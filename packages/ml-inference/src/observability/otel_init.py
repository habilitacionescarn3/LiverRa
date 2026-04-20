# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""OpenTelemetry SDK initialisation (T130).

Plain-English:
    OpenTelemetry is the vendor-neutral "spy cam" for our server — it
    watches every request/span/metric and forwards them over OTLP
    (gRPC) to the in-VPC collector. From there Grafana Tempo shows
    per-stage traces and Prometheus shows metrics. Everything stays
    inside eu-central-1; no telemetry ever leaves the VPC uninspected.

Instruments attached:
    - FastAPI — one span per HTTP request
    - SQLAlchemy — one span per DB query (async-safe)
    - Celery — one span per task (Sub-2p tasks)

References:
    - plan.md §Observability Event Catalogue → OpenTelemetry traces
    - plan.md §Observability: "Exported to Grafana Tempo EU"
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Soft imports so the FastAPI app still boots on a slim/test container
# that omits the OTel wheels.
try:  # pragma: no cover — import side-effect only
    from opentelemetry import metrics, trace
    from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
        OTLPMetricExporter,
    )
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
        OTLPSpanExporter,
    )
    from opentelemetry.sdk.metrics import MeterProvider
    from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
    from opentelemetry.sdk.resources import SERVICE_NAME, Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    _OTEL_SDK_AVAILABLE = True
except ImportError:  # pragma: no cover
    trace = None  # type: ignore[assignment]
    metrics = None  # type: ignore[assignment]
    OTLPSpanExporter = None  # type: ignore[assignment]
    OTLPMetricExporter = None  # type: ignore[assignment]
    TracerProvider = None  # type: ignore[assignment]
    MeterProvider = None  # type: ignore[assignment]
    BatchSpanProcessor = None  # type: ignore[assignment]
    PeriodicExportingMetricReader = None  # type: ignore[assignment]
    Resource = None  # type: ignore[assignment]
    SERVICE_NAME = "service.name"  # type: ignore[assignment]
    _OTEL_SDK_AVAILABLE = False

try:  # pragma: no cover
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    _FASTAPI_INSTR_AVAILABLE = True
except ImportError:  # pragma: no cover
    FastAPIInstrumentor = None  # type: ignore[assignment]
    _FASTAPI_INSTR_AVAILABLE = False

try:  # pragma: no cover
    from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

    _SQLA_INSTR_AVAILABLE = True
except ImportError:  # pragma: no cover
    SQLAlchemyInstrumentor = None  # type: ignore[assignment]
    _SQLA_INSTR_AVAILABLE = False

try:  # pragma: no cover
    from opentelemetry.instrumentation.celery import CeleryInstrumentor

    _CELERY_INSTR_AVAILABLE = True
except ImportError:  # pragma: no cover
    CeleryInstrumentor = None  # type: ignore[assignment]
    _CELERY_INSTR_AVAILABLE = False


_initialized: bool = False


def otel_available() -> bool:
    """True if the OTel SDK was imported AND init_otel has run."""
    return _OTEL_SDK_AVAILABLE and _initialized


def init_otel(
    service_name: str = "liverra-ml-inference",
    otlp_endpoint: Optional[str] = None,
) -> bool:
    """Initialise the global OTel providers.

    - ``service_name`` — logical service tag shown in Tempo/Prometheus.
    - ``otlp_endpoint`` — gRPC URL (defaults to
      ``OTEL_EXPORTER_OTLP_ENDPOINT`` env var, e.g.
      ``http://otel-collector.liverra.internal:4317``).
    - Returns True on success, False on any failure (non-fatal; app
      still boots without telemetry).
    """
    global _initialized

    if not _OTEL_SDK_AVAILABLE:
        logger.info("opentelemetry-sdk not installed — OTel disabled")
        return False

    otlp_endpoint = otlp_endpoint or os.environ.get(
        "OTEL_EXPORTER_OTLP_ENDPOINT"
    )
    if not otlp_endpoint:
        logger.info(
            "OTEL_EXPORTER_OTLP_ENDPOINT not set — OTel disabled"
        )
        return False

    try:
        resource = Resource.create({SERVICE_NAME: service_name})  # type: ignore[union-attr]

        # Tracer provider + OTLP span exporter
        tracer_provider = TracerProvider(resource=resource)  # type: ignore[misc]
        span_exporter = OTLPSpanExporter(endpoint=otlp_endpoint, insecure=True)  # type: ignore[misc]
        tracer_provider.add_span_processor(BatchSpanProcessor(span_exporter))  # type: ignore[misc]
        trace.set_tracer_provider(tracer_provider)  # type: ignore[union-attr]

        # Meter provider + OTLP metric exporter
        metric_exporter = OTLPMetricExporter(endpoint=otlp_endpoint, insecure=True)  # type: ignore[misc]
        reader = PeriodicExportingMetricReader(  # type: ignore[misc]
            metric_exporter, export_interval_millis=60_000
        )
        meter_provider = MeterProvider(resource=resource, metric_readers=[reader])  # type: ignore[misc]
        metrics.set_meter_provider(meter_provider)  # type: ignore[union-attr]

        _initialized = True
        logger.info(
            "OpenTelemetry initialised (service=%s, endpoint=%s)",
            service_name,
            otlp_endpoint,
        )
        return True
    except Exception as exc:  # pragma: no cover — defensive
        logger.error("OpenTelemetry init failed: %s", exc, exc_info=True)
        return False


def instrument_app(app: Any) -> None:
    """Attach FastAPI + SQLAlchemy + Celery instrumentation.

    - FastAPI: mandatory to produce per-request spans.
    - SQLAlchemy: picks up the engine registered in ``src/db/session.py``.
    - Celery: adds task-level spans. Noop until the Celery app is
      wired (T213). Safe to call pre-wiring.
    """
    if not _initialized:
        # Try to init lazily; if that still fails just skip instrumentation.
        if not init_otel():
            return

    if _FASTAPI_INSTR_AVAILABLE and FastAPIInstrumentor is not None:
        try:
            FastAPIInstrumentor.instrument_app(app)
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning("FastAPI instrumentation failed: %s", exc)

    if _SQLA_INSTR_AVAILABLE and SQLAlchemyInstrumentor is not None:
        try:
            # Engine is resolved lazily inside get_engine(); instrumenting
            # the class is fine because asyncpg creates sync engines per
            # connection as well.
            SQLAlchemyInstrumentor().instrument(enable_commenter=True)
        except Exception as exc:  # pragma: no cover
            logger.warning("SQLAlchemy instrumentation failed: %s", exc)

    if _CELERY_INSTR_AVAILABLE and CeleryInstrumentor is not None:
        try:
            CeleryInstrumentor().instrument()
        except Exception as exc:  # pragma: no cover
            logger.warning("Celery instrumentation failed: %s", exc)


__all__ = ["init_otel", "instrument_app", "otel_available"]
