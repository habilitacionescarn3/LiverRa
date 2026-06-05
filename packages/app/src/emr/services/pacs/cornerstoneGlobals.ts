// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

export interface CS3DAnnotationStyle {
  color?: string;
  lineWidth?: number;
  lineDash?: number[];
}

export interface CS3DAnnotationData {
  style?: CS3DAnnotationStyle;
  [key: string]: unknown;
}

export interface CS3DAnnotation {
  annotationUID?: string;
  data?: CS3DAnnotationData;
  metadata?: Record<string, unknown>;
  toolName?: string;
}

export interface CS3DAnnotationState {
  getAnnotation: (uid: string) => CS3DAnnotation | undefined;
  getAllAnnotations: () => CS3DAnnotation[];
  addAnnotation: (annotation: unknown) => void;
}

export interface CS3DViewport {
  render: () => void;
}

export interface CS3DRenderingEngine {
  getViewports: () => CS3DViewport[];
}

export interface CS3DToolsGlobal {
  annotation?: {
    state?: CS3DAnnotationState;
  };
}

export interface CS3DCoreGlobal {
  getRenderingEngines?: () => CS3DRenderingEngine[];
}

export interface CS3DEventSubscriber {
  eventTarget?: {
    addEventListener?: (type: string, handler: () => void) => void;
    removeEventListener?: (type: string, handler: () => void) => void;
  };
  Enums?: { Events?: Record<string, string> };
}

interface CornerstoneWindowGlobals {
  __cornerstoneTools?: CS3DToolsGlobal;
  __cornerstoneCore?: CS3DCoreGlobal;
  __cornerstoneToolsCore?: CS3DEventSubscriber;
  VideoEncoder?: unknown;
}

export interface CornerstoneGlobals {
  tools?: CS3DToolsGlobal;
  core?: CS3DCoreGlobal;
  events?: CS3DEventSubscriber;
}

export function getCornerstoneGlobals(): CornerstoneGlobals {
  if (typeof window === 'undefined') {
    return {};
  }

  const globals = window as Window & CornerstoneWindowGlobals;
  return {
    tools: globals.__cornerstoneTools,
    core: globals.__cornerstoneCore,
    events: globals.__cornerstoneToolsCore,
  };
}

export function hasWebVideoEncoder(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const globals = window as Window & CornerstoneWindowGlobals;
  return typeof globals.VideoEncoder === 'function';
}
