# Local audio generation

This feature is independent of chat and the Web Speech reading feature. It uses
shared model storage and the serialized inference worker, but owns its input,
result, cancellation, and model lifetime. It returns a final WAV file and can
add explicitly requested intermediate WAV snapshots to page history. Playback
remains user-controlled; there is no automatic streaming player or autoplay.

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

The audio catalog now uses the original `LlamaCppBrowserModelSuggestions` and
`LlamaCppBrowserModelSuggestion` UI, outside the model/runtime `details`. Its
custom disclosure has independent state and inert collapsed contents. The shared
component accepts optional bundled entries and a local-selection action; settings
continues to use the original chat catalog and default-model action. The older
repository-link-only catalog is no longer used on this page.

The two Qwen entries use existing explicit Check/Download handlers, the metadata
session, download queue, pinned plans, and local storage checks. Mounting,
folding, unfolding, details, quantization changes, and local-inventory refreshes
never authorize repository requests. There are no remote icons or eager hints.
Required audio companions are included in resolved plans and cannot be toggled
off; ambiguous/missing companions fail instead of downloading only the talker.
File sizes are rounded editorial hints from the repositories, not identities.
Audio hides the text-catalog memory filter, which is not a TTS runtime guarantee.

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

## Finish a partial generation, or cancel and discard

`completionSignal` is an independent, optional control signal.
`cancellationSignal` discards uncaptured output; it alone reaches native abort
and the cancellation timeout. `completionSignal` sends a generation-ID-scoped
`finishAudioGeneration` message to the same Worker; it never terminates a Worker or arms cancellation's five-second
cleanup deadline. The server accepts this control message outside the held
inference lane, but applies it only to the matching active audio request.
Other chats, imports, old IDs and future requests are unaffected. Signals and
late failures are detached/ignored when that request is complete.

The native loop checks `shouldComplete` between complete steps, after yielding to
queued tasks. Once at least one frame exists, it stops generating additional
frames, calls the existing upstream output helper (which flushes accumulated
codes), copies the WAV, and cleans up normally. The result reason is `user-stop`,
not a claim that the text finished. No end token, native patch, per-model graph,
or streaming playback is introduced. Finishing can still take time for a running
step and final waveform decoding; the last word can be incomplete. Cancel and
discard remains available and takes precedence, including during decoding.

## Page-local reference library

`AudioReferenceInput` owns a bounded in-memory library and explicit selection.
Adding files or a completed recording selects only the latest successful input.
Check other entries for multiple selection. The order shown (newest first) is the
concatenation order. Deselecting all keeps files available; deleting never selects
a different voice implicitly. Delete/unmount revokes URLs, detaches players and
releases owned file references. Nothing is persisted to model storage or chat.
This library is separate from generated-audio history; reference bytes and
recordings are never copied into history settings.

The pinned native helper accepts one speaker bitmap. One selected WAV/MP3/FLAC
retains the existing native path, without browser decoding/re-encoding. Multiple
selections and browser-only input containers are decoded sequentially with
`OfflineAudioContext`, resampled to 24 kHz, downmixed to mono and encoded as
16-bit PCM WAV. Selected clips are concatenated, NOT superimposed, and a single
WAV is passed to the existing native input. This does not blend voice identities
or guarantee useful multi-speaker conditioning; prefer examples of the same
speaker. A failed clip or excessive total duration rejects preparation rather
than silently dropping/trimming it. Selection is captured before any await.

Limits: 16 MiB per source file, 32 library entries / 64 MiB source bytes, and
30 seconds total selected audio. The library reports source bytes, not total
browser memory. Browser decoding may allocate before duration can be checked;
these are not hard peak-memory bounds. Single native inputs are still validated
in the Worker. Browser-only formats depend on the browser's decoders. Users can
always deselect/delete references or use the original supported single-file path.
Preparation happens before occupying the shared inference lane and is cancellable
at asynchronous boundaries; browser decode itself cannot be synchronously aborted.

