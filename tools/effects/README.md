# Static effect contracts

This is a **scoped production implementation**, not a claim that all Naidan
functions, browser operations, worker protocols or Vue components are covered.
The eventual product scope remains all functions and methods, except that ordinary
`.test.ts` files do not require effect annotations. Scope expansion is explicit.

No effect tokens, wrappers or runtime permission objects are added to the app.
The application changes in this implementation are comments only.

## Commands and rollout

```sh
npm run effects:check
npm run effects:fix
npm run effects:tidy               # Preview only
npm run effects:tidy -- --write     # Explicit maintenance
npm run lint:fix -- src/utils/opfs-detection.ts
npm run typecheck:effects
npm run test:effects
```

The initial entries in `effects.config.ts` are:

- `src/utils/opfs-detection.ts`
- `src/utils/ollama-detection.ts`
- `src/composables/useCodeBlockSettings.ts`
- `src/composables/useStoragePersistence.ts`
- `src/composables/useLayout.ts`
- `src/composables/useOverlay.ts`

Only those entries and their local static dependencies are traversed. A file being
included in another TypeScript project does not automatically enroll it. Local
functions and callbacks in an enrolled module are checked independently, even when
not reached from an exported entry. Test modules are excluded; importing one from a
product module is a diagnostic, not a pure boundary.

For a deliberate local experiment, entries can be overridden without changing the
checked-in rollout:

```sh
npm run effects:check -- --file src/path/to/module.ts --json
```

An override follows dependencies and may therefore uncover unsupported constructs.
Do not add an ignore or a false `none` declaration merely to make an entry pass.

`check` exits with 0 for no diagnostics, 1 for diagnostics, and 2 for configuration
or input failures. `fix` exits with 0 after a verified update (including no changes),
and 2 if planning or validation is refused. JSON mode emits coverage, assumptions,
diagnostics, contracts and `unsafeSuppressions` for a completed analysis; command failures go to stderr.
Successful text-mode checks also list every unsafe suppression, so a zero-diagnostic
result is not presented without its explicit exceptions.

## Integrated lint fixes and optional declaration maintenance

`npm run lint:fix -- <paths...>` now runs three explicit phases:

1. ESLint's ordinary fixes, deferring only `local-effects/contracts`.
2. The shared widening effect fix, if a linted file belongs to the configured
   effects project. This updates the **complete enrolled dependency scope**,
   including affected callers and dependencies outside the ordinary lint paths.
3. Fresh, non-fixing ESLint validation with the effects rule enabled, covering
   both the ordinary linted files and the affected effects scope.

No arguments selects `.` for ordinary lint (as before). Explicit paths replace
that default instead of implicitly linting the whole repository. Supported flags
are `--max-warnings`, `--effects-config`, and `--json`; this entry point is not a
transparent wrapper for all ESLint flags. Use direct ESLint for unrelated flags.
The independent `effects:check` and `effects:fix` commands remain available.
ESLint editor single-file fixes still do not perform project-wide effect edits.

Ordinary unfixable errors, configuration failures, unsupported effect boundaries
and final validation errors are not ignored. Each ESLint phase runs in a fresh
process so typed parser/config caches cannot describe pre-edit source. There is
no subprocess per file, broad `|| true`, or effect propagation via ESLint's fix
iteration count. Ordinary fixes may already be written when a later phase fails;
this is explicitly **not** an all-or-nothing repository transaction. Effect edits
retain the guarded multi-file validation described below. Unsafe boundaries
remain visible. Tests do not run the full application lint implicitly.

`tidy` is separate from normal checking and widening fixes. Excess valid
permissions are not ordinary diagnostics.

```sh
npm run effects:tidy -- --file src/utils/ollama-detection.ts --json
npm run effects:tidy -- --file src/utils/ollama-detection.ts --write
```

Without `--write`, source files are never edited. JSON contains the planned
before/after source, contract changes and the reason each owner is selected or
preserved. Its analysis describes the projected source, not a claim that preview
has changed the files. `--file` narrows only the tidy selection: the configured
project and all reached dependencies are still validated.

The initial tidy implementation targets **function declarations with checked
bodies** in the selected files. Callable variable/property slots, methods,
signature contracts, expression-owned callbacks, modules and unselected files
remain fixed, even when their current initializer does nothing. It is not a
global rewrite of every contract or a deletion of `none` annotations. Exported
function declarations in an explicitly selected file can be narrowed; callers
outside the configured project are not inspected. Extending owner selection
requires explicit compatibility tests.

