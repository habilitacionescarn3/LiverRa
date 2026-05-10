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

# PORT is overridable so the container can run with --network host on
# WSL2 (where userspace tailscaled can't reach docker-proxy ports — see
# README "WSL2 host networking" section). Default 9000 keeps the
# bridge-network case (-p HOST:9000) working as before.
ENV PORT=9000
EXPOSE 9000

# Bind to 0.0.0.0 inside the container. With --network host the
# container shares the WSL2 host's loopback so tailscaled's userspace
# netstack can reach it directly. With bridge networking the host port
# is published via -p HOST_PORT:PORT.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1"]
