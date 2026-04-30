"""Tiny mock for the anonymization sidecar — Phase 6 dev only.

Returns a ``done`` response immediately with a synthetic output URI so the
cascade can proceed past stage 1. NOT for production.
"""
from __future__ import annotations

import sys
import uvicorn
from fastapi import FastAPI

app = FastAPI()


@app.post("/anonymize")
async def anonymize(payload: dict) -> dict:
    return {
        "status": "done",
        "output_uri": f"s3://liverra-dev/anonymized/{payload.get('study_id', 'unknown')}.zip",
        "scrubbed_tag_count": 42,
    }


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 7070
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
