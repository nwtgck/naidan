# Worker Patterns

Use one of these two patterns for new workers.

## Why

The main constraint is `standalone`, which must work from `file:///`.

- Standalone cannot rely on normal hosted worker asset loading.
- Standalone worker code is built as one classic IIFE and registered by a lazily loaded classic script. It is not embedded into `index.html`.
- If standalone emits many independent worker bundles, shared libraries get duplicated across those bundles.
- Hosted should keep normal worker assets and chunk splitting.
- Build-time exclusion matters. Hosted-only worker code should not leak into standalone bundles.

The goal is:

- `file:///` compatibility in standalone
- small standalone `index.html` and lazy worker payload loading
- normal worker chunking in hosted
- good tree shaking
- one stable import surface for app code

## Core Rules

1. App code imports a client facade, not a loader.
2. Callers use typed clients with `dispose()`, not raw `Worker`.
3. Hosted/standalone switching happens with Vite alias, not runtime protocol branching.

Examples of public facades:

- `@/services/wesh-worker-client`
- `@/services/global-search/worker/client`
- `@/services/file-explorer/worker/client`
- `@/services/advanced-text-editor-v3/worker/client`
- `@/services/highlight/worker/client`
- `@/services/transformers-js/worker/client`

## Pattern A: Hosted + Standalone Hub

Use for lightweight workers that must work in both hosted and standalone.

Examples:

- `wesh`
- `globalSearch`

Structure:

- `foo/worker/client.ts`
- `foo/worker/client-hosted.ts`
- `foo/worker/client-standalone.ts`
- `foo/worker/impl.ts`
- `foo/worker/entry.ts`
- `foo/worker/types.ts`
- `worker-hub-standalone.ts`
- `worker-hub-standalone.worker.ts`

Behavior:

- Hosted: dedicated worker
- Standalone: one Blob-backed hub worker created from an external classic registry, accessed as `hub.remote.foo`

Why:

- Direct `file:` Worker URLs are not portable across the target browsers, so the plugin registers one Blob and creates Workers from its Object URL.
- One standalone hub avoids duplicating shared libraries across multiple independent worker bundles.
- Hosted keeps dedicated workers so normal chunking is preserved.

Rules:

1. Put reusable worker logic in `foo/worker/impl.ts`.
2. Keep `foo/worker/entry.ts` as the hosted entrypoint that only exposes the worker.
3. Add the service to `IWorkerHub` and `createStandaloneWorkerHub()`.
4. Wrap hub services with `Comlink.proxy(...)`.
5. Add standalone Vite alias for the public facade path, normally `@/services/foo/worker/client`.

Notes:

- Put worker request and response schemas in `foo/worker/types.ts`.
- Put worker-only helper code next to the worker, for example `highlight/worker/core.ts`.
- If the feature also has non-worker code, keep it outside `worker/`, for example `global-search/types.ts`.

## Standalone Hub Runtime Contract

The `file-protocol-standalone` plugin builds the configured hub entry as one classic IIFE. A classic registry script constructs a `Blob` from source parts and registers only the Blob metadata. The virtual worker module loads that registry on demand, creates one page-lifetime Object URL, deletes the temporary registry entry, and returns a new `Worker` instance for each caller.

Why:

- A classic `<script src>` can load a local file where direct `file:` Worker creation and native modules are unreliable.
- Keeping the large source outside `index.html` avoids parsing the Worker payload during initial page startup.
- Passing source parts directly to `Blob` avoids creating another large joined string.
- The Object URL keeps the Blob alive, so the temporary Blob entry under `globalThis.__FILE_PROTOCOL_STANDALONE__.internal.core.workerBlobRegistry` is removed after URL creation.
- The Object URL is intentionally not revoked during normal page lifetime because later callers may create more Worker instances from the same hub.
- The plugin does not make Worker instances singletons; isolation and lifetime are application decisions.
- SHA-256 is build-time diagnostic metadata only. Runtime code verifies metadata and `Blob.size` without reading the whole Blob into another buffer.

