import { vi } from 'vitest';
import { audioNativeFixture } from '@/features/audio-generation/test-utils/native.test-support';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { NativeChat, ChatPromptPart, ChatParams } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import type { GenerateInput } from '@/features/llama-cpp-browser/types';

/** ABI-shaped ownership fixture, not model inference. Missing APIs deliberately
 * fail rather than fabricating a working inference backend. */
export function liveNativeFixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const base = audioNativeFixture({ pointerBytes });
  const state = { position: 0, streamRows: 0, throwTemplate: false, audioChunks: 0 };
  const templateDisposals: ReturnType<typeof vi.fn>[] = [];
  const constants: Record<string, number> = {
    MTMD_GEN_AUDIO_TYPE_LFM3A: 4,
    MTMD_HELPER_GEN_AUDIO_OUTTYPE_PCM: 0,
    MTMD_HELPER_GEN_AUDIO_OUT_TEXT: 1,
    MTMD_HELPER_GEN_AUDIO_OUT_AUDIO: 2,
    MTMD_HELPER_GEN_AUDIO_OUT_MIXED: 3,
  };
  base.controls.nativeType = 4;
  const api = {
    ...base.api,
    mtmd_support_audio_stream: vi.fn(async () => 1),
    mtmd_support_vision: vi.fn(async () => 1),
    mtmd_gen_audio_get_info: vi.fn(async (out: bigint) => {
      base.write({ pointer: out, value: base.controls.nativeType, size: 4, signed: true });
      base.write({ pointer: out + 4n, value: 24000, size: 4, signed: true });
    }),
    mtmd_get_audio_sample_rate: vi.fn(async () => 16000),
    llama_model_get_vocab: vi.fn(async () => 90n),
    llama_memory_seq_pos_max: vi.fn(async () => state.position - 1),
    llama_memory_clear: vi.fn(async () => {
      state.position = 0;
    }),
    llama_state_seq_get_size: vi.fn(async () => 32n),
    llama_state_seq_get_data: vi.fn(async (_context: bigint, out: bigint) => {
      base.write({ pointer: out, value: state.position, size: 4, signed: true });
      return 32n;
    }),
    llama_state_seq_set_data: vi.fn(async (_context: bigint, data: bigint) => {
      const bytes = base.core.bytes({ pointer: data, length: 4 });
      state.position = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
      return 32n;
    }),
    mtmd_audio_stream_params_default: vi.fn(async () => {}),
    mtmd_audio_stream_init: vi.fn(async () => 51n),
    mtmd_audio_stream_free: vi.fn(async () => {}),
    mtmd_audio_stream_push: vi.fn(async () => {
      state.streamRows++;
      return 0;
    }),
    mtmd_audio_stream_step: vi.fn(async (): Promise<number> => {
      if (state.streamRows) {
        state.streamRows--;
        return 1;
      }
      return 0;
    }),
    mtmd_audio_stream_get_output_embd: vi.fn(async () => 10000n),
    mtmd_audio_stream_flush: vi.fn(async () => 0),
    llama_set_embeddings: vi.fn(async () => {}),
    mtmd_helper_gen_audio_inp_default: vi.fn(async () => {}),
    mtmd_helper_gen_audio_get_logit_bias: vi.fn(async () => 0n),
    mtmd_helper_gen_audio_next_is_text: vi.fn(async () => base.controls.steps % 2 === 0 ? 1 : 0),
    mtmd_helper_gen_audio_flush: vi.fn(async () => 0),
    llama_model_n_embd: vi.fn(async () => 16),
    llama_vocab_is_control: vi.fn(async () => 0),
    llama_vocab_is_eog: vi.fn(async () => 0),
    llama_token_to_piece: vi.fn(async (_vocab: bigint, _token: number, out: bigint) => {
      base.core.bytes({ pointer: out, length: 4 }).set(new TextEncoder().encode('word'));
      return 4;
    }),
    mtmd_helper_gen_audio_step_prompt: vi.fn(async () => {
      state.position += 2;
      return 0;
    }),
    mtmd_helper_gen_audio_step_gen: vi.fn(async (_helper: bigint, _token: number, _hidden: bigint, hiddenOut: bigint, stopOut: bigint) => {
      if (base.controls.growDuringStep) {
        base.grow();
        base.controls.growDuringStep = false;
      }
      const stop = base.controls.steps >= base.controls.stopAfter;
      base.write({ pointer: hiddenOut, value: stop ? 0n : 10000n, size: pointerBytes, signed: false });
      base.write({ pointer: stopOut, value: stop ? 1 : 0, size: 1, signed: false });
      if (!stop) {
        state.position++;
        base.controls.steps++;
        state.audioChunks++;
      }
      return 0;
    }),
    mtmd_helper_gen_audio_get_output: vi.fn(async (_helper: bigint, rate: bigint, data: bigint, length: bigint) => {
      const count = state.audioChunks > 0 ? 2 : 0;
      state.audioChunks = 0;
      base.core.bytes({ pointer: base.outputPointer, length: 8 }).set(new Uint8Array(new Float32Array([0.25, 0.5]).buffer));
      base.write({ pointer: rate, value: 24000, size: 4, signed: true });
      base.write({ pointer: data, value: base.outputPointer, size: pointerBytes, signed: false });
      base.write({ pointer: length, value: count * 4, size: pointerBytes, signed: false });
      return 0;
    }),
  };
  const prepare = vi.fn(({ request, generationPrompt }: { request: Pick<GenerateInput, 'messages' | 'tools' | 'reasoningEffort'>, generationPrompt: 'include' | 'omit' | undefined }) => {
    if (state.throwTemplate) {
      throw new Error('template failed');
    }
    const promptParts: ChatPromptPart[] = [{ text: '<bos>', isInput: false }];
    for (const message of request.messages) {
      promptParts.push({ text: `<${message.role}>`, isInput: false });
      promptParts.push({ text: typeof message.content === 'string' ? message.content : 'image', isInput: true });
      promptParts.push({ text: '</turn>', isInput: false });
    }
    let includePrompt: boolean;
    switch (generationPrompt) {
    case 'include': case undefined: includePrompt = true;
      break;
    case 'omit': includePrompt = false;
      break;
    default: {
      const exhaustive: never = generationPrompt;
      throw new Error(String(exhaustive));
    }
    }
    if (includePrompt) {
      promptParts.push({ text: '<assistant>', isInput: false });
    }
    const dispose = vi.fn();
    templateDisposals.push(dispose);
    const result = {
      prompt: promptParts.map(part => part.text).join(''),
      promptParts,
      images: [],
      additionalStops: [],
      params: { generation_prompt: '<assistant>' } as ChatParams,
      dispose,
      parse: ({ text }: { text: string, partial: boolean }) => ({ content: text, reasoningContent: '', toolCalls: [] }),
    };
    return result;
  });
  const core = {
    ...base.core,
    api,
    alloc: ({ bytes }: { bytes: number | bigint }) => base.core.alloc({ bytes: Number(bytes) }),
    chat: { prepare: ({ request }: { request: Pick<GenerateInput, 'messages' | 'tools' | 'reasoningEffort'> }) => prepare({ request, generationPrompt: undefined }), prepareWithGenerationPrompt: prepare, releaseModel: vi.fn() } as NativeChat,
    constant: ({ name }: { name: string }) => constants[name] ?? base.core.constant({ name }),
    fieldLayout: ({ name, field }: { name: string, field: string }) => {
      if (name === 'mtmd_gen_audio_info' && field === 'sample_rate') {
        return { kind: 'signed', offset: 4n, size: 4 };
      }
      return base.core.fieldLayout({ name, field });
    },
  } as unknown as Core;
  return { ...base, core, api, state, prepare, templateDisposals };
}

export const TEST_ONLY = {
};
