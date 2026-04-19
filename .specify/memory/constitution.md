<!--
SYNC IMPACT REPORT
==================
Version Change: 1.0.0 → 1.1.0
Rationale: MINOR - Added two new principles (VIII, IX) and expanded FHIR Conformance
Modified Principles:
  - None renamed or removed
Added Sections:
  - Principle VIII: Unified Design System
  - Principle IX: Internationalization & Localization
  - FHIR Conformance: MediMind-specific conventions (base URL, identifiers, extensions)
Removed Sections: None
Templates Status:
  ✅ plan-template.md - Reviewed, constitution check section aligns
  ✅ spec-template.md - Reviewed, requirements structure compatible
  ✅ tasks-template.md - Reviewed, task categorization aligns
  ✅ checklist-template.md - Reviewed, quality dimensions cover new principles
Follow-up TODOs: None
-->

# Medplum MediMind Constitution

## Core Principles

### I. FHIR-First Architecture
All healthcare data operations MUST follow the FHIR R4 specification. Resources MUST be strongly typed using `@medplum/fhirtypes`. Server implementations MUST provide full FHIR REST API with search, CRUD, and operations support.

**Rationale**: FHIR compliance ensures interoperability with healthcare systems and standardizes data exchange across the platform.

### II. Package-Based Modularity
Every feature MUST be implemented as an independently versioned package within the monorepo. Packages MUST have clear boundaries with explicit dependencies declared in package.json. Core package MUST NOT depend on other Medplum packages.

**Rationale**: Modular architecture enables independent testing, versioning, and reuse across different deployment contexts (browser, Node.js, Lambda).

### III. Test-First Development (NON-NEGOTIABLE)
All code changes MUST include tests before implementation. Tests MUST be colocated with source code (`filename.test.ts` next to `filename.ts`). Server tests MUST run against a test database. Mock implementations MUST be provided via `@medplum/mock` for client testing.

**Rationale**: Healthcare applications require high reliability. Test-first development catches errors early and ensures regression protection.

### IV. Type Safety & Strict Mode
TypeScript strict mode MUST be enabled across all packages. All FHIR resources MUST use generated types from `@medplum/fhirtypes`. Public APIs MUST have explicit type definitions with no use of `any` without justification.

**Rationale**: Type safety prevents runtime errors in healthcare-critical code paths and improves developer experience through IDE support.

### V. Security & Compliance by Default
All authentication MUST use OAuth 2.0/OpenID Connect/SMART-on-FHIR protocols. Access control MUST be enforced through AccessPolicy resources. All database operations MUST use parameterized queries. Secrets MUST NOT be committed to version control.

**Rationale**: Healthcare data is highly sensitive and regulated. Security must be built into the foundation, not added as an afterthought.

### VI. Build Order & Dependency Management
Package build order MUST respect dependency hierarchy: core → fhirtypes → definitions → everything else. Turborepo MUST handle build orchestration. Internal packages MUST use workspace references (e.g., `@medplum/core`).

**Rationale**: Ensures reproducible builds and prevents circular dependencies in the monorepo structure.

### VII. Observability & Debugging
All server operations MUST include structured logging. WebSocket connections MUST support real-time debugging. Database queries MUST be traceable through query logging. Error messages MUST include actionable context.

**Rationale**: Healthcare systems require detailed audit trails and quick troubleshooting capabilities.

### VIII. Unified Design System
All UI components MUST use CSS variables from `theme.css` — colors, typography, and spacing MUST NOT be hardcoded. All modals MUST use `EMRModal`. All buttons MUST use the primary gradient (`linear-gradient(135deg, #1a365d, #2b6cb0, #3182ce)`). Forbidden Tailwind/external colors (e.g., `#3b82f6`, `#60a5fa`) MUST NOT appear in any file. Dark mode MUST be handled exclusively by `theme.css` auto-switching variables — component-level dark overrides are forbidden. All interactive elements MUST have minimum 44x44px tap targets. UI MUST be styled mobile-first, enhanced with `@media (min-width: ...)`.