The plugin guarantees one JavaScript artifact with no additional Vite-managed Worker assets, static module syntax, or `import.meta`. A remaining runtime `import(specifier)` with a dynamic specifier is reported because the plugin cannot prove whether a dependency's code path is reachable; the plugin does not rewrite Naidan or its dependencies to remove it.

Adding a normal service to the existing hub does not require registering a new Worker entry. Update `vite.config.ts` only when introducing a genuinely independent standalone Worker artifact.


## Core, Debug, Optimization, and Verification Boundaries

File-protocol standalone code intentionally uses names that expose which path a symbol belongs to. Preserve these boundaries when adding features:

- **Core** makes the standalone application function: Worker Blob registration, Worker creation, SystemJS loading and recovery, HTML bootstrap replacement, output validation, build metrics, and budget enforcement.
- **Debug** observes Core but does not decide Core behavior. Names start with `Debug...` or `debug...` so unfamiliar implementers do not reuse them as normal product APIs. Core may write Debug checkpoints or counters, but Core must not read Debug state to choose its behavior.
- **Optimization** may improve latency without changing correctness. Worker asset warmup uses `scheduleFileProtocolStandaloneWorkerHubWarmup()` and is not Debug state.
- **Verification** actively probes a built standalone application. It lives under `debug-file-protocol-standalone/verification/` and must not become a dependency of normal application behavior.

The only public runtime namespace is `globalThis.__FILE_PROTOCOL_STANDALONE__`. Application code may call `getDiagnostics()`. Generated runtime scripts use the private namespace as follows:

- `internal.core.workerBlobRegistry` is Core state required while constructing the page-lifetime Worker Object URL.
- `internal.debug.startup`, `systemJsPatch`, `systemJsRetry`, and `workerRuntime` are optional Debug state. Their initialization and updates must fail open.

Do not make a normal feature depend on a `debug...` result. If a value starts controlling product behavior, promote it to an explicit Core API and rename it accordingly.

The standalone Worker facade is exposed through:

- `createFileProtocolStandaloneWorkerHub()` for normal Worker creation
- `scheduleFileProtocolStandaloneWorkerHubWarmup()` for optional idle warmup
- `debugGetFileProtocolStandaloneWorkerHubDiagnostics()` for Debug-only observation

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
5. Add standalone Vite alias for the facade path, normally `@/services/foo/worker/client`.
6. Do not keep a noop loader alias once the facade exists.


## Comlink and Named Args

Comlink positional exceptions are only for callable signatures that directly form the Comlink boundary: methods exposed with `Comlink.expose(...)`, methods declared for `Comlink.wrap<RemoteInterface>(...)`, or remote methods that receive `Comlink.proxy(...)` callbacks as top-level arguments.

Do not use the Comlink exception merely because a function internally calls a Comlink remote. Naidan-facing facades that hide the worker boundary should still use named args, and should bridge to the positional Comlink call internally:

```ts
async function generateText({ messages, onChunk }: {
  messages: ChatMessage[];
  onChunk: ({ chunk }: { chunk: string }) => void;
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
- If standalone supports the worker, add it to the shared hub. The plugin emits the hub source as an external classic registry script and creates a Blob lazily.
- If standalone does not support the worker, swap the facade to an unsupported implementation.

Why:

- Runtime branching is not enough for bundle exclusion.
- Alias-based switching keeps hosted-only code out of standalone at build time.
- That is what preserves tree shaking and correct output shape.

## Implementation Order

1. Add the public client facade.
2. Add the hosted client implementation.
3. Decide the standalone side:
   - supported in standalone: add the service to `worker-hub-standalone.ts` and expose it from `worker-hub-standalone.worker.ts`; the existing registered hub entry normally needs no `vite.config.ts` change
   - unsupported in standalone: add the standalone unsupported client and add the standalone alias in `vite.config.ts`
4. Add or update the `vite.config.ts` alias so app code imports the facade path in both modes.
5. Move callers to the facade.
6. Then remove direct loader imports, noop aliases, and transitional runtime branching.

This keeps old and new worker-loading styles from mixing.
