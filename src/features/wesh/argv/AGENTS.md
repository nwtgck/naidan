# argv

This directory owns the shared argv parser. Treat it as a unit for changes, reviews, and tests.

- Do not import from `@/features/wesh/commands/**`.
- Keep the public surface in `index.ts`; production consumers must not deep-import internal modules.
- A change to shared grammar or API semantics requires a concrete real-command counterexample and argv-architecture review.
- Prefer command-local composition over adding command-specific state/semantics here.
