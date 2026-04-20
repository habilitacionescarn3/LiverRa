// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import type { ComponentType } from 'react';
import { Box, Group, Text, ActionIcon, Stack, Progress } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconCheck } from '@tabler/icons-react';
import styles from './EMRWizardStepper.module.css';

/**
 * Individual step configuration for the wizard
 */
export interface WizardStep {
  /** Unique step identifier */
  key: string;
  /** Step label (shown on mobile) */
  label: string;
  /** Optional short description */
  description?: string;
  /** Step icon component */
  icon: ComponentType<{ size?: number }>;
  /** Whether step is valid/completed */
  isValid?: boolean;
  /** Whether step is optional (skippable) */
  optional?: boolean;
}

export interface EMRWizardStepperProps {
  /** Array of step configurations */
  steps: WizardStep[];
  /** Current active step key */
  currentStep: string;
  /** Callback when step changes */
  onStepChange: (stepKey: string) => void;
  /** Test ID for testing */
  'data-testid'?: string;
}

/**
 * EMRWizardStepper - A mobile-friendly step indicator for wizard flows
 *
 * Features:
 * - Compact progress display (Step 1 of 4)
 * - Navigation arrows for step traversal
 * - Visual progress indicator
 * - Touch-friendly controls (44x44px)
 * - Dark mode support
 *
 * @example
 * ```tsx
 * <EMRWizardStepper
 *   steps={[
 *     { key: 'registration', label: 'Registration', icon: IconClipboardList },
 *     { key: 'insurance', label: 'Insurance', icon: IconShieldCheck, optional: true },
 *     { key: 'demographics', label: 'Demographics', icon: IconMapPin },
 *     { key: 'confirm', label: 'Confirm', icon: IconCheck },
 *   ]}
 *   currentStep="registration"
 *   onStepChange={(key) => setStep(key)}
 * />
 * ```
 */
export function EMRWizardStepper({
  steps,
  currentStep,
  onStepChange,
  'data-testid': testId,
}: EMRWizardStepperProps): React.ReactElement {
  const currentIndex = steps.findIndex((step) => step.key === currentStep);
  const currentStepData = steps[currentIndex];
  const totalSteps = steps.length;
  const progressPercent = ((currentIndex + 1) / totalSteps) * 100;

  const canGoPrevious = currentIndex > 0;
  const canGoNext = currentIndex < totalSteps - 1;

  const handlePrevious = () => {
    if (canGoPrevious) {
      onStepChange(steps[currentIndex - 1].key);
    }
  };

  const handleNext = () => {
    if (canGoNext) {
      onStepChange(steps[currentIndex + 1].key);
    }
  };

  const StepIcon = currentStepData?.icon;

  return (
    <Box className={styles.container} data-testid={testId}>
      {/* Step Navigation Header */}
      <Group className={styles.header} justify="space-between" wrap="nowrap">
        {/* Previous Button */}
        <ActionIcon
          variant="subtle"
          size={44}
          onClick={handlePrevious}
          disabled={!canGoPrevious}
          className={styles.navButton}
          aria-label="Previous step"
        >
          <IconChevronLeft size={24} />
        </ActionIcon>

        {/* Step Info */}
        <Stack gap={2} align="center" className={styles.stepInfo}>
          <Group gap="xs" wrap="nowrap" align="center">
            {StepIcon && (
              <Box className={styles.iconContainer}>
                <StepIcon size={20} />
              </Box>
            )}
            <Text className={styles.stepLabel}>{currentStepData?.label}</Text>
            {currentStepData?.isValid && (
              <Box className={styles.validBadge}>
                <IconCheck size={14} />
              </Box>
            )}
          </Group>
          <Text className={styles.stepCounter}>
            {currentIndex + 1} / {totalSteps}
          </Text>
        </Stack>

        {/* Next Button */}
        <ActionIcon
          variant="subtle"
          size={44}
          onClick={handleNext}
          disabled={!canGoNext}
          className={styles.navButton}
          aria-label="Next step"
        >
          <IconChevronRight size={24} />
        </ActionIcon>
      </Group>

      {/* Progress Bar */}
      <Progress
        value={progressPercent}
        size="xs"
        className={styles.progressBar}
        color="blue"
        aria-label={`Step ${currentIndex + 1} of ${totalSteps}`}
      />

      {/* Step Dots Navigation */}
      <Group className={styles.dotsContainer} justify="center" gap="xs">
        {steps.map((step, index) => (
          <Box
            key={step.key}
            className={`${styles.dot} ${
              index === currentIndex ? styles.dotActive : ''
            } ${index < currentIndex || step.isValid ? styles.dotCompleted : ''}`}
            onClick={() => onStepChange(step.key)}
            role="button"
            tabIndex={0}
            aria-label={`Go to step ${index + 1}: ${step.label}`}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onStepChange(step.key);
              }
            }}
          />
        ))}
      </Group>
    </Box>
  );
}

export default EMRWizardStepper;
