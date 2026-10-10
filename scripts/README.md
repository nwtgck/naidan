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

Starts a release branch without requiring `git flow`. The script requires the current branch to be `develop`, updates `package.json` and `package-lock.json`, and commits the version bump. For `major`, `minor`, and `patch`, it creates `release/<version>`. For `dev`, it stays on `develop` and bumps to the next `-dev` version.

`patch` follows the repository's release flow: if the current version ends with `-dev`, it removes the suffix without incrementing the patch number. Otherwise, it increments the patch number.

### Usage

```bash
./scripts/release_start.py <major|minor|patch|dev>
```

```bash
./scripts/release_start.py --dry-run <major|minor|patch|dev>
```

### Example

```bash
./scripts/release_start.py minor
```

```bash
./scripts/release_start.py --dry-run minor
```

```bash
./scripts/release_start.py dev
```

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
