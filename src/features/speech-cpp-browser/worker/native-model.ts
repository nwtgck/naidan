import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';
import type { SpeechModelPort, SpeechDialoguePort, SpeechFailure, SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import { SpeechRuntimeError, speechError } from '@/features/speech-cpp-browser/types';
import { inspectSpeechCandidate, createSpeechFileSource } from './model-file';
import { createSpeechReadCoverage } from './load-progress';

type Helpers = typeof import('speech-cpp-browser-core/speech-cpp/host');

/** Actual generated C API integration. Native pointers remain bigint, callback
 * views expire on return, and every view is reacquired after an awaited call. */
export async function openNativeSpeechModel({ file, signal, core, helpers, readBlob, onProgress }: {
  file: File, signal: AbortSignal, core: Core, helpers: Helpers,
  readBlob: ({ blob }: { blob: Blob }) => ArrayBuffer,
  onProgress: ({ progress }: { progress: SpeechLoadProgress }) => void,
}): Promise<SpeechModelPort> {
  onProgress({ progress: { stage: 'preparing_model' } });
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
  let coverage: ReturnType<typeof createSpeechReadCoverage> | undefined = createSpeechReadCoverage({ size: file.size });
  const source = createSpeechFileSource({
    file,
    readBlob,
    maxReadBytes: 4 * 1024 * 1024,
    onRead({ offset, length }) {
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
  const output = core.alloc(8), path = core.utf8(mounted.path), device = core.utf8('gpu');
  let model = 0n, params = 0n, request = 0n;
  let continueFrames = true, released = false;
  function readPointer(): bigint {
    const bytes = core.bytes(output, 8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
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
  try {
    core.bytes(output, 8).fill(0);
    check({ status: await core.api.speech_load_params_new(output) });
    params = readPointer();
    check({ status: await core.api.speech_load_params_set_device(params, device) });
    check({ status: await core.api.speech_load_params_set_threads(params, 1) });
    // Warmup is an application decision; begin with the real model load only.
    check({ status: await core.api.speech_load_params_set_warmup(params, 0) });
    core.bytes(output, 8).fill(0);
    const status = await core.api.speech_model_load(path, params, output);
    model = readPointer();
    check({ status });
    signal.throwIfAborted();
  } catch (error) {
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
  }
  return {
    info: candidate.info,
    cancel() {
      continueFrames = false;
      if (request !== 0n) {
        sync.callSync({ name: 'speech_request_cancel', args: [request] });
      }
    },
    async start({ options, onFrame }) {
      if (released || request !== 0n) {
        throw speechError({ code: 'invalid_state', message: 'Speech model is not ready' });
      }
      continueFrames = true;
      const out = core.alloc(8);
      let dialogue = 0n, callback: number | bigint | undefined;
      let input = 0n, inputCapacity = 0;
      let ended = false, freed = false;
      let callbackFailure: unknown;
      function pointer(): bigint {
        const bytes = core.bytes(out, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
      }
      try {
        core.bytes(out, 8).fill(0);
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
            if (typeof samples !== 'bigint' || typeof count !== 'bigint' || typeof text !== 'bigint' || count !== 3200n) {
              throw new Error('Unexpected native Haru frame size');
            }
            const bytes = core.bytes(samples, count * 4n);
            const borrowed = new Float32Array(bytes.buffer, bytes.byteOffset, Number(count));
            // The session coordinator copies this borrowed view synchronously.
            const control = onFrame({ samples: borrowed, text: core.readUtf8(text, 16384) ?? '' });
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
        }, 'ijjjj');
        core.bytes(out, 8).fill(0);
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
        if (dialogue !== 0n) {
          await core.api.speech_dialogue_free(dialogue);
        }
        if (callback !== undefined) {
          core.module.removeFunction(callback);
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
          // Upstream marks any failed/cancelled dialogue closed; end() would
          // reject it and replace the original max_seconds/cancellation reason.
          if (status !== core.constant('SPEECH_OK')) {
            ended = true;
          }
          if (callbackFailure !== undefined) {
            throw callbackFailure;
          }
          if (status === core.constant('SPEECH_CANCELLED')) {
            return { kind: 'completed', reason: 'cancelled' };
          }
          if (status !== core.constant('SPEECH_OK')) {
            const failure = nativeFailure({ status });
            if (failure.nativeInput === 'max_seconds') {
              return { kind: 'completed', reason: 'max_seconds' };
            }
            throw new SpeechRuntimeError({ details: failure });
          }
          return { kind: 'continue' };
        },
        async end() {
          if (!ended && !freed) {
            ended = true;
            const status = await core.api.speech_dialogue_end(dialogue);
            if (status !== core.constant('SPEECH_CANCELLED')) {
              check({ status });
            }
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
