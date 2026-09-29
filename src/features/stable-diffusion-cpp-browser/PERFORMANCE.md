# Image performance measurements (passive v1)

## Contract and scope

The debug switch is next to Generate. It is selected before a run, remains
locked during generation, and retains the existing runtime-key policy: changing
debug can retire a loaded context. For fair comparisons, warm up each setting
separately. Detailed logs stay bounded and local; Copy/Save and the nanoid export
filename behavior are unchanged. Disabling debug does not suppress critical
native/device failures, but disables these additional timing/counter collectors.

This layer observes operations the runtime already performs. It does **not**
change native inference settings, weights, shaders, pipeline descriptors,
workgroup coordinates, submission batching, model lifetime or cancellation.
It does not create extra adapters/devices, request timestamp-query, insert queue
waits or copy tensor data for profiling. Instrumentation still has nonzero CPU,
microtask and logging overhead. No real-device speedup or zero-overhead claim is
made by adding it.

The new records use existing diagnostic events with `fields.perfVersion = 1`
and `fields.metric`. No independently uploaded telemetry or unbounded
per-operator trace is created. Fields are scalar values or fixed eight-bucket
histograms, within the existing diagnostic validation and export size limits.
The logger's bounded head/tail may discard earlier records in a long run;
run-total summaries preserve aggregate values even when detailed windows are
omitted. A hard Worker termination may leave only partial checkpoints: no extra
waiting is introduced to flush metrics from an unresponsive native instance.

## Records and units

All `*Ms`/`milliseconds` values are milliseconds. Byte counts are API-requested
bytes, not measured physical bus traffic. A large shared/unified-memory mapping
need not be an equally large device-to-host transfer. Native `MB` messages use
their own original units; these counters remain plain bytes.

| `metric` | Meaning |
|---|---|
| `worker-selection` | New/reused physical Worker and a finite reason: first use, same key, explicit release, changed context key, view settings, retention disabled, forced abort, error or page exit. No cache key or prompt is exported. |
| `run-settings` | App version when available, preview threshold/max edge, conditioning cache, tile policy, aggregate model bytes, and a narrowly approved exact Qwen prefix-cache flag. Arbitrary model arguments are not exported. |
| `run-environment` | Recognized Chrome/Chromium/Firefox version token and available hardware thread count. No full user agent or high-entropy device identifier. |
| `phase-wall` | Non-overlapping wall-clock intervals across runtime/header/model load, per-run preparation, conditioning, sampling, final decode, cleanup and encoding. |
| `step-wall` | Interval between actual native completed-step callbacks. The earlier UI step=0 before conditioning is not used as denoising start. Includes preview work; the available rounded native preview decode subtotal is separate. |
| `run-wall` | Whole observed Worker run, phase totals, completed-step interval aggregate/min/max, unfinished-step wall time on cancellation, known graph-start counts and native log summaries. |
| `gpu-observation`, `gpu-device` | Passive nature, feature availability versus enabled features, unchanged device limits, observation coverage. |
| `gpu-counters` | Requested buffer allocation, shader/pipeline creation, write/submit/encoder/pass/dispatch/copy/map counts and byte totals. Sync shader/pipeline host-call times are **not** compiler/GPU execution times. |
| `gpu-write-sizes` | Write-call counts in fixed inclusive upper-byte buckets 256, 4096, 65536, 1 MiB, 8 MiB, 64 MiB, 256 MiB, then larger. |
| `gpu-wait` | Existing queue-completion or mapping promises, including sum/union wall times, counts, pending/peak-pending and largest observed completed wait. |
| `preview-control` | Accepted in-run preview changes: revision, enabled, threshold, interval, mode and maximum edge. |
| `preview-output` | Native pixels' dimensions versus encoded output dimensions, time pending in the encoder, encoding promise wall time, PNG bytes, delivery eligibility and cumulative replaced waiting-frame count. This time excludes native VAE decoding. |
| `file-read-run` | Per-file deltas for this run. Existing cumulative file-read reports remain; a retained run can now explicitly show zero additional reads rather than repeating its lifetime total. |

### Windows versus totals

GPU counter reports have `scope: window` or `scope: run-total`. Window counters
are deltas, run totals are snapshots; **do not add totals to the windows**.
`windowStartMs`/`windowWallMs` are relative to that observer's run start, not the
page's host clock. `phase` and `step` label the interval's starting point (the
most recently completed sampling step); `reason: completed-step` closes it at
the next native progress callback. Do not assume `step` means that interval's
ending step. Run-total fields for phase/step are the final observation point,
not a claim that the entire total belongs to that phase.

