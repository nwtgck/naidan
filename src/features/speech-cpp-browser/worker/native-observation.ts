import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';
import type { SpeechInvestigationEvent, SpeechInvestigationObserver, SpeechObservation } from '@/features/speech-cpp-browser/investigation/types';
import { createSpeechReadCoverage } from './load-progress';
import { subscribeNativeSpeechLogs } from './native-log-router';

/** Optional, bounded public-API observations. No observer means no native calls,
 * callback slots, clock reads, read accounting or additional heap inspection. */
export function createNativeSpeechObservation({ core, observer, modelBytes, now }: { core: Core, observer: SpeechInvestigationObserver | undefined, modelBytes: number, now: () => number }) {
  if (observer === undefined) {
    return undefined;
  }
  let send: SpeechInvestigationObserver | undefined = observer;
  let unsubscribeLogs: (() => void) | undefined;
  let closed = false;
  let droppedLogs = 0;
  // Verbose model metadata must not consume the diagnostic allocation error
  // reserve. Warnings also cannot spend the separate error quota.
  const normalLogs = { count: 0, characters: 0, maximumCount: 224, maximumCharacters: 112 * 1024 };
  const warningLogs = { count: 0, characters: 0, maximumCount: 16, maximumCharacters: 8 * 1024 };
  const errorLogs = { count: 0, characters: 0, maximumCount: 16, maximumCharacters: 8 * 1024 };
  let logs: { level: string, text: string }[] = [], batchCharacters = 0, previousFlush = -Infinity;
  let calls = 0, totalBytes = 0, maximumChunkBytes = 0, smallReads = 0, uniqueBytes = 0;
  let blobCalls = 0, blobBytes = 0, blobMaximum = 0, blobSmallReads = 0, blobFailures = 0, blobMilliseconds = 0;
  let firstRead: number | undefined;
  const coverage = createSpeechReadCoverage({ size: modelBytes });
  function emit({ event }: { event: SpeechInvestigationEvent }): void {
    try {
      send?.({ event });
    } catch { /* Observations cannot control inference. */ }
  }
  function heap(): number | undefined {
    try {
      return core.module.HEAPU8.byteLength;
    } catch {
      return undefined;
    }
  }
  function flushLogs(): void {
    if (logs.length === 0 && droppedLogs === 0) {
      return;
    }
    const lines = logs;
    logs = [];
    batchCharacters = 0;
    const dropped = droppedLogs;
    droppedLogs = 0;
    emit({ event: { kind: 'native_log_batch', lines, dropped } });
  }
  function stage({ name }: { name: string }) {
    const started = now();
    emit({ event: { kind: 'stage', stage: name, state: 'started', durationMilliseconds: undefined, heapBytes: heap(), details: undefined } });
    let finished = false;
    return ({ state }: { state: 'completed' | 'cancelled' | 'failed' }): void => {
      if (!finished) {
        finished = true;
        flushLogs();
        emit({ event: { kind: 'stage', stage: name, state, durationMilliseconds: Math.max(0, now() - started), heapBytes: heap(), details: undefined } });
      }
    };
  }
  function observed<T>({ value, source }: { value: T, source: string }): SpeechObservation<T> {
    return { status: 'observed', value, source };
  }
  function text({ pointer, source }: { pointer: bigint, source: string }): SpeechObservation<string> {
    const value = core.readUtf8(pointer, 4096);
    return value === null ? { status: 'unknown', reason: `${source} returned no value` } : observed({ value, source });
  }
  return {
    stage,
    emit,
    async open(): Promise<void> {
      unsubscribeLogs = await subscribeNativeSpeechLogs({
        core,
        receive({ level, text: borrowed }) {
          if (closed) {
            return;
          }
          const quota = level >= 3 ? errorLogs : level === 2 ? warningLogs : normalLogs;
          if (quota.count >= quota.maximumCount || quota.characters >= quota.maximumCharacters) {
            droppedLogs++;
            return;
          }
          const text = borrowed.slice(0, Math.min(8192, quota.maximumCharacters - quota.characters));
          if (text.length !== borrowed.length) {
            droppedLogs++;
          }
          quota.count++;
          quota.characters += text.length;
          batchCharacters += text.length;
          logs.push({ level: ['debug', 'info', 'warn', 'error'][level] ?? `native:${level}`, text });
          const time = now();
          if (batchCharacters >= 16 * 1024 || logs.length >= 16 || time - previousFlush >= 250) {
            previousFlush = time;
            flushLogs();
          }
        },
      });
    },
    read({ offset, length }: { offset: number, length: number }): void {
      if (closed) {
        return;
      }
      if (firstRead === undefined) {
        firstRead = now();
      }
      calls++;
      totalBytes += length;
      maximumChunkBytes = Math.max(maximumChunkBytes, length);
      if (length < 4096) {
        smallReads++;
      }
      uniqueBytes = coverage.add({ offset, length });
    },
    readBlob({ blob, readBlob }: { blob: Blob, readBlob: ({ blob }: { blob: Blob }) => ArrayBuffer }): ArrayBuffer {
      if (closed) {
        return readBlob({ blob });
      }
      const started = now();
      blobCalls++;
      blobMaximum = Math.max(blobMaximum, blob.size);
      if (blob.size < 4096) {
        blobSmallReads++;
      }
      try {
        const bytes = readBlob({ blob });
        blobBytes += bytes.byteLength;
        return bytes;
      } catch (error) {
        blobFailures++;
        throw error;
      } finally {
        blobMilliseconds += Math.max(0, now() - started);
      }
    },
    async modelInfo({ metadata }: { metadata: bigint }): Promise<void> {
      const finished = stage({ name: 'native_model_info' });
      try {
        const pointer = await core.api.speech_model_info_json(metadata);
        const rawJson = core.readUtf8(pointer, 64 * 1024);
        if (rawJson === null) {
          finished({ state: 'failed' });
          return;
        }
        const device = text({ pointer: await core.api.speech_model_info_device(metadata), source: 'speech_model_info_device' });
        const threads = observed({ value: await core.api.speech_model_info_threads(metadata), source: 'speech_model_info_threads' });
        const weightType = text({ pointer: await core.api.speech_model_info_weight_type(metadata), source: 'speech_model_info_weight_type' });
        const weightBytes = observed({ value: String(await core.api.speech_model_info_weight_bytes(metadata)), source: 'speech_model_info_weight_bytes' });
        emit({ event: { kind: 'model_info', rawJson, device, threads, weightType, weightBytes } });
        finished({ state: 'completed' });
      } catch {
        finished({ state: 'failed' });
      }
    },
    async loadedModel({ model }: { model: bigint }): Promise<void> {
      let output = 0n, metadata = 0n;
      try {
        output = core.alloc(8);
        core.bytes(output, 8).fill(0);
        const status = await core.api.speech_model_get_info(model, output);
        const bytes = core.bytes(output, 8);
        metadata = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
        if (status === core.constant('SPEECH_OK') && metadata !== 0n) {
          await this.modelInfo({ metadata });
        }
      } catch { /* Model diagnostics cannot replace the inference result. */ } finally {
        if (metadata !== 0n) {
          try {
            await core.api.speech_model_info_free(metadata);
          } catch { /* Observational cleanup only. */ }
        }
        try {
          core.free(output);
        } catch { /* Observational cleanup only. */ }
      }
    },
    async devices(): Promise<void> {
      const devices: Extract<SpeechInvestigationEvent, { kind: 'devices' }>['devices'][number][] = [];
      let output = 0n;
      try {
        output = core.alloc(24);
        const count = await core.api.speech_device_count();
        for (let index = 0n; index < count && index < 32n; index++) {
          const name = core.readUtf8(await core.api.speech_device_name(index), 4096) ?? '';
          const description = core.readUtf8(await core.api.speech_device_description(index), 4096) ?? '';
          core.bytes(output, 24).fill(0);
          const kindStatus = await core.api.speech_device_get_kind(index, output);
          const kindBytes = core.bytes(output, 4);
          const kindValue = new DataView(kindBytes.buffer, kindBytes.byteOffset, 4).getInt32(0, true);
          const status = await core.api.speech_device_memory(index, output + 8n, output + 16n);
          const bytes = core.bytes(output, 24), view = new DataView(bytes.buffer, bytes.byteOffset, 24);
          const total = view.getBigUint64(8, true), free = view.getBigUint64(16, true);
          const memory = ({ value }: { value: bigint }): SpeechObservation<string> => status === core.constant('SPEECH_OK') && value > 0n ? observed({ value: String(value), source: 'speech_device_memory' }) : { status: 'unknown', reason: 'Device memory was not reported; zero is not a measured capacity' };
          devices.push({ name, description, kind: kindStatus === core.constant('SPEECH_OK') ? ['cpu', 'gpu', 'integrated_gpu'][kindValue] ?? `native:${kindValue}` : 'unknown', totalBytes: memory({ value: total }), freeBytes: memory({ value: free }) });
        }
        emit({ event: { kind: 'devices', devices } });
      } catch { /* A device observation failure cannot replace model state. */ } finally {
        try {
          core.free(output);
        } catch { /* Observational cleanup only. */ }
      }
    },
    async result({ result, nativeStatus }: { result: bigint, nativeStatus: number }): Promise<void> {
      try {
        const stop = await core.api.speech_result_stop(result);
        const seed = await core.api.speech_result_seed(result);
        emit({ event: { kind: 'result', nativeStatus, stop: observed({ value: stop, source: 'speech_result_stop' }), seed: seed === -1n ? { status: 'not_applicable', reason: 'speech_result_seed is only defined for synthesis requests' } : observed({ value: String(seed), source: 'speech_result_seed' }), details: undefined } });
      } catch { /* Only public, successfully returned result data is observed. */ }
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      unsubscribeLogs?.();
      unsubscribeLogs = undefined;
      flushLogs();
      if (calls !== 0) {
        emit({ event: { kind: 'read_summary', calls, totalBytes, uniqueBytes: observed({ value: uniqueBytes, source: 'native random-access read callbacks' }), maximumChunkBytes, smallReads, elapsedMilliseconds: firstRead === undefined ? undefined : Math.max(0, now() - firstRead) } });
      }
      if (blobCalls !== 0) {
        emit({ event: { kind: 'stage', stage: 'model_file_source_reads', state: blobFailures === 0 ? 'completed' : 'failed', durationMilliseconds: blobMilliseconds, heapBytes: heap(), details: { calls: blobCalls, bytesReturned: blobBytes, maximumChunkBytes: blobMaximum, smallReads: blobSmallReads, failures: blobFailures, boundary: 'sum of synchronous Blob reader calls; excludes native memory copies' } } });
      }
      const capacity = heap();
      if (capacity !== undefined) {
        emit({ event: { kind: 'wasm_heap', capacityBytes: capacity } });
      }
      send = undefined;
    },
  };
}

export type NativeSpeechObservation = NonNullable<ReturnType<typeof createNativeSpeechObservation>>;
export const TEST_ONLY = {
};
