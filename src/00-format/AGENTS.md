# Persistence Format

This directory is the review boundary for compatibility with existing Naidan data.
A change to where normal application code stores data, what it writes, or how it
interprets old data must be visible in this directory's diff.

- Start at `01-layout/layout.ts` to find the saved paths, keys, and migrations.
  `experimental.layout.ts` holds formats whose design is still evolving and
  their format-specific rules. `layout-entries.ts` provides shared constructors
  for both layouts. Use named primitives that take logical IDs, domain values,
  and raw I/O. Each primitive selects the path or key and the persisted
  representation together. Keep DTOs and schema selection inside the format for
  normal storage operations. Explicit transfer and inspection can use their own
  projections.
- Keep the primitives thin, alongside DTOs, persisted-value conversions, and
  pure migration rules. Storage owns browser I/O and its error handling, locks,
  and migration execution. The import/export feature owns the ZIP format and
  operations.
- Include definitions needed to interpret or maintain data from an earlier run.
  Cross-tab message protocols belong to their transport, including when it uses
  LocalStorage to deliver a signal. Keep stable format diffs small enough to
  review independently of changes to runtime behavior. When reviewing additions
  here, check which saved data needs each definition and why it belongs here.
- Keep format changes readable in a diff. Refer to the declared operation by its
  name. When exposing a subset of a declaration, name those fields explicitly.
- A user can open any supported old store directly with the current app. Keep
  old readers and migrations when you add a new write format. Remove old
  support only as an explicit compatibility decision.
- Review changes to established formats as compatibility changes. Experimental
  formats can evolve while their design is still being settled. Review what each
  change does to data already written with those formats.
- Keep definitions at their physical locations in the layout when a format is
  superseded. Add its successor and reference the existing definition from the
  migration. Keep removals explicit in diffs.
- Use `dtozod` for DTO definitions. Direct Zod imports here and extensions to
  `dtozod` require the user’s explicit approval.
- Verify compatibility through the normal storage entry points using fixtures
  that preserve the old names and values independently of the current layout.
