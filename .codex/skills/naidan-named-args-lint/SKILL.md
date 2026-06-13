---
name: naidan-named-args-lint
description: Use this when fixing Naidan require-named-args lint errors. Prefer named args or verifiable external TypeScript types over eslint-disable comments. Includes safe patterns for Promise callbacks, DOM callbacks, assignment RHS callbacks, EventTarget adapters, Comlink boundaries, runtime-only external contracts, and external interface contracts.
---

# Naidan named-args lint fixes

Use this skill when `local-rules-named-args/require-named-args` reports an error.

The goal is not only to silence lint. The goal is to preserve Naidan's named-args API style while keeping true external API contracts positional.

## Core rule

Naidan-owned callables should use one destructured object parameter.

```ts
function run({ value }: { value: string }) {}
```

Not:

```ts
function run(value: string) {}
```

Also prefer destructuring inline object parameters.

```ts
async function run({ signal }: { signal?: AbortSignal }) {}
```

Not:

```ts
async function run(params: { signal?: AbortSignal }) {}
```

Do not add `eslint-disable` as the first response. First try to make the callable either:

1. a Naidan named-args callable, or
2. a positional callable whose external contract is verifiable from TypeScript types.

Only use `eslint-disable` for true external, deprecated, or runtime-only contracts.

## Never suppress by name

Never allow or suppress a callable only because of its parameter, property, or method name.

These names are hints for investigation, not proof of an external contract:

```text
resolve
reject
event
listener
callback
handler
start
write
set
mounted
```

Also do not suppress only because a parameter type is external.

```ts
type NaidanHandler = (event: Event) => void;
```

`Event` is external, but `NaidanHandler` is Naidan-owned. Convert it to named args.

```ts
type NaidanHandler = ({ event }: { event: Event }) => void;
```

## Preferred fix order

1. Convert Naidan-owned functions and callbacks to one destructured object parameter.
2. For inline object parameters like `params: { ... }`, destructure the parameter instead of keeping `params`.
3. If the callable is storing or adapting an external callback, reference the external type instead of rewriting the function type by hand.
4. If the callable is only a short adapter to an external positional callback, keep the adapter inline and call a named-args function inside it.
5. If the callable mirrors a true external, deprecated, or runtime-only contract and cannot be expressed by external types, use a focused `eslint-disable` comment with a precise reason.

## Inline object parameters

Convert inline object parameters to destructured parameters.

```ts
async function listModels(params: { signal?: AbortSignal }) {
  const { signal } = params;
}
```

Fix:

```ts
async function listModels({ signal }: { signal?: AbortSignal }) {
}
```

This rule is based on the shape, not on the identifier name. These are all candidates:

```ts
params: { id: string }
options: { buffer: Uint8Array; offset?: number }
config: { endpoint: string; headers?: [string, string][] }
request: { url: string; signal?: AbortSignal }
```

When the original function stores the whole object, preserve behavior by rebuilding the object.

```ts
constructor({ endpoint, headers }: { endpoint: string; headers?: [string, string][] }) {
  this.config = { endpoint, headers };
}
```

## Alias-typed parameters

Alias-typed parameters need judgment.

```ts
function run(params: RunParams) {}
```

Prefer destructuring when the callable is Naidan-owned and the object is not intentionally passed through as a cohesive object.

```ts
function run({ id, title }: RunParams) {}
```

A destructured alias is already named-args compatible.

```ts
function run({ id, title }: RunParams) {}
```

Do not expand alias types mechanically unless doing so improves the code. Shared option types, worker request types, payload types, and cohesive context objects may remain aliases.

## Naidan callback and signature types

Naidan-owned callback types should also use one object parameter.

```ts
type ProgressListener = (status: string, progress: number) => void;
```

Fix:

```ts
type ProgressListener = ({ status, progress }: { status: string; progress: number }) => void;
```

Do not suppress a callback type just because the parameter type is external.

```ts
type ResizeHandler = (event: UIEvent) => void;
```

Fix:

```ts
type ResizeHandler = ({ event }: { event: UIEvent }) => void;
```

