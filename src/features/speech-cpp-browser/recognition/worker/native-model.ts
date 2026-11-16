import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';
import { readSpeechPointer } from '@/features/speech-cpp-browser/worker/native-memory';
import { SpeechRuntimeError, speechError, speechFailure, type SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import { createSpeechFileSource } from '@/features/speech-cpp-browser/worker/model-file';
import { createSpeechReadCoverage } from '@/features/speech-cpp-browser/worker/load-progress';
import { inspectSpeechRecognitionCandidate } from '@/features/speech-cpp-browser/recognition/model-file';
import type { SpeechRecognitionModelPort, SpeechRecognitionResult } from '@/features/speech-cpp-browser/recognition/types';
import { createNativeSpeechObservation } from '@/features/speech-cpp-browser/worker/native-observation';
import type { SpeechInvestigationObserver } from '@/features/speech-cpp-browser/investigation/types';

type Helpers = typeof import('speech-cpp-browser-core/speech-cpp/host');

/** Native pointers and borrowed result strings never cross the Worker boundary. */
export async function openNativeSpeechRecognitionModel({ file, signal, core, helpers, readBlob, onProgress, investigation }: {
  file: File, signal: AbortSignal, core: Core, helpers: Helpers,
  readBlob: ({ blob }: { blob: Blob }) => ArrayBuffer,
  onProgress: ({ progress }: { progress: SpeechLoadProgress }) => void,
  investigation?: SpeechInvestigationObserver,
}): Promise<SpeechRecognitionModelPort> {
  onProgress({ progress: { stage: 'checking_model' } });
  const candidate = await inspectSpeechRecognitionCandidate({ file, name: file.name, signal });
  switch (candidate.kind) {
  case 'recognition': break;
  case 'other': throw speechError({ code: 'invalid_model', message: 'Expected a speech.cpp recognition model' });
  default: {
    const exhaustive: never = candidate;
    throw new Error(String(exhaustive));
  }
  }
  onProgress({ progress: { stage: 'preparing_model' } });
  const loadingObservation = createNativeSpeechObservation({ core, observer: investigation, modelBytes: file.size, now: () => performance.now() });
  const coverage = createSpeechReadCoverage({ size: file.size });
  const source = createSpeechFileSource({
    file,
    readBlob: loadingObservation === undefined ? readBlob : ({ blob }) => loadingObservation.readBlob({ blob, readBlob }),
    maxReadBytes: 4 * 1024 * 1024,
    onRead({ offset, length }) {
      loadingObservation?.read({ offset, length });
      const readBytes = coverage.add({ offset, length });
      onProgress({ progress: readBytes === file.size ? { stage: 'preparing_model' } : { stage: 'reading_model', readBytes, totalBytes: file.size } });
    },
  });
  const mounted = helpers.mountReadOnlyFile(core, '/recognition-model.gguf', { size: source.size, read: (destination, offset) => source.read({ destination, offset }) }, { maxChunkBytes: 4 * 1024 * 1024 });
  const sync = helpers.createAbiCaller({ module: core.module, schema: core.schema, suspension: 'jspi', gate: undefined });
  const out = core.alloc(core.pointerBytes), path = core.utf8(mounted.path), device = core.utf8('gpu');
  let model = 0n, params = 0n, metadata = 0n, request = 0n;
  let released = false, cancelled = false;
  function pointer(): bigint {
    return readSpeechPointer({ core, address: out });
  }
  function check({ status }: { status: number }): void {
    if (status === core.constant('SPEECH_OK')) {
      return;
    }
    // Capture native error immediately; cleanup calls may replace it.
    const message = sync.callSync({ name: 'speech_last_error', args: [] });
    const input = sync.callSync({ name: 'speech_last_error_option', args: [] });
    throw new SpeechRuntimeError({ details: { code: 'runtime_failed', message: typeof message === 'bigint' ? core.readUtf8(message) ?? `Speech status ${status}` : `Speech status ${status}`, nativeStatus: status, nativeInput: typeof input === 'bigint' ? core.readUtf8(input) ?? undefined : undefined } });
  }
  const languages: string[] = [];
  let languageSelection: 'supported' | 'unsupported' = 'unsupported';
  let finishLoading: ReturnType<NonNullable<typeof loadingObservation>['stage']> | undefined;
  try {
    if (loadingObservation !== undefined) {
      await loadingObservation.open();
    }
    core.bytes(out, core.pointerBytes).fill(0);
    check({ status: await core.api.speech_load_params_new(out) });
    params = pointer();
    check({ status: await core.api.speech_load_params_set_device(params, device) });
    check({ status: await core.api.speech_load_params_set_threads(params, 1) });
    check({ status: await core.api.speech_load_params_set_warmup(params, 0) });
    signal.throwIfAborted();
    core.bytes(out, core.pointerBytes).fill(0);
    finishLoading = loadingObservation?.stage({ name: 'speech_model_load' });
    const status = await core.api.speech_model_load(path, params, out);
    model = pointer();
    check({ status });
    finishLoading?.({ state: 'completed' });
    signal.throwIfAborted();
    onProgress({ progress: { stage: 'checking_loaded_model' } });
    // Snapshot the loaded model's metadata instead of reparsing its GGUF first.
    core.bytes(out, core.pointerBytes).fill(0);
    const infoStatus = await core.api.speech_model_get_info(model, out);
    metadata = pointer();
    check({ status: infoStatus });
    signal.throwIfAborted();
    if (await core.api.speech_model_info_task(metadata) !== core.constant('SPEECH_TASK_RECOGNITION') || await core.api.speech_model_info_sample_rate(metadata) !== candidate.info.sampleRate) {
      throw speechError({ code: 'invalid_model', message: 'Native recognition metadata does not match the selected model' });
    }
    const count = await core.api.speech_model_info_language_count(metadata);
    if (count > 256n) {
      throw speechError({ code: 'invalid_model', message: 'Too many recognition languages' });
    }
    for (let index = 0n; index < count; index++) {
      const text = core.readUtf8(await core.api.speech_model_info_language(metadata, index), 256);
      if (text !== null) {
        languages.push(text);
      }
    }
    const options = await core.api.speech_model_info_option_count(metadata);
    for (let index = 0n; index < options; index++) {
      if (await core.api.speech_model_info_option(metadata, index) === core.constant('SPEECH_OPT_LANGUAGE')) {
        languageSelection = 'supported';
      }
    }
    signal.throwIfAborted();
    if (loadingObservation !== undefined) {
      await loadingObservation.modelInfo({ metadata });
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
    if (metadata !== 0n) {
      await core.api.speech_model_info_free(metadata);
    }
    if (params !== 0n) {
      await core.api.speech_load_params_free(params);
    }
    core.free(device);
    core.free(path);
    core.free(out);
    if (loadingObservation !== undefined) {
      await loadingObservation.close();
    }
  }
  return {
    info: { ...candidate.info, languages, languageSelection },
    cancel() {
      cancelled = true;
      if (request !== 0n) {
        // Registered synchronous leaf bypasses the busy JSPI call gate.
        sync.callSync({ name: 'speech_request_cancel', args: [request] });
      }
    },
    async transcribe({ samples, sampleRate, language, onProgress, investigation }) {
      if (released || request !== 0n) {
        throw speechError({ code: 'invalid_state', message: 'Recognition model is not ready' });
      }
      if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || samples.length === 0 || samples.length > sampleRate * 180 || samples.some(sample => !Number.isFinite(sample) || sample < -1 || sample > 1)) {
        throw speechError({ code: 'invalid_audio', message: 'Recognition needs at most 180 seconds of finite mono PCM' });
      }
      if (language !== undefined && (languageSelection !== 'supported' || (language !== 'auto' && !languages.includes(language)))) {
        throw speechError({ code: 'invalid_state', message: 'The recognition model does not support that language selection' });
      }
      cancelled = false;
      const output = core.alloc(core.pointerBytes);
      const observation = createNativeSpeechObservation({ core, observer: investigation, modelBytes: file.size, now: () => performance.now() });
      let finishTranscribing: ReturnType<NonNullable<typeof observation>['stage']> | undefined;
      let input = 0n, callback: number | bigint | undefined;
      try {
        if (observation !== undefined) {
          await observation.open();
          await observation.loadedModel({ model });
          await observation.devices();
        }
        core.bytes(output, core.pointerBytes).fill(0);
        check({ status: await core.api.speech_request_new(model, output) });
        request = readSpeechPointer({ core, address: output });
        input = core.alloc(samples.byteLength);
        core.bytes(input, samples.byteLength).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
        // set_audio owns a native copy. Free staging immediately after it
        // returns; the actual input rate is never relabelled as the model rate.
        check({ status: await core.api.speech_request_set_audio(request, input, BigInt(samples.length), sampleRate) });
        core.free(input);
        input = 0n;
        if (language !== undefined) {
          const text = core.utf8(language);
          try {
            check({ status: await core.api.speech_request_set_string(request, core.constant('SPEECH_OPT_LANGUAGE'), text) });
          } finally {
            core.free(text);
          }
        }
        let previous = -1;
        callback = core.module.addFunction(done => {
          if (cancelled) {
            return 1;
          }
          if (typeof done === 'number' && Number.isFinite(done) && done >= 0 && done <= 1 && (done - previous >= 0.01 || done === 1)) {
            previous = done;
            observation?.emit({ event: { kind: 'progress', stage: 'speech_transcribe', value: done, total: 1, unit: 'fraction', provenance: 'observed', details: undefined } });
            onProgress({ progress: done });
          }
          return 0;
        }, core.pointerBytes === 4 ? 'idi' : 'idj');
        check({ status: await core.api.speech_request_set_progress(request, BigInt(callback), 0n) });
        if (cancelled) {
          sync.callSync({ name: 'speech_request_cancel', args: [request] });
        }
        finishTranscribing = observation?.stage({ name: 'speech_transcribe' });
        const status = await core.api.speech_transcribe(request);
        if (status !== core.constant('SPEECH_CANCELLED')) {
          check({ status });
        }
        finishTranscribing?.({ state: status === core.constant('SPEECH_CANCELLED') ? 'cancelled' : 'completed' });
        const result = await core.api.speech_request_result(request);
        if (result === 0n) {
          if (status === core.constant('SPEECH_CANCELLED')) {
            return { text: '', languages: [], status: 'cancelled' };
          }
          throw speechError({ code: 'runtime_failed', message: 'Recognition returned no result' });
        }
        if (observation !== undefined) {
          await observation.result({ result, nativeStatus: status });
        }
        const stop = await core.api.speech_result_stop(result);
        let completion: SpeechRecognitionResult['status'];
        if (status === core.constant('SPEECH_CANCELLED') || stop === core.constant('SPEECH_STOP_CANCELLED')) {
          completion = 'cancelled';
        } else if (stop === core.constant('SPEECH_STOP_COMPLETE')) {
          completion = 'complete';
        } else if (stop === core.constant('SPEECH_STOP_MODEL_LIMIT')) {
          completion = 'model_limit';
        } else if (stop === core.constant('SPEECH_STOP_MAX_SECONDS')) {
          completion = 'max_seconds';
        } else {
          throw speechError({ code: 'runtime_failed', message: `Unknown recognition stop reason ${stop}` });
        }
        const text = core.readUtf8(await core.api.speech_result_text(result), 4 * 1024 * 1024) ?? '';
        const detected: string[] = [];
        const count = await core.api.speech_result_language_count(result);
        if (count > 256n) {
          throw speechError({ code: 'runtime_failed', message: 'Too many recognized languages' });
        }
        for (let index = 0n; index < count; index++) {
          const value = core.readUtf8(await core.api.speech_result_language(result, index), 256);
          if (value !== null) {
            detected.push(value);
          }
        }
        // Copy all borrowed result data before freeing its owning request.
        return { text, languages: detected, status: completion };
      } catch (error) {
        finishTranscribing?.({ state: cancelled ? 'cancelled' : 'failed' });
        observation?.emit({ event: { kind: 'failure', stage: 'speech_transcribe', failure: speechFailure({ error }) } });
        throw error;
      } finally {
        if (request !== 0n) {
          const previous = request;
          request = 0n;
          await core.api.speech_request_free(previous);
        }
        if (callback !== undefined) {
          core.module.removeFunction(callback);
        }
        core.free(input);
        core.free(output);
        if (observation !== undefined) {
          await observation.close();
        }
      }
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
