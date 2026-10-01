import base64
import io
import json
import os
import re
import sys
import traceback
from typing import Any

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PYTHONUTF8", "1")

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps
from paddleocr import PaddleOCR

# Matches standard asset/property tag format: PREFIX-YEAR-CODE (e.g., CPU-2024-AB1)
ASSET_TAG_REGEX = re.compile(r"\b[A-Z]{1,8}[\s/-]*(?:19|20)\d{2}[\s/-]*[A-Z0-9]{2,8}\b")

# Positive signals: these words near OCR text indicate a useful asset/serial region
SERIAL_HINT_REGEX = re.compile(
    r"\b(?:SERIAL(?:\s*NO\.?|\s*NUMBER)?|S\.?/?\s*N\.?|SN|SNID|BARCODE|QR(?:\s*CODE)?|"
    r"MODEL(?:\s*NO\.?|\s*NUMBER)?|PROPERTY|LIFEBANK|FOUNDATION|ASSET|TAG)\b",
    re.IGNORECASE,
)


def sanitize_text(value: Any) -> str:
    text = str(value or "").replace("\r", "\n")
    lines = [" ".join(part.split()) for part in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def bbox_from_poly(poly: Any) -> dict[str, int]:
    points = []
    raw_points = poly.tolist() if hasattr(poly, "tolist") else (poly if poly is not None else [])
    for point in raw_points:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            try:
                points.append((int(point[0]), int(point[1])))
            except (TypeError, ValueError):
                continue

    if not points:
        return {"x0": 0, "y0": 0, "x1": 0, "y1": 0}

    xs = [point[0] for point in points]
    ys = [point[1] for point in points]
    return {
        "x0": min(xs),
        "y0": min(ys),
        "x1": max(xs),
        "y1": max(ys),
    }


def map_point_back_to_base(
    x: float,
    y: float,
    base_width: int,
    base_height: int,
    angle: int,
    scale: float,
) -> tuple[float, float]:
    scaled_x = x / scale
    scaled_y = y / scale

    if angle == 90:
        return base_width - scaled_y, scaled_x
    if angle == 180:
        return base_width - scaled_x, base_height - scaled_y
    if angle == 270:
        return scaled_y, base_height - scaled_x

    return scaled_x, scaled_y


def remap_bbox_to_base(
    bbox: dict[str, int],
    base_width: int,
    base_height: int,
    angle: int,
    scale: float,
) -> dict[str, int]:
    corners = [
        (bbox["x0"], bbox["y0"]),
        (bbox["x1"], bbox["y0"]),
        (bbox["x1"], bbox["y1"]),
        (bbox["x0"], bbox["y1"]),
    ]
    mapped = [
        map_point_back_to_base(x, y, base_width, base_height, angle, scale)
        for x, y in corners
    ]
    xs = [point[0] for point in mapped]
    ys = [point[1] for point in mapped]
    return {
        "x0": int(max(0, round(min(xs)))),
        "y0": int(max(0, round(min(ys)))),
        "x1": int(max(0, round(max(xs)))),
        "y1": int(max(0, round(max(ys)))),
    }


def build_snapshot(
    result: Any,
    *,
    base_width: int,
    base_height: int,
    angle: int,
    scale: float,
) -> dict[str, Any]:
    if isinstance(result, list):
        page = result[0] if result else {}
    else:
        page = result or {}

    texts = list(page.get("rec_texts") or [])
    scores = list(page.get("rec_scores") or [])
    polys = list(page.get("dt_polys") or page.get("rec_polys") or [])

    lines = []
    words = []

    for index, raw_text in enumerate(texts):
        text = sanitize_text(raw_text)
        if not text:
            continue

        score = float(scores[index]) if index < len(scores) else 0.0
        bbox = remap_bbox_to_base(
            bbox_from_poly(polys[index] if index < len(polys) else None),
            base_width,
            base_height,
            angle,
            scale,
        )
        word_entries = [
            {
                "text": token,
                "confidence": score,
                "bbox": bbox,
            }
            for token in text.split()
            if token
        ]

        line_entry = {
            "text": text,
            "confidence": score,
            "bbox": bbox,
            "words": word_entries,
        }
        lines.append(line_entry)
        words.extend(word_entries)

    average_confidence = (
        sum(float(line["confidence"]) for line in lines) / len(lines)
        if lines
        else 0.0
    )

    return {
        "text": "\n".join(line["text"] for line in lines),
        "confidence": average_confidence,
        "lines": lines,
        "words": words,
        "width": base_width,
        "height": base_height,
    }


def crop_image(image: Image.Image, rectangle: dict[str, Any] | None) -> Image.Image:
    if not rectangle:
        return image

    left = clamp(int(rectangle.get("left", 0)), 0, image.width)
    top = clamp(int(rectangle.get("top", 0)), 0, image.height)
    width = max(1, int(rectangle.get("width", image.width)))
    height = max(1, int(rectangle.get("height", image.height)))
    right = clamp(left + width, left + 1, image.width)
    bottom = clamp(top + height, top + 1, image.height)
    return image.crop((left, top, right, bottom))


def decode_image(image_base64: str, rectangle: dict[str, Any] | None) -> Image.Image:
    binary = base64.b64decode(image_base64)
    with Image.open(io.BytesIO(binary)) as source:
        rgb_image = ImageOps.exif_transpose(source).convert("RGB")
        return crop_image(rgb_image, rectangle)


def decode_base_image(image_base64: str) -> Image.Image:
    binary = base64.b64decode(image_base64)
    with Image.open(io.BytesIO(binary)) as source:
        return ImageOps.exif_transpose(source).convert("RGB")


def upscale_for_ocr(image: Image.Image) -> tuple[Image.Image, float]:
    longest_side = max(image.width, image.height)
    if longest_side <= 0:
        return image, 1.0

    # Aggressively upscale very small images (device label crops, QR regions)
    if longest_side < 400:
        scale = 3.0
    elif longest_side < 900:
        scale = 2.0
    elif longest_side < 1400:
        scale = 1.5
    elif longest_side < 2000:
        scale = 1.2
    else:
        scale = 1.0

    if scale == 1.0:
        return image, scale

    return (
        image.resize(
            (
                max(1, int(round(image.width * scale))),
                max(1, int(round(image.height * scale))),
            ),
            Image.Resampling.LANCZOS,
        ),
        scale,
    )


def enhance_for_ocr(image: Image.Image) -> Image.Image:
    """Standard enhancement: grayscale + autocontrast + contrast boost + sharpen."""
    grayscale = ImageOps.grayscale(image)
    grayscale = ImageOps.autocontrast(grayscale, cutoff=1)
    grayscale = ImageEnhance.Contrast(grayscale).enhance(1.55)
    grayscale = grayscale.filter(ImageFilter.SHARPEN)
    return grayscale.convert("RGB")


def enhance_for_ocr_adaptive(image: Image.Image) -> Image.Image:
    """Aggressive enhancement for dark, blurry, or low-contrast images.

    Uses median denoising + higher contrast + unsharp mask edge recovery.
    Especially effective for compressed JPEGs, dark photos, and worn labels.
    """
    grayscale = ImageOps.grayscale(image)
    # Median filter removes salt-and-pepper noise while preserving edges
    grayscale = grayscale.filter(ImageFilter.MedianFilter(size=3))
    grayscale = ImageOps.autocontrast(grayscale, cutoff=2)
    grayscale = ImageEnhance.Contrast(grayscale).enhance(2.0)
    grayscale = ImageEnhance.Sharpness(grayscale).enhance(2.5)
    # Unsharp mask recovers fine text edges after aggressive contrast
    grayscale = grayscale.filter(ImageFilter.UnsharpMask(radius=2, percent=150, threshold=3))
    return grayscale.convert("RGB")


def enhance_for_ocr_denoised(image: Image.Image) -> Image.Image:
    """Smooth-then-enhance for noisy/grainy images.

    A light Gaussian blur reduces high-frequency noise before contrast boost,
    which prevents the noise from being amplified. Good for scanned receipts
    and low-light device photos.
    """
    grayscale = ImageOps.grayscale(image)
    grayscale = grayscale.filter(ImageFilter.GaussianBlur(radius=0.8))
    grayscale = ImageOps.autocontrast(grayscale, cutoff=1)
    grayscale = ImageEnhance.Contrast(grayscale).enhance(1.8)
    grayscale = ImageEnhance.Sharpness(grayscale).enhance(1.8)
    return grayscale.convert("RGB")


def build_variant_plan(
    image: Image.Image,
    *,
    include_rotations: bool,
    include_enhanced_variants: bool = True,
) -> list[dict[str, Any]]:
    variants: list[dict[str, Any]] = []
    seen: set[tuple[str, int, float]] = set()

    def add_variant(name: str, variant_image: Image.Image, angle: int) -> None:
        upscaled, scale = upscale_for_ocr(variant_image)
        key = (name, angle, scale)
        if key in seen:
            return
        seen.add(key)
        variants.append(
            {
                "name": name,
                "angle": angle,
                "scale": scale,
                "image": upscaled,
            }
        )

    enhanced = enhance_for_ocr(image)
    add_variant("original", image, 0)
    add_variant("enhanced", enhanced, 0)

    # Adaptive and denoised variants improve accuracy for difficult images
    # (dark/blurry/noisy/compressed). Gated so probe mode stays fast.
    if include_enhanced_variants:
        adaptive = enhance_for_ocr_adaptive(image)
        denoised = enhance_for_ocr_denoised(image)
        add_variant("adaptive", adaptive, 0)
        add_variant("denoised", denoised, 0)

    if include_rotations:
        for angle in (90, 270, 180):
            rotated = enhanced.rotate(angle, expand=True)
            add_variant(f"enhanced-{angle}", rotated, angle)

    return variants


def score_snapshot(snapshot: dict[str, Any]) -> float:
    text = sanitize_text(snapshot.get("text", ""))
    uppercase = text.upper()
    line_count = len(snapshot.get("lines") or [])
    alnum_count = sum(1 for char in text if char.isalnum())
    average_confidence = float(snapshot.get("confidence") or 0.0)
    asset_hits = len(ASSET_TAG_REGEX.findall(uppercase))
    serial_hints = len(SERIAL_HINT_REGEX.findall(uppercase))
    return (
        alnum_count
        + (line_count * 6)
        + (average_confidence * 40)
        + (asset_hits * 32)   # boosted: asset tag match is a strong positive signal
        + (serial_hints * 12) # boosted: serial/model/property labels are valuable
    )


def should_accept_snapshot(snapshot: dict[str, Any], threshold: float) -> bool:
    if not snapshot:
        return False
    lines = snapshot.get("lines") or []
    if len(lines) < 2:
        return False
    # Bonus: if an asset tag or serial label is present, lower the score requirement
    text = sanitize_text(snapshot.get("text", "")).upper()
    has_strong_signal = bool(
        ASSET_TAG_REGEX.search(text) or
        re.search(r"\b(?:SERIAL|S/N|SN|SNID|BARCODE)\b", text, re.IGNORECASE)
    )
    effective_threshold = threshold * 0.85 if has_strong_signal else threshold
    return score_snapshot(snapshot) >= effective_threshold


def predict_best_snapshot(
    ocr: PaddleOCR,
    image: Image.Image,
    *,
    mode: str = "full",
) -> dict[str, Any]:
    base_width = image.width
    base_height = image.height
    best_snapshot: dict[str, Any] | None = None
    best_score = -1.0

    # Tier 1: standard variants (original + enhanced) — always run, fast path
    tier1 = build_variant_plan(image, include_rotations=False, include_enhanced_variants=False)
    for variant in tier1:
        result = ocr.predict(np.array(variant["image"]))
        snapshot = build_snapshot(
            result,
            base_width=base_width,
            base_height=base_height,
            angle=variant["angle"],
            scale=variant["scale"],
        )
        score = score_snapshot(snapshot)

        if score > best_score:
            best_score = score
            best_snapshot = snapshot

        # Early exit: already excellent quality, no need to run more variants
        if score >= 120 and len(snapshot.get("lines") or []) >= 3:
            break

    # Tier 2: adaptive + denoised variants — run when standard results are insufficient
    # For probe mode: only run if score is very poor (bad crop region)
    # For full mode: run whenever score is below acceptance threshold
    tier2_needed = (
        (mode != "probe" and not should_accept_snapshot(best_snapshot or {}, 88)) or
        (mode == "probe" and best_score < 55)
    )

    if tier2_needed:
        tier2 = [
            v for v in build_variant_plan(image, include_rotations=False, include_enhanced_variants=True)
            if v["name"] in ("adaptive", "denoised")
        ]
        for variant in tier2:
            result = ocr.predict(np.array(variant["image"]))
            snapshot = build_snapshot(
                result,
                base_width=base_width,
                base_height=base_height,
                angle=variant["angle"],
                scale=variant["scale"],
            )
            score = score_snapshot(snapshot)

            if score > best_score:
                best_score = score
                best_snapshot = snapshot

            if score >= 115 and len(snapshot.get("lines") or []) >= 3:
                break

    # Tier 3: rotation variants — only for full mode when still below acceptance
    if mode != "probe" and not should_accept_snapshot(best_snapshot or {}, 88):
        rotated_variants = [
            v for v in build_variant_plan(image, include_rotations=True, include_enhanced_variants=False)
            if v["angle"] != 0
        ]
        for variant in rotated_variants:
            result = ocr.predict(np.array(variant["image"]))
            snapshot = build_snapshot(
                result,
                base_width=base_width,
                base_height=base_height,
                angle=variant["angle"],
                scale=variant["scale"],
            )
            score = score_snapshot(snapshot)

            if score > best_score:
                best_score = score
                best_snapshot = snapshot

            if score >= 110 and len(snapshot.get("lines") or []) >= 3:
                break

    return best_snapshot or {
        "text": "",
        "confidence": 0.0,
        "lines": [],
        "words": [],
    }


def create_ocr() -> PaddleOCR:
    return PaddleOCR(
        lang="en",
        use_doc_orientation_classify=True,
        use_doc_unwarping=False,
        use_textline_orientation=True,
        # Increased from 1600 → 2048 so detailed device labels are not downscaled
        # before text detection, preserving fine serial/model text.
        text_det_limit_side_len=2048,
        text_det_limit_type="max",
        # Filter out very low-confidence detections (pure noise/artifacts).
        # 0.2 is conservative: genuine text on clear labels is >0.7 confidence.
        text_rec_score_thresh=0.2,
        return_word_box=False,
    )


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def main() -> int:
    try:
        ocr = create_ocr()
    except Exception as error:  # pragma: no cover - startup failure path
        emit(
            {
                "type": "startup_error",
                "error": f"{error.__class__.__name__}: {error}",
                "traceback": traceback.format_exc(),
            }
        )
        return 1

    emit({"type": "ready"})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            base_image = decode_base_image(payload["imageBase64"])
            rectangles = payload.get("rectangles")
            mode = str(payload.get("mode") or "full").strip().lower() or "full"

            if isinstance(rectangles, list) and rectangles:
                snapshots: dict[str, Any] = {}
                for rectangle_entry in rectangles:
                    key = str((rectangle_entry or {}).get("key") or "").strip()
                    if not key:
                        continue

                    rectangle = (rectangle_entry or {}).get("rectangle")
                    snapshot = predict_best_snapshot(ocr, crop_image(base_image, rectangle), mode="probe")
                    snapshots[key] = snapshot

                emit({"id": request_id, "ok": True, "snapshots": snapshots})
                continue

            image = crop_image(base_image, payload.get("rectangle"))
            snapshot = predict_best_snapshot(ocr, image, mode=mode)
            emit({"id": request_id, "ok": True, "snapshot": snapshot})
        except Exception as error:  # pragma: no cover - runtime failure path
            emit(
                {
                    "id": request_id,
                    "ok": False,
                    "error": f"{error.__class__.__name__}: {error}",
                    "traceback": traceback.format_exc(),
                }
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
