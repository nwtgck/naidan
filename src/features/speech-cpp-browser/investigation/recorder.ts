import { nanoid } from 'nanoid';
import { exactObject } from '@/utils/exact-object';
import {
  speechInvestigationLimits,
  type SpeechInvestigationAudio,
  type SpeechInvestigationAudioRole,
  type SpeechInvestigationCapture,
  type SpeechInvestigationEnvironment,
  type SpeechInvestigationEvent,
  type SpeechInvestigationOperation,
  type SpeechInvestigationRecordedEvent,
  type SpeechInvestigationSnapshot,
  type SpeechInvestigationStatus,
  type SpeechObservation,
} from './types';

const encoder = new TextEncoder();

function boundedText({ text, bytes }: { text: string, bytes: number }): { text: string, truncatedCodeUnits: number } {
  const destination = new Uint8Array(Math.min(bytes, text.length * 3));
  const { read } = encoder.encodeInto(text, destination);
  return { text: text.slice(0, read), truncatedCodeUnits: text.length - read };
}

function freezeValue({ value }: { value: unknown }): void {
  if (typeof value !== 'object' || value === undefined || value === null || value instanceof Blob || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    freezeValue({ value: child });
  }
}

function cloneOperation({ operation }: { operation: SpeechInvestigationOperation }): { operation: SpeechInvestigationOperation, truncatedCodeUnits: number } {
  const { task, model, source, requested, effective, processing, result, measurements, failure, privateInputs, ...unhandled } = operation;
  unhandled satisfies Record<PropertyKey, never>;
  const { text, languages, completion, input, output, details, ...unhandledResult } = result;
  unhandledResult satisfies Record<PropertyKey, never>;
  const { persona, instructions, name, ...unhandledPrivate } = privateInputs;
  unhandledPrivate satisfies Record<PropertyKey, never>;
  let truncatedCodeUnits = 0;
  function clip({ text, bytes }: { text: string, bytes: number }): string {
    const bounded = boundedText({ text, bytes });
    truncatedCodeUnits += bounded.truncatedCodeUnits;
    return bounded.text;
  }
  return {
    operation: exactObject<SpeechInvestigationOperation>()({
      task,
      model,
      source,
      requested,
      effective,
      processing,
      result: { text: clip({ text, bytes: speechInvestigationLimits.resultTextBytes }), languages, completion, input, output, details },
      measurements,
      failure,
      privateInputs: {
        persona: persona === undefined ? undefined : clip({ text: persona, bytes: speechInvestigationLimits.privateTextBytes }),
        instructions: instructions === undefined ? undefined : clip({ text: instructions, bytes: speechInvestigationLimits.privateTextBytes }),
        name: name === undefined ? undefined : clip({ text: name, bytes: speechInvestigationLimits.privateTextBytes }),
      },
    }),
    truncatedCodeUnits,
  };
}

function cloneEvent({ event }: { event: SpeechInvestigationEvent }): { event: SpeechInvestigationEvent, truncatedCodeUnits: number } {
  switch (event.kind) {
  case 'native_log': {
    const { kind, level, message, ...unhandled } = event;
      unhandled satisfies Record<PropertyKey, never>;
      const bounded = boundedText({ text: message, bytes: speechInvestigationLimits.logTextBytes });
      return { event: { kind, level, message: bounded.text }, truncatedCodeUnits: bounded.truncatedCodeUnits };
  }
  case 'native_log_batch': {
    const { kind, lines, dropped, ...unhandled } = event;
      unhandled satisfies Record<PropertyKey, never>;
      let truncatedCodeUnits = 0;
      const boundedLines = lines.slice(0, speechInvestigationLimits.events).map(({ level, text, ...unhandledLine }) => {
        unhandledLine satisfies Record<PropertyKey, never>;
        const bounded = boundedText({ text, bytes: speechInvestigationLimits.logTextBytes });
        truncatedCodeUnits += bounded.truncatedCodeUnits;
        return { level, text: bounded.text };
      });
      return { event: { kind, lines: boundedLines, dropped: dropped + lines.length - boundedLines.length }, truncatedCodeUnits };
  }
  case 'model_info': {
    const { kind, rawJson, device, threads, weightType, weightBytes, ...unhandled } = event;
      unhandled satisfies Record<PropertyKey, never>;
      const bounded = boundedText({ text: rawJson, bytes: 64 * 1024 });
      return { event: { kind, rawJson: bounded.text, device, threads, weightType, weightBytes }, truncatedCodeUnits: bounded.truncatedCodeUnits };
  }
  case 'stage':
  case 'progress':
  case 'devices':
  case 'read_summary':
  case 'wasm_heap':
  case 'result':
  case 'cancel':
  case 'failure':
    return { event, truncatedCodeUnits: 0 };
  default: {
    const unhandled: never = event;
    throw new Error(`Unhandled investigation event: ${String(unhandled)}`);
  }
  }
}

