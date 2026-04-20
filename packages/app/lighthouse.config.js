/**
 * LiverRa Lighthouse CI budgets.
 *
 * Plan §Load & performance · Tasks T365 · Spec §NFR-001.
 *
 * Scope: three surgeon-critical routes get PR-blocking Lighthouse runs.
 *   - /cases                — dashboard (first impression, LCP-sensitive)
 *   - /cases/:demo          — viewer shell (TBT + CLS sensitive; 3D viewer
 *                             defers GPU work so LCP stays ≤2.5s)
 *   - /admin/users          — admin table
 *
 * Budgets are enforced by `@lhci/cli autorun --collect=...`. Failures block
 * PRs in the ci-lighthouse GitHub Actions lane.
 */

/** @type {import('@lhci/cli').Config} */
module.exports = {
  ci: {
    collect: {
      // Boot the built preview server; assumes `npm run build && npm run preview`
      // has produced a production bundle on :3000.
      startServerCommand: 'npx vite preview --port 3000',
      startServerReadyPattern: 'Local:.*http://localhost:3000',
      url: [
        'http://localhost:3000/cases',
        'http://localhost:3000/cases/demo-case-1',
        'http://localhost:3000/admin/users',
      ],
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
        // Simulated slow desktop + 150 ms RTT — middle-of-road surgeon
        // workstation on hospital LAN (research §G).
        throttling: {
          rttMs: 150,
          throughputKbps: 10 * 1024,
          cpuSlowdownMultiplier: 2,
        },
        onlyCategories: ['performance', 'accessibility', 'best-practices'],
      },
    },
    assert: {
      assertions: {
        // Core Web Vitals per NFR-001
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }], // ≤2.5s
        'total-blocking-time':     ['error', { maxNumericValue: 300 }],   // ≤300ms
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],   // ≤0.1
        interactive:               ['error', { maxNumericValue: 4000 }],  // TTI ≤4s

        // Accessibility floor (per NFR-002 WCAG 2.1 AA)
        'categories:accessibility': ['error', { minScore: 0.95 }],

        // Best-practices floor
        'categories:best-practices': ['warn', { minScore: 0.9 }],

        // No render-blocking resources above 500 ms
        'render-blocking-resources': ['warn', { maxNumericValue: 500 }],

        // No massive JS payloads on initial route
        'total-byte-weight': ['warn', { maxNumericValue: 1_500_000 }], // 1.5 MB
      },
    },
    upload: {
      target: 'temporary-public-storage',
    },
  },
};
