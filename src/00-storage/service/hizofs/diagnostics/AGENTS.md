# HizoFS diagnostics ownership

This directory owns HizoFS observation contracts, bounded accumulators,
snapshots, sanitization, counter validation, and shared failure isolation.

## Strict definition

Diagnostics are optional observation-only logic. Removing or not injecting
this directory's logic must not change HizoFS filesystem return values, errors,
persisted bytes, authentication, durability, publication, recovery,
concurrency decisions, algorithm selection, or resource bounds.

Caches, batching, prefetch, validation, integrity checks, retries, state
machines, recovery decisions, safety budgets, resource limits, and performance
optimizations are not diagnostics when removing them changes execution or
filesystem behavior.

## Ownership and placement

Keep the smallest accurate observation hook next to the owner that knows the
event occurred. Move observation types, aggregation, elapsed-time handling,
overflow checks, snapshots, sanitization, and failure policy here. Do not move
hooks here when doing so would require another traversal, I/O, decode, or copy.

Core owners must not inspect diagnostics counters or snapshots to choose a
filesystem path. A diagnostics port may be absent; the absent path must remain
the direct ordinary HizoFS path and must not allocate observation objects.

## Central failure isolation

Diagnostics failure isolation is centralized in a shared diagnostics facade.
Core owners must not scatter independent `try`/`catch` wrappers around
individual diagnostics calls. The facade may make diagnostics unavailable or
turn later observations into low-cost no-ops, but diagnostics recording failure
must not replace the result or error of the observed HizoFS operation when this
can be achieved without material complexity or hot-path regression.

Strict accumulators may remain available only to diagnostics-owned tests so
invalid observations and overflow handling are still tested directly.

## Privacy and boundedness

Do not expose passphrases, keys, nonces, AAD, plaintext, file contents, raw
paths, filenames, keys, record references, or other stable sensitive
identities. Keep counters, attribution sets, retained events, and snapshots
bounded. Diagnostics must not add storage I/O or cryptographic work merely to
produce a measurement.

## Benchmark boundary

The ordinary HizoFS implementation has priority over Workbench Benchmark.
Workbench explicitly injects diagnostics and consumes sanitized snapshots; it
must not introduce benchmark-only filesystem semantics or a production fast
path. Measure observer effect when a diagnostics refactor could add meaningful
CPU, allocation, or memory cost.
