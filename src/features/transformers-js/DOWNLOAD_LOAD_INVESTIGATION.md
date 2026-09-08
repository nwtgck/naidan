# Transformers.js Download and Load Investigation Notes

## Status and use

This document preserves investigation knowledge about Naidan's Transformers.js
Download and Load paths. It is not a specification and is not a substitute for
reading the active implementation.

The observations below were made against the Transformers.js 4.2 runtime and
the Naidan implementation present when this document was written. Transformers.js
internals, model repositories, exported model configurations, and Naidan routes
can all change. Before relying on a finding:

1. inspect the installed Transformers.js source or built bundle;
2. confirm the AutoClass, model configuration, candidate, and exact revision;
3. compare the finding with current repository and OPFS evidence;
4. run a regression against the real bundled runtime without external internet
   access; and
5. treat a disagreement as a reason to investigate, not as permission to force
   the old expectation.

Keep verified facts, model observations, hypotheses, and design proposals
separate. Update or supersede stale findings rather than silently treating them
as permanent API contracts.

## Naidan invariants

These are project requirements rather than conclusions inferred from
Transformers.js behavior:

- Explicit Download is the only model operation allowed to access Hugging Face.
- Normal Production Load is offline-only and read-only with respect to OPFS.
- A missing local resource during ordinary Load is a terminal error. Load must
  not repair the cache or implicitly enter Download.
- A higher-level flow may explicitly start Download after a Load failure, but
  the two operations and their authority must remain distinguishable.
- Exact immutable repository revisions are preferred over mutable `main`.
- Do not persist a Naidan-specific candidate plan or transaction manifest in
  OPFS without explicit user approval. Per-file `.complete` markers remain the
  permitted crash-safety mechanism.
- Model Support Investigation observes these Production boundaries and must not
  broaden them.

## Verified Transformers.js 4.2 behavior

### Loading and downloading share one upstream API

`from_pretrained()` performs cache lookup, remote retrieval when permitted,
response-body reading, and runtime session construction. Naidan must impose the
Download/Load separation outside that upstream API.

### A progress callback changes the request path

`PreTrainedModel.from_pretrained()` calls `get_model_files()` and performs a
metadata prepass when it receives a non-default progress callback. Those
metadata requests are useful for upstream aggregate progress, but they are not
proof that the corresponding files are required by the selected Production
AutoClass.

Consequences:

- do not interpret every request caused by the progress metadata prepass as a
  semantic runtime requirement;
- an actual-request observer intended to discover the Production model files
  should not pass the Transformers.js progress callback; and
- Naidan can report transfer progress at its own streaming boundary.

### ModelRegistry can disagree with the selected AutoClass

`ModelRegistry.get_model_files()` resolves sessions from the native model type.
It does not receive the selected AutoClass or the `textOnly` decision made by
`resolveTypeConfig()` inside `PreTrainedModel.from_pretrained()`.

For a cross-architecture load where a `ForCausalLM` class loads a configuration
whose native architecture ends in `ForConditionalGeneration`, Transformers.js
4.2 can select the native session configuration with `textOnly: true`. The
runtime request set can therefore be smaller than the ModelRegistry set.

ModelRegistry is valuable comparison evidence, but its output must not be
unconditionally unioned into a Production download plan.

### Current generic model session construction exposes requests before sessions

For the generic `PreTrainedModel.from_pretrained()` path inspected in
Transformers.js 4.2:

1. the config and selected model class determine the session map;
2. `constructSessions()` starts every session through `Promise.all()`;
3. each session starts its core ONNX and declared external-data requests; and
4. inference-session construction follows after those bytes resolve.

This makes a held cache/fetch boundary a practical way to observe the selected
Production route's model-artifact requests without reading multi-GB model
bodies or creating ONNX sessions.

This is version-specific, not a universal guarantee. A future model class may
override `from_pretrained()`, introduce sequential or content-dependent
requests, or otherwise invalidate a quiescence-based observer. Such a case must
fail closed and produce new evidence.

### Some tokenizer and processor probes omit revision

