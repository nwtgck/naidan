# Unreleased changelog entries

Record notable, implemented changes in separate Markdown files here to avoid
conflicts between parallel development tasks. Write entries in English and
explain the effect on users or contributors, not a list of commits.

## Filename

Use `changes-YYYYMMDDTHHMMSS.sssZ-<topic>.md`.

- Use the UTC (Coordinated Universal Time) timestamp at the instant the changelog
  Markdown file is first created, including exactly three millisecond digits.
- Use a short lowercase kebab-case topic containing only English letters, digits,
  and single separating hyphens. Do not append a random identifier.
- Keep the original filename when revising the entry.
- Never overwrite an existing entry when creating a new one. On a filename
  collision, obtain a new current UTC timestamp and try again.

Example: `changes-20261112T063045.123Z-workflow-branching.md`.

## Markdown format

Use UTF-8 without a byte-order mark, with LF (line feed) or CRLF (carriage return
+ line feed) line endings. Each file has
exactly one category heading, a blank line, and one nonempty `- ` list item:

```markdown
### Fixed

- Fix incorrect conditional branching in Workflow execution.
```

Use the six Keep a Changelog categories:

- `Added`: new features.
- `Changed`: changes in existing functionality.
- `Deprecated`: soon-to-be-removed features.
- `Removed`: removed features.
- `Fixed`: bug fixes.
- `Security`: changes addressing vulnerabilities.

Use `Fixed` for correcting unintended behavior and `Changed` for intentionally
changing existing behavior. Mark breaking changes with `**Breaking:**` at the
start of the item, in the appropriate category (usually `Changed` or `Removed`).

Keep the item to one paragraph. Long prose may wrap onto continuation lines
indented with exactly two spaces. Inline code, emphasis and inline links are
allowed; use absolute link destinations so links also work in published notes.
Do not use nested lists, extra paragraphs, headings, code blocks, HTML comments,
reference definitions, frontmatter, release version headings or release dates.
Create separate files for separate entries or categories. Leading/trailing blank lines
and an omitted final newline are accepted.

## Accuracy and maintenance

Only describe changes that have been implemented. Update an existing entry when
its change is revised; delete it when the change is reverted before release.
Remove duplicated or obsolete descriptions when several patches evolve the same
feature. The notes must describe the final changes relative to the last release,
not intermediate work that will never have been released.

## Integration

Only direct children named `changes-*.md` are collected for a release. Entries
are grouped by category and ordered by the filename's UTC creation timestamp
within each category; the topic breaks ties. This is a presentation order, not
an implementation or merge order. Existing direct notes in `CHANGELOG.md` are
also supported and kept before the corresponding entries, except that a category
with lower-level subsections receives entries before its entire existing body
to avoid splitting a list item or changing a subsection's scope.
Consumed entry files are deleted as part of release preparation. This
`AGENTS.md` and other nonmatching files are not consumed or deleted.
