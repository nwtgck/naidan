import { createAbortableByteStream } from '@/utils/abortable-byte-stream';
import { exactObject } from '@/utils/exact-object';
import { StreamingZipWriter, createWebZipCompressionCodec } from '@/utils/zip-stream';
import { createMemoryZipCentralDirectoryStore, createReadableZipOutput } from '@/utils/zip-stream/memory';
import { speechInvestigationLimits, speechInvestigationCollectionLimits, type SpeechInvestigationAudio, type SpeechInvestigationCollectionSnapshot, type SpeechInvestigationExportOptions, type SpeechInvestigationOperation, type SpeechInvestigationPlan, type SpeechInvestigationTrialPlan, type SpeechInvestigationSettings, type SpeechInvestigationSnapshot } from './types';

const readme = `\
# Speech browser investigation / ZIP v2

Start with manifest.json for collection/trial status, missing files and limits,
and plan.json for the fixed source/model/settings and selected trial order.
load/ contains the actual model-load record, if observed. It is never a generated
trial. Each trials/NNN-ID/ contains its own environment.json, operation.json and
events.jsonl. Join plan trial IDs, manifest prefixes and recorder run IDs; their
clocks are distinct. not_run is not a zero-time success. in_progress has capturedAt
but no finishedAt, and a checkpoint does not stop collection or native work.

Trial operation.json contains actual result text, original filename, selected
model identity, requested/effective settings, detailed failures and measurements.
Native model_info.rawJson is preserved without interpreting its private schema;
truncation can make it incomplete JSON. Native/app completion and capture status
are separate: missing retained audio does not rewrite an observed native success.
Collection partial plus capture reasons identify budget loss and unexecuted trials.

Default exports include recognition/response text, names, model identity, settings,
detailed errors/logs/metrics and retained generated audio/output.wav for each trial.
Only explicit input-audio selection includes source/audio.* (the common original
once) and trial audio/input.wav (adjusted/client-accepted PCM). Only explicit
input-text selection includes each operation's input.json persona/instructions/
character-name bodies. plan.json contains set/unset facts, never these bodies.
Diagnostic messages and result text can contain input-derived/personal content;
these remain useful evidence. Review before sharing. Nothing uploads automatically.
No model weights, credentials or unrelated application state are collected.

Source audio, gain-adjusted/decoded/resampled input, client acceptance and native
consumption are different boundaries. Read each operation's processing and audio
descriptions. Input meters can include queued samples; received/output meters can
cover more PCM than budget-limited prefix WAVs. Check audioRetention status/bytes
and clip duration. A complete operation does not prove correct recognition or
conversation. Recognition text is output; dialogue text is not a user transcript.
Missing/unset/unavailable/not_applicable/unknown differ from observed zero.

Event atMilliseconds is recorder receipt time relative to its own monotonic run
origin, not native/GPU time. Worker duration fields are stage host wall intervals.
Do not subtract timestamps across records or threads. Date labels are wall clocks.
Real-time replay intentionally waits; its wall-time ratio is not pure inference
speed. Read coverage is unique successful file ranges, not total I/O, cache hits
or GPU completion. Estimated work and observed bytes are separate. Wasm capacity
is linear-memory capacity, not live allocation or peak VRAM. GPU kernel timing,
peak VRAM and browser/OS cache hits are unobserved; no profiling runtime is used.

Runtime/schema hashes identify supplied artifacts/ABI. wasmVerification=verified
requires the matching loader's mandatory raw-Wasm/schema/ABI check; manifest_only
is a declaration. Neither proves operation success, model payload identity,
executed transformed JS/helper bytes or GPU correctness. Model names/sizes are not
payload hashes. An actually used GPU is never replaced by a newly probed adapter.

One recorder is active. The collection retains up to six trial snapshots and one
independent load slot. See limits/capture for collection and per-record byte/count
ceilings, dropped events, text truncation and rejected metadata updates.
latestMetadata=rejected retains prior values, not final state. Source and all
retained trial WAVs share a 64 MiB budget. Next-trial retention uses the remaining
budget; exhaustion stops later trials with reasons. Blob references are shared,
never copied or fetched from URLs. Immutable export snapshots survive UI clear.
Decoder/native/encoding buffers and buffered download fallback can coexist; this
is not a whole-application peak-memory guarantee. ZIP uses stored, streamed entries
with an exact byte length and a separate output limit. Cancel/source-read failure
fails the export, never silently omits bytes. Download completion is dispatch/EOF,
not proven disk storage. No object URLs are created here. This is a versioned
investigation handoff, not a ZIP import format.
`;

