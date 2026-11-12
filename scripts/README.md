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
`package-lock.json`, and `CHANGELOG.md`, consumes the collected changelog entry
files, and commits those updates and deletions together as `bump: <version>`.
It does not create a tag, push, publish, or update GitHub Releases.

Write and review English notes in `changelog-unreleased/changes-*.md` following
`changelog-unreleased/AGENTS.md`, then commit them before starting a release.
Review actual source differences; commit messages are supplementary context,
not evidence that a feature was released. Existing notes written directly under
`## [Unreleased]` are still supported, including when entry files also exist.
Both inputs are combined into `## [X.Y.Z] - YYYY-MM-DD`; the `Unreleased`
instructions remain in place and optional comparison links are updated.
Only consumed entry files are removed. The script never writes, summarizes, or
semantically deduplicates release-note prose.

```bash
# Inspect a plan, including validation of the notes, without writing anything.
./scripts/release_start.py minor --dry-run

# Use today's UTC calendar date, or supply the intended UTC date explicitly.
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
`-dev`, stays on `develop`, and does not read or modify `CHANGELOG.md` or the
changelog entry directory.
`--date` and `--allow-empty-changelog` are release-only options. Release dates
use UTC (Coordinated Universal Time), independent of the machine's local time
zone. `--date YYYY-MM-DD` supplies a UTC calendar date verbatim, not a local
midnight to convert. The default is the date when release preparation runs, not
the eventual tag or publication date; neither is created by this script. No
custom environment variable changes this behavior.

### Changelog format and validation

Use ordinary Markdown with one unindented `## [Unreleased]` heading first,
followed by unique `## [X.Y.Z] - YYYY-MM-DD` headings in descending version order.
Version headings and reference labels omit `v`; Git tag names keep it. Historical
dates in the initial changelog were derived from Git tag timestamps converted to
UTC, not independently verified GitHub publication dates.
The optional categories are `### Added`, `### Changed`, `### Deprecated`,
`### Removed`, `### Fixed`, and `### Security`. Do not duplicate a category in
`Unreleased`. Comments and fenced examples are not release boundaries; original
note text, historical sections, and line endings are preserved rather than
regenerated. An optional leading `<!-- changelog-unreleased:instructions`
comment, closed by `-->` on its own line, stays under `Unreleased`; ordinary
comments travel with the notes as before. This marked comment must occur only
once and before all other Unreleased content. Code examples of the marker are
not treated as instructions. Old changelogs without the marker remain supported.

Keep managed comparison links as single-line Markdown definitions at the end of
the document. Ordinary reference titles and angle-bracket destinations are
supported. The `Unreleased` comparison must begin at the newest recorded tag;
its comparison target (for example, `develop`) is preserved. Unsupported managed
link syntax fails validation instead of silently leaving stale links. A changelog
without reference links is also supported. For example:

```markdown
[Unreleased]: https://github.com/nwtgck/naidan/compare/v0.62.0...develop
[0.62.0]: https://github.com/nwtgck/naidan/compare/v0.61.0...v0.62.0
```

Missing files, malformed headings/dates, duplicate versions, conflicting release
branches/tags, and empty notes fail before branch creation or file writes. Empty
bullets, comments, and headings do not count as notes. The target version must be
newer than the latest section, and its date must not precede that section's date.
English prose quality and historical accuracy still require review; these are
not inferred from syntax. `--dry-run` performs content validation and can inspect
uncommitted draft notes, but a real run requires a clean working tree.

### Collecting independent entries

Only **direct children** of `changelog-unreleased/` matching `changes-*.md` are
candidates. A missing directory is equivalent to zero entries. `AGENTS.md`,
other names/extensions, and ordinary subdirectories are ignored and preserved.
A candidate whose name, UTC timestamp, content or file type is invalid stops the
release; `--allow-empty-changelog` does not bypass malformed input. Linked
entry directories/files and non-regular candidate files are rejected.

Filenames use `changes-YYYYMMDDTHHMMSS.sssZ-<topic>.md`, with the actual UTC
creation instant, not the release date. Timestamps are not changed on revision,
compared with the release clock, or used to infer dependencies. Topics contain
lowercase ASCII letters, digits and single separating hyphens. Timestamp ties
are sorted by the full filename. No random suffix is used.

Each entry contains one category and one paragraph-style bullet with optional
exactly-two-space-indented continuation lines and inline Markdown. These stricter
rules do not apply to legacy direct notes, which retain their paragraphs,
comments, code examples and existing category order. New entries follow direct
notes within their category; when a category contains a level-four or deeper
subheading, prepend entries to the entire category body rather than splitting
an existing list item or adding entries to that subsection. Missing categories
are appended in the order Added, Changed, Deprecated, Removed, Fixed, Security. Fragment-only
releases use that same category order. Each category heading appears only once.

