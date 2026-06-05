// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// PACS (Picture Archiving and Communication System) Types
// ============================================================================
// Pure type definitions for the embedded Cornerstone3D PACS viewer.
// No external dependencies — every other PACS module imports from here.
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
  | 'Stenosis'
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
  // Specialized
  | 'DSA'
  // Overlay tools (always-on, not user-selectable)
  | 'OrientationMarker'
  | 'ScaleOverlay';

/**
 * Rendering mode for slab-based volume projection.
 * - 'default': Normal rendering (single slice, no slab projection)
 * - 'mip': Maximum Intensity Projection — shows the brightest pixel in the slab
 *   (great for seeing blood vessels filled with contrast)
 * - 'minip': Minimum Intensity Projection — shows the dimmest pixel in the slab
 *   (great for seeing air-filled structures like bronchi)
 * - 'average': Average Intensity Projection — shows the mean pixel value across
 *   the slab (a softer, radiograph-like look). Best-effort: not every blend
 *   engine handler maps this, in which case it degrades to no slab change.
 */
export type RenderingMode = 'default' | 'mip' | 'minip' | 'average';

/**
 * Mouse-interaction mode for the 3D VR pane.
 * - 'rotate': LMB drags the trackball (rotate the volume). Default. Crop
 *   handles + reference lines are still visible but passive — you can SEE
 *   the bounding box but won't accidentally drag it while spinning.
 * - 'crop': LMB drags the cropping handles (3D spheres + MPR reference
 *   lines). The operator picks a region on any MPR pane and the 3D pane
 *   shows ONLY that region. Trackball rotation moves to a different
 *   binding (or pauses) while in this mode.
 */
export type VrInteractionMode = 'rotate' | 'crop';

/**
 * Transfer function presets for 3D volume rendering.
 * Each preset adjusts opacity and color mapping to highlight different tissue types.
 * Think of it like Instagram filters but for CT scans — each one makes different
 * body parts visible or invisible.
 *
 * `CtVessel` is the 3mensio-style glowing contrast-CT vessel render used by
 * the TAVI Step-9 access-route VR (single source of truth:
 * `vrViewportMode.ts:TAVI_VR_PRESET_NAME` → `'CT-Coronary-Arteries-2'`).
 */
export type TransferFunctionPreset =
  | 'Bone'
  | 'SoftTissue'
  | 'Lung'
  | 'Vascular'
  | 'CtVessel';

/**
 * Viewport layout presets.
 * - 1x1: single image (stack — non-volumetric series, default fallback)
 * - 1x2: two side-by-side (comparison)
 * - 2x1: two stacked vertically
 * - 2x2: quad view
 * - 1x3-mpr: axial + sagittal + coronal for MPR (multi-planar reconstruction)
 * - 1x1-axial: single ORTHOGRAPHIC axial pane backed by a volume — same
 *   quality as the MPR axial pane, smooth reslice-grade scrolling. Used as
 *   the M-key exit target for volumetric studies so you don't drop into a
 *   slow STACK after leaving MPR.
 * - 2x2-mpr-vr: 3 MPR (axial/sagittal/coronal) + 1 VR in a 2×2 grid, all
 *   four panes share a single cached volume. Used when the 3D toggle is
 *   pressed from MPR (instead of destroying MPR with a single-VR view).
 */
export type ViewportLayout =
  | '1x1'
  | '1x2'
  | '2x1'
  | '2x2'
  // Mammography screening hanging protocol: a 2×2 STACK grid auto-populated
  // with LCC (top-left) / RCC (top-right) / LMLO / RMLO, the right breast
  // mirrored so the two sides mount chest-wall-to-chest-wall. Stack-only.
  // See services/pacs/mammoLayout.ts for the per-pane assignment logic.
  | 'mammo-4up'
  | '1x3-mpr'
  | '1x1-axial'
  // Solo 3D volume rendering. Distinct id from '1x1' (which is a 2D stack pane)
  // so the render-reconciliation effect's layout-change gate fires when toggling
  // 3D on/off from a single-pane view. Reached only via the 3D toggle, never the
  // grid-layout picker.
  | '1x1-3d'
  | '2x2-mpr-vr';

/**
 * Per-image mammography descriptor — populated only for MG (FFDM) images.
 * Drives the 4-up hanging protocol (services/pacs/mammoLayout.ts). Empty for
 * every other modality, so non-MG code paths are unchanged.
 */
