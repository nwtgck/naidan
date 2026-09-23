# Local audio generation

This feature is independent of chat and the Web Speech reading feature. It uses
shared model storage and the serialized inference worker, but owns its input,
result, cancellation, and model lifetime. It returns a complete WAV file. It does
not play partially generated audio or autoplay.

## Layout and form behavior

Only this view owns an absolute, vertically scrollable viewport inside the
existing relative main layout slot. The expanded model manager has a separate
bounded scroll area. Do not change global body overflow or the common layout to
fix this screen. `novalidate` is intentional: browser validation cannot focus an
invalid input inside closed details. Zod validation instead renders a visible
summary, opens the field's ancestor details, focuses it, and adds inline range
information / aria-invalid. The worker validates again at its boundary.

## Language

The initial language follows Naidan's explicit interface locale, not the browser
locale. `Intl.DisplayNames` provides localized names and native names are added
as a second cue, except for the interface's own language. Labels follow locale
changes without changing a language already selected for speech.

Only explicit language choices and the upstream model default are exposed. The
retired downstream automatic-language request is rejected at the input/worker
boundary, not interpreted as English, guessed from text, or silently mapped to
another setting. Qwen's model default is English; it is not language detection.
Pocket's language is a property of its weights and this selector does not override
it. Localized labels do not imply additional model capabilities.

No downstream audio-capability query is imported or called, even when an older
published artifact still contains that export. Restoring automatic language or
other model-specific conditioning requires upstream support or explicit owner
approval of a new maintenance exception; a reference demo alone is not proof of
support in the pinned llama.cpp helper.

## Context and offline execution

The transport accepts a positive integer context request. The session bounds the
requested context by `llama_model_n_ctx_train` and can retry smaller allocations.
4096 remains the default. Increasing capacity is not a speed setting and does
not prove that enough memory is available. The native context-ready diagnostic
records the actual allocation. The independent 8192-character text limit and
maximum generation-step setting serve different purposes.

Once the app, runtime, and required models are locally available, generation does
not need an inference server or communication. Fetching missing assets or updates
still requires communication. Neither reference audio nor spoken text is sent to
an inference server. Cached files are not a guarantee against browser storage
eviction; a hosted URL also needs the app shell available offline.

## Complete-output latency

The default audio backend follows the selected execution profile. CPU remains a
manual compatibility/debugging choice, not an assertion that it is faster.
Audio helper operations log their elapsed time in diagnostics. Cooperative task
yields occur at a bounded cadence rather than an extra timer after every fast
frame; cancellation still checks before/after calls and the final forced yield.

Waveform decoding follows the pinned upstream implementation. The downstream
final-frame graph optimization has been removed from lcore; do not recreate it in
this feature or in a copied decoder. The frontend's cooperative-wait improvement
and elapsed-time diagnostics are independent and remain in place. This cleanup
is not a claim of faster native decoding.

## Reference audio and instructions

The previous lcore single-thread overlay is separate. Runtime profiles already
use a non-pthread Wasm configuration. That overlay serializes preprocessing
routines which otherwise construct threads internally, notably Qwen's reference
speaker path. No-reference Qwen skips that path, so it can work without that fix.
It does not force WebGPU model inference onto CPU. The Parakeet hunk covers
another generic audio preprocessing loop, not no-reference Qwen synthesis.

No `instruct` field is sent or prepended to spoken text. Qwen Base's current native
pipeline does not implement that conditioning. Supporting CustomVoice 1.7B or
VoiceDesign 1.7B requires their distinct model conversion/loading and prompt
conditioning, followed by a generic helper capability/input extension. A disabled
or silently ignored request must not be presented as working style control.

## Artifact transition

These frontend changes work with the previous and the cleaned core interface.
The old capability query is not required, and automatic-language input is no
longer accepted. A source cleanup cannot alter already published or cached Wasm
bytes. Until the cleaned lcore is built, published, and selected through the
normal dependency/hash update, an older artifact may still perform its internal
waveform optimization even though this UI no longer advertises Auto.

Do not invent a replacement artifact commit or bypass manifest verification.
This change does not alter the runtime profile policy or standalone bundle set:
chat and audio still share the same loader, worker lane, and embedded profiles.
The app, runtime, and model files must remain available for offline use.

## Candidate discovery and defaults

Audio candidates are detected from bounded local GGUF metadata, not file names.
Read the backbone architecture and the selected companion's generation metadata.
Known Qwen3-TTS and Pocket TTS pairs are suggestions, not compatibility proofs.
Unknown metadata, incomplete pairs, and future architectures remain selectable
through the explicit all-models mode. This scan must not download files, load
Wasm, occupy the inference lane, or persist metadata into the shared model store.

