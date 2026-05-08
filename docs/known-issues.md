# LiverRa — Known Issues

A short, regularly-updated list of bugs we are aware of but have intentionally
deferred. Each entry must include reproduction, workaround, and a pointer to
the root cause so a future maintainer can land a real fix.

---

## Cascade analysis stuck at `'running'` for 0-lesion cases

**Status:** Open — workaround documented, root cause identified.

**Symptom:**
For a healthy patient (cascade returns `lesion_count = 0`), the
`analysis.status` row never flips from `running` to `completed`. The UI
shows the case as "Running" indefinitely even though every cascade stage
has actually written its checkpoint.

**Root cause:**
The classification fanout (`detect_lesions → classify_lesions_fanout`) is
modelled as a Celery chord. The chord's body callback is the step that
ultimately writes `status = 'completed'` on the orchestrator's terminal
checkpoint. When `lesion_count == 0` the fanout produces an empty list of
subtasks, and the chord callback's DB-write branch is skipped — leaving
the analysis row's status untouched.

Code path:
`packages/ml-inference/src/orchestrator/cascade.py` — chord-callback
registration around the `classify_lesions_fanout` task body.

**Workaround:**
Manually flip the row:

```sql
UPDATE analysis
   SET status = 'completed',
       completed_at = NOW()
 WHERE id = '<analysis_uuid>';
```

…or, once the UI affordance lands, click "Mark complete" from the analysis
detail page (not yet wired).

**Real fix (out of scope for this PR):**
Make the chord callback always run — even for an empty subtask list — and
unconditionally write the terminal `analysis.status = 'completed'`
checkpoint. Track in a follow-up "orchestrator hardening" pass.
