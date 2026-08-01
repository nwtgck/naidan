# HizoFS persisted-compatibility boundary

Everything here is reviewed as capable of changing compatibility with already released `.hizofs` containers.

Ordinary TypeScript in this directory is the production machine authority. Production format uses no custom code generation, production JSON registry, generated output contract, output manifest, or Vite lifecycle dependency.

Belongs here: exact bytes/layouts/versions/kinds/flags/bounds, canonical JSON, identifiers/paths/order, crypto suite/KDF/domain/context/AAD and nonce representation, pure authority/recovery/reader-validity rules, direct golden/KAT fixtures, and cross-record semantics.

Does not belong here: Web Crypto/OPFS execution, cache/runtime/maintenance scheduling, UI/diagnostics/benchmarks, generic errors, or convenience re-exports of implementation modules.

For every change, state compatibility impact and update direct authority modules, exact fixtures, corruption tests, and independent-reader design specification as applicable. Consumers must import the authority; they must not redeclare it. Static guards are limited to exact ownership/dependency/deleted-path/fixture checks. Do not add heuristic duplicate-literal lint.
