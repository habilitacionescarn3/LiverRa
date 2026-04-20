// SPDX-License-Identifier: Apache-2.0
/**
 * Barrel file for LiverRa EMR form fields (T097).
 *
 * Ported from MediMind with these LiverRa-specific adjustments:
 *   • `EMRDatePicker` now lives LOCAL to this directory (MediMind kept it
 *     in `common/` because it predated the form-fields directory).
 *   • `EMRRichTextEditor` re-export removed — the `../EMRRichText` module
 *     is not ported yet (tracked separately as TODO).
 */

// Types
export * from './EMRFieldTypes';

// CSS (must be imported once)
import './emr-fields.css';

// Core wrapper
export { EMRFieldWrapper } from './EMRFieldWrapper';

// Input components
export { EMRTextInput } from './EMRTextInput';
export { EMRSelect } from './EMRSelect';
export { EMRVirtualSelect } from './EMRVirtualSelect';
export { EMRMultiSelect } from './EMRMultiSelect';
export { EMRAutocomplete } from './EMRAutocomplete';
export type { EMRAutocompleteProps, EMRAutocompleteOption } from './EMRAutocomplete';
export { EMRNumberInput } from './EMRNumberInput';
export { EMRTextarea } from './EMRTextarea';
export { EMRColorInput } from './EMRColorInput';
export { EMRTimeInput } from './EMRTimeInput';

// Rich text editor — NOT YET PORTED (tracked as TODO)
// export { EMRRichTextEditor } from '../EMRRichText';
// export type { EMRRichTextEditorProps, MedicalTemplate, ToolbarFeature, ToolbarPreset } from '../EMRRichText';

// Date picker — custom Apple-inspired calendar, now local to this folder
export { EMRDatePicker } from './EMRDatePicker';

// Date-time picker (date + time in one field)
export { EMRDateTimePicker } from './EMRDateTimePicker';
export type { EMRDateTimePickerProps } from './EMRDateTimePicker';

// Toggle components
export { EMRCheckbox } from './EMRCheckbox';
export { EMRSwitch } from './EMRSwitch';
export { EMRRadioGroup } from './EMRRadioGroup';

// Layout components
export { EMRFormRow } from './EMRFormRow';
export { EMRFormSection } from './EMRFormSection';
export { EMRFormActions } from './EMRFormActions';

// Default export for convenience
export { EMRTextInput as default } from './EMRTextInput';
