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
import { useTranslation } from '../contexts/TranslationContext';

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
  const { t } = useTranslation();
  return (
    <Box className={classes.root}>
      <Box className={classes.meshDecoration} aria-hidden="true" />

      <Container size="lg">
        <Stack gap={56}>
          {/* -------------------------------------------------- Hero */}
          <header className={classes.hero}>
            <span className={classes.ruoChip} role="status" aria-live="polite">
              <IconAlertTriangle size={14} stroke={2.2} aria-hidden="true" />
              {t('common:ruo.notice')}
            </span>

            <h1 className={classes.wordmark}>LiverRa</h1>

            <p className={classes.tagline}>
              {t('help:landing.tagline')}
            </p>

            <div className={classes.ctaRow}>
              <Link to={LIVERRA_ROUTES.CASES_LIST} className={classes.ctaPrimary}>
                {t('nav:cta.openCases')}
                <IconArrowRight size={18} stroke={2} aria-hidden="true" />
              </Link>

              <Link to={LIVERRA_ROUTES.SIGNIN} className={classes.ctaSecondary}>
                <IconLogin2 size={18} stroke={2} aria-hidden="true" />
                {t('nav:cta.signIn')}
              </Link>

              <Link to={LIVERRA_ROUTES.HELP} className={classes.tertiaryLink}>
                <IconHelpHexagon size={16} stroke={2} aria-hidden="true" />
                {t('nav:cta.help')}
              </Link>
            </div>
          </header>

          {/* ----------------------------------------- What v1 does */}
          <section aria-labelledby="v1-features-heading">
            <div className={classes.sectionHead}>
              <h2 id="v1-features-heading" className={classes.sectionTitle}>
                {t('help:landing.sections.v1.title')}
              </h2>
              <span className={classes.sectionKicker}>
                {t('help:landing.sections.v1.kicker')}
              </span>
              <span className={classes.sectionRule} aria-hidden="true" />
            </div>

            <div className={classes.featureGrid}>
              <FeatureCard
                icon={IconUpload}
                title={t('help:landing.features.upload.title')}
                body={t('help:landing.features.upload.body')}
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconTarget}
                title={t('help:landing.features.lesionDetection.title')}
                body={t('help:landing.features.lesionDetection.body')}
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconBrush}
                title={t('help:landing.features.refinement.title')}
                body={t('help:landing.features.refinement.body')}
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconFileCertificate}
                title={t('help:landing.features.finalize.title')}
                body={t('help:landing.features.finalize.body')}
                to={LIVERRA_ROUTES.CASES_LIST}
              />
              <FeatureCard
                icon={IconShieldCheck}
                title={t('help:landing.features.compliance.title')}
                body={t('help:landing.features.compliance.body')}
                to={LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY}
              />
              <FeatureCard
                icon={IconEraser}
                title={t('help:landing.features.erasure.title')}
                body={t('help:landing.features.erasure.body')}
                to={LIVERRA_ROUTES.ERASURE}
              />
            </div>
          </section>

          {/* ---------------------------------------- Admin / Ops */}
          <section aria-labelledby="admin-surfaces-heading">
            <div className={classes.sectionHead}>
              <h2 id="admin-surfaces-heading" className={classes.sectionTitle}>
                {t('help:landing.sections.admin.title')}
              </h2>
              <span className={classes.sectionKicker}>
                {t('help:landing.sections.admin.kicker')}
              </span>
              <span className={classes.sectionRule} aria-hidden="true" />
            </div>

            <div className={classes.adminGrid}>
              <AdminChip
                icon={IconUsers}
                label={t('nav:admin.users')}
                to={LIVERRA_ROUTES.ADMIN_USERS}
              />
              <AdminChip
                icon={IconServerCog}
                label={t('nav:admin.pacs')}
                to={LIVERRA_ROUTES.ADMIN_PACS_CONFIG}
              />
              <AdminChip
                icon={IconTopologyStar3}
                label={t('nav:admin.ops')}
                to={LIVERRA_ROUTES.OPS_QUEUE}
              />
              <AdminChip
                icon={IconShieldCheck}
                label={t('nav:admin.mbom')}
                to={LIVERRA_ROUTES.COMPLIANCE_MBOM}
              />
              <AdminChip
                icon={IconClipboardList}
                label={t('nav:admin.claimRegistry')}
                to={LIVERRA_ROUTES.COMPLIANCE_CLAIM_REGISTRY}
              />
              <AdminChip
                icon={IconClipboardCheck}
                label={t('nav:admin.auditSummary')}
                to={LIVERRA_ROUTES.COMPLIANCE_AUDIT_SUMMARY}
              />
              <AdminChip
                icon={IconShieldCheck}
                label={t('nav:admin.ruoSpotcheck')}
                to={LIVERRA_ROUTES.COMPLIANCE_RUO_SPOT_CHECK}
              />
              <AdminChip
                icon={IconEraser}
                label={t('nav:admin.erasure')}
                to={LIVERRA_ROUTES.ERASURE}
              />
            </div>
          </section>

          {/* ---------------------------------------- Meta footer */}
          <footer className={classes.footer}>
            <span className={classes.footerLeft}>
              <span>{t('help:landing.footer.preview')}</span>
              <span className={classes.footerDot} aria-hidden="true" />
              <span>{t('help:landing.footer.ce')}</span>
              <span className={classes.footerDot} aria-hidden="true" />
              <span>{t('help:landing.footer.gdpr')}</span>
            </span>
            <span className={classes.footerRight}>
              <span className={classes.footerRuo}>{t('help:landing.footer.ruo')}</span>
              <span className={classes.footerDot} aria-hidden="true" />
              <a
                href="https://liverra.ai"
                target="_blank"
                rel="noreferrer"
                className={classes.footerLink}
              >
                {t('help:landing.footer.brand')}
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
