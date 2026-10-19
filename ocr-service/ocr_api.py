import asyncio
import json
import logging
import os
import tempfile
import time
from pathlib import Path
from threading import Lock
from typing import Any

os.environ.setdefault("PYTHONUTF8", "1")

import cv2
import easyocr
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

from barcode_reader import decode_barcode


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("ocr-service")

OCR_LANG = os.getenv("OCR_LANG", "en")
OCR_MIN_CONFIDENCE = float(os.getenv("OCR_MIN_CONFIDENCE", "0.70"))
OCR_USE_ANGLE_CLS = os.getenv("OCR_USE_ANGLE_CLS", "true").strip().lower() in {"1", "true", "yes", "on"}
OCR_MAX_IMAGE_SIDE = int(os.getenv("OCR_MAX_IMAGE_SIDE", "2200"))
OCR_REQUEST_TIMEOUT_SECONDS = float(os.getenv("OCR_REQUEST_TIMEOUT_SECONDS", "180"))
OCR_USE_GPU = os.getenv("OCR_USE_GPU", "false").strip().lower() in {"1", "true", "yes", "on"}

# EasyOCR expects a list of language codes (e.g. ["en"]); allow comma-separated overrides.
OCR_LANGS = [code.strip() for code in OCR_LANG.split(",") if code.strip()] or ["en"]

app = FastAPI(title="IPAS EasyOCR Service", version="1.0.0")
ocr_model: easyocr.Reader | None = None
ocr_lock = Lock()


def sanitize_text(value: Any) -> str:
    text = str(value or "").replace("\r", "\n")
    lines = [" ".join(part.split()) for part in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def bbox_from_poly(poly: Any) -> dict[str, int]:
    raw_points = poly.tolist() if hasattr(poly, "tolist") else (poly if poly is not None else [])
    points: list[tuple[int, int]] = []
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
    return {"x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)}


def clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


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


def resize_safely(image: Image.Image) -> tuple[Image.Image, float]:
    longest_side = max(image.width, image.height)
    if longest_side <= 0:
        return image, 1.0

    scale = 1.0
    if longest_side < 700:
        scale = 2.0
    elif longest_side < 1100:
        scale = 1.5
    elif longest_side > OCR_MAX_IMAGE_SIDE:
        scale = OCR_MAX_IMAGE_SIDE / float(longest_side)

    if abs(scale - 1.0) < 0.01:
        return image, 1.0

    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    return resized, scale


def preprocess_image(image: Image.Image) -> tuple[np.ndarray, float]:
    resized, scale = resize_safely(image)
    rgb = np.array(resized.convert("RGB"))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    denoised = cv2.fastNlMeansDenoising(gray, None, h=7, templateWindowSize=7, searchWindowSize=21)

    mean, stddev = cv2.meanStdDev(denoised)
    contrast = float(stddev[0][0])
    if contrast < 55:
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        denoised = clahe.apply(denoised)

    processed = cv2.cvtColor(denoised, cv2.COLOR_GRAY2RGB)
    return processed, scale


def remap_bbox(bbox: dict[str, int], scale: float) -> dict[str, int]:
    if scale <= 0:
        scale = 1.0
    return {
        "x0": int(round(bbox["x0"] / scale)),
        "y0": int(round(bbox["y0"] / scale)),
        "x1": int(round(bbox["x1"] / scale)),
        "y1": int(round(bbox["y1"] / scale)),
    }


def normalize_easyocr_result(result: Any) -> dict[str, list[Any]]:
    # EasyOCR readtext(detail=1) returns rows of (poly, text, confidence).
    texts: list[str] = []
    scores: list[float] = []
    polys: list[Any] = []
    rows = result if isinstance(result, (list, tuple)) else []
    for row in rows:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        poly = row[0]
        text = row[1]
        score = row[2] if len(row) > 2 else 0
        texts.append(str(text))
        scores.append(float(score or 0))
        polys.append(poly)

    return {"texts": texts, "scores": scores, "polys": polys}


def build_snapshot(result: Any, width: int, height: int, scale: float) -> dict[str, Any]:
    normalized = normalize_easyocr_result(result)
    lines: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []

    for index, raw_text in enumerate(normalized["texts"]):
        text = sanitize_text(raw_text)
        if not text:
            continue

        score = float(normalized["scores"][index]) if index < len(normalized["scores"]) else 0.0
        if score < OCR_MIN_CONFIDENCE:
            continue

        bbox = remap_bbox(
            bbox_from_poly(normalized["polys"][index] if index < len(normalized["polys"]) else None),
            scale,
        )
        word_entries = [{"text": token, "confidence": score, "bbox": bbox} for token in text.split() if token]
        lines.append({"text": text, "confidence": score, "bbox": bbox, "words": word_entries})
        words.extend(word_entries)

    lines.sort(key=lambda line: (line["bbox"]["y0"], line["bbox"]["x0"]))
    confidence = sum(line["confidence"] for line in lines) / len(lines) if lines else 0.0

    return {
        "text": "\n".join(line["text"] for line in lines),
        "confidence": confidence,
        "lines": lines,
        "words": words,
        "width": width,
        "height": height,
    }


def create_ocr() -> easyocr.Reader:
    return easyocr.Reader(OCR_LANGS, gpu=OCR_USE_GPU)


def get_ocr() -> easyocr.Reader:
    if ocr_model is None:
        raise RuntimeError("EasyOCR reader is not loaded yet.")
    return ocr_model


def run_ocr(image: Image.Image) -> dict[str, Any]:
    processed, scale = preprocess_image(image)
    with ocr_lock:
        model = get_ocr()
        result = model.readtext(processed, detail=1)
    return build_snapshot(result, image.width, image.height, scale)



def parse_json_field(raw_value: str | None, fallback: Any) -> Any:
    if not raw_value:
        return fallback
    try:
        return json.loads(raw_value)
    except json.JSONDecodeError:
        return fallback


@app.on_event("startup")
def startup() -> None:
    global ocr_model
    started = time.perf_counter()
    logger.info(
        "Loading EasyOCR once at startup (lang=%s, min_confidence=%.2f, gpu=%s)",
        ",".join(OCR_LANGS),
        OCR_MIN_CONFIDENCE,
        OCR_USE_GPU,
    )
    ocr_model = create_ocr()
    logger.info("EasyOCR loaded successfully in %.2fs", time.perf_counter() - started)
    logger.info("EasyOCR service ready")


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "modelLoaded": ocr_model is not None,
        "lang": OCR_LANG,
        "minConfidence": OCR_MIN_CONFIDENCE,
        "useAngleCls": OCR_USE_ANGLE_CLS,
    }


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "IPAS EasyOCR Service",
        "health": "/health",
        "ocr": "POST /ocr",
        "barcode": "POST /barcode",
    }