function retainedAudioBytes({ audio }: { audio: SpeechInvestigationAudio }): number {
  switch (audio.status) {
  case 'retained': return audio.blob.size;
  case 'unavailable':
  case 'not_applicable': return 0;
  default: {
    const unhandled: never = audio;
    throw new Error(`Unhandled investigation audio: ${String(unhandled)}`);
  }
  }
}

function initialOutputAudio({ task }: { task: SpeechInvestigationOperation['task'] }): SpeechInvestigationAudio {
  switch (task) {
  case 'recognition': return { status: 'not_applicable', reason: 'Recognition produces text' };
  case 'dialogue': return { status: 'unavailable', reason: 'Generated WAV was not retained' };
  default: {
    const unhandled: never = task;
    throw new Error(`Unhandled investigation task: ${unhandled}`);
  }
  }
}

export type SpeechInvestigationRun = {
  id: string,
  record({ event }: { event: SpeechInvestigationEvent }): boolean,
  setAudio({ role, audio }: { role: SpeechInvestigationAudioRole, audio: SpeechInvestigationAudio }): boolean,
  checkpoint({ environment, operation }: { environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation }): SpeechInvestigationSnapshot | undefined,
  finish({ status, environment, operation }: { status: SpeechInvestigationStatus, environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation }): boolean,
};

type RunState = {
  id: string, startedAt: string, start: number, lastClock: number,
  environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation,
  events: SpeechInvestigationRecordedEvent[],
  audio: Record<SpeechInvestigationAudioRole, SpeechInvestigationAudio>,
  capture: SpeechInvestigationCapture,
  snapshot: SpeechInvestigationSnapshot | undefined,
  metadataTruncatedCodeUnits: number,
};

