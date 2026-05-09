# syntax=docker/dockerfile:1.7
# LiverRa orchestrator + Celery worker — runs on the laptop after the
# Option B split (2026-05-09). NO GPU, NO torch — the cascade calls
# packages/ml-inference-gpu/ over HTTP for TotalSegmentator inference.

FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps: weasyprint needs cairo+pango; pytesseract needs tesseract;
# pdf2image needs poppler. libmagic for python-magic. SimpleITK ships its
# own native libs in the wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
        libffi-dev shared-mime-info \
        tesseract-ocr poppler-utils libmagic1 \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app/

EXPOSE 8090

# Default command — overridden by docker-compose for the celery worker.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8090"]
