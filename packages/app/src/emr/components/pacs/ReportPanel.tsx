// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// ReportPanel — Radiology Report Editor (right panel alongside PACS viewer)
// ============================================================================
// A resizable right panel where radiologists write structured reports while
// viewing images on the left. Think of it like a text editor sidebar in an
// IDE — you see the images and write the report simultaneously.
//
// Features:
// - Rich-text editor slot (Phase-2 fallback: Mantine Textarea; Phase 3 will
//   wire `EMRRichTextEditor` once that module is ported).
// - Template selector (trimmed to liver-relevant templates).
// - Draft / Preliminary / Final status workflow.
// - Auto-loads existing report from the LiverRa FHIR stub (returns null
//   today; real persistence lands in Phase 4).
// - Keyboard shortcuts: Ctrl+S (save), Ctrl+Enter (sign), Esc (close).
//
// Ported from MediMind (components/pacs/ReportPanel.tsx) with:
//   - `useMedplum()` → `useLiverraFhir()`.
//   - `useMedplumProfile()` → `useAuth()` (Cognito user).
//   - Cardiology integrations removed (CathLabReport, CADRADSScoring,
//     PeerReviewPanel, coronary / CAD-RADS state + template).
//   - `EMRRichTextEditor` + `VoiceInputButton` + `SignedFormBanner` slots
//     stubbed with Mantine Textarea + small inline fallbacks. TODOs below
//     track re-wiring when those modules are ported.
// ============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  Alert,
  Loader,
  Select,
  Switch,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle,
  IconDeviceFloppy,
  IconFileCheck,
  IconFileText,
  IconFilePlus,
  IconPrinter,
  IconSettings,
  IconX,
} from '@tabler/icons-react';
import { useLiverraFhir } from '../../hooks/useLiverraFhir';
import { useAuth } from '../../services/auth';
import { useTranslation } from '../../contexts/TranslationContext';
import { toLocaleDateForPacs } from '../../services/pacs/dateFormatHelpers';
import { useRadiologyReport } from '../../hooks/pacs/useRadiologyReport';
import { useReportMacros } from '../../hooks/pacs/useReportMacros';
import {
  signRadiologyReport,
  printRadiologyReport,
  RADIOLOGY_TEMPLATES,
  getTemplateContent,
  type ReportTemplate,
  type TemplateLocale,
} from '../../services/pacs/radiologyReportService';
import { MacroEditor } from './MacroEditor';
import { EMRModal } from '../common/EMRModal';
import { ReportMeasurements } from './ReportMeasurements';
import { ReportKeyImages } from './ReportKeyImages';
import type { ImagingStudyListItem } from '../../types/pacs';
import styles from './ReportPanel.module.css';

// ============================================================================
// Props
// ============================================================================

export interface ReportPanelProps {
  /** The imaging study being reported on. */
  study: ImagingStudyListItem;
  /** Close the report panel. */
  onClose: () => void;
  /** Callback after a report is saved (with its final status and auto-next preference). */
  onReportSaved?: (status: 'partial' | 'preliminary' | 'final', autoNextEnabled?: boolean) => void;
}

// Detect macOS for keyboard shortcut labels
const isMac = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac');
const modKey = isMac ? '\u2318' : 'Ctrl';

/**
 * Strip all HTML tags from a string for a safe plain-text preview. Used for
 * addendum previews where the rich-text editor isn't mounted. Phase 3 will
 * swap this for `EMRRichTextEditor` in read-only mode, which handles HTML
 * rendering + sanitisation natively.
 */
function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ============================================================================
// Component
// ============================================================================