/** One retained run. Handles contain only an identity, so replacing/clearing releases its data. */
export function createSpeechInvestigationRecorder({ now, nowIso }: { now: () => number, nowIso: () => string }) {
  let current: RunState | undefined;

  function readClock({ run }: { run: RunState }): SpeechObservation<number> {
    let value: number;
    try {
      value = now();
    } catch {
      value = Number.NaN;
    }
    if (!Number.isFinite(run.start) || !Number.isFinite(value) || value < run.lastClock) {
      run.capture.clockAnomalies += 1;
      return { status: 'unknown', reason: 'Non-finite, exceptional or backward monotonic clock' };
    }
    run.lastClock = value;
    return { status: 'observed', value: value - run.start, source: 'Recorder receipt; host monotonic clock' };
  }

  function metadata({ environment, operation }: { environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation }) {
    const bounded = cloneOperation({ operation });
    const value = { environment, operation: bounded.operation };
    const bytes = encoder.encode(JSON.stringify(value)).byteLength;
    if (bytes > speechInvestigationLimits.metadataBytes) {
      return undefined;
    }
    const clone = structuredClone(value);
    freezeValue({ value: clone });
    return { ...clone, bytes, truncatedCodeUnits: bounded.truncatedCodeUnits };
  }

  function updateMetadata({ run, environment, operation }: { run: RunState, environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation }): void {
    const copied = metadata({ environment, operation });
    if (copied === undefined) {
      run.capture.rejectedMetadataUpdates += 1;
      run.capture.latestMetadata = 'rejected';
      return;
    }
    run.environment = copied.environment;
    run.operation = copied.operation;
    run.capture.metadataBytes = copied.bytes;
    run.capture.latestMetadata = 'accepted';
    run.capture.truncatedCodeUnits += copied.truncatedCodeUnits - run.metadataTruncatedCodeUnits;
    run.metadataTruncatedCodeUnits = copied.truncatedCodeUnits;
  }

  function captureSnapshot({ run, status, capturedAt, finishedAt }: { run: RunState, status: SpeechInvestigationSnapshot['status'], capturedAt: string, finishedAt: string | undefined }): SpeechInvestigationSnapshot {
    const elapsedMilliseconds = readClock({ run });
    const snapshot: SpeechInvestigationSnapshot = {
      id: run.id,
      startedAt: run.startedAt,
      capturedAt,
      finishedAt,
      status,
      elapsedMilliseconds,
      environment: run.environment,
      operation: run.operation,
      events: [...run.events],
      audio: { ...run.audio },
      capture: { ...run.capture },
    };
    freezeValue({ value: snapshot });
    return snapshot;
  }

  return {
    begin({ environment, operation }: { environment: SpeechInvestigationEnvironment, operation: SpeechInvestigationOperation }): SpeechInvestigationRun {
      // Replace first: a rejected new run must not silently leave the old result selected.
      current = undefined;
      const copied = metadata({ environment, operation });
      if (copied === undefined) {
        throw new Error('Speech investigation metadata exceeds its byte limit');
      }
      let start: number;
      try {
        start = now();
      } catch {
        start = Number.NaN;
      }
      const id = nanoid();
      current = {
        id,
        startedAt: nowIso(),
        start,
        lastClock: start,
        environment: copied.environment,
        operation: copied.operation,
        events: [],
        audio: {
          source: { status: 'unavailable', reason: 'Original audio was not retained' },
          input: { status: 'unavailable', reason: 'Submitted PCM was not retained' },
          output: initialOutputAudio({ task: operation.task }),
        },
        capture: { eventBytes: 0, metadataBytes: copied.bytes, audioBytes: 0, droppedEvents: 0, droppedEventBytes: 0, rejectedMetadataUpdates: 0, truncatedCodeUnits: copied.truncatedCodeUnits, clockAnomalies: Number.isFinite(start) ? 0 : 1, latestMetadata: 'accepted' },
        snapshot: undefined,
        metadataTruncatedCodeUnits: copied.truncatedCodeUnits,
      };
      return {
        id,
        record({ event }) {
          const run = current;
          if (run === undefined || run.id !== id || run.snapshot !== undefined) {
            return false;
          }
          const bounded = cloneEvent({ event });
          const record: SpeechInvestigationRecordedEvent = { sequence: run.events.length + run.capture.droppedEvents, atMilliseconds: readClock({ run }), event: bounded.event, truncatedCodeUnits: bounded.truncatedCodeUnits };
          const bytes = encoder.encode(JSON.stringify(record)).byteLength + 1;
          if (run.events.length >= speechInvestigationLimits.events || run.capture.eventBytes + bytes > speechInvestigationLimits.eventBytes) {
            run.capture.droppedEvents += 1;
            run.capture.droppedEventBytes += bytes;
            return false;
          }
          const clone = structuredClone(record);
          freezeValue({ value: clone });
          run.events.push(clone);
          run.capture.eventBytes += bytes;
          run.capture.truncatedCodeUnits += bounded.truncatedCodeUnits;
          return true;
        },
        setAudio({ role, audio }) {
          const run = current;
          if (run === undefined || run.id !== id || run.snapshot !== undefined) {
            return false;
          }
          const previous = run.audio[role];
          const previousBytes = retainedAudioBytes({ audio: previous });
          const nextBytes = retainedAudioBytes({ audio });
          if (nextBytes + run.capture.audioBytes - previousBytes > speechInvestigationLimits.audioBytes) {
            run.audio[role] = { status: 'unavailable', reason: 'Combined retained audio exceeds the investigation byte limit' };
            run.capture.audioBytes -= previousBytes;
            return false;
          }
          run.audio[role] = { ...audio };
          run.capture.audioBytes += nextBytes - previousBytes;
          return true;
        },
        checkpoint({ environment, operation }) {
          const run = current;
          if (run === undefined || run.id !== id || run.snapshot !== undefined) {
            return undefined;
          }
          updateMetadata({ run, environment, operation });
          return captureSnapshot({ run, status: 'in_progress', capturedAt: nowIso(), finishedAt: undefined });
        },
        finish({ status, environment, operation }) {
          const run = current;
          if (run === undefined || run.id !== id || run.snapshot !== undefined) {
            return false;
          }
          updateMetadata({ run, environment, operation });
          const capturedAt = nowIso();
          run.snapshot = captureSnapshot({ run, status, capturedAt, finishedAt: capturedAt });
          return true;
        },
      };
    },
    snapshot(): SpeechInvestigationSnapshot | undefined {
      return current?.snapshot;
    },
    clear(): void {
      current = undefined;
    },
  };
}

export const TEST_ONLY = {
};
