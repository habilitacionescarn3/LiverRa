---
name: deep-research
description: Launch 6 parallel deep-research agents to comprehensively investigate a feature or topic before building it. Each agent tackles a different research angle (codebase patterns, data model, UI/UX, architecture, security, industry practices) — angles are dynamically chosen based on the topic. Produces a single merged Research Brief that feeds directly into spec document creation. Use this skill whenever the user says "research [feature]", "investigate [topic]", "deep research [anything]", "what do I need to know to build [X]", or before starting any significant new feature. Also trigger when the user wants comprehensive pre-implementation research, competitive analysis, or technology evaluation for the MediMind EMR project.
---

# Deep Research — 6-Agent Parallel Investigation

You are the orchestrator for comprehensive pre-implementation research. When invoked, you launch 6 specialized research agents in parallel — each investigating a different angle of the same topic — then merge their findings into one unified Research Brief that feeds into spec document creation.

**Analogy:** Like sending 6 expert consultants to investigate a building project simultaneously — one checks the site (codebase), one studies blueprints (data model), one surveys similar buildings (industry), one checks safety codes (security), one plans the interior (UI/UX), and one evaluates materials (architecture). They all report back, and you compile their findings into one comprehensive feasibility study.

## Usage

```
/deep-research <topic or feature description>
```

**Examples:**
- `/deep-research pharmacy queue for medication dispensing`
- `/deep-research MAR (Medication Administration Record) system`
- `/deep-research real-time bed status notifications`
- `/deep-research appointment scheduling with calendar integration`
- `/deep-research patient portal lab results viewer`

---

## Step 1: Analyze the Topic & Choose 6 Research Angles

Before launching agents, analyze the topic to pick the most valuable 6 research angles. Not every topic needs the same angles.

### Default Angle Pool (pick 6 from these)

| ID | Angle | Best For | What It Investigates |
|----|-------|----------|---------------------|
| `codebase` | Codebase Patterns | Always useful | Similar features in this project, reusable components/services/hooks/types, existing conventions |
| `data-model` | Data Model & FHIR | Features storing/querying data | FHIR resources, extensions, identifiers, search parameters, data relationships |
| `ui-ux` | UI/UX & Design | Features with user interfaces | How leading systems design this, layout patterns, accessibility, mobile, interaction flows |
| `architecture` | Technical Architecture | Complex features | Libraries, state management, caching, real-time updates, performance, scalability |
| `security` | Security & Compliance | Clinical/financial features | HIPAA, RBAC, input validation, audit trails, data exposure risks |
| `industry` | Industry Best Practices | Domain-specific features | How Epic/Cerner/OpenMRS implement this, clinical workflow standards, regulatory requirements |
| `integration` | External Integrations | Features connecting to outside systems | API specs, authentication, data formats, error handling, rate limits |
| `i18n-ux` | Internationalization & UX Copy | User-facing features | Translation patterns, medical terminology in ka/en/ru, date/number formatting, RTL considerations |
| `performance` | Performance & Scale | Data-heavy features | Query optimization, pagination, lazy loading, bundle size, caching strategies |
| `workflow` | Clinical Workflow | Clinical features | Medical workflow standards, clinician expectations, order of operations, status transitions |

### Selection Logic

Read the topic and ask: **What 6 angles would give a developer the most complete picture for building this?**

Rules of thumb:
- `codebase` is **always** included — it's the most valuable angle
- `data-model` is included for any feature that reads/writes FHIR data (almost everything)
- `ui-ux` is included for any feature with a user interface
- `security` is included for features touching patient data, financial data, or access control
- `industry` is included when clinical domain knowledge matters
- `architecture` is included for complex features with state, real-time, or multi-service coordination
- `integration` replaces another angle when external APIs are involved
- `workflow` replaces another angle for clinical process features (order entry, medication admin, triage)
- `i18n-ux` replaces another angle when the feature is heavily user-facing with lots of text
- `performance` replaces another angle for data-heavy features (analytics, search, dashboards)

Announce your chosen 6 angles and why before launching.

---

## Step 2: Prepare Agent Prompts

For each of the 6 chosen angles, construct a focused research prompt. Read `references/agent-prompts.md` for the prompt template.

**Key rules:**
- Each agent gets the FULL topic description so it understands context
- Each agent gets its SPECIFIC angle and what to investigate
- Each agent is told to save its findings to `research/.parts/NN-[angle].md`
- Each agent uses the `deep-web-researcher` subagent type
- Each agent uses `model: "opus"`

---

## Step 3: Launch All 6 Agents in Parallel

Spawn all 6 agents in a **single message** (critical for parallelism). Use the Agent tool with:
- `subagent_type: "deep-web-researcher"`
- `model: "opus"`
- `run_in_background: true`
- `name: "research-[angle]"` (e.g., `research-codebase`, `research-data-model`)

Example pattern for each agent call:
```
Agent(
  name: "research-codebase",
  subagent_type: "deep-web-researcher",
  model: "opus",
  run_in_background: true,
  prompt: <constructed from template>
)
```

After launching, tell the user: "Launched 6 research agents. I'll compile the results when they're all done."

---

## Step 4: Wait for Completion

You will be notified as each agent completes. Do NOT poll or sleep. Continue with other work if the user asks, or wait.

As agents complete, briefly note which ones finished: "Research agent 3/6 done (UI/UX patterns)."

---

## Step 5: Merge Findings into Unified Research Brief

Once all 6 agents are done:

1. **Read all partial files** from `research/.parts/`
2. **Merge into one document** following the template in `references/merge-template.md`
3. **Write the unified brief** to `research/[feature-name]-research-brief.md`
4. **Clean up** — delete `research/.parts/` directory

### Merge Rules

- **Deduplicate** — If two agents found the same thing (e.g., both mention the same library), keep the richer description
- **Cross-reference** — When findings from different angles reinforce each other, note this ("Architecture research confirms the caching pattern found in codebase analysis")
- **Flag conflicts** — If agents disagree (e.g., one recommends library A, another warns against it), present both views
- **Preserve sources** — Keep all URLs and file paths from individual agents
- **Add a synthesis section** — Write a "Connections & Insights" section that ties findings across angles together. This is where the value of 6 parallel investigations pays off — patterns that no single agent would catch

### Quality Check Before Writing

Before writing the final brief, verify:
- [ ] Every section has substantive content (not just headers)
- [ ] File paths from codebase research are included
- [ ] External sources have URLs
- [ ] Risks have mitigations
- [ ] Open questions are clearly stated
- [ ] The document is detailed enough to write a spec from

---

## Step 6: Present Summary to User

After writing the file, present a concise summary:

```
## Research Complete: [Feature Name]

**Full brief:** `research/[feature-name]-research-brief.md`

### Key Findings
1. [Most important finding]
2. [Second most important]
3. [Third most important]

### Reusable from Codebase
- [Component/service 1] at [path]
- [Component/service 2] at [path]

### Key Risks
- [Biggest risk]
- [Second biggest]

### Open Questions (need your input)
- [Question 1]
- [Question 2]

Ready for spec creation whenever you are.
```

---

## Error Handling

- **If an agent fails or times out:** Note which angle is missing, present partial results, and offer to re-run the failed agent
- **If the topic is too vague:** Ask the user to be more specific before launching (e.g., "pharmacy queue" is good, "pharmacy" alone is too broad)
- **If `research/.parts/` already exists:** Ask if user wants to overwrite or merge with previous research
