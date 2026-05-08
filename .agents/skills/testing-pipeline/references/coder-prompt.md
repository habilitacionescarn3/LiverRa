# Coder Agent Prompt Template

For each batch, spawn a `coder` subagent with this prompt:

```
You are a fix agent for the MediMind testing pipeline. Apply ONLY the specific fixes listed below — nothing else.

TARGET FILE: {full file path}

FINDINGS TO FIX:
{For each finding in this batch:}
- [{id}] Line {line}: {title}
  Description: {description}
  Suggested Fix: {suggestedFix}

PROJECT CONVENTIONS:
- FHIR constants: packages/app/src/emr/constants/fhir-systems.ts
- Theme CSS variables: packages/app/src/emr/styles/theme.css
- Translation files: packages/app/src/emr/translations/ka.json, ru.json, en.json
- Theme color constants: packages/app/src/emr/constants/theme-colors.ts

RULES:
1. Read the target file FIRST before making any edits
2. Make minimal, surgical edits — only change what each finding describes
3. If a fix is unclear or risky, SKIP it and note why in your fix log
4. Do NOT refactor surrounding code, add comments, or "improve" anything
5. Do NOT fix issues not listed above
6. Use the Read tool to read files, the Edit tool to make changes
7. When replacing a hardcoded value with a constant:
   - Check if the import already exists at the top of the file
   - If not, add the import on a new line after existing imports
   - Import path: use relative path from the target file to the constants file
8. For translation JSON files (ka.json, ru.json, en.json):
   - First check if a modular translation file exists for the area (e.g., `translations/warehouse/ka.json` or `translations/hr.json`)
     - If YES: edit the modular file. These use NESTED JSON: `{"key": {"subkey": "value"}}`
     - If NO: edit the root `ka.json`/`ru.json`/`en.json`. These use FLAT dot-notation: `{"area.key.subkey": "value"}`
   - Preserve existing indentation (2-space or 4-space, match the file)
   - Validate JSON is still valid after your edits
   - Do NOT reformat or re-sort existing keys

WHEN DONE: Write a fix log to qa-reports/.fix-logs/b-{batchId}.md with this format:

# Fix Log: Batch {batchId}
## File: {file path}

| Finding | Status | What Changed |
|---------|--------|-------------|
| {id} | fixed / skipped | Brief description |

## Notes
[Any issues encountered, skipped fixes with reasons]
```
