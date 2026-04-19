# LiverRa Documentation Index

## Pre-Implementation Research Archive

Curated output from the pre-implementation research phase (April 2026). These documents consolidate findings from 8 parallel deep-research agents and represent the decision-grade consensus that informs LiverRa's product, technical, regulatory, and commercial strategy.

**Read order for a new contributor:**

1. Start with `research/00-executive-brief.md` — one-page verdict + go/no-go conditions
2. Then `research/10-mvp-strategy.md` — what we're actually building in v1
3. Then `research/11-model-and-dataset-choices.md` — exact model stack + dataset licensing
4. Then `research/07-technical-architecture.md` — infrastructure + deployment
5. Reference others as relevant to your task

## Documents

### Core Decision Documents
- [`research/00-executive-brief.md`](research/00-executive-brief.md) — Consolidated verdict + conditional go/no-go
- [`research/10-mvp-strategy.md`](research/10-mvp-strategy.md) — Zero-training cascaded pipeline plan
- [`research/11-model-and-dataset-choices.md`](research/11-model-and-dataset-choices.md) — Apache 2.0 model stack + dataset licensing discipline
- [`research/12-spec-input-prompt.md`](research/12-spec-input-prompt.md) — Ready-to-paste for `/speckit.specify`

### Technical & Regulatory
- [`research/02-regulatory-pathway.md`](research/02-regulatory-pathway.md) — CE MDR Class IIb + FDA 510(k)
- [`research/04-ml-feasibility.md`](research/04-ml-feasibility.md) — Per-capability maturity + benchmarks
- [`research/05-clinical-validation.md`](research/05-clinical-validation.md) — MRMC study design + LI-RADS
- [`research/07-technical-architecture.md`](research/07-technical-architecture.md) — Hybrid edge/cloud, AWS, stack

### Business & Market
- [`research/01-pitch-deck-analysis.md`](research/01-pitch-deck-analysis.md) — Pitch deck evaluation
- [`research/03-competitive-landscape.md`](research/03-competitive-landscape.md) — 20+ competitors mapped
- [`research/06-business-model.md`](research/06-business-model.md) — Pricing, reimbursement, unit economics
- [`research/08-market-sizing-funding.md`](research/08-market-sizing-funding.md) — TAM/SAM/SOM + funding comps
- [`research/09-gtm-partnerships.md`](research/09-gtm-partnerships.md) — KOL strategy, conferences, marketplaces

### Constitution Draft
- [`CONSTITUTION-DRAFT.md`](CONSTITUTION-DRAFT.md) — Answer sheet for `/speckit.constitution`

## How to Use This Archive

### For `/speckit.constitution` (first command to run in LiverRa)
Open `CONSTITUTION-DRAFT.md`. As the command asks clarifying questions, reference the 10 draft principles. **Do not paste the entire document at once — answer interactively.**

### For `/speckit.specify` (first feature — zero-training MVP)
Open `research/12-spec-input-prompt.md`. Copy the prompt block (between the triple-hash fences) and paste into `/speckit.specify`. It references the other research docs by file path, so the spec generator will read them as needed.

### For `/speckit.plan` and `/speckit.tasks`
These commands read the constitution + spec + relevant research docs automatically. If you're writing a plan that needs architectural context, point it at `research/07-technical-architecture.md`. If it needs regulatory context, `research/02-regulatory-pathway.md`. If it needs ML decisions, `research/11-model-and-dataset-choices.md`.

### For later features
- Feature 002 (edge appliance + PACS integration): see `research/07-technical-architecture.md` § MediMind reusable components
- Feature 003 (auth + multi-tenancy): spec-driven; reference `research/06-business-model.md` for market tier definitions
- Feature 004 (clinical validation study setup): deep reference in `research/05-clinical-validation.md`

## What's NOT In This Archive

- Original research transcripts (~50,000 words across 8 agents) — consolidated down to ~15,000 here
- Pitch deck slides themselves (private, not committed to git)
- Founder's personal network / KOL contact details (private)
- Financial projections spreadsheet (private)

## Versioning

Version 1.0 — initial archive (April 2026). When strategy evolves, update these docs (with git history preserving the evolution). Regulators will value the paper trail.

## Next Steps

1. Run `/speckit.constitution` in LiverRa root
2. Run `/speckit.specify` with prompt from `research/12-spec-input-prompt.md`
3. Run `/upgradeSpec` to harden first draft
4. Run `/speckit.plan` → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement`
