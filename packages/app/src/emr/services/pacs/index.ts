// SPDX-FileCopyrightText: Copyright LiverRa contributors
// SPDX-License-Identifier: Apache-2.0
export {
  initCornerstone,
  getOrCreateRenderingEngine,
  destroyRenderingEngine,
  RENDERING_ENGINE_ID,
  detectWebGL2Support,
  isCornerstoneInitialized,
  configureDicomAuth,
  WINDOW_LEVEL_PRESETS,
  getOrCreateToolGroup,
  activateToolOnGroup,
  // HTJ2K progressive streaming
  HTJ2K_LOSSLESS_UID,
  HTJ2K_LOSSY_UID,
  EXPLICIT_VR_LITTLE_ENDIAN_UID,
  configureHTJ2K,
  getHTJ2KConfig,
  getPreferredTransferSyntaxes,
  getDicomInstanceAcceptHeader,
  isHTJ2KTransferSyntax,
} from './cornerstoneInit';
export type { HTJ2KConfig } from './cornerstoneInit';
export {
  DicomWebClient,
  DicomWebError,
  DicomWebAuthError,
  DicomWebNotFoundError,
  DicomWebUnavailableError,
} from './dicomwebClient';
export type {
  DicomJsonObject,
  DicomJsonTag,
  StudySearchParams,
  SeriesSearchParams,
  StowResult,
} from './dicomwebClient';
export {
  toListItem,
  serviceRequestToListItem,
  mergeStudiesAndOrders,
  listByPatient,
  getByUid,
  getByAccessionNumber,
  getById,
  fetchReportsForStudies,
  fetchPendingOrders,
  getOrCreateEndpoint,
  listItemsByPatient,
  reassignStudy,
  findReportsForStudy,
  deleteStudy,
  deleteStudyAnnotations,
  deleteStudyRelatedResources,
  searchStudies,
  findPriorStudy,
} from './imagingStudyService';
export type { PriorStudyResult, ReassignmentResult, StudyCleanupResult } from './imagingStudyService';
export {
  saveAnnotations,
  loadAnnotations,
  loadMyAnnotations,
  deleteAnnotations,
} from './annotationService';
export type { StoredAnnotations } from './annotationService';
export {
  initAuditService,
  isAuditServiceInitialized,
  logStudyView,
  logAnnotationSave,
  logKeyImageFlag,
  logStudyDownload,
  logStudyModify,
  logStudyDelete,
  logBreakGlass,
  logImagingBreakGlassAccess,
  sendBreakGlassAlert,
  getActiveImagingBreakGlass,
  IMAGING_BTG_DURATION_MS,
} from './auditService';
export type { ImagingBreakGlassRequest } from './auditService';
export {
  matchProtocol,
  applyProtocol,
  loadUserProtocols,
  saveUserProtocol,
  deleteUserProtocol,
  SYSTEM_PROTOCOLS,
} from './hangingProtocolEngine';
export type { ViewerConfiguration, ViewportAssignment } from './hangingProtocolEngine';
export {
  getWorklistItems,
  getOverdueStatCount,
} from './readingWorklistService';
export type { PaginatedWorklistResult } from './readingWorklistService';
export {
  flagKeyImage,
  getKeyImages,
  getKeyImageCount,
  unflagKeyImage,
} from './keyImageService';
export type { KeyImage, FlagKeyImageOptions } from './keyImageService';
export { ProgressiveLoader } from './progressiveLoader';
export type {
  LoaderStatus,
  LoadProgress,
  ProgressiveLoaderConfig,
} from './progressiveLoader';
export {
  startTimer,
  stopTimer,
  firstImageTimer,
  mprTimer,
  worklistTimer,
  cornerstoneInitTimer,
  metadataFetchTimer,
  BENCHMARKS,
} from './pacsPerformance';
export {
  FRENCH_SIZES,
  CalibrationError,
  calculateCalibration,
  convertPixelsToMm,
} from './calibrationService';
export type { CalibrationResult } from './calibrationService';
export {
  createMacro,
  searchMacros,
  updateMacro,
  deleteMacro,
  getMacroTrigger,
  getMacroExpansion,
  getMacroCategory,
} from './macroService';
export type { MacroCategory } from './macroService';
export {
  subtractFrames,
  applyWindowLevel,
  validateFrameDimensions,
} from './dsaService';
export {
  auditLog as srAuditLog,
  exportAnnotationsToSR,
  importAnnotationsFromSR,
} from './dicomSRService';
export type {
  SRAuditAction,
  SRAuditEntry,
  SRExportResult,
  SRImportedAnnotation,
  SRImportResult,
} from './dicomSRService';
export {
  createCriticalAlert,
  acknowledgeCriticalAlert,
  getActiveAlerts,
  isEscalationDue,
} from './criticalAlertService';
export type {
  AlertSeverity,
  CreateCriticalAlertParams,
  CriticalAlert,
} from './criticalAlertService';
export {
  submitPeerReview,
  getReviewsForReport,
  RADPEER_SCORES,
} from './peerReviewService';
export type {
  RadpeerScore,
  SubmitPeerReviewParams,
  PeerReviewResult,
} from './peerReviewService';
export {
  applyConvolution,
  applyFilter,
  getSharpenKernel,
  getSmoothKernel,
  getSmoothPasses,
} from './imageFilterService';
export type {
  FilterType,
  FilterStrength,
  FilterConfig,
} from './imageFilterService';