Tidy first requires a clean ordinary check. It clears only selected declaration
seeds and recomputes the least fixed point from operations, assignments, callback
dependencies and preserved boundaries, including cycles. Cleanup summaries are
rebuilt using the same lowered seeds. Non-effect conditions, worker bindings,
resource information and `@effectsUNSAFE` text/reasons are not discarded. An
exception made stale by the candidate is a refusal, not an automatic deletion.

Before either preview or write, the candidate is type/effect checked, checked for
an empty subsequent widening fix and an empty second tidy, and checked for
unchanged executable tokens. Input snapshots and model pins must still match.
Only the explicit selection can be edited. A missing/invalid contract,
unsupported call or boundary, unknown value, or incomplete analysis does not
become `none` through maintenance. Run `effects:fix` and resolve diagnostics
before requesting tidy; tidy is never invoked by `lint:fix`.

## Reviewing surprising effects

```sh
npm run effects:check -- --explain
npm run effects:check -- --explain --json
```

`--explain` is opt-in. For every selected contract it lists the declared and
computed outward upper bounds and one bounded dependency witness per effect.
Modeled-operation leaves include the native operation and its source position;
ordinary calls, assignments, callback substitutions and worker connections retain
edges after comments have been fixed. A deliberately wide annotation can instead
be the leaf: this is labeled `declared-upper-bound`, not an observed operation.
Variable-bound arrows use the binding name in reports.

Witnesses are **not runtime execution traces**, proof of reachability, or automatic
judgments of what a user considers unexpected. Diagnostics, trusted models and
`unsafeSuppressions` remain visible. Suppressed operations do not leak into public
witnesses, and an explicit review budget produces `truncated` rather than an empty
or verified trace. This optional report does not change check/fix decisions. Its
per-effect graph search is not a persistent incremental analysis implementation.

When a result is surprising, distinguish:

- an incorrect operation model (fix the model and add a regression);
- an intentional upper bound or coarse taxonomy (review the design);
- actual operations in the body (review the application behavior);
- missing support (a diagnostic, not an empty effect).

Do not add an unsafe exception merely to make a surprising result disappear.
Ordinary fixes continue to widen existing annotations only; correcting a false
positive model does not automatically shrink an already broad user contract.

### Inspecting browser metadata versus performing I/O

The modeled native receiver is resolved through TypeScript declarations before
these operation names are matched. In particular:

- `indexedDB.cmp` compares supported scalar keys without storage effects.
  `databases` reads metadata; it does not write. `open` can create/upgrade a
  database and retains read/write. `deleteDatabase` requires write, not read.
- Constructing an `XMLHttpRequest` does not acquire a resource. Reading response
  headers and setting request headers/MIME configuration add no network effect.
  `send` requires HTTP. `open` and `abort` retain the HTTP bound because they can
  terminate an existing fetch; the checker does not reconstruct request history.
- Converting unsupported arguments is still a diagnostic even for these no-I/O
  operations. Explicit argument expressions are always analyzed. Unknown native
  members are not accepted just because their receiver belongs to one of these
  families. Detailed IndexedDB request lifecycles are still not modeled.

