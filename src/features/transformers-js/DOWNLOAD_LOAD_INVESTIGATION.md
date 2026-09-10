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

## Required-resource rejection and the Vite fixes

### Observed upstream failure

Against the original 4.2.0 web bundle identified above, the LFM2.5-350M
regression in
[download-replay-lfm2.5-350m.test.ts](./download-verification/fixtures/raw-download-replay/download-replay-lfm2.5-350m.test.ts)
completed explicit Download, then removed required q4f16 external data after
offline planning had classified the candidate as complete. The file removal
uses a runtime progress event, not a delay. The test expects terminal failure
without falling back to a separately complete q4 candidate or repairing OPFS.

The original runtime instead left the Load pending and reported an unhandled
rejection. Inspection of the installed bundle identified two related defects:

- `getModelDataFiles()` used an async Promise executor. Rejection from its
  awaited `getModelFile()` did not reject the enclosing Promise.
- `getSession()` started the core-file Promise, awaited external data, and only
  then attached an await to the core Promise. Early core rejection could remain
  unhandled while external data was pending or failed.

A Naidan cache-error check after `from_pretrained()` cannot handle a runtime
Promise that never settles. This is separate from file planning, revision
aliases, optional metadata, or device compatibility.

### Current bounded upstream fixes

The [Transformers.js fixes integration](../../../build/transformers-js-fixes/README.md)
reads unchanged upstream sources and the original web bundle from the pinned
installed dependency, validating their recorded hashes. Earlier unmodified
source copies were removed after byte-identity checks; this repository retains
the license notices, provenance, and exact before/after edits in `String.raw`
literals. Tests independently validate the extracted web sections. It transforms
the browser bundle through Vite without modifying installed package files or
adding an install hook. The Node exports remain unmodified.

The transform makes external-data retrieval return its rejection chain and
observes core and external-data promises together from the outset. It does not
change resource selection, dtype, revision, cache authority, or permissions.
Unknown upstream inputs or an unexpected transformed output are errors, not
permission to apply a similar-looking edit. Recheck the source and counterexample
when upgrading Transformers.js; remove each fix only after
the replacement runtime passes the same failure and success regressions.

The same integration config registers the transform for normal Vite modules,
Worker builds, and dependency optimization. Its output identity participates
in the optimizer cache key, and input/output validation runs even when a warm
cache could bypass the transform hook. Standalone does not gain a Transformers.js
dependency requirement from this integration.

### Regression evidence and limits

The nine model-specific Download/Load suites use checked-in, evidence-derived
metadata and file inventories. Their model bodies are tiny identity-bearing
fixtures, and ORT session creation is instrumented. They exercise actual Naidan
Download, OPFS writer/cache logic, candidate selection, and fresh offline
Transformers.js loading, including tokenizer/processor preparation. They do not
establish real ONNX graph validity, GPU capacity, or generation correctness.

Runtime replay imports now consume a library artifact built through the same
production Vite plugin, without a second test-only patch. Original-source hash
checks still refer to the unchanged upstream package; transformed and final
artifact identities are distinct. Each operation imports a fresh runtime
instance so pending requests or revision state cannot leak from Download or
observation into Load.

The connected Download/Load directory changed from 62 passes and the external-
data timeout above to 63 passes, without changing the model expectations.
Separate compatibility tests exercise late rejection ordering and actual Vite
library, Worker, development-module, and cold/warm optimizer paths. A pass in
these browserless tests does not replace a real-browser OPFS/Worker/GPU canary.

## Connected failure classification and resource identity follow-up

Further adversarial tests of the same runtime found gaps that successful
Download/Load cases alone did not expose:

- Removing Gemma 4's required `processor_config.json` after metadata preparation
  caused candidate acceptance to reject q4f16 as if it were a runtime
  incompatibility. The explicit Download loop then fetched all eight q4 model
  files and failed on the same shared metadata. A normal offline Load test that
  merely expected an exception did not cover this outer loop.
- An OPFS permission failure during exact-revision planning was also classified
  as runtime rejection, permitting acceptance of another cached revision.
- AutoModel reads `config.json` again after Naidan's initial config and candidate
  planning. Losing that file caused repeated candidate attempts; changing its
  external-data declaration could allow an unplanned cached body to reach ORT.
- A local upload with the same HF-shaped directory name could shadow HF
  tokenizer metadata. A cached mutable `main` presence-probe file could also win
  over the selected immutable revision because the earlier alias was attempted
  only after a primary miss.

