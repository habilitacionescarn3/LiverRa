// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * Dev-only mock backend fixtures.
 *
 * Loaded by `liverraDevApiStub()` in vite.config.ts. Returns realistic,
 * PHI-free sample data for every major endpoint so the UI renders end-
 * to-end without a real FastAPI backend. Disable with:
 *     VITE_LIVERRA_MOCK_API=false
 *
 * When the real backend is online, delete or ignore this file.
 */

export interface MockHandlerCtx {
  url: string;
  path: string;
  query: URLSearchParams;
  method: string;
}

type HandlerResult = { status: number; body: unknown } | null;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const iso = (offset = 0): string => new Date(now + offset).toISOString();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
const USERS = [
  {
    id: 'user-001',
    email: 'l.gogichaishvili@geohospitals.ge',
    display_name: 'Dr. Levan Gogichaishvili',
    role: 'hpb_surgeon',
    locale_preference: 'en',
    suspended: false,
    ruo_accepted_at: iso(-30 * DAY),
    mfa_enrolled_at: iso(-30 * DAY),
    last_active_at: iso(-2 * 3600 * 1000),
  },
  {
    id: 'user-002',
    email: 'z.giorgadze@geohospitals.ge',
    display_name: 'Dr. Zviad Giorgadze',
    role: 'radiologist',
    locale_preference: 'ka',
    suspended: false,
    ruo_accepted_at: iso(-28 * DAY),
    mfa_enrolled_at: iso(-28 * DAY),
    last_active_at: iso(-20 * 60 * 1000),
  },
  {
    id: 'user-003',
    email: 'i.giorgadze@liverra.ai',
    display_name: 'Irakli Giorgadze',
    role: 'admin',
    locale_preference: 'en',
    suspended: false,
    ruo_accepted_at: iso(-45 * DAY),
    mfa_enrolled_at: iso(-45 * DAY),
    last_active_at: iso(-5 * 60 * 1000),
  },
  {
    id: 'user-004',
    email: 'h.schlitt@ukr.de',
    display_name: 'Prof. Hans Schlitt',
    role: 'hpb_surgeon',
    locale_preference: 'de',
    suspended: false,
    ruo_accepted_at: iso(-10 * DAY),
    mfa_enrolled_at: iso(-10 * DAY),
    last_active_at: iso(-1 * DAY),
  },
  {
    id: 'user-005',
    email: 'l.svanadze@liverra.ai',
    display_name: 'Lika Svanadze',
    role: 'operations',
    locale_preference: 'en',
    suspended: false,
    ruo_accepted_at: iso(-60 * DAY),
    mfa_enrolled_at: iso(-60 * DAY),
    last_active_at: iso(-15 * 60 * 1000),
  },
  {
    id: 'user-006',
    email: 'dpo@geohospitals.ge',
    display_name: 'GEO Data Protection Officer',
    role: 'dpo',
    locale_preference: 'en',
    suspended: false,
    ruo_accepted_at: iso(-90 * DAY),
    mfa_enrolled_at: iso(-90 * DAY),
    last_active_at: iso(-4 * DAY),
  },
  {
    id: 'user-007',
    email: 'compliance@liverra.ai',
    display_name: 'Compliance Reviewer',
    role: 'compliance',
    locale_preference: 'de',
    suspended: false,
    ruo_accepted_at: iso(-20 * DAY),
    mfa_enrolled_at: iso(-20 * DAY),
    last_active_at: iso(-3 * 3600 * 1000),
  },
  {
    id: 'user-008',
    email: 'suspended.fellow@geohospitals.ge',
    display_name: 'Suspended Fellow (Demo)',
    role: 'fellow',
    locale_preference: 'ka',
    suspended: true,
    ruo_accepted_at: iso(-120 * DAY),
    mfa_enrolled_at: null,
    last_active_at: iso(-60 * DAY),
  },
];

