---
name: naidan-named-args-lint
description: Use this when fixing Naidan require-named-args lint errors. Prefer named args or verifiable external TypeScript types over eslint-disable comments. Includes safe patterns for Promise callbacks, DOM callbacks, platform-owned callback and mock contracts, assignment RHS callbacks, EventTarget adapters, Comlink boundaries, runtime-only external contracts, and external interface contracts.
---

# Naidan named-args lint fixes

Use this skill when `local-rules-named-args/require-named-args` reports an error.

The goal is not only to silence lint. The goal is to preserve Naidan's named-args API style while keeping true external API contracts positional.

## Core rule

Naidan-owned callables should use one destructured object parameter. Its explicit outer type must show the argument fields inline; an alias such as `({ id }: Args)` is not allowed.

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
options: { buffer: Uint8Array, offset?: number }
config: { endpoint: string, headers?: [string, string][] }
request: { url: string, signal?: AbortSignal }
```

When the original function stores the whole object, preserve behavior by rebuilding the object.

```ts
constructor({ endpoint, headers }: { endpoint: string, headers?: [string, string][] }) {
  this.config = { endpoint, headers };
}
```

## Explicit outer argument shapes

Do not use a type alias, interface, imported type, type parameter, `Parameters<...>[0]`, `Pick`, `Omit`, or a schema-inferred type as the outer annotation of a Naidan-owned destructured parameter.

```ts
// Not allowed, even though callers supply an object.
function read({ id, name }: ReadArgs) {}
```

Choose the fix from the callable's meaning, not from the type's name:

1. If the fields are independent named arguments, write the outer shape inline. Property types may still reference shared definitions.
2. If the callable consumes one cohesive value, wrap that value under a meaningful argument name instead of copying its fields into an argument bag.
3. For a shared callable contract, make the canonical signature inline and let contextually typed implementations infer their parameters when possible.
4. Keep real external callback and Comlink contracts unchanged. An external argument type alone does not prove external ownership.

```ts
function read({ id, name }: { id: ReadArgs['id'], name: ReadArgs['name'] }) {}
function copyPublication({ publication }: { publication: Publication }) {}
type Observer = ({ observation }: { observation: Observation }) => void;
```

Property-level indexed access is allowed. Preserve optional properties (`?`), readonly modifiers, explicit `undefined`, and discriminated-union correlations when converting an argument type. Do not change an optional field into a required field merely by spelling it as `field: Args['field']`.

For shared provider implementations, preserve the canonical input contract, including fields not destructured by that implementation. A private helper may use a narrower shape only after its callers have been checked. Do not remove a public option just because one implementation ignores it.

```ts
interface Reader { read({ id }: { id: string }): void }
const reader: Reader = { read({ id }) {} };
```

Do not remove a type annotation merely to bypass the rule when there is no real contextual signature. Class `implements` clauses alone do not provide contextual parameter types.

Inline object unions and intersections are allowed when every branch has a visible shape. Verified TypeScript `Readonly<{ ... }>` and Naidan `WorkerTransfer<{ ... }>` wrappers are allowed because they preserve the visible argument fields; nested aliases such as `Readonly<Args>` are not. Arbitrary `Wrapper<{ ... }>` types are not proof of a visible shape, and names that shadow the permitted wrappers are not exceptions.

Direct callbacks with a non-inline outer annotation require a verifiable external callable context, just like stored callbacks. For example, `items.map(({ id }: Item) => id)` keeps Array's positional callback contract; passing `({ id }: Args) => ...` into a Naidan-owned named-args callback contract is still reported. The parameter type's origin does not determine the callable's owner.

Abstract methods, ambient class members, and method overloads follow the same rule as implemented methods. An external method contract may be inherited by a class declaration or class expression; that inheritance does not make its constructor external.

For an explicit non-inline outer type, Web Streams and Vue setters also need a type-verified external contract. A local class named `ReadableStream` or a local function shadowing an imported `computed` binding is not an exception.

### Preserve behavior and layout

Inlining the outer type is a type-only change when the fields retain their original types and modifiers. Wrapping a cohesive value changes the calling convention: update its callers, callback consumers, and relevant tests together. Preserve any deliberate object-rest snapshot, validation-before-field-access, exception handling, and awaited callback delivery.

Do not add line breaks merely because an inline type makes a line longer. Keep one-line signatures on one line and preserve existing multiline structures where possible. Do not mix this migration with unrelated formatting.

This rule deliberately has no automatic fix or suggestion: deciding between an argument bag, a cohesive value, and an external contract requires semantic review.

The rule remains scoped to `src/**/*.ts` and `src/**/*.vue`, excluding `src/**/*.test.ts` and `src/**/*.spec.ts`. Test files may still be checked by other ESLint rules. Test call sites must still be updated when a production signature changes.

## Naidan callback and signature types

Naidan-owned callback types should also use one object parameter.

```ts
type ProgressListener = (status: string, progress: number) => void;
```

Fix:

```ts
type ProgressListener = ({ status, progress }: { status: string, progress: number }) => void;
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
  cleanup: () => void,
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


