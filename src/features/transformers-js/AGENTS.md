# Transformers.js Architecture

## Offline-first boundary

Naidan intentionally separates model downloading from model loading even
though Transformers.js combines cache lookup, remote fetching, and loading
inside `from_pretrained()`.

### Explicit Download

- Explicit Download is the only operation allowed to access Hugging Face for
  repository metadata or model artifacts.
- Download may inspect repository metadata and write model artifacts to OPFS.
- Download must resolve and use an immutable repository revision when possible.
- Download capability must be isolated in a dedicated Worker.
- Do not expose Download APIs from a Production Load Worker.

### Downloaded Model Load

- Loading a downloaded model must work without internet access.
- A Production Load Worker must not access Hugging Face for revision
  resolution, metadata, tokenizer files, processor files, model files, or
  fallback artifacts.
- A Production Load Worker may fetch only required Naidan same-origin runtime
  assets such as ONNX Runtime MJS/Wasm.
- OPFS access during Load must be read-only.
- A missing required local file is a terminal Load error.
- Load must not repair the cache, resume a download, or call the Explicit
  Download path.
- Any future recovery flow must be implemented by an upper-level coordinator
  that explicitly starts Download and then starts a new Load operation.

## Worker isolation

- Download and Production Load must use separate Worker entries.
- Do not implement their separation by temporarily switching mutable global
  `env.fetch`, `env.customCache`, or OPFS mutation policies in one shared
  Worker.
- Install the offline fetch policy before importing the Transformers.js
  runtime in a Load Worker.
- Do not capture or retain an unrestricted fetch implementation in a Load
  Worker.
- Production and Reference investigation loads must use the same offline
  resource-access boundary.

## Candidate selection

- Only locally complete candidates may be passed to the runtime loader.
- An incomplete candidate may be skipped during local planning.
- An unexpected required-file miss after a candidate was classified as
  complete is an invariant violation and must stop the Load.
- Runtime incompatibility may fall back only to another locally complete
  candidate.
- Candidate fallback must never initiate a download.

## OPFS state

- Per-file `.complete` markers are the permitted crash-safety mechanism because
  OPFS does not provide the required atomic rename/move operation.
- Do not add a Naidan-specific persisted candidate manifest or other model
  metadata without explicit user approval.
- Candidate completeness must be derived from the required-file plan and actual
  OPFS files and completion markers.
- Completeness checks must not read or hash multi-GB model bodies.

## Investigation

- Model Support Investigation observes Production contracts; Production must
  not depend on investigation-specific behavior.
- Investigation code must not weaken the Production Load network or OPFS
  mutation boundary.
- An Internet-enabled investigation may perform bounded repository metadata
  probes, but it must not download, resume, or repair model artifacts.
- A raw Transformers.js progress status of `download` is not proof of network
  transfer. Determine the source from cache and fetch observations.

## Required regression coverage

- `.test.ts` files under this directory must not access the external internet;
  localhost and loopback fixture servers that emulate Hugging Face are allowed;
- an incomplete fixture or network interceptor must fail the test instead of
  silently falling through to the real Hugging Face service;

Changes to Transformers.js Download, Load, cache, revision, or Worker code must
verify that:

- ordinary Load performs zero Hugging Face requests;
- cache misses do not invoke Download;
- Load does not mutate OPFS;
- immutable local revisions remain usable after upstream `main` advances;
- exact local revisions are preferred over legacy `main`;
- incomplete candidates are excluded before runtime loading;
- unexpected runtime resource requests fail closed;
- MSI cannot broaden Production network permissions.
