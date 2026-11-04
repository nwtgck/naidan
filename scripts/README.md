# Scripts

This directory contains utility scripts for codebase maintenance and refactoring.

## String Catalogs (`generate-string-catalogs.ts`)

Regenerate the locale catalogs after adding, renaming, or removing message
**directories**. Wording-only edits do not change catalogs.

```bash
npm run strings:catalogs
npm run strings:catalogs:check
npm run strings:catalogs:test
```

The first command updates catalogs. `:check` compares without writing and exits
nonzero when a catalog is missing or differs. `:test` runs only the generator and
catalog-reader tests, without application plugins or browser inference artifacts.
`npm run strings:catalogs -- --help` describes the command-line options.

### Inputs and outputs

- Message keys come from directories under `src/strings/messages/`.
- Supported locales come from `UI_LOCALES` in `src/01-models/ui-locale.ts`; there is
  no separate generator locale list.
- Only `src/strings/catalogs/<locale>.ts` files are written. Existing catalogs
  supply neither message keys nor ordering, so they can be missing or malformed.

Keys use the build reader's existing validation rule. Every message directory
must contain a regular file for every supported locale. Root-level documentation
is ignored. Invalid keys, missing locale files, empty input, and linked message
or output paths stop generation before any catalog is changed. Unexpected locale
catalogs are reported, not automatically deleted; review the locale definition or
remove obsolete catalogs explicitly.

Output uses a fixed, case-sensitive identifier order, with `SHARED__` first and
its ownership warnings retained. The English catalog retains its synchronous
string-return contract and exact `Strings` / `StringKey` types. Other catalogs
retain `satisfies Strings`. Generation uses LF line endings; comparison also
accepts CRLF checkouts. Identical files are not rewritten.

### Validation boundary

This command validates the file layout and reproducibility of catalogs. It does
**not** read or execute message implementations, inspect their TypeScript syntax,
check translation quality, or replace TypeScript checking. Generated named imports
and `satisfies` clauses let TypeScript detect incorrect exports, incompatible
parameters, and non-string or asynchronous return types without a second parser
or a restricted function-authoring syntax in the generator.

Translation, key ownership, locale registration, and call-site changes remain
separate edits. For a new language, update Naidan's supported-locale definition
and the other language-selection/runtime code as required, then provide that
locale's file in every message directory. The generator creates the new catalog;
it does not enable a language throughout the application by itself.

All input validation and destination reads finish before writing starts. Each
changed catalog is staged beside its destination and replaced by rename; a write
failure does not truncate that destination. The locale set is not a multi-file
transaction: after an interrupted run, rerun generation and `:check`.

These commands are explicit maintenance tools, not automatic dev/build hooks.
The implementation is in `build/boundary-strings/generate-catalogs.ts`; the script
only selects the mode, resolves the repository root, and reports results.

## Release Start (`release_start.py`)

Prepare a release locally without `git flow`. Run from `develop` with a clean
working tree. The script creates `release/<version>`, updates `package.json`,
`package-lock.json`, and `CHANGELOG.md`, and commits all three together as
`bump: <version>`. It does not create a tag, push, publish, or update GitHub Releases.

Write and review English notes under `## [Unreleased]` **before** starting a
release, then commit those edits. Review the actual source differences; commit
messages are supplementary context, not evidence that a feature was released.
The script moves those notes into `## [vX.Y.Z] - YYYY-MM-DD`, creates an empty
`Unreleased` section above it, and updates the optional Markdown comparison links.
It never writes or summarizes release-note prose.

```bash
# Inspect a plan, including validation of the notes, without writing anything.
./scripts/release_start.py minor --dry-run

# Use the local calendar date, or supply the intended date explicitly.
./scripts/release_start.py minor
./scripts/release_start.py patch --date 2026-11-04

# Only for a deliberately empty release; this does not fabricate a change entry.
./scripts/release_start.py patch --allow-empty-changelog

# The existing development bump changes only the two package files.
./scripts/release_start.py dev
```

`major` and `minor` increment their respective version components. `patch`
removes a final `-dev` suffix without incrementing the patch number; otherwise it
increments the patch number. `dev` increments the patch number and appends
`-dev`, stays on `develop`, and does not read or modify `CHANGELOG.md`.
`--date` and `--allow-empty-changelog` are release-only options.

### Changelog format and validation

Use ordinary Markdown with one unindented `## [Unreleased]` heading first,
followed by unique `## [vX.Y.Z] - YYYY-MM-DD` headings in descending version order.
The optional categories are `### Added`, `### Changed`, `### Deprecated`,
`### Removed`, `### Fixed`, and `### Security`. Do not duplicate a category in
`Unreleased`. Comments and fenced examples are not release boundaries; original
note text, historical sections, and line endings are preserved rather than
regenerated. No custom markers or generated commit lists are required.

Keep managed comparison links as single-line Markdown definitions at the end of
the document. Ordinary reference titles and angle-bracket destinations are
supported. The `Unreleased` comparison must begin at the newest recorded tag;
its comparison target (for example, `develop`) is preserved. Unsupported managed
link syntax fails validation instead of silently leaving stale links. A changelog
without reference links is also supported.

Missing files, malformed headings/dates, duplicate versions, conflicting release
branches/tags, and empty notes fail before branch creation or file writes. Empty
bullets, comments, and headings do not count as notes. The target version must be
newer than the latest section, and its date must not precede that section's date.
English prose quality and historical accuracy still require review; these are
not inferred from syntax. `--dry-run` performs content validation and can inspect
uncommitted draft notes, but a real run requires a clean working tree.

### Failure handling and targeted tests

Release files must be regular files, not symlinks. Each file is staged beside its
destination and replaced by rename, preserving its permissions; a write failure
does not truncate that destination. The whole operation is **not** a transaction
across files, branch creation, and Git hooks. Do not run concurrent release
preparations. If writing or committing fails, inspect `git status`, the index,
and the current branch. Prepared work is left available for recovery; the script
does not reset or discard it automatically.

Run the release-script tests without building or testing the application:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_release_start.py'
```

The integration tests use isolated temporary Git repositories and do not publish
anything or contact the network.

## Refactor Named Arguments (`refactor-named-args.ts`)

A powerful codemod tool to convert positional function arguments into named arguments (object destructuring). It automatically updates the function definition and all its call sites across `.ts` and `.vue` files.

### Features
- **Type-Safe**: Uses TypeScript Language Service to accurately identify references.
- **Vue Support**: Handles `<script>` and `<template>` blocks in Vue SFCs.
- **Recursive Tracking**: Follows re-exports and Composable return objects to find all call sites.
- **Heuristic Backup**: Ensures no calls are missed in complex Vue components using string-based scanning.

### Usage

```bash
npx tsx scripts/refactor-named-args.ts <source-file-path> <function-name> [options]
```

### Options
- `--dry-run`: Preview changes without modifying files.

### Example

For a hypothetical `exampleFunction` in `src/example.ts` (replace both with the actual refactoring target):

```bash
# Preview changes
npx tsx scripts/refactor-named-args.ts src/example.ts exampleFunction --dry-run

# Apply changes
npx tsx scripts/refactor-named-args.ts src/example.ts exampleFunction
```

### How it works
1. **Definition**: Changes `function foo(a, b)` to `function foo({ a, b }: { a: type, b: type })`.
2. **Call Sites**: Changes `foo(1, 2)` to `foo({ a: 1, b: 2 })`.
