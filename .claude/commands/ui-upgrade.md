---
description: Upgrade a page's UI to production-ready, beautiful design following LiverRa design system
---

## User Input

```text
$ARGUMENTS
```

## Instructions

Launch the **frontend-designer** agent to upgrade this page's UI.

**Input provided:** The user has specified either:
- A screenshot path (e.g., `screenshots/current-page.png`)
- A page route (e.g., `/emr/patient-history`)
- A description of what to upgrade

**Agent capabilities:**
1. Takes BEFORE screenshots using Playwright
2. Analyzes all visual issues (colors, typography, components, responsiveness)
3. Creates a detailed plan in `tasks/ui-upgrade-todo.md`
4. IMPLEMENTS all code changes following LiverRa design system
5. Takes AFTER screenshots to verify improvements
6. Iterates until the page is production-ready and beautiful

**The frontend-designer agent will:**
- Replace all hardcoded colors with theme variables
- Ensure all buttons use the primary gradient
- Convert modals to EMRModal
- Fix mobile responsiveness (44px tap targets, 16px min font)
- Add loading skeletons and empty states
- Apply proper transitions, shadows, and polish

Pass the user's input to the frontend-designer agent and let it execute the full workflow.

Make it production ready beautiful, with best designe practices in mind. with best ui/ux in mind. Make it user centric, practical with best layout in mind. easy to understand and navigate. make sure to use my reusbale ui compontns from 
  my UI components library not the mentine stuff. 0 Tolereance to mentine stuff.                            