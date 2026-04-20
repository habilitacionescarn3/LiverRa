# Test fixtures

This directory holds the small fixtures used by integration/regression
tests. Large binary datasets are **not** committed — they live on a
separate storage mount and are referenced via env var.

## Layout (populated by CI / test runner, not the repo)

```
fixtures/
├── ct-001.zip .. ct-005.zip          # multi-phase CT archives
├── ct-001.nii.gz .. ct-005.nii.gz    # full CT volumes (NIfTI)
├── ct-00N-parenchyma-gt.nii.gz       # hand-curated parenchyma GT
└── golden-responses/
    └── parenchyma/
        └── ct-00N.npy                # pre-computed Triton responses
                                       # (hermetic: keeps tests offline)
```

## Required env vars

- `LIVERRA_GOLDEN_FIXTURES_DIR` → absolute path to the directory that
  contains the files above. If unset, the regression tests are
  skipped (see `tests/regression/test_parenchyma_dice.py`).

## Licensing

All golden CT cases derive from in-house data collected under DPAs with
Geo Hospitals (see `docs/research/05-data-strategy.md`). They are NOT
redistributed outside the test runner; fetching them requires a
signed-off request to the ML team.