For waits, `wallSumMs` sums outstanding time across all observed promises;
`wallUnionMs` is the time during which at least one of that kind was pending.
Both include the partial outstanding duration at a checkpoint. Their difference
shows overlap, not duplicated GPU execution. Queue and map unions may themselves
overlap and must not be summed as exclusive phases. Pending, peak pending and
maximum completed wait are run gauges, not per-window deltas. Counts cannot be
interpreted as that many sequential CPU stalls. Actual GPU timestamps are not
measured and are explicitly reported as unavailable in this measurement mode.

WriteBuffer element offsets/sizes are converted to bytes for typed arrays;
ArrayBuffer/SharedArrayBuffer/DataView offsets remain bytes. Uniform/storage
usage classification is only API usage: storage bytes cannot be labelled model
weights or activations without semantic information from the engine. Likewise,
copy-to-MAP_READ counts are encoded requests, not proof of all bytes crossing a
physical link. Dispatch counts are physical calls under Naidan's existing
oversized-dispatch adapter, not pre-split logical dispatch counts.

Buffer sizes/usage are immutable metadata cached weakly; no diagnostic structure
retains every historical buffer, encoder or pass. Allocation bytes are cumulative
requests, **not live VRAM**, a memory-pressure estimate or a physical residency
measurement. Frozen/unobservable objects leave a bounded `unavailableMethods`
coverage warning. Missing coverage is not evidence of zero traffic.

### Native summaries and preview timing

An anchored allowlist of existing pinned native log formats counts known
qwen3/qwen3vl, qwen_image_2_1/z_image and VAE graph starts. These are graph-start
counts, not an inferred CPU/GPU allocation or a proven cond/uncond classification.
The parser never exports arbitrary graph labels, tokens, prompts or tensors.
Native condition/sampling/VAE duration reports remain rounded values; a separate
report count distinguishes no measurement from measured zero.

A VAE decode-completed message seen during sampling contributes to the available
preview-native subtotal; the same message during final decoding contributes to
final-decode subtotal. These subtotals **overlap** phase-wall/step-wall. They do
not cover latent preparation, all copying, queueing and UI painting. If upstream
wording changes, counters stay absent/zero-report rather than guessing values.
Detailed exact native preview spans require a future engine event, not an
estimate from a display resize. The final image's existing page elapsed-time
label retains its prior meaning.

## Runtime isolation

Each observation run has independent counters and a listener for that run. An
asynchronous queue/map/pipeline completion captures its owner at invocation time
and cannot leak into a later retained generation. After completion, cooperative
cancellation or error, the current metrics close without adding a queue wait.
Per-image native memory, read-only model mounts and retained context ownership
are unchanged. Exceptions from diagnostic sinks cannot replace native errors.
Method wrappers forward original arguments/objects/promises and do not consume
one-shot submission iterables. Ephemeral wrappers become forwarding-only after
disposal and are not stored in an ever-growing undo list.

## Performance improvement design

The supplied two cold logs spend about 89% of elapsed time in denoising. This is
an investigation priority, not proof of a particular kernel bug or a promised
speedup. Priorities are:

1. Separate cold runtime/model work from a stable same-context second/third run.
   New per-run file deltas and Worker-selection reasons establish actual reuse.
2. Compare per-step transfer sizes, copy-to-readback bytes, physical dispatches,
   passes, submits and overlapping waits. A small write repeated many times is
   not equivalent to uploading weights again. Counter correlations locate the
   next profiling target but do not themselves identify a slow kernel.
3. Inspect actual attention/backend choices and dominant tensor shapes using an
   explicit semantic engine trace before changing kernels/fallbacks. Preserve
   output validation and the current WebGPU dispatch/tiling fixes.
4. Improve a measured bottleneck (native backend coverage, small transfer
   aggregation, submission/pass scheduling or a kernel for the observed shape),
   then benchmark the ordinary nonprofiling path on the same models/settings.
5. Treat Flash Attention, tiling or reduced precision as separate numeric-path
   experiments, not guaranteed output-preserving optimizations. Never silently
   lower steps, resolution or guidance as a speed fix.
6. Optimizing tiny native file-read calls can reduce cold loading, but cannot
   explain the majority of these runs' denoising time; measure it separately.

