# Feature Placement

This file applies to `src/features/**`.

A Feature in this repository is narrower than a general product feature. It is not a dependency layer and is not a tool for subdividing the source tree.

## Primary Criterion

The primary question is:

> If this capability were removed from Naidan, could its related UI, state, logic, workers, and configuration be deleted together as one cohesive unit?

Do not create a Feature unless the answer is clearly yes.

The following characteristics support Feature placement:

- the capability can be added or removed independently;
- related files change for the same reason;
- the capability is not a Naidan-wide foundation;
- removing the capability makes most of the Feature directory unnecessary.

Clear examples include:

```text
wesh
file-explorer
wesh-terminal
```

Feature extraction should be uncommon. Most Naidan behavior is closely integrated with the rest of the application.

## Avoid Fragmentation

Do not split strongly interdependent code into separate Features. Also avoid Feature boundaries when the involved areas are likely to become more interdependent.

Over-fragmentation can:

- force one change to cross many directories;
- obscure ownership;
- complicate import paths;
- make related behavior difficult to trace;
- turn the source tree into a maze;
- create a separation that does not match actual dependencies.

When the removal boundary is unclear, prefer the shared `src/components/**`, `src/composables/**`, or `src/logic/**` areas.

File count and technical category are not sufficient reasons to create a Feature.

## Feature Contents

Create only the subdirectories that the Feature needs. A Feature may contain:

```text
components/
composables/
logic/
worker/
types.ts
constants.ts
index.ts
```

Do not force every Feature into the same shape.

- Place `.vue` files under `components/` unless there is a specific reason not to.
- Place Vue composables under `composables/`.
- Place Feature-owned non-Vue application logic under `logic/` when that grouping is useful.
- Place worker implementation under `worker/` when applicable.
- Do not create layers for a single type or helper without a concrete need.
- Add barrel exports only when they provide a useful public surface.

## Reconsidering Existing Placement

During unrelated work, an existing Feature may appear to contain code that belongs elsewhere, or shared code may appear to belong in a Feature.

Do not perform that relocation automatically. Feature work and structural refactoring in the same diff make rename detection and review substantially harder.

Explain the following points and ask the user how to proceed:

- why the current placement is problematic;
- the proposed destination;
- the effect of combining the relocation with the requested change;
- the advantage of handling the relocation separately.

Existing directories under `src/features/**` are not proof that their current classification is correct. Do not reclassify them as part of this documentation change, and do not weaken the Feature criterion to justify existing placement.

## Dependencies

Features may depend on other Features and on shared application code. Feature-to-Feature dependencies are not prohibited.

Features may depend on:

```text
src/components/**
src/composables/**
src/logic/**
src/01-models/**
src/00-storage/service/**
src/strings/**
src/constants.ts
src/utils/**
```

Features must not depend directly on:

```text
src/00-storage/00-dto/**
src/00-storage/mapper/**
```

Use a purpose-specific public Storage service API instead of exposing persisted formats.

---

# Worker Patterns

Use one of these two patterns for new workers.

## Why

The main constraint is `standalone`, which must work from `file:///`.

- Standalone cannot rely on normal hosted Worker asset loading.
- Standalone-supported Worker entries join the same Vite/Rolldown graph as the UI so shared dependencies have one physical output owner.
- Each dedicated Worker still needs its own Realm, so runtime state is never shared merely because a JavaScript chunk is physically shared.
- Direct `file:` Worker entry URLs are not portable across the target browsers; a small Blob bootstrap loads SystemJS and imports the logical Worker entry instead.
- Hosted should keep normal Worker assets and chunk splitting.
- Build-time exclusion matters. Hosted-only Worker code should not leak into standalone bundles.

The goal is:

- `file:///` compatibility in standalone
- one physical copy of modules shared by the UI and standalone Workers
- lazy UI and Worker chunk loading rather than embedding Worker applications into `index.html`
- normal Worker chunking in hosted
- good tree shaking
- one stable import surface for app code

## Core Rules

1. App code imports a client facade, not a loader.
2. Callers use typed clients with `dispose()`, not raw `Worker`.
3. Hosted/standalone switching happens with Vite alias, not runtime protocol branching.

Examples of public facades:

