import { logFailure, type DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { decodeImage } from '@/features/llama-cpp-browser/runtime/image-input';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

export function splitImagePrompt({ prompt, images }: { prompt: string, images: { marker: string, blob: Blob }[] }): ({ type: 'text', text: string } | { type: 'image', blob: Blob })[] {
  const parts: ({ type: 'text', text: string } | { type: 'image', blob: Blob })[] = [];
  let offset = 0;
  for (const { marker, blob } of images) {
    const position = prompt.indexOf(marker, offset);
    if (position < 0 || prompt.indexOf(marker, position + marker.length) !== -1) throw new LlamaCppBrowserError({ code: 'template-unsupported' });
    if (position > offset) parts.push({ type: 'text', text: prompt.slice(offset, position) });
    parts.push({ type: 'image', blob }); offset = position + marker.length;
  }
  if (offset < prompt.length) parts.push({ type: 'text', text: prompt.slice(offset) });
  return parts;
}
/** Native mtmd owns image preprocessing, embedding and model-specific positions. */
export async function prepareMultimodal({ core, projector, prompt, images }: {
  core: Core, projector: bigint, prompt: string, images: { marker: string, blob: Blob }[],
}): Promise<{ positions: number, tokenCount: number, textTokens: number[], evaluate: ({ context, capacity }: { context: bigint, capacity: number }) => Promise<number>, dispose: () => Promise<void> }> {
  if (projector === 0n) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  let stage: DiagnosticStage = 'image-decode';
  const allocations: bigint[] = []; const bitmaps: bigint[] = []; let chunks = 0n;
  const record = ({ name }: { name: string }): bigint => {
    const pointer = core.allocRecord({ name }); allocations.push(pointer); return pointer;
  };
  const allocate = ({ bytes }: { bytes: number }): bigint => {
    const pointer = core.alloc({ bytes }); allocations.push(pointer); return pointer;
  };
  const dispose = async (): Promise<void> => {
    if (chunks !== 0n) {
      const owned = chunks; chunks = 0n; await core.api.mtmd_input_chunks_free(owned);
    }
  };
  try {
    const parts: bigint[] = [];
    for (const part of splitImagePrompt({ prompt, images })) {
      const input = record({ name: 'mtmd_input_part' }); parts.push(input);
      switch (part.type) {
      case 'text': {
        const text = record({ name: 'mtmd_input_text' }); const data = core.utf8({ text: part.text }); allocations.push(data);
        for (const [field, value] of Object.entries({ text: data, text_len: BigInt(new TextEncoder().encode(part.text).length), add_special: 0, parse_special: 1 })) core.setField({ name: 'mtmd_input_text', pointer: text, field, value });
        core.setField({ name: 'mtmd_input_part', pointer: input, field: 'text', value: text }); break;
      }
      case 'image': {
        const { width, height, rgb } = await decodeImage({ blob: part.blob });
        const data = core.alloc({ bytes: rgb.byteLength }); core.bytes({ pointer: data, length: rgb.byteLength }).set(rgb);
        let bitmap: bigint;
        try {
          bitmap = await core.api.mtmd_bitmap_init(width, height, data);
        } finally {
          core.free({ pointer: data });
        }
        if (bitmap === 0n) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        bitmaps.push(bitmap); core.setField({ name: 'mtmd_input_part', pointer: input, field: 'bitmap', value: bitmap }); break;
      }
      default: { const exhaustive: never = part; throw new Error(`Unknown part: ${exhaustive}`); }
      }
    }
    const pointers = allocate({ bytes: parts.length * core.pointerBytes });
    const bytes = core.bytes({ pointer: pointers, length: parts.length * core.pointerBytes });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    parts.forEach((pointer, index) => {
      if (core.pointerBytes === 8) view.setBigUint64(index * 8, pointer, true); else view.setUint32(index * 4, Number(pointer), true);
    });
    stage = 'image-tokenize';
    chunks = await core.api.mtmd_input_chunks_init();
    if (chunks === 0n || await core.api.mtmd_tokenize_from_parts(projector, chunks, pointers, BigInt(parts.length), 1) !== 0) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    const count = await core.api.mtmd_input_chunks_size(chunks);
    // Sampling needs logits from a final text token, typically the assistant prefix.
    if (count === 0n || await core.api.mtmd_input_chunk_get_type(await core.api.mtmd_input_chunks_get(chunks, count - 1n)) !== core.constant({ name: 'MTMD_INPUT_CHUNK_TYPE_TEXT' })) throw new LlamaCppBrowserError({ code: 'template-unsupported' });
    const positions = await core.api.mtmd_helper_get_n_pos(chunks);
    const tokenCount = Number(await core.api.mtmd_helper_get_n_tokens(chunks));
    if (!Number.isSafeInteger(tokenCount) || tokenCount < 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const textTokens: number[] = [];
    const tokenSize = allocate({ bytes: core.pointerBytes });
    for (let index = 0n; index < count; index++) {
      const chunk = await core.api.mtmd_input_chunks_get(chunks, index);
      if (await core.api.mtmd_input_chunk_get_type(chunk) !== core.constant({ name: 'MTMD_INPUT_CHUNK_TYPE_TEXT' })) continue;
      const pointer = await core.api.mtmd_input_chunk_get_tokens_text(chunk, tokenSize);
      const sizeBytes = core.bytes({ pointer: tokenSize, length: core.pointerBytes }); const sizeView = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, sizeBytes.byteLength);
      const length = core.pointerBytes === 8 ? Number(sizeView.getBigUint64(0, true)) : sizeView.getUint32(0, true);
      const bytes = core.bytes({ pointer, length: length * 4 }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < length; index++) textTokens.push(view.getInt32(index * 4, true));
    }
    if (!Number.isSafeInteger(positions) || positions < 1) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    return { positions, tokenCount, textTokens, dispose, async evaluate({ context, capacity }) {
      const nextPosition = core.alloc({ bytes: 4 });
      try {
        core.bytes({ pointer: nextPosition, length: 4 }).fill(0);
        const status = await core.api.mtmd_helper_eval_chunks(projector, context, chunks, 0, 0, 128, 1, nextPosition);
        if (status !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
        const bytes = core.bytes({ pointer: nextPosition, length: 4 }); const position = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
        if (position < 1 || position >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
        return position;
      } catch (error) {
        logFailure({ stage: 'image-evaluate', error }); throw error;
      } finally {
        core.free({ pointer: nextPosition });
      }
    } };
  } catch (error) {
    logFailure({ stage, error });
    await dispose(); throw error;
  } finally {
    for (const bitmap of bitmaps.reverse()) await core.api.mtmd_bitmap_free(bitmap);
    for (const pointer of allocations.reverse()) core.free({ pointer });
  }
}
export const TEST_ONLY = {
};
