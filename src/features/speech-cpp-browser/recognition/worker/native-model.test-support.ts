import { vi } from 'vitest';
import { schema, type Core } from 'speech-cpp-browser-core/speech-cpp/host';

type Helpers = typeof import('speech-cpp-browser-core/speech-cpp/host');

/** A small in-memory native boundary double, typed against the installed SDK.
 * Unexpected calls fail instead of simulating unrelated SDK behavior. */
export function nativeRecognitionFixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const heap = new Uint8Array(128 * 1024), strings = new Map<bigint, string>();
  const freed: bigint[] = [], calls: string[] = [];
  let next = 1024n;
  function alloc({ bytes }: { bytes: number | bigint }): bigint {
    const result = next;
    next = (next + BigInt(bytes) + 7n) & ~7n;
    return result;
  }
  function writePointer({ output, value }: { output: bigint, value: bigint }): void {
    const view = new DataView(heap.buffer);
    switch (pointerBytes) {
    case 4:
      view.setUint32(Number(output), Number(value), true);
      // Poison alignment padding so an incorrect uint64 pointer read fails.
      view.setUint32(Number(output) + 4, 0xa5a5a5a5, true);
      break;
    case 8: view.setBigUint64(Number(output), value, true);
      break;
    default: {
      const exhaustive: never = pointerBytes;
      throw new Error(String(exhaustive));
    }
    }
  }
  const api: Partial<Core['api']> = {
    speech_model_get_info: vi.fn(async (_model, output) => {
      calls.push('get_info');
      writePointer({ output, value: 10n });
      return 0;
    }),
    speech_model_info_free: vi.fn(async () => {
      calls.push('free_info');
    }),
    speech_model_info_task: vi.fn(async () => 1),
    speech_model_info_sample_rate: vi.fn(async () => 16000),
    speech_model_info_language_count: vi.fn(async () => 1n),
    speech_model_info_language: vi.fn(async () => 200n),
    speech_model_info_option_count: vi.fn(async () => 1n),
    speech_model_info_option: vi.fn(async () => 1),
    speech_load_params_new: vi.fn(async output => {
      writePointer({ output, value: 20n });
      return 0;
    }),
    speech_load_params_free: vi.fn(async () => {
      calls.push('free_params');
    }),
    speech_load_params_set_device: vi.fn(async () => 0),
    speech_load_params_set_threads: vi.fn(async () => 0),
    speech_load_params_set_warmup: vi.fn(async () => 0),
    speech_model_load: vi.fn(async (_path, _params, output) => {
      calls.push('load_model');
      writePointer({ output, value: 30n });
      return 0;
    }),
    speech_model_free: vi.fn(async () => {
      calls.push('free_model');
    }),
    speech_request_new: vi.fn(async (_model, output) => {
      writePointer({ output, value: 40n });
      return 0;
    }),
    speech_request_set_audio: vi.fn(async () => {
      calls.push('audio');
      return 0;
    }),
    speech_request_set_string: vi.fn(async () => 0),
    speech_request_set_progress: vi.fn(async () => 0),
    speech_transcribe: vi.fn(async () => {
      calls.push('transcribe');
      return 0;
    }),
    speech_request_result: vi.fn(async () => 50n),
    speech_result_stop: vi.fn(async () => 0),
    speech_result_text: vi.fn(async () => 100n),
    speech_result_language_count: vi.fn(async () => 1n),
    speech_result_language: vi.fn(async () => 200n),
    speech_request_free: vi.fn(async () => {
      calls.push('free_request');
      strings.delete(100n);
    }),
  };
  strings.set(100n, 'こんにちは');
  strings.set(200n, 'ja');
  strings.set(300n, 'native error');
  strings.set(400n, 'audio');
  const addFunction = vi.fn<Core['module']['addFunction']>(() => 123n), removeFunction = vi.fn<Core['module']['removeFunction']>();
  const constantValues = (schema as Core['schema']).constantValues;
  // Only the native module/API are mocked; their types come from generated SDK
  // declarations. Proxy guards make an accidental extra call a test failure.
  const core = new Proxy({
    schema,
    pointerBytes,
    module: { addFunction, removeFunction },
    api: new Proxy(api, {
      get(target, key) {
        if (typeof key === 'string' && key in target) {
          return Reflect.get(target, key);
        }
        throw new Error(`Unexpected native API ${String(key)}`);
      },
    }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the generated SDK's positional helper signature.
    alloc: (bytes: number | bigint) => alloc({ bytes }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the generated SDK's positional helper signature.
    free: (pointer: bigint) => {
      freed.push(pointer);
      calls.push(`free:${pointer}`);
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the generated SDK's positional helper signature.
    bytes: (pointer: bigint, length: number | bigint) => heap.subarray(Number(pointer), Number(pointer) + Number(length)),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the generated SDK's positional helper signature.
    utf8: (text: string) => {
      const pointer = alloc({ bytes: text.length + 1 });
      strings.set(pointer, text);
      return pointer;
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the generated SDK's positional helper signature.
    readUtf8: (pointer: bigint) => strings.get(pointer) ?? null,
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Implements the generated SDK's positional helper signature.
    constant: (name: string) => {
      const value = constantValues[name];
      if (value === undefined) {
        throw new Error(`Unknown constant ${name}`);
      }
      return Number(value);
    },
  }, {
    get(target, key) {
      if (key in target) {
        return Reflect.get(target, key);
      }
      throw new Error(`Unexpected core helper ${String(key)}`);
    },
  }) as unknown as Core;
  const sync = vi.fn<ReturnType<Helpers['createAbiCaller']>['callSync']>(({ name }) => name === 'speech_last_error' ? 300n : name === 'speech_last_error_option' ? 400n : undefined);
  const remove = vi.fn<ReturnType<Helpers['mountReadOnlyFile']>['remove']>();
  const helpers = { mountReadOnlyFile: vi.fn(() => ({ path: '/model.gguf', remove })), createAbiCaller: vi.fn(() => ({ callSync: sync })) } as unknown as Helpers;
  return { core, helpers, api, calls, freed, strings, heap, sync, addFunction, removeFunction, remove, writePointer };
}

export const TEST_ONLY = {
};
