// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

import type { ComponentType } from 'react';
import React from 'react';
import { Box, Text, Group, Stack, Badge, Loader } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import styles from './EMRProgressStepper.module.css';

export interface EMRProgressStepperProps {
  steps: {
    key: string;
    label: string;
    description?: string;
    icon: ComponentType<{ size?: number }>;
  }[];
  currentStep: string;
  progress?: number; // 0-100
  error?: boolean;
  errorMessage?: string;
  'data-testid'?: string;
}

export function EMRProgressStepper({
  steps,
  currentStep,
  progress,
  error,
  errorMessage,
  'data-testid': testId,
}: EMRProgressStepperProps): React.ReactElement {
  const currentStepIndex = steps.findIndex((step) => step.key === currentStep);

  const getStepState = (index: number): 'completed' | 'active' | 'pending' | 'error' => {
    if (error && index === currentStepIndex) {
      return 'error';
    }
    if (index < currentStepIndex) {
      return 'completed';
    }
    if (index === currentStepIndex) {
      // If at last step AND progress is 100%, show as completed (workflow done)
      const isLastStep = index === steps.length - 1;
      if (isLastStep && progress === 100) {
        return 'completed';
      }
      return 'active';
    }
    return 'pending';
  };

  return (
    <Box className={styles.container} data-testid={testId}>
      {/* Steps */}
      <Group className={styles.stepsContainer} wrap="nowrap" gap={0}>
        {steps.map((step, index) => {
          const state = getStepState(index);
          const StepIcon = step.icon;
          const isLast = index === steps.length - 1;

          return (
            <Box key={step.key} className={styles.stepWrapper}>
              <Stack className={styles.step} gap={8} align="center">
                {/* Icon Circle */}
                <Box className={`${styles.iconCircle} ${styles[state]}`}>
                  {state === 'completed' ? (
                    <IconCheck size={20} />
                  ) : state === 'active' ? (
                    <Loader size={18} color="white" />
                  ) : (
                    <StepIcon size={20} />
                  )}
                </Box>

                {/* Label */}
                <Text className={styles.label} ta="center">
                  {step.label}
                </Text>

                {/* Description */}
                {step.description && (
                  <Text className={styles.description} ta="center">
                    {step.description}
                  </Text>
                )}
              </Stack>

              {/* Connector Line */}
              {!isLast && (
                <Box
                  className={`${styles.connector} ${
                    index < currentStepIndex ? styles.connectorCompleted : styles.connectorPending
                  }`}
                />
              )}
            </Box>
          );
        })}
      </Group>

      {/* Progress Bar */}
      {progress !== undefined && (
        <Box className={styles.progressContainer}>
          <Box className={styles.progressBar}>
            <Box className={styles.progressFill} style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
          </Box>
          <Badge className={styles.progressBadge} variant="filled">
            {Math.round(progress)}%
          </Badge>
        </Box>
      )}

      {/* Error Message */}
      {error && errorMessage && (
        <Box className={styles.errorContainer}>
          <Badge className={styles.errorBadge} variant="filled">
            Processing Error
          </Badge>
          <Text className={styles.errorMessage}>{errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
