// SPDX-License-Identifier: Apache-2.0
// ============================================================================
// LiverRa PACS (Picture Archiving and Communication System) Types
// ============================================================================
// Pure type definitions for the embedded Cornerstone3D PACS viewer in LiverRa.
// No external dependencies — every other PACS module imports from here.
//
// Ported from MediMind 2026-04-20 with cardiology-only shapes removed
// (QCAState, DSAState, CalibrationState, StenosisResult, CADRADSScore,
// MedinaClassification). LiverRa scope is hepatobiliary CT/MRI, so only
// the generic viewer primitives are retained.
//
// Type inventory (quick scan):
//   - ImagingStudyStatus / ImagingPriority   — lifecycle + triage metadata
//   - PACSViewerTool (a.k.a. ToolName)       — Cornerstone3D tool union
//   - RenderingMode                          — MIP / MinIP / Average slab modes
//   - WindowLevelPreset                      — window center/width preset value
//   - TransferFunctionPreset                 — 3D volume rendering recipe
//   - ViewportLayout                         — grid layout preset
//   - StatusTimelineEntry                    — per-status audit trail row
//   - ImagingStudyListItem                   — minimal study row for lists
//   - ViewportState                          — per-viewport imaging state
//   - PACSViewerState / ViewerState          — top-level viewer state
//   - SeriesSelector                         — series-matching predicate
//   - HangingProtocolRule                    — auto-layout recipe
//   - ReadingWorklistItem / Filters          — radiologist worklist
//   - Calibration                            — pixel-to-mm calibration
//   - AnnotationHistoryEntry / TrackingState — annotation audit state
//   - ReportMacro                            — reusable report text snippet
//   - CriticalFindingAlert                   — urgent-finding notification
//   - PeerReviewScore                        — RADPEER 2016 QA row
//   - ImageFilter                            — brightness/contrast/sharpen etc.
//   - PACSViewerProps                        — main viewer component props
// ============================================================================

// ============================================================================
// Core Enums and Types
// ============================================================================

/**
 * Status of an imaging study through its lifecycle.
 * Flows from 'ordered' (doctor places order) through to 'reported' (radiologist signs off).
 */
export type ImagingStudyStatus =
  | 'ordered'
  | 'scheduled'
  | 'in-progress'
  | 'images-available'
  | 'preliminary-read'
  | 'reported';

/**
 * Priority level for imaging studies.
 * - stat: life-threatening, needs immediate attention
 * - urgent: needs attention within hours
 * - routine: standard turnaround time
 */
export type ImagingPriority = 'stat' | 'urgent' | 'routine';

/**
 * Available tools in the PACS viewer toolbar.
 * Maps directly to Cornerstone3D tool names.
 *
 * LiverRa scope: we keep the superset from MediMind minus cardiology-specific
 * 'Stenosis' and 'DSA'. 'Calibrate' is retained because hepatobiliary reads
 * occasionally need ruler calibration for external measurements.
 */
export type PACSViewerTool =
  // Navigation & display
  | 'WindowLevel'
  | 'Zoom'
  | 'Pan'
  | 'StackScroll'
  | 'Crosshairs'
  | 'ReferenceLines'
  | 'MagnifyTool'
  | 'PlanarRotate'
  // Measurement tools
  | 'Length'
  | 'Angle'
  | 'CobbAngle'
  | 'Bidirectional'
  | 'Probe'
  | 'DragProbe'
  | 'Calibrate'
  // ROI (Region of Interest) tools
  | 'EllipticalROI'
  | 'RectangleROI'
  | 'CircleROI'
  | 'FreehandROI'
  | 'SplineROI'
  // Annotation tools
  | 'ArrowAnnotate'
  | 'Polyline'
  // Segmentation tools
  | 'Brush'
  | 'Threshold'
  | 'Eraser'
  // Overlay tools (always-on, not user-selectable)
  | 'OrientationMarker'
  | 'ScaleOverlay';

/**
 * Alias requested by the Phase 1 spec for components that prefer the
 * generic `ToolName` identifier. Keep as a type alias (not a separate
 * union) so every consumer sees the same exhaustive tool list.
 */
