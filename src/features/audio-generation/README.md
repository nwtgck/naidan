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

8192 was the initial application input limit, not a universal model limit. The
transport accepts a wider positive integer range. The session still bounds the
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
