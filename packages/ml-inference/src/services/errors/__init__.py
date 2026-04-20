# SPDX-FileCopyrightText: Copyright LiverRa contributors
# SPDX-License-Identifier: Apache-2.0
"""Error catalogue + RFC 7807 problem-detail helpers."""

from .catalog import (  # noqa: F401
    ErrorSlug,
    ProblemDetailException,
    problem_detail,
    register_exception_handler,
)
