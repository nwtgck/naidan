# Experimental browser image workspace

`/#/image-generation-lab` is a dedicated experimental image workspace.
The sidebar quick-access link opens it.
Opening the page does not fetch model files, instantiate Wasm, create an inference
Worker or request a GPU adapter. Settings/results are temporary page-local state.

## Published bicore integration

The normal dependency installation now supplies the image runtime separately:

```text
stable-diffusion-cpp-browser-core
  -> github:nwtgck/llama-cpp-browser-core#3924d1154e4a03290c96a861031030155998a0f2
```

This is a dependency name for the existing **Browser Inference Core (bicore)**
artifact repository, not a separately published registry package. Keep Naidan's
existing `llama-cpp-browser-core` dependency and its adapters unchanged. The image
package's `resolved` and `integrity` lock fields come from the supplied CI-generated
consumer metadata. The underlying package remains `llama-cpp-browser-core`.
Installation has no compiler, postinstall hook, model download or generated-code rewrite. Model acquisition is a separate explicit action in the hosted UI.

```sh
npm ci
npm run build:hosted
# Or, for the hosted development server:
npm run dev
```

Open `/#/image-generation-lab` from the sidebar quick-access link, import a local repository folder (or use the advanced single-file controls),
then start generation explicitly. No environment variable or manual
copy into node_modules is needed with the committed dependency installed.

The pinned artifact is source commit
`e9b0620fd46b362af3693723425c90aa32587d22`, image ABI 2 / image manifest format 2.
Its manifest records all three profiles in both variants as compiled and
browser-smoke validated, including real-Wasm Worker/public-record/callback tests
and virtual unsplit GGUF reads above 8 GiB, safetensors above 20 GiB, and standard
GGUF shard groups (native probes in test variants). **It does not certify trained-model
loading, actual WebGPU image generation, model compatibility, speed or memory.**
Naidan ships only the `browser` variants, not the diagnostic `test` variants.

For explicit development overrides, a complete artifact checkout may still be
provided at build time:

```sh
NAIDAN_STABLE_DIFFUSION_CORE_DIR=/absolute/path/to/artifact-checkout npm run build:hosted
```

The override is validated by the same manifest, capability, browser-smoke and
schema contract, without hard-coding generated JavaScript hashes into Naidan.
Missing explicit paths or invalid artifacts fail the build; they do not fall
back silently. Source-only builds without an image dependency retain an
unavailable page. The previously supplied ABI 1 artifact is intentionally rejected.

The standalone build (whether opened by `file://` or served over HTTP) keeps the
same page, form controls and quick-access link visible, with generation/file
controls disabled and a hosted-only explanation. Its exact facade alias replaces
`use-image-generation` with a UI-only stub. Form defaults and labels are shared;
the native-operation controller, runtime configuration/schema, capability probes,
Worker, file reader, model/session code and image Wasm are hosted-only.

The image build plugin refuses non-UI feature imports or image runtime assets in
standalone output. Its allowlist is deliberately small: the Vue views/pickers, display-only library state, form state,
static acquisition recipes/catalog, form options, standalone composable and standalone client stub. Type-only imports
do not retain their runtime modules. The build also ignores the optional image
artifact location in standalone mode, even if that location is invalid.

Do not hide the page or ship the hosted controller behind a disabled button.
Changes to this boundary must keep both the real-output module audit and the
negative import/asset tests passing.

The build verifies parent/inner inventories, source identity, ABI/capabilities,
successful browser-smoke metadata,
schema fingerprint, every emitted binary/module/helper and license notice.
Runtime URLs are same-origin, source-bound paths. The normal hosted build emits
all three profiles, and generation fetches the selected one. Naidan's existing
all-assets PWA precache policy may separately cache these runtime assets; this
feature does not change that policy. Model weights are downloaded only through the explicit catalog action. Wasm decompression is bounded
by its verified byte count and followed by SHA-256 verification. Core attachment
checks the schema fingerprint embedded in the compiled binary too.

## Static multi-repository model catalog and acquisition

The page separates **Add models** (catalog or local folders), **Model to use**
(saved primary and components), generation inputs, and collapsed **Runtime and
advanced settings**. Live diagnostics are outside the generation form, so logs
can be copied or saved while model work is still running.

