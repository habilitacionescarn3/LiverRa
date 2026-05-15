# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Background / scheduled jobs.

This package houses out-of-band tasks that do not belong on a Celery
worker — typically annual or daily attestations whose timing is best
expressed via cron.
"""
