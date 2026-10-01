import base64
import io
import json
import sys
import traceback
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps


def sanitize_text(value: Any) -> str:
    text = str(value or "").replace("\r", "\n")
    lines = [" ".join(part.split()) for part in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def normalize_barcode_type(value: Any) -> str | None:
    text = str(value or "").strip().upper()
    return text or None


def decode_barcode(image: Image.Image) -> dict[str, Any]:
    rgb = np.array(image.convert("RGB"))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    detector = cv2.barcode.BarcodeDetector()
    candidates: list[dict[str, Any]] = []

    try:
        retval, decoded_info, decoded_type, points = detector.detectAndDecodeWithType(bgr)
        if retval:
            for index, value in enumerate(decoded_info or []):
                text = sanitize_text(value)
                if not text:
                    continue
                barcode_type = None
                if decoded_type is not None and index < len(decoded_type):
                    barcode_type = normalize_barcode_type(decoded_type[index])
                candidates.append({
                    "value": text,
                    "type": barcode_type,
                    "points": points[index].tolist() if points is not None and index < len(points) else None,
                })
    except Exception:
        pass

    if not candidates:
        try:
            value, points = detector.detectAndDecode(bgr)
            text = sanitize_text(value)
            if text:
                candidates.append({
                    "value": text,
                    "type": None,
                    "points": points.tolist() if points is not None else None,
                })
        except Exception:
            pass

    if not candidates:
        return {
            "success": False,
            "barcode": None,
            "type": None,
            "matched": False,
            "record": None,
            "message": "No barcode detected. Please capture a clearer image.",
            "barcodes": [],
        }

    primary = candidates[0]
    return {
        "success": True,
        "barcode": primary["value"],
        "type": primary.get("type"),
        "matched": False,
        "record": None,
        "message": "Barcode detected.",
        "barcodes": candidates,
    }


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        image_base64 = str(payload.get("imageBase64") or "")
        if not image_base64:
            raise ValueError("imageBase64 is required")

        image_bytes = base64.b64decode(image_base64)
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(image_bytes))).convert("RGB")
        print(json.dumps(decode_barcode(image), ensure_ascii=False), flush=True)
    except Exception as error:
        print(json.dumps({
            "success": False,
            "barcode": None,
            "type": None,
            "matched": False,
            "record": None,
            "message": f"{error.__class__.__name__}: {error}",
            "traceback": traceback.format_exc(),
        }), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
