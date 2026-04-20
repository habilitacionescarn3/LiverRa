// SPDX-License-Identifier: Apache-2.0

/**
 * AuditChainVerifier component tests (T353).
 *
 * Plain-English: feed the verifier synthetic summaries — a valid one,
 * a tampered one, and an empty one — and assert the UI renders the
 * right badge + highlights the first invalid sequence + shows the S3
 * anchor links.
 *
 * These tests are deliberately lightweight; they assert on
 * `data-testid` selectors to avoid coupling to translation strings.
 *
 * Spec ref: SC-010.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import { AuditChainVerifier } from '../AuditChainVerifier';
import type { AuditSummaryResponse } from '../../../hooks/useAuditSummary';

// Minimal translation mock: we don't want the real context / translation
// bundle for this test — just echo the translation keys back so the
// assertions stay stable.
vi.mock('../../../contexts/TranslationContext', () => ({
  useTranslation: () => ({
    t: (k: string, vars?: Record<string, string | number>) => {
      if (!vars) return k;
      return `${k}:${JSON.stringify(vars)}`;
    },
  }),
}));

function withMantine(ui: React.ReactElement) {
  return render(<MantineProvider>{ui}</MantineProvider>);
}

const TS = '2026-04-12T09:15:30Z';

function buildValidSummary(): AuditSummaryResponse {
  return {
    events: [
      {
        id: 'evt-1',
        category: 'study_upload',
        actor: 'User/alice',
        subject: 'Study/abc',
        timestamp: TS,
        outcome: 'success',
        chain_sequence_no: 1,
      },
      {
        id: 'evt-2',
        category: 'inference_stage_end',
        actor: 'System/cascade',
        subject: 'Analysis/xyz',
        timestamp: TS,
        outcome: 'success',
        chain_sequence_no: 2,
      },
    ],
    chain_valid: true,
    chain_first_invalid_sequence_no: null,
    merkle_root_for_window: 'aabbccdd',
    s3_anchor_uris: [
      's3://liverra-audit-anchors-eu-central-1/merkle/T/2026/04/11.json',
      's3://liverra-audit-anchors-eu-central-1/merkle/T/2026/04/12.json',
    ],
  };
}

function buildTamperedSummary(firstInvalid = 2): AuditSummaryResponse {
  const s = buildValidSummary();
  s.chain_valid = false;
  s.chain_first_invalid_sequence_no = firstInvalid;
  return s;
}

describe('AuditChainVerifier', () => {
  it('renders a valid badge when chain_valid=true', () => {
    withMantine(<AuditChainVerifier summary={buildValidSummary()} />);
    expect(screen.getByTestId('audit-chain-verifier-valid')).toBeDefined();
    expect(screen.queryByTestId('audit-chain-verifier-invalid')).toBeNull();
  });

  it('renders the invalid alert and highlights first invalid sequence', () => {
    const summary = buildTamperedSummary(2);
    withMantine(<AuditChainVerifier summary={summary} />);
    const invalidAlert = screen.getByTestId('audit-chain-verifier-invalid');
    expect(invalidAlert).toBeDefined();
    // `t` is mocked to echo the key + vars — assert the vars encoded
    // the first-invalid sequence number so the UI is pointing at row 2.
    expect(invalidAlert.textContent).toContain('"seq":"2"');
  });

  it('lists every S3 Merkle anchor link when the chain is invalid', () => {
    const summary = buildTamperedSummary(2);
    withMantine(<AuditChainVerifier summary={summary} />);
    const anchors = screen.getAllByTestId('audit-chain-s3-anchor');
    expect(anchors.length).toBe(summary.s3_anchor_uris.length);
    expect(anchors[0].getAttribute('href')).toBe(summary.s3_anchor_uris[0]);
  });

  it('renders an empty state when no summary is present', () => {
    withMantine(<AuditChainVerifier summary={null} />);
    expect(screen.getByTestId('audit-chain-verifier-empty')).toBeDefined();
  });

  it('renders a loading state when isLoading=true', () => {
    withMantine(<AuditChainVerifier summary={null} isLoading />);
    expect(screen.getByTestId('audit-chain-verifier-loading')).toBeDefined();
  });

  it('handles a valid chain with zero anchors without crashing', () => {
    const summary = buildValidSummary();
    summary.s3_anchor_uris = [];
    withMantine(<AuditChainVerifier summary={summary} />);
    expect(screen.getByTestId('audit-chain-verifier-valid')).toBeDefined();
  });
});