// ---------------------------------------------------------------------------
// Analyses (Cases list + Detail)
// ---------------------------------------------------------------------------
const ANALYSES = [
  {
    analysisId: 'case-2026-0412',
    studyUidShort: '1.2.840…a1b2',
    patientReference: 'MRN-4721',
    uploadedAt: iso(-2 * 3600 * 1000),
    status: 'done',
    flrPct: 38.4,
    phaseCoverage: ['native', 'arterial', 'portal', 'venous'],
  },
  {
    analysisId: 'case-2026-0411',
    studyUidShort: '1.2.840…c3d4',
    patientReference: 'MRN-4718',
    uploadedAt: iso(-6 * 3600 * 1000),
    status: 'done',
    flrPct: 27.9,
    phaseCoverage: ['portal', 'venous'],
  },
  {
    analysisId: 'case-2026-0410',
    studyUidShort: '1.2.840…e5f6',
    patientReference: 'MRN-4715',
    uploadedAt: iso(-1 * DAY),
    status: 'done',
    flrPct: 42.1,
    phaseCoverage: ['arterial', 'portal', 'venous', 'delayed'],
  },
  {
    analysisId: 'case-2026-0409',
    studyUidShort: '1.2.840…1234',
    patientReference: 'MRN-4702',
    uploadedAt: iso(-1 * DAY - 3 * 3600 * 1000),
    status: 'done',
    flrPct: 31.5,
    phaseCoverage: ['portal', 'venous'],
  },
  {
    analysisId: 'case-2026-0408',
    studyUidShort: '1.2.840…5678',
    patientReference: 'MRN-4690',
    uploadedAt: iso(-2 * DAY),
    status: 'done',
    flrPct: 44.8,
    phaseCoverage: ['native', 'arterial', 'portal', 'venous'],
  },
  {
    analysisId: 'case-2026-0407',
    studyUidShort: '1.2.840…9abc',
    patientReference: 'MRN-4685',
    uploadedAt: iso(-10 * 60 * 1000),
    status: 'running',
    phaseCoverage: ['portal', 'venous'],
  },
  {
    analysisId: 'case-2026-0406',
    studyUidShort: '1.2.840…def0',
    patientReference: 'MRN-4681',
    uploadedAt: iso(-4 * 60 * 1000),
    status: 'running',
    phaseCoverage: ['arterial', 'portal'],
  },
  {
    analysisId: 'case-2026-0405',
    studyUidShort: '1.2.840…abcd',
    patientReference: 'MRN-4677',
    uploadedAt: iso(-2 * 60 * 1000),
    status: 'queued',
    phaseCoverage: ['portal', 'venous'],
  },
  {
    analysisId: 'case-2026-0404',
    studyUidShort: '1.2.840…efgh',
    patientReference: 'MRN-4673',
    uploadedAt: iso(-90 * 1000),
    status: 'anonymizing',
    phaseCoverage: ['portal'],
  },
  {
    analysisId: 'case-2026-0403',
    studyUidShort: '1.2.840…ijkl',
    patientReference: 'MRN-4669',
    uploadedAt: iso(-30 * 1000),
    status: 'uploading',
    phaseCoverage: [],
  },
  {
    analysisId: 'case-2026-0402',
    studyUidShort: '1.2.840…mnop',
    patientReference: 'MRN-4640',
    uploadedAt: iso(-3 * DAY),
    status: 'failed',
    phaseCoverage: ['portal'],
  },
  {
    analysisId: 'case-2026-0401',
    studyUidShort: '1.2.840…qrst',
    patientReference: 'MRN-4612',
    uploadedAt: iso(-4 * DAY),
    status: 'cancelled',
    phaseCoverage: ['native', 'arterial', 'portal'],
  },
];

function analysisDetail(id: string): unknown {
  const row = ANALYSES.find((a) => a.analysisId === id) ?? ANALYSES[0];
  return {
    id: row.analysisId,
    status: row.status,
    studyUidShort: row.studyUidShort,
    patientReference: row.patientReference,
    createdAt: row.uploadedAt,
    flrPct: row.flrPct,
    reportUrl: row.status === 'done' ? `/api/v1/reports/${row.analysisId}` : undefined,
  };
}