export type ToolName = PACSViewerTool;

/**
 * Rendering mode for slab-based volume projection.
 *
 * LiverRa also accepts the legacy 'default' literal (no slab projection) from
 * the MediMind port, but the four documented values match the Phase 1 spec.
 * - 'default':  Normal rendering (single slice, no slab projection)
 * - 'MIP':      Maximum Intensity Projection — shows brightest voxel in slab
 *                (great for contrast-filled hepatic vessels)
 * - 'MinIP':    Minimum Intensity Projection — shows dimmest voxel in slab
 *                (great for air-filled bowel / biliary tree)
 * - 'Average':  Mean-intensity slab — smooths noise in thick slabs
 */
export type RenderingMode = 'default' | 'MIP' | 'MinIP' | 'Average';

/**
 * Transfer function presets for 3D volume rendering.
 * Each preset adjusts opacity and color mapping to highlight different tissue types.
 * Think of it like Instagram filters but for CT scans — each one makes different
 * body parts visible or invisible.
 */
export type TransferFunctionPreset = 'Bone' | 'SoftTissue' | 'Lung' | 'Vascular';

/**
 * Viewport layout presets.
 * - 1x1:     single image (default)
 * - 1x2:     two side-by-side (comparison)
 * - 2x1:     two stacked vertically
 * - 2x2:     quad view
 * - 1x3-mpr: axial + sagittal + coronal for MPR (multi-planar reconstruction)
 */
export type ViewportLayout = '1x1' | '1x2' | '2x1' | '2x2' | '1x3-mpr';

/**
 * Window/level preset as a raw pair of numbers.
 * `center` = window center (Hounsfield units for CT, arbitrary for MR).
 * `width`  = window width (total contrast span around the center).
 *
 * For CT liver reads, typical presets are { center: 50, width: 350 } for
 * abdomen and { center: 40, width: 400 } for soft tissue. Named presets
 * (e.g., 'liver', 'bone') are stored elsewhere as maps of string → this.
 */
export interface WindowLevelPreset {
  center: number;
  width: number;
}

// ============================================================================
// Status Timeline
// ============================================================================

/**
 * A single entry in the imaging study status timeline.
 * Records when each status transition happened and who triggered it.
 * Like a package tracking event: "Delivered at 3pm by courier."
 */
export interface StatusTimelineEntry {
  /** Status at this point (e.g., 'ordered', 'images-available') */
  status: ImagingStudyStatus;
  /** ISO timestamp of when this transition occurred */
  timestamp: string;
  /** Who or what triggered the transition (e.g., 'PACS Bridge', doctor name) */
  actor?: string;
}

// ============================================================================
// Imaging Study
// ============================================================================

/**
 * Summary of an imaging study for display in lists and tables.
 * Combines data from FHIR ImagingStudy, Orthanc metadata, and DiagnosticReport.
 */
export interface ImagingStudyListItem {
  /** ImagingStudy FHIR resource ID */
  id: string;
  /** Orthanc internal study ID (used to build DICOMweb URLs) */
  orthancStudyId: string;
  /** DICOM StudyInstanceUID — the universal study identifier */
  studyInstanceUid: string;
  /** Accession number (format: ACC-YYYY-NNNNNN) */
  accessionNumber?: string;
  /** FHIR Patient resource ID */
  patientId: string;
  /** Patient display name */
  patientName: string;
  /** Study date in ISO format (YYYY-MM-DD) */
  date: string;
  /** Imaging modalities in the study (e.g., ['CT', 'MR']) */
  modalities: string[];
  /** Body part examined (e.g., 'LIVER', 'ABDOMEN') */
  bodyPart?: string;
  /** Study description from DICOM metadata */
  description?: string;
  /** Number of series in the study */
  seriesCount: number;
  /** Total number of images across all series */
  instanceCount: number;
  /** Current study lifecycle status */
  status: ImagingStudyStatus;
  /** Clinical priority */
  priority: ImagingPriority;
  /** Reference to the originating ServiceRequest (e.g., 'ServiceRequest/123') */
  orderRef?: string;
  /** Whether a DiagnosticReport with findings exists */
  hasFindings: boolean;
  /** Preliminary or final findings text from the radiologist */
  findingsText?: string;
  /** DiagnosticReport status */
  reportStatus?: 'preliminary' | 'final';
  /** DiagnosticReport resource ID (if a full radiology report exists) */
  reportId?: string;
  /** Status transition timeline (chronological list of status changes) */
  timeline?: StatusTimelineEntry[];
  /** Data source: PACS (Orthanc), local-upload (direct DICOM), or order (pending) */
  source?: 'pacs' | 'local-upload' | 'order';
}