`model-recipes.ts` contains two static recipes: Z-Image-Turbo and Qwen Image 2.1.
Each role has an option array and explicit default. Unknown substitutions are not
invented: the model-specific VAE can have only one reviewed option. Catalog
options describe published files, not a claim of trained-model/WebGPU validation.
Opening the page, expanding a card, changing an option or choosing from saved
files performs **no remote metadata request or download**. Source links are
ordinary explicit, referrer-free navigation. No thumbnails are loaded remotely.

**Download** snapshots the chosen options. Only then is a dedicated download
Worker created. `logic/catalog-source.ts` fetches bounded metadata at immutable
source commits, requiring each selected file's LFS SHA-256 and exact byte count.
The hosted window retains ownership of the sandboxed privacy-fetch broker;
it supplies streams to the download Worker through `servePrivacyStreamWithFetcher`
and `receivePrivacyStream`. They reuse the existing transferable-stream path and
bounded 256 KiB pull fallback. The Worker never imports the DOM broker client.
SHA-256 and synchronous file writes run in that Worker, with source-lifetime
cleanup on completion, pause or crash. `logic/catalog-file-download.ts` writes into:

```
models/huggingface.co/<owner>/<repository>/resolve/main/<original-relative-path>
```

`main` is a local storage convention, not a mutable network revision. No file is
split, converted, merged, or materialized as one whole-model ArrayBuffer.

### Publication and interruption protocol

For each weight file `name`, Naidan owns two sibling records:

- `.name.pending`: a bounded, validated journal binding repository, revision,
  original relative path, SHA-256, expected size and the last flushed offset.
- `.name.complete`: a bounded, validated receipt binding that verified source to
  the saved file's exact size and last-modified snapshot.

Pending always wins over complete. A matching receipt is required for image
inventory entries under `models/huggingface.co`. It is not a signature or proof
of training provenance. Inventory reads only local receipts and bounded headers;
opening/focusing the page never hashes whole models or contacts Hugging Face.

Writes take the existing model-mutation lock followed by the repository lock.
The writer creates pending before the first payload write. It flushes and records
checkpoints, verifies the complete streamed hash, checks the weight header, closes
the synchronous file handle, writes complete, and removes pending **last**. The
llama.cpp model reader also excludes per-file pending files. The existing llama
repository-wide `.llama-cpp-import-pending` journal remains supported separately;
image acquisition never takes over or deletes an unknown repository operation.

Pause/failure retains owned partial bytes. Explicit resume rehashes the stored
prefix and validates the HTTP Range response using the same parser as llama.cpp.
A valid full `200` response restarts only that owned download; invalid `206`
ranges never publish. A full-size pending file is hashed, not promoted by size.
Hash failures retain an invalid journal and restart on a subsequent explicit retry.
Completion-receipt failure leaves pending in place. Earlier completed components
survive failures in a later repository. Cooperative cancellation checkpoints first;
a stalled/crashed download Worker is terminated after a bounded grace period.

Old image downloads have no complete receipt. They remain stored but unselected.
An explicit **Download** verifies their bytes against the pinned source, then
creates the receipt **without fetching the payload again**. Conflicting existing
files are preserved and reported, never truncated or silently overwritten. This
same path can adopt an already installed llama.cpp encoder. Multi-GB verification
runs in the download Worker, not on the UI thread.

After acquisition, the library rescans and resolves the selected recipe. Only a
complete, structurally matching set becomes ready. Download completion with a
missing/incompatible component has its own non-ready UI state. When all selected
files are available, the catalog replaces Download with **Use this model**; this
action is local. Manual component choices remain explicit and are not silently
replaced on refresh. Unverified same-named files are never automatic fallbacks.

### Compact UI and progress

The catalog starts open; each recipe's details start closed. The heading contains
the model, primary quantization and one state-appropriate action. Details contain
component variants, `Hugging Face · owner/repo`, original file links and the same
save-to-device affordance as llama.cpp. Internal local-storage paths and long
setup essays are not rendered. Layout wraps by available card width, not by a
viewport breakpoint that might leave the name in a narrow column.

Downloads and local imports reuse `LlamaCppBrowserDownloadProgress.vue` directly.
Recipe progress has one aggregate byte total across all components; `processed`
counts network payload bytes, not local verification or reused files. Terminal
states remove the bar rather than repeating the completed message and showing a
native green progress element.

Folder input is equally supported across separate actions: drop the diffusion
repository now, the VAE repository later, and the encoder repository afterwards.
Preserve each repository's inner paths. The storage namespace remains
`models/user/<folder-name>`; directories are not renamed into pretend network
identities. The library composes a model across those roots. Repositories can
contain README/config/index/tokenizer files; these are retained, not executed.
Git LFS pointer text is not a downloaded weight and is reported.

