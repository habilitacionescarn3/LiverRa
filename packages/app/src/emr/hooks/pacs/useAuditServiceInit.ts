// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// useAuditServiceInit — initialise the PACS audit service singleton once
// ============================================================================
// All logStudy*/logAnnotation* calls require the audit service to be wired
// up with a FHIR client. This hook performs that one-time init and never
// re-runs even if `fhir` is reassigned (the singleton is process-global).
//
// Extracted from PACSViewer.tsx (PACS-H10).
//
// LiverRa adaptation: MedplumClient → LiverRaFhirClient, and because the
// LiverRa FHIR client carries no signed-in profile (MedplumClient did), the
// hook also pushes the current Cognito user into setAuditPrincipal so every
// AuditEvent's agent block carries a non-empty identity.
// ============================================================================

import { useEffect, useRef } from 'react';
import type { LiverRaFhirClient } from '../../services/fhirClient';
import { initAuditService } from '../../services/pacs';
import { setAuditPrincipal } from '../../services/pacs/auditService';
import { useAuth } from '../../services/auth';

export function useAuditServiceInit(fhir: LiverRaFhirClient): void {
  const { user } = useAuth();
  const auditInitRef = useRef(false);
  useEffect(() => {
    if (!auditInitRef.current) {
      initAuditService(fhir);
      auditInitRef.current = true;
    }
  }, [fhir]);

  // Keep the audit principal in sync with the signed-in Cognito user so the
  // AuditEvent agent block is populated (auditService falls back to an
  // anonymous agent when the principal is null).
  useEffect(() => {
    setAuditPrincipal(
      user
        ? {
            resourceType: 'Practitioner',
            id: user.id,
            displayName: user.name ?? user.email ?? undefined,
          }
        : null
    );
  }, [user]);
}
