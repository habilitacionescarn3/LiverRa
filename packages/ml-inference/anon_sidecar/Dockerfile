FROM python:3.12-slim

# Pull fixed Debian package versions (resolves CVEs that surface in
# python:3.12-slim's bundled libs at any given tag pin) and tidy up
# apt cache to keep the image small.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Run the FastAPI process as a dedicated non-root user. UID 10001 is
# outside the typical host range so volume-mount ownership stays
# unambiguous; home is /app so any inadvertent writes (logs, caches)
# land inside the container layer.
RUN useradd --system --create-home --home-dir /app \
    --shell /usr/sbin/nologin --uid 10001 appuser

WORKDIR /app

RUN pip install --no-cache-dir \
    "fastapi>=0.121,<0.130" \
    "uvicorn[standard]>=0.32,<0.40" \
    "httpx>=0.27,<0.30" \
    "psycopg[binary]>=3.2,<3.3" \
    "pydantic>=2.9,<3.0"
# fastapi >=0.121 pulls starlette<0.50 (which includes 0.49.1+) — clears
# CVE-2025-62727 (Range-header DoS). Earlier fastapi 0.115-0.119 pinned
# starlette<0.49.0 which left the vulnerable 0.48.0 in the dep tree.

COPY --chown=appuser:appuser main.py /app/main.py

USER appuser

EXPOSE 7070

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7070"]
