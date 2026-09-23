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

Automatic language selection is **model-native conditioning**, not client-side
script guessing, an external service, or a detected-language result. An older
core artifact keeps Auto visible but disabled. The generated ABI schema must
expose `mtmd_helper_gen_audio_supports_language_auto`, and the worker must check
that query for the loaded selectable-language pipeline. An unsupported Auto is
an error, never an English fallback. Qwen uses the official no-forced-language
prefix added by the accompanying lcore overlay. Pocket's language remains a
property of its weights; the help explicitly explains that the selector does
not override it. Short or ambiguous text may benefit from manual selection.

The special model-default choice is distinct from Auto: Qwen's existing default
is English. No unknown model is assumed to support extra conditioning.

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

The lcore follow-up reduces Qwen's final waveform graph to the actual number of
frames, instead of computing a padded 72-frame window and throwing away its tail.
This is a native inference optimization, not streaming playback. A full 72-frame
block is unchanged. Device/model timings and trained-model quality must be
verified with rebuilt artifacts; synthetic CPU tests are not a WebGPU benchmark.

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

## Artifact prerequisite

The source patches deliberately do not invent a new published core revision or
hash. Build and publish the patched lcore, then update the actual dependency and
integrity metadata through Naidan's normal artifact-update flow. UI/layout/form
improvements work with the old artifact; native Auto and shorter waveform graphs
require the new artifact. Applying a source patch alone does not replace cached
Wasm binaries.