- `@/features/wesh/worker/client`
- `@/features/global-search/worker/client`
- `@/features/file-explorer/worker/client`
- `@/features/advanced-text-editor-v3/worker/client`
- `@/features/highlight/worker/client`
- `@/features/transformers-js/worker/client`

## Pattern A: Hosted + Standalone Independent Worker

Use for workers that must work in both hosted and standalone.

Examples:

- `wesh`
- `globalSearch`
- `fileExplorer`
- `highlight`
- `advancedTextEditorV3`

Structure:

- `foo/worker/client.ts`
- `foo/worker/client-hosted.ts`
- `foo/worker/client-standalone.ts`
- `foo/worker/entry.ts`
- `foo/worker/types.ts`
- `build/file-protocol-standalone/worker-definitions.ts`

Behavior:

- Hosted: a normal dedicated Worker built by Vite.
- Standalone: an independent dedicated Worker whose entry is emitted into the same Vite/Rolldown graph as the UI and the other standalone Workers.

Why:

- Direct `file:` Worker URLs are not portable across the target browsers, so standalone uses a small Blob bootstrap that loads SystemJS and imports the logical Worker entry.
- UI and Worker entries share one module graph, so shared dependencies such as Zod, Comlink, and Naidan modules have one physical output owner instead of being duplicated per Worker bundle.
- Each dedicated Worker still has its own JavaScript Realm and evaluates shared modules independently; only the physical output files are shared.
- Hosted keeps normal dedicated Worker chunking.

Rules:

1. Put each standalone-supported Worker entry in `build/file-protocol-standalone/worker-definitions.ts`.
2. Keep standalone callers behind the same public client facade used by hosted mode.
3. Standalone clients import their generated virtual Worker factory, not raw `Worker` URLs.
4. Use `standalone-worker-session.ts` for bounded Comlink cleanup and unconditional physical Worker termination.
5. Do not add a Worker Hub, `?worker`/`?sharedworker` imports, or another Worker build graph to solve dependency sharing.

Notes:

- Put worker request and response schemas in `foo/worker/types.ts`.
- Put worker-only helper code next to the worker, for example `highlight/worker/core.ts`.
- If the feature also has non-worker code, keep it outside `worker/`, for example `global-search/types.ts`.

## Standalone Independent Worker Runtime Contract

`createNaidanStandalonePlugin()` owns one standalone build graph containing the UI entry and every configured Worker entry. Internally it may use more than one Vite plugin object to separate hook responsibilities, but callers should treat it as one standalone build integration.

For each standalone Worker, the plugin emits a virtual factory that creates a small Blob bootstrap. The bootstrap loads the copied SystemJS runtime with `importScripts()` and then `System.import()`s the logical Worker entry. Static Worker dependencies use the same physical `System.register` chunks as other Workers and the UI when Rolldown places them in shared chunks.

The plugin also enforces the output contract:

- no Vite-managed `?worker` or `?sharedworker` graph for standalone-supported Workers
- no unapproved raw Worker constructor surviving in final application output
- no Worker-only CSS with nowhere to apply it
- no unsupported Worker-realm globals
- no duplicate physical owner for one rendered module
- all standalone application JavaScript is `System.register` output

A shared physical file does not imply shared runtime state. UI and each Worker Realm evaluate that file independently.

## Core, Debug, Optimization, and Verification Boundaries

File-protocol standalone code intentionally uses names that expose which path a symbol belongs to. Preserve these boundaries when adding features:

- **Core** makes the standalone application function: Worker bootstrap creation, Worker creation, SystemJS loading and recovery, HTML bootstrap replacement, output validation, build metrics, and budget enforcement.
- **Debug** observes Core but does not decide Core behavior. Names start with `Debug...` or `debug...` so unfamiliar implementers do not reuse them as normal product APIs. Core may write Debug checkpoints or counters, but Core must not read Debug state to choose its behavior.
- **Optimization** may improve latency without changing correctness. Shared Worker bootstrap warmup uses `scheduleStandaloneWorkerBootstrapWarmup()` and is not Debug state.
- **Verification** actively probes a built standalone application. It lives under `file-protocol-standalone/debug/verification/` and must not become a dependency of normal application behavior.

