import { isGpuProfileTrial, summarizeGpuProfiles } from './gpu-profile-summary';
import { createMemoryZipCentralDirectoryStore, createReadableZipOutput } from '@/utils/zip-stream/memory';
import { StreamingZipWriter, createWebZipCompressionCodec } from '@/utils/zip-stream';
import { performanceProtocol, snapshotSchema, type PerformanceSnapshot } from './types';
import { summarizePerformance, performanceFindings, trialRates } from './summary';

const readme = `# Naidan llama.cpp browser performance / ${performanceProtocol}

## Start here
- manifest.json: collection status, export time, and model-level errors; completed
  means collection ended, not that every model or attempt succeeded.
- environment.json: browser/build environment and available runtime asset provenance.
- execution.json: runner wall time and orchestration intervals; null means unavailable.
- plan.json: exact models, order, settings, per-call output limits, and fixtures.
- findings.json: same-workload before/after comparisons; observations, not causes.
- summary.json: uninstrumented measurements partitioned by effective conditions.
- trials.jsonl: all attempts, timings, exclusions, diagnostics, and partial failures.
- memory/: canonical bounded raw memory observations, including partial failures;
  trials.jsonl links each available file and summarizes its retained/dropped counts.
- backend-placement.json: operation metadata from separate diagnostic calls.
- gpu-profile.jsonl: one record per GPU-profiling attempt, including missing and
  partial results; the canonical shader/phase/grid timestamp observations.
- gpu-profile-summary.json: per-request/per-phase shader rankings, not a model
  speed benchmark or a cross-request average.
- q8-kernel-diagnostic.json, when present: a separate, bounded synthetic kernel
  comparison after the model trials. Never include it in model throughput.
- outputs/: actual input, output, and reasoning for each attempt.
- summary.csv: one row per attempt, including failures and exclusions; unlike
  summary.json, this is not an aggregate or a list of only valid speed samples.

## Join records and check coverage
modelIndex is the zero-based index into plan.models. Join trial.stepId to
plan.steps[].id for scenario, order, repetition, sequence, parent and output limit.
Use trials.jsonl IDs for canonical joins: summary.csv prefixes cells beginning
with =, +, -, @, tab or carriage return with an apostrophe for spreadsheet safety.
For attempt IDs, only a leading apostrophe followed by a hyphen is this escape;
remove that apostrophe only when the resulting ID matches trials.jsonl.
Join attemptId/beforeAttempt/afterAttempt to trials.jsonl record id; its exact
input and output are in outputs/<id>.json. Raw memory histories live only in
memoryDiagnosticsFile; trials.jsonl contains a reference and retained/dropped
counts, not a second copy of the raw records.
Compare planned steps with recorded attempts before concluding that all work ran.
A missing attempt is unobserved/not run, never a zero-duration successful call.
Inspect status, exclusion, modelErrors and dropped counts before using summaries.
For before/after findings, observed model reloads or context retries suppress the
ratio. Missing positive model-reuse evidence or preparation evidence reaching its
64-event cap is listed under uncertainties; any remaining ratio is conditional
on those unknowns. These checks do not certify unchanged model bytes.
Requested plan/trial options and observed native settings are distinct; use the
terminal performance summary for effective conditions when available. An absent
terminal summary leaves final effective conditions unknown.
This ZIP is a self-describing investigation handoff, not a stable API. Layout and
fields may change on every commit; use this README and this run's actual plan.

Optional earlyGenerationTiming reuses existing Worker clocks for the first 16
sampler-stage intervals, first 16 combined serial/overlap decode-stage intervals,
and first 16 sample timestamps, including stop/EOG samples. The two interval
series have separate ordinals; sampleCountAtStart is a count, never a token ID.
These are stage residence times: generation-overlap includes delivery and decode
as joint wall time, not decode-only or GPU time. Neither closure boundary proves a
completed native call: failed/aborted cleanup can also cause stage-transition. Truncated
flags mark the capture limits. Nonzero clockAnomalies invalidates timing precision;
exceptional, non-finite or backward clock reads retain the last valid timestamp.

Raw memory histories appear only in the referenced memory/<attemptId>.json file,
not a second copy in trials.jsonl. If memoryDiagnosticsFile is absent, that attempt
has no captured raw memory history; inspect summary.performance.memoryObservation
separately for any terminal heap/checkpoint measurements. Missing evidence is not
zero memory use. Coverage
counts describe retained and discarded records, not uninterrupted sampling.
The 128 MiB archive-output limit is not a cap on live export memory: validation,
JSON strings, ZIP output chunks and final Blob can coexist while exporting.

## Measurement modes and GPU timestamp boundaries
plan.settings.mode is gpu-profile, standard, or both. Missing means the older
standard-only protocol. Both runs each model's complete standard block first,
retires its Worker, then runs the profiling block in a new Worker. Continuations
never cross these boundaries. Each lane has its own initial load/warm-up and
optional placement diagnostic. Request counts double, not necessarily wall time.
The ordinary lane in both always uses webgpu-wasm64-jspi, matching the diagnostic
profile's memory width and suspension strategy. Standalone cannot select the GPU
profiling runtime. Hosted includes development serving as well as production.

GPU-profile attempts, including their ordinary-looking generation rates, are
instrumented and excluded from summary.json and findings.json. summary.csv keeps
those rates only in explicitly instrumented columns. GPU pass sums are NOT
request wall time: do not subtract them to derive CPU time or utilization.
The upstream GGML_WEBGPU_GPU_PROFILE build changes pass boundaries and reads
queries back. Naidan observes those existing public timestampWrites, pipeline
labels, resolveQuerySet, copyBufferToBuffer and getMappedRange calls. It does not
add GPU queries, dispatches, copies, maps or waits. This timestamp observer uses
public WebGPU calls and does not patch upstream code. It is loaded only for the diagnostic
runtime and only isolated measurement requests can activate it.

The optional Q8 diagnostic runs once after all model scopes have released, in a
dedicated Worker under the same exclusive measurement lane. It uses small,
self-authored Q8 weights and F32 inputs; it does not load another model or capture
chat activations. A missing extension produces unavailable, never a substitute
kernel result. Failed/cancelled attempts retain their last progress and cause;
they do not certify that every sample finished. Aborting terminates the Worker,
not individual pointers of a suspended native call. This does not assert instant
GPU-process completion or physical memory reclamation.

The comparison prepares every variant, warms each one, then alternates forward
and reverse order across four rounds. Each sample sums the existing timestamps
of 32 individual native dispatches. Setup, preparation, warmup, native-call wall
time, verification readback and GPU pass time are separate; do not subtract them
to infer CPU time. timingStatus=quantized means zero-duration passes were seen,
not an infinitely fast kernel. Partial/unavailable timings are not qualified GPU
samples. Record the actual launch decision, processed shader SHA and extension
schema identity. Requested variants may be unsupported. Exact checks here use a
bounded dyadic fixture and do not prove equivalence on every real activation.
Repeated small weights can remain warm in cache. These results are neither
ordinary chat tok/s nor a native-versus-browser full-model speed comparison.
hiddenObserved excludes an otherwise useful sample set from reliable timing.

Each sample is owned by the request and phase active when its pass was encoded,
not the phase active when readback completes. phases are prefill, decode,
checkpoint and other. Shader labels distinguish the implementation/quantization
when upstream includes them in the name; the collector does not guess tensor
quantization, layer, expert, dimensions or FLOPS from a label. workgroups is the
actual dispatch grid, NOT a tensor shape. passes counts timed compute passes;
dispatches counts native dispatch calls inside them. A split pass has no single
grid. minimum/maximum/meanPassMs describe passes, not individual split dispatches.
The derived amortizedDispatchMs is total time divided by dispatch count, not an
individual dispatch latency distribution. Multiple-pipeline passes are marked
ambiguous and are never credited in full to each shader separately.

Timestamp values are nanoseconds converted to milliseconds; precision is
browser-defined. Complete status means all observed timestamp-bearing passes
were read, not that every GPU operation was timed: untimestamped setup/copy/memset
work is outside this table. Zero durations can reflect quantization, not absent work.
Missing/unavailable observations are never zero-cost kernels. Check status,
pendingPasses, invalidPasses, droppedPasses, ungroupedPasses, ambiguousPasses and
instrumentationErrors. Collection is bounded to 1024 groups and 4096 pending
passes per request. Retained-row phase shares exclude lost observations and must
not be interpreted as shares of total GPU work or of the whole request.
Rankings stay separate for initial, short-before, continuation, long, short-after
and placement; the latter additionally synchronizes native evaluation callbacks.
Late readbacks cannot modify a closed request or contaminate its successor.
No hardware performance counters, physical GPU residency, swap, bandwidth
utilization or per-instruction timings are collected.

## What changed in this protocol
The default is one block: initial short (up to 8 output tokens), short before
(up to 64), its real continuation (up to 16), long input (up to 8), and the
same fresh short input after (up to 64). The initial call doubles as warm-up;
there is no additional full-length warm-up or regenerated continuation parent.
An optional final diagnostic generates up to 2 tokens. Thus the default is
6 calls per lane with an output ceiling of 162 tokens. GPU profiling is the UI
default when supported; both uses 12 calls with these same default settings.
That describes the default UI settings only; plan.steps is authoritative for this
archive, including custom output limits, disabled diagnostics and extra blocks.
The short before/after results stay separate. The first long input can include
first-use graph/pipeline work; it is NOT a warmed-prefill claim. Increase blocks
only when a specific comparison needs confirmation, not to hide chronological drift.
The input is English. Results are not interchangeable with standard-text-v1
(Japanese) or standard-text-en-v2 (a different schedule and output budget).

## Operation diagnostic: capabilities and limitations
The diagnostic uses the public native evaluation callback. Prefill observations
are metadata-only. When decodeCompletionTiming is present, the same public
callback requests completion for every decode node, including views and nodes
whose metadata was dropped. The scheduler synchronizes each node before the
completion callback; this deliberately changes batching and inhibits fusion.
Tensor values are NEVER read. This extra instrumentation is enabled only in the
separate diagnostic call, never ordinary chat or the speed-summary trials. It
does not itself require a different Wasm variant or a timestamp feature. It is
orthogonal to the selected standard/GPU-profiling lane.
Operation type, weight/source shapes and quantization, destination-buffer storage,
and WebGPU operation-support queries are collected. This is NOT an exact
execution-backend trace: a host buffer does not by itself prove CPU fallback,
an unsupported op is not proof of its runtime share, and optimized/fused graph
nodes may not correspond to separate dispatches. Views are identified separately.
Node counts are not time. completionTiming groups observed decode completion wall
times by operation, weight types/shapes and destination storage. samples, totalMs,
minMs and maxMs exclude the callback's metadata reads, but include dispatch,
synchronization, driver scheduling and potentially memory-residency waits. They
are not GPU kernel time, bandwidth, swap measurements, or CPU/GPU utilization.
maxNodeName and maxNodeIndex identify the slowest observed node in each group;
maxNodeIndex is the one-based completion-request ordinal within this diagnostic.
Timings across backends are not directly comparable; split-input copies can
precede the first ask and are not fully attributed. Per-node fences can also
change residency and eliminate or amplify a slowdown seen in ordinary inference.
Never sum these values into normal trial timings or claim a speedup from them.
The decodeCompletionTiming totals disclose requested/completed/timed nodes,
unattributedNodes (metadata missing), unfinishedNodes (no matching completion),
skippedNodes (budget exhausted or callback protocol failed) and errors. totalMs
includes valid but unattributed durations; per-entry sums may therefore differ.
Timing is capped at 25,000 nodes per diagnostic decode phase. Metadata shape caps
never silently merge a preceding node's time into a later recorded operation.
Missing decodeCompletionTiming in older archives means not collected, not zero.
GPU (Graphics Processing Unit) timestamp durations, exact CPU (Central Processing
Unit)/GPU utilization, physical memory residency and swap are NOT collected.
Missing fields are not replaced with zero.
The capability field identifies which metadata reader was actually available.
Legacy JSPI (JavaScript Promise Integration) artifacts return Promises even for
non-suspending getters. Without the versioned synchronous callback bindings,
only safe tensor layout fields are read: buffer placement and WebGPU support
are explicitly unavailable, not CPU fallback. Rebuild bicore with the separate
callback-metadata binding patch to obtain those additional leaf observations.
Collection is bounded; inspect droppedNodes, errors and decodeCompletionTiming
coverage before drawing conclusions.
placement-layout-only, placement-missing and placement-incomplete warnings are
not erased by a successful inference. A completed run is not proof of full GPU
profiling. Failure summaries retain a classified failureKind and stage, not raw
native messages or exception stacks.
No callback or node inspection is installed for normal unmeasured chat. A context
created for diagnostics is freed before returning to an ordinary context; loaded
weights can be retained. The final model cleanup releases the diagnostic context.

## Passive native graph counters
nativeGraphCounters, when present in performance, reads the existing
llama_perf_context counters before and after each measured request in the same
resident context. This does not enable native performance clocks, reset counters,
change graph batching or add GPU work. Ordinary chat does not create this reader.
The upstream field names are preserved: n_reused counts successful graph reuse;
n_reallocs_same and n_reallocs_diff count reallocations of unchanged/changed graph
size only when backend assignments did not change. They are NOT all graph builds,
all allocations, live GPU bytes, page faults, or an attribution of elapsed time.
Use after minus before within one request only; never compare raw totals between
contexts. Counters can have different reset lifetimes upstream; negative deltas
are not performance measurements. Missing boundaries/errors mean an incomplete
observation, not zero. Before/after reads allocate and free one small record only
at measurement boundaries. These reads use the existing public API and add no
per-token observer or extra Wasm variant.

## Interpreting timings
Each model uses a new physical Worker. The previous Worker is terminated before
starting the next model; fresh/continuation trials within one model intentionally
reuse that model's Worker. Initial setup retires any preceding chat/probe Worker.
This resets Worker-owned state, not OS/browser caches or a physical RAM guarantee. Fresh requests reset the sequence; reusedTokens must be zero.
Continuation uses the actual parent output, even if it reached the output cap.
An incomplete-parent warning describes this condition; it does not erase the data.
Reasoning-only parents are not fabricated into complete visible answers.
trial.elapsedMs is main-thread elapsed time around the generate request, including
its settlement. trial.summary.elapsedMs is the worker's measured request duration.
performance.stages contains exclusive wall-time buckets accumulated across visits;
the stage list is not a chronological trace. These buckets partition the worker
measurement, so do not add them to summary.elapsedMs or trial.elapsedMs. Nested
preparation, checkpoint and decode/delivery observations describe work inside those
intervals, not additional elapsed time. Differences across clocks are not a
measurement of messaging overhead, CPU work, or GPU time.
Trial firstReceivedMs/firstTextMs/firstReasoningMs/lastProgressMs are relative to
the main-thread trial start. Worker firstSampleMs/firstDeliveryMs and sample-window
firstMs/lastMs are relative to the worker measurement start; they have no shared
zero with trial.startedMs (runner-relative) or memory sample timestamp.
Main-thread receipt is not display completion. Native stage durations are elapsed
wall time, not GPU kernel time. Overlapped decode/delivery must not be decomposed
into independent CPU and GPU time by subtraction.
deliveryDecode.decodeWaitMs and deliveryWaitMs measure elapsed native-decode and
main-thread callback delivery waits in overlap mode; jointWaitMs measures their
joint settling interval. These clocks are enabled for investigation requests even
with debug logging off. They overlap each other and generation-overlap; never add
them to stage totals or infer CPU arithmetic/GPU kernel time by subtraction.
Serial mode does not time these child waits, so their duration fields are absent
(pairedSteps is zero); its stage wall times remain the evidence. A measured zero
can occur in overlap mode, but still does not represent GPU kernel time.
Generation rate = (non-EOG samples - 1) / seconds between first and last sample.
EOG means End Of Generation. Sample counts are not chunk counts or decode counts.
Use summary.json/findings.json/summary.csv generation rates for that definition.
The raw performance.postFirstSample rate instead uses all sampled tokens after
the first, including an EOG sample when present, and the first-to-last interval.
It is a different diagnostic rate and must not replace the non-EOG generation rate.
Input rate uses actually decoded tokens and excludes reused tokens.
sampleWindows groups up to 16 already-timestamped samples per window, adding no
per-token clock reads. Each window's rate uses its own first/last sample interval;
partial windows and gaps between windows must not be silently averaged together.
memoryObservation describes WebAssembly linear-heap capacity and retained native
checkpoint bytes. Neither is GPU allocation, resident physical memory, or pressure.
Each referenced memory file includes the original Wasm instance/profile/checkpoint and
source timestamp for each received sample. capacityBytes is linear-heap capacity,
not live heap usage or resident RAM. gpuRequests are cumulative buffer-creation
and queue-write API requests for that runtime instance, not live GPU allocation,
physical VRAM, transfer completion or execution time. Never sum these snapshots.
gpuRequests.metadata is metadata exposed by the actual selected adapter/device,
not a second diagnostic GPU probe. Missing or browser-redacted fields remain absent.
gpuRequests.queue differs from lifetime buffer/write totals: submit and completion
wait counters belong to this measured request only. They observe existing submit()
and onSubmittedWorkDone() calls; no extra submit, fence, wait or timestamp query is
issued. At most 256 unresolved completion observers are attached per runtime,
including waits started in closed requests. completionWaitCount includes all
existing returned promises; completionWaitUnobserved counts waits omitted when the
observer budget is full or an observer cannot attach. completionWaitPending counts
only attached, still-unsettled observations. completionWaitResolved and
completionWaitRejected count attached observers that settled before the request
closed. Skipped observations are not completed
waits. Slots return only on actual settlement or when the runtime is destroyed.
completionWaitDurationMs sums settled promise wall times that can overlap;
longestCompletionWaitDurationMs is the longest such observed wait. Neither is GPU
kernel time or GPU busy time, nor additive to decode/stage wall time. Pending waits
at the last sample are incomplete observations, not proof of a hung device. Late
settlement after a request closes cannot mutate that request or the next one.
Completion promises can span checkpoints; differences between checkpoint snapshots
do not isolate pure per-phase GPU work or permit deriving CPU time by subtraction.
Native model/KV/recurrent-state/compute values are upstream allocation-log attempts rounded to
hundredths of MiB. A present 0.00 MiB can be a small nonzero allocation rounded
by the native formatted log, not proof that nothing was allocated. These are not
exact byte counts; multiplying rounded MiB by 2^20 does not recover exact bytes.
Retries and repeated allocations remain separate; adding them
would not measure live residency. Missing records/counters mean unavailable, not zero.
nativeSettings preserves native context/batch/sequence sizes (token/count units)
and graph node/split counts in observed order, including retry attempts. Graph
batchTokens and nativeSingleTokenValue retain the upstream comparison where present.
nativeSettings can contain loadedModelDescriptor from bounded getters on the loaded
LM, collected once per resident model only when measurement is requested and
re-emitted for each measured request. source=loaded-model-native-api identifies the native API, not a
filename inference. Missing fields mean unavailable or invalid, never zero.
parameterCount and tensorBytes are unsigned 64-bit decimal strings so JSON does
not lose precision. tensorBytes describes model tensors, not file bytes or live
RAM/VRAM. fileType is the loaded native llama_model_ftype numeric classification, including any
LLAMA_FTYPE_GUESSED flag; mixed tensor quantization is possible. Head and layer counts are native summaries, not
proof that every layer uses attention or that Flash Attention executed.
No full metadata enumeration, model name, tokenizer data, or template is collected.
The same nativeSettings history can also contain nativeFlashAttention requested
(auto/enabled/disabled) or resolved (enabled/disabled) records, and contextEvent
start/retry/ready boundaries. Requested mode is the native constructor parameter
after any native parameter rewrites, not necessarily the original caller setting.
contextAttempt is a request-local ordinal: start and
retry begin an attempt; ready closes it. Missing contextAttempt means unassociated.
Only a matching ready boundary can show that initialization completed for a
resolved attempt. Requested mode alone is never resolved selection; explicit
modes may not emit an AUTO-resolution line. Failed attempts remain in the history,
and a later attempt with no resolution stays unknown rather than inheriting it.
Missing boundaries/request/resolution after truncation also remain unknown.
Measured settings use the same ordered Worker endpoint as the request's terminal
response, rather than separate callback ports. Success, failure, and cooperative
Stop retain notifications sent before that response without waiting for diagnostic
acknowledgements. A forcibly terminated or failed Worker can still lose undelivered
observations; absent evidence remains unavailable, never proof of a setting.
These records report the native Flash Attention choice, not an execution backend,
GPU kernel selection, performance improvement, or proof that a model ran on GPU.
These records are observations, not an assurance that an attempted configuration
became the final effective one; compare the terminal summary and preparation events.
Each history retains its first 16 and latest 112 records, with dropped counts.
Collection follows each measured request, including graceful failures and cleanup.
On forced Worker termination, received partial observations survive even without a
terminal summary. Unreceived messages and final model/runtime release outside the
request are not reconstructed. Native observedMs is main-thread receipt time relative
to request start; sample timestamp is producer Date.now() in Unix epoch
milliseconds, not the same clock. Bytes are integer bytes; MiB means 2^20 bytes.
Memory instanceId identifies a Wasm runtime instance, not a process ID or a
physical GPU allocation. Decode memory checkpoints are rate-limited to at most
one per second, plus lifecycle checkpoints; these are not continuous peak-memory
samples. A zero droppedSamples count does not establish that all peaks or all
Worker messages were captured.
checkpoint.phases separates boundary tokenization, state sizing/allocation, readback,
restore upload, trim and validation. These child wall times overlap the existing
cache-checkpoint stage; never add them to the stage sum or label them GPU kernel
time. captureAttempts/restoreAttempts count attempts, not successful copies;
retainedRestoredCaptures counts identical restored snapshots not copied again.
Checkpoint elapsed time can include device-to-host transfer and synchronization;
it must not be labelled CPU arithmetic time.
cacheReuse records the cache decision before prefill and any new checkpoint
capture: decoded cache length, common prefix, actual reused prefix, planned
evaluation count, native removal capability, decision reason and the checkpoint
still available after restoration/discard decisions. Native positions describe
the state before those decisions. Compare evaluatedTokens with prefillDecodedTokens
to distinguish planned work from completed work on interrupted/failed attempts.
Older summaries can omit cacheReuse; absence does not establish a cache hit or miss.

## Interrupt the current trial and continue
The user can interrupt only the active attempt, without stopping the whole run.
An accepted request immediately records interruption.reason=user-skip and
requestedMs (relative to that trial). The runner waits for the existing generation
call to settle, retaining ALL received events, output, progress, summary and memory
observations until then. settledMs is the same trial-relative clock. Late callbacks
after settlement are ignored; unavailable/unfinished GPU observations remain missing
or partial, never fabricated zero. No additional GPU synchronization is introduced.
The unchanged Worker client still owns cooperative cancellation and its bounded
forced-termination fallback. Unsaved Worker-local data cannot be recovered after
termination; this UI does not claim which native termination path occurred.

status=interrupted is distinct from skipped (never started) and cancelled (whole
run stopped). A whole-run Stop wins if received before the attempt settles; an
already accepted interruption record is still retained. Timeout that already fired
cannot be converted into a user interruption. Interrupted requests remain in raw
outputs, memory, GPU profiles and CSV but not successful normal speed aggregates.

The runner NEVER reuses a failed performance scope. After an intentional abort it
awaits full scope/Worker retirement, then acquires a new scope for the next independent
step in the SAME model/lane. Model identity is revalidated. Dependent continuations
are skipped with skipReason=dependency-interrupted (including transitive dependents),
not generated from truncated output. A successful parent from a different runtime
segment cannot supply cached continuation state (dependency-runtime-reset).
No extra warm-up call or hidden retry of the interrupted attempt is performed.
A paired run keeps the other lane's plan unchanged. Real non-abort failures retain
the existing lane-failure behavior rather than becoming automatic retries.

interruption.recovery is pending while settling/releasing/reacquiring, new-scope
once the next scope is acquired, not-needed when no independent step remains in that
lane, stopped if the whole run stops first, or failed if cleanup/reacquisition fails.
It is NOT a report of native cancellation safety. runtimeSegment starts at zero per
model/lane and increments on reacquisition. The first request after restarting carries
runtime-restarted. It includes model reload cost in its ordinary timings. Successful
aggregates partition by segment and findings reject a before/after pair crossing a
segment. Older records without a segment are treated as segment zero. Acquisition,
visibility, inventory and release intervals identify their segment; interrupted is
also an orchestration outcome. The interval cap allows up to 1024 planned trials each
requiring a separate scope. Completion order and actual request counts remain visible.

## Provenance and failure handling
Inputs and results live in memory; no chat history is read or written. Export
occurs only when the user presses Save ZIP, never automatically after completion.
execution.json records runner duration separately from export time, including
visibility waits, inventory checks, model acquisition/release and bounded visibility
changes. These intervals are orchestration wall time, not CPU/GPU kernel time.
Trial startedMs is relative to runner start. Manual delay before Save ZIP is not
inference time; elapsed time between trials must not be attributed to the GPU.
Export happens only after measuring; there is no ZIP compression during generation.
Hidden-page attempts remain recorded but are excluded; the next call waits for
visibility. Cancellation and failed attempts retain available partial output.
Model IDs, names, sizes, and import timestamps are identifiers, not content hashes.
Architecture/quantization are not inferred from filenames; no extra full-model
reread or hashing is performed. Missing model metadata is unavailable.
runtimeBuild records the supplied bicore source revision and original asset
SHA-256 digests (Secure Hash Algorithm, 256 bits), not a rehash of transformed
JavaScript or the actual loaded bytes. appSource records the Naidan sourceCommit
(full Git revision when available) and workingTree (clean, dirty, or unknown)
when Vite loads its config. Dirty includes tracked and non-ignored untracked
changes; unknown means the check was unavailable, not a clean checkout. Missing
sourceCommit means the revision was unavailable, such as a source ZIP without Git.
This is source-checkout evidence, not a hash of built or executing app bytes.
Development hot updates and changes after config loading are not captured; restart
Vite after source changes for a fresh observation. Save ZIP preserves the run's
captured identity rather than inspecting the checkout at export time. appVersion
alone cannot identify a development patch. Record other environment conditions
in plan.notes.
runtimeAssetBaseURL is the asset location, not a model download URL.
preparationEvents contains up to 64 existing low-frequency observations; their
observedMs is relative to request acceptance, not the event's own elapsedMs.
modelReads uses existing byte/read counters, without extra per-read clock calls.
lastProgress survives forced termination when its notification was received.
The archive does not include model weights, account credentials, or saved chats.
`;