The context default remains 4096 to limit eager allocation; generation now allows
up to 1024 steps rather than 256. A native stop still ends generation sooner.
For Qwen's 24,000 Hz / 1,920-sample frame configuration, these step caps correspond
to approximately 81.92 and 20.48 seconds, respectively, not execution time.
Neither bound guarantees that arbitrary text will fit; context and step limits
remain independently enforced.

Metadata references (pinned llama.cpp, not a downstream model implementation):
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/conversion/qwen3tts.py
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/conversion/pockettts.py
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/gguf-py/gguf/constants.py
- https://huggingface.co/Qwen/Qwen3-TTS-Tokenizer-12Hz/blob/main/config.json


Candidate ordering is deterministic: a detected model that does not require a
reference is preferred, followed by smaller stored file size, then stable model
ID. This is a convenience default, not a quality or peak-memory ranking. Refresh
must preserve a manual selection and a still-detected automatic selection. A new
inventory aborts the old scan; late results cannot replace current choices.
Metadata read/format limits yield an unverified model, never an execution ban.

## In-memory results

Each successful completion prepends an audio result without clearing older ones
on submit, failure, validation errors, or cancellation. Capture settings before
awaiting inference; never read current form values when a result arrives. Keep
text, language, model identity/name, and requested numeric/runtime parameters.
Do not store the reference audio Blob or its file bytes in a history entry.
Requested profile/context are not necessarily the resolved native profile/context;
a random seed sentinel is not the actual sampled seed. This is an inspection
record, not a promise of exact reproducibility.

The page owns this history. Nothing is persisted to browser storage or chat.
Leaving the route/reloading clears it. Individual and bulk deletion revoke Blob
URLs and unmount players, stopping playback and detaching decoded sources. Store
one Blob URL per result rather than retaining an extra WAV byte array. Report
WAV byte totals (not total browser memory); avoid silently evicting old results.
Users can save WAVs or explicitly delete results to reclaim their owned data.


## Model controls and reusable composition

The page's native `details` element is the disclosure and scroll boundary only.
`LlamaCppBrowserManager` coordinates the inventory, removals, subscriptions, and
child controls; it is not a second settings modal. Repository inspection already
lives in `LlamaCppBrowserHuggingFaceManager`, and the chat recommendation catalog
remains in its existing components. Device file/folder import and runtime settings
are independent `LlamaCppBrowserModelImport` and `LlamaCppBrowserRuntimeSettings`
components. Preserve settings-modal behavior when composing them elsewhere.

The manager's optional `catalog` slot provides an explicit repository-inspection
action and its disabled state. The static `LlamaCppBrowserRepositoryCatalog`
renders the audio page's two user-selected repository references. Opening the
page/disclosure is not permission to contact Hugging Face. Check model uses the
existing inspector, displays the resolved quantization and same-repository
companion, and still requires the user to press Download. Do not hard-code remote
file names or bypass download planning, integrity, or storage locks.

Audio choices use the shared `ModelSelector` with an explicit list of stable IDs
and separate display labels. Searching considers both. Refresh explicitly reloads
the local inventory; it must not fetch an unrelated chat provider. Candidate
filtering, the all-models escape hatch, and user-selection preservation are unchanged.

## Recovery after runtime errors

A failed generation can retire the shared Worker and invalidate its capability
report, making `runtimeReady` false. The explicit Reinitialize runtime action
releases an idle runtime and probes its replacement through the existing queue.
It does not clear model storage, reference input, text, history, or options, and
it does not generate automatically. The next generation loads model weights as usual.

The service checks the lane owner synchronously before releasing anything, not
only the UI progress state: a chat tool callback can own the lane while the last
reported state is idle. Recovery rejects with busy in that case and does not abort
the owner. Leaving this page aborts only its recovery observer. Unsupported
profiles, incompatible models, memory exhaustion, and permanently hung active
operations are not claimed to be fixed by this control. The existing manager's
explicit Release runtime control retains its pre-refactor cancellation semantics.

## Result text and compact playback

Each result shows a two-line clamped preview outside its settings disclosure.
Inside the disclosure, Copy text copies the exact submission text including
whitespace; denied/unavailable clipboard access presents a manual selected-text
fallback. A pending copy may not select content after the result is deleted.
The player and WAV link share one nonwrapping flex row. At narrow widths the save
label is visually hidden, not removed from its accessible name. No custom player,
streaming, autoplay, persistence, or lcore modification is introduced.
