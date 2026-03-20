# Wesh Commands Guide

This file adds command-specific rules on top of the repository-level `AGENTS.md`.

Every command under this directory should aim for real shell utility behavior, not a simplified convenience API. Compatibility is the default goal.

## Primary Goal

- Match the behavior of widely used shell commands as closely as possible.
- Treat GNU/POSIX/BSD behavior as the reference, depending on the command.
- Prioritize user-visible behavior over implementation convenience:
  - accepted options
  - operand parsing
  - `--`
  - `-` as stdin when relevant
  - stdout/stderr wording
  - exit codes
  - continuation after per-file errors
  - help and usage output

If the implementation is intentionally incomplete, make that explicit in tests and in the final report. Do not silently implement a reduced command while presenting it as complete.

## Command Architecture

When adding or refactoring a command, separate these layers clearly:

1. Standard option parsing
2. Command-specific operand or grammar parsing
3. Command execution semantics
4. Output formatting and diagnostics

Do not mix all four into one monolithic function unless the command is trivial.

### Standard Option Layer

- Prefer the shared argv system for ordinary options.
- Use `parseStandardArgv` for commands whose option surface is mostly conventional.
- Reuse shared help and usage formatting.
- Do not hand-roll generic option scanning unless there is a concrete compatibility reason.

Good fit for shared argv:
- `cat`
- `grep`
- `head`
- `tail`
- `sort`
- `uniq`
- `wc`
- `cut`
- `tr`
- `mkdir`
- `rm`
- `touch`
- `readlink`

### Grammar Layer

Some commands are not just “flags + positionals”. Their operands form a grammar.

Examples:
- `find`
- `sed`
- `test`
- `awk`
- `jq`

For these commands:
- keep the grammar parser separate from the standard option layer
- still reuse shared help and usage behavior where possible
- do not force the entire command through `parseStandardArgv` if the grammar becomes less correct as a result

Rule of thumb:
- standard options: shared argv
- grammar and expression parsing: custom layer after argv

## Shared Helpers vs Core Wesh Helpers

Choose the layer before adding a helper.

### `commands/_shared`

Use `commands/_shared` only for helpers that are:
- command-local in responsibility
- small
- genuinely reused by multiple commands in this directory
- not shell-core behavior

Acceptable examples:
- usage/help formatters for commands
- small text helpers for line-oriented commands
- pure string-only path helpers for `basename` / `dirname`

Do not turn `commands/_shared` into a dumping ground.

### Core `wesh` Helpers

If behavior depends on shell state or the virtual filesystem, it belongs outside `commands/_shared`.

Examples:
- cwd-aware path resolution
- canonicalization through the VFS
- command resolution
- execution dispatch
- shell state or environment semantics

Those should live under core `wesh` modules, for example:
- `src/services/wesh/path.ts`
- `src/services/wesh/command-resolution/...`
- other top-level `wesh` modules as appropriate

If you are unsure whether a helper belongs in `_shared` or core:
- if it depends on `cwd`, env, VFS, shell state, or execution semantics, it is core
- if it is only string manipulation or command-local formatting, it may be `_shared`

## Efficient I/O Capabilities

When a command handles large files or archives, do not assume the generic
`open()` / `read()` / `write()` path is fast enough.

Prefer core `try...Efficiently` capabilities when they exist, for example:
- `tryReadBlobEfficiently`
- `tryCreateFileWriterEfficiently`

Rules:
- these are optimization capabilities, not mandatory success paths
- if they return `fallback-required`, use the normal generic path
- do not reimplement backend-specific optimizations inside a command
- keep backend-specific fast paths in core `wesh` / VFS layers
- commands should choose the efficient capability first for large sequential I/O

Examples:
- archive readers should try blob-native reads before buffering through generic handles
- archive extractors should try efficient file writers before chunking through generic `write()`

## Keep Shared Abstractions Small

Before creating a new shared helper:
- check whether the logic is already implemented elsewhere
- check whether the helper would only have one or two call sites
- check whether inlining would be clearer

Do not create tiny abstractions that hide no real complexity.

Example of likely over-abstraction:
- a helper used only for `true`, `false`, and `:`

Example of acceptable abstraction:
- line-oriented text loading reused by several line-processing commands

## Import Discipline

Before reporting a task complete:
- verify every new import path
- verify every exported symbol exists
- verify there is no accidental circular dependency
- verify helpers were moved to the correct layer