type ArchiveEntry = { name: string, blob: Blob };
type FileInventory = { path: string, status: 'included', bytes: number } | { path: string, status: 'omitted', reason: string };

function jsonBlob({ value }: { value: unknown }): Blob {
  return new Blob([JSON.stringify(value)], { type: 'application/json' });
}

function projectSettings({ settings }: { settings: SpeechInvestigationSettings }): SpeechInvestigationSettings {
  const { language, seed, maxSeconds, inputPacing, device, threads, warmup, ...unhandled } = settings;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<SpeechInvestigationSettings>()({ language, seed, maxSeconds, inputPacing, device, threads, warmup });
}

function projectModel({ model }: { model: SpeechInvestigationOperation['model'] }) {
  const { id, name, bytes, source, info, ...unhandled } = model;
  unhandled satisfies Record<PropertyKey, never>;
  return { id, name, bytes, source, info };
}

function projectSource({ source }: { source: SpeechInvestigationOperation['source'] }) {
  switch (source.kind) {
  case 'unset': {
    const { kind, reason, ...unhandled } = source;
unhandled satisfies Record<PropertyKey, never>;
return { kind, reason };
  }
  case 'file': case 'recording': {
    const { kind, name, bytes, mediaType, captureRequested, captureActual, ...unhandled } = source;
    unhandled satisfies Record<PropertyKey, never>;
    return { kind, name, bytes, mediaType, captureRequested, captureActual };
  }
  default: {
    const exhaustive: never = source;
    throw new Error(String(exhaustive));
  }
  }
}

function projectInputLevel({ inputLevel }: { inputLevel: SpeechInvestigationTrialPlan['inputLevel'] }): SpeechInvestigationTrialPlan['inputLevel'] {
  switch (inputLevel.status) {
  case 'observed': {
    const { kind } = inputLevel.value;
    switch (kind) {
    case 'gain': return { status: 'observed', source: inputLevel.source, value: { kind, gain: inputLevel.value.gain } };
    case 'peak': return { status: 'observed', source: inputLevel.source, value: { kind, targetPeak: inputLevel.value.targetPeak } };
    default: {
      const exhaustive: never = kind;
      throw new Error(String(exhaustive));
    }
    }
  }
  case 'unset': case 'unknown': case 'unavailable': case 'not_applicable': return { status: inputLevel.status, reason: inputLevel.reason };
  default: {
    const exhaustive: never = inputLevel;
    throw new Error(String(exhaustive));
  }
  }
}

function projectPlan({ plan }: { plan: SpeechInvestigationPlan }) {
  const { task, model, source, requested, tailSeconds, privateInputs, trials, ...unhandled } = plan;
  unhandled satisfies Record<PropertyKey, never>;
  const { persona, instructions, name, ...unhandledPrivate } = privateInputs;
  unhandledPrivate satisfies Record<PropertyKey, never>;
  return {
    task,
    model: projectModel({ model }),
    source: projectSource({ source }),
    requested: projectSettings({ settings: requested }),
    tailSeconds,
    privateInputs: { persona, instructions, name },
    trials: trials.map(({ id, inputLevel, ...unhandledTrial }) => {
 unhandledTrial satisfies Record<PropertyKey, never>;
 return { id, inputLevel: projectInputLevel({ inputLevel }) };
    }),
  };
}

