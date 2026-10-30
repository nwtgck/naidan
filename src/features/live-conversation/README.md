# Live conversation

An independent, ephemeral workspace at `/live-conversation`. Its sidebar link is
additive: the existing Chat view, Chat state and persisted Chat DTOs are unchanged.

## Boundaries

- `components/` owns the workspace and its channel controls.
- `logic/controller.ts` owns the session, current turn, explicit tool approval and
  cancellation ordering. Reloading or leaving the page closes the session.
- `logic/audio-capture.ts` owns permission, tracks, a self-contained AudioWorklet
  and a continuous anti-aliased resampler. The Worklet is a self-contained raw
  script with a validated MessagePort boundary, not a new dedicated Worker graph.
- `logic/audio-playback.ts` owns short PCM playback queues independently of native
  inference. Muting playback is not the same as disabling audio generation.
- The existing llama-cpp-browser client facade owns one exclusive live lease.
  `worker/live-session.ts` owns resident weights, the multimodal projector and the
  native conversation. It uses the public upstream audio helpers rather than
  reimplementing the codec or running a separate recognizer/synthesizer.

Only the three WebGPU JSPI profiles are targeted. Other profiles fail through the
normal runtime/API path; the native session entry carries the corresponding TODO.
No bicore artifacts or source are changed by this feature.

## Turn invariants

Input is direct audio, optional literal text and (for a capable model) images.
Images and text are fixed at the start of a turn. The native stream consumes audio
while the user records; **Stop and send** commits the turn. Input transcription is
optional additional inference by the same model, using an isolated native state.
It is not required for audio understanding and is not live transcription.

The output policy is captured per turn: text, audio, or interleaved text/audio.
Changing channels affects the next turn without reloading weights. Output text is
co-generated text, not a second transcription of generated audio. Hiding text and
muting playback do not reduce inference work.

A full native sequence checkpoint is taken before input. It includes recurrent,
attention and sliding-window state. A manual interrupt stops playback immediately,
then cooperatively stops generation and restores the pre-turn checkpoint. The
**entire interrupted turn** is marked discarded, including its user input. Already
heard partial audio is not falsely treated as a completed native conversation.
New input is disabled while a completed native answer still has queued speech;
finish playback or explicitly interrupt first. A failed restore closes the session;
it never resumes from an uncertain state.

There are explicit bounds: 64 visible turns, 180 seconds per input/output, 8 seconds
of pending input, four images (16 MiB each), 512 MiB per native checkpoint and eight
tool rounds per turn. Exceeding a bound is visible, not silent loss of audio. The
model context can reach its own limit earlier; clearing the conversation preserves
resident weights. Native codec output uses PCM with the reported sample rate.

## Wesh

Wesh is opt-in. Only one explicitly selected existing Volume is mounted at
`/workspace`; access defaults to read-only. Chat and `/sys/fs/naidan` mounts are
not inherited. Every complete tool batch requires an explicit approval or denial.
Partial tool calls, malformed arguments and unsupported tool names never execute.
Results keep literal-input provenance when passed back through the native template.

Ending the session disposes the Wesh process, not its persistent Volume. Interrupt
or context rollback cannot undo approved filesystem writes; these remain real side
effects even when the conversation turn is discarded.

## Validation and limits

Unit tests cover controller races, source/stream ordering, late microphone
permission, bounded queues, interruption, literal tool output, 32/64-bit native
record access and ownership. The hybrid checkpoint regression uses a tiny synthetic
LFM2 model with real CPU WebAssembly. It is not validation of real LFM3 audio or
WebGPU operation. Web Audio tests use local fakes, not hardware permissions.

Actual LFM3-Audio/Omni weights, browsers, microphones, WebGPU device behavior and
hosted/file-protocol playback still need device-level verification. This initial
implementation has manual recording/interrupt, not automatic voice activity
selection, full-duplex inference, video, camera capture or audio-file import.

Run targeted tests with the repository's `npm run test:only-failed -- <paths>`
runner. Do not substitute a whole-application run for affected-scope verification.