The only public runtime namespace is `globalThis.__FILE_PROTOCOL_STANDALONE__`. Application code may call `getDiagnostics()`. Generated runtime scripts store optional Debug state such as startup checkpoints, the SystemJS file patch, retry observations, and aggregate/per-Worker lifecycle diagnostics. Their initialization and updates must fail open.

Do not make a normal feature depend on a `debug...` result. If a value starts controlling product behavior, promote it to an explicit Core API and rename it accordingly.

The generated standalone Worker runtime exposes:

- each configured `virtual:file-protocol-standalone/worker/<name>` factory for normal Worker creation
- `scheduleStandaloneWorkerBootstrapWarmup()` for optional idle warmup
- `debugGetStandaloneWorkerRuntimeDiagnostics()` for Debug-only observation

## Pattern B: Hosted Only + Standalone Unsupported

Use for heavy workers that should stay unavailable in standalone.

Example:

- `transformers.js`

Structure:

- `foo/worker/client.ts`
- `foo/worker/client-hosted.ts`
- `foo/worker/client-standalone.ts`
- `foo/worker/entry.ts`
- `foo/worker/types.ts`
- optional nested worker helpers such as `foo/scanner/worker/client.ts`
- feature-level modules stay under `foo/`, for example `foo/types.ts`, `foo/provider.ts`, `foo/models/*`

Behavior:

- Hosted: dedicated worker
- Standalone: no worker, unsupported client surface

Why:

- Heavy worker bundles or large wasm should not be embedded into standalone.
- The right behavior is hosted support plus explicit standalone unavailability through the same facade.
- Tests may run in environments without `Worker`, so hosted clients must not crash at import time.

Rules:

1. Define worker-facing interfaces in `foo/worker/types.ts`, and keep feature-level shared types in `foo/types.ts` when needed.
2. Hosted client wraps the dedicated worker.
3. Hosted client should handle `typeof Worker === 'undefined'` by returning an unavailable client surface instead of crashing at import time.
4. Standalone client keeps the same methods but throws a clear unsupported error.
5. Add standalone Vite alias for the facade path, normally `@/features/foo/worker/client`.
6. Do not keep a noop loader alias once the facade exists.


## Comlink and Named Args

Comlink positional exceptions are only for callable signatures that directly form the Comlink boundary: methods exposed with `Comlink.expose(...)`, methods declared for `Comlink.wrap<RemoteInterface>(...)`, or remote methods that receive `Comlink.proxy(...)` callbacks as top-level arguments.

Do not use the Comlink exception merely because a function internally calls a Comlink remote. Naidan-facing facades that hide the worker boundary should still use named args, and should bridge to the positional Comlink call internally:

```ts
async function generateText({ messages, onChunk }: {
  messages: ChatMessage[],
  onChunk: ({ chunk }: { chunk: string }) => void,
}) {
  return remote.generateText(
    { messages },
    Comlink.proxy((chunk) => onChunk({ chunk })),
  );
}
```

## Vite Rules

- Use `resolve.alias` to swap standalone clients.
- Do not depend on `window.location.protocol` to exclude hosted worker code.
- If standalone supports the worker, register its existing Worker entry in `build/file-protocol-standalone/worker-definitions.ts` so it joins the single standalone module graph.
- If standalone does not support the worker, swap the facade to an unsupported implementation.
- Do not use Vite `?worker`, `?sharedworker`, or a second Worker build pipeline for standalone-supported Workers; those create separate graphs and defeat physical dependency sharing.

Why:

- Runtime branching is not enough for bundle exclusion.
- Alias-based switching keeps hosted-only code out of standalone at build time.
- One standalone graph is what lets UI and independent Workers share physical chunks while preserving separate Worker Realms.

## Implementation Order

1. Add the public client facade.
2. Add the hosted client implementation.
3. Decide the standalone side:
   - supported in standalone: add `client-standalone.ts`, use its generated virtual Worker factory, and register the Worker entry in `build/file-protocol-standalone/worker-definitions.ts`
   - unsupported in standalone: add the standalone unsupported client and add the standalone alias in `vite.config.ts`
4. Add or update the standalone facade alias so app code imports the same facade path in both modes.
5. Move callers to the facade.
6. Then remove transitional loaders and runtime protocol branching.

This keeps hosted and standalone Worker-loading styles explicit without reintroducing a shared Worker Hub.