@app.post("/barcode")
async def barcode_endpoint(
    file: UploadFile = File(...),
) -> JSONResponse:
    started = time.perf_counter()
    suffix = Path(file.filename or "upload").suffix or ".img"
    temp_path = ""

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                temp_file.write(chunk)

        with Image.open(temp_path) as source:
            original = ImageOps.exif_transpose(source).convert("RGB")

        result = await asyncio.wait_for(
            asyncio.to_thread(decode_barcode, original),
            timeout=OCR_REQUEST_TIMEOUT_SECONDS,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        logger.info("Barcode scan complete file=%s detected=%s elapsed_ms=%s", file.filename, bool(result["barcode"]), elapsed_ms)
        result["durationMs"] = elapsed_ms
        return JSONResponse(result)
    except asyncio.TimeoutError:
        message = f"Barcode scan timed out after {OCR_REQUEST_TIMEOUT_SECONDS:.0f} seconds."
        logger.warning(message)
        return JSONResponse({
            "success": False,
            "barcode": None,
            "type": None,
            "matched": False,
            "record": None,
            "message": message,
        }, status_code=504)
    except Exception as error:
        message = f"{error.__class__.__name__}: {error}"
        logger.exception("Barcode scan failed")
        return JSONResponse({
            "success": False,
            "barcode": None,
            "type": None,
            "matched": False,
            "record": None,
            "message": message,
        }, status_code=500)
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)
        await file.close()


@app.post("/ocr")
async def ocr_endpoint(
    file: UploadFile = File(...),
    mode: str = Form("full"),
    rectangle: str | None = Form(None),
    rectangles: str | None = Form(None),
) -> JSONResponse:
    started = time.perf_counter()
    suffix = Path(file.filename or "upload").suffix or ".img"
    temp_path = ""

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
            temp_path = temp_file.name
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                temp_file.write(chunk)

        with Image.open(temp_path) as source:
            original = ImageOps.exif_transpose(source).convert("RGB")

        parsed_rectangle = parse_json_field(rectangle, None)
        parsed_rectangles = parse_json_field(rectangles, [])

        if isinstance(parsed_rectangles, list) and parsed_rectangles:
            snapshots: dict[str, Any] = {}
            for entry in parsed_rectangles:
                key = str((entry or {}).get("key") or "").strip()
                if not key:
                    continue
                cropped = crop_image(original, (entry or {}).get("rectangle"))
                snapshots[key] = await asyncio.wait_for(
                    asyncio.to_thread(run_ocr, cropped),
                    timeout=OCR_REQUEST_TIMEOUT_SECONDS,
                )
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            logger.info("OCR batch complete file=%s mode=%s elapsed_ms=%s", file.filename, mode, elapsed_ms)
            return JSONResponse({"ok": True, "snapshots": snapshots, "durationMs": elapsed_ms})

        cropped = crop_image(original, parsed_rectangle)
        snapshot = await asyncio.wait_for(
            asyncio.to_thread(run_ocr, cropped),
            timeout=OCR_REQUEST_TIMEOUT_SECONDS,
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        logger.info("OCR complete file=%s mode=%s elapsed_ms=%s", file.filename, mode, elapsed_ms)
        return JSONResponse(
            {
                "ok": True,
                "text": snapshot["text"],
                "confidence": snapshot["confidence"],
                "lines": snapshot["lines"],
                "words": snapshot["words"],
                "boundingBoxes": [line["bbox"] for line in snapshot["lines"]],
                "width": snapshot["width"],
                "height": snapshot["height"],
                "snapshot": snapshot,
                "durationMs": elapsed_ms,
                "raw": {
                    "mode": mode,
                    "minConfidence": OCR_MIN_CONFIDENCE,
                },
                "error": None,
            }
        )
    except asyncio.TimeoutError:
        message = f"OCR timed out after {OCR_REQUEST_TIMEOUT_SECONDS:.0f} seconds."
        logger.warning(message)
        return JSONResponse({"ok": False, "text": "", "confidence": 0, "error": message}, status_code=504)
    except Exception as error:
        message = f"{error.__class__.__name__}: {error}"
        logger.exception("OCR failed")
        return JSONResponse({"ok": False, "text": "", "confidence": 0, "error": message}, status_code=500)
    finally:
        if temp_path:
            Path(temp_path).unlink(missing_ok=True)
        await file.close()