## Promise resolver and rejecter callbacks

Do not suppress based on the names `resolve` or `reject`.

For stored Promise callbacks, use native Promise types.

```ts
type PromiseResolve<T> =
  ReturnType<typeof Promise.withResolvers<T>>['resolve'];

type PromiseReject<T> =
  ReturnType<typeof Promise.withResolvers<T>>['reject'];
```

For both callbacks:

```ts
type PromiseCallbacks<T> = Pick<
  ReturnType<typeof Promise.withResolvers<T>>,
  'resolve' | 'reject'
>;
```

Example:

```ts
let resolvePromise:
  | ReturnType<typeof Promise.withResolvers<boolean>>['resolve']
  | undefined;
```

Instead of:

```ts
let resolvePromise: ((value: boolean) => void) | undefined;
```

For deferred objects:

```ts
type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;
```

Or with extra fields:

```ts
type PendingRequest = Pick<
  ReturnType<typeof Promise.withResolvers<PrivacyFetchResponse>>,
  'resolve' | 'reject'
> & {
  cleanup: () => void;
};
```

## DOM callback properties

Do not rewrite DOM callback types by hand.

Prefer DOM-owned property types.

```ts
private readonly storageHandler: NonNullable<Window['onstorage']> = (event) => {
  // external Window callback contract
};
```

Instead of:

```ts
private readonly storageHandler = (event: StorageEvent) => {
  // ambiguous local function type
};
```

For message handlers:

```ts
const onMessage: NonNullable<Window['onmessage']> = (event) => {
  // external Window callback contract
};
```

For element handlers:

```ts
const onImageError: NonNullable<HTMLImageElement['onerror']> = (event) => {
  // external HTMLImageElement callback contract
};
```

## requestIdleCallback and requestAnimationFrame

Avoid handwritten callback signatures in local object types.

Prefer DOM-owned types.

```ts
const requestIdleCallback:
  Window['requestIdleCallback'] =
    window.requestIdleCallback.bind(window);
```

For animation frames:

```ts
const requestAnimationFrame:
  Window['requestAnimationFrame'] =
    window.requestAnimationFrame.bind(window);
```

If a polyfill or test shim is needed, type it through the DOM property when possible.

```ts
const requestIdle:
  Window['requestIdleCallback'] =
    (callback) => window.setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 0 }), 0);
```

## Assignment RHS callbacks

Do not allow assignments just because they are assignments.

This is allowed only if the assignment target has an external callback type.

```ts
window.onresize = (event) => {
  // external Window callback contract
};
```

This is also good:

```ts
let onStorage: NonNullable<Window['onstorage']>;

onStorage = (event) => {
  // external Window callback contract
};
```

This should still be fixed as Naidan-owned:

```ts
type NaidanListener = (event: Event) => void;

let listener: NaidanListener;

listener = (event) => {
  // still Naidan-owned
};
```

Fix:

```ts
type NaidanListener = ({ event }: { event: Event }) => void;

let listener: NaidanListener;

listener = ({ event }) => {
  // ...
};
```

When the lint error says the assignment target needs an external callback type, do not disable the rule first. Type the assignment target with a verifiable external callback type.

## EventTarget listener adapters

`useEventTargetListener` intentionally mirrors `addEventListener` / `removeEventListener` and remains positional.

For short adapters, prefer inline positional adapter functions.

```ts
useEventTargetListener(window, 'keydown', (event) => {
  handleKeyDown({ event });
});
```

Avoid defining a separate positional function only to call a named-args function.

```ts
// Avoid this when it only adapts positional event to named args.
function handleWindowKeyDown(event: KeyboardEvent) {
  handleKeyDown({ event });
}

useEventTargetListener(window, 'keydown', handleWindowKeyDown);
```

Keep the real logic in named-args functions.

```ts
function handleKeyDown({ event }: { event: KeyboardEvent }) {
  // real logic
}

useEventTargetListener(window, 'keydown', (event) => {
  handleKeyDown({ event });
});
```

If the same function identity is required for both add and remove, use an external callback type.

