import { vi } from 'vitest';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { audioResult } from './wav';

/** Deliberately small ABI fixture. This tests ownership and orchestration, not
 * trained model inference or the actual device scheduler. */
export function audioNativeFixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  let heap = new Uint8Array(1024 * 1024); let cursor = 128;
  const output = audioResult(); const outputPointer = 500000n;
  const controls = { nativeType: 1, position: 0, capacity: 4096, stopAfter: 2, steps: 0, audio: true, referenceBytes: 24000 * 4, growDuringStep: false };
  const fields = new Map<string, number | bigint>();
  const owned = new Set<bigint>(); const freed: bigint[] = [];
  const constants: Record<string, number> = { MTMD_GEN_AUDIO_TYPE_QWEN3TTS: 1, MTMD_GEN_AUDIO_TYPE_POCKETTTS: 2, MTMD_HELPER_GEN_AUDIO_OUTTYPE_WAV: 1, LLAMA_TOKEN_NULL: -1 };
  const bytes = ({ pointer, length }: { pointer: bigint, length: number | bigint }): Uint8Array => {
    const start = Number(pointer); const end = start + Number(length);
    if (start < 0 || end > heap.length) throw new Error('Fixture out of bounds');
    return heap.subarray(start, end);
  };
  const write = ({ pointer, value, size, signed }: { pointer: bigint, value: number | bigint, size: number, signed: boolean }): void => {
    const view = new DataView(heap.buffer);
    if (size === 8) {
      if (signed) view.setBigInt64(Number(pointer), BigInt(value), true); else view.setBigUint64(Number(pointer), BigInt(value), true);
    } else if (size === 4) {
      if (signed) view.setInt32(Number(pointer), Number(value), true); else view.setUint32(Number(pointer), Number(value), true);
    } else view.setUint8(Number(pointer), Number(value));
  };
  const allocate = ({ bytes: count }: { bytes: number }): bigint => {
    const pointer = BigInt(cursor); cursor += Math.ceil(count / 8) * 8 + 8; owned.add(pointer); return pointer;
  };
  const grow = (): void => {
    const next = new Uint8Array(heap.length * 2); next.set(heap);
    // Detach the previous view to model memory growth invalidating JS references.
    const previous = heap.buffer; heap = next;
    if (typeof structuredClone === 'function') structuredClone(previous, { transfer: [previous] });
  };
  const api = {
    mtmd_gen_audio_get_info: vi.fn(async (out: bigint, _projector: bigint) => {
      write({ pointer: out, value: controls.nativeType, size: 4, signed: true });
    }),
    mtmd_helper_init_opt_default: vi.fn(async (_out: bigint) => {}),
    mtmd_helper_bitmap_init_from_buf: vi.fn(async (out: bigint, _projector: bigint, _buffer: bigint, _length: bigint, _placeholder: number, _options: bigint) => {
      write({ pointer: out, value: 50n, size: pointerBytes, signed: false });
    }),
    mtmd_bitmap_is_audio: vi.fn(async () => controls.audio ? 1 : 0),
    mtmd_bitmap_get_n_bytes: vi.fn(async () => BigInt(controls.referenceBytes)),
    mtmd_get_audio_sample_rate: vi.fn(async () => 24000),
    mtmd_bitmap_free: vi.fn(async (_pointer: bigint) => {}),
    llama_set_abort_callback: vi.fn(async (_context: bigint, _callback: bigint, _data: bigint) => {}),
    mtmd_helper_gen_audio_init: vi.fn(async () => 60n),
    mtmd_helper_gen_audio_set_input: vi.fn(async () => 0),
    llama_n_ctx: vi.fn(async () => controls.capacity),
    llama_get_memory: vi.fn(async () => 70n),
    llama_memory_seq_pos_max: vi.fn(async () => controls.position),
    mtmd_helper_gen_audio_step_prompt: vi.fn(async () => {
      controls.position = 10; return 0;
    }),
    llama_get_embeddings_ith: vi.fn(async () => 10000n),
    llama_sampler_sample: vi.fn(async () => 123),
    mtmd_helper_gen_audio_step_gen: vi.fn(async (_helper: bigint, _token: number, _hidden: bigint, hiddenOut: bigint, stopOut: bigint) => {
      if (controls.growDuringStep) {
        grow(); controls.growDuringStep = false;
      }
      const stop = controls.steps >= controls.stopAfter;
      write({ pointer: hiddenOut, value: stop ? 0n : 10000n, size: pointerBytes, signed: false });
      write({ pointer: stopOut, value: stop ? 1 : 0, size: 1, signed: false });
      if (!stop) {
        controls.steps++; controls.position++;
      }
      return 0;
    }),
    mtmd_helper_gen_audio_get_output: vi.fn(async (_helper: bigint, rate: bigint, data: bigint, length: bigint, samples: bigint) => {
      heap.set(output.wav, Number(outputPointer));
      write({ pointer: rate, value: output.sampleRate, size: 4, signed: true });
      write({ pointer: data, value: outputPointer, size: pointerBytes, signed: false });
      write({ pointer: length, value: output.wav.length, size: pointerBytes, signed: false });
      write({ pointer: samples, value: output.samples, size: 8, signed: true });
      return 0;
    }),
    mtmd_helper_gen_audio_free: vi.fn(async () => {
      bytes({ pointer: outputPointer, length: output.wav.length }).fill(0);
    }),
    llama_sampler_init_greedy: vi.fn(async () => 80n),
    llama_sampler_chain_default_params: vi.fn(async () => {}),
    llama_sampler_chain_init: vi.fn(async () => 81n),
    llama_sampler_init_top_k: vi.fn(async () => 82n),
    llama_sampler_init_top_p: vi.fn(async () => 83n),
    llama_sampler_init_temp: vi.fn(async () => 84n),
    llama_sampler_init_dist: vi.fn(async () => 85n),
    llama_sampler_chain_add: vi.fn(async (_chain: bigint, _sampler: bigint) => {}),
    llama_sampler_free: vi.fn(async (_sampler: bigint) => {}),
  };
  const module = { addFunction: vi.fn(() => 9), removeFunction: vi.fn() };
  const core = {
    api, module, pointerBytes, bytes,
    alloc: allocate,
    allocRecord: ({ name: _name }: { name: string }) => allocate({ bytes: 128 }),
    free: ({ pointer }: { pointer: bigint }) => {
      if (!owned.delete(pointer)) throw new Error('Double or foreign free'); freed.push(pointer);
    },
    utf8: ({ text }: { text: string }) => {
      const encoded = new TextEncoder().encode(text); const pointer = allocate({ bytes: encoded.length + 1 }); bytes({ pointer, length: encoded.length }).set(encoded); return pointer;
    },
    constant: ({ name }: { name: string }) => {
      const value = constants[name]; if (value === undefined) throw new Error('Unknown fixture constant'); return value;
    },
    setField: ({ name, pointer: _pointer, field, value }: { name: string, pointer: bigint, field: string, value: number | bigint }) => {
      fields.set(`${name}.${field}`, value);
    },
    fieldLayout: ({ name, field }: { name: string, field: string }) => {
      if (name === 'mtmd_gen_audio_info' && field === 'type') return { kind: 'signed', offset: 0n, size: 4 };
      if (name === 'mtmd_helper_bitmap_wrapper' && field === 'bitmap') return { kind: 'pointer', offset: 0n, size: pointerBytes };
      throw new Error('Unknown fixture field');
    },
  } as unknown as Core;
  return { core, api, module, controls, fields, owned, freed, write, grow, outputPointer };
}
export const TEST_ONLY = {
};