If you move or rename helpers, do a dependency-integrity pass before claiming completion.

Do not leave behind:
- broken imports
- duplicate half-migrated helpers
- command-local copies of new shared helpers

## Path Handling Rules

Be careful with path logic. Shell-like commands frequently differ in subtle ways.

- Respect absolute paths as absolute.
- Join relative paths against `context.cwd`.
- Never generate malformed double-slash output such as `//foo` unless the real command meaningfully preserves it.
- Distinguish pure string path behavior from filesystem resolution behavior.

Examples:
- `basename` and `dirname` are mostly string operations
- `realpath`, `readlink -f`, `find`, and file-opening commands depend on actual VFS resolution

## Stdin and `-`

If a command accepts `-` as stdin:
- test it explicitly
- test it in realistic command lines
- test repeated `-` where the command allows multiple inputs

Repeated `-` is a common compatibility trap.

Examples:
- `cat - file`
- `paste - -`
- `comm - file`
- `shuf -`

Do not assume “cache stdin once and reuse it” is correct. Real commands often consume stdin sequentially, and repeated `-` semantics vary by command.

## Error Handling

User-visible errors matter as much as successful output.

For each command, verify:
- invalid option behavior
- missing operand behavior
- extra operand behavior
- option requires argument behavior
- per-file failure behavior
- final exit code behavior

When multiple inputs are involved:
- decide whether the command should continue after one file fails
- match real command behavior as closely as possible
- test that continuation behavior

Do not print usage for ordinary runtime failures unless the real command does.

Typical split:
- usage errors: invalid option, missing operand, malformed syntax
- runtime errors: missing file, permission issue, bad descriptor, resolution failure

## Help and Usage

Every command should support `--help`.

Requirements:
- use the shared help/usage system when possible
- keep the command description accurate and short
- make usage lines match the actual accepted syntax
- ensure `help <command>` and `<command> --help` stay aligned

If a command intentionally supports only a subset of a real utility:
- do not advertise unsupported flags in help
- keep help text honest

## Tests

Tests are first-class deliverables.

Every implemented feature must have at least one realistic command-level test.

Prefer:
- dedicated `src/services/wesh/commands/<command>/<command>.test.ts`
- `Wesh.execute()`-based integration-style tests
- realistic shell scripts
- real stdin/stdout/stderr assertions

Do not use batch test files that mix unrelated commands.

### Minimum Test Checklist

For most commands, cover:
- `--help`
- happy path
- invalid option
- missing operand
- extra operand when relevant
- stdin path
- file path
- `-` behavior when relevant
- exit codes
- stderr wording at a useful level

Add command-specific edge cases too:
- repeated `-`
- format string parsing
- expression grammar precedence
- recursive traversal
- symlink behavior
- binary vs text behavior
- multi-file continuation rules

### Test Style

- Use multiline template literals for multi-line shell scripts.
- Keep tests command-local and focused.
- Prefer explicit expected stdout/stderr text over vague assertions.
- When randomness is involved, assert invariants rather than exact ordering.

## Implementation Strategy

When building a command:

1. Check whether an existing real command has unusual parsing rules.
2. Decide whether it is:
   - standard-option command
   - standard-option command with special operand rules
   - grammar command
3. Reuse existing shared/core helpers first.
4. Add dedicated tests for real-command edge cases.
5. Only then widen the feature surface.

Do not start by adding many flags with shallow coverage.
Prefer a smaller but correct feature set over a larger but misleading one.

## Reporting Expectations

When you finish a command task, report:
- files changed
- why any new shared helper was needed
- what stayed command-local vs moved to core
- feature-to-test mapping
- commands run and their results
- remaining compatibility gaps

If you intentionally did not use shared argv or shared helpers, explain why.

## Red Flags

Stop and rethink if you notice any of these:
- hand-written generic option parsing for an otherwise normal command
- a new `_shared` helper with only one real caller
- shell/VFS logic being added under `commands/_shared`
- tests that only cover help text and one happy path
- claiming compatibility without edge-case tests
- reporting completion before import/export integrity is checked

## Practical Bias

Bias toward:
- correctness
- narrow, reviewable diffs
- real-command behavior
- explicit tests

Bias against:
- convenience abstractions
- speculative shared modules
- shallow compatibility claims
- convenience-only rewrites of existing working code
