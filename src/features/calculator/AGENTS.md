# Calculator Feature

This file applies to `src/features/calculator/**`.

The calculator is a deterministic numeric expression interpreter. Preserve these invariants:

- Never use `eval`, the `Function` constructor, dynamic imports, or input-driven JavaScript property access.
- Resolve identifiers and functions only through the calculator catalog allowlist.
- Keep tokenization, parsing, evaluation, formatting, and help generation separate.
- Do not add variables, assignment, user-defined functions, randomness, current time, or other external state.
- Every evaluation loop whose work depends on numeric input must consume the operation budget. Tokenization and parsing must enforce their own structural limits.
- Every catalog function must include help metadata and at least one executable example.
- Keep Tool, Zod, Vue, storage, and chat concerns outside this Feature.
- Do not add mathjs compatibility syntax unless it independently improves the calculator language.
- Treat calculator input failures as diagnostics. Unexpected implementation errors must remain exceptions.
