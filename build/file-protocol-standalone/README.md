# Naidan file-protocol standalone build integration

`createNaidanStandalonePlugin(...)` is the single public build integration for the file-protocol standalone package.

It owns one Vite/Rolldown module graph containing the UI entry and every standalone Worker entry so shared modules can be emitted once and loaded by each JavaScript realm from the same physical chunk. Internally it returns multiple Vite plugin objects to keep build hooks separated by responsibility; callers register only the one public factory.

The integration also owns the standalone release gate. Size, module ownership, license coverage, output shape, and packaging are validated by internal plugins before the archive callback is allowed to run.

Worker definitions live in `worker-definitions.ts`. Runtime Worker clients use the generated virtual modules declared under `virtual:file-protocol-standalone/worker/*`.

## Validation ownership

- `file-protocol-startup-support.ts` is the single source for the UI bootstrap, the `file:` SystemJS script patch, and physical-load recovery.
- `standalone-worker-runtime-source.ts` generates the small Blob Worker bootstrap and the shared Worker lifecycle runtime. It does not embed Worker application code.
- `html-validation.ts` validates the HTML both before and after the standalone rewrite and fails closed on unexpected executable/preload/network-dependent elements.
- `plugin.ts` owns the unified graph, source/output policy hooks, Worker entries, and SystemJS output conversion.
- `release-validation.ts` is the final packaging gate. Metrics, duplicate module ownership, license coverage, report placement, and budgets must pass before the archive callback runs.

`sourceAudit.mode: 'external'` exists because repeating the full source AST audit inside the already large Naidan graph materially increases peak build memory. It is not a permanent waiver. The evidence must come from a reviewed source-policy audit and must be renewed when changes can alter the standalone Worker/source graph or its policy assumptions. Vite Worker-query and `importScripts()` source guards remain active because they use cheap lexical prefilters; final-output Raw Worker, CommonJS, CSS, WASM, output-shape, ownership, and release checks also remain active regardless of source-audit mode. External mode skips the Worker-realm global graph audit and source-candidate Raw Worker diagnostics, so its evidence must cover those source-level assumptions.
