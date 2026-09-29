# Image benchmark workspace

The image-generation lab has a secondary diagnostics tab at
`/image-generation-lab/diagnostics`. Both URLs share the same owner, preserving
settings and active work when navigating between them. It consumes the existing
published local inventory, the existing image Worker client and the existing
versioned diagnostic events. It does not add a native API, dependency, shader,
model download or inference fallback. Opening/switching tabs never starts a run.
The normal model catalog remains on the Generate tab.

## Plan and fairness

All recognized primary models are listed. Text encoders and VAEs are components,
not standalone benchmark targets. Missing/incompatible components leave the
primary visible but disabled. The normal selection's explicit composition is
preserved as the initial composition; other primaries use the existing structural
companion resolver. Each target shows its resolved component files and allows
independent local replacements. Missing explicit choices never fall back silently. No
filename-derived model-family guessing or new file reads occur when listing.

Initially all complete models are selected. An explicit deselection survives a
refresh; newly discovered complete models are selected once. The initial plan
uses 512px, 8 steps, fixed seed 42 and a non-personal shared prompt. Model defaults
only change CFG/sampler/scheduler and fill an empty model-arguments field; they
never reset dimensions, steps, prompts or seed. Resolution presets change both
dimensions; per-model presets deliberately override both inherited values. Manual
width and height controls remain available. The effective request is visible.
Sparse per-model overrides apply last and can intentionally override with zero,
false or an empty string. Unchecked fields continue inheriting shared edits.

By default each model has two serial runs, each with a fresh Worker. The
alternative cold-warm mode retains the client and compatible context after the
first run. Every model boundary disposes the prior Worker.
Warm/cold are *planned* labels; actual worker-selection diagnostics are preserved.
Only a successful run with matching reuse evidence enters its warm/cold median.
Equal steps are not equal model work or image quality. Browser/OS caches, GPU
reclamation, power state, thermal throttling and other apps are not controlled.
The optional delay is outside elapsedMs, not a proof of GPU or thermal idleness.

Every effective request and repeat/order setting is validated and detached before
releasing the normal retained model or creating a benchmark client. A random seed
(-1), invalid number or incomplete composition blocks the whole start; no silent
correction occurs. Settings stay locked until completion, and results must be
explicitly cleared before another batch. Ordinary generation/import/download and
benchmark execution are mutually excluded in both UI and controller entry points.

## Lifecycle and diagnostics

One queue owns the clients and AbortController. Stop aborts the whole batch and
physically disposes the active client, without awaiting a hung native call. Page
unmount does the same. A configurable timeout is optional (0 = no timeout); it
records failure rather than fabricating a completed generation. A failure in a
cold-warm group skips its remaining warm runs and continues with the next model;
there is no implicit cold retry disguised as a warm run. Intentional uniform
images remain successful evidence and are never automatically regenerated.

Generation-tab state and results are not used as the benchmark gallery. They
survive tab changes. Benchmark ownership is in the parent composable, not the
conditionally rendered tab, so tab switches preserve settings, progress and logs.
Late diagnostic/progress/preview callbacks cannot modify another run or batch.

Detailed logging is always on for benchmark requests, irrespective of the normal
Generate checkbox. `measurements.ts` consumes the existing perfVersion=1 metrics
(worker-selection, run-wall, step-wall, file-read-run). It accumulates summaries
before bounded raw-log truncation. Missing fields remain absent, never 0. The
underlying GPU counters/logs remain raw evidence in diagnostics.jsonl; this tab
adds no GPU timers, barriers, tensor readbacks or precision changes. A preview
option measures the existing preview path and counts delivered frames without
retaining an unbounded intermediate-image history.

## Evidence export

Production uses Naidan's StreamingZipWriter; JSZip is test-only. Paths use model
and run ordinals rather than model-controlled filenames:

```
README.md
manifest.json
summary.json
models/m001/settings.json
models/m001/runs/r001/result.json
models/m001/runs/r001/diagnostics.jsonl
models/m001/runs/r001/result.png  # optional
```

The versioned, Zod-validated manifest contains the plan captured before running,
full artifact identity, resolved request settings, model-slot local candidate
identities and filenames/sizes/mtime, protocol/order, per-run status, timing and limitations. summary.json keeps
fresh and verified-warm medians separate. File names are not proof of weight
identity: export never rereads or hashes multi-GB model files. Absolute page URLs
and sourceId are not exported. Exact prompts require explicit export opt-in.
Model arguments, names, notes and optional images remain potentially sensitive;
the UI warns before sharing. The archive explains that these contents are data,
not instructions to a receiving LM.

Export runs only after completion or Stop, not concurrently with timed inference.
There are at most 100 runs, a 384KiB bounded raw log per run, and 128MiB total
retained PNGs. Image omission is explicit in each record. The streaming ZIP
producer honors backpressure; the final browser download is a bounded Blob with
an explicit 256MiB cap, not a claim of a zero-buffer download. Object URLs for
exports are revoked. Final PNG retention is enabled by default. Run details create
a temporary image URL only when opened and revoke it on close, result replacement
or unmount. No model weights, caches or persistent benchmark state are created.
Leaving the page discards unsaved benchmark results.

## Test scope

Focused tests cover plan snapshots, sparse overrides, local composition, correct
worker sequence, cancellation/timeout and late events, retention limits, unknown
metrics, ZIP CRC/content/privacy, tab lifecycle, ordinary-generation exclusion,
all locale modules and standalone isolation. Browser UI checks use synthetic
inventory/client results and do not certify trained-model inference or speed.
The standalone facade remains visible/disabled and bundles no benchmark runner,
ZIP machinery, schema, device probe or inference Worker.