Z-Image defaults to its distributed VAE plus Qwen3-4B; Qwen Image 2.1 defaults to
its dedicated VAE plus Qwen3-VL-8B. The initial feature is text-to-image only, so
image-editing projectors are not required or silently loaded. Recipe alternatives
are reviewed compatible families/quantizations, not arbitrary language models.

Standalone shows the same catalog/import/library UI with unavailable actions disabled; local presentation disclosures still work. No downloader,
network broker, metadata scanner, native controller, diagnostic observer or Wasm
is included through this feature; the actual Vite module-boundary test enforces it.

## Ownership and input contract

Naidan owns all application decisions: model component assignments, profile,
file sources, mount paths, native context/settings, GPU budget, sampler,
scheduler, seed, callback lifetime, Worker, cancellation and PNG encoding.
The core exposes upstream parameter initialization, functions and record layouts;
there is no image-command JSON dispatcher. All pointer/64-bit fields use bigint.
The form/Worker preserve the full signed 64-bit seed as decimal text, including
upstream's `-1` random-seed request (the resolved random seed is not returned).

The local-input workflow imports a **local repository working tree** into
`models/user/<original folder name>`, preserving paths, filenames and file bytes.
Git's `.git` object database is excluded; README, configuration, index and tokenizer
files are retained. This local-input action performs no network download, conversion, re-splitting or shard merging. Existing cached Hugging Face trees are read locally for companions.
Colliding roots are rejected rather than merged or replaced. A transient pending
marker hides incomplete imports from model readers. Imports use the existing
model mutation lock, stream copies, progress and cooperative cancellation.
Rollback removes only still-owned/matching files and empty directories; it does
not recursively remove a repository that may have been externally modified.

The image-specific picker normally shows recognized primary image weights.
Advanced reveals unverified weights without making them automatic defaults.
Separate component pickers can resolve companions **across repositories**.
Z-Image requires a Flux-format latent-16 VAE and Qwen3-4B-shaped encoder;
Qwen Image 2.1 requires its latent-64/RGBA VAE and Qwen3-VL-8B-shaped encoder.
The encoder fingerprint requires Qwen3-VL architecture, width 4096 and **36 text
layers**. The former 32-layer condition confused the attention-head count with
layer count; it rejected the catalog's own encoder. The official model config is
https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct/raw/main/config.json.
Regression fixtures cover 36 layers, reject the old 32-layer shape, and exercise
acquisition -> publication -> inventory -> recipe selection rather than only
isolated synthetic classifier calls.
These are structural classes, not proof that a fine-tune has identical training
weights or equivalent output quality. Gemma, other Qwen sizes and earlier Qwen
VAEs are not automatically substituted. Required components cannot be disabled.
This workspace still implements text-to-image, not image editing; projectors
needed only for editing are not loaded. Full SD checkpoints need no extra files.

Detection uses GGUF magic/metadata/tensor descriptors or validated safetensors
JSON/tensor shapes. Filenames alone never establish a family or compatibility.
The Turbo label within an already structurally recognized Z-Image family is a
filename/metadata hint because the Base and Turbo structures can coincide.
Header inspection is bounded (16 MiB JSON headers; GGUF range-read budget 32 MiB,
100,000 tensors, bounded item counts); unknown/over-budget files remain stored
and are reported. Git LFS pointers are not mistaken for downloaded weights.
Custom code in repositories is neither imported nor executed.

GGUF shard groups use standard names and `split.*` metadata. Safetensors groups
use a validated `weight_map` index and sibling-relative references. Missing,
inconsistent or duplicate tensors, unsafe paths and unsupported quantization
metadata are reported. Only selected component files and referenced shards are
mounted; unrelated repository files remain in storage. Each component receives
an isolated mount root with the **original relative paths**, even when files in
several repositories share the same basename. Native model parsing remains the
final authority for actual compatibility.

A manual single-file path remains available for experiments and existing SD1.5
workflows. Its GGUF/safetensors content is validated before native loading; use
folder import for index files and pre-sharded models. The Worker uses bounded
FileReaderSync reads over File snapshots from OPFS or manual selection. It never
materializes a complete large weight file in one ArrayBuffer.

