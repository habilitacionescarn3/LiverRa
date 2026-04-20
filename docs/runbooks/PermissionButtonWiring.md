# PermissionButton + step-up wiring (T451)

**Scope:** cross-cutting wiring instructions for the two non-compliance
components whose submit buttons must trigger a fresh MFA challenge
before the mutation POST lands:

- `packages/app/src/emr/components/report/RetractModal.tsx` (T271)
- `packages/app/src/emr/views/erasure/ErasureWizardView.tsx` (T330)

Phase 12 US10 (compliance dashboard) introduced the pattern for
step-up-guarded mutations in `ClaimRegistryView.tsx`. This runbook
defines the identical wiring for the two pre-existing components —
keeping them aligned without touching the Phase 10/11 backends.

---

## Why this matters

`compliance.toggle_claim_registry`, `report.retract`, and
`erasure.execute` are all flagged `x-step-up: true` in
`contracts/api-openapi.yaml`. The server already enforces step-up on
these routes — if the user's `auth_time` claim is stale, the request
returns `401 step-up-required` and the global `errorClient` dispatches
`liverra:step-up-required` for the `StepUpAuthModal` to pick up.

The *client* must therefore surface the intent visually: the button
renders with a shield icon + "MFA required" tooltip, so the user is
never surprised when Cognito redirects them mid-click.

---

## Required `PermissionButton` API extension

The current `PermissionButton` (`components/access-control/PermissionButton.tsx`)
accepts `permission`, `hiddenIfDenied`, `deniedTooltip`. It must gain:

```ts
export interface PermissionButtonProps extends Omit<EMRButtonProps, 'disabled'> {
  permission: LiverraPermission;
  hiddenIfDenied?: boolean;
  deniedTooltip?: string;
  /** When true, render a shield icon + tooltip signalling that step-up
   *  MFA will be required. The server enforces the check — the prop is
   *  purely a UX affordance. */
  stepUp?: boolean;
  onClick?: () => void;
  children: ReactNode;
}
```

Implementation sketch (inside the existing `PermissionButton` body):

```tsx
if (stepUp) {
  const label = hasPermission
    ? (t('common:stepUp.required') ?? 'Step-up MFA required')
    : (deniedTooltip ?? t('common:permission.accessDenied'));
  const button = (
    <EMRButton
      {...buttonProps}
      disabled={!hasPermission}
      leftSection={<IconShieldLock size={14} aria-hidden="true" />}
      onClick={handleClick}
    >
      {children}
    </EMRButton>
  );
  return (
    <Tooltip label={label} withArrow>
      <span>{button}</span>
    </Tooltip>
  );
}
```

No server changes — the retry flow already works via the errorClient
→ `StepUpAuthModal` → Cognito `prompt=login&max_age=0` round-trip.

---

## Edit 1 — `RetractModal.tsx` (T271)

**File:** `packages/app/src/emr/components/report/RetractModal.tsx`

**Current** (lines 90–101):

```tsx
<PermissionButton
  permission="report.retract"
  color="red"
  disabled={!canSubmit}
  onClick={() => {
    setError(null);
    mutation.mutate(reason.trim());
  }}
  data-testid="retract-modal-submit"
>
  {t('report:retract.confirm') ?? 'Retract'}
</PermissionButton>
```

**Target:** add `stepUp` prop.

```tsx
<PermissionButton
  permission="report.retract"
  stepUp
  color="red"
  disabled={!canSubmit}
  onClick={() => {
    setError(null);
    mutation.mutate(reason.trim());
  }}
  data-testid="retract-modal-submit"
>
  {t('report:retract.confirm') ?? 'Retract'}
</PermissionButton>
```

**Unit test (colocate at `components/report/__tests__/RetractModal.stepup.test.tsx`):**

1. Render the modal with a user who has `report.retract`.
2. Intercept `fetch` to return `401 step-up-required`.
3. Assert the button triggers the `liverra:step-up-required` event before
   the mutation POST would otherwise succeed.

---

## Edit 2 — `ErasureWizardView.tsx` (T330)

**File:** `packages/app/src/emr/views/erasure/ErasureWizardView.tsx`

**Locate** the final-step submit button and wrap it with
`<PermissionButton stepUp permission="erasure.execute">`.

Given the wizard's step pattern, the final step's footer should read:

```tsx
<PermissionButton
  permission="erasure.execute"
  stepUp
  color="red"
  disabled={!isFinalStepValid}
  loading={submitting}
  onClick={handleExecute}
  data-testid="erasure-wizard-execute"
>
  {t('erasure:wizard.execute')}
</PermissionButton>
```

**Unit test (colocate at `views/erasure/__tests__/ErasureWizardView.stepup.test.tsx`):**

1. Advance the wizard through all steps programmatically.
2. Mock `POST /api/v1/erasure/requests` to return `401 step-up-required`
   on the first call, success on the second.
3. Assert the `liverra:step-up-required` event fires before the POST and
   the wizard surfaces the `StepUpAuthModal` challenge.

---

## Existing step-up paths (do not duplicate)

| Component                                         | Task | Status      |
|---------------------------------------------------|------|-------------|
| `ClaimRegistryView.tsx` (save button per claim)   | T349 | Implemented |
| `StepUpAuthModal.tsx` (global prompt receiver)    | T101 | Implemented |
| `PermissionButton` (`stepUp` prop)                | —    | **TODO** — blocks T451 edits |
| `RetractModal.tsx` submit                         | T271 | TODO this runbook |
| `ErasureWizardView.tsx` final-step submit         | T330 | TODO this runbook |

---

## Acceptance

- `PermissionButton` supports `stepUp` boolean prop with shield icon + tooltip.
- `RetractModal.tsx` + `ErasureWizardView.tsx` use `<PermissionButton stepUp>`.
- Unit tests assert the `liverra:step-up-required` event fires before the
  mutation POST on a stale-auth response.
- No backend changes — server-side step-up guard remains the source of truth.

**Spec refs:** FR-032, plan §Step-up & freshness, research §X.3, T271, T330, T349, T451.
