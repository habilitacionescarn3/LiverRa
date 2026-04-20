// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode, CSSProperties, ComponentType, SVGAttributes } from 'react';

// Tabler icon props type
export type IconProps = SVGAttributes<SVGElement> & {
  size?: number | string;
  stroke?: number | string;
};

/**
 * Input size variants
 */
export type EMRInputSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Validation state for inputs
 */
export type EMRValidationState = 'default' | 'error' | 'success' | 'warning';

/**
 * Base props shared by all EMR form field components
 */
export interface EMRFieldBaseProps {
  /** Unique identifier for the field */
  id?: string;

  /** Field name for form submission */
  name?: string;

  /** Field label displayed above input */
  label?: ReactNode;

  /** Placeholder text inside the input */
  placeholder?: string;

  /** Help text displayed below the input */
  helpText?: string;

  /** Error message (overrides helpText when present) */
  error?: string | boolean | null;

  /** Success message (shown with success validation state) */
  successMessage?: string;

  /** Warning message (shown with warning validation state) */
  warningMessage?: string;

  /** Input size variant */
  size?: EMRInputSize;

  /** Whether the field is required */
  required?: boolean;

  /** Whether the field is disabled */
  disabled?: boolean;

  /** Whether the field is read-only */
  readOnly?: boolean;

  /** Validation state */
  validationState?: EMRValidationState;

  /** Left section content (icon or text) */
  leftSection?: ReactNode;

  /** Right section content (icon or text) */
  rightSection?: ReactNode;

  /** Additional CSS class name */
  className?: string;

  /** Inline styles */
  style?: CSSProperties;

  /** Data attributes for testing */
  'data-testid'?: string;

  /** ARIA label for accessibility */
  'aria-label'?: string;

  /** ARIA described by ID */
  'aria-describedby'?: string;

  /** Show clear button */
  clearable?: boolean;

  /** Callback when clear button is clicked */
  onClear?: () => void;

  /** Full width input */
  fullWidth?: boolean;
}

/**
 * EMRTextInput specific props
 */
export interface EMRTextInputProps extends EMRFieldBaseProps {
  /** Input type (text, email, password, etc.) */
  type?: 'text' | 'email' | 'password' | 'search' | 'tel' | 'url' | 'number' | 'time';

  /** Input mode for mobile keyboards (tel, email, numeric, decimal, url, search) */
  inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search';

  /** Current value */
  value?: string;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string) => void;

  /** Native change event handler */
  onChangeEvent?: (event: React.ChangeEvent<HTMLInputElement>) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Focus handler */
  onFocus?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Key down handler */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;

  /** Maximum character length */
  maxLength?: number;

  /** Pattern for validation */
  pattern?: string;

  /** Autocomplete attribute */
  autoComplete?: string;

  /** Auto focus on mount */
  autoFocus?: boolean;

  /** Description text (alias for helpText, for backward compatibility) */
  description?: string;

  /** Custom styles (for backward compatibility, ignored in new design) */
  styles?: Record<string, unknown>;

  /** Width of the right section in pixels */
  rightSectionWidth?: number;
}

/**
 * EMRSelect specific props
 */
export interface EMRSelectOption {
  /** Option value */
  value: string;

  /** Display label */
  label: string;

  /** Whether option is disabled */
  disabled?: boolean;

  /** Group name for option groups */
  group?: string;

  /** Optional description */
  description?: string;
}

export interface EMRSelectProps extends EMRFieldBaseProps {
  /** Select options */
  data: EMRSelectOption[] | string[];

  /** Current value */
  value?: string | null;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string | null) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Whether the select is searchable */
  searchable?: boolean;

  /** Nothing found message */
  nothingFoundMessage?: string;

  /** Maximum dropdown height */
  maxDropdownHeight?: number;

  /** Allow deselecting (clearing) */
  allowDeselect?: boolean;

  /** Check icon position */
  checkIconPosition?: 'left' | 'right';

  /** Dropdown position */
  dropdownPosition?: 'bottom' | 'top' | 'flip';

  /** Custom filter function */
  filter?: (options: { options: EMRSelectOption[]; search: string }) => EMRSelectOption[];

  /** Custom render function for dropdown options */
  renderOption?: (item: { option: { value: string; label: string } }) => ReactNode;

  /** Description text (alias for helpText, for backward compatibility) */
  description?: string;

  /** Custom styles (for backward compatibility, ignored in new design) */
  styles?: Record<string, unknown>;

  /** Controlled search value for searchable selects */
  searchValue?: string;

  /** Callback when search value changes */
  onSearchChange?: (value: string) => void;
}

