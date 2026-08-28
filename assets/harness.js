/**
 * SUPERSEDED — do not inject this file.
 *
 * The single-file, accounts-sidebar-only harness was replaced by an app-agnostic core plus an
 * adapter, so the skill covers the whole SPA performance picture rather than one list:
 *
 *   assets/harness-core.js          instrumentation + the seven scenario primitives
 *   assets/adapters/suite-web.js    Suite fixtures, seeding, selectors and scenarios
 *
 * Inject them together:
 *
 *   cat assets/harness-core.js assets/adapters/suite-web.js
 *
 * This placeholder exists only because the sandbox that wrote it could not delete files under
 * ~/.claude/skills. It is safe to remove.
 */
throw new Error(
    'harness.js is superseded — inject harness-core.js + adapters/suite-web.js instead',
);