Observed Transformers.js 4.2 tokenizer and processor registry helpers can issue
revisionless requests that resolve to `main`, even when the enclosing operation
uses an exact revision. An exact-revision operation must canonicalize only
known-safe revisionless metadata requests to the selected local exact revision.
It must not read mutable upstream `main` during offline Load.

## Model evidence observed so far

### Qwen3.5 cross-architecture planning

For the inspected Qwen3.5 CausalLM route, actual Production model requests used
decoder and embedding sessions while ModelRegistry also listed vision encoder
artifacts. Unioning both sets caused an over-download. Historical fixture tests
record this mismatch, but the active route and bundle must still be checked
before applying that expectation to another Qwen repository or version.

### Gemma 4 route differences

An older recorded Gemma 4 Production observation used `AutoModelForCausalLM`
and requested only decoder and embedding sessions. The current Naidan route
uses `AutoModelForImageTextToText`; the inspected runtime consequently requests
audio encoder, decoder, embedding, and vision encoder sessions for q4f16.

This is an example of why historical evidence must not be treated as the
current contract. The audio and vision files are not proven over-downloads
merely because a previous text-only route omitted them.

### SmolLM2 and LFM2.5 observations

In the inspected batch evidence for the successful SmolLM2 and LFM2.5 models,
held Production model requests matched the ModelRegistry model-artifact sets.
This shows that ModelRegistry can agree for simpler model families; it does not
remove the cross-architecture counterexample.

### Exact-revision metadata visibility

LFM2.5 and SmolLM2 evidence exposed cases where exact-revision tokenizer
metadata existed in OPFS while a revisionless runtime probe looked under
`main`. Testing the cache wrapper and candidate acceptance separately did not
catch the broken connection between them. End-to-end resource identity must be
checked across repository, Download, OPFS, runtime request, and acceptance.

## Current Naidan implementation findings

These findings describe the implementation at the time of writing and should
be rechecked after related changes.

### Download performs a discarded full runtime acceptance

The ordinary Download preparation currently:

1. downloads runtime metadata;
2. observes and downloads candidate model artifacts;
3. creates a separate offline candidate-acceptance Worker;
4. reads the complete model from OPFS and creates its ONNX sessions; and
5. terminates that Worker.

The model manager then starts normal Production Load, which reads and compiles
the model again. If another model is already active, the acceptance Worker can
temporarily compete with it for memory and GPU resources. A Gemma 4 download
was observed remaining at 99% after all displayed artifact bytes were present,
while a browser reload followed by normal Load and generation succeeded. A
post-transfer acceptance stall is one plausible explanation. The observation
does not identify the stalled phase or prove that the reload used the same
revision and candidate. Confirm those identities and phase telemetry before
attributing the incident to acceptance, GPU contention, or incomplete bytes.

### Progress display combines different meanings

The Download Worker reports `loaded` and `total` while streaming a prefetched
file, but does not currently derive the per-file `progress` value or emit a
terminal `done` event. The UI displays the retained `progress` field, so a row
can show complete byte counts and `0%` at the same time.

High-frequency notifications are throttled. Without an unthrottled terminal
event, the visible final byte count can remain one chunk behind the internal
state. Overall progress is deliberately capped at 99% until the entire Download
preparation, including runtime acceptance, returns.

These are distinct issues: misleading row progress does not prove an incomplete
OPFS file, and a 99% overall state does not identify which post-transfer phase
is active.

### Staging has a significant storage and I/O cost

Explicit prefetch currently writes each response to a staging file and then
copies it to the final OPFS file before creating `.complete`. During promotion,
this can require approximately twice the largest artifact's storage and adds a
full local read/write pass. Because `.complete` is already the committed-state
indicator, a future design may be able to remove the marker, truncate/write the
final path, verify its size, and recreate the marker. That change needs its own
crash, quota, and cleanup tests before adoption.

## Design direction under investigation

The following is a proposal, not an accepted specification.

The held-request and automatic recovery ideas below are retained as investigation
history, not approved work. The subsequent adversarial audit establishes why a
quiet interval cannot certify selection completeness. Automatic missing-file
recovery remains outside the approved scope.

### Production-route request planning

Use a dedicated planner with the same AutoClass, exact revision, config, and
candidate as Production Load. Its cache boundary should:

