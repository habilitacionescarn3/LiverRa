---
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(find:*), Bash(wc:*), Bash(ls:*), Read, Edit, Glob, Grep
description: Automatically update CLAUDE.md file based on recent code changes
---

# Update CLAUDE.md - Focused & Minimal

## Reference Current State
@CLAUDE.md

## Quick Git Analysis
!`git log --oneline -5`
!`git diff --name-status HEAD~5 | grep -E "^[AD]" | head -20`

## Your Task

Update CLAUDE.md with ONLY essential changes. Follow these strict rules:

### RULES - What to ADD:
1. **New major features** (new views/, services/, hooks/ directories)
2. **New routes** (only main routes like `/emr/new-feature`)
3. **New FHIR resources** being used
4. **New translation modules** added
5. **Breaking changes** that affect development

### RULES - What to NEVER ADD:
1. Individual component files (just note "60+ components" not each file)
2. Individual translation keys (just note "200+ keys")
3. CSS/style file changes
4. Test files
5. Screenshot files
6. Minor bug fixes
7. Refactoring details
8. Implementation details that don't affect how to USE the code

### RULES - Format:
1. **File structure trees**: Max 10 lines per section, use `...` for more
2. **Recent Changes**: Max 6 bullet points per date, one line each
3. **Keep older changes condensed**: Anything older than 2 weeks = max 2 lines
4. **Total file**: Should stay under 1200 lines

### RULES - What to UPDATE vs ADD:
- If a section already exists (e.g., Laboratory), UPDATE it don't duplicate
- If feature is documented, just update the status (e.g., "Status: Active Development" → "Status: Production Ready")
- Merge similar entries (don't have 5 entries about the same feature)

### Update Process:

1. **Check what's new** in git diff
2. **Identify which EXISTING sections** need minor updates
3. **Only create NEW sections** for genuinely new major features
4. **Condense Recent Changes** older than 2 weeks
5. **Remove redundant/duplicate information**

### Section Templates:

**For a new major feature (only if truly new):**
```
## Feature Name

**Status:** Active/Production | **FHIR:** Resource1, Resource2 | **Route:** `/emr/feature`

**Key Files:** `views/feature/`, `services/featureService.ts`, `hooks/useFeature.ts`

**Key Types:** Type1, Type2, Type3
```

**For Recent Changes (today's date):**
```
## Recent Changes (YYYY-MM-DD)

- **Feature Name:** Brief one-line description
- **Another Change:** Brief one-line description
```

### Final Check Before Saving:

1. Is the file still under 1200 lines? If not, condense more.
2. Did you add any individual file names that aren't critical? Remove them.
3. Are there duplicate descriptions of the same feature? Merge them.
4. Are Recent Changes sections older than 1 month? Delete them, info should be in main sections.

## Output

Edit CLAUDE.md directly with minimal, focused updates. Do NOT rewrite entire sections unless necessary.