/**
 * EMRNumberInput specific props
 */
export interface EMRNumberInputProps extends EMRFieldBaseProps {
  /** Current value */
  value?: number | string;

  /** Default value (uncontrolled) */
  defaultValue?: number;

  /** Change handler */
  onChange?: (value: number | string) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Minimum value */
  min?: number;

  /** Maximum value */
  max?: number;

  /** Step increment */
  step?: number;

  /** Number of decimal places */
  decimalScale?: number;

  /** Decimal separator */
  decimalSeparator?: string;

  /** Thousand separator */
  thousandSeparator?: string;

  /** Prefix (e.g., '$') */
  prefix?: string;

  /** Suffix (e.g., 'GEL', '%') */
  suffix?: string;

  /** Hide step controls */
  hideControls?: boolean;

  /** Allow negative values */
  allowNegative?: boolean;

  /** Clamp value to min/max on blur */
  clampBehavior?: 'blur' | 'strict' | 'none';
}

/**
 * EMRTextarea specific props
 */
export interface EMRTextareaProps extends EMRFieldBaseProps {
  /** Current value */
  value?: string;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string) => void;

  /** Native change event handler */
  onChangeEvent?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;

  /** Focus handler */
  onFocus?: (event: React.FocusEvent<HTMLTextAreaElement>) => void;

  /** Number of visible rows */
  rows?: number;

  /** Minimum rows (for autosize) */
  minRows?: number;

  /** Maximum rows (for autosize) */
  maxRows?: number;

  /** Enable auto-resize */
  autosize?: boolean;

  /** Maximum character length */
  maxLength?: number;

  /** Show character count */
  showCount?: boolean;

  /** Resize behavior */
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
}

/**
 * EMRDatePicker specific props
 */
export interface EMRDatePickerProps extends EMRFieldBaseProps {
  /** Current value */
  value?: Date | null;

  /** Default value (uncontrolled) */
  defaultValue?: Date;

  /** Change handler */
  onChange?: (value: Date | null) => void;

  /** Blur handler */
  onBlur?: () => void;

  /** Minimum selectable date */
  minDate?: Date;

  /** Maximum selectable date */
  maxDate?: Date;

  /** Excluded dates */
  excludeDates?: Date[];

  /** Date format string */
  valueFormat?: string;

  /** Whether to clear on escape */
  clearable?: boolean;

  /** Allow input editing */
  allowInput?: boolean;

  /** First day of week (0 = Sunday, 1 = Monday) */
  firstDayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;

  /** Show week numbers */
  showWeekNumbers?: boolean;

  /** Highlight weekends */
  highlightWeekends?: boolean;

  /** Level to display (date, month, year) */
  level?: 'date' | 'month' | 'year';

  /** Dropdown type */
  dropdownType?: 'modal' | 'popover';
}

/**
 * EMRPhoneInput specific props
 */
export interface EMRPhoneInputProps extends EMRFieldBaseProps {
  /** Current value (full phone number with country code) */
  value?: string;

  /** Default value */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string) => void;

  /** Country code (ISO 2) */
  defaultCountry?: string;

  /** Allowed countries */
  onlyCountries?: string[];

  /** Excluded countries */
  excludeCountries?: string[];

  /** Preferred countries (shown at top) */
  preferredCountries?: string[];

  /** Auto format phone number */
  autoFormat?: boolean;

  /** Show country flag */
  showFlag?: boolean;

  /** Show dial code in input */
  showDialCode?: boolean;
}

/**
 * EMRCheckbox specific props
 */
export interface EMRCheckboxProps extends Omit<EMRFieldBaseProps, 'placeholder'> {
  /** Current checked state */
  checked?: boolean;

