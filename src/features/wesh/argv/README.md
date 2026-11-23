# Wesh argv

`argv` provides catalog-based option parsing and help for Wesh commands.

## Reading order

For an architecture review, read this directory in this order:

1. `README.md` and `AGENTS.md` — subsystem boundary and parser rules.
2. `index.ts` — complete production public API.
3. `model.ts` and `types.ts` — shared action/policy/value vocabulary.
4. `catalog.ts` — catalog definition, compilation, and long-name namespace resolution.
5. `analyze.ts` — token-local short/long analysis used by both standard parsing and partial-use consumers.
6. `result.ts` — parsed result, diagnostics, occurrence retention, and semantic/action accumulation.
7. `parser.ts` — standard argv scanning and value binding.
8. `help.ts` and `early-exit.ts` — presentation derived from the same catalog/resolution semantics.
9. `*.test.ts` — parser regression coverage.

## Boundary

- This directory owns shared option syntax, resolution, parsing, and help.
- It must not import from `../commands/**`.
- Production consumers import only the `@/features/wesh/argv` barrel.
- The returned `ArgvCatalog` is a frozen runtime-opaque handle; compiled lookup maps are module-private and cannot be mutated through the public catalog object.
- Catalog compilation snapshots syntax/value grammar, resolver metadata, and help presentation, but generic `TSemantic` payloads remain caller-owned references. Treat object/array semantic declarations as immutable after `defineArgvCatalog()`; in particular, do not retain and mutate `StandardArgvAction.effects` arrays or deferred tags after catalog definition.
- Command-specific phase/state/expression grammars stay command-local.
- `kind: 'deferred'` is the searchable semantic-delegation boundary when the standard scanner still owns syntax.
- `analyzeArgvShortForm` / `analyzeArgvLongForm` are the searchable token-local partial-use boundary when a command owns argv cursor/phase.
  - `analyzeArgvShortForm` expects a token whose first character matches `prefix` and a `bodyOffset` pointing at an option character inside that token; invalid coordinates are programming errors.
  - `analyzeArgvLongForm` expects a `--name` / `--name=value`-style token and does not accept the bare `--` terminator; invalid tokens are programming errors.
  - Both analyzers own only lexical resolution/value-claim description. The command owns argv cursor movement, following-argv availability/consumption, phase changes, and semantic state.
- Helpers used by catalog-based and command-local parsers can live outside this directory when they are independent of this subsystem.

`StandardArgvAction` value parsers are pure transformations. `stopArgvAtFirstEarlyExit()`
may parse prefixes while preserving source-order diagnostics, so a `required-value.parse`
callback can run more than once for the same original argv. It must not mutate command
state, perform I/O, or depend on exactly-once invocation.

A parse with diagnostics is unsuccessful. Command consumers must handle non-empty
`diagnostics` before using `optionValues`, `deferred`, or positional output as command
semantics. Those fields preserve useful parser/provenance state but are not a transactional
rollback contract for failed argv.

Positionals are returned as values only. Option provenance is available through `deferred`
and occurrence retention. Command-owned parsers can retain their own cursor when source
position is semantic. Do not add positional indexes without a concrete real-command requirement.

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
