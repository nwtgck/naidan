# Worker Patterns

Use one of these two patterns for new workers.

## Why

The main constraint is `standalone`, which must work from `file:///`.

- Standalone cannot rely on normal hosted worker asset loading.
- Standalone worker code must be embedded into `index.html`.
- If standalone embeds many separate workers, shared libraries get duplicated and `index.html` grows.
- Hosted should keep normal worker assets and chunk splitting.
- Build-time exclusion matters. Hosted-only worker code should not leak into standalone bundles.

The goal is:

- `file:///` compatibility in standalone
- small standalone `index.html`
- normal worker chunking in hosted
- good tree shaking
- one stable import surface for app code

## Core Rules

1. App code imports a client facade, not a loader.
2. Callers use typed clients with `dispose({})`, not raw `Worker`.
3. Hosted/standalone switching happens with Vite alias, not runtime protocol branching.

Examples of public facades:

- `@/services/wesh-worker-client`
- `@/services/global-search-worker-client`
- `@/services/transformers-js-worker-client`

## Pattern A: Hosted + Standalone Hub

Use for lightweight workers that must work in both hosted and standalone.

Examples:

- `wesh`
- `globalSearch`

Structure:

- `foo-worker-client.ts`
- `foo-worker-client-hosted.ts`
- `foo-worker-client-standalone.ts`
- `foo.worker.impl.ts`
- `foo.worker.ts`
- `worker-hub-standalone.ts`
- `worker-hub-standalone.worker.ts`

Behavior:

- Hosted: dedicated worker
- Standalone: one embedded hub worker, accessed as `hub.remote.foo`

Why:

- Standalone embedding is required anyway.
- One standalone hub avoids duplicating shared libraries across multiple embedded workers.
- Hosted keeps dedicated workers so normal chunking is preserved.

Rules:

1. Put reusable worker logic in `foo.worker.impl.ts`.
2. Keep `foo.worker.ts` as the hosted entrypoint that only exposes the worker.
3. Add the service to `IWorkerHub` and `createStandaloneWorkerHub({})`.
4. Wrap hub services with `Comlink.proxy(...)`.
5. Add standalone Vite alias for the public facade.

## Pattern B: Hosted Only + Standalone Unsupported

Use for heavy workers that should stay unavailable in standalone.

Example:

- `transformers.js`

Structure:

- `foo-worker-client.ts`
- `foo-worker-client-hosted.ts`
- `foo-worker-client-standalone.ts`
- optional helper facades like `foo-scanner-worker-client.ts`
- hosted worker entrypoints stay normal

Behavior:

- Hosted: dedicated worker
- Standalone: no worker, unsupported client surface

Why:

- Heavy worker bundles or large wasm should not be embedded into standalone.
- The right behavior is hosted support plus explicit standalone unavailability through the same facade.
- Tests may run in environments without `Worker`, so hosted clients must not crash at import time.

Rules:

1. Define a typed client interface in `foo.types.ts`.
2. Hosted client wraps the dedicated worker.
3. Hosted client should handle `typeof Worker === 'undefined'` by returning an unavailable client surface instead of crashing at import time.
4. Standalone client keeps the same methods but throws a clear unsupported error.
5. Add standalone Vite alias for the facade.
6. Do not keep a noop loader alias once the facade exists.

## Vite Rules

- Use `resolve.alias` to swap standalone clients.
- Do not depend on `window.location.protocol` to exclude hosted worker code.
- If standalone supports the worker, embed the standalone hub worker into `index.html`.
- If standalone does not support the worker, swap the facade to an unsupported implementation.

Why:

- Runtime branching is not enough for bundle exclusion.
- Alias-based switching keeps hosted-only code out of standalone at build time.
- That is what preserves tree shaking and correct output shape.

## Implementation Order

1. Add the public client facade.
2. Add the hosted client implementation.
3. Decide the standalone side:
   - supported in standalone: add the service to `worker-hub-standalone.ts`, expose it from `worker-hub-standalone.worker.ts`, and add standalone embedding in `vite.config.ts`
   - unsupported in standalone: add the standalone unsupported client and add the standalone alias in `vite.config.ts`
4. Add or update the `vite.config.ts` alias so app code imports the facade path in both modes.
5. Move callers to the facade.
6. Then remove direct loader imports, noop aliases, and transitional runtime branching.

This keeps old and new worker-loading styles from mixing.
