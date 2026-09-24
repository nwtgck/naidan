# Experimental browser image workspace

`/#/image-generation-lab` is a dedicated experimental image workspace.
The sidebar quick-access link opens it.
Opening the page does not fetch model files, instantiate Wasm, create an inference
Worker or request a GPU adapter. Settings/results are temporary page-local state.

## Published bicore integration

The normal dependency installation now supplies the image runtime separately:

```text
stable-diffusion-cpp-browser-core
  -> github:nwtgck/llama-cpp-browser-core#c3a3a1f27b22d95bdd6ec6c35f3f623e4e18479a
```

This is a dependency name for the existing **Browser Inference Core (bicore)**
artifact repository, not a separately published registry package. Keep Naidan's
existing `llama-cpp-browser-core` dependency and its adapters unchanged. The image
package's `resolved` and `integrity` lock fields come from the supplied CI-generated
consumer metadata. The underlying package remains `llama-cpp-browser-core`.
There is no compiler, postinstall hook, model download or generated-code rewrite.

```sh
npm ci
npm run build:hosted
# Or, for the hosted development server:
npm run dev
```

Open `/#/image-generation-lab` from the sidebar quick-access link, choose complete
GGUF files and start generation explicitly. No environment variable or manual
copy into node_modules is needed with the committed dependency installed.

The initial artifact is source commit
`1a354989ff799210eaf3b14c26970ada4cf3cbfc`, image ABI 2 / image manifest format 2.
Its manifest records all three profiles in both variants as compiled and
browser-smoke validated, including real-Wasm Worker/public-record/callback tests
and virtual unsplit GGUF reads above 8 GiB. **It does not certify trained-model
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
standalone output. Its allowlist is deliberately small: the Vue view, form state,
form options, standalone composable and standalone client stub. Type-only imports
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
feature does not change that policy or download model weights. Wasm decompression is bounded
by its verified byte count and followed by SHA-256 verification. Core attachment
checks the schema fingerprint embedded in the compiled binary too.

## Ownership and input contract

Naidan owns all application decisions: model component assignments, profile,
file sources, mount paths, native context/settings, GPU budget, sampler,
scheduler, seed, callback lifetime, Worker, cancellation and PNG encoding.
The core exposes upstream parameter initialization, functions and record layouts;
there is no image-command JSON dispatcher. All pointer/64-bit fields use bigint.
The form/Worker preserve the full signed 64-bit seed as decimal text, including
upstream's `-1` random-seed request (the resolved random seed is not returned).

Only **complete, unsplit GGUF** files are accepted by this UI. Header magic and
v2/v3 are checked before mounting. Common shard filenames are rejected. A split
checkpoint is not automatically assembled. Model architectures and tensor
quantizations must still be supported by the pinned image core/GGML backend.
A combined checkpoint or separate diffusion/encoder/VAE GGUF files can be chosen.
Separate components are not shards of a single GGUF.

`createGgufFileSource` uses FileReaderSync on **bounded File.slice ranges** in the
Worker; the file itself is structured-cloned, not read into a giant array first.
It implements the same `{size, read(destination, offset)}` boundary as llama's
caller-owned adapter. Offsets stay safe JavaScript integers, including above
4/8/18 GiB. Changing to an OPFS or other synchronous source is an application
change, not a core rewrite; this initial UI does not implement OPFS persistence.

Every component is mounted with the core's generic read-only helper, an 8 MiB
maximum read chunk and mmap disabled. Source lifetime extends through native
context destruction. Large files do **not** guarantee the model fits memory:
individual tensors, live activations, GPU buffers and staging allocations remain
limited. The Wasm32 managed budget is below 4 GiB; Wasm64 allows a larger budget
but not unlimited physical/GPU memory.

## Runtime behavior and policy

Each explicit generation owns a new Worker/context. Success, cancellation,
error, navigation and disposal terminate it. Hard cancellation works even if
native code cannot process another message. This is Naidan's initial policy,
not a restriction imposed by the core. The caller can later design reuse or
other scheduling with the same exposed API.

Application defaults are conservative: 256x256, 20 steps, upstream model-specific
sampler/scheduler, one image, tiled image decoding, no mmap, prefetch threads or
conditioning cache. The advanced panel exposes sampling, scheduler, guidance,
cache, tiling, attention and model arguments. Nothing silently forces Qwen
prefix-cache settings in the core. For Qwen experiments the caller may set
`qwen_image_2_1_prefix_cache=false` explicitly when needed.

The UI permits 128..2048 dimensions in multiples of 64, but this is **not** a
certified range on every model/device. Begin with a compatible small Stable
Diffusion 1.5 GGUF and 256 or 512 output; Qwen Image readiness is not established.
Backend fallbacks/transfers and large dispatch limits still need real testing.
Native diagnostics are retained for failures. No resolution reduction or backend
switch is silently retried. Up to four PNGs remain in memory; URLs are revoked
on deletion/unmount. Results are not written into chat/history/storage.

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