The current Naidan changes separate shared config/planning/tokenizer preparation
failures from candidate session incompatibility, retain required config in the
candidate resource boundary, and reject unplanned ONNX body consumption before
reading its source. Metadata-only header inspection of unselected ONNX files is
still permitted because the upstream progress prepass uses it. An operation's
recorded failure also prevents delivery of subsequent body reads; it does not
physically undo an I/O operation that already started.

The read-only cache now owns the selected model/revision namespace. Known
revisionless presence probes are canonicalized before OPFS lookup, not used as
a fallback after inspecting mutable `main`. An HF operation does not read a
same-named local upload. Explicitly selected `user/` and `local/` models retain
their local storage route. These are operation-local policies, not new OPFS
manifests or changes to the general explicit Download cache.

### Optional I/O and local resource identity follow-up

A separate SmolLM2-1.7B case established that a valid, committed optional
`generation_config.json` whose OPFS `getFile()` throws `NotReadableError` could
still produce a successful offline Load. Upstream cache exception handling
treated the read failure as absence. This differs from an ordinary optional
MISS and from parsing invalid JSON after successfully reading its bytes.

The candidate operation now retains native lookup, body-read, and cleanup
failures for requests admitted to its selected model/revision scope, including
optional metadata. Its read-only cache and error boundary use the same scope
resolver. Ordinary optional absence, successful metadata-only inspection of
unselected ONNX files, and normal cancellation remain permitted. A real I/O
failure during that inspection is terminal: it establishes neither absence nor
candidate incompatibility and must not authorize another dtype transfer.
Reader acquisition/release and cancellation of responses arriving during
closure are covered as well; cleanup must not silently discard those failures.

The shared resolver also distinguishes a lookup URL from the OPFS resource key
used for comparison. For an explicitly selected local upload, Transformers.js
can request `/models/user/...` while Naidan's plan uses `/user/...`. The existing
storage mapping resolves both to one file. Comparing those URLs literally
caused the unplanned-body guard to reject a planned local model. Comparison now
uses the admitted OPFS key without changing the lookup spelling or decoding and
re-encoding filenames. Namespace admission still happens first: this does not
permit an HF operation to consume a same-named local model or another revision.

These regressions use the real Naidan cache and resource operation with an
in-memory OPFS adapter. The SmolLM2 I/O case also traverses the actual runtime.
They do not claim to reproduce physical browser storage failures.

### Whole-response validation before file completion

A transfer-boundary counterexample supplied HTTP 206 with two bytes and
`Content-Range: bytes 0-1/100`. The former prefetch check accepted `response.ok`,
and the writer compared the received bytes with the partial `Content-Length`.
That could publish `.complete` for a fragment. A correct byte count relative to
the response alone did not establish a complete resource.

Full-file persistence now requires HTTP 200 with no `Content-Range`, before any
write or removal of an existing completion marker. The same contract applies to
direct cache writes and staged prefetch; stream wrapping preserves response
status. Explicit metadata range probes remain allowed as probes, not saved full
files. Rejected response bodies are handed to their existing operation owner or
canceled with bounded failure cleanup; this is not a delay in successful
downloads or proof of physical network termination. Compression-aware byte
verification still concerns the decoded body exposed by fetch.

These checks prevent observed partial-response promotion and preserve a prior
committed file when the replacement response is rejected. They do not prove that
a server's status, full-body length, or content is truthful, nor do they validate
real ONNX graph contents. No new persisted OPFS metadata is introduced.

### Optional-config parsing and session ordering

A separate SmolLM2-1.7B regression supplies an existing but invalid
`generation_config.json` after successful metadata preparation. The actual
candidate loop originally received an untyped JSON parse error and downloaded
q4 after q4f16 failed. Optional absence still succeeds and must not become a
required-file error. The Naidan preparation-phase changes alone did not fix
this counterexample.

The original pinned upstream bundle starts optional-config parsing and session
construction in the same `Promise.all`. Merely tagging a JSON exception is
insufficient if an earlier session exception already causes fallback. The Vite
fix now completes optional preparation before selecting or constructing sessions.
It tags errors at that consumer as `TransformersJsOptionalConfigurationError`,
retaining the file and original cause. Naidan preserves that error name across
preparation wrapping and Worker transport and treats it as terminal, including
when a previous candidate had a genuine ORT error. It does not classify every
`SyntaxError` or every runtime failure as terminal.

