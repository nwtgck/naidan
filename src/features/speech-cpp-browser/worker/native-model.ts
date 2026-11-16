import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';
import { readSpeechPointer, speechCallbackPointer } from './native-memory';
import type { SpeechModelPort, SpeechDialoguePort, SpeechFailure, SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import { SpeechRuntimeError, speechError, speechFailure } from '@/features/speech-cpp-browser/types';
import { inspectSpeechCandidate, createSpeechFileSource } from './model-file';
import { createSpeechReadCoverage } from './load-progress';
import { createNativeSpeechObservation } from './native-observation';
import type { SpeechInvestigationObserver } from '@/features/speech-cpp-browser/investigation/types';

type Helpers = typeof import('speech-cpp-browser-core/speech-cpp/host');

/** Actual generated C API integration. Native pointers remain bigint, callback
 * views expire on return, and every view is reacquired after an awaited call. */
export async function openNativeSpeechModel({ file, signal, core, helpers, readBlob, onProgress, investigation }: {
  file: File, signal: AbortSignal, core: Core, helpers: Helpers,
  readBlob: ({ blob }: { blob: Blob }) => ArrayBuffer,
  onProgress: ({ progress }: { progress: SpeechLoadProgress }) => void,
  investigation?: SpeechInvestigationObserver,
}): Promise<SpeechModelPort> {
  onProgress({ progress: { stage: 'checking_model' } });
  const candidate = await inspectSpeechCandidate({ file, name: file.name, signal });
  switch (candidate.kind) {
  case 'speech': break;
  case 'other': throw speechError({ code: 'invalid_model', message: 'Expected a Haru dialogue model' });
  default: {
    const exhaustive: never = candidate;
    throw new Error(String(exhaustive));
  }
  }
  signal.throwIfAborted();
  onProgress({ progress: { stage: 'preparing_model' } });
  const loadingObservation = createNativeSpeechObservation({ core, observer: investigation, modelBytes: file.size, now: () => performance.now() });
  let coverage: ReturnType<typeof createSpeechReadCoverage> | undefined = createSpeechReadCoverage({ size: file.size });
  const source = createSpeechFileSource({
    file,
    readBlob: loadingObservation === undefined ? readBlob : ({ blob }) => loadingObservation.readBlob({ blob, readBlob }),
    maxReadBytes: 4 * 1024 * 1024,
    onRead({ offset, length }) {
      loadingObservation?.read({ offset, length });
      if (coverage === undefined) {
        return;
      }
      const readBytes = coverage.add({ offset, length });
      onProgress({ progress: { stage: 'reading_model', readBytes, totalBytes: file.size } });
      if (readBytes === file.size) {
        coverage = undefined;
        // File coverage says nothing about pending GPU uploads or preparation.
        onProgress({ progress: { stage: 'preparing_model' } });
      }
    },
  });
  const mounted = helpers.mountReadOnlyFile(core, '/speech-model.gguf', {
    size: source.size,

    read: (destination, offset) => source.read({ destination, offset }),
  }, { maxChunkBytes: 4 * 1024 * 1024 });
  const sync = helpers.createAbiCaller({ module: core.module, schema: core.schema, suspension: 'jspi', gate: undefined });
  const output = core.alloc(core.pointerBytes), path = core.utf8(mounted.path), device = core.utf8('gpu');
  let model = 0n, params = 0n, request = 0n;
  let continueFrames = true, released = false;
  function readPointer(): bigint {
    return readSpeechPointer({ core, address: output });
  }
  function nativeFailure({ status }: { status: number }): SpeechFailure {
    const message = sync.callSync({ name: 'speech_last_error', args: [] });
    const input = sync.callSync({ name: 'speech_last_error_option', args: [] });
    return { code: 'runtime_failed', message: typeof message === 'bigint' ? core.readUtf8(message) ?? `Speech status ${status}` : `Speech status ${status}`, nativeStatus: status, nativeInput: typeof input === 'bigint' ? core.readUtf8(input) ?? undefined : undefined };
  }
  function check({ status }: { status: number }): void {
    if (status !== core.constant('SPEECH_OK')) {
      throw new SpeechRuntimeError({ details: nativeFailure({ status }) });
    }
  }
  let finishLoading: ReturnType<NonNullable<typeof loadingObservation>['stage']> | undefined;
  try {
    if (loadingObservation !== undefined) {
      await loadingObservation.open();
    }
    core.bytes(output, core.pointerBytes).fill(0);
    check({ status: await core.api.speech_load_params_new(output) });
    params = readPointer();
    check({ status: await core.api.speech_load_params_set_device(params, device) });
    check({ status: await core.api.speech_load_params_set_threads(params, 1) });
    // Warmup is an application decision; begin with the real model load only.
    check({ status: await core.api.speech_load_params_set_warmup(params, 0) });
    core.bytes(output, core.pointerBytes).fill(0);
    finishLoading = loadingObservation?.stage({ name: 'speech_model_load' });
    const status = await core.api.speech_model_load(path, params, output);
    model = readPointer();
    check({ status });
    finishLoading?.({ state: 'completed' });
    signal.throwIfAborted();
    if (loadingObservation !== undefined) {
      onProgress({ progress: { stage: 'checking_loaded_model' } });
      await loadingObservation.loadedModel({ model });
      await loadingObservation.devices();
    }
  } catch (error) {
    finishLoading?.({ state: signal.aborted ? 'cancelled' : 'failed' });
    loadingObservation?.emit({ event: { kind: 'failure', stage: 'model_load', failure: speechFailure({ error }) } });
    if (model !== 0n) {
      await core.api.speech_model_free(model);
    }
    mounted.remove();
    throw error;
  } finally {
    coverage = undefined;
    if (params !== 0n) {
      await core.api.speech_load_params_free(params);
    }
    core.free(device);
    core.free(path);
    core.free(output);
    if (loadingObservation !== undefined) {
      await loadingObservation.close();
    }
  }
  return {
    info: candidate.info,
    cancel() {
      continueFrames = false;
      if (request !== 0n) {
        sync.callSync({ name: 'speech_request_cancel', args: [request] });
      }
    },
    async start({ options, onFrame, investigation }) {
      if (released || request !== 0n) {
        throw speechError({ code: 'invalid_state', message: 'Speech model is not ready' });
      }
      continueFrames = true;
      const out = core.alloc(core.pointerBytes);
      let dialogue = 0n, callback: number | bigint | undefined;
      let input = 0n, inputCapacity = 0;
      let ended = false, freed = false;
      let callbackFailure: unknown;
      const observation = createNativeSpeechObservation({ core, observer: investigation, modelBytes: file.size, now: () => performance.now() });
      let finishDialogue: ReturnType<NonNullable<typeof observation>['stage']> | undefined;
      let finishFirstFrame: ReturnType<NonNullable<typeof observation>['stage']> | undefined;
      let outputFrames = 0, inputCalls = 0, inputSamples = 0;
      let observedCompletion = false;
      function observeCompletion({ status, stop }: { status: number | undefined, stop: string | undefined }): void {
        if (observation === undefined || observedCompletion) {
          return;
        }
        observedCompletion = true;
        finishDialogue?.({ state: status === undefined || status === core.constant('SPEECH_CANCELLED') ? 'cancelled' : status === core.constant('SPEECH_OK') ? continueFrames ? 'completed' : 'cancelled' : 'failed' });
        finishFirstFrame?.({ state: 'cancelled' });
        observation.emit({ event: { kind: 'result', nativeStatus: status, stop: stop === undefined ? { status: 'unknown', reason: 'Dialogue exposes return status, not a speech_result stop snapshot' } : { status: 'observed', value: stop, source: 'speech_dialogue return status or native max_seconds error' }, seed: { status: 'unavailable', reason: 'The public dialogue handle does not expose its resolved seed' }, details: { inputCalls, inputSamplesSubmitted: inputSamples, outputFrames, requestedSeed: options.seed } } });
      }
      function pointer(): bigint {
        return readSpeechPointer({ core, address: out });
      }
      try {
        if (observation !== undefined) {
          await observation.open();
          await observation.loadedModel({ model });
          await observation.devices();
          finishDialogue = observation.stage({ name: 'speech_dialogue_lifetime' });
          finishFirstFrame = observation.stage({ name: 'first_native_dialogue_frame' });
        }
        core.bytes(out, core.pointerBytes).fill(0);
        check({ status: await core.api.speech_request_new(model, out) });
        request = pointer();
        check({ status: await core.api.speech_request_set_float(request, core.constant('SPEECH_OPT_MAX_SECONDS'), options.maxSeconds) });
        if (options.seed !== undefined) {
          check({ status: await core.api.speech_request_set_int(request, core.constant('SPEECH_OPT_SEED'), BigInt(options.seed)) });
        }
        for (const [name, value] of [['SPEECH_OPT_LANGUAGE', options.language], ['SPEECH_OPT_PERSONA', options.persona], ['SPEECH_OPT_NAME', options.name]] as const) {
          if (value !== undefined) {
            const text = core.utf8(value);
            try {
              check({ status: await core.api.speech_request_set_string(request, core.constant(name), text) });
            } finally {
              core.free(text);
            }
          }
        }
        callback = core.module.addFunction((samples, count, text) => {
          if (!continueFrames) {
            return 1;
          }
          try {
            const samplePointer = speechCallbackPointer({ core, value: samples });
            const sampleCount = speechCallbackPointer({ core, value: count });
            const textPointer = speechCallbackPointer({ core, value: text });
            if (sampleCount !== 3200n) {
              throw new Error('Unexpected native Haru frame size');
            }
            const bytes = core.bytes(samplePointer, sampleCount * 4n);
            const borrowed = new Float32Array(bytes.buffer, bytes.byteOffset, Number(sampleCount));
            if (observation !== undefined) {
              outputFrames++;
              finishFirstFrame?.({ state: 'completed' });
            }
            // The session coordinator copies this borrowed view synchronously.
            const control = onFrame({ samples: borrowed, text: core.readUtf8(textPointer, 16384) ?? '' });
            switch (control) {
            case 'continue': return 0;
            case 'stop': return 1;
            default: {
              const exhaustive: never = control;
              throw new Error(String(exhaustive));
            }
            }
          } catch (error) {
            callbackFailure = error;
            continueFrames = false;
            return 1;
          }
        }, core.pointerBytes === 4 ? 'iiiii' : 'ijjjj');
        core.bytes(out, core.pointerBytes).fill(0);
        const status = await core.api.speech_dialogue_start(request, options.inputSampleRate, BigInt(callback), 0n, out);
        dialogue = pointer();
        if (status !== core.constant('SPEECH_OK')) {
          ended = true;
        }
        if (callbackFailure !== undefined) {
          throw callbackFailure;
        }
        if (status !== core.constant('SPEECH_CANCELLED')) {
          check({ status });
        }
        if (dialogue === 0n) {
          throw new Error('Speech dialogue did not return an owned handle');
        }
      } catch (error) {
        observation?.emit({ event: { kind: 'failure', stage: 'speech_dialogue_start', failure: speechFailure({ error }) } });
        finishDialogue?.({ state: 'failed' });
        finishFirstFrame?.({ state: 'failed' });
        if (dialogue !== 0n) {
          await core.api.speech_dialogue_free(dialogue);
        }
        if (callback !== undefined) {
          core.module.removeFunction(callback);
        }
        if (observation !== undefined) {
          await observation.close();
        }
        throw error;
      } finally {
        if (request !== 0n) {
          const previous = request;
          request = 0n;
          await core.api.speech_request_free(previous);
        }
        core.free(out);
      }
      const callbackPointer = callback;
      const port: SpeechDialoguePort = {
        async push({ samples }) {
          if (freed || ended) {
            throw speechError({ code: 'invalid_state', message: 'Speech dialogue is closed' });
          }
          if (samples.byteLength > inputCapacity) {
            const replacement = core.alloc(samples.byteLength);
            core.free(input);
            input = replacement;
            inputCapacity = samples.byteLength;
          }
          // Heap growth during earlier C calls may invalidate previous views.
          core.bytes(input, samples.byteLength).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
          const status = await core.api.speech_dialogue_push(dialogue, input, BigInt(samples.length));
          if (observation !== undefined) {
            inputCalls++;
            inputSamples += samples.length;
          }
          // Upstream marks any failed/cancelled dialogue closed; end() would
          // reject it and replace the original max_seconds/cancellation reason.
          if (status !== core.constant('SPEECH_OK')) {
            ended = true;
          }
          if (callbackFailure !== undefined) {
            throw callbackFailure;
          }
          if (status === core.constant('SPEECH_CANCELLED')) {
            observeCompletion({ status, stop: 'cancelled' });
            return { kind: 'completed', reason: 'cancelled' };
          }
          if (status !== core.constant('SPEECH_OK')) {
            const failure = nativeFailure({ status });
            observation?.emit({ event: { kind: 'failure', stage: 'speech_dialogue_push', failure } });
            if (failure.nativeInput === 'max_seconds') {
              observeCompletion({ status, stop: 'max_seconds' });
              return { kind: 'completed', reason: 'max_seconds' };
            }
            observeCompletion({ status, stop: undefined });
            throw new SpeechRuntimeError({ details: failure });
          }
          return { kind: 'continue' };
        },
        async end() {
          if (!ended && !freed) {
            ended = true;
            const status = await core.api.speech_dialogue_end(dialogue);
            if (status !== core.constant('SPEECH_CANCELLED') && status !== core.constant('SPEECH_OK')) {
              const failure = nativeFailure({ status });
              observation?.emit({ event: { kind: 'failure', stage: 'speech_dialogue_end', failure } });
              observeCompletion({ status, stop: undefined });
              throw new SpeechRuntimeError({ details: failure });
            }
            observeCompletion({ status, stop: status === core.constant('SPEECH_CANCELLED') ? 'cancelled' : continueFrames ? 'dialogue_end_ok' : undefined });
          }
        },
        async release() {
          if (!freed) {
            freed = true;
            try {
              await core.api.speech_dialogue_free(dialogue);
            } finally {
              if (callbackPointer !== undefined) {
                core.module.removeFunction(callbackPointer);
              }
              core.free(input);
              if (observation !== undefined) {
                if (!observedCompletion) {
                  observeCompletion({ status: undefined, stop: undefined });
                }
                await observation.close();
              }
            }
          }
        },
      };
      return port;
    },
    async release() {
      if (!released) {
        released = true;
        try {
          await core.api.speech_model_free(model);
        } finally {
          mounted.remove();
        }
      }
    },
  };
}

export const TEST_ONLY = {
};
