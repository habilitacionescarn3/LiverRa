// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import { IconCamera, IconUpload, IconX } from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { EMRButton } from './EMRButton';
import { useTranslation } from '../../contexts/TranslationContext';
import styles from './EMRDropzone.module.css';

/** Preview data for uploaded file */
interface FilePreview {
  url: string;
  name: string;
  size?: number;
}

/**
 * Props for EMRDropzone component
 */
export interface EMRDropzoneProps {
  /** Callback when file is selected */
  onFileSelect: (file: File) => void;
  /** Accepted MIME types (e.g., ['image/jpeg', 'image/png', 'image/webp']) */
  accept?: string[];
  /** Maximum file size in bytes (default: 10MB) */
  maxSize?: number;
  /** Show camera capture button */
  showCamera?: boolean;
  /** File preview data */
  preview?: FilePreview;
  /** Callback when preview is removed */
  onRemove?: () => void;
  /** Disabled state */
  disabled?: boolean;
  /** Title text */
  title?: string;
  /** Description text */
  description?: string;
  /** Test ID for testing */
  'data-testid'?: string;
}

/**
 * Format file size to human-readable string
 * @param bytes
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) {return `${bytes} B`;}
  if (bytes < 1024 * 1024) {return `${(bytes / 1024).toFixed(1)} KB`;}
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * EMRDropzone - File upload component with drag-and-drop support
 *
 * Features:
 * - Drag-and-drop file upload
 * - File type validation
 * - File size validation
 * - Camera capture support
 * - Image preview
 * - Mobile-friendly design
 *
 * @param root0
 * @param root0.onFileSelect
 * @param root0.accept
 * @param root0.maxSize
 * @param root0.showCamera
 * @param root0.preview
 * @param root0.onRemove
 * @param root0.disabled
 * @param root0.title
 * @param root0.description
 * @param root0.'data-testid'
 * @example
 * ```tsx
 * <EMRDropzone
 *   onFileSelect={(file) => handleFileSelect(file)}
 *   accept={['image/jpeg', 'image/png']}
 *   maxSize={10 * 1024 * 1024}
 *   showCamera={true}
 * />
 * ```
 */
export function EMRDropzone({
  onFileSelect,
  accept = ['image/jpeg', 'image/png', 'image/webp'],
  maxSize = 10 * 1024 * 1024, // 10MB default
  showCamera = false,
  preview,
  onRemove,
  disabled = false,
  title,
  description,
  'data-testid': testId,
}: EMRDropzoneProps): React.ReactElement {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default values using translations
  const displayTitle = title ?? t('dropzone.defaultTitle');
  const displayDescription = description ?? t('dropzone.defaultDescription');

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) {
      setIsDragActive(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
  };

  const validateFile = (file: File): string | null => {
    // Check file type
    if (accept.length > 0 && !accept.includes(file.type)) {
      const acceptedTypes = accept.map((type) => type.split('/')[1].toUpperCase()).join(', ');
      return t('dropzone.error.invalidType', { types: acceptedTypes });
    }

    // Check file size
    if (file.size > maxSize) {
      return t('dropzone.error.tooLarge', { maxSize: formatFileSize(maxSize) });
    }

    return null;
  };

  const handleFileDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (disabled) {return;}

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }
      setError(null);
      onFileSelect(file);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }
      setError(null);
      onFileSelect(file);
    }
  };

  const handleChooseFile = (): void => {
    fileInputRef.current?.click();
  };

  const handleCameraCapture = (): void => {
    // Set camera capture attribute and trigger file input
    if (fileInputRef.current) {
      fileInputRef.current.setAttribute('capture', 'environment');
      fileInputRef.current.click();
    }
  };

  const handleRemove = (): void => {
    setError(null);
    onRemove?.();
  };

  // Show preview mode if preview data exists
  if (preview) {
    return (
      <div className={styles.previewContainer} data-testid={testId}>
        <div className={styles.previewCard}>
          <img loading="lazy" src={preview.url} alt={preview.name} className={styles.previewImage} />
          <div className={styles.previewInfo}>
            <p className={styles.previewName}>{preview.name}</p>
            {preview.size != null && preview.size > 0 && <p className={styles.previewSize}>{formatFileSize(preview.size)}</p>}
          </div>
          <button
            type="button"
            onClick={handleRemove}
            disabled={disabled}
            className={styles.removeButton}
            aria-label={t('dropzone.removeFile')}
          >
            <IconX size={18} />
          </button>
        </div>
      </div>
    );
  }

  // Get accepted file extensions for display
  const acceptedExtensions = accept
    .map((type) => type.split('/')[1].toUpperCase())
    .join(', ');

  return (
    <div
      className={`${styles.dropzone} ${isDragActive ? styles.dragActive : ''} ${disabled ? styles.disabled : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleFileDrop}
      data-testid={testId}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept={accept.join(',')}
        onChange={handleFileInputChange}
        disabled={disabled}
        className={styles.fileInput}
        aria-label={t('common.fileInput')}
      />

      <div className={styles.dropzoneContent}>
        <IconUpload size={48} className={styles.uploadIcon} stroke={1.5} />

        <h3 className={styles.title}>{displayTitle}</h3>
        <p className={styles.description}>{displayDescription}</p>

        <div className={styles.buttonGroup}>
          <EMRButton variant="primary" onClick={handleChooseFile} disabled={disabled}>
            {t('dropzone.chooseFile')}
          </EMRButton>

          {showCamera && (
            <>
              <span className={styles.orDivider}>{t('common.or')}</span>
              <EMRButton variant="secondary" icon={IconCamera} onClick={handleCameraCapture} disabled={disabled}>
                {t('dropzone.takePhoto')}
              </EMRButton>
            </>
          )}
        </div>

        <p className={styles.info}>
          {acceptedExtensions} • {t('dropzone.upTo')} {formatFileSize(maxSize)}
        </p>

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  );
}

export default EMRDropzone;
