# Naidan file-protocol standalone build integration

`createNaidanStandalonePlugin(...)` is the single public build integration for the file-protocol standalone package.

It owns one Vite/Rolldown module graph containing the UI entry and every standalone Worker entry so shared modules can be emitted once and loaded by each JavaScript realm from the same physical chunk. Internally it returns multiple Vite plugin objects to keep build hooks separated by responsibility; callers register only the one public factory.

The integration also owns the standalone release gate. Size, module ownership, license coverage, output shape, and packaging are validated by internal plugins before the archive callback is allowed to run.

## Implementation map

Start with `plugin.ts`. It is the public factory and pipeline table of contents: validation and build-local state are followed by graph construction, source policies, composed-bundle guards, CSS/SystemJS finalization, and the optional written-distribution release gate in execution order. Keep that ordering visible in the factory rather than hiding mandatory phases behind a barrel or aggregate helper.

Implementation details live under `plugin/` and are grouped by behavior rather than by generic utility type:

- `source-policy/` contains source/module-graph policies such as Vite Worker queries, `importScripts()`, Raw Worker construction, Worker-realm globals, and CommonJS compatibility.
- `worker-entry.ts` owns Worker virtual entries and generated clients; `worker-definition.ts` owns validation/normalization of caller definitions.
- `worker-css.ts`, `external-wasm.ts`, `preload-helper.ts`, and `empty-css.ts` own focused output compatibility policies.
- `systemjs-output.ts` owns the single post-bundle SystemJS lifecycle hook. It transforms one JavaScript chunk at a time and delegates HTML semantics to `html-rewrite.ts` without creating a second Vite-plugin boundary.
- `html-rewrite.ts` separates HTML decision-making from application with a small rewrite plan that is created and immediately applied to the same original HTML source.
- `diagnostics.ts` and `output-graph.ts` contain narrowly shared data/graph definitions; there is intentionally no generic `utils.ts` bucket or internal `index.ts` barrel.

Worker definitions live in `worker-definitions.ts`. Runtime Worker clients use the generated virtual modules declared under `virtual:file-protocol-standalone/worker/*`.

## Validation ownership

- `file-protocol-startup-support.ts` is the single source for the UI bootstrap, the `file:` SystemJS script patch, and physical-load recovery.
- `standalone-worker-runtime-source.ts` generates the small Blob Worker bootstrap and the shared Worker lifecycle runtime. It does not embed Worker application code.
- `html-validation.ts` validates the HTML both before and after the standalone rewrite and fails closed on unexpected executable/preload/network-dependent elements. It also rejects `<base href>` and CSP meta because both can change the runtime semantics of generated relative scripts/styles, and it records whether each existing stylesheet applies unconditionally. Conditional public stylesheets remain valid, while a link used as the existing owner of UI-graph CSS must be a direct child of `<head>` and unconditional (`media` absent/`all`, not disabled/alternate/titled, and CSS-typed when a type hint is present).
- Bootstrap insertion uses the parsed `<head>` source boundary rather than a literal `</head>` search, so comments or inline text containing that token cannot capture generated runtime scripts.
- `plugin.ts` owns public orchestration and keeps the pipeline order visible; the corresponding hook implementations are grouped under `plugin/` by domain.
- The Vite preload-helper compatibility hook leaves HTTP/HTTPS preloading intact. Under `file:`, SystemJS owns JavaScript dependency loads, while local CSS dependencies retain Vite's Dynamic Import timing and are linked on demand by the UI Realm without `crossorigin`. The helper is guarded by `typeof document !== 'undefined'`, so Worker Realms do not execute DOM loading code.
- CSS output metadata is fail-closed: every UI chunk must retain Vite `importedCss` metadata as `Set<string>`, every metadata-referenced non-empty stylesheet must exist as a CSS asset, parsed HTML must not link the same CSS output twice, and final local stylesheet links must not retain `crossorigin`.
- Effect-free empty CSS placeholders are removed from stylesheet metadata and HTML before Vite's manifest post-plugin runs. The physical file is removed only when it is not also referenced through `importedAssets`; this preserves JavaScript-owned lazy CSS splitting without breaking `?url`-style data-asset semantics.
- Initial file-protocol CSS preserves Vite's cascade ordering for the static UI closure (static imports depth-first, then each chunk's `importedCss` insertion order). Dynamic-only UI CSS must not be present in initial HTML; it remains a physical asset referenced by Vite Dynamic Import dependency metadata. Any initial UI-owned stylesheet already present in Vite's HTML must be an unconditional direct child of `<head>` matching a prefix of the static cascade order.
- Generated href/src references URI-encode each Rollup output path segment so spaces, `%`, `#`, `?`, and non-ASCII file names cannot change URL semantics. Final release validation reuses the same parsed-HTML contract and independently checks every referenced stylesheet against the complete distribution, including copied public assets that are not Rollup bundle entries.
- Worker CSS classification covers both direct stylesheet modules and Vue SFC `?vue&type=style` virtual modules; reviewed `?raw`, `?inline`, and `?url` imports remain data imports rather than stylesheet side effects.
- `release-validation.ts` is the final packaging gate. Metrics, duplicate module ownership, license coverage, report placement, and budgets must pass before the archive callback runs.

