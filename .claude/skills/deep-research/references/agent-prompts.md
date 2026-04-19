# Agent Prompt Templates

Use these templates to construct the prompt for each research agent. Fill in the `{placeholders}` with actual values.

## Universal Preamble (include in every agent prompt)

```
You are researching: {full topic description}

Your specific research angle: {angle name}
Your focus: {angle description — what specifically to investigate}

IMPORTANT RULES:
- Save your findings to: research/.parts/{NN}-{angle-id}.md
- Use the output format specified below — do not use the default Implementation Brief format
- Be thorough and detailed — this research feeds into spec document creation
- Include file paths for every codebase finding
- Include URLs for every external finding
- If you find nothing substantial for a section, say "No significant findings" rather than padding
```

## Per-Angle Prompts

### 01 — Codebase Patterns

```
Research angle: Existing Codebase Patterns
Your job: Find everything in this project that's relevant to building {topic}.

Investigate:
1. SIMILAR FEATURES — Search for features that solve analogous problems. For a queue, look at other queues/lists. For a form, look at other forms. For a dashboard, look at other dashboards.
   - Grep for related keywords across components/, services/, hooks/, views/
   - Read the key files to understand the patterns used

2. REUSABLE COMPONENTS — Check these locations:
   - packages/app/src/emr/components/common/ (EMRModal, EMRButton, etc.)
   - packages/app/src/emr/components/shared/ (form fields, layouts)
   - packages/react/src/ (cross-package components)

3. REUSABLE SERVICES & HOOKS
   - packages/app/src/emr/services/ — how do similar services work?
   - packages/app/src/emr/hooks/ — what custom hooks exist?

4. EXISTING TYPES — packages/app/src/emr/types/

5. TRANSLATION STRUCTURE — packages/app/src/emr/translations/
   - How are modular translation folders organized?

6. ROUTING — How are similar views routed in AppRoutes.tsx, EMRMainMenu, HorizontalSubMenu?

7. FHIR CONSTANTS — packages/app/src/emr/constants/fhir-systems.ts

Output format for research/.parts/01-codebase.md:

# Codebase Pattern Analysis: {topic}

## Similar Features Found
| Feature | Key Files | Pattern | Reuse Potential |
|---------|-----------|---------|-----------------|
| [name] | [paths] | [what pattern it uses] | [direct reuse / adapt / reference only] |

## Reusable Components
[For each: name, path, what it does, how it applies here]

## Reusable Services & Hooks
[For each: name, path, what it does, how it applies here]

## Existing Types
[Relevant type definitions with file paths]

## Translation Patterns
[How translations are organized for similar features]

## Route Patterns
[How similar features are routed]

## FHIR Constants Already Defined
[Relevant identifier systems, extension URLs, code systems]

## Key Conventions Observed
[Patterns that should be followed: naming, file structure, state management approach]
```

### 02 — Data Model & FHIR

```
Research angle: Data Model & FHIR Resources
Your job: Determine the right data model for {topic} using FHIR R4 resources.

Investigate:
1. FHIR RESOURCES — Which FHIR R4 resources are needed? Search hl7.org/fhir/R4/ for:
   - Primary resource(s) for this feature
   - Supporting/referenced resources
   - Required fields per FHIR spec
   - Relevant value sets and code systems

2. EXISTING FHIR USAGE — How does this project already use these resources?
   - Grep the codebase for the resource type names
   - Check fhir-systems.ts for existing identifier systems and extensions
   - Look at how MedplumClient is used to create/search/update these resources

3. EXTENSIONS — Will custom extensions be needed?
   - Check existing extension patterns in fhir-systems.ts
   - Follow the project convention: http://medimind.ge/fhir/StructureDefinition/[name]

4. SEARCH PARAMETERS — What FHIR search parameters will be needed?
   - Standard search params from the spec
   - Custom search patterns used in the project

5. RELATIONSHIPS — How do the resources reference each other?

Output format for research/.parts/02-data-model.md:

# Data Model Research: {topic}

## Primary FHIR Resources
| Resource | Purpose | FHIR Spec Link |
|----------|---------|----------------|
| [type] | [what it stores] | [URL] |

## Resource Field Mapping
[For each resource: key fields, required vs optional, data types, value sets]

### [ResourceType]
| Field | Required | Type | Notes |
|-------|----------|------|-------|
| [field] | Y/N | [type] | [usage notes] |

## Extensions Needed
| Extension Name | URL | Value Type | Purpose |
|---------------|-----|------------|---------|
| [name] | http://medimind.ge/fhir/StructureDefinition/[name] | [type] | [why needed] |

## Identifier Systems
[New identifier systems needed, following existing conventions]

## Search Parameters
| Parameter | Resource | Type | Usage |
|-----------|----------|------|-------|
| [param] | [resource] | [token/reference/date/string] | [when/why to search by this] |

## Resource Relationships
[Diagram or description of how resources reference each other]

## Existing Usage in Codebase
[How these resources are already used, with file paths]
```

