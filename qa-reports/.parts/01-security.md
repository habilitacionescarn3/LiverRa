# 01 — Security Scan

## Verdict: WARNING

## Findings

#### FINDING: [SEC1] Hardcoded fallback secrets in development environment
- **severity**: MEDIUM
- **file**: `/Users/toko/Desktop/LiverRa/packages/ml-inference/src/services/admin/invite_service.py`
- **line**: 89
- **description**: The InviteService falls back to a hardcoded development secret `"dev-invite-secret-CHANGE-ME"` when the environment variable `LIVERRA_INVITE_JWT_SECRET` is not set. This placeholder secret could be used to forge invite JWTs if the env var is misconfigured in any environment, including production.
- **suggestedFix**: Remove all hardcoded fallback secrets. In production environments, require explicit environment variables and fail loudly (via `_strict_boot`) if they are missing. Use AWS Secrets Manager for secret rotation in production per the .env.example pattern.

#### FINDING: [SEC2] Hardcoded fallback secret for RUO signing
- **severity**: MEDIUM
- **file**: `/Users/toko/Desktop/LiverRa/packages/ml-inference/src/services/onboarding/signed_ruo.py`
- **line**: 43
- **description**: The SignedRUOService falls back to `"dev-ruo-secret-CHANGE-ME"` when `LIVERRA_RUO_SIGNING_SECRET` is not provided. Since RUO acceptance signatures are audit-critical for regulatory compliance, a default secret could allow forged RUO acceptances.
- **suggestedFix**: Require explicit `LIVERRA_RUO_SIGNING_SECRET` in all environments. Apply `_strict_boot` pattern to fail loudly in staging/production if the secret is missing.

#### FINDING: [SEC3] Overly permissive CORS configuration with wildcard methods and headers
- **severity**: MEDIUM
- **file**: `/Users/toko/Desktop/LiverRa/packages/ml-inference/src/main.py`
- **line**: 159-160
- **description**: CORS middleware allows `allow_methods=["*"]` and `allow_headers=["*"]`. While `allow_origins` is restricted to environment-configured values, the wildcard on methods and headers means any HTTP method (TRACE, CONNECT) and any request header (including custom injected headers) is accepted. This increases the attack surface for CSRF and header injection attacks.
- **suggestedFix**: Explicitly list allowed methods: `["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]`. For headers, whitelist only required ones (e.g., `["Authorization", "Content-Type", "X-Requested-With", "X-LiverRa-Tenant"]`).

#### FINDING: [SEC4] Math.random() used for non-security-critical IDs with weak entropy
- **severity**: LOW
- **file**: `/Users/toko/Desktop/LiverRa/packages/app/src/emr/services/offline/conflictResolver.ts`
- **line**: 77
- **description**: Conflict resolution generates IDs using `Math.random().toString(36).slice(2, 10)` combined with Date.now(). While this is for offline collision detection (not authentication), predictable IDs could facilitate debugging or tracing attacks if conflict IDs are exposed in logs.
- **suggestedFix**: Use `crypto.getRandomValues()` for any ID generation that might be exposed, or ensure conflict IDs are not logged/transmitted.

#### FINDING: [SEC5] DICOM UID field directly exposed in query parameters (DICOM-specific risk)
- **severity**: MEDIUM
- **file**: `/Users/toko/Desktop/LiverRa/packages/app/src/emr/services/pacs/dicomwebClient.ts`
- **line**: 215-220
- **description**: While the code includes UID validation (`validateDicomUid`), StudyInstanceUID and SeriesInstanceUID are passed as query parameters to DICOMweb endpoints. If error messages or logs expose these UIDs, they could be correlated with patient identities. Additionally, the QIDO-RS endpoint accepts `patientId` as a query parameter.
- **suggestedFix**: Ensure DICOMweb endpoints are always accessed over TLS and behind the nginx proxy with tenant isolation headers. Log only anonymized study identifiers, never raw UIDs. Consider using POST instead of GET for sensitive DICOM searches where available.

#### FINDING: [SEC6] Console logging in production error handlers
- **severity**: LOW
- **file**: `/Users/toko/Desktop/LiverRa/packages/app/src/emr/services/pacs/dicomwebClient.ts`
- **line**: 453, 470, 595
- **description**: `console.error()` is called in STOW-RS failure handlers with response previews. In some browsers, console output may be captured by monitoring tools or debugging proxies, potentially exposing DICOM metadata or error context.
- **suggestedFix**: Replace console logs with structured logging via Sentry that applies PHI scrubbing before transmission. Ensure sensitive error context is never logged to the console in production.

#### FINDING: [SEC7] Fetch requests missing explicit error handling on non-API endpoints
- **severity**: LOW
- **file**: `/Users/toko/Desktop/LiverRa/packages/app/src/emr/components/upload/UploadProgress.tsx`
- **line**: 142
- **description**: A `fetch()` call to `/api/v1/system/health` does not include error handling or validation of the response. If an attacker intercepts or spoofs this endpoint, the application could misinterpret health status.
- **suggestedFix**: Add explicit `.catch()` and validate HTTP status code before assuming success. Use `credentials: 'include'` if authentication is required.

#### FINDING: [SEC8] Potential XSS risk in error message display
- **severity**: MEDIUM
- **file**: `/Users/toko/Desktop/LiverRa/packages/app/src/emr/components/common/EMRErrorBoundary.tsx`
- **line**: 133-136
- **description**: The error boundary logs `error` and `errorInfo.componentStack` to console, which is then rendered in development mode. While the component itself does not use `dangerouslySetInnerHTML`, if error messages include untrusted content (e.g., from API responses), the console output could contain XSS payloads that are later executed if copied into dev tools.
- **suggestedFix**: Sanitize error messages before logging. Strip HTML/script tags from untrusted error text using DOMPurify or a sanitization library.

## Summary

No critical secrets or credentials were found hardcoded in production code. However:
- **2 MEDIUM issues**: Hardcoded fallback secrets in services (invite, RUO signing) and overly permissive CORS
- **1 MEDIUM issue**: DICOM UID exposure in query parameters (DICOM-specific regulatory risk)
- **1 MEDIUM issue**: Potential XSS in error boundary rendering
- **3 LOW issues**: Weak random ID generation, console logging of error details, missing fetch error handling

The application demonstrates strong security practices:
- JWT-based authentication with step-up challenges
- RLS session isolation per tenant in database
- Comprehensive security headers (CSP, HSTS, X-Frame-Options)
- Auth middleware enforced on all non-public routes
- PHI scrubber applied to observability pipelines
- DICOM UID validation to prevent path traversal
- No `eval()`, `innerHTML`, or `dangerouslySetInnerHTML` detected
- No SQL injection risk (parameterized queries throughout)
- No hardcoded API keys or Cognito secrets in source

All findings are LOW-to-MEDIUM severity with clear remediation paths. Apply fixes before production deployment.
