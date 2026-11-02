import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { NativeChat } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import type { LiveAnswer, LiveCommand, LiveEventHandler } from '@/features/llama-cpp-browser/live-types';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { createAudioCooperator } from './audio-cooperate';
import { readAudioScalar } from './audio-memory';
import { createChatSampler } from './chat-sampler';
import { createTokenRenderer } from './token-renderer';
import { createLiveAllocations, type LiveNative } from './live-memory';

type Prepared = ReturnType<NativeChat['prepare']>;

async function createLiveSampler({ core, native, helper, prepared }: { core: Core, native: LiveNative, helper: bigint, prepared: Prepared }) {
  const allocations = createLiveAllocations({ core });
  let chain = 0n;
  let child = 0n;
  try {
    const params = allocations.record({ name: 'llama_sampler_chain_params' });
    await core.api.llama_sampler_chain_default_params(params);
    chain = await core.api.llama_sampler_chain_init(params);
    if (!chain) {
      throw new Error('Cannot create live sampler');
    }
    const countOut = allocations.alloc({ bytes: core.pointerBytes });
    const bias = await core.api.mtmd_helper_gen_audio_get_logit_bias(helper, countOut);
    const count = Number(readAudioScalar({ core, pointer: countOut, kind: 'size' }));
    if (!Number.isSafeInteger(count) || count < 0 || count > 1024 || (count > 0 && !bias)) {
      throw new Error('Invalid live logit bias');
    }
    const creators = [
      ...(count ? [async () => core.api.llama_sampler_init_logit_bias(await core.api.llama_vocab_n_tokens(native.vocab), count, bias)] : []),
      () => core.api.llama_sampler_init_top_k(50),
      () => core.api.llama_sampler_init_top_p(0.9, 1n),
      () => core.api.llama_sampler_init_temp(0.7),
      () => core.api.llama_sampler_init_dist(4294967295),
    ];
    for (const create of creators) {
      child = await create();
      if (!child) {
        throw new Error('Cannot create live sampling stage');
      }
      await core.api.llama_sampler_chain_add(chain, child);
      child = 0n;
    }
    // createChatSampler takes ownership even if its own initialization fails.
    const owned = chain;
    chain = 0n;
    return await createChatSampler({ core, vocab: native.vocab, chain: owned, params: prepared.params });
  } finally {
    try {
      if (child) {
        await core.api.llama_sampler_free(child);
      }
    } finally {
      try {
        if (chain) {
          await core.api.llama_sampler_free(chain);
        }
      } finally {
        allocations.release();
      }
    }
  }
}

/** Calls upstream's public multimodal generation helper. Audio code sampling,
 * codec state and text/audio interleaving stay in llama.cpp, not in TypeScript. */
