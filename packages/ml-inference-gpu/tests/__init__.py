# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""LiverRa GPU inference test suite.

Smoke + contract tests for the FastAPI microservice in ``main.py``.
Heavy ML inference is NOT exercised here — those tests live in the
``packages/ml-inference`` integration suite which can mount the
laptop's MinIO + Postgres + Celery loop. This module just verifies
the security and licensing gates that Agent 2.4 added.
"""