Sources: [Indexed Database API](https://www.w3.org/TR/IndexedDB/),
[XMLHttpRequest Standard](https://xhr.spec.whatwg.org/).

## Explicit image acquisition and navigation

The first DOM slice handles `new Image()`, the built-in `document.createElement('img')`
without custom-element options, direct/computed `src` assignments, and the exact
`setAttribute('src', value)` operation. These map to executable definitions in
`models/browser/dom.ts`, alongside their policy rationale and argument/result guards.
Other DOM operations are not covered by a blanket no-effect policy.

`models/browser/url-target.ts` uses the standard URL parser, not URL prefix matching.
HTTP/HTTPS image acquisition and navigation require `network.http(*)`, including
same-origin servers. File URLs require `hostfs.read(*)`. Relative references retain
both hosted HTTP and standalone file candidates; leading `/`, backslashes, queries,
and fragments do not prove an in-memory resource. This is a conservative deployment
upper bound, not a prediction that both operations always happen.

Passive `img` decoding of known blob/data URLs has no additional external effect.
`URL.createObjectURL` retains evidence for an evaluated Blob/File URL through direct
immutable const bindings. File acquisition and `fetch` retain their own earlier
read/network effects. `Response.blob()` and `getFile()` now retain a Blob/File result
instead of losing that identity. Creating a memory Blob is distinct from storage;
this slice requires fresh literal part arrays with supported passive elements.

The same exemption does **not** apply to opening a Blob/data document or executing
script. Such navigation, custom schemes, script/custom element construction, srcset,
HTML insertion, and arbitrary event attributes remain unsupported. Explicit HTTP/file
`window.open`, `location.assign`/`replace`, and `location.href` writes are modeled.
`open()` with no statically classified destination and general WindowProxy use are
not certified merely because a popup might be blocked or blank.

Type assertions and literal types do not manufacture URL evidence. Mutable variables
and object fields (including reflected fields used for spread) do not retain their
initial URL or fresh-image state. This deliberately diagnoses some valid programs
instead of requiring mutation-history analysis. Passing an arbitrary string through a
parameter/return or reading a stored source does not prove its scheme. Ordinary unknown
strings retain candidate effects and a blocking diagnostic, not an empty upper bound.

A preexisting `HTMLImageElement` may select a `srcset`/`picture` candidate even when
its `src` is a Blob URL. Source activation therefore requires a proven fresh image
whose other acquisition paths have not been accepted implicitly. A TypeScript image
type alone cannot provide that proof. Shared object storage loses this fresh-image
refinement; it does not resurrect through a shallow copy after replacement.

The standalone TypeScript fixtures cover local/network acquisition, source evaluation,
coercion refusal, shadows, casts, writable aliases, copies, caller propagation,
unsafe boundaries and explicit tidy. The default six application modules are unchanged;
this is not Vue template support or an audit of all application images. Browser probes
in the handoff are separate from checker fixture tests; network acquisition was blocked
by the sandbox's administrator policy, while the in-memory Blob probes were executable.

Sources: [HTML images](https://html.spec.whatwg.org/multipage/images.html),
[URL Standard](https://url.spec.whatwg.org/),
[File API](https://w3c.github.io/FileAPI/).

## Contract semantics

A declaration is an **upper bound**, not a list of operations that must occur.

```ts
const actions = {
  /** @effects `localstorage.read(*)`, `localstorage.write(*)` */
  run: () => {},
};

/** @effects `localstorage.write(*)` */
function save() {
  localStorage.clear();
}

/** @effects `none` */
function install() {
  actions.run = save;
}

/** @effects `localstorage.read(*)`, `localstorage.write(*)` */
function execute() {
  actions.run();
}
```

The empty initial function and `save` both fit the slot. Installing a function does
not execute it. Calls use the slot's stable public upper bound, not the effect of
whichever implementation happens to be there today. The checker does not reconstruct
all assignment histories or try to prove invocation order.

The central constraints are:

```text
body requirements       <= function contract
assigned function       <= destination callable contract
called contract         <= caller contract
```

Mutable shared slots additionally require compatible read and write views. A function
with fewer effects may be stored in a wider slot; the slot itself may not be aliased
as a different writable contract. Callback parameters are contravariant and returned
function contracts are covariant. Ordinary TypeScript checking runs separately and
cannot substitute for these checks.

Symbolic callback rows such as `call(arg0.operation)` are instantiated at each call
site. A read callback and a write callback do not contaminate each other's callers.
Not every generic signature or forwarding shape is implemented: unsupported cases
are diagnostics and block fixing. Argument-number syntax remains a local initial
syntax, not a promise that the final public notation cannot evolve.

`none` means no operation in the **defined tracking scope**. It does not mean
mathematical purity, determinism, no memory allocation or no exceptions. Normal
memory changes and computation do not receive storage effects. Vue's reactive
causality is not propagated back to a state setter. Watch callbacks are checked
independently by the reviewed TypeScript-only Vue model described below. `.vue`
(single-file component) files are still outside this implementation.

## Comment syntax

Use a separate, dedicated documentation comment, adjacent to the callable or slot:

```ts
/** Existing explanation stays unchanged. */
/** @effects `opfs.read(*)`, `opfs.write(*)` */
async function save() {
  // ...
}
```

One code span contains one effect. Newlines between items are supported. Comma and
ampersand separators both mean the same upper-bound set, but cannot be mixed in a
single declaration. The printer uses commas. `none` must be the only item.

The TypeScript scanner finds the actual comment ranges. A bounded recursive-descent
parser reads the effect expressions, including resource strings and callback paths.
There is no regular-expression tag extraction, comma splitting, `eval` or generated
runtime expression. Unknown names, malformed terms, duplicate dedicated declarations
and unbound callback references are diagnostics. Resource strings support JSON
escapes; the printer escapes backticks and the JavaScript comment terminator.

Free-form prose and fenced examples are not interpreted as contracts. The initial
reader deliberately does **not** parse general mixed TSDoc documents. An annotation
inside prose is not a supported declaration, so the callable still has a missing
contract; fixing inserts a separate dedicated declaration and preserves the prose.
A dedicated declaration containing trailing prose is rejected. General document
parsing is a separate follow-up; this implementation does not pretend that
TypeScript's JSDoc tag reader understands all Markdown structures.

## Explicit, selective unsafe suppression

Use this conspicuous opt-in only when an operation is intentionally hidden from a
function's callers. It is a reviewed abstraction boundary, **not** a proof that the
implementation performs no input/output. The implementation remains fully checked
within the supported analysis scope.

```ts
/** @effects `none` */
/**
 * @effectsUNSAFE `opfs.read(*)`, `opfs.write(*)`
 * -- "Capability probe only; temporary-file creation/removal is intentionally hidden from callers. Cleanup remains best-effort."
 */
export async function checkOPFSSupport(): Promise<boolean> {
  // The existing probe body still reads, creates and removes its temporary file.
  // ...
}
```

The ordinary `@effects` describes the **remaining public upper bound**. The
separate `@effectsUNSAFE` lists specific registered operation effects to suppress,
followed by `--` and exactly one nonblank JSON string explaining the exception.
The reason must be a single line of at most 2048 UTF-16 code units. Commas or
ampersands are supported, as for ordinary declarations; do not mix separators.
`none`, global wildcards, unknown operation names and symbolic `call(...)` terms
are not valid suppression entries. A resource wildcard such as `opfs.write(*)`
only covers that operation family, but covers **all** resources in that family.

The data flow is:

```text
checked body requirements
  -- subtract explicitly suppressed operations --> public callable contract
  -- normal call/assignment rules --> consumers
```

The filter is attached only to the checked implementation-to-public edge. It is
not attached to a variable, object property or interface as a general exemption.
Consequently:

- Adding an unlisted HTTP request still changes the function and its callers.
- Replacing a function-valued property later does not exempt the replacement.
  Its public contract must fit the destination exactly as before.
- A returned callback retains its own effects. Merely enclosing it in an unsafe
  function does not suppress the callback's later invocation.
- Called helpers and nested callbacks are checked independently. An unsafe caller
  cannot excuse an invalid helper contract, an unknown call, a type error, a bad
  worker connection, or unsupported syntax.
- Default parameter initializers and finally blocks are part of the body analysis;
  the exception is not limited to explicit statements in the function block.

A directive may accompany a checked function declaration, function expression or
arrow implementation, including an inline implementation in a property. A directive
on a signature, scalar, alias, assignment statement or module is a diagnostic, not a
scope-wide exemption. An adjacent dedicated public declaration is still required;
`effects:fix` may add it when the rest of the input is valid.

### Review, fixes and initial restrictions

Each analysis reports the owner's location, reason, specified masks, body requirements
before this boundary, actually suppressed effects and outward contract. The body's
requirements already respect any separately reviewed unsafe callees; they are not an
absolute reconstruction of every physical operation. The project-level assumptions
also list each explicit exception. A caller with `none` can therefore rely on a
reviewed exception rather than on the physical absence of storage or networking.

Ordinary fixing **never creates, widens, rewrites or removes** an unsafe directive or
its reason. It can still widen the remaining public contracts and their callers.
The initial implementation rejects unused suppression entries (stale exceptions),
overlap between the public declaration and the suppression list, and a symbolic
callback row remaining at an unsafe boundary. Concrete callback effects obtained by
calling a helper are supported; generalized subtraction from an unbound effect
variable is not. Fixing refuses these diagnostics instead of silently changing the
reviewer's decision. To stop suppressing an operation, explicitly remove that entry
(and the directive if empty), then run the ordinary widening fix.

The checker does **not** verify that a reason is truthful, a temporary file is always
removed, or `opfs.write(*)` is restricted to a probe filename. The real OPFS probe has
best-effort cleanup and can leave its temporary file after a removal failure. A later
write of the same listed kind would also be suppressed at this boundary; that remains
a review obligation. Narrow wrappers are preferable to large unsafe functions.
Nothing is erased from the runtime behavior by this annotation.

## Architecture

| Area | Responsibility |
| --- | --- |
| `syntax/` | Comment ownership, expression grammar and safe printing |
| `contracts/` | Upper-bound sets, coverage and canonical representation |
| `analysis/` | TypeScript identities, callable/slot/value contracts, compatibility and fixed-point propagation |
| `models/` | Effect registry and explicitly supported native/foreign operations |
| `bridges/` | Evidence for literal worker entry connections |
| `project.ts` | Scoped TypeScript program, configuration, reviewed-model pins and input snapshots |
| `fixes/` | Whole-analysis edit plan, source conflicts and bounded rollback |
| `index.ts` | Shared check/fix orchestration |
| `cli.ts` | Validated configuration and command output |
| `eslint-local-rules/effects.ts` | Thin typed lint integration using the same analyzer |

ESLint imports the TypeScript rule once through the existing `tsx` development
dependency. It does not spawn a checker for every file or install an app runtime.
Results are shared by TypeScript Program identity. Reviewed models and disk snapshots
are rechecked, and editor/Program mismatches are reported rather than reused silently.
The initial integration is a saved-file check; it does not promise full unsaved editor
project virtualization.

ESLint reports diagnostics, but does not provide a multi-file rule fixer.
`effects:fix` computes the full transitive change once. ESLint's fix-loop iteration
limit is not the propagation algorithm. Ordinary `lint:fix` does not automatically
widen contracts across the repository.

## Browser and library models

The registry recognizes storage read/write families for OPFS (Origin Private File
System), host file systems, IndexedDB, localStorage, sessionStorage, Cache Storage and
cookies. It also recognizes HTTP (Hypertext Transfer Protocol), WebSocket, WebRTC
(Web Real-Time Communication), WebTransport, storage metadata/persistence requests and downloads.
**Registering an effect name does not implement all of its entry points.**

Implemented local models include Web Storage methods/property writes, explicit
cookie reads/writes, OPFS root and handle operations, representative network entry
points, limited Cache Storage and IndexedDB entry points, Promise continuations,
locks, timers and selected scalar operations. An unknown member or lifecycle is not
made pure by being in a familiar API family. For operations with result types not yet
modeled, further use of the result is diagnosed.

File-system provenance is retained where known. A generic file handle with unknown
origin conservatively requires both OPFS and host-file-system effects. Read does not
imply write, or vice versa. Create-capable handle lookup includes write. The initial
native operations use wildcard resources; literal resources are syntax and subset
support, not an implemented path-provenance proof.

String/numeric conversion can execute user hooks. Unknown conversions, getters,
custom thenables, reflective writes, unconstrained object replacements and unsupported
iterators are diagnosed instead of erased. Known const aliases retain own-property
information for reflection. A structural type that hides a member does not prove the
member is absent at runtime. General open-shape serialization and arbitrary heap
history reconstruction remain unsupported.

External models are explicit trust boundaries identified by exact declaration paths,
export names and reviewed-file SHA-256 (Secure Hash Algorithm, 256-bit) digests.
Digests detect changed inputs; they do not prove model correctness. Global builtins,
standard-library declarations and reviewed models are assumed not to be monkey-patched.
This is a review and maintenance tool, not a security sandbox for adversarial runtime
code or an information-flow security proof.

### Auditable primitive decisions, including intentional none

The native browser operation definitions live in `models/browser/`, immediately
next to their argument guards and return-value models. They are typed executable
TypeScript, not a separate policy/configuration language or a second handwritten
list of effects. `browser/operations.ts` only indexes these definitions.

An `OperationRule` contains:

- an exact operation target and access kind (`call`, `construct`, `read`, `write`);
- its `tracked`, `conditional`, or `intentional-none` policy and a required rationale;
- argument/return handling in `evaluate`, with access to diagnostics and native
  values but **without** an effect-emission or argument-invocation hook;
- the defining module's `import.meta.url`, so audit output points back to the code.

The analyzer still owns TypeScript symbol resolution, alias resolution and handle
provenance. A local function named `fetch` or an arbitrary object's `write` method
is not matched as a browser primitive just by its text. Receiver/key/argument
expressions are evaluated before policy application. Binding reads such as
`const { cookie } = document` use the same property rule as `document.cookie`.

The dispatcher emits only the selected effects, then runs the rule's guards and
value model. Conditional rules declare an effect envelope; an implementation that
returns effects outside it fails loudly. Empty tracked lists, missing rationales,
duplicate targets and duplicate rule identities are rejected. No matching rule is
**not** the same as a rule explicitly selecting none: unsupported operations keep
diagnostics, and fixes cannot erase them.

Read these files to audit primitive behavior:

| File | What it owns |
| --- | --- |
| `models/browser/storage-manager.ts` | The intentional storage accounting/retention boundary, beside `getDirectory` |
| `models/browser/web-storage.ts` | Web Storage methods/length/property writes and explicit cookie reads/writes |
| `models/browser/file-system.ts` | Handle provenance, content reads/writes, and conditional creation |
| `models/browser/network.ts` | Fetch, connection/request acquisition, and response consumption |
| `models/browser/metadata.ts` | IndexedDB factory and XMLHttpRequest operation-level decisions |
| `models/browser/cache-storage.ts` | Explicit cache reads, writes, and combined fetch-and-store |

This covers the browser primitives implemented in this slice, **not** all browser
APIs. JavaScript callback semantics, external-library models and Vue/worker bridges
remain separate. They do not get a new blanket exemption. Transport methods and
filesystem entries are explicitly enumerated; unlisted members are unsupported.

`effects:check -- --explain` prints selected primitive rules even when their effect
list is empty. With `--json`, `modelDecisions` includes the use site, definition file,
rule ID, reason, disposition and modeled effects. Shape discovery is not execution
and does not create duplicate decision entries. These entries document a selected
policy, not that all its guards succeeded: read diagnostics, assumptions and unsafe
suppression reports alongside them. Stored origin witnesses include the rule ID.
The list is not a runtime execution trace or a proof of browser purity.

### Storage accounting and retention are intentionally outside tracked I/O

The current contract vocabulary emphasizes application-content reads/writes and
network I/O. These explicit exclusions are defined locally in
`models/browser/storage-manager.ts`, not scattered across application callers:

| Operation | Policy | Why |
| --- | --- | --- |
| `navigator.storage.persisted()` | intentional none | Browser persistence status, not stored application content |
| `navigator.storage.estimate()` | intentional none | Browser usage/quota accounting, not content access |
| `navigator.storage.persist()` | intentional none | Retention/permission policy; intentionally outside this content-I/O vocabulary |
| `navigator.storage.getDirectory()` | `opfs.read(*)` | Content root access is still tracked |

`persist()` can request permission and change retention policy. None means
**outside the selected effect vocabulary**, not inert or mathematically pure.
It is not a backup guarantee or protection from user-initiated deletion. See the
[Storage Standard](https://storage.spec.whatwg.org/).

`estimate()` still returns an open shape with scalar `usage`/`quota`; arbitrary
extension enumeration remains unsupported. No-argument methods do not perform
argument conversion, but any extra argument expression is evaluated and ordinary
TypeScript errors still block fixing. A callback's body is independently checked.

The unreleased `storage.manage`, `storage.metadata.read` and
`storage.persistence.request` names are no longer registered. No alias silently
maps old contracts or unsafe directives to none. The enrolled
`requestPersistence()` and its factory both declare none; this is an intentional
reviewed source change, not an automatic shrinking rule. Ordinary widening fixes
preserve other valid, deliberately wide upper bounds. Per-function `@effectsUNSAFE`
remains a separate, conspicuous exception and is not needed for these three APIs.

### File-system creation options

A fresh `create: false` literal remains read-only through grouping, `as`, and
`satisfies`; these wrappers do not change the value. Options are evaluated before
classification, so `void fetch(...)` still contributes the network operation even
though its resulting options value is absent. A later spread may replace an earlier
`create: false`; only an explicit final false property after all possible overwrites
is sufficient to exclude creation. Unknown option shapes are still diagnosed.

A mutable alias initially containing `create: false` is **not** frozen at its initial
value. Such aliases retain read/write unless an immutable option contract is proven.
This limitation remains visible rather than introducing mutation-history analysis
or adding runtime `Object.freeze` calls to application code.

## Reviewed Vue boundaries in TypeScript

`vueModels` selects exact reviewed declaration files with content digests. Supported
operations are identified by their resolved declaration, not by spelling `ref` or
`watch`. A package update that changes those declarations requires model review and
pin updates. These pins detect changed assumptions, not implementation correctness.
The pinned dependency set used for the runtime probes is Vue 3.5.39; it is not a
claim about the latest available version or all Vue configurations.

The current model supports scalar `ref` and `shallowRef` creation, reads and writes;
`watch` with a proven scalar ref or scalar getter source; zero-argument watch effects;
selected default-scope lifecycle registration; `onWatcherCleanup` and `onScopeDispose`.
Object refs, custom refs, source arrays, debug hooks, positional cleanup arguments,
component rendering and general callback forwarding are not silently certified.

```ts
const name = ref('');

/** @effects `none` */
function setName({ value }: { value: string }) {
  name.value = value;
}

/** @effects `localstorage.write(*)` */
function install() {
  watch(name, /** @effects `localstorage.write(*)` */ value => {
    localStorage.setItem('name', value);
  }, { flush: 'sync' });
}
```

This boundary is independent of scheduling. Even a synchronous watcher does not
add its effect to `setName`, but its callback body must satisfy its own contract.
An explicit call to that callback does propagate normally. Registration conservatively
carries the callback/source/cleanup lifetime upper bound; it does not mean all of
those operations run immediately. Registering a watcher is not equivalent to an
arbitrary higher-order function that may be assumed never to call its callback.

Watcher control distinguishes the operation being performed:

| Operation | Propagated contract |
| --- | --- |
| Registration | Source, callback and cleanup lifetime upper bound |
| Direct stop or `handle.stop()` | Registered `onWatcherCleanup` functions only |
| `handle.pause()` | No additional operation |
| `handle.resume()` | Source, callback and cleanup lifetime upper bound |

A writing callback with no registered cleanup no longer makes stopping the watcher
write. A cleanup that writes still makes stop write, even when a particular execution
never ran the callback or already stopped the handle: no invocation-history proof is
attempted. Existing wider user declarations are not automatically narrowed by fix.

Cleanup registrations have a separate internal contract row. Ordinary calls,
callable aliases and supported callback substitutions transfer that row; merely
creating a function does not. Nested watcher jobs and lifecycle callbacks form
separate regions. A `watch` source getter runs in the inherited ambient context,
so a getter used to construct an inner watcher can register cleanup on the outer
watcher. The checker retains that registration without reconstructing reactive
sources or schedules. Reentrant cleanup registration (a cleanup itself registering
further watcher cleanup) is explicitly unsupported at a stop boundary in this
initial model; it is not silently classified as empty.

An unsafe exception on the registering function does not erase an independent
cleanup's public contract. A deliberately annotated exception on the cleanup itself
is respected. Replacing a watch handle with one tied to a different callback is
rejected until there is an explicit lifetime-slot contract. Passing remote methods
as callbacks is also rejected, including aliases resolved late: framework-supplied
runtime arguments must not bypass the worker's transport checks.

A TypeScript `Ref<T>` annotation alone does not establish a passive accessor. Only
known scalar creation and supported aliases retain that proof. Functions that accept
an arbitrary `Ref<T>`, return a typed watch handle, or use unsupported lifecycle
signatures may need additional models; widening an effect list is not a workaround.

Static fixture tests and separate tests with the installed Vue runtime cover sync,
pre/post scheduling, effect execution, cleanup, pause/resume and a changed-handle
counterexample. Runtime tests use Node and storage counters, not browser rendering,
real browser storage or network access. Actual enrolled source modules and in-memory
mutation overlays are checked separately without replacing their function bodies.

## Ambient values and conditional records

Ambient runtime declarations are not treated as verified implementations. An explicit
`scalar-value` external model may represent a reviewed non-callable compile-time
binding, with an empty effect list. The rollout uses it for `__BUILD_MODE_IS_TEST__`
from `src/env.d.ts`. Ambient files from the scoped TypeScript configuration are loaded
for name/type resolution without enrolling unrelated product implementations.

Closed conditional record spreads, including the existing conditional `TEST_ONLY`
pattern, retain every possible callable field and check overwrites against the slot
contract. Both expression branches remain effect-checked; only value alternatives
are narrowed. Optional native capabilities have unknown truthiness, so their fallback
implementations cannot be erased from the analysis. Open structural shapes and
unsupported union contracts are still diagnosed. Copying fresh fields is distinct
from sharing an existing writable slot; fresh construction is not a blanket variance
escape for nested shared objects.

## Worker boundary

A configured `workerTransports` entry identifies the exact reviewed transport module,
wrap/expose exports and its digest. The bridge recognizes a builtin constructor of the
form `new Worker(new URL('./entry.ts', import.meta.url), ...)`, verifies the same shared
contract declaration at wrap and expose sites, and connects individual methods to
provider implementations. A dedicated comment on the first callable in a module
belongs only to that callable, not to module initialization. Matching method names or structurally equal types alone do
not establish a connection. Type-only imports do not execute module initialization.

The command discovers literal entry files. For ESLint, the typed Program must also
include these entries (list them in the scoped TypeScript configuration). Missing
entries are errors, not empty worker bodies.

Worker startup is charged to creation, while method effects flow only through the
corresponding method. Creation carries a possible script-acquisition HTTP effect.
Known exposed shapes are checked for undeclared members. Passive argument and return
shapes are required for this initial copied-value transport; typed method aliases
retain the boundary checks. Higher-order remote forwarding, proxy callback transport,
standalone virtual imports, arbitrary endpoint factories, recursive wire shapes and
Naidan's independent RPC (Remote Procedure Call) protocol are not implemented here.
A factory returning a remote needs an explicit readonly returned-method contract when
the inferred mapped signature is outside the supported subset.

The bridge is tested on isolated TypeScript fixture projects. No real Naidan worker
has been enrolled in the default production rollout in this commit. Earlier handoff
prototypes exercised a broader worker subset; their results are not silently counted
as tests of this new TypeScript implementation.

## Fix safety and failure behavior

`fix` only widens existing upper bounds. It never replaces unknown operations with
`none`, grants all effects, or shrinks a deliberately broad declaration. Ordinary
TypeScript errors, unsupported constructs and boundary errors block the whole plan.

Before disk changes it validates the projected program, checks that a second fix
would be empty, and compares comment-stripped executable token streams. This protects
return/throw/arrow positions against automatic semicolon insertion changes.
Configuration inputs, model pins and all read local source snapshots are checked.
Files are replaced individually using temporary files, with best-effort rollback if
one replacement fails. This is not a filesystem-wide atomic transaction; an external
concurrent edit will never be overwritten as part of rollback. Dependencies under
`node_modules` are treated as a stable toolchain for one command invocation.

Checks intentionally do not certify arbitrary JavaScript. The initial supported
subset is narrow and has explicit failure diagnostics. Arrays/Map/class contracts,
general generic and asynchronous value conditions, complete Vue support, general
TSDoc comments, all browser storage/network lifecycles and persistent incremental
caching remain follow-ups. The implementation does not claim to have ported all
features or all tests from the independent prototypes.

## Validation and continuous integration

The effect tooling has an isolated Node-based Vitest configuration and a strict
TypeScript configuration. Existing application test setup is not imported.
`test:effects` uses the repository's failed-only, non-interactive test script.
A dedicated CI job runs the scoped check, tooling typecheck and checker tests.

Tests include contract subsets, writable aliases, callbacks, cyclic and generated
graphs, cross-file fixes, parser rejection, read/write separation, literal worker
bindings, hidden object members, coercion witnesses in a mock runtime, command exit
codes, input pin changes, concurrent edit refusal and rollback. Runtime mock tests do
not touch browser storage or use the network. Initial selected product utilities are
also tested locally without running the entire Naidan suite.


## Explicit Window messages and internal broadcast

`messaging.crossorigin.send(*)` records a Window send that may deliver across an
origin boundary. It is not HTTP traffic and is not an authorization policy.
The `*` argument covers possible recipients of this operation, not every effect.

The co-located rules are in `models/browser/messaging.ts`. They keep the primitive
policy, reason, overload selection, input guards and result model together:

- An omitted target or the exact `/` restriction uses the browser's incumbent
  origin check. The message transport itself is intentionally internal (`none`).
- `*`, an explicit origin URL, or an unverified primitive target retain the
  cross-origin upper bound. No deployment origin or equality of serialized `null`
  origins is assumed. Invalid targets can throw without sending; this first model
  intentionally does not minimize the upper bound using exception prediction.
- A fresh options literal is inspected from the last property backwards. A later
  spread can overwrite `targetOrigin`. A mutable options alias cannot keep its
  initial `/` value as proof of same-origin delivery.
- Three arguments select the legacy string-target overload. An object cast to a
  string still has conversion hooks. With two arguments an object is a dictionary;
  unrelated object methods are not invoked just because the type says string.
- BroadcastChannel construction, send, close and name access are intentional-none:
  the channel is confined to its storage key. A localStorage signal sent alongside
  the broadcast still requires the storage write effect.

All arguments are evaluated before applying the policy. Internal delivery does
not skip payload serialization checks. `message-data.ts` accepts checked scalar
values, closed data-only records and modeled Blob/File values; an open record,
scalar index signature, array, function, Promise, getter or unmodeled transferable
is not evidence of passive serialization. Structured clone does not assimilate a
`then` callback like Promise settlement. Nonempty transfer lists and mutable empty
list aliases require a later ownership/endpoint model. Only literal empty lists
(or explicit `void`) are currently supported.

The initial Window model accepts an explicit `window`/`parent`/`top`/`opener`
endpoint or a checked library Window value. Bare `postMessage`, `self.postMessage`
and `globalThis.postMessage` remain unsupported because worker source files can
also be type-checked with DOM ambient declarations. Do not silently classify those
worker transports as Window messages. Explicit `globalThis.window.postMessage`
is a Window path. Receiver listeners, transferred MessagePorts, iframe creation
and generic forwarding are separate future work; existing worker bridges retain
their own backend checks. This is not full cross-origin receive coverage.

`--explain` records these policies even for internal sends. Unsupported payloads
still produce diagnostics and block fix/tidy. Widening and selective unsafe
boundaries work as for other effects; tidy does not shrink shared callable slots.