The pinned ABI 2 artifact reports `_sdc_model_io_capabilities() == 3`: 64-bit
safetensors file positions (bit 0) and standard GGUF groups (bit 1). The Worker
checks these compiled capabilities before using the associated inputs. An older
development override is rejected for inputs it cannot support, never with a
request to split or merge original files. The normal npm dependency is already
pinned to the published artifact containing both capabilities.

Every component is mounted with the core's generic read-only helper, an 8 MiB
maximum read chunk and mmap disabled. Source lifetime extends through native
context destruction. A session-wide 64 MiB LRU cache reads aligned 8 MiB pages,
sharing its bound across all component files. It coalesces tiny native reads
without splitting, converting or reading a whole large model into CPU memory.
The bound covers cached bytes, not caller destinations, browser internals or
garbage-collection timing. Large files do **not** guarantee the model fits memory:
individual tensors, live activations, GPU buffers and staging allocations remain
limited. An explicit Wasm32 managed budget is below 4 GiB; Wasm64 allows a larger budget
but not unlimited physical/GPU memory.

## Runtime behavior and policy

Each explicit generation owns a new Worker/context. Success, cancellation,
error, navigation and disposal terminate it. Hard cancellation works even if
native code cannot process another message. This is Naidan's initial policy,
not a restriction imposed by the core. The caller can later design reuse or
other scheduling with the same exposed API.

For recognized Z-Image-Turbo, selecting the main model suggests 8 steps and CFG 1;
Qwen Image 2.1 suggests CFG 6 and disables its large prefix cache when model
arguments are empty. These are visible Naidan choices, not core restrictions.
Other application defaults are conservative: 256x256, 20 steps, upstream model-specific
sampler/scheduler, one image, tiled image decoding, no mmap, prefetch threads or
conditioning cache. The advanced panel exposes sampling, scheduler, guidance,
cache, tiling, attention and model arguments. Nothing silently forces Qwen
prefix-cache settings in the core. For Qwen experiments the caller may set
`qwen_image_2_1_prefix_cache=false` explicitly when needed.

The UI permits 128..2048 dimensions in multiples of 64, but this is **not** a
certified range on every model/device. Begin with a compatible small Stable
Diffusion 1.5 GGUF and 256 or 512 output; Qwen Image readiness is not established.
Backend fallbacks/transfers and large dispatch limits still need real testing.
Native diagnostics are available during the operation, including before a failure, in opt-in debug mode. No resolution reduction or backend
switch is silently retried. Up to four PNGs remain in memory; URLs are revoked
on deletion/unmount. Results are not written into chat/history/storage.

## Live diagnostics and non-completing generations

The image debug checkbox uses the same per-request `debug: "off" | "on"` approach
as the llama browser/audio requests. It does not reuse another chat's debug state.
The image request snapshots it before creating its dedicated Worker. Turning it
on does not select test Wasm, change precision, enable an alternative backend or
change generation parameters. Current published ABI 2 is sufficient; no bicore
rebuild or generated-code string replacement is involved.

Basic checkpoints are available even without verbose native text. Debug mode adds:

- Runtime fetch/instantiate, model-header/load, generation, sampling, PNG encoding
  and cleanup boundaries. A start is posted **before** each potentially long call.
- Public source/profile/schema and selected settings; tensor dtype counts and
  largest tensor element count from file headers; bounded file-read counters,
  total bytes, maximum 64-bit offset and time spent inside file reads.
- The existing stable-diffusion log callback, including its debug/verbose levels
  and segment/model-manager logs when upstream emits them.
- Observations of the **actual runtime-requested** WebGPU device: features/limits,
  shader and pipeline creation, buffer request totals, uploads/submissions/queue
  completions, device loss, uncaptured errors and observed error-scope results.
  Buffer request totals are cumulative, **not current VRAM consumption**.

`file-read` reports cumulative per-file logical `reads`, `bytes` and `readMs`,
separately from actual `blobReads`, `blobBytes` and `blobReadMs` (including slicing
and synchronous Blob access). `readMs` includes `blobReadMs`; do not add them.
`cacheHits` counts nonempty logical reads served entirely from cached pages;
`cacheHitBytes` also includes cached portions of partially satisfied reads.
Read-ahead may make `blobBytes` greater than logical `bytes`. A final report is
emitted during cleanup, including after failure, so the last partial interval is
not lost. Cache capacity and retained bytes describe the shared session cache,
not separate per-file allowances.