// ============================================================================
// Viewer State
// ============================================================================

/**
 * State of a single viewport in the PACS viewer.
 * Tracks which series is displayed and all image manipulation settings.
 */
export interface ViewportState {
  /** Unique viewport identifier */
  id: string;
  /** Viewport rendering type */
  type: 'stack' | 'volume' | 'volume3d';
  /** DICOM SeriesInstanceUID currently displayed */
  seriesUid?: string;
  /** Current image index within the series (0-based) */
  imageIndex: number;
  /** Window/level settings for contrast adjustment */
  windowLevel: WindowLevelPreset;
  /** Zoom factor (1.0 = no zoom) */
  zoom: number;
  /** Pan offset in viewport coordinates */
  pan: {
    x: number;
    y: number;
  };
  /** Rotation in degrees */
  rotation: number;
  /** Horizontal flip */
  flipH: boolean;
  /** Vertical flip */
  flipV: boolean;
  /** Active transfer function preset for 3D rendering (only used when type === 'volume3d') */
  volume3DPreset?: TransferFunctionPreset;
}

/**
 * Top-level state of the PACS viewer.
 * Manages layout, active tool, and all viewport states.
 */
export interface PACSViewerState {
  /** FHIR ImagingStudy resource ID being viewed */
  studyId: string;
  /** Current viewport layout */
  viewportLayout: ViewportLayout;
  /** ID of the currently active (focused) viewport */
  activeViewportId: string;
  /** Map of viewport ID to its state */
  viewports: Map<string, ViewportState>;
  /** Currently selected tool in the toolbar */
  activeTool: PACSViewerTool;
  /** FHIR ImagingStudy ID for comparison (side-by-side) view */
  comparisonStudyId?: string;
  /** Cornerstone3D image IDs (wadors: URLs) fetched from DICOMweb */
  imageIds?: string[];
}

/**
 * Friendlier alias for `PACSViewerState`. The plan document refers to this
 * type as `ViewerState`; keep both exports so imports under either name
 * resolve to the same shape.
 */
export type ViewerState = PACSViewerState;

// ============================================================================
// Hanging Protocols
// ============================================================================

/**
 * Selects a specific series from a study based on DICOM metadata.
 * Used by hanging protocols to assign the right series to each viewport.
 */
export interface SeriesSelector {
  /** Filter by modality (e.g., 'CT', 'MR') */
  modality?: string;
  /** Match series description with regex */
  description?: RegExp;
  /** Match exact series number */
  seriesNumber?: number;
  /** If multiple series match, prefer the first one */
  preferFirst?: boolean;
}

/**
 * A hanging protocol rule that automatically arranges viewports based on study metadata.
 * Think of it as a "recipe" — when the study matches certain criteria (e.g., CT Liver),
 * the viewer automatically picks the right layout and assigns series to viewports.
 */
export interface HangingProtocolRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable name (e.g., "CT Liver Standard") */
  name: string;
  /** Whether this is the default rule when no other matches */
  isDefault: boolean;
  /** Criteria for matching this rule to a study */
  matchCriteria: {
    /** Match studies containing these modalities */
    modality: string[];
    /** Match studies with these body parts */
    bodyPart?: string[];
    /** Match study description with regex */
    description?: RegExp;
  };
  /** Viewport layout to use when this rule matches */
  layout: ViewportLayout;
  /** How to assign series to each viewport position */
  viewportAssignments: Array<{
    /** Which viewport slot (0-based index) */
    viewportIndex: number;
    /** How to pick the series for this viewport */
    seriesSelector: SeriesSelector;
    /** Tool to activate in this viewport on load */
    initialTool?: PACSViewerTool;
    /** Window/level preset name (e.g., 'liver', 'bone', 'soft-tissue') */
    windowPreset?: string;
  }>;
  /** Optional prior study comparison settings */
  priorStudyMatch?: {
    /** Whether to load a prior study for comparison */
    enabled: boolean;
    /** Which viewport to display the prior study in */
    viewportIndex: number;
    /** Maximum age of prior study in days */
    maxAgeDays?: number;
  };
}

