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
- Decoding embedded `data:` input through platform fetch is local processing,
  not network access. Do not confuse it with permission to fetch remote images,
  arbitrary same-origin endpoints, or other URL schemes.
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

## Model-visible history and KV cache fidelity

- Preserve the model-visible representation of messages across live generation,
  tool continuation, stored-history reconstruction, and subsequent requests.
  Equivalent meaning or identical UI rendering does not establish identical
  tokenizer input or compatibility with an existing KV cache.
- Do not normalize inline `<think>` content into a `thinking` or
  `reasoning_content` property, or perform the reverse conversion, merely to
  unify representations. Handle equivalent visual presentation in the UI without
  rewriting the underlying model-visible history.
- Apply the same rule to system prompts, default instructions, role boundaries,
  whitespace, special tokens, tool declarations, tool-call IDs and arguments,
  and tool-result serialization. In particular, retain assistant tool-call
  content already supplied to the model during the live tool loop.
- A required model-native protocol adapter must be justified against the actual
  tokenizer/template and the live and reconstructed input paths. Do not assume
  that introducing a native-looking field preserves those inputs. Verify the
  relevant token sequences with independent expectations before reusing cached
  state; do not rewrite recorded evidence to make a changed input appear equal.
  With that justification, the model-specific adapter may translate native
  framing into the existing Provider output contract and map it back on input.
  This does not authorize changes to shared stored messages or the common chat
  API, or moving model-native special-token interpretation into common UI.
- Reuse KV state only when its ownership, model/runtime configuration, and
  cached token prefix agree with the actual next input. Matching message counts,
  visible text, or token lengths alone is insufficient. If a legitimate input
  change invalidates that agreement, discard the incompatible cache and process
  the correct input instead of forcing reuse or changing the user's request.

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
- Evidence ZIP creation and validation at runtime must use the existing shared
  `@/utils/zip-stream` core. JSZip is development-only; it may serve as an
  independent test/build tool, but must not be imported by runtime code, including
  runtime-facing type imports. Do not add a JSZip compatibility wrapper.

## Investigation knowledge

- Read [DOWNLOAD_LOAD_INVESTIGATION.md](./DOWNLOAD_LOAD_INVESTIGATION.md) before
  changing Download planning, candidate selection, cache completeness, progress,
  or Production Load orchestration.
- That document records time- and version-specific investigation evidence, not
  an authoritative specification. Do not copy its conclusions into an
  implementation without checking the active Transformers.js bundle, current
  Naidan route, relevant tests, and current model evidence.
- Preserve the distinction in that document between verified facts,
  observations, hypotheses, and proposed designs. A hypothesis must not become
  a Production invariant merely because it was useful in an earlier incident.

## Required regression coverage

### Evidence-backed upstream fixes

- Version-bound Transformers.js fixes through the Vite integration in
  `build/transformers-js-fixes/` are authorized when supported by a reproducible
  counterexample and inspection of the active upstream source. Additional fixes
  using this method do not require separate approval solely because they touch
  another upstream location.
- Preserve the original source and license, record reviewed input/output
  identities, and reject unknown upstream inputs rather than applying a
  similar-looking transformation. Do not edit installed package files.
- Preserve upstream structure and formatting instead of rewriting third-party
  files to satisfy Naidan-specific lint rules. File-wide lint exceptions are
  authorized for upstream-derived files when needed for that maintenance
  boundary, including upstream-derived files with localized Naidan fixes.
  A directory named `upstream/` is not required to contain only unmodified files.
  Keep the original reference distinguishable from locally modified versions so
  the intended changes can be compared without reconstructing the original.
  The upstream-derived files under `build/transformers-js-fixes/upstream/` are
  excluded from Naidan lint; Naidan-owned transformation code and tests remain
  linted.
- Confirm the regression fails before the fix, then verify the actual transformed
  runtime and the model-specific regressions. Do not weaken successful paths,
  optional-resource behavior, or valid candidate fallback to make a test pass.
- Keep Naidan-owned defects in Naidan. This authorization does not permit new
  network authority, implicit Download during Load, or custom OPFS persistence;
  those boundaries still require explicit approval to change.

### Evidence-derived test data

- Read [REPLAY_TESTING.md](./REPLAY_TESTING.md) when deriving model regression
  tests from investigation evidence. It describes replay boundaries, conditional
  contracts, evidence ownership, and model-local test patterns.
- Investigation ZIPs are development inputs, not test-time dependencies. Only
  `naidan/` is published; sibling handoff and evidence directories are private.
- Investigation archive layouts and observation schemas are not application
  persistence contracts. Breaking changes are allowed when they improve capture,
  analysis, or evidence-derived tests. Identify the format so old observations
  are not silently misinterpreted. This does not authorize changes to model-cache
  or user-setting persistence, or fabrication of observations missing in old ZIPs.
- Select the data needed to reproduce and verify a contract, remove personal
  information, and commit that test data inside this repository. Do not commit
  entire investigation archives, unused logs, user conversations, or environment
  inventories merely because they were present in an input ZIP.
- Choose JSON, TypeScript, or other fixture formats according to the data. Large
  required raw assets may be compressed losslessly; do not simplify their contents
  in ways that hide the failure or change the runtime path being tested.
- Regression tests must run in ordinary CI using repository-owned fixtures. Do
  not require an evidence-path environment variable, a private local file, or an
  evidence download step, and do not exclude them from CI to conceal that dependency.
- Keep model-specific revisions, evidence, and expectations independently
  readable in per-model tests. Share mechanics only when a change to that
  responsibility should intentionally affect all consumers, not merely because
  current code or values look alike.
- Both Download and generation regressions must protect successful model paths,
  not only reproduce known failures. Use comparable applicable scenarios across
  exact models so shared implementation changes can be checked against unchanged
  model-specific expectations. Record missing evidence even for models that
  currently appear to work, including what additional capture would enable.
- Within one replay boundary, prefer one test file per exact model, grouping
  scenarios with `describe()`. Separate evidence files do not require separate
  test files. Add scenario suffixes only for a concrete execution or maintenance
  boundary, not automatically for every capability or new observation.
- Keep model-specific scenarios in a comparable simple-to-complex order: basic
  user/system input, first generation and settlement, supplied history and
  same-runtime continuity, independent next input, reasoning, tools, then
  multimodal input. Keep supporting native controls near the relevant contract.
  Order by the behavior being verified, not when a test was added or whether it
  currently passes. Missing evidence does not justify empty or skipped tests.
- Treat an unrecorded resource as missing evidence, not as proof that the
  repository does not contain it. Record known absence explicitly and reject
  unexpected fixture requests instead of falling through to the internet.

### Offline boundaries

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
