# HizoFS ownership and placement

Choose a destination by compatibility responsibility, not by filename suffix.

- Existing-container bytes/meaning, versions, kinds, bounds, canonical ordering, paths, crypto domains/contexts/AAD, authority/recovery, and reader validity belong in `00-format/`.
- Ordinary TypeScript under `00-format/` is the production machine authority. Production format uses no custom code generation, JSON owner registry, generated output contract, output manifest, or Vite lifecycle dependency.
- Web Crypto execution, secrets, and secure randomness belong in `01-crypto/` and consume the `00-format` contract directly.
- Backend I/O, filesystem algorithms, indexes, runtime, maintenance, inspection, API, and UI stay in their owner directories.
- Consumers must not redeclare magic, kind tables, crypto domains, field order, or hard limits. Add a needed format concept to `00-format/` and import it directly.
- Do not add heuristic lint that guesses semantic duplicates from numbers, strings, names, AST shapes, documentation, or tests. Use exact dependency/path/fixture checks.
- Never import debug features from HizoFS core.
- HizoFS core, API, runtime, and Worker own only generic filesystem, session, and Transition contracts. They must not name, type, import, or branch on Naidan application features such as Wesh, Chat, or File Explorer.
- Only separately reviewed exact debug roots may receive deep-import exceptions; future `debug-*` names inherit nothing.

## Strict diagnostics terminology

Within HizoFS, `diagnostics` means optional observation-only logic. Removing or
not injecting diagnostics must not change filesystem return values, errors,
persisted bytes, authentication, durability, publication, recovery,
concurrency decisions, algorithm selection, or resource bounds.

Logic that changes any of those properties is not diagnostics, even when it
exists mainly for benchmarking, debugging, validation, or performance analysis.
Detailed ownership, failure-isolation, privacy, and hot-path rules are defined
by `diagnostics/AGENTS.md`.
