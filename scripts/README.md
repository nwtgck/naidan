# Scripts

This directory contains utility scripts for codebase maintenance and refactoring.

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

To refactor `sendMessage` in `useChat.ts`:

```bash
# Preview changes
npx tsx scripts/refactor-named-args.ts src/composables/useChat.ts sendMessage --dry-run

# Apply changes
npx tsx scripts/refactor-named-args.ts src/composables/useChat.ts sendMessage
```

### How it works
1. **Definition**: Changes `function foo(a, b)` to `function foo({ a, b }: { a: type, b: type })`.
2. **Call Sites**: Changes `foo(1, 2)` to `foo({ a: 1, b: 2 })`.