  /** Default checked state (uncontrolled) */
  defaultChecked?: boolean;

  /** Change handler */
  onChange?: (checked: boolean) => void;

  /** Native change event handler */
  onChangeEvent?: (event: React.ChangeEvent<HTMLInputElement>) => void;

  /** Indeterminate state */
  indeterminate?: boolean;

  /** Label position */
  labelPosition?: 'left' | 'right';

  /** Checkbox color */
  color?: string;

  /** Custom icon when checked */
  icon?: ComponentType<IconProps>;

  /** Custom icon when indeterminate */
  indeterminateIcon?: ComponentType<IconProps>;

  /** Description text (alias for helpText, for backward compatibility) */
  description?: string;

  /** Custom styles (for backward compatibility, ignored in new design) */
  styles?: Record<string, unknown>;
}

/**
 * EMRSwitch specific props
 */
export interface EMRSwitchProps extends Omit<EMRFieldBaseProps, 'placeholder'> {
  /** Current checked state */
  checked?: boolean;

  /** Default checked state (uncontrolled) */
  defaultChecked?: boolean;

  /** Change handler */
  onChange?: (checked: boolean) => void;

  /** Native change event handler */
  onChangeEvent?: (event: React.ChangeEvent<HTMLInputElement>) => void;

  /** Label position */
  labelPosition?: 'left' | 'right';

  /** Switch color */
  color?: string;

  /** Label when on */
  onLabel?: string;

  /** Label when off */
  offLabel?: string;

  /** Thumb icon when on */
  thumbIcon?: ReactNode;

  /** Description text (alias for helpText, for backward compatibility) */
  description?: string;

  /** Custom styles */
  styles?: Record<string, unknown>;
}

/**
 * EMRMultiSelect specific props
 */
export interface EMRMultiSelectProps extends EMRFieldBaseProps {
  /** Select options */
  data: EMRSelectOption[] | string[];

  /** Current value (array of selected values) */
  value?: string[];

  /** Default value (uncontrolled) */
  defaultValue?: string[];

  /** Change handler */
  onChange?: (value: string[]) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Whether the select is searchable */
  searchable?: boolean;

  /** Nothing found message */
  nothingFoundMessage?: string;

  /** Maximum dropdown height */
  maxDropdownHeight?: number;

  /** Maximum number of values */
  maxValues?: number;

  /** Hide already picked options */
  hidePickedOptions?: boolean;

  /** Dropdown position */
  dropdownPosition?: 'bottom' | 'top' | 'flip';

  /** Custom filter function */
  filter?: (options: { options: EMRSelectOption[]; search: string }) => EMRSelectOption[];
}

/**
 * EMRColorInput specific props
 */
export interface EMRColorInputProps extends EMRFieldBaseProps {
  /** Current value (color string) */
  value?: string;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Color format */
  format?: 'hex' | 'rgb' | 'rgba' | 'hsl' | 'hsla';

  /** Color swatches to display */
  swatches?: string[];

  /** Number of swatches per row */
  swatchesPerRow?: number;

  /** Show eye dropper tool */
  withEyeDropper?: boolean;

  /** Close dropdown when swatch is clicked */
  closeOnColorSwatchClick?: boolean;

  /** Disallow manual input */
  disallowInput?: boolean;
}

/**
 * EMRTimeInput specific props
 */
export interface EMRTimeInputProps extends EMRFieldBaseProps {
  /** Current value (time string HH:mm or HH:mm:ss) */
  value?: string;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string) => void;

  /** Blur handler */
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;

  /** Show seconds input */
  withSeconds?: boolean;

  /** Minimum time */
  minTime?: string;

  /** Maximum time */
  maxTime?: string;
}

/**
 * EMRRadioGroup specific props
 */
export interface EMRRadioOption {
  /** Option value */
  value: string;

  /** Display label */
  label: string;

  /** Whether option is disabled */
  disabled?: boolean;

  /** Optional description */
  description?: string;
}

export interface EMRRadioGroupProps extends EMRFieldBaseProps {
  /** Radio options */
  options: EMRRadioOption[];

  /** Current value */
  value?: string;

