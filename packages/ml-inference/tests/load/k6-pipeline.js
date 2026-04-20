/**
 * LiverRa k6 API load test — end-to-end cascaded pipeline.
 *
 * Plan §Load & performance · Tasks T366 · Spec §SC-002, §FR-013.
 *
 * Scenario (research §G.1):
 *   3 tenants × 5 users × 5 studies/week → 75 studies/week.
 *   Normalised: ~11 studies/day; peak burst ~3 concurrent (matches GPU
 *   concurrency budget of 3 on a single L4 24 GB, research §C.1).
 *
 * Thresholds:
 *   - p95 end-to-end analysis latency ≤ 300 000 ms (5 min, SC-002)
 *   - p99 ≤ 600 000 ms (10 min)
 *   - FLR compute p95 ≤ 1 000 ms (FR-013)
 *   - HTTP failure rate < 1%
 *
 * CI: `ci-k6-nightly` lane. Executes against staging Medplum + staging
 * FastAPI orchestrator. Do NOT run against production.
 *
 * Run locally:
 *   k6 run --env LIVERRA_API_URL=https://staging.liverra.ai --env LIVERRA_TOKEN=$DEV_TOKEN \
 *          packages/ml-inference/tests/load/k6-pipeline.js
 */

import http from 'k6/http';
import { check, group, sleep, fail } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const API_URL = __ENV.LIVERRA_API_URL || 'http://localhost:8000';
const TOKEN = __ENV.LIVERRA_TOKEN || 'dev:radiologist:tenant-load-test';

// 3 tenants × 5 users — 15 VUs total, scaled over a 1-week window.
// k6 pattern: run 15 iterations per VU, each emulating a "user-week" of 5
// studies. Compressed to a 15-minute test with ramp.
export const options = {
  scenarios: {
    per_tenant_load: {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1m',
      preAllocatedVUs: 15,
      maxVUs: 30,
      stages: [
        { duration: '2m', target: 10 }, // ramp
        { duration: '10m', target: 10 }, // sustained
        { duration: '3m', target: 0 },   // ramp down
      ],
    },
  },
  thresholds: {
    // SC-002 p95 ≤ 5 min
    'pipeline_end_to_end_ms': ['p(95)<300000', 'p(99)<600000'],
    // FR-013 FLR compute p95 ≤ 1 s
    'flr_compute_ms': ['p(95)<1000'],
    // HTTP health
    'http_req_failed': ['rate<0.01'],
    // No pipeline stage should error > 0.5%
    'pipeline_stage_failed': ['rate<0.005'],
  },
};

// ---------------------------------------------------------------------------
// Test data — tenants × users
// ---------------------------------------------------------------------------

const TENANTS = new SharedArray('tenants', () => [
  'tenant-load-a',
  'tenant-load-b',
  'tenant-load-c',
]);

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const e2eLatency = new Trend('pipeline_end_to_end_ms', true);
const flrLatency = new Trend('flr_compute_ms', true);
const stageFail = new Rate('pipeline_stage_failed');
const studiesSubmitted = new Counter('studies_submitted');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(tenantId, role = 'radiologist') {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer dev:${role}:${tenantId}`,
    'X-LiverRa-Tenant-Id': tenantId,
  };
}

function submitAnalysis(tenantId) {
  const payload = JSON.stringify({
    study_uid: `1.2.840.113619.2.5.99.${Date.now()}.${Math.random()}`,
    phase_hint: 'portal_venous',
    fixture: 'ct-001-normal',
  });
  const res = http.post(`${API_URL}/api/v1/analyses`, payload, {
    headers: authHeaders(tenantId),
  });
  check(res, {
    'analysis submit 202': (r) => r.status === 202,
  }) || stageFail.add(1);
  studiesSubmitted.add(1);
  return res.json('analysis_id');
}

function waitForAnalysisComplete(tenantId, analysisId, timeoutMs = 600000) {
  const start = Date.now();
  const pollInterval = 5000; // 5 s
  while (Date.now() - start < timeoutMs) {
    const res = http.get(`${API_URL}/api/v1/analyses/${analysisId}`, {
      headers: authHeaders(tenantId),
    });
    if (res.status !== 200) {
      stageFail.add(1);
      return { status: 'failed', ms: Date.now() - start };
    }
    const body = res.json();
    if (body.status === 'succeeded' || body.status === 'failed') {
      return { status: body.status, ms: Date.now() - start };
    }
    sleep(pollInterval / 1000);
  }
  return { status: 'timeout', ms: timeoutMs };
}

function computeFlr(tenantId, analysisId) {
  const payload = JSON.stringify({
    target_segments: [5, 6, 7, 8],
  });
  const start = Date.now();
  const res = http.post(
    `${API_URL}/api/v1/analyses/${analysisId}/flr`,
    payload,
    { headers: authHeaders(tenantId) },
  );
  const ms = Date.now() - start;
  flrLatency.add(ms);
  check(res, {
    'flr 200': (r) => r.status === 200,
    'flr body has flr_pct': (r) => r.json('flr_pct') != null,
  }) || stageFail.add(1);
  return ms;
}

// ---------------------------------------------------------------------------
// Default VU body — one "user submits a study" iteration
// ---------------------------------------------------------------------------

export default function () {
  const tenantId = TENANTS[__VU % TENANTS.length];

  group('submit + wait + flr', () => {
    const analysisId = submitAnalysis(tenantId);
    if (!analysisId) {
      fail(`submit failed for ${tenantId}`);
    }

    const outcome = waitForAnalysisComplete(tenantId, analysisId);
    e2eLatency.add(outcome.ms);
    check(outcome, {
      'analysis succeeded': (o) => o.status === 'succeeded',
    }) || stageFail.add(1);

    if (outcome.status === 'succeeded') {
      computeFlr(tenantId, analysisId);
    }
  });

  // Inter-study pacing: users submit ~1 study every 2-3 min in realistic load
  sleep(Math.random() * 60 + 30);
}
