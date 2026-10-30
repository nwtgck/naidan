import { decodeImage } from '@/features/llama-cpp-browser/runtime/image-input';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { createLiveAllocations, type LiveNative } from './live-memory';
import { readAudioField, readAudioScalar } from './audio-memory';

export type LivePromptPart = { type: 'text', text: string, isInput: boolean } | { type: 'image', blob: Blob };

/** Decode trusted template parts and literal input with mtmd's public tokenizer.
 * No reparsing user strings or raw tool output as control tokens. */
export async function evaluateLiveParts({ native, parts }: { native: LiveNative, parts: LivePromptPart[] }): Promise<void> {
  if (!parts.length) {
    return;
  }
  const { core, context, projector, capacity } = native;
  const allocations = createLiveAllocations({ core });
  const bitmaps: bigint[] = [];
  let chunks = 0n;
  try {
    const pointers: bigint[] = [];
    for (const part of parts) {
      const input = allocations.record({ name: 'mtmd_input_part' });
      pointers.push(input);
      switch (part.type) {
      case 'text': {
        const text = allocations.record({ name: 'mtmd_input_text' });
        for (const [field, value] of Object.entries({ text: allocations.text({ text: part.text }), text_len: BigInt(new TextEncoder().encode(part.text).length), add_special: 0, parse_special: Number(!part.isInput) })) {
          core.setField({ name: 'mtmd_input_text', pointer: text, field, value });
        }
        core.setField({ name: 'mtmd_input_part', pointer: input, field: 'text', value: text });
        break;
      }
      case 'image': {
        const { width, height, rgb } = await decodeImage({ blob: part.blob });
        const data = core.alloc({ bytes: rgb.byteLength });
        let bitmap = 0n;
        try {
          core.bytes({ pointer: data, length: rgb.byteLength }).set(rgb);
          bitmap = await core.api.mtmd_bitmap_init(width, height, data);
        } finally {
          core.free({ pointer: data });
        }
        if (!bitmap) {
          throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        }
        bitmaps.push(bitmap);
        core.setField({ name: 'mtmd_input_part', pointer: input, field: 'bitmap', value: bitmap });
        break;
      }
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }
    const array = allocations.alloc({ bytes: pointers.length * core.pointerBytes });
    const bytes = core.bytes({ pointer: array, length: pointers.length * core.pointerBytes });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pointers.forEach((pointer, index) => {
      if (core.pointerBytes === 8) {
        view.setBigUint64(index * 8, pointer, true);
      } else {
        view.setUint32(index * 4, Number(pointer), true);
      }
    });
    chunks = await core.api.mtmd_input_chunks_init();
    if (!chunks || await core.api.mtmd_tokenize_from_parts(projector, chunks, array, BigInt(pointers.length), 0) !== 0) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    const count = await core.api.mtmd_helper_get_n_pos(chunks);
    if (!Number.isSafeInteger(count) || count < 0 || native.position + count + 2 >= capacity) {
      throw new LlamaCppBrowserError({ code: 'context-full' });
    }
    if (!count) {
      return;
    }
    const position = allocations.alloc({ bytes: 4 });
    if (await core.api.mtmd_helper_eval_chunks(projector, context, chunks, native.position, 0, 128, 1, position) !== 0) {
      throw new LlamaCppBrowserError({ code: 'runtime-error' });
    }
    const next = Number(readAudioScalar({ core, pointer: position, kind: 'i32' }));
    if (next !== native.position + count || next >= capacity) {
      throw new Error('Invalid live input position');
    }
    native.position = next;
  } finally {
    try {
      if (chunks) {
        await core.api.mtmd_input_chunks_free(chunks);
      }
    } finally {
      try {
        await freeBitmaps({ native, bitmaps });
      } finally {
        allocations.release();
      }
    }
  }
}

async function freeBitmaps({ native, bitmaps }: { native: LiveNative, bitmaps: bigint[] }): Promise<void> {
  let failure: { error: unknown } | undefined;
  for (const bitmap of bitmaps.reverse()) {
    try {
      await native.core.api.mtmd_bitmap_free(bitmap);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

export async function decodeLiveRows({ native, rows, count }: { native: LiveNative, rows: bigint, count: number }): Promise<void> {
  const { core, context, model, capacity } = native;
  if (!Number.isSafeInteger(count) || count < 1 || native.position + count + 2 >= capacity) {
    throw new LlamaCppBrowserError({ code: 'context-full' });
  }
  const dimension = await core.api.llama_model_n_embd_inp(model);
  if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 32768) {
    throw new Error('Invalid live embedding dimension');
  }
  // The stream's borrowed output is copied before allocating or decoding batches.
  const copy = new Uint8Array(core.bytes({ pointer: rows, length: count * dimension * 4 }));
  const batch = core.allocRecord({ name: 'llama_batch' });
  let initialized = false;
  try {
    const batchSize = Math.min(128, await core.api.llama_n_batch(context));
    if (batchSize < 1) {
      throw new Error('Invalid live batch size');
    }
    await core.api.llama_batch_init(batch, batchSize, dimension, 1);
    initialized = true;
    const field = ({ name }: { name: string }) => readAudioField({ core, pointer: batch, name: 'llama_batch', field: name, kind: 'pointer' });
    const embd = field({ name: 'embd' });
    const positions = field({ name: 'pos' });
    const counts = field({ name: 'n_seq_id' });
    const sequences = field({ name: 'seq_id' });
    const logits = field({ name: 'logits' });
    for (let offset = 0; offset < count; offset += batchSize) {
      const n = Math.min(batchSize, count - offset);
      core.bytes({ pointer: embd, length: n * dimension * 4 }).set(copy.subarray(offset * dimension * 4, (offset + n) * dimension * 4));
      const write = ({ pointer, value }: { pointer: bigint, value: number }) => {
        const bytes = core.bytes({ pointer, length: 4 });
        new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(0, value, true);
      };
      for (let i = 0; i < n; i++) {
        write({ pointer: positions + BigInt(4 * i), value: native.position + i });
        write({ pointer: counts + BigInt(4 * i), value: 1 });
        const sequence = readAudioScalar({ core, pointer: sequences + BigInt(core.pointerBytes * i), kind: 'pointer' });
        write({ pointer: sequence, value: 0 });
      }
      core.bytes({ pointer: logits, length: n }).fill(0);
      core.setField({ name: 'llama_batch', pointer: batch, field: 'n_tokens', value: n });
      if (await core.api.llama_decode(context, batch) !== 0) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      native.position += n;
    }
  } finally {
    try {
      if (initialized) {
        await core.api.llama_batch_free(batch);
      }
    } finally {
      core.free({ pointer: batch });
    }
  }
}

export const TEST_ONLY = {
};