**Rationale**: A single source of truth for visual design prevents inconsistency across 1,300+ component files and ensures both light/dark modes work correctly without per-component overrides.

### IX. Internationalization & Localization
All user-facing strings MUST use the `useTranslation()` hook — hardcoded UI text is forbidden. Translation files MUST be maintained for Georgian (`ka.json`), English (`en.json`), and Russian (`ru.json`). Medical terminology MUST be translated accurately with domain-expert review. New features MUST include translation keys for all three languages before merging.

**Rationale**: MediMind serves the Georgian healthcare market where staff use Georgian, English, and Russian. Hardcoded strings break the multilingual experience and prevent localization.

## Healthcare & Compliance Standards

### HIPAA Compliance Requirements
- All PHI (Protected Health Information) MUST be encrypted at rest and in transit
- Audit logs MUST be maintained for all data access operations
- User authentication MUST support multi-factor authentication (MFA)
- Data retention policies MUST be configurable per project
- Breach notification procedures MUST be documented

### FHIR Conformance
- All resource operations MUST validate against FHIR R4 schema
- Search parameters MUST conform to FHIR search specification
- CapabilityStatement MUST accurately reflect server capabilities
- Extensions MUST follow FHIR extension guidelines
- Base URL for all MediMind extensions MUST be `http://medimind.ge/fhir`
- Extension URLs MUST follow `http://medimind.ge/fhir/StructureDefinition/[name]`
- Identifier systems MUST use constants from `fhir-systems.ts` — hardcoded URL strings are forbidden
- FHIR references MUST include the `reference` field (display-only references are invalid)
- Search parameter prefixes (`ge`, `le`, `gt`, `lt`) MUST be placed on the value, not the key

### Data Migration & Versioning
- Database migrations MUST use transaction wrappers
- Migrations MUST be reversible where possible
- Schema changes MUST maintain backward compatibility for at least one version
- Breaking changes MUST be announced with migration path documentation

## Development Workflow

### Code Review Requirements
- All PRs MUST pass automated tests (Jest/Vitest)
- All PRs MUST pass linting and formatting checks (ESLint, Prettier)
- At least one approving review required for changes to core packages
- Security-sensitive changes require additional security team review

### Testing Gates
- Unit tests MUST achieve >80% code coverage for new code
- Integration tests required for FHIR endpoint changes
- End-to-end tests required for user-facing workflow changes
- Performance regression tests required for database schema changes

### Deployment Standards
- Server deployments MUST run database migrations before code deployment
- Breaking API changes MUST be versioned with deprecation notices
- Redis cache MUST be cleared for subscription logic changes
- Health check endpoints MUST verify database and Redis connectivity

### Documentation Requirements
- New FHIR resources MUST include usage examples
- React components MUST include Storybook stories
- API changes MUST update corresponding documentation in `packages/docs`
- Breaking changes MUST be documented in CHANGELOG.md

## Governance

This constitution supersedes all other development practices within the Medplum MediMind project. All pull requests and code reviews MUST verify compliance with these principles.

### Amendment Process
1. Proposed amendments MUST be submitted as a PR to `.specify/memory/constitution.md`
2. Amendment rationale MUST be documented in PR description
3. Template consistency impacts MUST be assessed and addressed
4. Approval requires consensus from project maintainers
5. Migration plan MUST be provided for breaking governance changes

### Version Increment Rules
- **MAJOR**: Backward incompatible governance changes, principle removals/redefinitions
- **MINOR**: New principles added, materially expanded guidance
- **PATCH**: Clarifications, wording improvements, non-semantic refinements

### Compliance Review
- Constitution compliance MUST be checked during PR review
- Complexity violations MUST be justified with alternatives documented
- New principles MUST include enforcement mechanisms
- Annual review MUST assess principle effectiveness and relevance

### Runtime Development Guidance
For day-to-day development guidance, refer to `.claude/CLAUDE.md` which provides specific commands, troubleshooting steps, and common task patterns.

**Version**: 1.1.0 | **Ratified**: 2025-11-11 | **Last Amended**: 2026-03-10
