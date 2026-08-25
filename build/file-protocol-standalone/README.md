# Naidan file-protocol standalone build integration

`createNaidanStandalonePlugin(...)` is the single public build integration for the file-protocol standalone package.

It owns one Vite/Rolldown module graph containing the UI entry and every standalone Worker entry so shared modules can be emitted once and loaded by each JavaScript realm from the same physical chunk. Internally it returns multiple Vite plugin objects to keep build hooks separated by responsibility; callers register only the one public factory.

The integration also owns the standalone release gate. Size, module ownership, license coverage, output shape, and packaging are validated by internal plugins before the archive callback is allowed to run.

Worker definitions live in `worker-definitions.ts`. Runtime Worker clients use the generated virtual modules declared under `virtual:file-protocol-standalone/worker/*`.

## Validation ownership

- `file-protocol-startup-support.ts` is the single source for the UI bootstrap, the `file:` SystemJS script patch, and physical-load recovery.
- `standalone-worker-runtime-source.ts` generates the small Blob Worker bootstrap and the shared Worker lifecycle runtime. It does not embed Worker application code.
- `html-validation.ts` validates the HTML both before and after the standalone rewrite and fails closed on unexpected executable/preload/network-dependent elements. It also rejects `<base href>` and CSP meta because both can change the runtime semantics of generated relative scripts/styles, and it records whether each existing stylesheet applies unconditionally. Conditional public stylesheets remain valid, while a link used as the existing owner of UI-graph CSS must be a direct child of `<head>` and unconditional (`media` absent/`all`, not disabled/alternate/titled, and CSS-typed when a type hint is present).
- Bootstrap insertion uses the parsed `<head>` source boundary rather than a literal `</head>` search, so comments or inline text containing that token cannot capture generated runtime scripts.
- `plugin.ts` owns the unified graph, source/output policy hooks, Worker entries, and SystemJS output conversion.
- The Vite preload-helper compatibility hook leaves HTTP/HTTPS preloading intact, but returns before `import.meta.resolve` and DOM preload creation whenever the UI is running from `file:`. SystemJS owns JavaScript loads there, while every physical stylesheet in the complete UI closure is linked once from the final HTML.
- CSS output metadata is fail-closed: every UI chunk must retain Vite `importedCss` metadata as `Set<string>`, every metadata-referenced non-empty stylesheet must exist as a CSS asset, parsed HTML must not link the same CSS output twice, and final local stylesheet links must not retain `crossorigin`.
- Effect-free empty CSS placeholders are removed from stylesheet metadata and HTML before Vite's manifest post-plugin runs. The physical file is removed only when it is not also referenced through `importedAssets`; this preserves JavaScript-owned lazy CSS splitting without breaking `?url`-style data-asset semantics.
- Eager file-protocol CSS preserves Vite's cascade ordering for each static closure (static imports depth-first, then the chunk's `importedCss` insertion order). Dynamic Import branches are appended in stable graph-discovery order instead of sorting output file names, and any UI-owned stylesheet already present in Vite's HTML must be an unconditional direct child of `<head>` matching a prefix of that order.
- Generated href/src references URI-encode each Rollup output path segment so spaces, `%`, `#`, `?`, and non-ASCII file names cannot change URL semantics. Final release validation reuses the same parsed-HTML contract and independently checks every referenced stylesheet against the complete distribution, including copied public assets that are not Rollup bundle entries.
- Worker CSS classification covers both direct stylesheet modules and Vue SFC `?vue&type=style` virtual modules; reviewed `?raw`, `?inline`, and `?url` imports remain data imports rather than stylesheet side effects.
- `release-validation.ts` is the final packaging gate. Metrics, duplicate module ownership, license coverage, report placement, and budgets must pass before the archive callback runs.

`sourceAudit.mode: 'external'` exists because repeating the full source AST audit inside the already large Naidan graph materially increases peak build memory. It is not a permanent waiver. The evidence must come from a reviewed source-policy audit and must be renewed when changes can alter the standalone Worker/source graph or its policy assumptions. Vite Worker-query and `importScripts()` source guards remain active because they use cheap lexical prefilters; final-output Raw Worker, CommonJS, CSS, WASM, output-shape, ownership, and release checks also remain active regardless of source-audit mode. External mode skips the Worker-realm global graph audit and source-candidate Raw Worker diagnostics, so its evidence must cover those source-level assumptions.