The existing SmolLM2-1.7B corrupt-JSON Download-loop regression now passes without
changing its no-q4-transfer expectation. Additional real-runtime cases verify
that corrupt optional metadata prevents model-body reads/session creation during
fresh Load, while valid present optional metadata succeeds. Small transformed-
consumer tests verify held optional reads, late rejections, error origin, and
unchanged constructor arguments for absent or empty optional-config mappings.
Ordinary optional absence and genuine session fallback remain separate cases.

This ordering change does not add a timeout, new JSON validation, cache writes,
or network authority. It may delay session work until optional reads settle;
an unresponsive read still needs the owning Worker's existing lifecycle handling.
Do not infer that a generic exception proves another multi-GB transfer will help.

### Partial ORT session ownership remains unverified

Source review of the pinned runtime also identifies a separate lifecycle risk:
`constructSessions()` aggregates sessions with `Promise.all()`. If one session
is created and another rejects, or a model constructor throws after session
creation, Naidan's awaited model assignment has not completed. Disposing that
model cannot recover sessions it never received. The resource-operation boundary
owns response readers, not native ORT sessions, and ordinary Load failure does
not always imply physical Worker termination.

This is a source-derived risk, not an observed browser leak or a newly reproduced
ORT failure. The identity-bearing synthetic session tests do not prove native
session reclamation in these cases. The current Vite fixes do not claim to fix
this ownership gap; investigating it needs a separate failure reproduction and
session/Worker lifecycle contract, without weakening the offline boundary.

### Fetch redirects and native module loading are different boundaries

The downloaded-model Worker's fetch guard used to validate only the initial
runtime URL. Loopback regressions demonstrated that a redirect could send a
second request to a non-allowlisted same-origin path or another origin. The
guard now forces `redirect: 'error'` after caller options, while preserving a
Request's attributes and abort signal. Native-fetch tests assert that forbidden
redirect targets receive no request. They use loopback servers, not Hugging Face.

This is not proof that every browser module request passes through that guard.
With `useWasmCache: false`, Transformers.js skips its Wasm preload/cache path.
The previous Production configuration gave ORT a same-origin factory MJS URL
to import directly. Native `import(url)` does not call the Worker's replaced
global fetch. Its initial URL was build-owned, not model-supplied, but the fetch
guard did not reject redirection of that module response.

### Production MJS startup ownership

The Production startup fetches the selected MJS through
the fixed runtime capability, enforce a complete JavaScript response, and check
its bounded byte length and SHA-256 against the build manifest. Model cache and
model fetch authority are not involved. The Worker sends a small, tightly owned
byte array through a versioned startup protocol; the host snapshots and verifies
those bytes before creating its session-owned Blob URL. A late verification
result after disposal cannot create another URL.

The Worker validates the matching lease and same-origin Blob URL, imports the
module, and checks its default factory export before exposing the model API or
announcing readiness. Configuring a URL alone was insufficient: an import error
delayed until the first ORT session could otherwise look like model incompatibility.
The factory is not called during this startup check. The explicit absolute Wasm
URL and the existing Wasm transport remain separate from MJS acquisition.

The host retains the URL for the full Worker session, including model unload and
subsequent loads, and attempts revocation when terminating the session. It does
not depend on a forcibly terminated Worker running its own finally block. Startup
failure is a Worker lifecycle error, not permission to try another dtype or
revision. An initial explicit Download may already have transferred its first
candidate before acceptance starts; this boundary prevents additional fallback
transfers rather than claiming that first transfer never happened. There is no
fallback to direct HTTP import or new persisted runtime/model cache.

Browserless tests separate legitimate same-origin MJS acquisition from forbidden
model/external traffic. The nine-model replay instruments ORT session creation;
native Blob import is a separately identified platform boundary in its harness.
It does not establish real-browser Blob/CSP support, pthread construction,
Wasm initialization, GPU compatibility, or physical native resource reclamation.
Those limits remain even when startup and model regressions pass. Vite tests
verify the applied fixes, not a browser-wide network firewall; initial app and
Worker module delivery still has its own deployment trust boundary.

The completed browserless regression run covers all nine checked-in model
fixtures through the new startup path. Independent startup tests cover early or
duplicate readiness, a mismatched acknowledgement, late verification after
disposal, import failure, and teardown failures. Module-response tests cover
partial, short, oversized, corrupted, unreadable, and non-JavaScript responses;
they also verify that the host hashes the same immutable bytes it leases.
These checks prove the listed Naidan contracts, not the native-platform behavior
excluded above. Raw metadata suites prepare the Vite artifact in suite setup,
then retain fresh runtime imports and independent model expectations per test.

## Fresh metadata size probes, 2026-09-09