## Platform-owned callback and mock contracts

When a positional callback or mock mirrors a platform API, prefer typing it with the platform-owned contract instead of adding a disable comment.

For Node HTTP server callbacks, use the Node-owned listener type.

```ts
import type { RequestListener } from 'node:http';

const handler: RequestListener = (req, res) => {
  // external Node HTTP callback contract
};
```

For global `fetch` adapters, use the global fetch type.

```ts
const interceptedFetch: typeof self.fetch = async (input, init) => {
  // external fetch contract
  return fetch(input, init);
};
```

For DOM function shims, use the DOM-owned function type.

```ts
const mockScrollTo: typeof window.scrollTo = (_options, _left) => {
  // external scrollTo contract
};
```

For test doubles that mirror platform objects, implement the platform interface when TypeScript can verify it.

```ts
class MockFileSystemHandle implements FileSystemHandle {
  readonly kind: FileSystemHandleKind;
  readonly name: string;

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return this === other;
  }
}
```

Do not assume that implementing an external interface covers local constructors. Constructors are not part of TypeScript interfaces, so mock constructors remain Naidan-owned and should use named args unless they are intentionally preserving a deprecated or runtime-only positional contract.

```ts
class MockFileSystemDirectoryHandle implements FileSystemDirectoryHandle {
  constructor({ name }: { name: string }) {
    this.name = name;
  }
}
```

After adding `implements` for an external interface, run typecheck and add any required platform members to the mock. For example, `FileSystemDirectoryHandle` requires async iteration support.

```ts
async *[Symbol.asyncIterator](): AsyncIterableIterator<[
  string,
  FileSystemHandle,
]> {
  for (const entry of this.entries.values()) {
    yield [entry.name, entry];
  }
}
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
  ): void,
}
```

This is only safe when the method name exists on the external base type.

Do not use this as a blanket exception for new Naidan methods.

```ts
interface LocalEventTarget extends EventTarget {
  naidanMethod(value: string): void, // should use named args
}
```

Fix:

```ts
interface LocalEventTarget extends EventTarget {
  naidanMethod({ value }: { value: string }): void,
}
```

## Runtime-only external methods

If a method exists at runtime but not in the package's public TypeScript declarations, TypeScript cannot verify it as an external signature.

In that case, keep a precise disable comment.

```ts
interface JSZipObjectWithInternalStream extends JSZip.JSZipObject {
  // eslint-disable-next-line local-rules-named-args/require-named-args -- Kept positional because this method mirrors JSZip's runtime internalStream API, which is not declared in the public JSZipObject type.
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>,
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
  ): Promise<void>,
}
```

Good Naidan-facing facade above it:

```ts
async function run({
  request,
  onProgress,
}: {
  request: RunRequest,
  onProgress: ({ progress }: { progress: ProgressInfo }) => void,
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
6. Prefer platform-owned function types like `RequestListener`, `typeof self.fetch`, or `typeof window.scrollTo` for platform callback shims.
7. Prefer `implements` for external platform object mocks, then typecheck and add missing required members.
8. Keep local mock constructors named args unless they intentionally preserve a deprecated or runtime-only positional contract.
9. Keep Comlink boundary methods positional, but keep Naidan-facing facades named args.
10. Keep runtime-only external exceptions narrow and explicit.
11. Confirm no `TODO(named-args-audit): mechanically suppressed` remains.
12. Confirm `TODO(named-args-design)` is rare and genuinely needs human design judgment.
13. Check explicit outer types for aliases and derived types; keep shared property types and verified external contracts.
14. Preserve existing line breaks instead of vertically expanding inline types.
15. Run targeted named-args rule tests, relevant consumer tests, lint, and typechecks before finalizing; do not run project-wide checks without permission.
