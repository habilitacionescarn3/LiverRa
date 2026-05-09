# syntax=docker/dockerfile:1.7
# LiverRa GPU inference microservice — see ./README.md.
#
# Base image already ships PyTorch 2.8 + CUDA 12.6 + cuDNN 9. Building
# from this avoids the ~3GB torch wheel install in our requirements step.
FROM pytorch/pytorch:2.8.0-cuda12.6-cudnn9-runtime

# Avoid Python writing .pyc files / buffering stdout (better Docker logs).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps — totalsegmentator needs git for some optional checkpoints.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps (torch is already in the base, so this is fast).
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# App code (single file).
COPY main.py /app/main.py

EXPOSE 9000

# Bind to 0.0.0.0 inside the container; the host's docker --publish
# maps it to whatever interface the operator wants (Tailscale-only by
# convention — see README).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000", "--workers", "1"]