export interface MammoImageDescriptor {
  /** Frame-1 imageId (the displayed image). */
  imageId: string;
  /** Breast side from ImageLaterality (0020,0062): 'L' | 'R'. */
  laterality?: 'L' | 'R';
  /** Normalized ViewPosition (0018,5101): 'CC' | 'MLO' | 'ML' | 'XCCL' | … */
  view?: string;
  /** Presentation intent (0008,0068) — prefer PRESENTATION over PROCESSING duplicates. */
  presentationIntent?: 'PROCESSING' | 'PRESENTATION';
  /** Patient Orientation (0020,0020), e.g. 'A\\F' — orientation hint used to
   *  detect a study that is already stored mirrored (so we don't double-flip). */
  patientOrientation?: string;
  /** Field of View Horizontal Flip (0018,7034): 'YES' | 'NO' — when 'YES' the
   *  detector already flipped the image horizontally. */
  fieldOfViewHorizontalFlip?: string;
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
  /** Accession number (format: ACC-YYYYMMDD-XXXXXX) */
  accessionNumber?: string;
  /** FHIR Patient resource ID */
  patientId: string;
  /** Patient display name */
  patientName: string;
  /** Study date in ISO format (YYYY-MM-DD) */
  date: string;
  /** Imaging modalities in the study (e.g., ['CT', 'MR']) */
  modalities: string[];
  /** Body part examined (e.g., 'CHEST', 'ABDOMEN') */
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
  /** Ordering clinician's display name (resolved from basedOn → ServiceRequest → Practitioner) */
  orderingDoctorName?: string;
  /** True if an earlier study of the same modality/body-part exists for this patient (prior for comparison) */
  hasPrior?: boolean;
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
  windowLevel: {
    center: number;
    width: number;
  };
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
 * Think of it as a "recipe" — when the study matches certain criteria (e.g., CT Chest),
 * the viewer automatically picks the right layout and assigns series to viewports.
 */
export interface HangingProtocolRule {
  /** Unique rule identifier */
  id: string;
  /** Human-readable name (e.g., "CT Chest Standard") */
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
    /** Window/level preset name (e.g., 'lung', 'bone', 'brain') */
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
  /** Patient age in years at read time (from Patient.birthDate); undefined if unknown */
  patientAge?: number;
  /** Patient sex ('male' | 'female' | 'other' | 'unknown'); undefined if unknown */
  patientSex?: string;
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
  /**
   * Filter by radiology subspecialty. Accepts `'all'` (or omitted) to disable
   * the filter. LiverRa keeps this as a plain string (no subspecialty-mapping
   * constants module — MediMind's coded enum was not ported).
   */
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
 * (e.g., a catheter with known French size).
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
// Cardiology
// ============================================================================

/**
 * Details about a coronary stent found during imaging.
 */
export interface StentDetails {
  /** Stent type/brand */
  type: string;
  /** Stent diameter in mm */
  diameter: number;
  /** Stent length in mm */
  length: number;
  /** ISO date when the stent was deployed (if known) */
  deploymentDate?: string;
}

/**
 * Findings for a single coronary artery segment (AHA 15-segment model).
 * Records stenosis severity, calcification, and any stents present.
 */
export interface CoronarySegmentFinding {
  /** AHA segment ID (e.g., '1' for proximal RCA) */
  segmentId: string;
  /** Segment name (e.g., 'pRCA', 'LM', 'mLAD') */
  segmentName: string;
  /** Diameter stenosis percentage (0-100) */
  stenosisPercent: number;
  /** Length of the lesion in mm */
  lesionLength?: number;
  /** Calcification severity */
  calcification: 'none' | 'mild' | 'moderate' | 'severe';
  /** Stent details if a stent is present in this segment */
  stent?: StentDetails;
}

/**
 * CAD-RADS 2.0 score — standardized way to report coronary CT angiography.
 * Like a grading system for how blocked the arteries are.
 */
export interface CADRADSScore {
  /** Stenosis severity grade */
  score: '0' | '1' | '2' | '3' | '4A' | '4B' | '5' | 'N';
  /** Optional modifier: S=stent, G=graft, S+G=both */
  modifier?: 'S' | 'G' | 'S+G';
  /** Human-readable description of the score */
  description: string;
}

/**
 * Stenosis measurement result from the quantitative analysis tool.
 * Captures the narrowing of a vessel at a specific location.
 */
export interface StenosisResult {
  /** AHA segment ID where stenosis was measured */
  segmentId: string;
  /** Minimum lumen diameter at the stenosis (mm) */
  minDiameter: number;
  /** Reference vessel diameter upstream of stenosis (mm) */
  referenceDiameter: number;
  /** Calculated percent stenosis: ((ref - min) / ref) × 100 */
  percentStenosis: number;
  /** Length of the stenotic lesion (mm) */
  lesionLength: number;
  /** Measurement points used for the calculation */
  points: Array<{ x: number; y: number }>;
}

// ============================================================================
// Reporting
// ============================================================================

/**
 * A reusable text template for radiology reports.
 * Like autocomplete snippets — type "normal chest" and get a full normal findings paragraph.
 */
export interface ReportMacro {
  /** Unique macro ID */
  id: string;
  /** Short name (e.g., "Normal Chest CT") */
  name: string;
  /** Category for grouping (e.g., "Chest", "Abdomen", "MSK") */
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
 * When a radiologist spots something life-threatening (e.g., aortic dissection),
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
// Cath Lab Reporting
// ============================================================================

/**
 * Findings for a single vessel in a cath lab report.
 * Records stenosis %, TIMI flow grade, intervention performed, and stent details.
 */
export interface CathLabVesselFinding {
  /** Vessel name (e.g., 'LM', 'LAD', 'LCx', 'RCA', 'PDA', 'PLV') */
  vessel: string;
  /** Diameter stenosis percentage (0-100) */
  stenosisPercent: number;
  /** TIMI flow grade (0-3) */
  timiGrade: number;
  /** Intervention performed */
  intervention: 'none' | 'ptca' | 'stent' | 'des' | 'bypass';
  /** Stent brand/name (when intervention is stent or DES) */
  stentName?: string;
  /** Stent diameter in mm (when intervention is stent or DES) */
  stentDiameter?: number;
  /** Stent length in mm (when intervention is stent or DES) */
  stentLength?: number;
  /** Medina bifurcation classification — [proximal MB, distal MB, side branch] */
  medinaClassification?: [number, number, number];
}

/**
 * Hemodynamic measurements from cardiac catheterization.
 * All pressures in mmHg, cardiac output in L/min.
 */
export interface CathLabHemodynamics {
  /** Left Ventricular End-Diastolic Pressure */
  lvedp?: number;
  /** Aortic systolic pressure */
  aorticSystolic?: number;
  /** Aortic diastolic pressure */
  aorticDiastolic?: number;
  /** Pulmonary artery systolic pressure */
  paSystolic?: number;
  /** Pulmonary artery diastolic pressure */
  paDiastolic?: number;
  /** Pulmonary capillary wedge pressure */
  pcwp?: number;
  /** Cardiac output (L/min) */
  cardiacOutput?: number;
}

/**
 * Full cath lab structured report data.
 * Captures coronary dominance, per-vessel findings, hemodynamics, and summary.
 */
export interface CathLabData {
  /** Coronary dominance pattern */
  dominance: 'right' | 'left' | 'co-dominant';
  /** Per-vessel findings (LM, LAD, LCx, RCA, PDA, PLV) */
  vesselFindings: CathLabVesselFinding[];
  /** Hemodynamic measurements */
  hemodynamics: CathLabHemodynamics;
  /** Auto-generated (but editable) summary text */
  summary: string;
}

// ============================================================================
// CAD-RADS 2.0 Scoring
// ============================================================================

/**
 * CAD-RADS 2.0 structured scoring data for coronary CT angiography.
 * Standardized reporting system: grade + plaque burden + modifiers = summary.
 */
export interface CADRADSData {
  /** Stenosis severity grade: '0','1','2','3','4A','4B','5','N', or null */
  grade: string | null;
  /** Plaque burden classification: 'P1','P2','P3','P4', or null */
  plaqueBurden: string | null;
  /** Active modifiers: 'N','S','G','HRP','I+','I-','I+/-','E' */
  modifiers: string[];
  /** Auto-generated summary string, e.g. "CAD-RADS 3/P2 (S, HRP)" */
  summary: string;
  /** Recommended followup based on grade */
  followup: string;
}

// ============================================================================
// BI-RADS Mammography Assessment
// ============================================================================

/**
 * BI-RADS structured assessment for mammography (ACR BI-RADS 5th edition).
 * The overall coded category is written to DiagnosticReport.conclusionCode;
 * density is the optional ACR breast composition. summary/management are
 * derived display strings recomputed on load so they never go stale.
 */
export interface BIRADSData {
  /** Overall BI-RADS category: '0','1','2','3','4','4A','4B','4C','5','6', or null */
  category: string | null;
  /** ACR breast composition: 'a','b','c','d', or null (optional) */
  density: string | null;
  /** Auto-generated summary, e.g. "BI-RADS 4A" (plus ", ACR c" when set) */
  summary: string;
  /** Management recommendation derived from the category */
  management: string;
}

/**
 * State for Digital Subtraction Angiography (DSA).
 * DSA subtracts a "mask" frame (without contrast) from "live" frames
 * (with contrast) to make blood vessels pop out from the background.
 */
export interface DSAState {
  /** Whether DSA mode is currently active */
  enabled: boolean;
  /** Index of the mask frame (pre-contrast injection) */
  maskFrameIndex: number;
  /** Index of the current live frame being displayed */
  currentFrameIndex: number;
  /** Pre-computed subtracted pixel data (null if not yet computed) */
  subtractedPixelData: Float32Array | null;
  /** Blending opacity for the subtracted overlay (0-1) */
  opacity: number;
}

// ============================================================================
// LiverRa-only exports (preserved across the MediMind viewer re-merge).
// These predate the advanced-viewer port and are consumed by existing
// LiverRa code (PacsStudyViewerView, WindowPresets, hangingProtocolEngine).
// ============================================================================

/** Window/level preset shape (structurally identical to ViewportState.windowLevel). */
export interface WindowLevelPreset {
  center: number;
  width: number;
}

/** @deprecated alias kept for pre-port LiverRa code; use PACSViewerTool. */
export type ToolName = PACSViewerTool;

/** @deprecated alias kept for pre-port LiverRa code; use PACSViewerState. */
export type ViewerState = PACSViewerState;

/**
 * Props for the PACS viewer component (LiverRa shape — the ported
 * PACSViewer.tsx defines its own internal props type and this one is kept
 * for the route-level wrapper).
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
