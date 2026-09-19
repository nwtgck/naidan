# Wesh argv v2

`argv-v2` is the isolated replacement generic argv subsystem used during migration from
`../argv`. The `v2` suffix is temporary: after all eligible command consumers have
migrated and the legacy subsystem is deliberately retired, this directory is renamed
to `argv` without keeping a versioned public name.

The legacy `argv/` subsystem is intentionally allowed to coexist for as long as needed.
Do not rush its deletion merely to complete the rename: preserving the frozen v2
contract and finding any remaining grammar gaps is more important than migration speed.

## Reading order

For an architecture review, read this directory in this order:

1. `README.md` and `AGENTS.md` — subsystem boundary and migration rules.
2. `index.ts` — complete production public API.
3. `model.ts` and `types.ts` — shared action/policy/value vocabulary.
4. `catalog.ts` — catalog definition, compilation, and long-name namespace resolution.
5. `analyze.ts` — token-local short/long analysis used by both standard parsing and partial-use consumers.
6. `result.ts` — parsed result, diagnostics, occurrence retention, and semantic/action accumulation.
7. `parser.ts` — standard argv scanning and value binding.
8. `help.ts` and `early-exit.ts` — presentation derived from the same catalog/resolution semantics.
9. `*.test.ts` — permanent v2 regression contract.

A reviewer should not need to read legacy `../argv` to understand whether the v2 generic
parser design is internally coherent.

## Boundary

- This directory owns the complete generic argv-v2 syntax/resolution/parsing/help contract.
- It must not import `../argv` or `../commands/**`.
- Production consumers import only the `@/features/wesh/argv-v2` barrel; deep imports are internal.
- The returned `ArgvCatalog` is a frozen runtime-opaque handle; compiled lookup maps are module-private and cannot be mutated through the public catalog object.
- Catalog compilation snapshots syntax/value grammar, resolver metadata, and help presentation, but generic `TSemantic` payloads remain caller-owned references. Treat object/array semantic declarations as immutable after `defineArgvCatalog()`; in particular, do not retain and mutate `StandardArgvAction.effects` arrays or deferred tags after catalog definition.
- Command-specific phase/state/expression grammars stay command-local.
- `kind: 'deferred'` is the searchable semantic-delegation boundary when the standard scanner still owns syntax.
- `analyzeArgvShortForm` / `analyzeArgvLongForm` are the searchable token-local partial-use boundary when a command owns argv cursor/phase.
  - `analyzeArgvShortForm` expects a token whose first character matches `prefix` and a `bodyOffset` pointing at an option character inside that token; invalid coordinates are programming errors.
  - `analyzeArgvLongForm` expects a `--name` / `--name=value`-style token and does not accept the bare `--` terminator; invalid tokens are programming errors.
  - Both analyzers own only lexical resolution/value-claim description. The command owns argv cursor movement, following-argv availability/consumption, phase changes, and semantic state.
- Shared code outside this directory belongs elsewhere only when it remains meaningful for legacy argv, argv-v2, and/or fully command-local parsers independently of this subsystem.

`StandardArgvAction` value parsers are pure transformations. `stopArgvAtFirstEarlyExit()`
may parse prefixes while preserving source-order diagnostics, so a `required-value.parse`
callback can run more than once for the same original argv. It must not mutate command
state, perform I/O, or depend on exactly-once invocation.

A parse with diagnostics is unsuccessful. Command consumers must handle non-empty
`diagnostics` before using `optionValues`, `deferred`, or positional output as command
semantics. Those fields preserve useful parser/provenance state but are not a transactional
rollback contract for failed argv.

Positionals are returned as values only; argv-v2 intentionally does not expose a generic
positional-source-index policy. Freeze review found no production Wesh consumer for that
prototype-era metadata, while option provenance already has bounded `deferred` / occurrence
retention and command-owned parsers can retain their own cursor when source position is
semantic. Do not re-add positional indexes without a concrete real-command requirement.

`required-value` is the reduction action for syntax that always supplies a value (for
example short `required-attached-or-following` or long `required`). Do not attach it to
`optional-attached` / `optional-following`: a bare optional occurrence has no raw value.
Use `deferred` when command semantics must preserve the distinction between option presence,
an omitted optional value, and an explicitly supplied value.

## Resolver namespace and help visibility

For `unique-prefix` command families, keep three concepts separate:

- membership in the real long-option resolver namespace,
- whether Wesh implements that option semantic,
- whether a spelling should be shown in help.

`nonExecutableLongOptions` is only for real options whose semantic Wesh does not implement.
A string entry is one distinct unsupported resolver semantic. When multiple unsupported real
spellings are GNU-style resolver-equivalent aliases with the same value grammar, group them as
`{ equivalentNames: [...] }`; otherwise a shared prefix would become a false ambiguity. GNU
`grep --fixed-strings` / hidden `--fixed-regexp` and GNU `cp --parents` / hidden `--path` are
concrete examples. A hidden compatibility alias for an implemented semantic instead stays in
that semantic's executable catalog `forms` and may be omitted only from help presentation;
GNU `rmdir --path` / `--parents` is the regression that requires that distinction.

## Migration invariant

A command declared migrated to argv-v2 must have no direct or transitive dependency on
`@/features/wesh/argv`. During migration legacy commands continue to use `argv` and
migrated commands use `argv-v2`; the two generic parser systems do not import each other.
Migration-only dependency/parity tooling is maintained in the Wesh compatibility Lab,
not shipped as production source.
