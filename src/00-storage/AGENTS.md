# Storage Boundary

This file applies to `src/00-storage/**`.

## Responsibilities

```text
00-dto/
  Persisted formats and their schemas

mapper/
  Conversion between persisted DTOs and `src/01-models/**`

service/
  Public persistence operations and provider implementations
```

## Internal Dependency Direction

The following dependencies are allowed:

```text
service → mapper
service → 00-dto
mapper  → 00-dto
```

The reverse directions are forbidden.

All storage areas may depend on `src/01-models/**`, `src/constants.ts`, and `src/utils/**` when appropriate.

Storage code must not depend on `src/features/**`, `src/components/**`, `src/composables/**`, `src/logic/**`, or `src/strings/**`.

## Public Boundary

Code outside `src/00-storage/**` must use `src/00-storage/service/**`.

`00-dto` and `mapper` are persistence internals. Do not expose them as convenient application APIs.

Persistence errors can cause data loss. Prefer explicit validation, backward compatibility, and auditable conversions over convenience abstractions.
