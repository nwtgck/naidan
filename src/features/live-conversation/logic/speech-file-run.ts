import { SpeechRuntimeError, speechFailure, speechFrameSamples, speechSampleRate, type SpeechFailure, type SpeechFrame, type SpeechStartOptions } from '@/features/speech-cpp-browser/types';
import type { SpeechClient } from '@/features/speech-cpp-browser/worker/types';
import { createLiveAudioMeter, liveAudioSecondsLimit, type decodeLiveAudioFile, type LiveAudioStatistics } from './audio-file';
import { createLiveAudioRetention, type LiveAudioClip } from './audio-retention';
import { nanoid } from 'nanoid';

export type SpeechFileRunState = {
  id: string,
  status: 'decoding' | 'running' | 'complete' | 'partial' | 'failed',
  inputName: string,
  text: string,
  input: LiveAudioClip | undefined,
  output: LiveAudioClip | undefined,
  inputStatistics: LiveAudioStatistics,
  outputStatistics: LiveAudioStatistics,
  sourceSamples: number,
  paddingSamples: number,
  requestedTailSeconds: number,
  effectiveTailSeconds: number,
  submittedSamples: number,
  frames: number,
  firstFrameStatistics: LiveAudioStatistics | undefined,
  firstSequence: number | undefined,
  lastSequence: number | undefined,
  sequenceDiscontinuities: number,
  elapsedMilliseconds: number,
  inputPreparationMilliseconds: number | undefined,
  firstOutputMilliseconds: number | undefined,
  generationMilliseconds: number | undefined,
  maxSeconds: number,
  language: string,
  seed: number,
  failure: SpeechFailure | undefined,
};

/** Explicit file runs retain exactly the PCM sent to and received from the
 * model. They do not open a microphone or feed a realtime playback queue. */