```ts
const onStorage: NonNullable<Window['onstorage']> = (event) => {
  // ...
};

window.addEventListener('storage', onStorage);
window.removeEventListener('storage', onStorage);
```

## Interface extends external contracts

If an interface extends an external interface and redeclares the same method, prefer relying on the external base method when possible.

Allowed pattern:

```ts
interface LocalEventTarget extends EventTarget {
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
}
```

This is only safe when the method name exists on the external base type.

Do not use this as a blanket exception for new Naidan methods.

```ts
interface LocalEventTarget extends EventTarget {
  naidanMethod(value: string): void; // should use named args
}
```

Fix:

```ts
interface LocalEventTarget extends EventTarget {
  naidanMethod({ value }: { value: string }): void;
}
```

## Runtime-only external methods

If a method exists at runtime but not in the package's public TypeScript declarations, TypeScript cannot verify it as an external signature.

In that case, keep a precise disable comment.

```ts
interface JSZipObjectWithInternalStream extends JSZip.JSZipObject {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors JSZip's runtime internalStream API, which is not declared in the public JSZipObject type.
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}
```

Do not use vague comments such as:

```text
Kept positional because this is external.
```

## Comlink boundaries

Keep Comlink boundary methods positional when top-level arguments or proxied callbacks are required.

This applies to interfaces used with `Comlink.wrap<RemoteInterface>(...)` or objects exposed through `Comlink.expose(...)`.

Do not move `Comlink.proxy(...)` callbacks inside named-args objects.

Good boundary:

```ts
interface WorkerApi {
  run(
    request: RunRequest,
    progressCallback: (progress: ProgressInfo) => void,
  ): Promise<void>;
}
```

Good Naidan-facing facade above it:

```ts
async function run({
  request,
  onProgress,
}: {
  request: RunRequest;
  onProgress: ({ progress }: { progress: ProgressInfo }) => void;
}) {
  await remote.run(
    request,
    Comlink.proxy((progress) => {
      onProgress({ progress });
    }),
  );
}
```

## Existing focused exceptions

If a positional callable already has a precise local exception comment, preserve that reasoning when it is still accurate.

Do not broaden a local exception into a reusable category unless the same contract is verifiable from TypeScript types or from a documented runtime boundary.

Prefer converting the callable or proving the external contract over adding a new exception category.

## Disable comment requirements

Only use `eslint-disable-next-line local-rules-named-args/require-named-args` when the positional callable is one of:

```text
- true external API contract
- Comlink boundary that requires top-level arguments
- deprecated positional overload retained for compatibility
- runtime-only external API not represented in public TypeScript declarations
- intentionally external-compatible helper with a documented local reason
```

The reason must be specific.

Good:

```ts
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because Comlink proxy callbacks must remain top-level arguments.
```

Good:

```ts
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because deprecated positional overloads are retained for compatibility.
```

Good:

```ts
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors JSZip's runtime internalStream API, which is not declared in the public JSZipObject type.
```

Bad:

```ts
// eslint-disable-next-line local-rules-named-args/require-named-args -- TODO(named-args-design): decide whether this should be positional.
```

Bad:

```ts
// eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this is external.
```

## Checklist before finishing

Before returning a patch:

1. Search for new `require-named-args` disables.
2. Confirm no disable was added only because of a name like `resolve`, `reject`, `event`, `callback`, `start`, `write`, or `set`.
3. Convert inline object parameters like `params: { ... }` to destructured parameters.
4. Prefer `ReturnType<typeof Promise.withResolvers<T>>[...]` for Promise callbacks.
5. Prefer DOM-owned types like `Window['onstorage']`, `Window['onmessage']`, `HTMLImageElement['onerror']`, or `Window['requestIdleCallback']`.
6. Keep Comlink boundary methods positional, but keep Naidan-facing facades named args.
7. Keep runtime-only external exceptions narrow and explicit.
8. Confirm no `TODO(named-args-audit): mechanically suppressed` remains.
9. Confirm `TODO(named-args-design)` is rare and genuinely needs human design judgment.
10. Run the named-args rule tests and lint before finalizing.
