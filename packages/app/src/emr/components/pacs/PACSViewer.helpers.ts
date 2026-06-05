// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

export const FLEX_COLUMN_STYLE = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column' as const,
  minWidth: 0,
  minHeight: 0,
} as const;

export const FLEX_ROW_MIN_HEIGHT_STYLE = {
  flex: 1,
  display: 'flex',
  minHeight: 0,
} as const;

export const BUTTON_MARGIN_TOP_STYLE = {
  marginTop: '12px',
  whiteSpace: 'nowrap' as const,
  flexShrink: 0,
} as const;

// Image IDs look like:
// wadors:{baseUrl}/studies/{studyUid}/series/{seriesUid}/instances/{sopUid}/frames/{frame}
export function extractSeriesUidFromImageId(imageId: string): string | undefined {
  const match = imageId.match(/\/series\/([^/]+)/);
  return match?.[1];
}