- serve small config/tokenizer/processor resources from exact-revision OPFS;
- record and hold model-artifact cache requests before their bodies are read;
- forbid Hugging Face access in the offline variant; and
- terminate the planner after obtaining a request observation. Stability over
  a time interval alone must not promote that observation to a complete plan;
  see the adversarial audit below.

The resulting set can be compared with repository and ModelRegistry sets:

- actual request intersect registry: agreement;
- actual request minus registry: a registry omission;
- registry minus actual request: a possible overestimate;
- actual request minus exact repository manifest: an invalid or unavailable
  candidate.

Only actual Production requests should drive transfer. ModelRegistry should be
diagnostic evidence unless a newly verified contract establishes otherwise.

### One useful runtime Load

After Explicit Download transfers a candidate, the upper-level user flow can
start normal offline Production Load exactly once. A successful model remains
active instead of being discarded and loaded again.

If that Load rejects the runtime candidate, the upper-level Explicit Download
flow may deliberately select and download the next candidate, then start a new
offline Load. The Load Worker itself must never gain network or OPFS-write
authority. A Load started outside an Explicit Download flow must stop on a
missing required file.

### Late or content-dependent requests

A planner must not claim completeness solely because no new request appeared
for an arbitrary delay. If the real offline Load asks for an unplanned local
resource, classify it as a planning invariant violation and stop. While an
Explicit Download flow is still active, its upper-level coordinator may validate
that path against the frozen repository and explicitly run another bounded
Download round. Each successful round must add a previously absent exact-
revision file or terminate, which bounds the process by the finite frozen
repository manifest.

## Required adversarial checks for this direction

Before adopting the proposed design, tests should establish at least:

- the actual bundled Qwen3.5 CausalLM plan excludes unrequested vision files;
- the current Gemma 4 image-text route includes every session it actually
  constructs, including audio and vision when required by that route;
- a q4-only repository can skip unavailable q4f16 without downloading an
  unquantized fallback;
- ModelRegistry disagreement is recorded but does not broaden transfer;
- planning reads no multi-GB OPFS body and creates no ONNX session;
- planner and Production Load make zero external requests in offline mode;
- an unexpected late file request fails closed;
- a normal Load never invokes Explicit Download;
- fallback Download occurs only under the upper-level explicitly online flow;
- an already active model does not coexist with a discarded full acceptance
  copy merely to complete Download;
- progress receives a terminal file event even when the final chunk falls
  inside the notification throttle window; and
- all `.test.ts` coverage uses mocks or loopback fixtures and cannot fall
  through to the external internet.

## Updating these notes

When new evidence changes a conclusion, record the model ID, exact revision,
selected route and candidate, installed Transformers.js version, and whether
the evidence came from repository metadata, actual runtime requests, OPFS,
runtime acceptance, or generation. Do not generalize one model result to an
entire architecture without an explicit regression that supports that scope.

## Adversarial audit of the proposed planner, 2026-09-08

Scope: challenge the proposed design before changing Production. This audit
does not establish that a Production planner has been implemented or accepted.

Reproduction baseline:

- Naidan HEAD: `aab692bf` (plus these uncommitted investigation notes/tests).
- Transformers.js: `4.2.0`.
- Installed `dist/transformers.web.js` SHA-256:
  `25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff`.
- Test: [request-planner-adversarial.test.ts](./download-verification/fixtures/request-planner-adversarial.test.ts).

### What the executable audit establishes

The seven added cases use the installed web bundle with its actual model
selection and resource-loading code. Config planning fields are reconstructed
from the Qwen3.5-2B, Qwen3.5-4B, and Gemma 4 repository fixtures; other config
fields and cache responses are synthetic. They do not represent complete
exported model packages. The test explicitly selects the browser environment
branch when importing the bundle in Node, blocks both global and runtime fetch,
and instruments the exact imported ORT `InferenceSession.create` method.

Holding artifact cache requests produces zero artifact stream reads and zero
session creations during observation. Releasing tiny synthetic bodies lets the
real Transformers.js loader finish against the instrumented ORT boundary.
This checks request orchestration and session counts, not ONNX validity,
WebGPU compatibility, real OPFS behavior, or generation.

Results:

- Qwen3.5-2B CausalLM exposes four q4f16 model paths; Qwen3.5-4B exposes
  five. ModelRegistry includes two additional vision paths in each case.
- Gemma 4 ImageTextToText exposes eight q4f16 model paths and constructs
  four instrumented sessions. Its registry set agrees in this fixture.
- Enabling the progress callback exposes Qwen vision metadata cache requests
  before session loading even though the actual CausalLM constructs only two
  sessions. Therefore cache-request observation also needs to distinguish
  metadata prepass requests from required body requests.
- A synthetic `device_config.webgpu.use_external_data_format: 2` override
  makes the real loader request two external-data chunks that ModelRegistry
  omits. Registry disagreement is not restricted to excess modality files.
- Delaying external-data cache processing until after the quiescence snapshot
  produces a two-file snapshot followed by two more requests in the actual
  bundle. This disproves completeness inferred solely from elapsed quiet time
  for a planner that records after asynchronous cache work. Recording at the
  cache entrance before any I/O avoids this particular counterexample, but
  does not prove all loaders expose every request before a deadline.
- Starting a second load at another revision while the first is held in the
  same module reuses its pending model-file requests. Upstream's in-flight key
  uses model ID and filename, without revision. A held observation must own
  a disposable runtime/Worker; it cannot be left pending in the runtime later
  used for Production Load or another revision.

The three targeted test files (seven new audit cases, two existing real-bundle
LFM cases, and two barrier cases) passed: 11 tests total. The existing LFM cases
establish requested q4f16/q4 paths, not end-to-end fallback correctness.

### Claims the proposal has not established

1. **A complete plan from a quiet interval.** A finite observed request set is
   useful evidence, but lacks an upstream completion signal. An exact repository
   manifest supplies file existence and bounds; it does not say which unobserved
   files a selected loader will later require. General support needs an explicit
   supported-loader contract or a result that remains inconclusive.
2. **Every Production resource is covered.** Holding model loading prevents
   later sequential tokenizer/processor preparation from running in the full
   Production path. The separate metadata phase still needs a verified resource
   contract, including optional files and revision aliases. These model-only
   tests do not establish it.
3. **Acceptance can be removed without changing semantics.** File observation
   does not prove runtime compatibility. Reusing one successful offline Load
   would require explicit Worker ownership, old-model disposal, cancellation,
   failure classification, and candidate-selection rules. It cannot follow
   automatically from a planner test passing.
4. **Runtime failure justifies another download.** Out-of-memory, device loss,
   missing metadata, and unsupported operations are different outcomes. A generic
   rejection must not automatically trigger multi-GB fallback transfers. The
   proposed upper-level recovery flow remains unapproved design work; ordinary
   Load continues to stop on missing files.
5. **Finite repository size guarantees completion.** Monotonic additions bound
   the number of productive rounds only if revision/candidate identity is fixed,
   files remain available, and each round adds a new file. It does not bound a
   stuck stream or session creation. Repeated requests, cancellation, timeout,
   and cache changes still need terminal outcomes. A timeout is inconclusive,
   not evidence of incompatibility or download success.

Consequently, the earlier statement that the design's feasibility was already
confirmed was too strong. The request-observation mechanism is promising for
the inspected paths. Its use as the sole completeness authority and its proposed
replacement of runtime acceptance require additional design and validation.

### Browser evidence still needed for the Gemma incident

No browser action is required to accept the counterexamples above. To diagnose
the reported 99% stall, future evidence must capture the exact model ID,
revision, candidate, last completed stage, outstanding Worker operation, and
the model already active before Download. Compare those with the revision and
candidate used by the successful reload. A post-reload MSI run alone cannot
reconstruct the earlier stalled Worker's state.

If the incident recurs, preserve the console log before reloading and note
whether network transfers are still active and whether `worker tryLoad start`
or `worker tryLoad success` was emitted. Those logs narrow the stage but do not
prove GPU memory pressure. The current telemetry may be insufficient; design
stage/candidate reporting first rather than requiring blind repeat downloads
or deleting a usable cache. Real browser OPFS, Worker lifecycle, and GPU behavior
remain separate canary checks after a concrete implementation exists.