function audioMetadata({ audio }: { audio: SpeechInvestigationAudio }) {
  switch (audio.status) {
  case 'retained': {
    const { status, blob, format, description, ...unhandled } = audio;
unhandled satisfies Record<PropertyKey, never>;
return { status, bytes: blob.size, format, description };
  }
  case 'unavailable': case 'not_applicable': return { status: audio.status, reason: audio.reason };
  default: {
    const exhaustive: never = audio;
    throw new Error(String(exhaustive));
  }
  }
}

function safeIdentifier({ id }: { id: string }): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function archiveEntries({ collection, options }: { collection: SpeechInvestigationCollectionSnapshot, options: SpeechInvestigationExportOptions }): ArchiveEntry[] {
  const { id, createdAt, capturedAt, status, plan, load, sourceAudio, trials, capture, ...unhandled } = collection;
  unhandled satisfies Record<PropertyKey, never>;
  if (trials.length > speechInvestigationCollectionLimits.trials || capture.metadataBytes > speechInvestigationCollectionLimits.metadataBytes || capture.audioBytes > speechInvestigationCollectionLimits.audioBytes) {
    throw new Error('Speech investigation collection exceeds its metadata/audio limits');
  }
  const entries: ArchiveEntry[] = [{ name: 'README.md', blob: new Blob([readme], { type: 'text/markdown' }) }, { name: 'plan.json', blob: jsonBlob({ value: projectPlan({ plan }) }) }];
  const files: FileInventory[] = [];
  let audioBytes = 0;
  function addAudio({ path, audio, selected }: { path: string, audio: SpeechInvestigationAudio, selected: 'on' | 'off' }): void {
    switch (selected) {
    case 'off': files.push({ path, status: 'omitted', reason: 'Input audio was not selected at export' });
      return;
    case 'on': break;
    default: {
      const exhaustive: never = selected;
      throw new Error(String(exhaustive));
    }
    }
    switch (audio.status) {
    case 'unavailable': case 'not_applicable': files.push({ path, status: 'omitted', reason: audio.reason });
      return;
    case 'retained':
      audioBytes += audio.blob.size;
      if (audioBytes > speechInvestigationCollectionLimits.audioBytes) {
        throw new Error('Speech investigation audio exceeds its byte limit');
      }
      entries.push({ name: path, blob: audio.blob });
      return;
    default: {
      const exhaustive: never = audio;
      throw new Error(String(exhaustive));
    }
    }
  }
  const sourceExtension = (() => {
    switch (sourceAudio.status) {
    case 'retained': return sourceAudio.format;
    case 'unavailable': case 'not_applicable': return 'bin';
    default: {
      const exhaustive: never = sourceAudio;
      throw new Error(String(exhaustive));
    }
    }
  })();
  addAudio({ path: `source/audio.${sourceExtension}`, audio: sourceAudio, selected: options.includeInputAudio });
  function addRecord({ snapshot, prefix }: { snapshot: SpeechInvestigationSnapshot, prefix: string }) {
    const { id: runId, startedAt, capturedAt, finishedAt, status, elapsedMilliseconds, environment, operation, events, audio, capture, ...unhandledSnapshot } = snapshot;
    unhandledSnapshot satisfies Record<PropertyKey, never>;
    if (events.length > speechInvestigationLimits.events || capture.metadataBytes > speechInvestigationLimits.metadataBytes || capture.eventBytes > speechInvestigationLimits.eventBytes) {
      throw new Error('Speech investigation snapshot exceeds its metadata/event limits');
    }
    const { task, model, source, requested, effective, processing, result, measurements, failure, privateInputs, ...unhandledOperation } = operation;
    unhandledOperation satisfies Record<PropertyKey, never>;
    const { persona, instructions, name, ...unhandledPrivate } = privateInputs;
    unhandledPrivate satisfies Record<PropertyKey, never>;
    entries.push({ name: prefix + 'environment.json', blob: jsonBlob({ value: environment }) }, { name: prefix + 'operation.json', blob: jsonBlob({ value: { task, model: projectModel({ model }), source: projectSource({ source }), requested: projectSettings({ settings: requested }), effective: projectSettings({ settings: effective }), processing, result, measurements, failure, privateInputs: { persona: persona === undefined ? 'unset' : 'set', instructions: instructions === undefined ? 'unset' : 'set', name: name === undefined ? 'unset' : 'set' } } }) }, { name: prefix + 'events.jsonl', blob: new Blob(events.map(event => `${JSON.stringify(event)}\n`), { type: 'application/x-ndjson' }) });
    switch (options.includeInputText) {
    case 'on': entries.push({ name: prefix + 'input.json', blob: jsonBlob({ value: { persona, instructions, name } }) });
      break;
    case 'off': files.push({ path: prefix + 'input.json', status: 'omitted', reason: 'Persona/instruction/name bodies were not selected at export' });
      break;
    default: {
      const exhaustive: never = options.includeInputText;
      throw new Error(String(exhaustive));
    }
    }
    for (const role of ['input', 'output'] as const) {
      switch (role) {
      case 'output': addAudio({ path: prefix + 'audio/output.wav', audio: audio.output, selected: 'on' });
        break;
      case 'input': addAudio({ path: prefix + 'audio/input.wav', audio: audio.input, selected: options.includeInputAudio });
        break;
      default: {
        const exhaustive: never = role;
        throw new Error(String(exhaustive));
      }
      }
    }
    return { runId, startedAt, capturedAt, finishedAt, status, elapsedMilliseconds, capture, audio: { source: audioMetadata({ audio: audio.source }), input: audioMetadata({ audio: audio.input }), output: audioMetadata({ audio: audio.output }) } };
  }
  const modelLoad = load === undefined ? { status: 'unavailable', reason: 'No model-load snapshot was captured for this collection' } : { ...addRecord({ snapshot: load, prefix: 'load/' }), prefix: 'load/' };
  const trialManifest = trials.map(trial => {
    const prefix = `trials/${String(trial.index).padStart(3, '0')}-${safeIdentifier({ id: trial.id })}/`;
    switch (trial.status) {
    case 'not_run': files.push({ path: prefix, status: 'omitted', reason: trial.reason });
      return { id: trial.id, index: trial.index, status: trial.status, reason: trial.reason, prefix };
    case 'in_progress': case 'completed': case 'partial': case 'cancelled': case 'failed':
      if (trial.snapshot === undefined) {
        files.push({ path: prefix, status: 'omitted', reason: trial.capture.reason ?? 'No snapshot was captured' });
      }
      return { id: trial.id, index: trial.index, status: trial.status, capture: trial.capture, prefix, record: trial.snapshot === undefined ? undefined : addRecord({ snapshot: trial.snapshot, prefix }) };
    default: {
      const exhaustive: never = trial;
      throw new Error(String(exhaustive));
    }
    }
  });
  files.push(...entries.map(entry => ({ path: entry.name, status: 'included' as const, bytes: entry.blob.size })));
  entries.splice(1, 0, { name: 'manifest.json', blob: jsonBlob({ value: { format: 'naidan_speech_investigation', version: 2, collection: { id, createdAt, capturedAt, status }, selection: options, limits: { collection: speechInvestigationCollectionLimits, recorder: speechInvestigationLimits }, capture, sourceAudio: audioMetadata({ audio: sourceAudio }), load: modelLoad, trials: trialManifest, files, manifest: { path: 'manifest.json', status: 'included', sizeSource: 'ZIP central directory' }, unobserved: ['GPU kernel timing', 'Peak VRAM', 'OS/browser cache hits', 'Model payload hash', 'Executed transformed JS/helper byte hashes'] } }) });
  const metadataBytes = entries.filter(entry => !entry.name.includes('/audio/') && !entry.name.startsWith('source/')).reduce((sum, entry) => sum + entry.blob.size, 0);
  if (metadataBytes > speechInvestigationCollectionLimits.metadataBytes) {
    throw new Error('Speech investigation serialized metadata exceeds its byte limit');
  }
  return entries;
}