// ============================================================================
// Reading Worklist
// ============================================================================

/**
 * An imaging study in the radiologist's reading worklist.
 * Extends ImagingStudyListItem with workflow-specific fields
 * like wait time and assignment info.
 */
export interface ReadingWorklistItem extends ImagingStudyListItem {
  /** Minutes since images became available */
  waitTime: number;
  /** True if STAT study waiting > 30 minutes — triggers visual alert */
  isOverdue: boolean;
  /** Doctor who ordered the study */
  orderingDoctor: {
    id: string;
    name: string;
  };
  /** Radiologist assigned to read the study */
  assignedTo?: {
    id: string;
    name: string;
  };
  /** True if the patient has other imaging studies (prior exams for comparison) */
  hasPriors?: boolean;
}

/**
 * Filters for the reading worklist view.
 * All fields are optional — unset means "show all".
 */
export interface ReadingWorklistFilters {
  /** Filter by priority levels */
  priority?: ImagingPriority[];
  /** Filter by imaging modalities */
  modality?: string[];
  /** Filter by body parts examined */
  bodyPart?: string[];
  /** Filter by radiology subspecialty */
  subspecialty?: string;
  /** Show only studies assigned to the current user */
  assignedToMe?: boolean;
  /** Show only overdue studies (exceeded SLA turnaround time) */
  overdue?: boolean;
}

// ============================================================================
// Calibration
// ============================================================================

/**
 * Stores pixel-to-physical-distance calibration data.
 * Created when a user calibrates using a known-size reference object
 * (e.g., external ruler / phantom visible in the scan).
 */
export interface Calibration {
  /** Physical spacing per pixel [rowSpacing, colSpacing] in mm */
  pixelSpacing: [number, number];
  /** UID of the annotation used as the calibration reference */
  sourceAnnotationUID: string;
  /** Tool that created the calibration (e.g., 'Calibrate') */
  toolName: string;
  /** ISO timestamp of when calibration was performed */
  timestamp: string;
}

// ============================================================================
// Annotation History
// ============================================================================

/**
 * A single entry in the undo/redo history stack for annotations.
 * Records what changed so the action can be reversed or replayed.
 */
export interface AnnotationHistoryEntry {
  /** UID of the annotation that was modified */
  annotationUID: string;
  /** What happened to the annotation */
  action: 'create' | 'modify' | 'delete' | 'undo' | 'redo';
  /** ISO timestamp */
  timestamp: string;
  /** User who performed the action */
  userId: string;
  /** Annotation state before the action (for undo) */
  previousState?: unknown;
  /** Annotation state after the action (for redo) */
  currentState?: unknown;
}

/**
 * Tracks whether an annotation is "tracked" for DICOM SR persistence.
 * Tracked annotations get unique IDs and are saved as Structured Reports.
 * Untracked ones are ephemeral — gone when you close the viewer.
 */