`--allow-empty-changelog` is needed only when neither input contains notes.
`--dry-run` validates uncommitted entries too, lists the exact planned deletions,
and prints the rendered new release body (including its comparison link).
Preparation and publication share `changelog_format.py`; the complete generated
changelog must pass the publication renderer's reference rules and 125,000-byte
UTF-8 body limit before a branch is created. No body is silently truncated.

A real run requires collected files to be tracked by Git without skip-worktree
or assume-unchanged flags. Tracked entries missing from a sparse checkout also
stop release preparation. Ignored untracked entries can be previewed but never
consumed. The entry inventory and contents are rechecked before mutation, after
branch creation, and before deletion. This detects ordinary intervening edits,
including checkout-hook changes; it is not a concurrency lock. Only the explicit
update/deletion paths are staged, never the whole directory or working tree.
They are passed as a NUL-delimited standard-input list, avoiding command-line
length limits when collecting many files.

Deletions happen on the release branch. Merge the release back to `develop`
before starting another release so consumed entries are not collected again.
New independently named entries added on `develop` after the release branch was
cut remain for the next release. Editing an already-consumed entry on another
branch may still produce a modify/delete conflict that needs human review.
No registry or automatic semantic deduplication hides those conflicts.

### Failure handling and targeted tests

Release files must be regular files, not symlinks. Each file is staged beside its
destination and replaced by rename, preserving its permissions; a write failure
does not truncate that destination. The whole operation is **not** a transaction
across file updates, entry deletions, branch creation, and Git hooks. Do not run
concurrent release preparations. If writing or committing fails, inspect `git status`, the index,
and the current branch. Prepared work is left available for recovery; the script
does not reset or discard it automatically. Consumed entries are recoverable
from the pre-release commit; do not blindly rerun on a partially prepared branch.
Check whether the generated notes contain every expected entry, then either
finish the reviewed release commit or deliberately restore the pre-release state.

