# Source Layout

This file applies to all files under `src/**`.

A deeper `AGENTS.md` supplements this file. Rules from this file continue to apply unless the deeper file explicitly overrides them.

## Purpose

Source placement must clarify ownership, dependency direction, and removal boundaries. Do not create directories merely to make the tree look more categorized.

Existing placement is not automatically correct. However, do not mix feature work with unrelated source relocation. If a better placement is discovered but is not required for the requested change, explain the issue and ask the user whether the relocation should be handled as a separate change.

Do not introduce conceptual layers or directory names that do not exist in the repository.

## Primary Directories

```text
src/00-storage/
  Persistence formats, mapping, and storage implementations

src/01-models/
  Naidan-wide concepts, types, IDs, schemas, and pure model operations

src/features/
  Capabilities that can be removed from Naidan as a cohesive unit

src/components/
  Vue components not owned by one removable feature

src/composables/
  Vue composables not owned by one removable feature

src/logic/
  Naidan-specific non-Vue application logic

src/utils/
  Naidan-independent reusable helpers and technical primitives

src/strings/
  User-visible strings, translations, and string loading

src/constants.ts
  Static constants shared across Naidan
```

`src/main.ts` is an entry point. It does not define a separate architectural layer.

## Placement Order

When placing new code, consider the following questions in order:

1. Is the code part of persistence format or persistence implementation?
2. Does the code define a Naidan-wide concept?
3. Can the code be removed as part of one cohesive feature?
4. Is the code a Vue component not owned by one feature?
5. Is the code a Vue composable not owned by one feature?
6. Is the code Naidan-specific non-Vue application logic?
7. Is the code a Naidan-independent reusable helper or technical primitive?

Do not decide ownership from the file extension, filename, or a `use` prefix alone.

Feature extraction is intentionally conservative. Most Naidan behavior is closely integrated, so code belongs in `src/features/**` only when the removal boundary is clear.

## Adding Entries Directly Under `src`

Do not add a new file or directory directly under `src` without asking the user first.

Before requesting approval, explain:

- why none of the existing primary directories is appropriate;
- the proposed name;
- the proposed responsibility;
- the expected dependency direction.

Existing entry files and declarations under `src` are not precedents for adding another top-level entry.

## Application Dependencies

The following directories do not form dependency layers and may depend on each other when needed:

```text
src/features/**
src/components/**
src/composables/**
src/logic/**
```

Application code may depend on:

```text
src/01-models/**
src/00-storage/service/**
src/strings/**
src/constants.ts
src/utils/**
```

Application code must not depend directly on:

```text
src/00-storage/00-dto/**
src/00-storage/mapper/**
```

Use the public API under `src/00-storage/service/**` when application code needs persistence behavior.

Type-only imports, dynamic imports, test mocks, worker URLs, and other static module references count as dependencies.

## Temporary Dependency Exceptions

An existing dependency violation may be preserved temporarily only with a suppression immediately before the exact import or static reference:

```ts
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Replace this dependency with the appropriate public API.
import ...;
```

Do not disable the rule for an entire file or block.

Write the TODO in English and describe the concrete direction for removing the dependency. Do not use an existing TODO as precedent for introducing another violation.