// ---------------------------------------------------------------------------
// Lesions (results payload)
// ---------------------------------------------------------------------------
function analysisResults(id: string): unknown {
  return {
    analysis_id: id,
    parenchyma_uri: `s3://liverra-dev/${id}/parenchyma.nii.gz`,
    segments_uri: `s3://liverra-dev/${id}/couinaud.nii.gz`,
    vessels_uri: `s3://liverra-dev/${id}/vessels.nii.gz`,
    total_liver_volume_ml: 1484.2,
    flr: { plane_defined: true, remnant_volume_ml: 569.6, flr_pct: 38.4 },
    lesions: [
      {
        id: 'lesion-1',
        segment: 'VII',
        diameter_mm: 42.1,
        volume_ml: 23.7,
        centroid: [120, 88, 64],
        detected_by: 'ai',
        classification: {
          predicted_class: 'hcc',
          confidence: 0.87,
          class_probs: { hcc: 0.87, icc: 0.04, metastasis: 0.05, fnh: 0.01, hemangioma: 0.02, cyst: 0.01 },
          abstained: false,
          reviewer_override: null,
        },
      },
      {
        id: 'lesion-2',
        segment: 'IVb',
        diameter_mm: 18.9,
        volume_ml: 3.2,
        centroid: [95, 102, 70],
        detected_by: 'ai',
        classification: {
          predicted_class: 'metastasis',
          confidence: 0.72,
          class_probs: { hcc: 0.05, icc: 0.08, metastasis: 0.72, fnh: 0.03, hemangioma: 0.10, cyst: 0.02 },
          abstained: false,
          reviewer_override: null,
        },
      },
      {
        id: 'lesion-3',
        segment: 'VIII',
        diameter_mm: 12.4,
        volume_ml: 1.0,
        centroid: [140, 110, 72],
        detected_by: 'ai',
        classification: {
          predicted_class: null,
          confidence: 0.31,
          class_probs: { hcc: 0.21, icc: 0.18, metastasis: 0.16, fnh: 0.14, hemangioma: 0.13, cyst: 0.18 },
          abstained: true,
          reviewer_override: null,
        },
      },
      {
        id: 'lesion-4',
        segment: 'II',
        diameter_mm: 8.1,
        volume_ml: 0.28,
        centroid: [60, 74, 58],
        detected_by: 'reviewer',
        classification: {
          predicted_class: 'cyst',
          confidence: 0.94,
          class_probs: { hcc: 0.01, icc: 0.01, metastasis: 0.01, fnh: 0.02, hemangioma: 0.01, cyst: 0.94 },
          abstained: false,
          reviewer_override: null,
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Ops queue
// ---------------------------------------------------------------------------
const OPS_QUEUE = {
  queued: [
    {
      analysis_id: 'case-2026-0405',
      study_id: 'study-405',
      tenant_id: 'geo-hospitals',
      status: 'queued',
      queued_at: iso(-2 * 60 * 1000),
      started_at: null,
      pipeline_version: '1.0.0-mvp',
      model_versions: { stunet: '1.4b-sha-7f3a', couinaud: 'pc-sha-22bd', lilnet: 'lil-sha-aae1' },
      error_slug: null,
      last_stage: null,
      last_stage_at: null,
      stuck_minutes: null,
    },
    {
      analysis_id: 'case-2026-0404',
      study_id: 'study-404',
      tenant_id: 'geo-hospitals',
      status: 'anonymizing',
      queued_at: iso(-90 * 1000),
      started_at: iso(-60 * 1000),
      pipeline_version: '1.0.0-mvp',
      model_versions: { ctp: '3.1' },
      error_slug: null,
      last_stage: 'anonymization',
      last_stage_at: iso(-45 * 1000),
      stuck_minutes: null,
    },
  ],
  running: [
    {
      analysis_id: 'case-2026-0407',
      study_id: 'study-407',
      tenant_id: 'geo-hospitals',
      status: 'running',
      queued_at: iso(-10 * 60 * 1000),
      started_at: iso(-9 * 60 * 1000),
      pipeline_version: '1.0.0-mvp',
      model_versions: { stunet: '1.4b-sha-7f3a', couinaud: 'pc-sha-22bd' },
      error_slug: null,
      last_stage: 'couinaud_segmentation',
      last_stage_at: iso(-30 * 1000),
      stuck_minutes: null,
    },
    {
      analysis_id: 'case-2026-0406',
      study_id: 'study-406',
      tenant_id: 'regensburg-uk',
      status: 'running',
      queued_at: iso(-4 * 60 * 1000),
      started_at: iso(-3.5 * 60 * 1000),
      pipeline_version: '1.0.0-mvp',
      model_versions: { stunet: '1.4b-sha-7f3a' },
      error_slug: null,
      last_stage: 'parenchyma_segmentation',
      last_stage_at: iso(-90 * 1000),
      stuck_minutes: null,
    },
  ],
  stuck_over_15min: [
    {
      analysis_id: 'case-2026-0393',
      study_id: 'study-393',
      tenant_id: 'geo-hospitals',
      status: 'running',
      queued_at: iso(-40 * 60 * 1000),
      started_at: iso(-38 * 60 * 1000),
      pipeline_version: '1.0.0-mvp',
      model_versions: { stunet: '1.4b-sha-7f3a', lilnet: 'lil-sha-aae1' },
      error_slug: null,
      last_stage: 'lesion_classification',
      last_stage_at: iso(-22 * 60 * 1000),
      stuck_minutes: 22,
    },
  ],
  gpu_utilization_pct: 72,
  cold_start_rate_last_hour: 0.08,
};

// ---------------------------------------------------------------------------
// MBoM (Apache-2.0 models from CLAUDE.md)
// ---------------------------------------------------------------------------
const MBOM = [
  {
    model_name: 'STU-Net (1.4B)',
    source_url: 'https://github.com/uni-medical/STU-Net',
    pinned_commit_sha: '7f3ae23cc14d0b9a2c1d5f8e9a2b3c4d5e6f7a8b',
    license_text_hash_hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    license_name: 'Apache-2.0',
    integration_date: iso(-45 * DAY),
    approver: 'Irakli Giorgadze',
  },
  {
    model_name: 'Pictorial Couinaud',
    source_url: 'https://github.com/xukun-zhang/Couinaud-Segmentation',
    pinned_commit_sha: '22bd8f11a0c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
    license_text_hash_hex: '2c6ac3de7e3c3c3b4b4a4a3b2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2',
    license_name: 'Apache-2.0',
    integration_date: iso(-42 * DAY),
    approver: 'Irakli Giorgadze',
  },
  {
    model_name: 'LiLNet',
    source_url: 'https://github.com/yangmeiyi/Liver',
    pinned_commit_sha: 'aae1f23cc14d0b9a2c1d5f8e9a2b3c4d5e6f7a8b',
    license_text_hash_hex: '3d6ac3de7e3c3c3b4b4a4a3b2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2',
    license_name: 'Apache-2.0',
    integration_date: iso(-40 * DAY),
    approver: 'Irakli Giorgadze',
  },
  {
    model_name: 'VISTA3D',
    source_url: 'https://github.com/Project-MONAI/VISTA',
    pinned_commit_sha: 'bdc2f11a0c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7a',
    license_text_hash_hex: '4e6ac3de7e3c3c3b4b4a4a3b2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2',
    license_name: 'Apache-2.0',
    integration_date: iso(-38 * DAY),
    approver: 'Compliance Reviewer',
  },
  {
    model_name: 'MedSAM-2',
    source_url: 'https://github.com/MedicineToken/Medical-SAM2',
    pinned_commit_sha: 'cef3d11a0c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7a',
    license_text_hash_hex: '5f6ac3de7e3c3c3b4b4a4a3b2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2',
    license_name: 'Apache-2.0',
    integration_date: iso(-36 * DAY),
    approver: 'Compliance Reviewer',
  },
];

// ---------------------------------------------------------------------------
// Audit events
// ---------------------------------------------------------------------------
const AUDIT = Array.from({ length: 24 }).map((_, i) => {
  const cats = [
    'auth.login',
    'study.upload',
    'analysis.complete',
    'review.finalize',
    'report.pacs_push',
    'admin.user_invite',
    'admin.user_suspend',
    'compliance.claim_update',
    'erasure.request',
    'erasure.execute',
    'mbom.upload',
    'report.retract',
  ];
  const actors = [
    'l.gogichaishvili@geohospitals.ge',
    'z.giorgadze@geohospitals.ge',
    'i.giorgadze@liverra.ai',
    'h.schlitt@ukr.de',
    'dpo@geohospitals.ge',
    'compliance@liverra.ai',
    'system',
  ];
  const outcomes = ['success', 'success', 'success', 'success', 'failure'];
  const cat = cats[i % cats.length];
  return {
    id: `audit-${1000 + i}`,
    sequence_no: 1000 + i,
    category: cat,
    recorded: iso(-i * 3600 * 1000),
    actor: actors[i % actors.length],
    outcome: outcomes[i % outcomes.length],
    summary: `${cat.replace('.', ' ')} — case-2026-04${String(12 - (i % 12)).padStart(2, '0')}`,
  };
});

// ---------------------------------------------------------------------------
// Claim registry (7 regulatory claims per tenant)
// ---------------------------------------------------------------------------
const CLAIMS = [
  { claim_key: 'parenchyma_volumetry', status: 'ruo', effective_from: iso(-60 * DAY), regulatory_reference: null },
  { claim_key: 'flr', status: 'ruo', effective_from: iso(-60 * DAY), regulatory_reference: null },
  { claim_key: 'couinaud_segmentation', status: 'under_conformity_assessment', effective_from: iso(-30 * DAY), regulatory_reference: 'BSI MDR ref pending' },
  { claim_key: 'vessel_identification', status: 'ruo', effective_from: iso(-60 * DAY), regulatory_reference: null },
  { claim_key: 'lesion_detection', status: 'ruo', effective_from: iso(-60 * DAY), regulatory_reference: null },
  { claim_key: 'lesion_classification', status: 'ruo', effective_from: iso(-60 * DAY), regulatory_reference: null },
  { claim_key: 'surgical_planning', status: 'ruo', effective_from: iso(-60 * DAY), regulatory_reference: null },
];

// ---------------------------------------------------------------------------
// Erasure requests (GDPR Art. 17)
// ---------------------------------------------------------------------------
const ERASURE = [
  {
    id: 'erasure-001',
    target_study_id: 'study-2026-0321',
    status: 'completed',
    requested_at: iso(-5 * DAY),
    completed_at: iso(-5 * DAY + 10 * 60 * 1000),
    tombstone_hash_hex: 'a3f5d2e1c8b9a0f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3',
    confirmation_pdf_url: '/api/v1/erasure/requests/erasure-001/confirmation.pdf',
    dpo_email: 'dpo@geohospitals.ge',
    justification: 'Patient withdrawal of consent (GDPR Art. 17(1)(b))',
  },
  {
    id: 'erasure-002',
    target_study_id: 'study-2026-0388',
    status: 'in_progress',
    requested_at: iso(-1 * DAY),
    completed_at: null,
    tombstone_hash_hex: null,
    confirmation_pdf_url: null,
    dpo_email: 'dpo@geohospitals.ge',
    justification: 'Patient request — incorrect MRN linkage',
  },
  {
    id: 'erasure-003',
    target_study_id: 'study-2026-0399',
    status: 'pending',
    requested_at: iso(-3 * 3600 * 1000),
    completed_at: null,
    tombstone_hash_hex: null,
    confirmation_pdf_url: null,
    dpo_email: 'dpo@geohospitals.ge',
    justification: 'Purpose limitation expired (retention policy)',
  },
];

// ---------------------------------------------------------------------------
// RUO spot-check artifacts
// ---------------------------------------------------------------------------
const RUO_SAMPLE = Array.from({ length: 6 }).map((_, i) => ({
  artifact_id: `artifact-${i + 1}`,
  artifact_url: `/assets/ruo-samples/sample-${i + 1}.png`,
  artifact_kind: i % 2 === 0 ? 'report_pdf' : 'viewer_screenshot',
  watermark_bbox: [10, 10, 120, 28],
  pass: null,
}));

// ---------------------------------------------------------------------------
// Audit summary (chain verification)
// ---------------------------------------------------------------------------
const AUDIT_SUMMARY = {
  chain_valid: true,
  chain_first_invalid_sequence_no: null,
  events: AUDIT.slice(0, 10).map((e, i) => ({
    id: e.id,
    chain_sequence_no: e.sequence_no,
    timestamp: e.recorded,
    category: e.category,
    actor: e.actor,
    subject: `case-2026-04${String(12 - (i % 12)).padStart(2, '0')}`,
    outcome: e.outcome,
  })),
};

// ---------------------------------------------------------------------------
// Tenant + onboarding
// ---------------------------------------------------------------------------
const TENANT = {
  id: 'geo-hospitals',
  name: 'Geo Hospitals Tbilisi',
  locale_default: 'en',
  pacs_destination: { ae_title: 'GEOHOSPACS', host: 'pacs.geohospitals.local', port: 11112, use_tls: true, cert_fingerprint: 'SHA256:aa:bb:cc:dd:ee:ff' },
  allow_partial_coverage_override: false,
};

const ONBOARDING_STATUS = {
  user_id: 'user-001',
  tenant_id: 'geo-hospitals',
  ruo_accepted_at: iso(-30 * DAY),
  mfa_enrolled_at: iso(-30 * DAY),
  sample_case_run_at: iso(-25 * DAY),
  tour_completed_at: iso(-25 * DAY),
  completed: true,
  sample_case_analysis_id: 'case-2026-0410',
};

// ---------------------------------------------------------------------------
// Notification preferences (9 event types)
// ---------------------------------------------------------------------------
const NOTIFICATION_EVENT_TYPES = [
  'analysis_complete',
  'analysis_failed',
  'queued_long',
  'pacs_failed',
  'mfa_reset',
  'invite_accepted',
  'erasure_confirmed',
  'phi_incident',
  'maintenance_window',
] as const;

let notificationPrefs = NOTIFICATION_EVENT_TYPES.map((event_type) => ({
  user_id: 'user-001',
  event_type,
  opted_out: event_type === 'maintenance_window',
  locked: event_type === 'phi_incident',
}));

// ---------------------------------------------------------------------------
// Reports (finalize output)
// ---------------------------------------------------------------------------
function reportPayload(reportId: string, analysisId: string) {
  return {
    id: reportId,
    analysis_id: analysisId,
    status: 'complete',
    created_at: iso(-60 * 1000),
    finalized_at: iso(-30 * 1000),
    artifacts: [
      { kind: 'pdf', uri: `/api/v1/reports/${reportId}/artifact/pdf`, sop_instance_uid: '1.2.840.99999.1', size_bytes: 842_112 },
      { kind: 'dicom_seg', uri: `/api/v1/reports/${reportId}/artifact/seg`, sop_instance_uid: '1.2.840.99999.2', size_bytes: 12_448_320 },
      { kind: 'dicom_sr', uri: `/api/v1/reports/${reportId}/artifact/sr`, sop_instance_uid: '1.2.840.99999.3', size_bytes: 48_512 },
    ],
    deliveries: [
      { delivery_id: 'dlv-001', kind: 'pdf', status: 'acknowledged', attempts: 1, last_error: null, updated_at: iso(-30 * 1000) },
      { delivery_id: 'dlv-002', kind: 'dicom_seg', status: 'pending', attempts: 0, last_error: null, updated_at: iso(-30 * 1000) },
      { delivery_id: 'dlv-003', kind: 'dicom_sr', status: 'sending', attempts: 1, last_error: null, updated_at: iso(-10 * 1000) },
    ],
    retracted: false,
    superseded_by_report_id: null,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export function handleMockRequest(ctx: MockHandlerCtx): HandlerResult {
  const { path, method, query } = ctx;

  // --- Cases list + detail + results ---
  if (path === '/api/v1/analyses' && method === 'GET') {
    const status = query.get('status');
    const items = status && status !== 'all'
      ? ANALYSES.filter((a) => a.status === status)
      : ANALYSES;
    return { status: 200, body: { items, total: items.length } };
  }

  const analysisDetail_m = path.match(/^\/api\/v1\/analyses\/([^/]+)$/);
  if (analysisDetail_m && method === 'GET') {
    return { status: 200, body: analysisDetail(analysisDetail_m[1]) };
  }

  const analysisResults_m = path.match(/^\/api\/v1\/analyses\/([^/]+)\/results$/);
  if (analysisResults_m && method === 'GET') {
    return { status: 200, body: analysisResults(analysisResults_m[1]) };
  }

  // --- Admin ---
  if (path === '/api/v1/admin/users' && method === 'GET') return { status: 200, body: USERS };
  if (path === '/api/v1/admin/users/invite' && method === 'POST') {
    return { status: 200, body: { invite_id: `invite-${Date.now()}`, expires_at: iso(7 * DAY) } };
  }
  if (/^\/api\/v1\/admin\/users\/[^/]+\/suspend$/.test(path) && method === 'POST') {
    return { status: 204, body: null };
  }
  if (path === '/api/v1/admin/tenants/me' && method === 'GET') return { status: 200, body: TENANT };
  if (path === '/api/v1/admin/audit' && method === 'GET') return { status: 200, body: AUDIT };
  if (path === '/api/v1/admin/pacs-destination' && method === 'GET') {
    return { status: 200, body: TENANT.pacs_destination };
  }
  if (path === '/api/v1/admin/pacs-destination/echo' && method === 'POST') {
    return { status: 200, body: { success: true, rtt_ms: 34, remote_ae: 'GEOHOSPACS' } };
  }

  // --- Auth + onboarding ---
  if (path === '/api/v1/auth/me' && method === 'GET') {
    return {
      status: 200,
      body: {
        user: USERS[0],
        tenant: TENANT,
        permissions: [
          'study.view', 'study.upload',
          'analysis.view', 'analysis.retry',
          'review.refine_mask', 'review.flr_adjust', 'review.override_classification', 'review.reprompt_lesion',
          'report.view', 'report.finalize', 'report.download', 'report.pacs_push',
          'audit.view', 'mbom.view', 'compliance.view', 'claim_registry.view',
          'ops.queue_view',
          'admin.user_create', 'admin.user_role_change', 'pacs.config_read', 'pacs.config_write', 'pacs.c_echo',
          'erasure.request', 'erasure.approve', 'erasure.execute',
        ],
      },
    };
  }
  if (path === '/api/v1/auth/me/onboarding-status' && method === 'GET') {
    return { status: 200, body: ONBOARDING_STATUS };
  }

  // --- Ops ---
  if (path === '/api/v1/ops/queue' && method === 'GET') return { status: 200, body: OPS_QUEUE };

  // --- Compliance ---
  if (path === '/api/v1/compliance/mbom' && method === 'GET') return { status: 200, body: MBOM };
  if (path === '/api/v1/compliance/claims' && method === 'GET') return { status: 200, body: CLAIMS };
  if (path === '/api/v1/compliance/claim-registry' && method === 'GET') return { status: 200, body: CLAIMS };
  if (/^\/api\/v1\/compliance\/claims\/[^/]+$/.test(path) && method === 'PUT') {
    return { status: 200, body: { ok: true } };
  }
  if (path === '/api/v1/compliance/audit-summary' && method === 'POST') {
    return { status: 200, body: AUDIT_SUMMARY };
  }
  if (path === '/api/v1/compliance/ruo-spot-check' && method === 'GET') {
    return { status: 200, body: RUO_SAMPLE };
  }

  // --- Erasure ---
  if (path === '/api/v1/erasure/requests' && method === 'GET') return { status: 200, body: ERASURE };
  if (path === '/api/v1/erasure/requests' && method === 'POST') {
    return {
      status: 201,
      body: {
        id: `erasure-${Date.now()}`,
        erasure_request_id: `erasure-${Date.now()}`,
        status: 'pending',
        tombstone_hash_hex: null,
        confirmation_pdf_url: null,
      },
    };
  }
  const erasureDetail_m = path.match(/^\/api\/v1\/erasure\/requests\/([^/]+)$/);
  if (erasureDetail_m && method === 'GET') {
    const match = ERASURE.find((e) => e.id === erasureDetail_m[1]);
    return { status: 200, body: match ?? ERASURE[0] };
  }

  // --- Reviews (seat lifecycle + mutations) ---
  if (path === '/api/v1/reviews' && method === 'POST') {
    return {
      status: 201,
      body: {
        review_id: `review-${Date.now()}`,
        analysis_id: query.get('analysis_id') ?? 'case-2026-0412',
        seat_held_until: iso(60 * 1000),
        heartbeat_interval_s: 15,
        holder_user_id: 'user-001',
      },
    };
  }
  const reviewHeartbeat_m = path.match(/^\/api\/v1\/reviews\/([^/]+)\/heartbeat$/);
  if (reviewHeartbeat_m && method === 'POST') {
    return { status: 200, body: { seat_held_until: iso(60 * 1000) } };
  }
  const reviewRelease_m = path.match(/^\/api\/v1\/reviews\/([^/]+)$/);
  if (reviewRelease_m && method === 'DELETE') {
    return { status: 204, body: null };
  }
  const maskRefine_m = path.match(/^\/api\/v1\/reviews\/([^/]+)\/mask-refine$/);
  if (maskRefine_m && method === 'POST') {
    return {
      status: 200,
      body: {
        segmentation_id: `seg-${Date.now()}`,
        status: 'complete',
        generation_source: 'reviewer_edited',
        model: 'vista3d',
        latency_ms: 820,
      },
    };
  }
  const classOverride_m = path.match(/^\/api\/v1\/reviews\/([^/]+)\/classification-override$/);
  if (classOverride_m && method === 'POST') {
    return {
      status: 200,
      body: {
        classification_id: `cls-${Date.now()}`,
        status: 'complete',
      },
    };
  }
  const lesionPrompt_m = path.match(/^\/api\/v1\/reviews\/([^/]+)\/lesion-prompt$/);
  if (lesionPrompt_m && method === 'POST') {
    return {
      status: 200,
      body: {
        lesion_id: `lesion-${Date.now()}`,
        segment: 'V',
        diameter_mm: 15.3,
        volume_ml: 1.9,
        predicted_class: 'metastasis',
        confidence: 0.82,
        detected_by: 'reviewer',
        model: 'medsam-2',
      },
    };
  }
  const reviewFlr_m = path.match(/^\/api\/v1\/reviews\/([^/]+)\/flr$/);
  if (reviewFlr_m && method === 'POST') {
    return { status: 200, body: { flr_pct: 38.4, remnant_volume_ml: 569.6, plane_defined: true } };
  }
  const finalize_m = path.match(/^\/api\/v1\/reviews\/([^/]+)\/finalize$/);
  if (finalize_m && method === 'POST') {
    const reportId = `report-${Date.now()}`;
    return {
      status: 202,
      body: {
        report_id: reportId,
        status: 'generating',
        polling_url: `/api/v1/reports/${reportId}`,
      },
    };
  }

  // --- Reports ---
  const reportDetail_m = path.match(/^\/api\/v1\/reports\/([^/]+)$/);
  if (reportDetail_m && method === 'GET') {
    return { status: 200, body: reportPayload(reportDetail_m[1], 'case-2026-0412') };
  }
  const pacsPush_m = path.match(/^\/api\/v1\/reports\/([^/]+)\/pacs-push$/);
  if (pacsPush_m && method === 'POST') {
    return {
      status: 202,
      body: { delivery_id: `dlv-${Date.now()}`, status: 'pending', attempts: 0 },
    };
  }
  const pacsRetry_m = path.match(/^\/api\/v1\/reports\/([^/]+)\/pacs-push\/([^/]+)\/retry$/);
  if (pacsRetry_m && method === 'POST') {
    return {
      status: 202,
      body: { delivery_id: pacsRetry_m[2], status: 'pending', attempts: 2 },
    };
  }
  const retract_m = path.match(/^\/api\/v1\/reports\/([^/]+)\/retract$/);
  if (retract_m && method === 'POST') {
    return { status: 204, body: null };
  }

  // --- Auth / profile ---
  if (path === '/api/v1/auth/me' && method === 'PUT') {
    return {
      status: 200,
      body: { ...USERS[0], last_active_at: iso(0) },
    };
  }
  if (path === '/api/v1/auth/me/mfa-reset-request' && method === 'POST') {
    return {
      status: 202,
      body: {
        request_id: `mfa-reset-${Date.now()}`,
        admin_contact: 'i.giorgadze@liverra.ai',
        message: 'Admin has been notified. You will receive an email with reset instructions.',
      },
    };
  }
  if (path === '/api/v1/auth/me/ruo-accept' && method === 'POST') {
    return {
      status: 200,
      body: { accepted_at: iso(0), signature_hash: 'sha256:mock' },
    };
  }

  // --- Notification preferences ---
  if (path === '/api/v1/auth/me/notification-preferences' && method === 'GET') {
    return { status: 200, body: notificationPrefs };
  }
  if (path === '/api/v1/auth/me/notification-preferences' && method === 'PUT') {
    // In a real impl we'd parse the body; in the mock we just flip the requested one if included via query,
    // otherwise return current state. The view uses optimistic updates so this is low-risk.
    return { status: 200, body: notificationPrefs };
  }

  // --- System ---
  if (path === '/api/v1/system/health') return { status: 200, body: { ok: true, uptime_s: 86400 } };
  if (path === '/api/v1/system/version') return { status: 200, body: { version: '0.1.0-mvp-mock', build: 'dev' } };

  return null;
}