Run the release-script tests without building or testing the application:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_*.py'
node --test scripts/tests/release-notes-workflow.test.mjs
```

The integration tests use isolated temporary Git repositories and do not publish
anything or contact the network.

## GitHub Release Notes (`plan_release_notes.py`)

`CHANGELOG.md` on **develop** is the canonical source of release-note prose.
The workflow `.github/workflows/sync-release-notes.yml` is both a lightweight
synchronizer and the reusable, serialized publication job called by `main.yml`.
No AI, commit-log summaries, new npm packages, or synchronization database are used.

### Audit and execution boundary

All release-note GitHub API (Application Programming Interface) calls are inline
JavaScript in that workflow, using `actions/github-script` pinned by
`.github/workflows/actions.lock`. When adding or changing `uses:` references,
run `gh actions-lock` to regenerate the lockfile and check it with
`gh actions-lock --verify` (also enforced by `verify-lockfile.yml`). The Python
planner only reads files and prints a complete JSON (JavaScript Object Notation)
plan. It shares the pure scanner and renderer in `changelog_format.py` with release
preparation, without running release preparation or Git commands. It runs in a
read-only Docker container with
`--network none`, no credentials or Docker socket, read-only script/input mounts,
and no writable host mount. Stdout is redirected to the plan by the host shell.
The planner's Python image is digest-pinned and pulled explicitly before running
with `--pull=never`. Update the pin deliberately when updating that runtime.

Checkout, image pulls, artifact transfers, and the existing asset publishers are
also network operations and remain visible in YAML. This boundary does **not**
sandbox the host runner or restrict github-script to a network allowlist. The
workflow JavaScript and action dependencies remain trusted code. Do not import
repository JavaScript into the credentialed steps or add networking to the planner.

### Triggers and ordering

- A relevant push to `develop` compares **all** published releases, including old
  versions. Tooling/workflow changes also trigger comparison. `Unreleased` never
  becomes release notes. Unrelated pushes do not run this synchronizer.
- A tag push first builds and tests the release tooling in `main.yml`, then calls
  this reusable job. It validates the entire plan before creating the requested
  release with reviewed notes, updates differing historical bodies, and finally
  uploads the existing distributions and runs GoReleaser. Only an explicit
  `vX.Y.Z` tag-push publication can create a release; a changelog-only sync cannot.
- Manual `workflow_dispatch` on `develop` defaults to **dry-run**. Inspect the
  `release-note-plan-<run>-<attempt>` artifact, then run again with dry-run disabled
  to apply. Inputs, source identity, and the plan are retained for seven days,
  including after a failed planning/application step when the fetch succeeded.
  Draft metadata is removed before writing this snapshot to avoid exposing
  unpublished draft tags or notes through artifacts.

The first push of this implementation to `develop` automatically synchronizes
existing releases; it is not a preview. Prepare/review an offline plan first when
an initial all-history update needs review. The synchronizer itself does not build
the application, but the pre-existing all-push `main.yml` build/test triggers are
not suppressed by this change.

All paths use the same job-level concurrency group, with `cancel-in-progress:
false` and `queue: max`. Up to 100 pending jobs are retained instead of replacing
pending tag publications. The lock spans fetching, planning, mutations, AND asset
publishing: GoReleaser 2.7.0's `keep-existing` still resends a fetched existing body.
Without this shared lock, it could undo a newer synchronization. GoReleaser's
changelog generator is disabled; it does not author release notes.

The canonical changelog is fetched from current `develop` **after acquiring the
lock**, not from the triggering commit. For a new tag, the tagged changelog must
also contain that version. The canonical section wins when present. Otherwise,
only the requested version may fall back to the tagged notes, and only for a new
release or an existing empty body. Tag fallback never replaces nonempty existing
notes or imports historical descriptions. Merge the new section back to `develop`
so subsequent ordinary synchronizations can manage it.

### Rendering and update rules

The planner accepts the same canonical stable-version headings, date syntax, and
newest-first ordering as release preparation. It masks comments and code examples
when recognizing structure. It does not interpret arbitrary Markdown extensions,
write prose, or migrate formats. Prerelease version headings are not supported by
the existing release-preparation contract and are not introduced here.

Each release body contains its section's original Markdown (without the version
heading), then its optional `Full Changelog` reference link. Dates remain in the
canonical document rather than being repeated in the body. Outer blank lines and
CRLF (carriage return + line feed) endings are normalized; hard line breaks and
other formatting are preserved. Notes may be deliberately empty, as supported by
`release_start.py --allow-empty-changelog`; no synthetic change entry is invented.

Keep reference definitions on single lines at the document end. Used definitions
are copied into each body, including normal full/collapsed/shortcut/image
references; irrelevant version definitions are not copied. Defined bracket labels
are conservatively retained, not rewritten with a general Markdown renderer.
Use absolute link destinations for links that must also work outside the source
file. Malformed or duplicate headings/definitions, invalid dates, non-footer text
after the reference block, and oversized bodies fail before any mutation.

Releases are listed with pagination at 100 per page. For R existing releases and
U differing bodies, synchronization uses max(1, ceil(R / 100)) list requests and
U body-only PATCH requests, plus one canonical-content read. A tag publication
adds one tagged-content read and, only when absent, one creation request. These
counts exclude retries, action setup, checkout, and asset upload traffic. No
per-version GET is used. Repeating a successful synchronization makes zero writes.

Before writing, the inline JavaScript independently validates **every** update's
shape, unique positive safe-integer identifier, tag, size, and match to the fetched
snapshot. It never spreads plan fields into an API request. Existing-release
writes contain only `body`, not name, tag, assets, draft/prerelease/latest flags.
Drafts, prereleases, and releases missing from the canonical changelog are skipped,
not cleared or deleted. Missing GitHub releases are not created during ordinary
syncs. Writes are sequential with a one-second interval between content mutations.

### Failures, recovery, and limitations

A planning/validation failure makes zero writes. A network failure can leave a
partially applied plan: the job fails, earlier successes remain, and the next full
comparison recovers the rest. There is no cross-release transaction or automatic
rollback. New publication stops before asset uploads if synchronization fails.
After an asset-publishing failure, rerun the failed publication job; the planner
recognizes existing notes and does not create duplicate releases.

The default `GITHUB_TOKEN` needs `contents: write`; no personal token is required
by this workflow. Creation deliberately omits `target_commitish`: the tag already
exists, so that field is unnecessary, and freezing it to a historical workflow
commit could cause later body updates to require workflow-write permissions. GitHub can still reject a release update with 403/404 when its
resolved target modifies workflows relative to the default branch and the token
cannot modify workflows. Do not interpret those errors as "missing, skip" or
silently broaden permissions. Review the target/default-branch state and GitHub's
release API permission rules before retrying.

The concurrency group coordinates these workflows, not manual GitHub edits,
external publishers, or old workflow definitions from tags predating this change.
Do not manually edit derived release bodies. A canonical edit arriving during a
run is picked up by the next queued synchronization; no instantaneous consistency
is promised. A canceled job or a full queue requires a later sync/manual rerun.
No scheduled job or alternate credential is configured automatically.

### Local planning and targeted tests

With a previously fetched JSON array containing each release's `id`, `tag_name`,
`body`, `draft`, and `prerelease`, planning performs no network access or writes:

```bash
python3 scripts/plan_release_notes.py \
  --changelog CHANGELOG.md --releases /path/to/releases.json > /tmp/updates.json

PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -p 'test_*.py'
node --test scripts/tests/release-notes-workflow.test.mjs
```

The JavaScript tests execute the **actual inline scripts extracted from YAML**
with mocked GitHub endpoints; they do not maintain a second implementation.
Python integration tests require Git. The tooling check uses the full Python
image (which includes Git), while production planning uses the smaller, pinned
image. Both test processes run with networking disabled in Actions.

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
