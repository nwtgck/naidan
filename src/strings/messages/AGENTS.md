# Boundary Strings message rules

Message directories and catalog properties must use this format:

```text
<scope>__<natural_english_like_message>
```

The directory name, English catalog property, every locale catalog property,
and properties accessed after `lazyStrings.` or `ensureStrings.` must match exactly.
Every message directory must be registered in every locale catalog. Application
code must not import locale catalogs or message implementation modules directly.

## Scope ownership

Choose the smallest stable unit that would be removed together. If removing a
component, composable, or feature would remove a group of messages at the same
time, those messages belong to the same scope. If some messages could remain
after that removal, they need a different scope. Copy decisions and movement
should normally follow the same ownership boundary.

* Use an existing Vue component identifier for component-owned copy, preserving
  PascalCase, for example `ChatInput` or `SettingsModal`.
* Use an existing composable or function identifier for workflow-owned copy,
  preserving camelCase, for example `useChatLifecycle`.
* Use lowerCamelCase for a removable feature made of multiple source files,
  for example `fileExplorer` or `weshTerminal`.
* Do not use broad scopes such as `chat`, `settings`, or `common` merely because
  messages are in the same product area or currently have identical English.

The scope describes copy ownership. It does not describe a Vite chunk or force
messages from different scopes into different output files.

## Accessor selection

`lazyStrings` intentionally returns `string | undefined`. The unresolved value
is a design signal requiring the call site to choose an appropriate contract;
it is not a type error to suppress locally.

Use `lazyStrings` only where Vue or another reactive path will evaluate the
message again after its boundary loads, such as a template or computed value.
Use `ensureStrings` when a completed string is stored, emitted, passed to an
imperative UI API, written into an event, or otherwise will not be revisited by
a reactive render. Do not use test-wide eager string installation to hide an
incorrect accessor choice.

Do not use `Promise.all` to resolve multiple `ensureStrings` calls. Their
results are usually all `string`, so an ordering mistake can remain type-correct
while assigning the wrong copy to a title, message, button, or other field.
Messages referenced from the same source module normally share a Boundary pack,
so after the first `ensureStrings` call loads it, the remaining calls resolve
without another pack load. Await each message at its named use site instead,
preserving the original object and expression shape whenever practical.

This restriction is specific to using `Promise.all` for `ensureStrings`. It is
not a general prohibition on `Promise.all`; for other asynchronous work, decide
whether concurrency is appropriate from the surrounding design.

Do not weaken an existing API to accept `undefined`, add `?? ''` or `|| ''`, or
use a type assertion or non-null assertion merely to accept a `lazyStrings`
result. Instead, keep the use reactive, await `ensureStrings`, or explicitly
defer the operation or UI until the message resolves.

Adding `async` for `ensureStrings` is acceptable only when the change remains
local and does not alter an existing public, callback, event, parser, getter, or
other synchronous contract. Do not force asynchronous behavior through callers,
use `.then()` or a fire-and-forget async wrapper to avoid a contract decision,
or convert a value API to `ComputedRef` or a getter solely to bypass the error.
Reactive arguments require a review of the consumer, storage, rendering,
lifetime, and tests because they are a different API contract.

When localization requires such a wider redesign, leave the existing English
copy in place and add this exact searchable marker with a concrete reason:

```typescript
// TODO(strings-localize): Localize this copy after the synchronous callback contract is redesigned.
```

Do not add this marker to intentionally English Wesh command output,
diagnostics, shell transcript content, or raw worker errors.

## Shared copy ownership

`SHARED__` is a reserved scope for copy whose future wording changes must
intentionally propagate to every call site using the key. It is not a fallback
for messages whose owner is unclear, and it must not be used merely to remove
duplicate implementations or because multiple call sites currently have the
same English text.

Before creating or reusing a `SHARED__` key, verify all of the following:

* Every call site represents the same product concept.
* The message has the same meaning in every supported locale.
* A future wording change should intentionally affect every call site.
* No call site is expected to evolve independently.

If any condition is uncertain, use an owner-specific scope. If one call site
later needs independent wording, split that call site into an owner-specific
key instead of weakening or contextually overriding the shared message.

Existing user-facing constants are strong evidence that copy was intended to be
shared, but inspect every use before migration. A constant may have accumulated
semantically different uses over time. Preserve sharing only when the call sites
still represent one product-level copy decision.

All `SHARED__` imports and catalog properties must appear before owner-specific
keys in every locale catalog. Each catalog must keep the warning comment at the
start of the shared group directing contributors to this file.

## Natural-language suffix

The suffix after `__` must be lowercase snake_case derived from the existing
English UI message. A reader should be able to predict the likely message from
`lazyStrings.<key>` or `ensureStrings.<key>` without opening the locale file.

Do not use abstract role-only suffixes such as `confirmation`, `error_message`,
or `button_label`. Punctuation, minor tone, and incidental wording do not need
to be copied into the key. Do not reproduce an entire sentence when that makes
the identifier unwieldy. Use the shortest natural-English phrase that still
preserves the distinguishing meaning and lets a reader predict the message.
For example, prefer `SettingsModal__discard_unsaved_connection_changes` over a
key that copies the full confirmation sentence. Avoid opaque abbreviations.
Keep a key for minor copy edits; change it when the meaning or ownership changes
materially.

## Language and Wesh boundary

Identifiers, comments, and tests remain English. Locale message implementations
may contain their target natural language.

Prefer direct, neutral Japanese UI copy over formal business-style phrasing.

Naidan UI around Wesh is eligible for Boundary Strings. Wesh command output,
usage text, diagnostics, shell transcript content, and raw worker errors remain
English and must not be moved into this directory.

## Module exports and implementation style

Each locale module must use a named export whose identifier exactly matches the
message directory and catalog key. Individual message modules must not use a
default export. Message functions must return `string` synchronously. Do not add
`async` message functions or `Promise<string>` results; asynchronous localization
requires a separate API because `lazyStrings` returns `undefined` until a pack is
available.

Do not import the English message type into every locale module and do not add
per-message `satisfies` expressions. Each locale implementation declares its
own parameter and return types, while `src/strings/catalogs/<locale>.ts` uses
`satisfies Strings` as the single catalog-wide compatibility check. This keeps
adding a translation to one small file and avoids repetitive type-import noise.

Prefer a compact `export const` arrow function when the message is a direct
string or template expression. Keep the destructured parameter and its inline
object type on one line, including for block-bodied functions.

```typescript
export const ChatInput__failed_to_copy = ({ name, errorMessage }: { name: string; errorMessage: string }): string => (
  `Failed to copy "${name}": ${errorMessage}`
);
```

When the entire declaration fits comfortably on one line, do not add
parentheses around the returned expression.

```typescript
export const ChatInput__remove = (): string => 'Remove';
```

When an arrow function returns an expression on the following line, wrap that
expression in parentheses. Use `function` only when message construction needs
substantial branching, multiple intermediate values, explanatory comments, or
a parameter list that is too large to remain readable as a compact arrow
function. Even then, keep the destructured parameter and inline object type on
one line unless doing so would be exceptionally difficult to read.

Generated catalogs and virtual packs must preserve message identifiers. Use
single-line named imports or named re-exports. Do not generate information-free
aliases such as `message0`, `message1`, or similar numbered names.