## Explicit microphone capture

`useReferenceRecording` requests `{audio:true, video:false}` only when Record is
pressed. There is no permission request on mount, model loading, selection, or
generation. Keep unavailable controls visible with an explanation. Microphone
availability depends on the browser, a permitted secure context and user/site
permissions; a file URL or hosted page is not a blanket permission guarantee.

Capture uses `MediaRecorder` with supported MIME negotiation, accumulates bounded
chunks, and releases tracks as soon as Stop/discard/error/unmount occurs. It also
stops streams returned by a late permission response after cancellation. Stop
waits for the final data event before normalizing to a WAV reference. Capture
ends automatically after 30 seconds (subject to browser timer scheduling); an
explicit recording-only policy caps delayed final audio to the first 30 seconds
and visibly reports trimming. This policy never trims imported/combined clips.
Permission denials, missing devices, encoder errors and decoder errors remain
local and retryable. Recording blocks generation but never prevents its own
Stop/discard controls when another shared inference job becomes busy.

Browser encoding and normalization are separate from lcore. No new library,
service, native API, upstream patch or standalone runtime is required. Synthetic
unit tests do not prove real model voice quality or device microphone operation.

Sources used for this feature boundary:
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/mtmd/mtmd-helper.h
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/mtmd/mtmd-helper-gen.cpp
- https://www.w3.org/TR/mediastream-recording/
- https://www.w3.org/TR/webaudio/
- https://www.w3.org/TR/mediacapture-streams/


## Continuing, user-requested audio snapshots

`generateAudio({ input, cancellationSignal, completionSignal, preview })` separates
cancellation, graceful completion, and repeatable preview intent. AbortSignals are
one-shot: repeatable previews use a generation-local versioned request source,
not an AbortSignal that is silently replaced. A pending request survives queuing
or lazy standalone initialization. The client forwards only generation ID and
request version, and detaches its listener after completion. The server applies
requests only to the matching active audio operation and coalesces duplicates.

The implementation uses the existing output helper; it does not modify lcore or
llama.cpp, patch generated files, or reimplement the model. It continues using the
pinned 0fc505c5 artifact / upstream b29c606e. Re-review the following timing
assumptions when updating upstream:

- Qwen's helper flushes every 72 generated code frames. An arbitrary intermediate
  `get_output` would flush a partially filled block, whose padded frames advance
  the original decoder's state. Therefore a preview waits until a 72-frame
  boundary where the helper has already flushed; the getter then only serializes
  existing accumulated audio. No early tail flush, replay, or KV-state rewind is
  used. A short utterance may finish before that point and produce only its final
  result. The user-requested step and delivered step can differ.
- Pocket accepts exact-length waveform chunks. Its helper may advance through
  prompt-chunk transitions, so the UI's generated-step count is not a universal
  conversion into audio duration and does not pretend to count text tokens.
- Output is cumulative, not only the newest chunk. Copy borrowed WAV bytes before
  resuming native generation. Transfer one owned copy and await its callback
  acknowledgment instead of buffering unlimited cross-worker outputs. Capturing
  has serialization/copy overhead; it does not cancel or restart inference.

Preview outputs have a separate validated `finishReason: 'preview'` contract;
the final promise cannot masquerade as a preview. Both final and intermediate
history entries display the actual completed step count separately from the
requested maximum. Original text/settings are captured once at submission;
reference audio is still never retained in result history. Already accepted
previews survive cancellation/failure of the remaining generation. Route exit
revokes all URLs and ignores late callbacks. There is no autoplay, background
capture, persistent audio storage, or additional runtime profile.

Source review:
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/mtmd/mtmd-helper-gen.cpp
- https://github.com/ggml-org/llama.cpp/blob/b29c606e28a01b1bc8c1351026a0fa6e616bf6c4/tools/mtmd/clip.cpp
- https://huggingface.co/mradermacher/Qwen3-TTS-12Hz-0.6B-Base-GGUF/tree/main
- https://huggingface.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF/tree/main