export function createSpeechFileRun({ client, file, options, tailSeconds, decodeFile, onChange }: {
  client: SpeechClient, file: File, options: SpeechStartOptions & { seed: number }, tailSeconds: number,
  decodeFile: typeof decodeLiveAudioFile,
  onChange: ({ state }: { state: SpeechFileRunState }) => void,
}) {
  const lifetime = new AbortController();
  const retained = createLiveAudioRetention({ maximumBytes: 64 * 1024 * 1024 });
  retained.setEnabled({ value: 'on' });
  const inputMeter = createLiveAudioMeter({ sampleRate: speechSampleRate });
  const outputMeter = createLiveAudioMeter({ sampleRate: speechSampleRate });
  const began = performance.now();
  // Include the initial frame and the rounded final silence frame in the bound.
  const maximumOutputSamples = Math.ceil((liveAudioSecondsLimit + 30) * speechSampleRate / speechFrameSamples) * speechFrameSamples + speechFrameSamples * 2;
  let state: SpeechFileRunState = {
    id: nanoid(),
    status: 'decoding',
    inputName: file.name,
    text: '',
    input: undefined,
    output: undefined,
    inputStatistics: inputMeter.read(),
    outputStatistics: outputMeter.read(),
    sourceSamples: 0,
    paddingSamples: 0,
    requestedTailSeconds: tailSeconds,
    effectiveTailSeconds: 0,
    submittedSamples: 0,
    frames: 0,
    firstFrameStatistics: undefined,
    firstSequence: undefined,
    lastSequence: undefined,
    sequenceDiscontinuities: 0,
    elapsedMilliseconds: 0,
    inputPreparationMilliseconds: undefined,
    firstOutputMilliseconds: undefined,
    generationMilliseconds: undefined,
    maxSeconds: options.maxSeconds,
    language: options.language,
    seed: options.seed,
    failure: undefined,
  };
  let started = false, cleared = false;
  let requestedStop: 'finish' | 'cancel' | undefined;
  let stoppedAs: 'finish' | 'cancel' | undefined;
  let shutdown: Promise<void> | undefined;
  let task: Promise<void> | undefined;
  let generationBegan: number | undefined;
  let changed = Promise.withResolvers<void>();
  function wake(): void {
    const previous = changed;
    changed = Promise.withResolvers<void>();
    previous.resolve();
  }
  function publish(): void {
    if (!cleared) {
      state = { ...state, inputStatistics: inputMeter.read(), outputStatistics: outputMeter.read(), elapsedMilliseconds: performance.now() - began };
      onChange({ state });
    }
  }
  function checkRuntime(): void {
    const runtime = client.getState();
    if (runtime.failure) {
      throw new SpeechRuntimeError({ details: runtime.failure });
    }
    if (runtime.model === undefined) {
      throw new Error('Speech model was released during the file run');
    }
  }
  function retain({ key, pcm }: { key: string, pcm: Float32Array }): void {
    const result = retained.append({ key, sampleRate: speechSampleRate, pcm });
    switch (result) {
    case 'kept': return;
    case 'skipped': case 'limit': throw new Error('Speech file audio exceeded its retention limit');
    default: {
      const exhaustive: never = result;
      throw new Error(String(exhaustive));
    }
    }
  }
  async function drained(): Promise<void> {
    while (!requestedStop) {
      checkRuntime();
      const runtime = client.getState();
      if (runtime.queuedSamples === 0 || runtime.phase === 'completed') {
        return;
      }
      await changed.promise;
    }
  }
  function stopNative({ mode }: { mode: 'finish' | 'cancel' }): Promise<void> {
    if (!started) {
      return Promise.resolve();
    }
    if (!shutdown || (mode === 'cancel' && stoppedAs === 'finish')) {
      stoppedAs = mode;
      shutdown = client.stop({ mode });
      void shutdown.catch(() => {});
    }
    return shutdown;
  }
  async function decode(): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const aborted = () => reject(lifetime.signal.reason);
      lifetime.signal.addEventListener('abort', aborted, { once: true });
      if (lifetime.signal.aborted) {
        aborted();
      }
      void decodeFile({ file, sampleRate: speechSampleRate, signal: lifetime.signal }).then(resolve, reject).finally(() => lifetime.signal.removeEventListener('abort', aborted));
    });
  }
  async function execute(): Promise<void> {
    publish();
    const inputBegan = performance.now();
    try {
      if (options.inputSampleRate !== speechSampleRate || !Number.isFinite(tailSeconds) || tailSeconds < 0 || tailSeconds > 30 || !Number.isFinite(options.maxSeconds) || options.maxSeconds <= 0 || options.maxSeconds > 3600) {
        throw new Error('Invalid speech file duration or sample rate');
      }
      if (!Number.isSafeInteger(options.seed) || options.seed < 0) {
        throw new Error('Speech seed must be a safe non-negative integer');
      }
      const pcm = await decode();
      lifetime.signal.throwIfAborted();
      if (!pcm.length || pcm.length > speechSampleRate * liveAudioSecondsLimit) {
        throw new Error('Audio must be non-empty and at most 180 seconds long');
      }
      const sourceFrames = Math.ceil(pcm.length / speechFrameSamples);
      // Haru counts the frame produced by start in max_seconds as well.
      const availableFrames = Math.floor(options.maxSeconds * speechSampleRate / speechFrameSamples + 1e-9) - 1;
      if (sourceFrames > availableFrames) {
        throw new Error('The audio file and initial response frame exceed the session duration; choose a shorter file or a longer session');
      }
      const tailFrames = Math.min(Math.ceil(tailSeconds * speechSampleRate / speechFrameSamples), availableFrames - sourceFrames);
      state = { ...state, sourceSamples: pcm.length, paddingSamples: sourceFrames * speechFrameSamples - pcm.length, effectiveTailSeconds: tailFrames * speechFrameSamples / speechSampleRate, status: 'running', inputPreparationMilliseconds: performance.now() - inputBegan };
      publish();
      started = true;
      generationBegan = performance.now();
      await client.start({ options });
      for (let index = 0; index < sourceFrames + tailFrames && !requestedStop; index++) {
        await drained();
        if (requestedStop || client.getState().phase === 'completed') {
          break;
        }
        const samples = new Float32Array(speechFrameSamples);
        const offset = index * speechFrameSamples;
        if (offset < pcm.length) {
          samples.set(pcm.subarray(offset, offset + speechFrameSamples));
        }
        const accepted = client.push({ samples, sampleRate: speechSampleRate });
        switch (accepted.kind) {
        case 'accepted': break;
        case 'backpressure': throw new Error('Speech file input exceeded its bounded queue');
        case 'not_running': throw new Error('Speech file session stopped before accepting its input');
        default: {
          const exhaustive: never = accepted;
          throw new Error(String(exhaustive));
        }
        }
        inputMeter.append({ pcm: samples });
        retain({ key: 'input', pcm: samples });
        state = { ...state, submittedSamples: state.submittedSamples + samples.length };
        publish();
      }
      await drained();
      await stopNative({ mode: requestedStop ?? 'finish' });
      checkRuntime();
      if (state.failure) {
        throw new SpeechRuntimeError({ details: state.failure });
      }
      state = { ...state, status: requestedStop === undefined && state.submittedSamples === (sourceFrames + tailFrames) * speechFrameSamples ? 'complete' : 'partial' };
    } catch (error) {
      const failure = state.failure ?? client.getState().failure;
      if (failure !== undefined || requestedStop === undefined) {
        state = { ...state, status: 'failed', failure: failure ?? speechFailure({ error }) };
      } else {
        state = { ...state, status: 'partial' };
      }
      try {
        await stopNative({ mode: 'cancel' });
      } catch { /* Preserve the original generation/decode failure. */ }
    } finally {
      if (generationBegan !== undefined) {
        // End the native-session interval before WAV encoding and URL creation.
        state = { ...state, generationMilliseconds: performance.now() - generationBegan };
      }
      lifetime.abort();
      wake();
      if (!cleared) {
        const status = (() => {
          switch (state.status) {
          case 'complete': return 'complete';
          case 'decoding': case 'running': case 'partial': case 'failed': return 'partial';
          default: {
            const exhaustive: never = state.status;
            throw new Error(String(exhaustive));
          }
          }
        })();
        try {
          state = { ...state, input: retained.finish({ key: 'input', status }), output: retained.finish({ key: 'output', status }) };
        } catch (error) {
          retained.clear();
          state = { ...state, status: 'failed', input: undefined, output: undefined, failure: state.failure ?? speechFailure({ error }) };
        }
        publish();
      }
    }
  }
  return {
    getState: () => state,
    onState: wake,
    onFrame({ frame }: { frame: SpeechFrame }): void {
      if (cleared || state.status !== 'running' || !started) {
        return;
      }
      const received = performance.now();
      try {
        if (frame.sampleRate !== speechSampleRate || frame.samples.length !== speechFrameSamples || outputMeter.read().samples + frame.samples.length > maximumOutputSamples) {
          throw new Error('Invalid or oversized speech file output');
        }
        const meter = createLiveAudioMeter({ sampleRate: speechSampleRate });
        meter.append({ pcm: frame.samples });
        outputMeter.append({ pcm: frame.samples });
        retain({ key: 'output', pcm: frame.samples });
        state = {
          ...state,
          text: state.text + frame.text,
          firstOutputMilliseconds: state.firstOutputMilliseconds ?? (generationBegan === undefined ? undefined : received - generationBegan),
          frames: state.frames + 1,
          firstFrameStatistics: state.firstFrameStatistics ?? meter.read(),
          firstSequence: state.firstSequence ?? frame.sequence,
          lastSequence: frame.sequence,
          sequenceDiscontinuities: state.sequenceDiscontinuities + (frame.sequence === (state.lastSequence === undefined ? 0 : state.lastSequence + 1) ? 0 : 1),
        };
        publish();
      } catch (error) {
        state = { ...state, status: 'failed', failure: speechFailure({ error }) };
        publish();
        requestedStop = 'cancel';
        lifetime.abort();
        wake();
        void stopNative({ mode: 'cancel' }).catch(() => {});
      }
    },
    run(): Promise<void> {
      task ??= execute();
      return task;
    },
    async stop({ mode }: { mode: 'finish' | 'cancel' }): Promise<void> {
      switch (requestedStop) {
      case 'cancel': break;
      case 'finish': case undefined: requestedStop = mode;
        break;
      default: {
        const exhaustive: never = requestedStop;
        throw new Error(String(exhaustive));
      }
      }
      lifetime.abort();
      wake();
      try {
        await stopNative({ mode });
      } finally {
        await task;
      }
    },
    clear(): void {
      cleared = true;
      lifetime.abort();
      retained.clear();
      wake();
    },
  };
}

export const TEST_ONLY = {
};
