// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

// Re-export shim for MediMind-ported PACS code that imports the client hook
// from `hooks/pacs/`. The ROOT hook at `hooks/useDicomWebClient.ts` is the
// canonical implementation (Cognito token + tenant wiring) — do not add
// logic here.
export { useDicomWebClient } from '../useDicomWebClient';
