# argv-v2

This directory is the isolated replacement generic argv subsystem. Treat its boundary as a deletion/replacement/review/test unit, not as a file-category label.

- Do not import from `@/features/wesh/argv` or `@/features/wesh/commands/**`.
- Keep the public surface in `index.ts`; production consumers must not deep-import internal modules.
- Grammar/API semantics are frozen for distributed command migration. A change requires a concrete real-command counterexample and argv-architecture review.
- Prefer command-local composition over adding command-specific state/semantics here.
- Do not introduce a shared abstraction solely to deduplicate migration-era legacy/v2 code.
- The `v2` name is temporary and must disappear after legacy argv deletion and directory rename.