### 03 — UI/UX & Design

```
Research angle: UI/UX & Design Patterns
Your job: Research how {topic} should look and behave from a user experience perspective.

Investigate:
1. COMPETITOR UX — How do leading EHR systems (Epic, Cerner, OpenMRS) design this feature?
   - Search for screenshots, demo videos, UX reviews
   - Use WebFetch to read full articles, not just search snippets

2. UX BEST PRACTICES — General best practices for this type of interface
   - Search for "[feature type] UX best practices"
   - Search for "[feature type] design patterns"

3. ACCESSIBILITY — WCAG requirements for this type of interface
   - Keyboard navigation, screen reader, color contrast
   - Touch targets for mobile (min 44x44px per project convention)

4. MOBILE PATTERNS — How should this work on mobile?
   - Responsive layout strategy
   - Touch interactions vs mouse interactions

5. EXISTING PROJECT UI PATTERNS — How do similar views look in this project?
   - Check existing views for layout patterns
   - Note use of Mantine components, theme variables

6. WORKFLOW — What's the user's mental model? What steps do they take?
   - Think about the clinical user's workflow
   - Note status transitions, filters, actions

Output format for research/.parts/03-ui-ux.md:

# UI/UX Research: {topic}

## User Workflow
[Step-by-step: what the user does, in what order, why]

## Competitor Approaches
| System | Approach | Strengths | Weaknesses | Screenshot/Source |
|--------|----------|-----------|------------|-------------------|
| [name] | [how they do it] | [what's good] | [what's bad] | [URL] |

## Recommended Layout & Components
[Description of recommended UI structure, referencing existing project components]

## Key Interaction Patterns
[Filters, sorting, status changes, modals, inline editing — what interactions are needed]

## Mobile Considerations
[How the layout adapts, touch targets, simplified views]

## Accessibility Requirements
[Specific WCAG concerns for this feature type]

## UX Best Practices
1. [Practice] — [Why it matters] — *Source: [URL]*
```

### 04 — Technical Architecture

```
Research angle: Technical Architecture & Libraries
Your job: Research the right technical approach for building {topic}.

Investigate:
1. STATE MANAGEMENT — What state does this feature need?
   - Local component state vs shared context vs URL state
   - How do similar features in this project manage state?

2. REAL-TIME / CACHING — Does this need real-time updates? Caching?
   - Search for how this project handles data freshness
   - Research options: polling, WebSocket, SSE, optimistic updates

3. LIBRARIES — Are there libraries that would help?
   - Search npm/GitHub for relevant packages
   - Check what's already in package.json
   - Evaluate: bundle size, maintenance status, TypeScript support

4. API PATTERNS — What API calls are needed?
   - MedplumClient methods for FHIR operations
   - Any external APIs needed?
   - Batch operations, pagination strategies

5. PERFORMANCE — What could be slow?
   - Large lists: virtualization, pagination
   - Complex calculations: memoization, web workers
   - Bundle size considerations

6. ERROR HANDLING — What error states exist?
   - Network failures, stale data, concurrent edits
   - How does this project handle errors? (search for error patterns)

Output format for research/.parts/04-architecture.md:

# Architecture Research: {topic}

## Recommended Architecture
[High-level description of the approach]

### Component Structure
[What components, how they nest, what each does]

### Service Layer
[What services are needed, what they do]

### Hook Layer
[Custom hooks needed, what state they manage]

## State Management Strategy
[What state, where it lives, how it flows]

## API Patterns
| Operation | Method | Endpoint/Resource | Notes |
|-----------|--------|-------------------|-------|
| [what] | [GET/POST/PUT] | [FHIR resource or API] | [pagination, caching, etc.] |

## Libraries to Consider
| Library | Purpose | Already in Project? | Bundle Size | Recommendation |
|---------|---------|--------------------|----|----------------|
| [name] | [what for] | Y/N | [size] | Use / Skip / Evaluate |

## Performance Considerations
[What could be slow and how to prevent it]

## Error Handling Strategy
[Error states and how to handle each]
```

### 05 — Security & Compliance

