# Merge Template — Unified Research Brief

When merging the 6 agent outputs into one document, use this structure. Fill sections from the corresponding agent's findings. The goal is a document detailed enough that someone can write a complete feature spec from it.

---

```markdown
# Research Brief: {Feature Name}

*Generated: {date} | Agents: 6 | Angles: {list of 6 angles used}*

---

## Executive Summary

[3-5 sentences synthesizing the most important findings across ALL agents. What is this feature, what's the recommended approach, what are the key decisions, and what are the biggest risks?]

---

## 1. Existing Codebase Patterns

*Source: Codebase Patterns agent*

### Similar Features Already Built
[Table of similar features with file paths and reuse potential]

### Reusable Components
[Components that can be used directly or adapted, with paths]

### Reusable Services & Hooks
[Services and hooks that handle similar logic, with paths]

### Existing Types & Constants
[Relevant type definitions and FHIR constants already defined]

### Conventions to Follow
[Naming patterns, file structure, state management approaches observed]

---

## 2. Data Model & FHIR Resources

*Source: Data Model agent*

### Resource Map
[Table of FHIR resources needed: type, purpose, key fields]

### Field Mappings
[Detailed field-by-field mapping for each resource]

### Extensions & Identifiers
[Custom extensions needed, new identifier systems]

### Search Parameters
[How data will be queried]

### Resource Relationships
[How resources reference each other]

---

## 3. UI/UX Design Direction

*Source: UI/UX agent*

### User Workflow
[Step-by-step user journey]

### Competitor Analysis
[How leading systems approach this — table with strengths/weaknesses]

### Recommended Layout
[Layout structure, key components, interaction patterns]

### Mobile & Accessibility
[Responsive strategy, touch targets, WCAG considerations]

---

## 4. Technical Architecture

*Source: Architecture agent*

### Component Architecture
[What components, how they nest]

### Service & Hook Design
[What services/hooks needed, responsibilities]

### State Management
[Where state lives, how it flows]

### API Patterns
[What API calls, caching, pagination]

### Libraries & Dependencies
[Any new packages needed, with justification]

### Performance Strategy
[What to watch for, optimization approaches]

---

## 5. Security & Compliance

*Source: Security agent*

### Data Sensitivity Classification
[What data is PHI, what needs encryption]

### Access Control Matrix
[Who can do what — role/permission table]

### Validation Requirements
[Input validation rules]

### Audit Requirements
[What actions must be logged]

### Security Risks & Mitigations
[Risk table with severity and prevention]

---

## 6. Industry Context

*Source: Industry / Workflow / Integration agent (whichever was the 6th angle)*

### Standard Workflow
[How this works in clinical practice]

### Industry Standards
[HL7, IHE, or other relevant standards]

### How Leading Systems Do It
[Comparison table]

### Common Pitfalls
[What implementations get wrong]

---

## Cross-Cutting Insights

*Synthesized from multiple agents — this is where the value of 6 parallel investigations shows*

### Reinforcing Findings
[Where multiple agents independently reached the same conclusion — these are high-confidence findings]

### Conflicts & Trade-offs
[Where agents disagreed or where there's a genuine trade-off to decide]

### Unexpected Connections
[Insights that emerge from combining findings across angles]

---

## Risks & Mitigations Summary

[Combined risk table from all agents, deduplicated and sorted by severity]

| # | Risk | Source | Severity | Mitigation |
|---|------|--------|----------|-----------|
| 1 | [risk] | [which agent found it] | Critical/High/Medium/Low | [mitigation] |

---

## Open Questions

[Combined from all agents — things that need user/stakeholder input before spec creation]

1. [Question] — *Context: [why this matters]*
2. [Question] — *Context: [why this matters]*

---

## Recommended Implementation Order

[Based on combined findings — what to build first and why]

1. **[First]** — [why first: foundation, dependency, risk reduction]
2. **[Second]** — [depends on #1 because...]
3. **[Third]** — ...

---

## Sources

### Codebase Files Referenced
[All file paths mentioned across agents]

### External Sources
[All URLs consulted, grouped by topic]
```

---

## Merge Quality Checklist

Before saving the final brief, verify:

- [ ] Executive Summary captures the essence from all 6 angles
- [ ] No section is empty (if an agent found nothing, note "No significant findings — [reason]")
- [ ] All file paths from codebase agent are preserved
- [ ] All URLs from web-searching agents are preserved
- [ ] Cross-Cutting Insights section has genuine synthesis (not just a repeat of individual findings)
- [ ] Risks are deduplicated (two agents may find the same risk)
- [ ] Open Questions are actionable (someone can answer them)
- [ ] Implementation Order reflects dependencies found across multiple agents
- [ ] Document is detailed enough to write a feature spec from — if a spec writer would need to research more, the brief is incomplete
