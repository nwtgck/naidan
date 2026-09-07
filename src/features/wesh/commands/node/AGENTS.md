# Wesh node command invariants

The Wesh `node` command is intentionally **not** a Node.js runtime. It exists only to
provide a high-fidelity, parse-only compatibility surface for `node --check` and
`node -c`.

These rules are security and architecture boundaries, not temporary missing features:

- Never execute the JavaScript being checked.
- Never add `eval`, `Function`, `new Function`, VM execution, dynamic-module execution,
  Worker-based execution, or an equivalent execution mechanism to improve syntax
  compatibility.
- Reject Node.js runtime/REPL/eval/print/help/version or other non-check invocations with
  the command-owned syntax-check-only diagnostic. Do not grow this command into a Node.js
  runtime implementation.
- Preserve real `--check` argv boundaries where they are observable. In particular, argv
  after the script operand belongs to the script and is not interpreted as Node options.
- Node.js source code must not be copied, translated, or used as an implementation
  blueprint. Compatibility work must be based on black-box behavioral observation of the
  pinned reference Node.js executable and on independently written TypeScript.
- Parser backends must remain parse-only and replaceable. Backend-specific AST and error
  types must not escape the parser adapter.
- Prefer structured parser diagnostics (`reasonCode`, source locations, offsets, details)
  over extracting line/column/message data from formatted exception strings. Do not use
  regular expressions to scrape Babel diagnostic messages.
- The compatibility target is the pinned Node.js `--check` behavior recorded by the Wesh
  compatibility lab. TypeScript syntax is out of scope until the reference `--check`
  behavior itself supports it and the project explicitly expands this scope.
- Keep production changes for this command inside `src/features/wesh/commands/node/**`,
  except for the explicitly allowed registration-only edit in
  `src/features/wesh/commands/index.ts`.
- Do not modify argv-v2, VFS, Wesh lexer/parser/DTO/kernel/worker/shell core, or other
  reserved Wesh core to hide a node-specific compatibility gap. Record such a gap in the
  compatibility lab instead.
