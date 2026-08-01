# Naidan Persistence Control persisted-compatibility boundary

Ordinary TypeScript in this directory is the production machine authority for Naidan-only control bytes. Production format uses no custom code generation, production JSON registry, generated output contract, output manifest, or Vite lifecycle dependency.

Import only the narrow HizoFS compatibility surface explicitly allowed by the architecture rule. Do not deep-import HizoFS `00-format` internals and do not duplicate portable HizoFS values.

Keep runtime routing, physical I/O, crypto execution, transition orchestration, diagnostics, and UI outside. Consumers import authority modules directly. Use exact dependency/path/fixture checks, not heuristic lint that guesses semantic duplicates.