GPU observation is confined to the disposable Worker. It returns the real native
objects, forwards the same arguments, never requests an extra device, and restores
instance methods on teardown. Diagnostic failure cannot change native outcomes.
It does not enable compile-time upstream GPU tracing or report every scheduler
node's actual CPU/GPU placement. BF16 in a file header is **not proof** of CPU
fallback; a quiet GPU or a slow phase alone is not proof of a deadlock either.

One-way notifications pass through schema-checked worker-transport helpers instead
of queued RPC callback acknowledgements. The window adds a five-second heartbeat
with the last known stage and time since a Worker notification. It continues when
synchronous Wasm occupies the Worker; timer throttling in a hidden tab can delay
it. Silence never auto-cancels, changes the seed/model, or starts a retry.

The UI exposes **Copy logs** and **Save logs** while generation is pending, after
errors and after cancellation. Verbose records also use the console prefix
`[stable-diffusion-cpp-browser]`. Native lines are rate-limited with dropped-line
counts; exports retain initial context plus a bounded tail (about 384 KiB). The
buffer is temporary and replaced by the next generation, not written to storage
or sent to a server automatically. Inspect logs before sharing: file paths and
technical model messages can identify local files. Common prompt/token dumps,
exact input strings and URLs are redacted as a best-effort privacy filter, not a
claim that every conceivable upstream message is content-free.

For a reported Z-Image-Turbo hang: enable debug, start generation, copy/save logs
**before cancelling or leaving the page**. Repeated reads suggest transfer/reload
work; a native segment-start without progress narrows the location; a GPU queue
or device error is distinct from a model-load failure. The logs support further
investigation; this change does not claim the reported hang or a BF16/F32 issue
has already been reproduced or repaired.

## Weight residency and optional GPU budget

Auto requests `backend="WebGPU"`, `params_backend="WebGPU"`, `eager_load=true`
and `auto_fit=false`. Supported weights are loaded onto the GPU before generation
and retained for the operation, without arbitrary CPU/disk model-size thresholds.
Native unsupported tensor/operation fallbacks can still use the CPU; requested
placement is not evidence that every tensor or graph node executes on the GPU.
The existing CPU, hybrid and disk choices remain explicit advanced alternatives.

The managed-memory target in advanced settings starts empty. An empty input
becomes `undefined` in the request and a null `sd_ctx_params_t.max_vram` pointer.
In the pinned runtime this leaves the managed budget unset, rather than imposing
an artificial 2 GiB cap. The WebGPU memory-query overlay reports unknown free and
total capacity (0/0); the native manager treats that as unknown, not zero usable
memory. Actual buffer/binding, Wasm and device allocation limits still apply.
Allocation failures are reported; Naidan does not silently retry with CPU weights,
lower precision or a smaller image.

An explicitly entered target is converted from MiB to a GiB string. It covers
resident weights plus working buffers and can guide graph segmentation; it is
not a model-file-size limit or a measurement of available memory. A budget smaller
than GPU-resident weights plus workspace can prevent generation. Explicit Wasm32
budgets remain below 4096 MiB because native accounting uses `size_t`; this does
not impose a 4 GiB file-size ceiling or detect physical GPU memory.

Source: stable-diffusion.cpp `88411ef`, `include/stable-diffusion.h` (max_vram),
`src/core/ggml_graph_cut.cpp` (budget parsing/segmentation), and
`src/model_manager.cpp` (managed capacity/residency/eviction). These are runtime
policies exposed by stable-diffusion.cpp and selected by Naidan, not a general
WebGPU requirement. The core remains policy-free and no new core build is needed.

## Tests and limits

Feature tests include actual Vite output checks for both hosted/standalone module
graphs, disabled-form behavior, and rejection of bypass imports/assets. They also
cover input validation, exact seeds, large-offset file callbacks,
public-record/control/cleanup mapping with mocked native calls, bounded artifact
integration, unsupported/legacy artifacts, Worker cancellation and page behavior.
Those mocked tests do not demonstrate image inference. The core's native/CI
large-GGUF probes separately exercise real metadata parsing and C++ file reads.
The installed-package test validates actual emitted modules, licenses and bounded
gzip payloads against the dependency manifest; this is not model inference.
Feature, build-boundary and worker tests may be run locally using a temporary,
untracked tsconfig/Vitest configuration. Do not run Naidan-wide lint, tests or
typecheck in the constrained assistant environment.

Published bicore browser-smoke success does not cover Naidan's complete browser
execution path or GPU/model initialization. End-to-end image generation still
needs validation on a supported device. Wasm size optimization is deferred.