```
Research angle: Security & Compliance
Your job: Identify security risks and compliance requirements for {topic}.

Investigate:
1. DATA SENSITIVITY — What data does this feature handle?
   - PHI (Protected Health Information)?
   - Financial data?
   - User credentials?

2. ACCESS CONTROL — Who should see/edit what?
   - Check existing RBAC patterns in the project (permissionService.ts, roleTemplateService.ts)
   - What roles need access? What permissions?

3. INPUT VALIDATION — What user inputs exist?
   - What needs server-side validation?
   - What FHIR validation applies?

4. AUDIT TRAIL — What actions need logging?
   - HIPAA audit requirements for this type of data
   - Existing audit patterns in the project

5. COMMON VULNERABILITIES — What could go wrong?
   - Search OWASP for this feature type
   - XSS, injection, broken access control
   - Race conditions with concurrent users

6. REGULATORY — Any specific regulations for this feature?
   - HIPAA requirements
   - Georgian healthcare regulations if applicable

Output format for research/.parts/05-security.md:

# Security & Compliance Research: {topic}

## Data Classification
| Data Element | Sensitivity | PHI? | Encryption Needed? |
|-------------|------------|------|-------------------|
| [field] | High/Medium/Low | Y/N | [notes] |

## Access Control Requirements
| Role | Can View | Can Create | Can Edit | Can Delete |
|------|----------|-----------|----------|-----------|
| [role] | [what] | [what] | [what] | [what] |

## Existing RBAC Patterns
[How permission checks work in this project, with file paths]

## Input Validation Requirements
| Input | Validation Rules | Server-Side? |
|-------|-----------------|-------------|
| [field] | [rules] | Y/N |

## Audit Trail Requirements
[What actions must be logged, existing audit patterns]

## Security Risks
| Risk | Severity | Mitigation |
|------|----------|-----------|
| [risk] | Critical/High/Medium/Low | [how to prevent] |

## Regulatory Requirements
[HIPAA, Georgian regulations, etc.]
```

### 06 — Industry Best Practices

```
Research angle: Industry Best Practices & Standards
Your job: Research how the healthcare industry handles {topic} — standards, workflows, and what leading systems do.

Investigate:
1. CLINICAL WORKFLOW — What's the standard clinical workflow?
   - Search for "{topic} clinical workflow"
   - Search for "{topic} standard operating procedure healthcare"
   - Use WebFetch to read full articles

2. INDUSTRY STANDARDS — Are there HL7/IHE/other standards?
   - Search for "{topic} HL7 standard"
   - Search for "{topic} IHE profile"
   - Check FHIR implementation guides

3. LEADING IMPLEMENTATIONS — How do top EHR vendors do it?
   - Epic, Cerner/Oracle Health, OpenMRS, GNU Health
   - Search for demos, documentation, user guides

4. COMMON PITFALLS — What do implementations get wrong?
   - Search for "{topic} EHR problems"
   - Search for "{topic} implementation challenges healthcare"

5. EMERGING TRENDS — What's the direction?
   - Recent innovations, AI integration, mobile-first approaches

Output format for research/.parts/06-industry.md:

# Industry Research: {topic}

## Standard Clinical Workflow
[Step-by-step clinical workflow as it happens in practice]

## Industry Standards
| Standard | Organization | Relevance | Link |
|----------|-------------|-----------|------|
| [name] | [HL7/IHE/etc.] | [how it applies] | [URL] |

## How Leading Systems Implement This
| System | Approach | Key Features | Source |
|--------|----------|-------------|--------|
| [name] | [approach] | [notable features] | [URL] |

## Common Implementation Pitfalls
1. [Pitfall] — [Why it happens] — [How to avoid]

## Emerging Trends
[What's changing in this space]

## Recommendations for Our Implementation
[What to adopt, what to skip, what to adapt — based on industry findings]
```

### Alternative Angles (use same structure — header, investigate list, output format)

### 07 — Integration

```
Research angle: External Integration Requirements
Focus: API specifications, authentication methods, data formats, error handling, rate limits for any external systems {topic} needs to connect to.

Save to: research/.parts/07-integration.md
```

### 08 — i18n & UX Copy

```
Research angle: Internationalization & UX Copy
Focus: Translation patterns for ka/en/ru, medical terminology accuracy, date/number formatting, existing translation structure in the project.

Save to: research/.parts/08-i18n.md
```

### 09 — Performance & Scale

```
Research angle: Performance & Scalability
Focus: Query optimization, pagination strategies, lazy loading, bundle size impact, caching patterns for data-heavy aspects of {topic}.

Save to: research/.parts/09-performance.md
```

### 10 — Clinical Workflow

```
Research angle: Clinical Workflow Analysis
Focus: Medical workflow standards, clinician expectations, order of operations, status state machines, exception handling in clinical context for {topic}.

Save to: research/.parts/10-workflow.md
```