/** Streams an immutable v2 collection; never fetches object URLs. */
export function createSpeechInvestigationArchive({ collection, includeInputAudio, includeInputText, signal }: { collection: SpeechInvestigationCollectionSnapshot, includeInputAudio: SpeechInvestigationExportOptions['includeInputAudio'], includeInputText: SpeechInvestigationExportOptions['includeInputText'], signal: AbortSignal }): { stream: ReadableStream<Uint8Array>, size: number, filename: string } {
  signal.throwIfAborted();
  const entries = archiveEntries({ collection, options: { includeInputAudio, includeInputText } });
  // Stored entries: local header 30, descriptor 16, central header 46, end 22.
  const size = 22 + entries.reduce((sum, entry) => sum + entry.blob.size + 92 + 2 * new TextEncoder().encode(entry.name).length, 0);
  if (!Number.isSafeInteger(size) || size > speechInvestigationCollectionLimits.zipBytes) {
    throw new Error('Speech investigation ZIP exceeds its byte limit');
  }
  const lifetime = new AbortController();
  const combined = AbortSignal.any([signal, lifetime.signal]);
  const output = createReadableZipOutput({ highWaterMarkBytes: 256 * 1024 });
  const directory = createMemoryZipCentralDirectoryStore();
  let written = 0;
  const writer = new StreamingZipWriter({
    output: {
      async write({ chunk }) {
        combined.throwIfAborted();
        written += chunk.byteLength;
        if (written > size) {
          throw new Error('Speech investigation ZIP stream exceeded its declared byte length');
        }
        await output.sink.write({ chunk });
      },
    },
    centralDirectoryStore: directory,
    compressionCodec: createWebZipCompressionCodec(),
  });
  const stream = createAbortableByteStream({ stream: output.stream, signal: combined, onCancel: () => lifetime.abort(new DOMException('Speech investigation export cancelled', 'AbortError')) });
  void (async () => {
    try {
      for (const entry of entries) {
        combined.throwIfAborted();
        await writer.addFile({ name: entry.name, modifiedAt: new Date(collection.capturedAt), compression: 'store', stream: createAbortableByteStream({ stream: entry.blob.stream(), signal: combined, onCancel: undefined }) });
      }
      await writer.finalize();
      if (written !== size) {
        throw new Error('Speech investigation ZIP stream did not match its declared byte length');
      }
      await output.close();
    } catch (error) {
      lifetime.abort(error);
      await output.abort({ reason: error }).catch(() => undefined);
    } finally {
      await directory.dispose();
    }
  })();
  // Never use an input/model name or caller-supplied path as a download filename.
  const safeId = collection.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return exactObject<{ stream: ReadableStream<Uint8Array>, size: number, filename: string }>()({ stream, size, filename: `naidan-speech-investigation-${safeId}.zip` });
}

export async function downloadSpeechInvestigation({ collection, includeInputAudio, includeInputText, signal }: { collection: SpeechInvestigationCollectionSnapshot, includeInputAudio: SpeechInvestigationExportOptions['includeInputAudio'], includeInputText: SpeechInvestigationExportOptions['includeInputText'], signal: AbortSignal }): Promise<void> {
  const { downloadReadableStream } = await import('@/utils/stream-download');
  const archive = createSpeechInvestigationArchive({ collection, includeInputAudio, includeInputText, signal });
  await downloadReadableStream({ ...archive, signal });
}

export const TEST_ONLY = {
};
