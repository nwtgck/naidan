# Storage Boundary

This file applies to `src/00-storage/**`.

## Responsibilities

```text
00-dto/
  Shared persisted formats and schemas for ordinary Naidan storage areas

mapper/
  Conversion between persisted DTOs and `src/01-models/**`

service/
  Public persistence operations and provider implementations
```

## Self-contained persisted-format owners

Do not assume every persisted schema belongs in the shared `00-dto/` directory.

A self-contained portable subsystem may own a nested `00-format/` when its complete released-data compatibility contract must stay together as one high-sensitivity review boundary. The approved owners for this migration are:

```text
service/hizofs/00-format/
service/naidan-persistence-control/00-format/
```

This exception is not based on a DTO suffix. It exists because binary/JSON layout, path naming, identifiers, crypto context/AAD/KDF contracts, authority selection, publication, fallback, recovery, and hard reader limits can all break persisted compatibility without appearing in one DTO type.

Do not add unrelated algorithms, diagnostics, UI messages, runtime caches, or backend I/O to a nested `00-format/`; noise weakens the breaking-change review signal. A new self-contained owner requires explicit architecture review and local `AGENTS.md` guidance.

## Internal Dependency Direction

The following dependencies are allowed for the shared storage areas:

```text
service → mapper
service → 00-dto
mapper  → 00-dto
```

The reverse directions are forbidden.

A nested self-contained format owner may be consumed only through the dependency directions defined by its local `AGENTS.md` and architecture tests. It must not import application features or become a convenience public API.

All storage areas may depend on `src/01-models/**`, `src/constants.ts`, and `src/utils/**` when appropriate.

Storage code must not depend on `src/features/**`, `src/components/**`, `src/composables/**`, `src/logic/**`, or `src/strings/**`.

The only intentional dependency-direction exceptions are separately reviewed exact overrides for `src/features/debug-hizofs/**` and `src/features/debug-opfs-encryption/**`. Those features may observe HizoFS internals; HizoFS and normal features must never import them. No `debug-*` wildcard is allowed.

## Public Boundary

Code outside `src/00-storage/**` must use `src/00-storage/service/**`.

Shared `00-dto`, mapper internals, and nested `00-format` owners are persistence internals. Do not expose them as convenient application APIs.

Persistence errors can cause data loss. Prefer explicit validation, backward compatibility, auditable conversions, and mechanically enforced migration inventories over convenience abstractions.
