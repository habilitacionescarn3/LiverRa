// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

import { Box, Container, Stack } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconBrush,
  IconClipboardCheck,
  IconClipboardList,
  IconEraser,
  IconFileCertificate,
  IconHelpHexagon,
  IconLogin2,
  IconServerCog,
  IconShieldCheck,
  IconTarget,
  IconTopologyStar3,
  IconUpload,
  IconUsers,
} from '@tabler/icons-react';
import type { ComponentType, ReactElement } from 'react';
import { Link } from 'react-router-dom';

import { LIVERRA_ROUTES } from '../constants/routes';

import classes from './LandingView.module.css';

/**
 * LandingView — marketing / showcase page at `/`.
 *
 * Renders inside the authenticated EMRPage shell, so treat it as a hero
 * hub rather than a full marketing site. Sections:
 *   1. Hero — RUO warning chip + wordmark + tagline + CTAs
 *   2. "What v1 does" — 6 feature cards with Tabler icons
 *   3. "Admin & operator surfaces" — quick-link rail to internal tools
 *   4. Meta footer — version, residency, RUO repetition, liverra.ai
 *
 * All colors/shadows/radii come from var(--emr-*) tokens so dark mode
 * and the future brand-ramp swap propagate automatically.
 */
export default function LandingView(): ReactElement {
  return (
    <Box className={classes.root}>
      <Box className={classes.meshDecoration} aria-hidden="true" />

      <Container size="lg">
        <Stack gap={56}>
          {/* -------------------------------------------------- Hero */}
          <header className={classes.hero}>
            <span className={classes.ruoChip} role="status" aria-live="polite">
              <IconAlertTriangle size={14} stroke={2.2} aria-hidden="true" />
              Research use only — not for clinical use
            </span>

            <h1 className={classes.wordmark}>LiverRa</h1>

            <p className={classes.tagline}>
              AI-powered liver diagnostics and surgical planning for
              hepatobiliary surgeons and abdominal radiologists.
            </p>

            <div className={classes.ctaRow}>
              <Link to={LIVERRA_ROUTES.CASES_LIST} className={classes.ctaPrimary}>
                Open cases
                <IconArrowRight size={18} stroke={2} aria-hidden="true" />
              </Link>

              <Link to={LIVERRA_ROUTES.SIGNIN} className={classes.ctaSecondary}>
                <IconLogin2 size={18} stroke={2} aria-hidden="true" />
                Sign in
              </Link>

              <Link to={LIVERRA_ROUTES.HELP} className={classes.tertiaryLink}>
                <IconHelpHexagon size={16} stroke={2} aria-hidden="true" />
                Help &amp; demo case
              </Link>
            </div>
          </header>

          {/* ----------------------------------------- What v1 does */}
          <section aria-labelledby="v1-features-heading">
            <div className={classes.sectionHead}>
              <h2 id="v1-features-heading" className={classes.sectionTitle}>
                What v1 does
              </h2>
              <span className={classes.sectionKicker}>
                Zero-training cascaded pipeline · Apache 2.0 model stack
              </span>
              <span className={classes.sectionRule} aria-hidden="true" />
            </div>

            <div className={classes.featureGrid}>
              <FeatureCard
                icon={IconUpload}
                title="Upload → 3D + FLR"
                body="4-phase contrast CT in, interactive Couinaud segmentation + future-liver-remnant readout out. Target 5 minutes end-to-end."
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconTarget}
                title="Lesion detection"
                body="6-class tumor classifier (HCC, ICC, MET, FNH, HEM, CYST) with calibrated abstention."
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconBrush}
                title="Interactive refinement"
                body="VISTA3D one-click mask correction + MedSAM-2 lesion re-prompt. Offline-durable edits."
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconFileCertificate}
                title="Finalize & PACS"
                body="DICOM-SEG + SR + PDF with burned-in RUO watermark. Transactional PACS push with retry."
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconShieldCheck}
                title="Compliance & audit"
                body="Per-tenant chain-of-hashes audit log, daily Merkle anchors to S3 Object Lock, MBoM tracking."
                to={LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY}
              />
              <FeatureCard
                icon={IconEraser}
                title="GDPR Art. 17 erasure"
                body="Per-case KMS key with < 60 s crypto-shred. 404-on-disclosure preserved."
                to={LIVERRA_ROUTES.ERASURE}
              />
            </div>
          </section>

          {/* ---------------------------------------- Admin / Ops */}
          <section aria-labelledby="admin-surfaces-heading">
            <div className={classes.sectionHead}>
              <h2 id="admin-surfaces-heading" className={classes.sectionTitle}>
                Admin &amp; operator surfaces
              </h2>
              <span className={classes.sectionKicker}>
                Internal tools for staff roles
              </span>
              <span className={classes.sectionRule} aria-hidden="true" />
            </div>

            <div className={classes.adminGrid}>
              <AdminChip
                icon={IconUsers}
                label="User management"
                to={LIVERRA_ROUTES.ADMIN_USERS}
              />
              <AdminChip
                icon={IconServerCog}
                label="PACS config"
                to={LIVERRA_ROUTES.ADMIN_PACS_CONFIG}
              />
              <AdminChip
                icon={IconTopologyStar3}
                label="Ops queue"
                to={LIVERRA_ROUTES.OPS_QUEUE}
              />
              <AdminChip
                icon={IconShieldCheck}
                label="MBoM"
                to={LIVERRA_ROUTES.COMPLIANCE_MBOM}
              />
              <AdminChip
                icon={IconClipboardList}
                label="Claim registry"
                to={LIVERRA_ROUTES.COMPLIANCE_CLAIM_REGISTRY}
              />
              <AdminChip
                icon={IconClipboardCheck}
                label="Audit summary"
                to={LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY}
              />
              <AdminChip
                icon={IconShieldCheck}
                label="RUO spot-check"
                to={LIVERRA_ROUTES.COMPLIANCE_RUO_SPOT_CHECK}
              />
              <AdminChip
                icon={IconEraser}
                label="Erasure (DPO)"
                to={LIVERRA_ROUTES.ERASURE}
              />
            </div>
          </section>

          {/* ---------------------------------------- Meta footer */}
          <footer className={classes.footer}>
            <span className={classes.footerLeft}>
              <span>Design-partner preview build</span>
              <span className={classes.footerDot} aria-hidden="true" />
              <span>CE MDR Class IIb track · 24–30 months</span>
              <span className={classes.footerDot} aria-hidden="true" />
              <span>GDPR · eu-central-1 residency</span>
            </span>
            <span className={classes.footerRight}>
              <span className={classes.footerRuo}>Research use only</span>
              <span className={classes.footerDot} aria-hidden="true" />
              <a
                href="https://liverra.ai"
                target="_blank"
                rel="noreferrer"
                className={classes.footerLink}
              >
                liverra.ai
              </a>
            </span>
          </footer>
        </Stack>
      </Container>
    </Box>
  );
}

// ── feature card ────────────────────────────────────────────────────────
interface IconProps {
  size?: number | string;
  stroke?: number;
}

interface FeatureCardProps {
  icon: ComponentType<IconProps>;
  title: string;
  body: string;
  to: string;
}

function FeatureCard({
  icon: Icon,
  title,
  body,
  to,
}: FeatureCardProps): ReactElement {
  return (
    <Link to={to} className={classes.featureCard}>
      <span className={classes.featureIcon} aria-hidden="true">
        <Icon size={22} stroke={1.8} />
      </span>
      <h3 className={classes.featureTitle}>{title}</h3>
      <p className={classes.featureBody}>{body}</p>
    </Link>
  );
}

// ── admin chip ──────────────────────────────────────────────────────────
interface AdminChipProps {
  icon: ComponentType<IconProps>;
  label: string;
  to: string;
}

function AdminChip({ icon: Icon, label, to }: AdminChipProps): ReactElement {
  return (
    <Link to={to} className={classes.adminChip}>
      <span className={classes.adminChipIcon} aria-hidden="true">
        <Icon size={16} stroke={1.9} />
      </span>
      <span className={classes.adminChipLabel}>{label}</span>
    </Link>
  );
}