  /** Default value (uncontrolled) */
  defaultValue?: string;

  /** Change handler */
  onChange?: (value: string) => void;

  /** Layout orientation */
  orientation?: 'horizontal' | 'vertical';

  /** Spacing between options */
  spacing?: EMRInputSize;

  /** Radio color */
  color?: string;
}

/**
 * EMRFormRow props (for horizontal field layouts)
 */
export interface EMRFormRowProps {
  /** Row children (form fields) */
  children: ReactNode;

  /** Gap between children */
  gap?: EMRInputSize | number;

  /** Wrap children on small screens */
  wrap?: boolean;

  /** Alignment */
  align?: 'start' | 'center' | 'end' | 'stretch';

  /** Additional CSS class name */
  className?: string;

  /** Inline styles */
  style?: CSSProperties;
}

/**
 * EMRFormSection props (for collapsible sections)
 */
export interface EMRFormSectionProps {
  /** Section title */
  title: string;

  /** Section icon */
  icon?: ComponentType<IconProps>;

  /** Section children */
  children: ReactNode;

  /** Whether section is open by default */
  defaultOpen?: boolean;

  /** Controlled open state */
  open?: boolean;

  /** Change handler for open state */
  onOpenChange?: (open: boolean) => void;

  /** Section border color */
  borderColor?: string;

  /** Additional CSS class name */
  className?: string;

  /** Inline styles */
  style?: CSSProperties;

  /** Data attributes for testing */
  'data-testid'?: string;

  /** Optional subtitle below title */
  subtitle?: string;

  /** Right-aligned content (e.g., checkbox, button) */
  rightContent?: ReactNode;

  /** Whether section has content (affects empty state display) */
  hasContent?: boolean;

  /** Empty state message when section has no content */
  emptyStateMessage?: string;
}

/**
 * EMRFormActions props (for form submit/cancel buttons)
 */
export interface EMRFormActionsProps {
  /** Primary action label */
  submitLabel?: string;

  /** Secondary action label */
  cancelLabel?: string;

  /** Submit handler */
  onSubmit?: () => void;

  /** Cancel handler */
  onCancel?: () => void;

  /** Loading state */
  loading?: boolean;

  /** Disabled state */
  disabled?: boolean;

  /** Alignment */
  align?: 'left' | 'center' | 'right' | 'space-between';

  /** Show cancel button */
  showCancel?: boolean;

  /** Additional actions (rendered between cancel and submit) */
  additionalActions?: ReactNode;

  /** Additional CSS class name */
  className?: string;

  /** Inline styles */
  style?: CSSProperties;
}

/**
 * EMRFieldWrapper props (internal wrapper component)
 */
export interface EMRFieldWrapperProps {
  /** Field label */
  label?: ReactNode;

  /** Whether field is required */
  required?: boolean;

  /** Help text */
  helpText?: string;

  /** Error message */
  error?: string | boolean;

  /** Success message */
  successMessage?: string;

  /** Warning message */
  warningMessage?: string;

  /** Validation state */
  validationState?: EMRValidationState;

  /** Field size */
  size?: EMRInputSize;

  /** Full width */
  fullWidth?: boolean;

  /** Wrapper children */
  children: ReactNode;

  /** Additional CSS class name */
  className?: string;

  /** Inline styles */
  style?: CSSProperties;

  /** HTML for attribute (connects label to input) */
  htmlFor?: string;

  /** Field ID used to generate accessible error/message element IDs (pattern: fieldId-error) */
  fieldId?: string;
}

/**
 * Helper type to get height based on size
 */
export const EMR_INPUT_HEIGHTS: Record<EMRInputSize, string> = {
  xs: 'var(--emr-input-height-xs)',
  sm: 'var(--emr-input-height-sm)',
  md: 'var(--emr-input-height-md)',
  lg: 'var(--emr-input-height-lg)',
  xl: 'var(--emr-input-height-xl)',
};

/**
 * Helper to get numeric height based on size
 */
export const EMR_INPUT_HEIGHT_VALUES: Record<EMRInputSize, number> = {
  xs: 30,
  sm: 36,
  md: 42,
  lg: 48,
  xl: 54,
};
