# IPAS EasyOCR Service

FastAPI OCR service for IPAS. It loads EasyOCR once at startup (`easyocr.Reader(["en"], gpu=False)`), preprocesses uploaded images, filters low-confidence lines, and returns the same OCR snapshot shape used by the existing Node/TypeScript backend.

## Setup

Use Python 3.10–3.13. EasyOCR depends on PyTorch (CPU build is fine).

```bash
cd ocr-service
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### Debian/Linux system dependencies

OpenCV needs a few shared libraries that are not always present on a minimal
server. Install them once (this is **not** done automatically by the service):

```bash
apt install -y libgl1 libglib2.0-0 libsm6 libxext6 libxrender1
```

The first startup downloads the EasyOCR detection/recognition models to
`~/.EasyOCR/`; subsequent startups load them from disk.

## Run

```bash
cd ocr-service
source .venv/bin/activate
python -m uvicorn ocr_api:app --host 127.0.0.1 --port 8001
```

## Node Integration

Set these values in the main project `.env.local`:

```env
OCR_ENGINE=easyocr
OCR_SERVICE_URL=http://127.0.0.1:8001
OCR_SERVICE_TIMEOUT_MS=180000
OCR_LANG=en
OCR_MIN_CONFIDENCE=0.70
```

The backend keeps the existing OCR worker as fallback. If this service is unavailable or times out, Node logs the fallback and continues with the existing OCR path.

## Endpoints

- `GET /health`
- `GET /`
- `POST /ocr`
- `POST /barcode`

`POST /ocr` accepts multipart form data:

- `file`: uploaded image
- `mode`: `full` or `probe`
- `rectangle`: optional JSON crop rectangle
- `rectangles`: optional JSON list for batch probe crops

The response includes:

- `text`
- `confidence`
- `lines`
- `words`
- `boundingBoxes`
- `snapshot`
- `raw`
- `error`