## Does bicore need to change?

**Not for this passive measurement layer.** The attached bicore develop(11)
source uses the same image upstream pins as the installed artifact. No bicore
source, installed artifact, schema hash, npm pin or unrelated llama runtime is
modified by this patch.

For exact semantic tracing, inspecting the existing exported callback alone is
not enough: pinned `src/core/ggml_runner.cpp:766-774` explicitly ignores
`sd_set_backend_eval_callback` when the backend scheduler is used. Its existence
must not be mistaken for a working scheduler profiler. The lower-level GGML
evaluation callback also adds synchronizations around requested graph views;
using it indiscriminately would change scheduling. Reading a `ggml_tensor`
using hard-coded C++ byte offsets in Naidan would be an unstable ABI workaround.

The proposed next native instrumentation is additive and opt-in:

- Report stable numeric metadata at natural planner/model-evaluation/preview
  boundaries: graph category, conditional/unconditional evaluation identity,
  phase/span IDs, operator/dtype/shape counts, actual scheduler backend and the
  recorded reason for unsupported-operation fallback.
- Aggregate semantic transfer direction and bytes by purpose inside the engine,
  not by parsing labels or copying full tensors back for logging.
- Expose a minimal capability/query/control/read interface through the existing
  generated bridge. Naidan owns whether to enable it, limits, display and export;
  bicore should not own storage, prompts, model catalogs or UI policy.
- Keep OFF essentially inert, budget counters and records, separate unsupported
  profiling from inference failures, and never call a mutating API reentrantly
  from an evaluation callback. Test current 32-/64-bit address/suspension modes.
- Apply image-only prepared-source overlays with pinned hashes, not edits to a
  vendor checkout. Publish fresh source-bound artifacts and validate manifest,
  schema and feature compatibility before updating the image dependency. Do not
  overwrite the text-inference dependency or fabricate a future commit pin.

GPU pass timestamp sampling could also be implemented at Naidan's WebGPU API
boundary when timestamp-query is explicitly available/requested; thus GPU timing
is not intrinsically impossible without bicore. However, identifying the shader
and its model/operator role reliably, fallback reasons and CPU portions needs
engine cooperation. That richer capability is not implemented here.

The existing upstream `GGML_WEBGPU_GPU_PROFILE` flag is useful for a dedicated
profiling build, but pinned `ggml-webgpu.cpp:4176-4178` sets
`batch_compute_passes = false`. It also creates/resolves/maps timestamp resources.
Turning that on is not a passive equivalent of production timings. A diagnostic
build must be labelled separately; ideally sample the existing batched passes
without changing batch boundaries, then only use the heavier per-op trace when
needed. Unsupported timestamp-query should degrade gracefully rather than make
ordinary inference unavailable.

## How to collect comparable next logs

Keep model files, prompts/negative prompts, seed, resolution, steps, guidance,
sampler, scheduler and preview settings fixed. Enable debug **before** starting
and leave it unchanged for the series. Run one cold generation followed by two
retained generations; save after each because the view's diagnostic buffer is
per-run. Check `worker-selection`, request `reuse` and `file-read-run` first.
Begin with previews disabled; then repeat a separately labelled series with the
intended detailed-preview threshold/interval. Do not add overlapping timing
fields or compare a cold Flash Attention run with a warm non-flash run.

For instrumentation-overhead checks, warm each debug setting independently,
repeat ordinary generation with debug OFF and ON under similar device conditions,
and compare the existing end-to-end result time. Browser/OS/chip/memory/power mode,
DevTools status and competing workloads should be supplied as test context where
available; device limits alone cannot establish memory capacity or GPU occupancy.

## Primary references used in the design

- WebGPU specification: https://gpuweb.github.io/gpuweb/
- WebGPU GPUQueue contract: https://gpuweb.github.io/types/interfaces/GPUQueue.html
- stable-diffusion.cpp pin: `88411ef1e0688ff2df1010aeeb5d92b2d8cea2be`
- image GGML pin: `3057bb66c86c46d5781e50e85462a760ba7d1feb`
- Supplied bicore develop(11) archive identity:
  `415fc9824aa2d1f345b0e018113a11eb42518e36`

Validation artifacts distinguish mock/passive counter tests, real Vite/Vue
localized bundle construction, and real model/GPU execution. Only the first two
are part of this patch's verified scope.