export function ReportPanel({
  study,
  onClose,
  onReportSaved,
}: ReportPanelProps): React.ReactElement {
  const { t, locale } = useTranslation();
  const lang = locale; // alias preserved for legacy template-name dispatch
  const medplum = useLiverraFhir();
  const { user } = useAuth();

  // Editor ref kept for compatibility with child components that expect a
  // TipTap `Editor` (e.g., `ReportMeasurements`). While the RichText editor
  // isn't wired we still provide the ref shape so those components compile.
  const editorRef = useRef<Editor | null>(null);

  // Report hook — loads existing report, tracks dirty state, saves to FHIR
  const {
    report,
    isLoading,
    isSaving,
    isDirty,
    error: reportLoadError,
    content,
    setContent,
    save,
    createAddendum,
    addenda,
    autoNextEnabled,
    toggleAutoNext,
  } = useRadiologyReport({
    studyId: study.id,
    patientId: study.patientId,
  });

  // Report status selector
  const [reportStatus, setReportStatus] = useState<'partial' | 'preliminary' | 'final'>(() => {
    if (report?.status === 'preliminary') { return 'preliminary'; }
    if (report?.status === 'final') { return 'final'; }
    return 'partial';
  });

  // Sync reportStatus when report data loads from the API
  useEffect(() => {
    if (report?.status === 'preliminary' || report?.status === 'final') {
      setReportStatus(report.status);
    }
  }, [report?.status]);

  // Macro editor modal
  const [isMacroEditorOpen, setIsMacroEditorOpen] = useState(false);

  // Report macros — text shortcuts like ".normal" → full boilerplate
  const {
    macros,
    createMacro,
    updateMacro,
    deleteMacro: removeMacro,
  } = useReportMacros(user?.id ?? '');

  // Unsaved changes confirmation modal
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);

  // Sign confirmation modal
  const [showSignModal, setShowSignModal] = useState(false);

  // Template selection
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  // Build practitioner reference from the current user.
  const practitionerRef = user?.id ? `Practitioner/${user.id}` : undefined;
  const practitionerDisplay = user?.name ?? undefined;

  // Get template display name based on current language
  const getTemplateName = useCallback(
    (tmpl: ReportTemplate): string => {
      if (lang === 'ka' && tmpl.nameKa) { return tmpl.nameKa; }
      if (lang === 'ru' && tmpl.nameRu) { return tmpl.nameRu; }
      if (lang === 'de' && tmpl.nameDe) { return tmpl.nameDe; }
      return tmpl.name;
    },
    [lang],
  );

  // Handle template selection — inserts template HTML into the editor
  const handleTemplateSelect = useCallback(
    (templateId: string | null) => {
      if (!templateId) { return; }
      const tmpl = RADIOLOGY_TEMPLATES.find((tpl) => tpl.id === templateId);
      if (tmpl) {
        setContent(getTemplateContent(tmpl, lang as TemplateLocale));
        setSelectedTemplate(templateId);
      }
    },
    [setContent, lang],
  );

  // Save as draft
  const handleSaveDraft = useCallback(async () => {
    const result = await save({
      reportStatus: 'partial',
      practitionerRef,
      practitionerDisplay,
    });
    if (result) {
      notifications.show({
        title: t('pacs.report.reportSaved'),
        message: t('pacs.report.saveSuccess'),
        color: 'green',
      });
      onReportSaved?.('partial', autoNextEnabled);
    } else {
      // eslint-disable-next-line no-console
      console.error('[ReportPanel] Draft save returned null — report not saved');
      notifications.show({
        title: t('pacs.report.saveError'),
        message: t('pacs.report.saveErrorMessage'),
        color: 'red',
      });
    }
  }, [save, practitionerRef, practitionerDisplay, t, onReportSaved, autoNextEnabled]);

  // Sign & submit — saves draft content, then atomically finalizes + creates Provenance
  const handleSign = useCallback(async () => {
    setShowSignModal(false);
    const finalStatus = reportStatus === 'preliminary' ? 'preliminary' : 'final';

    // Save editor content first (as 'preliminary' to persist changes without
    // prematurely marking as 'final' — the sign function handles finalization).
    const result = await save({
      reportStatus: finalStatus === 'final' ? 'preliminary' : finalStatus,
      practitionerRef,
      practitionerDisplay,
    });

    if (!result?.id) {
      // eslint-disable-next-line no-console
      console.error('[ReportPanel] Sign/save returned null — report not saved');
      notifications.show({
        title: t('pacs.report.saveError'),
        message: t('pacs.report.saveErrorMessage'),
        color: 'red',
      });
      return;
    }

    if (finalStatus === 'final' && user?.id) {
      try {
        const signResult = await signRadiologyReport(medplum, {
          reportId: result.id,
          studyId: study.id,
          patientId: study.patientId,
          signerId: user.id,
          signerName: practitionerDisplay || 'Unknown',
        });
        if (signResult.warnings.length > 0) {
          notifications.show({
            title: t('pacs.report.reportSigned'),
            message: signResult.warnings.join('; ') + ' — please refresh.',
            color: 'yellow',
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ReportPanel] Signing failed:', err);
        // Rollback: restore report status to what the user selected before sign attempt
        setReportStatus(reportStatus);
        void save({
          reportStatus,
          practitionerRef,
          practitionerDisplay,
        });
        const errMsg = err instanceof Error ? err.message : '';
        let userMessage: string;
        if (errMsg.includes('does not match')) {
          userMessage = t('pacs.report.signerMismatch');
        } else if (errMsg.includes('already finalized')) {
          userMessage = t('pacs.report.alreadyFinalized');
        } else {
          userMessage = t('pacs.report.saveErrorMessage');
        }
        notifications.show({
          title: t('pacs.report.saveError'),
          message: userMessage,
          color: 'red',
        });
        return;
      }
    }

    notifications.show({
      title: t('pacs.report.reportSigned'),
      message: t('pacs.report.signSuccess'),
      color: 'green',
    });
    onReportSaved?.(finalStatus, autoNextEnabled);
  }, [
    save,
    reportStatus,
    practitionerRef,
    practitionerDisplay,
    t,
    onReportSaved,
    medplum,
    study.id,
    study.patientId,
    user?.id,
    autoNextEnabled,
  ]);

  // Print the report
  const handlePrint = useCallback(() => {
    printRadiologyReport({
      htmlContent: content,
      studyDescription: study.description,
      patientName: study.patientName,
      studyDate: study.date,
      modalities: study.modalities,
      signerName: report?.performer,
      signedAt: report?.status === 'final' ? report?.effectiveDateTime : undefined,
      locale: lang,
      labels: {
        title: t('pacs.print.title'),
        patient: t('pacs.print.patient'),
        modality: t('pacs.print.modality'),
        study: t('pacs.print.study'),
        date: t('pacs.print.date'),
        signedBy: t('pacs.print.signedBy'),
      },
    });
  }, [content, study, report, lang, t]);

  // Create addendum for a signed report
  const handleAddAddendum = useCallback(async () => {
    if (!report?.id) { return; }
    const newId = await createAddendum(report.id);
    if (newId) {
      notifications.show({
        title: t('pacs.addendum.created'),
        message: t('pacs.addendum.createdMessage'),
        color: 'green',
      });
    }
  }, [report?.id, createAddendum, t]);

  // Handle close — check for unsaved changes first
  const handleClose = useCallback(() => {
    if (isDirty) {
      setShowUnsavedModal(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Ctrl+S / Cmd+S — save draft
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSaveDraft();
      }
      // Ctrl+Enter / Cmd+Enter — sign
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        setShowSignModal(true);
      }
      // Escape — close panel
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    },
    [handleSaveDraft, handleClose],
  );

  // Build template options for the Select dropdown
  const templateOptions = useMemo(() => {
    return RADIOLOGY_TEMPLATES.map((tmpl) => ({
      value: tmpl.id,
      label: getTemplateName(tmpl),
    }));
  }, [getTemplateName]);

  // Read-only when report is final
  const isReadOnly = report?.status === 'final';

  // Format study date
  const formattedDate = toLocaleDateForPacs(study.date, locale);

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className={styles.panel} onKeyDown={handleKeyDown} data-testid="report-panel">
      {/* Panel header — dark chrome matching PACS viewer */}
      <div className={styles.header}>
        <div className={styles.headerIcon}>
          <IconFileText size={16} />
        </div>
        <span className={styles.headerTitle}>{t('pacs.report.title')}</span>
        <div className={styles.headerActions}>
          {/* Unsaved changes indicator */}
          {isDirty && (
            <div
              className={styles.dirtyDot}
              title={t('pacs.report.unsavedChanges')}
              role="status"
              aria-label={t('pacs.report.unsavedChanges')}
            />
          )}
          {/* Print button in header when content exists */}
          {content.trim() && (
            <Tooltip label={t('common.print')} position="bottom" withArrow>
              <button
                className={styles.headerBtn}
                onClick={handlePrint}
                aria-label={t('common.print')}
                data-testid="report-print"
              >
                <IconPrinter size={14} />
              </button>
            </Tooltip>
          )}
          <Tooltip label={`${t('pacs.report.closePanel')} (Esc)`} position="bottom" withArrow>
            <button
              className={styles.closeBtn}
              onClick={handleClose}
              aria-label={t('pacs.report.closePanel')}
            >
              <IconX size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Study info bar — shows modality, date, description */}
      <div className={styles.studyInfo}>
        <span className={styles.studyInfoModality}>
          {study.modalities.join(' / ')}
        </span>
        {formattedDate && (
          <>
            <span className={styles.studyInfoDivider} />
            <span className={styles.studyInfoText}>{formattedDate}</span>
          </>
        )}
        {study.description && (
          <>
            <span className={styles.studyInfoDivider} />
            <span className={styles.studyInfoDescription}>{study.description}</span>
          </>
        )}
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className={styles.emptyState}>
          <Loader size="sm" />
          <Text size="sm" c="dimmed">{t('pacs.report.loadingReport')}</Text>
        </div>
      ) : (
        <>
          {/* Signed report banner (shows when report is finalized) */}
          {/* TODO(phase-3): swap this inline chip for `SignedFormBanner` once that
              component is ported from MediMind. */}
          {isReadOnly && report?.performer && report?.effectiveDateTime && (
            <Alert
              color="green"
              variant="light"
              styles={{ root: { padding: '8px 12px' } }}
              data-testid="signed-banner"
            >
              <Text size="sm">
                {t('pacs.report.signedBy', { name: report.performer })}
                {' • '}
                {new Date(report.effectiveDateTime).toLocaleString()}
              </Text>
            </Alert>
          )}

          {/* Addendum banner — shows when viewing an addendum, linking back to original */}
          {report?.isAddendum && (
            <Alert
              color="blue"
              variant="light"
              styles={{ root: { padding: '8px 12px' } }}
              data-testid="addendum-banner"
            >
              <Text size="sm">
                {t('pacs.addendum.banner', {
                  date: toLocaleDateForPacs(report.effectiveDateTime, locale),
                })}
              </Text>
            </Alert>
          )}

          {/* Add Addendum button — appears when viewing a signed report */}
          {isReadOnly && report?.id && (
            <div style={{
              padding: '8px 12px',
              display: 'flex',
              justifyContent: 'flex-end',
            }}>
              <button
                onClick={handleAddAddendum}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'var(--emr-gradient-primary)',
                  border: 'none',
                  borderRadius: 'var(--emr-radius-sm)',
                  padding: '6px 14px',
                  cursor: 'pointer',
                  color: 'var(--emr-text-inverse)',
                  fontSize: 'var(--emr-font-sm)',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
                data-testid="report-add-addendum"
              >
                <IconFilePlus size={14} />
                {t('pacs.addendum.add')}
              </button>
            </div>
          )}

          {/* Toolbar: template selector + macro settings */}
          {/* TODO(phase-3): re-add `VoiceInputButton` slot here once that component lands. */}
          <div className={styles.toolbar}>
            <Select
              size="sm"
              placeholder={t('pacs.report.templateSelect')}
              data={templateOptions}
              value={selectedTemplate}
              onChange={handleTemplateSelect}
              clearable
              disabled={isReadOnly}
              style={{ flex: 1, minWidth: 120 }}
              data-testid="report-template-select"
            />

            <Tooltip label={t('pacs.macro.settings')} position="bottom" withArrow>
              <button
                className={styles.headerBtn}
                onClick={() => setIsMacroEditorOpen(true)}
                aria-label={t('pacs.macro.settings')}
                data-testid="report-macro-settings"
              >
                <IconSettings size={16} />
              </button>
            </Tooltip>
          </div>

          {/* Status selector — separate row for visual clarity */}
          {!isReadOnly && (
            <div className={styles.statusRow}>
              <span className={styles.statusLabel}>{t('pacs.report.status')}:</span>
              <div
                className={styles.statusPills}
                role="radiogroup"
                aria-label={t('pacs.report.status')}
              >
                {(['partial', 'preliminary', 'final'] as const).map((status) => (
                  <button
                    key={status}
                    className={styles.statusPill}
                    data-status={status}
                    data-active={reportStatus === status ? 'true' : 'false'}
                    onClick={() => setReportStatus(status)}
                    role="radio"
                    aria-checked={reportStatus === status}
                    data-testid={`report-status-${status}`}
                  >
                    <span className={styles.statusDot} data-status={status} />
                    {status === 'partial' && t('pacs.report.statusDraft')}
                    {status === 'preliminary' && t('pacs.report.statusPreliminary')}
                    {status === 'final' && t('pacs.report.statusFinal')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Report load error alert */}
          {reportLoadError && (
            <Alert
              icon={<IconAlertTriangle size={18} />}
              color="red"
              variant="light"
              title={t('pacs.report.loadError')}
              style={{ margin: '0 12px' }}
            >
              <Text size="sm">{t('pacs.report.loadErrorDescription')}</Text>
            </Alert>
          )}

          {/* Main writing area — fallback Textarea until EMRRichTextEditor is ported. */}
          {/* TODO(phase-3): swap this Textarea for `EMRRichTextEditor` with full toolbar,
              cursor-position macro expansion, and template HTML rendering. The `editorRef`
              above is retained for that swap. */}
          <div className={styles.editorArea}>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.currentTarget.value)}
              readOnly={isReadOnly}
              placeholder={t('pacs.report.noReport')}
              autosize
              minRows={12}
              styles={{
                root: { height: '100%' },
                wrapper: { height: '100%' },
                input: {
                  height: '100%',
                  fontFamily: 'var(--emr-font-family, system-ui)',
                  fontSize: 'var(--emr-font-sm)',
                  lineHeight: 1.5,
                  padding: 12,
                },
              }}
              data-testid="report-editor"
            />
          </div>

          {/* Measurements from viewer annotations */}
          <ReportMeasurements
            studyId={study.id}
            editorRef={editorRef}
            disabled={isReadOnly}
          />

          {/* Key images flagged during study review */}
          <ReportKeyImages studyId={study.id} />

          {/* Addenda list — shows addenda linked to the original signed report */}
          {isReadOnly && addenda.length > 0 && (
            <div style={{
              padding: '8px 12px',
              borderTop: '1px solid var(--emr-border-color)',
            }}>
              <Text
                size="sm"
                fw={600}
                mb={8}
                style={{ color: 'var(--emr-text-primary)' }}
              >
                {t('pacs.addendum.title')} ({addenda.length})
              </Text>
              {addenda.map((addendum) => {
                // Render addendum as plain text (stripped HTML) until Phase 3 adds
                // a read-only rich-text viewer. This avoids any innerHTML injection.
                const preview = addendum.htmlContent
                  ? stripHtmlTags(addendum.htmlContent)
                  : (addendum.conclusion ?? '');
                return (
                  <div
                    key={addendum.id}
                    style={{
                      padding: '8px 10px',
                      marginBottom: 6,
                      borderRadius: 'var(--emr-radius-sm)',
                      background: 'var(--emr-bg-hover)',
                      border: '1px solid var(--emr-border-color)',
                    }}
                    data-testid={`addendum-${addendum.id}`}
                  >
                    <Text size="xs" c="dimmed" mb={4}>
                      {addendum.effectiveDateTime
                        ? new Date(addendum.effectiveDateTime).toLocaleString()
                        : ''}
                      {addendum.performer ? ` — ${addendum.performer}` : ''}
                    </Text>
                    {preview ? (
                      <Text
                        size="sm"
                        style={{
                          color: 'var(--emr-text-primary)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {preview}
                      </Text>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {/* Keyboard shortcut hints — subtle helper at bottom */}
          {!isReadOnly && (
            <div className={styles.shortcutHint}>
              <span className={styles.shortcutItem}>
                <span className={styles.shortcutKbd}>{modKey}+S</span>
                {t('pacs.report.saveDraft')}
              </span>
              <span className={styles.shortcutItem}>
                <span className={styles.shortcutKbd}>{modKey}+Enter</span>
                {t('pacs.report.signSubmit')}
              </span>
              <span className={styles.shortcutItem}>
                <span className={styles.shortcutKbd}>Esc</span>
                {t('pacs.report.closePanel')}
              </span>
            </div>
          )}

          {/* Action bar — auto-next toggle + save and sign buttons */}
          {!isReadOnly && (
            <div className={styles.actionBar}>
              {/* Auto-next toggle — like Netflix "auto-play next episode" */}
              <div className={styles.autoNextRow}>
                <Tooltip
                  label={t('pacs.report.autoNextToggle')}
                  position="top"
                  withArrow
                >
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <Switch
                      size="xs"
                      checked={autoNextEnabled}
                      onChange={() => toggleAutoNext()}
                      label={t('pacs.report.autoNextToggle')}
                      aria-label={t('pacs.report.autoNextToggle')}
                      data-testid="report-auto-next-toggle"
                      styles={{
                        root: { minHeight: 44 },
                        track: {
                          cursor: 'pointer',
                          backgroundColor: autoNextEnabled ? 'var(--emr-accent)' : undefined,
                        },
                        label: {
                          fontSize: 'var(--emr-font-xs)',
                          color: 'var(--emr-text-secondary)',
                          cursor: 'pointer',
                        },
                      }}
                    />
                  </div>
                </Tooltip>
              </div>

              <div className={styles.actionButtons}>
                <button
                  className={styles.saveDraftBtn}
                  onClick={handleSaveDraft}
                  disabled={!isDirty || isSaving || !!reportLoadError || isLoading}
                  data-testid="report-save-draft"
                >
                  {isSaving ? (
                    <Loader size={14} color="var(--emr-text-secondary)" />
                  ) : (
                    <IconDeviceFloppy size={14} />
                  )}
                  {t('pacs.report.saveDraft')}
                </button>

                <button
                  className={styles.signSubmitBtn}
                  onClick={() => setShowSignModal(true)}
                  disabled={!content.trim() || !!reportLoadError || isLoading}
                  data-testid="report-sign-submit"
                >
                  <IconFileCheck size={16} />
                  {t('pacs.report.signSubmit')}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Unsaved changes confirmation */}
      <EMRModal
        opened={showUnsavedModal}
        onClose={() => setShowUnsavedModal(false)}
        title={t('pacs.report.unsavedChanges')}
        size="sm"
        cancelLabel={t('pacs.report.keepEditing')}
        submitLabel={t('pacs.report.discard')}
        onSubmit={() => {
          setShowUnsavedModal(false);
          onClose();
        }}
        submitColor="red"
        testId="report-unsaved-modal"
      >
        <Text size="sm">{t('pacs.report.unsavedChangesMessage')}</Text>
      </EMRModal>

      {/* Sign confirmation */}
      <EMRModal
        opened={showSignModal}
        onClose={() => setShowSignModal(false)}
        title={t('pacs.report.signConfirmTitle')}
        size="sm"
        cancelLabel={t('common.cancel')}
        submitLabel={t('pacs.report.signSubmit')}
        onSubmit={() => { void handleSign(); }}
        submitLoading={isSaving}
        testId="report-sign-modal"
      >
        <Text size="sm">{t('pacs.report.signConfirmMessage')}</Text>
      </EMRModal>

      {/* Macro editor — manage text-expansion shortcuts */}
      <MacroEditor
        isOpen={isMacroEditorOpen}
        onClose={() => setIsMacroEditorOpen(false)}
        macros={macros}
        onCreateMacro={createMacro}
        onUpdateMacro={updateMacro}
        onDeleteMacro={removeMacro}
      />
    </div>
  );
}

export default ReportPanel;