`sourceAudit.mode: 'external'` exists because repeating the full source AST audit inside the already large Naidan graph materially increases peak build memory. It is not a permanent waiver. The evidence must come from a reviewed source-policy audit and must be renewed when changes can alter the standalone Worker/source graph or its policy assumptions. Vite Worker-query and `importScripts()` source guards remain active because they use cheap lexical prefilters; final-output Raw Worker, CommonJS, CSS, WASM, output-shape, ownership, and release checks also remain active regardless of source-audit mode. External mode skips the Worker-realm global graph audit and source-candidate Raw Worker diagnostics, so its evidence must cover those source-level assumptions.

## Executable artifact contract

`representative-standalone-artifact-contract.test.ts` is the representative browserless specification for the composed Vite/Rolldown/SystemJS output. Its fixture intentionally compresses important Naidan shapes into one small build: initial and lazy UI CSS, nested Dynamic Import, `?url` data assets, a conditional public stylesheet, UI/Worker-shared modules, a CSS-owning module dynamically imported by both the UI and Workers, modules shared by only a subset of Workers, Worker-shared modules, five Worker entries, one Worker-subset lazy chunk, and one Worker-private Dynamic Import.

The assertions describe semantic output contracts rather than freezing content hashes or complete generated files. The representative fixture is materialized only as build input; Vite runs with `write: false`, so permanent assertions inspect the real Rollup output bundle in memory rather than re-reading generated files from disk. Distribution-only filesystem effects that are not represented in `RolldownOutput` stay in the release gate instead: notably, Vite copies `publicDir` before the standalone `writeBundle` validation, which then validates the complete written distribution. Full artifact dumps are intentionally kept out of the permanent test and may be generated by a local diagnostic test whose canonical source is retained in the standalone research lab.

When changing the standalone plugin, read this test together with `plugin.ts`. The plugin describes how the build is implemented; the representative artifact contract test describes what final output must mean for the modeled production topology after Vite, Rolldown, SystemJS conversion, CSS handling, and Worker graph sharing are composed.

The artifact contract is intentionally not a replacement for Standalone Verification. It moves deterministic output failures earlier: static-versus-lazy CSS placement, Dynamic Import CSS metadata, preservation and ordering of pre-runtime/SystemJS bootstrap scripts, virtual Worker-client composition, Worker-entry ownership, shared physical chunks, Worker-side Dynamic Import ownership, data-asset semantics, SystemJS output shape, and build-host path leakage can all be checked without a browser. Standalone Verification remains responsible for browser/runtime semantics that an output bundle cannot prove: actually running under `file:`, Vue startup and router transitions, computed-style application timing, installed SystemJS patch/retry diagnostics, and real Worker construction/initialization/round trips/termination.
