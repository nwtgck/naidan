import { SpeechRuntimeError, speechFailure, speechError, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';

export const transcriptionRegionSeconds = 8;
export const transcriptionPendingSeconds = 45;
export const transcriptionBufferSeconds = 60;
const maximumTextLength = 500_000;
const maximumRegions = 2048;

export type TranscriptionStopReason = 'backpressure' | 'buffer_limit' | 'text_limit';
export type ContinuousAudioTranscriptionState = {
  confirmedText: string,
  provisionalText: string,
  confirmedRevision: number,
  pendingRegionCount: number,
  bufferedSeconds: number,
  recordedSeconds: number,
  failure: SpeechFailure | undefined,
  stopReason: TranscriptionStopReason | undefined,
};

export function initialContinuousAudioTranscriptionState(): ContinuousAudioTranscriptionState {
  return { confirmedText: '', provisionalText: '', confirmedRevision: 0, pendingRegionCount: 0, bufferedSeconds: 0, recordedSeconds: 0, failure: undefined, stopReason: undefined };
}

/** The public recognizer is one-shot. Re-recognize only the current bounded
 * region, then commit each non-overlapping region once. Fixed boundaries can
 * split words; this is not a streaming encoder or a speech detector. */
export function createContinuousAudioTranscription({ sampleRate, language, initial, recognize, onChange, onStopRequested }: {
  sampleRate: number,
  language: string | undefined,
  initial: Pick<ContinuousAudioTranscriptionState, 'confirmedText' | 'confirmedRevision' | 'recordedSeconds'>,
  recognize: ({ samples, sampleRate, language }: { samples: Float32Array<ArrayBuffer>, sampleRate: number, language: string | undefined }) => Promise<Pick<SpeechRecognitionRun, 'text' | 'status' | 'failure'> | undefined>,
  onChange: ({ state }: { state: ContinuousAudioTranscriptionState }) => void,
  onStopRequested: ({ reason }: { reason: TranscriptionStopReason }) => void,
}) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
    throw speechError({ code: 'invalid_audio', message: 'Invalid transcription sample rate' });
  }
  type Region = { chunks: Float32Array<ArrayBuffer>[], samples: number, closed: boolean, text: string, recognizedSamples: number, complete: boolean };
  const regions: Region[] = [];
  const regionSamples = sampleRate * transcriptionRegionSeconds;
  let state: ContinuousAudioTranscriptionState = { ...initialContinuousAudioTranscriptionState(), ...initial };
  let bufferedSamples = 0, addedSamples = 0;
  let accepting = true, disposed = false, finishingRequested = false;
  let pumping: Promise<void> | undefined;

  function publish(): void {
    if (disposed) {
      return;
    }
    state = { ...state, provisionalText: regions.map(region => region.text).filter(Boolean).join('\n'), pendingRegionCount: regions.filter(region => region.closed).length, bufferedSeconds: bufferedSamples / sampleRate, recordedSeconds: initial.recordedSeconds + addedSamples / sampleRate };
    onChange({ state });
  }
  function requestStop({ reason }: { reason: TranscriptionStopReason }): void {
    if (state.stopReason !== undefined || disposed) {
      return;
    }
    state = { ...state, stopReason: reason };
    // A capture callback must return before finish() asks its worklet to flush.
    void Promise.resolve().then(() => {
      if (!disposed) {
        onStopRequested({ reason });
      }
    });
  }
  function fail({ error }: { error: unknown }): void {
    accepting = false;
    state = { ...state, failure: speechFailure({ error }) };
    publish();
  }
  function current(): Region | undefined {
    const last = regions.at(-1);
    return last?.closed === false ? last : undefined;
  }
  function job(): Region | undefined {
    if (disposed || state.failure !== undefined) {
      return undefined;
    }
    const final = regions.find(region => region.closed);
    if (final !== undefined) {
      return final;
    }
    const region = current();
    if (!accepting || finishingRequested || state.stopReason !== undefined || region === undefined || region.samples < sampleRate || region.samples - region.recognizedSamples < sampleRate * 0.75) {
      return undefined;
    }
    return region;
  }
  function confirm({ region }: { region: Region }): void {
    const text = [state.confirmedText, region.text].filter(Boolean).join('\n');
    if (text.length > maximumTextLength || state.confirmedRevision >= maximumRegions) {
      requestStop({ reason: 'text_limit' });
      fail({ error: speechError({ code: 'queue_full', message: 'Transcription text limit reached; some audio remains unconfirmed' }) });
      return;
    }
    state = { ...state, confirmedText: text, confirmedRevision: state.confirmedRevision + 1 };
    bufferedSamples -= region.samples;
    regions.shift();
    region.chunks = [];
    if (state.confirmedRevision === maximumRegions || text.length === maximumTextLength) {
      requestStop({ reason: 'text_limit' });
    }
    publish();
  }
  async function drain(): Promise<void> {
    let region: Region | undefined;
    while ((region = job()) !== undefined) {
      const length = region.samples;
      if (region.complete && region.recognizedSamples === length) {
        confirm({ region });
        continue;
      }
      const snapshot = new Float32Array(length);
      let offset = 0;
      for (const chunk of region.chunks) {
        snapshot.set(chunk, offset);
        offset += chunk.length;
      }
      try {
        // Only this disposable snapshot transfers. Master PCM stays available
        // until its final recognition succeeds, including during stop/flush.
        const result = await recognize({ samples: snapshot, sampleRate, language });
        if (disposed) {
          return;
        }
        if (result === undefined) {
          throw speechError({ code: 'invalid_state', message: 'The recognition model is no longer ready' });
        }
        region.recognizedSamples = length;
        switch (result.status) {
        case 'complete':
          region.text = result.text.slice(0, maximumTextLength);
          region.complete = true;
          break;
        case 'cancelled': case 'model_limit': case 'max_seconds': case 'failed': case 'preparing': case 'recognizing':
          // A failed request often has no text. Keep its last useful prefix
          // visible when the capture owner releases the unconfirmed audio.
          if (result.text !== '') {
            region.text = result.text.slice(0, maximumTextLength);
          }
          region.complete = false;
          throw result.failure === undefined ? speechError({ code: 'runtime_failed', message: `Recognition ended with ${result.status}; some audio remains unconfirmed` }) : new SpeechRuntimeError({ details: result.failure });
        default: {
          const exhaustive: never = result.status;
          throw new Error(String(exhaustive));
        }
        }
        if (result.text.length > maximumTextLength) {
          requestStop({ reason: 'text_limit' });
          throw speechError({ code: 'queue_full', message: 'Transcription text limit reached; some audio remains unconfirmed' });
        }
        if (region.closed && region.samples === length) {
          confirm({ region });
        } else {
          publish();
        }
      } catch (error) {
        if (!disposed) {
          fail({ error });
        }
        return;
      }
    }
  }
  function pump(): void {
    if (pumping !== undefined || job() === undefined) {
      return;
    }
    pumping = Promise.resolve().then(drain).finally(() => {
      pumping = undefined;
      if (job() !== undefined) {
        pump();
      }
    });
  }
  return {
    getState: () => state,
    prepareFinish(): void {
      finishingRequested = true;
    },
    append({ pcm }: { pcm: Float32Array }): void {
      if (!accepting || disposed || pcm.length === 0) {
        return;
      }
      if (pcm.some(sample => !Number.isFinite(sample) || sample < -1 || sample > 1)) {
        fail({ error: speechError({ code: 'invalid_audio', message: 'Invalid microphone samples' }) });
        return;
      }
      if (bufferedSamples + pcm.length > sampleRate * transcriptionBufferSeconds) {
        requestStop({ reason: 'buffer_limit' });
        fail({ error: speechError({ code: 'queue_full', message: 'The microphone audio buffer limit was reached; some audio was not accepted' }) });
        return;
      }
      for (let offset = 0; offset < pcm.length;) {
        let region = current();
        if (region === undefined) {
          region = { chunks: [], samples: 0, closed: false, text: '', recognizedSamples: 0, complete: false };
          regions.push(region);
        }
        const length = Math.min(pcm.length - offset, regionSamples - region.samples);
        region.chunks.push(new Float32Array(pcm.subarray(offset, offset + length)));
        region.samples += length;
        bufferedSamples += length;
        addedSamples += length;
        offset += length;
        if (region.samples === regionSamples) {
          region.closed = true;
        }
      }
      if (bufferedSamples >= sampleRate * transcriptionPendingSeconds) {
        requestStop({ reason: 'backpressure' });
      }
      publish();
      pump();
    },
    async finish(): Promise<void> {
      accepting = false;
      const region = current();
      if (region !== undefined) {
        region.closed = true;
      }
      publish();
      pump();
      while (pumping !== undefined) {
        await pumping;
      }
    },
    discard(): void {
      disposed = true;
      accepting = false;
      regions.splice(0);
      bufferedSamples = 0;
    },
  };
}

export const TEST_ONLY = {
};