export interface TrackingState {
  /** UID of the annotation */
  annotationUID: string;
  /** Human-readable tracking ID (e.g., "Lesion 1") */
  trackingId: string;
  /** Globally unique tracking ID (UUID) for DICOM SR */
  trackingUniqueId: string;
  /** Whether this annotation is being tracked for persistence */
  isTracked: boolean;
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * A reusable text template for radiology reports.
 * Like autocomplete snippets — type "normal liver" and get a full normal findings paragraph.
 */
export interface ReportMacro {
  /** Unique macro ID */
  id: string;
  /** Short name (e.g., "Normal Liver CT") */
  name: string;
  /** Category for grouping (e.g., "Liver", "Abdomen", "HPB") */
  category: string;
  /** Template text with optional {{variable}} placeholders */
  templateText: string;
  /** List of variable names used in the template */
  variables: string[];
  /** User ID of the macro creator */
  createdBy: string;
}

/**
 * Alert for critical/urgent findings that need immediate communication.
 * When a radiologist spots something life-threatening (e.g., hepatic arterial rupture),
 * this triggers notifications to the ordering physician.
 */
export interface CriticalFindingAlert {
  /** Alert ID */
  id: string;
  /** DICOM StudyInstanceUID of the study with the critical finding */
  studyInstanceUID: string;
  /** Description of the critical finding */
  finding: string;
  /** Severity level */
  severity: 'critical' | 'urgent';
  /** ISO timestamp when notification was sent */
  notifiedAt?: string;
  /** ISO timestamp when the finding was acknowledged */
  acknowledgedAt?: string;
  /** User ID of who acknowledged it */
  acknowledgedBy?: string;
}

/**
 * RADPEER 2016 peer review score for quality assurance.
 * Radiologists review each other's reads to catch discrepancies.
 */
export interface PeerReviewScore {
  /** Review ID */
  reviewId: string;
  /** DICOM StudyInstanceUID being reviewed */
  studyInstanceUID: string;
  /** User ID of the reviewing radiologist */
  reviewerId: string;
  /** Individual scores per criterion */
  scores: Record<string, number>;
  /** Weighted overall score */
  overallScore: number;
  /** Free-text comments from the reviewer */
  comments: string;
  /** Whether a significant discrepancy was found */
  discrepancyFlag: boolean;
}

// ============================================================================
// Image Processing
// ============================================================================

/**
 * Image filter/enhancement settings applied to a viewport.
 * Think of it like photo editing controls — brightness, contrast, sharpen, etc.
 */
export interface ImageFilter {
  /** Brightness adjustment (-100 to 100, 0 = no change) */
  brightness: number;
  /** Contrast adjustment (-100 to 100, 0 = no change) */
  contrast: number;
  /** Whether pixel values are inverted (like a photo negative) */
  invert: boolean;
  /** Sharpening strength (0 = off, 1 = light, 2 = medium, 3 = strong) */
  sharpen: number;
  /** Whether edge enhancement filter is applied */
  edgeEnhance: boolean;
  /** Whether CLAHE (adaptive histogram equalization) is applied */
  clahe: boolean;
}

// ============================================================================
// PACS Viewer Component Props
// ============================================================================

/**
 * Props for the top-level `<PACSViewer>` React component.
 * Mirrors the MediMind shape one-for-one so the ported component tree can
 * be reused with no call-site changes. Cardiology-only props were never on
 * this interface (DSA/QCA/calibration state lived inside the hook), so the
 * port is clean.
 */
export interface PACSViewerProps {
  /** DICOM StudyInstanceUID to load */
  studyInstanceUid: string;
  /** Orthanc internal study ID (optional — local uploads may not have this) */
  orthancStudyId?: string;
  /** Optional: pre-select a specific series by its SeriesInstanceUID */
  seriesUid?: string;
  /** Called when the user closes the viewer */
  onClose?: () => void;
  /** Optional: study metadata for hanging protocol matching */
  studyInfo?: ImagingStudyListItem;
  /** Whether the viewer is in full-screen mode */
  isFullScreen?: boolean;
  /** Toggle full-screen mode */
  onToggleFullScreen?: () => void;
  /** Navigate to previous study */
  onPrevStudy?: () => void;
  /** Navigate to next study */
  onNextStudy?: () => void;
  /** Whether there is a previous study to navigate to */
  hasPrevStudy?: boolean;
  /** Whether there is a next study to navigate to */
  hasNextStudy?: boolean;
  /** Toggle the Report Panel (opens/closes the side panel for writing reports) */
  onToggleReport?: () => void;
  /** Hide the left sidebar (tools/presets/series) — used when study drawer is open */
  hideSidebar?: boolean;
}
