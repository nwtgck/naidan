import { SpeechRuntimeError, speechFailure, speechError, type SpeechFailure } from '@/features/speech-cpp-browser/types';
import type { SpeechRecognitionRun } from '@/features/speech-cpp-browser/recognition/controller';

export const transcriptionRegionSeconds = 14;
export const transcriptionPendingSeconds = 45;
export const transcriptionBufferSeconds = 60;
const minimumPauseBoundarySeconds = 4;
const speechPauseSeconds = 0.5;
// Keep headroom between one region and the pending-audio stop threshold.
export const minimumMicrophoneSegmentSeconds = minimumPauseBoundarySeconds;
export const maximumMicrophoneSegmentSeconds = 30;
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
  microphoneLevel: number,
  failure: SpeechFailure | undefined,
  stopReason: TranscriptionStopReason | undefined,
};

export function initialContinuousAudioTranscriptionState(): ContinuousAudioTranscriptionState {
  return { confirmedText: '', provisionalText: '', confirmedRevision: 0, pendingRegionCount: 0, bufferedSeconds: 0, recordedSeconds: 0, microphoneLevel: 0, failure: undefined, stopReason: undefined };
}

export function microphoneSegmentSeconds({ stored }: { stored: number | undefined }): number {
  return stored !== undefined && Number.isInteger(stored) && stored >= minimumMicrophoneSegmentSeconds && stored <= maximumMicrophoneSegmentSeconds ? stored : transcriptionRegionSeconds;
}

/** The recognizer is one-shot. Keep the current region provisional until a
 * speech pause, a memory-bounding time limit, or the end of input. */
export function createContinuousAudioTranscription({ sampleRate, language, maxRegionSeconds, initial, recognize, onChange, onStopRequested }: {
  sampleRate: number,
  language: string | undefined,
  maxRegionSeconds: number,
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
  const regionSamples = sampleRate * microphoneSegmentSeconds({ stored: maxRegionSeconds });
  const frameSamples = Math.round(sampleRate * 0.02);
  let state: ContinuousAudioTranscriptionState = { ...initialContinuousAudioTranscriptionState(), ...initial };
  let bufferedSamples = 0, addedSamples = 0;
  let transcriptGeneration = 0;
  let frameLength = 0, framePower = 0, speechPeak = 0, silentSamples = 0;
  let meterFrames = 0, meterPeak = 0, microphoneLevel = 0;
  let heardSpeech = false;
  let accepting = true, disposed = false, finishingRequested = false;
  let pumping: Promise<void> | undefined;

  function publish(): void {
    if (disposed) {
      return;
    }
    state = { ...state, provisionalText: regions.map(region => region.text).filter(Boolean).join('\n'), pendingRegionCount: regions.filter(region => region.closed).length, bufferedSeconds: bufferedSamples / sampleRate, recordedSeconds: initial.recordedSeconds + addedSamples / sampleRate, microphoneLevel };
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
      const generation = transcriptGeneration;
      try {
        // Only this disposable snapshot transfers. Master PCM stays available
        // until its final recognition succeeds, including during stop/flush.
        const result = await recognize({ samples: snapshot, sampleRate, language });
        if (disposed) {
          return;
        }
        if (generation !== transcriptGeneration) {
          continue;
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
        if (generation !== transcriptGeneration) {
          continue;
        }
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
  function measureFrame({ pcm, offset, length }: { pcm: Float32Array, offset: number, length: number }): void {
    for (let i = offset; i < offset + length; i++) {
      const sample = pcm[i] ?? 0;
      framePower += sample * sample;
    }
    frameLength += length;
    if (frameLength !== frameSamples) {
      return;
    }
    const level = Math.sqrt(framePower / frameLength);
    meterPeak = Math.max(meterPeak, level);
    if (++meterFrames === 4) {
      // Reuse the pause detector's 20 ms RMS frames without rescanning PCM.
      microphoneLevel = meterPeak;
      meterFrames = 0;
      meterPeak = 0;
    }
    speechPeak = Math.max(level, speechPeak * 0.996);
    if (level >= Math.max(0.002, speechPeak * 0.12)) {
      heardSpeech = true;
      silentSamples = 0;
    } else {
      silentSamples += frameLength;
    }
    frameLength = 0;
    framePower = 0;
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
      let chunkStart = 0;
      for (let offset = 0; offset < pcm.length;) {
        let region = current();
        if (region === undefined) {
          region = { chunks: [], samples: 0, closed: false, text: '', recognizedSamples: 0, complete: false };
          regions.push(region);
        }
        const length = Math.min(pcm.length - offset, regionSamples - region.samples, frameSamples - frameLength);
        measureFrame({ pcm, offset, length });
        region.samples += length;
        bufferedSamples += length;
        addedSamples += length;
        offset += length;
        if (region.samples === regionSamples || heardSpeech && region.samples >= sampleRate * minimumPauseBoundarySeconds && silentSamples >= sampleRate * speechPauseSeconds) {
          region.closed = true;
          heardSpeech = false;
          silentSamples = 0;
        }
        if (region.closed || offset === pcm.length) {
          region.chunks.push(new Float32Array(pcm.subarray(chunkStart, offset)));
          chunkStart = offset;
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
    clearText(): void {
      transcriptGeneration++;
      regions.splice(0);
      bufferedSamples = 0;
      heardSpeech = false;
      silentSamples = 0;
      frameLength = 0;
      framePower = 0;
      state = { ...state, confirmedText: '', confirmedRevision: 0 };
      publish();
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