export async function generateLiveAnswer({ native, prepared, prompt, turnId, output, maxSteps, interrupted, signal, onEvent }: {
  native: LiveNative, prepared: Prepared, prompt: string, turnId: string,
  output: Extract<LiveCommand, { type: 'respond' }>['output'], maxSteps: number,
  interrupted: () => boolean, signal: AbortSignal | undefined, onEvent: LiveEventHandler,
}): Promise<LiveAnswer> {
  const { core, context, projector, vocab, capacity } = native;
  const api = core.api;
  const allocations = createLiveAllocations({ core });
  const renderer = createTokenRenderer({ core, vocab, cacheMode: 'bounded' });
  const cooperate = createAudioCooperator({ signal });
  let helper = 0n;
  let sampler: Awaited<ReturnType<typeof createLiveSampler>> | undefined;
  let raw = '';
  let visible = '';
  let finishReason: LiveAnswer['finishReason'] = 'limit';
  let deliveredSamples = 0;
  try {
    if (!native.position) {
      throw new Error('A live answer must continue an input turn');
    }
    await api.llama_set_embeddings(context, 1);
    helper = await api.mtmd_helper_gen_audio_init(context, projector);
    if (!helper) {
      throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
    }
    const input = allocations.record({ name: 'mtmd_helper_gen_audio_inp' });
    await api.mtmd_helper_gen_audio_inp_default(input);
    const mode = (() => {
      switch (output) {
      case 'text': return 'MTMD_HELPER_GEN_AUDIO_OUT_TEXT';
      case 'audio': return 'MTMD_HELPER_GEN_AUDIO_OUT_AUDIO';
      case 'mixed': return 'MTMD_HELPER_GEN_AUDIO_OUT_MIXED';
      default: {
        const exhaustive: never = output;
        throw new Error(String(exhaustive));
      }
      }
    })();
    for (const [field, value] of Object.entries({
      stream: 1,
      seq_id: 0,
      n_past: native.position,
      prompt: allocations.text({ text: prompt }),
      prompt_len: BigInt(new TextEncoder().encode(prompt).length),
      out_mode: core.constant({ name: mode }),
      out_type: core.constant({ name: 'MTMD_HELPER_GEN_AUDIO_OUTTYPE_PCM' }),
    })) {
      core.setField({ name: 'mtmd_helper_gen_audio_inp', pointer: input, field, value });
    }
    if (await api.mtmd_helper_gen_audio_set_input(helper, input) !== 0) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    while (true) {
      await cooperate({ force: false });
      if (interrupted()) {
        return { type: 'answer', turnId, text: '', toolCalls: [], finishReason: 'interrupted' };
      }
      const remaining = await api.mtmd_helper_gen_audio_step_prompt(helper, 128);
      native.position = await api.llama_memory_seq_pos_max(native.memory, 0) + 1;
      if (remaining < 0) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      if (native.position + remaining + 2 >= capacity) {
        throw new LlamaCppBrowserError({ code: 'context-full' });
      }
      if (!remaining) {
        break;
      }
    }
    sampler = await createLiveSampler({ core, native, helper, prepared });
    const dimension = await api.llama_model_n_embd(native.model);
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 32768) {
      throw new Error('Invalid hidden-state dimension');
    }
    const hidden = allocations.alloc({ bytes: dimension * 4 });
    const copyHidden = ({ source }: { source: bigint }) => {
      if (!source) {
        throw new Error('Missing live hidden state');
      }
      core.bytes({ pointer: hidden, length: dimension * 4 }).set(core.bytes({ pointer: source, length: dimension * 4 }));
    };
    copyHidden({ source: await api.llama_get_embeddings_ith(context, -1) });
    const hiddenOut = allocations.alloc({ bytes: core.pointerBytes });
    const stopOut = allocations.alloc({ bytes: 1 });
    const rateOut = allocations.alloc({ bytes: 4 });
    const dataOut = allocations.alloc({ bytes: core.pointerBytes });
    const lengthOut = allocations.alloc({ bytes: core.pointerBytes });
    const readAudio = async () => {
      if (await api.mtmd_helper_gen_audio_get_output(helper, rateOut, dataOut, lengthOut, 0n) !== 0) {
        throw new Error('Cannot read live audio');
      }
      const length = Number(readAudioScalar({ core, pointer: lengthOut, kind: 'size' }));
      if (!Number.isSafeInteger(length) || length < 0 || length % 4 !== 0 || length > 192000 * 4) {
        throw new Error('Invalid live audio length');
      }
      if (!length || interrupted()) {
        return;
      }
      const sampleRate = Number(readAudioScalar({ core, pointer: rateOut, kind: 'i32' }));
      const pointer = readAudioScalar({ core, pointer: dataOut, kind: 'pointer' });
      if (!pointer || sampleRate < 8000 || sampleRate > 96000) {
        throw new Error('Invalid live audio format');
      }
      deliveredSamples += length / 4;
      if (deliveredSamples > sampleRate * 180) {
        throw new Error('Live answer exceeded three minutes');
      }
      const bytes = new Uint8Array(core.bytes({ pointer, length }));
      const pcm = new Float32Array(bytes.buffer);
      await onEvent({ event: { type: 'audio', pcm, sampleRate } });
    };
    for (let step = 0; step < maxSteps; step++) {
      await cooperate({ force: false });
      if (interrupted()) {
        finishReason = 'interrupted';
        break;
      }
      if (native.position + 2 >= capacity) {
        break;
      }
      const token = await api.mtmd_helper_gen_audio_next_is_text(helper)
        ? await sampler.sample({ context }) : core.constant({ name: 'LLAMA_TOKEN_NULL' });
      core.bytes({ pointer: stopOut, length: 1 }).fill(0);
      core.bytes({ pointer: hiddenOut, length: core.pointerBytes }).fill(0);
      if (await api.mtmd_helper_gen_audio_step_gen(helper, token, hidden, hiddenOut, stopOut) !== 0) {
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      const stop = readAudioScalar({ core, pointer: stopOut, kind: 'bool' }) !== 0n;
      const nextHidden = readAudioScalar({ core, pointer: hiddenOut, kind: 'pointer' });
      if (nextHidden) {
        copyHidden({ source: nextHidden });
      } else if (!stop) {
        throw new Error('Live generation lost its hidden state');
      }
      native.position = await api.llama_memory_seq_pos_max(native.memory, 0) + 1;
      if (interrupted()) {
        finishReason = 'interrupted';
        break;
      }
      if (!stop && token !== core.constant({ name: 'LLAMA_TOKEN_NULL' })) {
        const preserved = sampler.preservedTokens.has(token);
        if (preserved || !await api.llama_vocab_is_control(vocab, token)) {
          raw += (await renderer.render({ token, special: preserved })).text;
          if (raw.length > 131072) {
            throw new Error('Live answer text is too large');
          }
          const parsed = prepared.parse({ text: raw, partial: true });
          if (parsed.content !== visible) {
            visible = parsed.content;
            await onEvent({ event: { type: 'text', text: visible } });
          }
        }
      }
      await readAudio();
      if (stop) {
        finishReason = 'stop';
        break;
      }
    }
    switch (finishReason) {
    case 'interrupted': break;
    case 'stop': case 'limit': {
      if (await api.mtmd_helper_gen_audio_flush(helper) !== 0) {
        throw new Error('Cannot flush live audio');
      }
      await readAudio();
      break;
    }
    default: {
      const exhaustive: never = finishReason;
      throw new Error(String(exhaustive));
    }
    }
    // A callback can deliver an interrupt while the final audio is acknowledged.
    if (interrupted()) {
      finishReason = 'interrupted';
    }
    raw += renderer.finish();
    switch (finishReason) {
    case 'stop': {
      const parsed = prepared.parse({ text: raw, partial: false });
      return { type: 'answer', turnId, text: parsed.content, toolCalls: parsed.toolCalls, finishReason };
    }
    case 'limit': case 'interrupted':
      return { type: 'answer', turnId, text: prepared.parse({ text: raw, partial: true }).content, toolCalls: [], finishReason };
    default: {
      const exhaustive: never = finishReason;
      throw new Error(String(exhaustive));
    }
    }
  } finally {
    try {
      await sampler?.dispose();
    } finally {
      try {
        if (helper) {
          await api.mtmd_helper_gen_audio_free(helper);
        }
      } finally {
        try {
          renderer.dispose();
        } finally {
          allocations.release();
        }
      }
    }
  }
}

export const TEST_ONLY = {
};
