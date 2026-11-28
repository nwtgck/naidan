# Storage Operations

This file applies to `src/00-storage/**`.

Use the record primitives and migration definitions in `src/00-format` for persisted data.
This directory owns provider implementations, browser I/O, locks, transactions,
and migration execution. Expose persistence operations through `service/`.

Storage may depend on the format, models, constants, and utilities. It must not
depend on features, components, composables, application logic, or strings.