A connected SmolLM2-135M Download regression uses the unchanged raw metadata
at revision `12fd25f77366fa6b3b4b768ec3050bf629380bac`, but removes Content-Length
from full metadata responses and serves size probes as HTTP 206. Before the
Naidan fix, the actual runtime requested `bytes=0-0` for `config.json` and
preparation failed with `Unexpected metadata Range request`. The previous
transport fixture always supplied Content-Length and did not exercise this
path. This is an executable counterexample, not proof of the exact rejected
URL in the separately reported browser incident.

The pinned runtime's `getModelFile()` calls `get_file_metadata()` when a progress
callback is present and the full response lacks Content-Length. Size probes
therefore are not restricted to the two revisionless tokenizer/processor
presence probes. Naidan now permits `bytes=0-0` for admitted exact-revision
metadata while retaining the narrow revisionless alias policy. Other ranges,
other revisions, and model weights remain forbidden in metadata preparation.
Probe responses never acquire a full-file save obligation; full metadata
persistence still requires a complete HTTP 200 response without Content-Range.
The connected regression verifies full saved bytes and completion markers,
then starts a fresh offline Load without another model-network request.

An empty-cache nine-model MSI batch independently established a coverage gap:
the existing collector retrieved raw metadata remotely, but runtime completion
reported `cache-only-unavailable` for every model and did not invoke ordinary
Download preparation. Its execution-level `passed` did not mean fresh Download
or Load succeeded. Raw JSON alone also does not retain the HTTP response
conditions that select the failing branch. Sharing the fresh metadata execution
path with MSI, while keeping bounded transfer and isolated temporary storage,
is the next implementation task; this paragraph does not claim it is done.

### Fresh MSI metadata integration follow-up

The working implementation now connects a dedicated fresh-metadata Worker to
MSI planning through a top-level Comlink callback. It shares ordinary Download's
config, resource selection, and tokenizer/processor preparation, with empty
temporary memory instead of OPFS. Successful metadata is reused for replay
sidecars; supplementary allowlisted files have distinct HTTP observations.
The connected SmolLM2-135M tests exercise both a previously populated cache and
an empty profile with missing Content-Length and HTTP 206 probes. They assert
no OPFS access, no model-weight requests, no ORT sessions, and preserved raw
bytes. This is not yet fresh-path regression coverage for all nine models.

The UI and `download-lane/fresh-metadata.json` report this preparation separately
from investigation completion and existing-cache acceptance. Metadata preparation
does not establish successful full Download or Load. Actual Comlink MessagePort
tests carry raw Blob sidecars through the fresh callback and planning checkpoint;
they do not verify native browser Worker startup or deployment.

Response validation also compares replay model/revision, budget, file identity,
size, and provenance with the fresh preparation result. Independent valid JSON
schemas alone allowed inconsistent combinations in adversarial tests. Raw
supplemental acquisition rejects Content-Range even on HTTP 200: a synthetic
counterexample previously archived that fragment as a complete replay resource.
These response conditions are regression inputs, not claims that the latest
browser ZIP recorded each malformed response.

### Nine-model fresh metadata replay coverage

The fresh path is now exercised independently in all nine model Download test
files with absent Content-Length and HTTP 206 size probes. Each model retains
its own processor, resource-plan, and collected-file expectations. The tests
start with empty model storage and assert no OPFS activity, model-artifact
fetches, or ORT session creation. HTTP response shaping is shared deliberately;
model expectations are not generated from runtime output. Large raw bodies are
compared by byte length and SHA-256 rather than a test framework's deep array
comparison, which exhausted the Node heap on the larger tokenizers.

The latest empty-cache evidence agrees with existing fixture revisions and
previously selected raw bytes. The fixture corpus now covers presence/absence
for all ten replay-collector paths, including supplementary templates and
special-token maps. Those additions do not broaden required Production files.
SmolLM2-1.7B's special-token map timed out in that evidence; an earlier raw
observation at the same immutable revision supplies its success-case bytes.
A separate actual-runtime test reproduces a stalled supplemental response:
metadata preparation succeeds, raw collection remains partial, previously
collected bytes survive, and no weights or OPFS operations are performed.

A host-coordinator regression also holds the fresh Worker's result indefinitely.
The deadline physically terminates that Worker, retains its partial HTTP
observation as timeout, and allows a second model's fresh preparation to proceed.
Late completion and progress from the retired Worker cannot replace the timeout.
That test uses simulated Worker endpoints; native termination remains a browser
canary item, not a claim established by the model replay.
