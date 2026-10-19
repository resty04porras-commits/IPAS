"""Barcode decoding for IPAS; no OCR-model loading or identifier guessing.

ZXing handles Code 128/39 and QR in addition to retail EAN codes. OpenCV
remains the fallback when the optional native decoder is unavailable.
"""
import logging
from typing import Any

import cv2
import numpy as np
from PIL import Image

try:
    import zxingcpp
except ImportError:
    zxingcpp = None

logger = logging.getLogger("ocr-service.barcode")
RETAIL_TYPES = {"EAN_13", "EAN_8", "UPC_A", "UPC_E"}


def _type_name(value: Any) -> str | None:
    if value is None:
        return None
    name = str(value).strip().upper().replace("-", "_").replace(" ", "_")
    return name or None


def _scan_regions(width: int, height: int):
    """Full frame plus four overlapping windows, independent of label location."""
    yield (0, 0, width, height)
    if max(width, height) <= 1800:
        return
    window_width = max(1, round(width * 0.60))
    window_height = max(1, round(height * 0.60))
    for top in (0, height - window_height):
        for left in (0, width - window_width):
            yield (left, top, left + window_width, top + window_height)


def _zxing_candidates(image: Image.Image) -> list[dict[str, Any]]:
    candidates = []
    seen = set()
    for left, top, right, bottom in _scan_regions(image.width, image.height):
        for result in zxingcpp.read_barcodes(image.crop((left, top, right, bottom))):
            # Invalid/checksum-failing reads must never become identifier candidates.
            if not result.valid:
                continue
            value = str(result.text).strip()
            kind = _type_name(result.format)
            key = (value, kind)
            if not value or key in seen:
                continue
            seen.add(key)
            points = [
                [int(point.x) + left, int(point.y) + top]
                for point in (result.position.top_left, result.position.top_right,
                              result.position.bottom_right, result.position.bottom_left)
            ]
            candidates.append({"value": value, "type": kind, "points": points})
    return candidates


def _opencv_candidates(image: Image.Image) -> list[dict[str, Any]]:
    bgr = cv2.cvtColor(np.asarray(image.convert("RGB")), cv2.COLOR_RGB2BGR)
    detector = cv2.barcode.BarcodeDetector()
    candidates = []
    try:
        detected, values, kinds, points = detector.detectAndDecodeWithType(bgr)
        if detected:
            for index, value in enumerate(values if values is not None else []):
                value = str(value or "").strip()
                if not value:
                    continue
                kind = _type_name(kinds[index]) if kinds is not None and index < len(kinds) else None
                poly = points[index].tolist() if points is not None and index < len(points) else None
                candidates.append({"value": value, "type": kind, "points": poly})
    except Exception:
        logger.debug("OpenCV multi-detect failed; trying single detection.", exc_info=True)
    if not candidates:
        try:
            value, points = detector.detectAndDecode(bgr)
            value = str(value or "").strip()
            if value:
                candidates.append({"value": value, "type": None, "points": points.tolist() if points is not None else None})
        except Exception:
            logger.debug("OpenCV single-detect failed.", exc_info=True)
    return candidates


def decode_barcode(image: Image.Image) -> dict[str, Any]:
    image = image.convert("RGB")
    candidates = []
    engine = "opencv"
    if zxingcpp is not None:
        try:
            candidates = _zxing_candidates(image)
            engine = "zxing-cpp"
        except Exception:
            logger.warning("ZXing decoding failed; trying OpenCV.", exc_info=True)
    if not candidates:
        candidates = _opencv_candidates(image)
        engine = "opencv"
    # Prefer inventory-capable codes over a product's shared EAN/UPC when both
    # exist. This is not a claim that any decoded value is a serial or asset tag.
    candidates.sort(key=lambda entry: (entry["type"] in RETAIL_TYPES,
                                      min((p[1] for p in entry["points"]), default=0) if entry["points"] else 0))
    primary = candidates[0] if candidates else None
    return {
        "success": primary is not None,
        "barcode": primary["value"] if primary else None,
        "type": primary["type"] if primary else None,
        "matched": False,
        "record": None,
        "message": "Barcode detected." if primary else "No barcode detected. Please capture a clearer image.",
        "barcodes": candidates,
        "raw": {"engine": engine},
    }