function csvCell({ value }: { value: string | number | undefined }): string {
  let text = value === undefined ? '' : String(value);
  // Metadata can be arbitrary text. Do not turn it into a spreadsheet formula.
  if (/^[=+@\-\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

// This ZIP is an ephemeral, self-describing investigation artifact for humans/GPT,
// not a stable API or persisted application state. Its shape may change each
// commit: keep the README/field semantics current instead of adding migrations
// or old-format readers that obscure the evidence from the measured build.
export async function performanceArchive({ snapshot: input }: { snapshot: PerformanceSnapshot }): Promise<Blob> {
  const snapshot = snapshotSchema.parse(input);
  switch (snapshot.status) {
  case 'running': throw new Error('Stop measurement before exporting');
  case 'completed': case 'cancelled': break;
  default: {
    const exhaustive: never = snapshot.status;
    throw new Error(String(exhaustive));
  }
  }
  const output = createReadableZipOutput({ highWaterMarkBytes: 256 * 1024 });
  const directory = createMemoryZipCentralDirectoryStore();
  const writer = new StreamingZipWriter({ output: output.sink, centralDirectoryStore: directory, compressionCodec: createWebZipCompressionCodec() });
  const modifiedAt = new Date();
  const add = async ({ name, text }: { name: string, text: string }) => writer.addFile({ name, modifiedAt, compression: 'store', stream: new Blob([text]).stream() });
  const json = ({ value }: { value: unknown }) => JSON.stringify(value, undefined, 2) + '\n';
  const completed = (async () => {
    try {
      await add({ name: 'README.md', text: readme });
      await add({
        name: 'manifest.json',
        text: json({
          value: {
            version: 1,
            id: snapshot.plan.id,
            mode: snapshot.plan.settings.mode ?? 'standard',
            status: snapshot.status,
            modelErrors: snapshot.modelErrors,
            exportedAt: modifiedAt.toISOString(),
          },
        }),
      });
      await add({ name: 'execution.json', text: json({ value: snapshot.execution ?? null }) });
      await add({ name: 'plan.json', text: json({ value: snapshot.plan }) });
      await add({ name: 'environment.json', text: json({ value: snapshot.environment }) });
      if (snapshot.q8KernelDiagnostic !== undefined) {
        await add({ name: 'q8-kernel-diagnostic.json', text: json({ value: snapshot.q8KernelDiagnostic }) });
      }
      await add({ name: 'summary.json', text: json({ value: summarizePerformance({ snapshot }) }) });
      await add({ name: 'findings.json', text: json({ value: performanceFindings({ snapshot }) }) });
      await add({ name: 'gpu-profile-summary.json', text: json({ value: summarizeGpuProfiles({ snapshot }) }) });
      await add({
        name: 'gpu-profile.jsonl',
        text: snapshot.trials.filter(trial => isGpuProfileTrial({ trial, snapshot })).map(trial => {
          const step = snapshot.plan.steps.find(step => step.id === trial.stepId);
          return JSON.stringify({
            attemptId: trial.id,
            stepId: trial.stepId,
            modelIndex: trial.modelIndex,
            lane: trial.lane ?? step?.lane,
            scenario: step?.scenario,
            position: step?.position,
            status: trial.status,
            interruption: trial.interruption,
            runtimeSegment: trial.runtimeSegment,
            requestedProfile: trial.options.profile,
            observedProfile: trial.summary?.profile,
            observationStatus: trial.summary?.performance?.gpuProfile?.status ?? 'missing',
            observation: trial.summary?.performance?.gpuProfile,
            warnings: trial.warnings,
            error: trial.error,
          });
        }).join('\n') + '\n',
      });
      await add({ name: 'backend-placement.json', text: json({ value: snapshot.trials.filter(trial => snapshot.plan.steps.find(step => step.id === trial.stepId)?.scenario === 'placement').map(trial => ({ attemptId: trial.id, modelIndex: trial.modelIndex, lane: trial.lane, profile: trial.options.profile, status: trial.status, interruption: trial.interruption, runtimeSegment: trial.runtimeSegment, warnings: trial.warnings, diagnostic: trial.summary?.performance?.backendCensus, failureKind: trial.summary?.failureKind, stage: trial.summary?.stage, error: trial.error })) }) });
      await add({
        name: 'trials.jsonl',
        text: snapshot.trials.map(({ input: _input, output: _output, partialText: _text, partialReasoning: _reasoning, memoryDiagnostics, ...record }) => {
          const coverage = (() => {
            if (!memoryDiagnostics) {
              return undefined;
            }
            const { samples, droppedSamples, nativeAllocations, droppedNativeAllocations, nativeSettings, droppedNativeSettings, ...unhandled } = memoryDiagnostics;
            unhandled satisfies Record<PropertyKey, never>;
            return { samples: samples.length, droppedSamples, nativeAllocations: nativeAllocations.length, droppedNativeAllocations, nativeSettings: nativeSettings.length, droppedNativeSettings };
          })();
          const gpuProfile = record.summary?.performance?.gpuProfile;
          const { rows: _gpuRows, ...gpuCoverage } = gpuProfile ?? {};
          const summary = record.summary?.performance && gpuProfile ? { ...record.summary, performance: { ...record.summary.performance, gpuProfile: undefined } } : record.summary;
          return JSON.stringify({ ...record, summary, gpuProfileFile: gpuProfile ? 'gpu-profile.jsonl' : undefined, gpuProfileCoverage: gpuProfile ? gpuCoverage : undefined, memoryDiagnosticsFile: memoryDiagnostics ? `memory/${record.id}.json` : undefined, memoryDiagnosticsCoverage: coverage });
        }).join('\n') + '\n',
      });
      const rows: (string | number | undefined)[][] = [['attempt', 'model', 'mode', 'lane', 'requested_profile', 'observed_profile', 'scenario', 'position', 'output_limit', 'role', 'status', 'warnings', 'exclusion', 'elapsed_ms', 'first_received_ms', 'first_text_ms', 'first_reasoning_ms', 'prefill_tokens_s', 'generation_tokens_s', 'prompt_tokens', 'reused_tokens', 'context_tokens', 'batch_tokens', 'finish_reason', 'parent_finish_reason', 'last_phase', 'last_progress_ms', 'error', 'gpu_profile_status', 'gpu_pass_total_ms', 'instrumented_prefill_tokens_s', 'instrumented_generation_tokens_s', 'runtime_segment', 'interrupt_requested_ms', 'interrupt_settled_ms', 'interrupt_recovery', 'skip_reason']];
      for (const trial of snapshot.trials) {
        if (trial.memoryDiagnostics) {
          await add({ name: `memory/${trial.id}.json`, text: json({ value: { attemptId: trial.id, modelIndex: trial.modelIndex, status: trial.status, interruption: trial.interruption, runtimeSegment: trial.runtimeSegment, ...trial.memoryDiagnostics } }) });
        }
        const step = snapshot.plan.steps.find(step => step.id === trial.stepId);
        const metrics = trial.summary?.performance, rates = trialRates({ trial });
        const instrumented = trial.exclusion.includes('instrumented') || isGpuProfileTrial({ trial, snapshot });
        let gpuTotalMs: number | undefined;
        const gpuStatus = metrics?.gpuProfile?.status;
        switch (gpuStatus) {
        case undefined: case 'unavailable': break;
        case 'complete': case 'partial': gpuTotalMs = metrics?.gpuProfile?.totalGpuMs;
          break;
        default: {
          const exhaustive: never = gpuStatus;
          throw new Error(String(exhaustive));
        }
        }
        rows.push([trial.id, snapshot.plan.models[trial.modelIndex]?.modelId, snapshot.plan.settings.mode ?? 'standard', trial.lane ?? step?.lane ?? 'standard', trial.options.profile, trial.summary?.profile, step?.scenario, step?.position, step?.maxTokens, step?.role, trial.status,
          trial.warnings.join(';'), trial.exclusion.join(';'), trial.elapsedMs, trial.firstReceivedMs, trial.firstTextMs, trial.firstReasoningMs,
          instrumented ? undefined : rates.prefillTokensPerSecond, instrumented ? undefined : rates.generationTokensPerSecond, metrics?.promptTokens, metrics?.reusedTokens,
          metrics?.contextTokens, metrics?.prefillBatchTokens, trial.output?.finishReason,
          step?.dependsOn === undefined ? undefined : snapshot.trials.find(parent => parent.stepId === step.dependsOn)?.output?.finishReason, trial.lastProgress?.phase, trial.lastProgressMs, trial.error, metrics?.gpuProfile?.status, gpuTotalMs,
          instrumented ? rates.prefillTokensPerSecond : undefined, instrumented ? rates.generationTokensPerSecond : undefined, trial.runtimeSegment, trial.interruption?.requestedMs, trial.interruption?.settledMs, trial.interruption?.recovery, trial.skipReason]);
        await add({ name: `outputs/${trial.id}.json`, text: json({ value: { attemptId: trial.id, status: trial.status, interruption: trial.interruption, runtimeSegment: trial.runtimeSegment, input: trial.input, output: trial.output, partialText: trial.partialText, partialReasoning: trial.partialReasoning } }) });
      }
      await add({ name: 'summary.csv', text: rows.map(row => row.map(value => csvCell({ value })).join(',')).join('\r\n') + '\r\n' });
      await writer.finalize();
      await output.close();
    } catch (error) {
      await output.abort({ reason: error }).catch(() => {});
      throw error;
    } finally {
      await directory.dispose();
    }
  })();
  void completed.catch(() => {});
  const reader = output.stream.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > 128 * 1024 ** 2) {
        throw new Error('Measurement archive exceeds 128 MiB');
      }
      parts.push(Uint8Array.from(part.value));
    }
    await completed;
    return new Blob(parts, { type: 'application/zip' });
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const TEST_ONLY = {
};
