import { SpeechRuntimeError, speechFailure, speechFrameSamples, speechSampleRate, type SpeechFailure, type SpeechFrame, type SpeechStartOptions } from '@/features/speech-cpp-browser/types';
import type { SpeechClient } from '@/features/speech-cpp-browser/worker/types';
import { createLiveAudioMeter, liveAudioSecondsLimit, type decodeLiveAudioFile, type LiveAudioStatistics } from './audio-file';
import { createLiveAudioRetention, type LiveAudioClip } from './audio-retention';
import { nanoid } from 'nanoid';

export type SpeechInputPacing = 'fast' | 'real_time';
export type SpeechReplayTiming = {
  dialogueReadyMilliseconds: number | undefined,
  producerDurationMilliseconds: number | undefined,
  drainDurationMilliseconds: number | undefined,
  maxScheduleLatenessMilliseconds: number,
  maxOutputLatenessMilliseconds: number | undefined,
  maxQueuedSamples: number,
  catchUpFrames: number,
  interruption: 'user_cancel' | 'user_finish' | 'page_hidden' | 'backpressure' | 'native_completed' | undefined,
};
export type SpeechFileRunState = {
  id: string,
  status: 'decoding' | 'running' | 'complete' | 'partial' | 'failed',
  inputPacing: SpeechInputPacing,
  stage: 'preparing_input' | 'starting_dialogue' | 'feeding_input' | 'draining_input' | 'saving_output' | 'finished',
  plannedInputSamples: number,
  replayTiming: SpeechReplayTiming | undefined,
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

/** Explicit file runs retain accepted input PCM and received output PCM.
 * Accepted input may still be queued when cancelled. These runs do not open
 * a microphone or feed a realtime playback queue. */
export function createSpeechFileRun({ client, file, options, tailSeconds, inputPacing, decodeFile, onChange }: {
  client: SpeechClient, file: File, options: SpeechStartOptions & { seed: number }, tailSeconds: number,
  inputPacing: SpeechInputPacing,
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
    inputPacing,
    stage: 'preparing_input',
    plannedInputSamples: 0,
    replayTiming: (() => {
      switch (inputPacing) {
      case 'fast': return undefined;
      case 'real_time': return { dialogueReadyMilliseconds: undefined, producerDurationMilliseconds: undefined, drainDurationMilliseconds: undefined, maxScheduleLatenessMilliseconds: 0, maxOutputLatenessMilliseconds: undefined, maxQueuedSamples: 0, catchUpFrames: 0, interruption: undefined };
      default: {
        const exhaustive: never = inputPacing;
        throw new Error(String(exhaustive));
      }
      }
    })(),
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
  let started = false, cleared = false, settled = false;
  let requestedStop: 'finish' | 'cancel' | undefined;
  let stoppedAs: 'finish' | 'cancel' | undefined;
  let shutdown: Promise<void> | undefined;
  let task: Promise<void> | undefined;
  let generationBegan: number | undefined;
  let inputEpoch: number | undefined, producerEnded: number | undefined, drainBegan: number | undefined, previousOffer: number | undefined;
  let visibilityDocument: Document | undefined;
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
  function producerStopped(): void {
    if (state.replayTiming !== undefined) {
      const now = performance.now();
      if (inputEpoch !== undefined && producerEnded === undefined) {
        producerEnded = now;
        state = { ...state, replayTiming: { ...state.replayTiming, producerDurationMilliseconds: now - inputEpoch } };
      }
      if (started && drainBegan === undefined) {
        drainBegan = now;
      }
    }
  }
  function requestStop({ mode, reason }: { mode: 'finish' | 'cancel', reason: SpeechReplayTiming['interruption'] }): void {
    switch (requestedStop) {
    case 'cancel': break;
    case 'finish': case undefined:
      requestedStop = mode;
      if (state.replayTiming !== undefined && reason !== undefined) {
        state = { ...state, replayTiming: { ...state.replayTiming, interruption: reason } };
      }
      break;
    default: {
      const exhaustive: never = requestedStop;
      throw new Error(String(exhaustive));
    }
    }
    producerStopped();
    lifetime.abort();
    wake();
  }
  function visibilityChanged(): void {
    const visibility = visibilityDocument?.visibilityState;
    switch (visibility) {
    case 'hidden':
      requestStop({ mode: 'cancel', reason: 'page_hidden' });
      void stopNative({ mode: 'cancel' }).catch(() => {});
      break;
    case 'visible': case undefined: break;
    default: {
      const exhaustive: never = visibility;
      throw new Error(String(exhaustive));
    }
    }
  }
  async function waitForDeadline({ deadline }: { deadline: number }): Promise<boolean> {
    if (requestedStop !== undefined || cleared) {
      return false;
    }
    return new Promise(resolve => {
      function complete(): void {
        clearTimeout(timer);
        lifetime.signal.removeEventListener('abort', complete);
        resolve(requestedStop === undefined && !cleared);
      }
      // Even overdue frames yield a task so catch-up cannot starve RPC replies.
      const timer = setTimeout(complete, Math.max(0, Math.ceil(deadline - performance.now())));
      lifetime.signal.addEventListener('abort', complete, { once: true });
      if (lifetime.signal.aborted) {
        complete();
      }
    });
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
      if (inputPacing === 'real_time' && typeof document !== 'undefined') {
        visibilityDocument = document;
        visibilityDocument.addEventListener('visibilitychange', visibilityChanged);
        visibilityChanged();
      }
      if (requestedStop !== undefined) {
        state = { ...state, status: 'partial' };
        return;
      }
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
      state = { ...state, sourceSamples: pcm.length, paddingSamples: sourceFrames * speechFrameSamples - pcm.length, effectiveTailSeconds: tailFrames * speechFrameSamples / speechSampleRate, plannedInputSamples: (sourceFrames + tailFrames) * speechFrameSamples, status: 'running', stage: 'starting_dialogue', inputPreparationMilliseconds: performance.now() - inputBegan };
      publish();
      started = true;
      generationBegan = performance.now();
      await client.start({ options });
      checkRuntime();
      if (state.replayTiming !== undefined && client.getState().phase === 'running') {
        inputEpoch = performance.now();
        state = { ...state, replayTiming: { ...state.replayTiming, dialogueReadyMilliseconds: inputEpoch - generationBegan } };
      }
      state = { ...state, stage: 'feeding_input' };
      publish();
      inputLoop: for (let index = 0; index < sourceFrames + tailFrames && !requestedStop; index++) {
        let deadline: number | undefined;
        switch (inputPacing) {
        case 'fast': await drained();
          break;
        case 'real_time': {
          if (inputEpoch === undefined) {
            break;
          }
          deadline = inputEpoch + (index + 1) * speechFrameSamples / speechSampleRate * 1000;
          if (!await waitForDeadline({ deadline })) {
            break;
          }
          break;
        }
        default: {
          const exhaustive: never = inputPacing;
          throw new Error(String(exhaustive));
        }
        }
        checkRuntime();
        if (requestedStop || client.getState().phase === 'completed') {
          if (requestedStop === undefined && state.replayTiming !== undefined) {
            requestStop({ mode: 'cancel', reason: 'native_completed' });
          }
          break;
        }
        const samples = new Float32Array(speechFrameSamples);
        const offset = index * speechFrameSamples;
        if (offset < pcm.length) {
          samples.set(pcm.subarray(offset, offset + speechFrameSamples));
        }
        if (deadline !== undefined && state.replayTiming !== undefined) {
          const offered = performance.now();
          const timing = state.replayTiming;
          state = { ...state, replayTiming: { ...timing, maxScheduleLatenessMilliseconds: Math.max(timing.maxScheduleLatenessMilliseconds, offered - deadline), catchUpFrames: timing.catchUpFrames + (previousOffer !== undefined && deadline <= previousOffer ? 1 : 0) } };
          previousOffer = offered;
        }
        const accepted = client.push({ samples, sampleRate: speechSampleRate });
        switch (accepted.kind) {
        case 'accepted': break;
        case 'backpressure':
          if (state.replayTiming !== undefined) {
            requestStop({ mode: 'cancel', reason: 'backpressure' });
            break inputLoop;
          }
          throw new Error('Speech file input exceeded its bounded queue');
        case 'not_running':
          checkRuntime();
          if (state.replayTiming !== undefined && client.getState().phase === 'completed') {
            requestStop({ mode: 'cancel', reason: 'native_completed' });
            break inputLoop;
          }
          throw new Error('Speech file session stopped before accepting its input');
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
      producerStopped();
      state = { ...state, stage: 'draining_input' };
      publish();
      switch (inputPacing) {
      case 'fast': await drained();
        break;
      case 'real_time': break;
      default: {
        const exhaustive: never = inputPacing;
        throw new Error(String(exhaustive));
      }
      }
      await stopNative({ mode: requestedStop ?? 'finish' });
      checkRuntime();
      if (state.failure) {
        throw new SpeechRuntimeError({ details: state.failure });
      }
      state = { ...state, status: requestedStop === undefined && state.submittedSamples === (sourceFrames + tailFrames) * speechFrameSamples ? 'complete' : 'partial' };
    } catch (error) {
      producerStopped();
      const failure = state.failure ?? client.getState().failure;
      if (failure !== undefined || requestedStop === undefined) {
        state = { ...state, status: 'failed', failure: failure ?? speechFailure({ error }) };
      } else {
        state = { ...state, status: 'partial' };
      }
      try {
        await stopNative({ mode: state.failure === undefined && requestedStop === 'finish' ? 'finish' : 'cancel' });
      } catch (stopError) {
        state = { ...state, status: 'failed', failure: state.failure ?? client.getState().failure ?? speechFailure({ error: stopError }) };
      }
    } finally {
      visibilityDocument?.removeEventListener('visibilitychange', visibilityChanged);
      const lateFailure = client.getState().failure;
      if (lateFailure !== undefined) {
        state = { ...state, status: 'failed', failure: state.failure ?? lateFailure };
      }
      if (generationBegan !== undefined) {
        // End the native-session interval before WAV encoding and URL creation.
        state = { ...state, generationMilliseconds: performance.now() - generationBegan };
      }
      if (state.replayTiming !== undefined && drainBegan !== undefined) {
        state = { ...state, replayTiming: { ...state.replayTiming, drainDurationMilliseconds: performance.now() - drainBegan } };
      }
      lifetime.abort();
      wake();
      settled = true;
      if (!cleared) {
        state = { ...state, stage: 'saving_output' };
        publish();
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
        state = { ...state, stage: 'finished' };
        publish();
      }
    }
  }
  return {
    getState: () => state,
    onState(): void {
      if (state.replayTiming !== undefined) {
        state = { ...state, replayTiming: { ...state.replayTiming, maxQueuedSamples: Math.max(state.replayTiming.maxQueuedSamples, client.getState().queuedSamples) } };
      }
      wake();
    },
    onFrame({ frame }: { frame: SpeechFrame }): void {
      if (cleared || state.status !== 'running' || !started) {
        return;
      }
      const received = performance.now();
      if (state.replayTiming !== undefined && inputEpoch !== undefined && frame.sequence > 0) {
        state = { ...state, replayTiming: { ...state.replayTiming, maxOutputLatenessMilliseconds: Math.max(state.replayTiming.maxOutputLatenessMilliseconds ?? 0, received - inputEpoch - frame.sequence * speechFrameSamples / speechSampleRate * 1000) } };
      }
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
        requestStop({ mode: 'cancel', reason: undefined });
        void stopNative({ mode: 'cancel' }).catch(() => {});
      }
    },
    run(): Promise<void> {
      task ??= execute();
      return task;
    },
    async stop({ mode }: { mode: 'finish' | 'cancel' }): Promise<void> {
      if (settled) {
        await task;
        return;
      }
      switch (mode) {
      case 'finish': requestStop({ mode, reason: 'user_finish' });
        break;
      case 'cancel': requestStop({ mode, reason: 'user_cancel' });
        break;
      default: {
        const exhaustive: never = mode;
        throw new Error(String(exhaustive));
      }
      }
      try {
        await stopNative({ mode });
      } finally {
        await task;
      }
    },
    clear(): void {
      cleared = true;
      if (!settled) {
        requestStop({ mode: 'cancel', reason: 'user_cancel' });
        void stopNative({ mode: 'cancel' }).catch(() => {});
      } else {
        lifetime.abort();
      }
      retained.clear();
      wake();
    },
  };
}

export const TEST_ONLY = {
};
