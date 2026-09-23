import { audioGenerationInputSchema, audioGenerationResultSchema, MAX_AUDIO_BYTES, type AudioGenerationResult } from '@/features/audio-generation/types';
import { validateAudioWav } from '@/features/audio-generation/wav';
import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import { LlamaCppBrowserError, type Progress } from '@/features/llama-cpp-browser/types';
import { logFailure, logOperation, type DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import { AUDIO_LANGUAGE_AUTO_QUERY } from '@/features/llama-cpp-browser/runtime/audio-capabilities';
import { prepareAudioSession, releaseSession } from './session';
import { createAudioCooperator } from './audio-cooperate';
import { readAudioField, readAudioScalar } from './audio-memory';
import type { WorkerAudioInput } from './types';

type AudioCapabilities = { pipeline: AudioGenerationResult['pipeline'], reference: 'optional' | 'required', language: 'selectable' | 'weights', sampling: 'token' | 'continuous' };
export function audioCapabilities({ core, nativeType }: { core: Core, nativeType: number }): AudioCapabilities {
  if (nativeType === core.constant({ name: 'MTMD_GEN_AUDIO_TYPE_QWEN3TTS' })) return { pipeline: 'qwen3-tts', reference: 'optional', language: 'selectable', sampling: 'token' };
  if (nativeType === core.constant({ name: 'MTMD_GEN_AUDIO_TYPE_POCKETTTS' })) return { pipeline: 'pocket-tts', reference: 'required', language: 'weights', sampling: 'continuous' };
  throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
}

/** The wrapper owns model lifetime even if session preparation itself fails. */
export async function generateAudio({ request, onProgress, signal }: {
  request: WorkerAudioInput, onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}): Promise<AudioGenerationResult> {
  try {
    const { core, context, projector } = await prepareAudioSession({ request, contextTokens: request.contextTokens, audioBackend: request.audioBackend, onProgress, signal });
    return await synthesizeAudio({ core, context, projector, request, onProgress, signal });
  } finally {
    await releaseSession({ releaseRuntime: false });
  }
}

/** A model-independent transcription of upstream llama-tts's native helper loop.
 * No chat templates, JS token rendering, or model-specific audio graph in Naidan. */
export async function synthesizeAudio({ core, context, projector, request, onProgress, signal }: {
  core: Core, context: bigint, projector: bigint, request: WorkerAudioInput,
  onProgress: ({ progress }: { progress: Progress }) => void, signal: AbortSignal | undefined,
}): Promise<AudioGenerationResult> {
  // The wire schema also includes transport-only fields; validate the model input separately.
  const { assetBaseURL: _assetBaseURL, ...input } = request;
  const accepted = audioGenerationInputSchema.parse(input);
  const api = core.api;
  let stage: DiagnosticStage = 'audio-info';
  const allocations: bigint[] = [];
  let helper = 0n; let speaker = 0n; let sampler = 0n;
  let abortCallback: number | bigint | undefined;
  const alloc = ({ bytes }: { bytes: number }): bigint => {
    const pointer = core.alloc({ bytes }); allocations.push(pointer); core.bytes({ pointer, length: bytes }).fill(0); return pointer;
  };
  const record = ({ name }: { name: string }): bigint => {
    const pointer = core.allocRecord({ name }); allocations.push(pointer); return pointer;
  };
  const string = ({ text }: { text: string }): bigint => {
    const pointer = core.utf8({ text }); allocations.push(pointer); return pointer;
  };
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  const yieldControl = createAudioCooperator({ signal });
  const checked = async ({ call }: { call: () => Promise<number> }): Promise<number> => {
    checkCancelled();
    await logOperation({ diagnostic: { event: 'operation-start', stage, mediaType: 'audio' } });
    const started = performance.now();
    const status = await call();
    await logOperation({ diagnostic: { event: 'operation-complete', stage, mediaType: 'audio', statusCode: status, elapsedMs: performance.now() - started } });
    checkCancelled(); return status;
  };
  try {
    checkCancelled();
    if (projector === 0n) throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
    const info = record({ name: 'mtmd_gen_audio_info' });
    await api.mtmd_gen_audio_get_info(info, projector);
    const capabilities = audioCapabilities({ core, nativeType: Number(readAudioField({ core, pointer: info, name: 'mtmd_gen_audio_info', field: 'type', kind: 'i32' })) });
    stage = 'audio-reference';
    if (!accepted.reference && capabilities.reference === 'required') throw new LlamaCppBrowserError({ code: 'audio-reference-required' });
    if (accepted.reference) {
      const encoded = new Uint8Array(await accepted.reference.arrayBuffer()); checkCancelled();
      const buffer = alloc({ bytes: encoded.length }); core.bytes({ pointer: buffer, length: encoded.length }).set(encoded);
      const opts = record({ name: 'mtmd_helper_init_opt' }); await api.mtmd_helper_init_opt_default(opts);
      const wrapper = record({ name: 'mtmd_helper_bitmap_wrapper' });
      await api.mtmd_helper_bitmap_init_from_buf(wrapper, projector, buffer, BigInt(encoded.length), 0, opts);
      speaker = readAudioField({ core, pointer: wrapper, name: 'mtmd_helper_bitmap_wrapper', field: 'bitmap', kind: 'pointer' });
      if (!speaker || !await api.mtmd_bitmap_is_audio(speaker)) throw new LlamaCppBrowserError({ code: 'audio-reference-invalid' });
      // Bound decoded references too. The native decoder has already allocated its
      // output here; the encoded input cap is a separate, earlier protection.
      const sampleRate = await api.mtmd_get_audio_sample_rate(projector);
      if (sampleRate <= 0 || await api.mtmd_bitmap_get_n_bytes(speaker) > BigInt(sampleRate * 30 * 4)) throw new LlamaCppBrowserError({ code: 'audio-reference-invalid' });
    }
    abortCallback = core.module.addFunction(() => signal?.aborted ? 1 : 0, core.pointerBytes === 8 ? 'ij' : 'ii');
    await api.llama_set_abort_callback(context, BigInt(abortCallback), 0n);
    helper = await api.mtmd_helper_gen_audio_init(context, projector);
    if (!helper) throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
    if (accepted.language === 'auto' && capabilities.language === 'selectable') {
      const query: unknown = Reflect.get(api, AUDIO_LANGUAGE_AUTO_QUERY);
      // Missing support must never silently become English, or a guessed script.
      if (typeof query !== 'function' || await Reflect.apply(query, api, [helper]) !== 1) {
        throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      }
    }
    const params = record({ name: 'mtmd_helper_gen_audio_inp' });
    const language = capabilities.language === 'weights' || accepted.language === 'default' ? 0n : string({ text: accepted.language });
    for (const [field, value] of Object.entries({ seq_id: 0, prompt: string({ text: accepted.text }), prompt_len: BigInt(new TextEncoder().encode(accepted.text).length), speaker_ref: speaker, lang: language, top_k: accepted.topK, top_p: accepted.topP, seed: accepted.seed, out_type: core.constant({ name: 'MTMD_HELPER_GEN_AUDIO_OUTTYPE_WAV' }) })) {
      core.setField({ name: 'mtmd_helper_gen_audio_inp', pointer: params, field, value });
    }
    stage = 'audio-input';
    if (await checked({ call: () => api.mtmd_helper_gen_audio_set_input(helper, params) }) !== 0) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    const capacity = await api.llama_n_ctx(context); const memory = await api.llama_get_memory(context);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !memory) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    stage = 'audio-prompt';
    let processed = 0;
    while (true) {
      await yieldControl({ force: false });
      const remaining = await checked({ call: () => api.mtmd_helper_gen_audio_step_prompt(helper, 128) });
      if (remaining < 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      processed = await api.llama_memory_seq_pos_max(memory, 0) + 1;
      onProgress({ progress: { phase: 'prefill', completed: Math.max(0, processed), total: Math.max(0, processed + remaining) } });
      if (processed + remaining >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
      if (remaining === 0) break;
    }
    switch (capabilities.sampling) {
    case 'token':
      stage = 'sampler-create';
      sampler = await createAudioSampler({ core, temperature: accepted.temperature, topK: accepted.topK, topP: accepted.topP, seed: accepted.seed });
      break;
    case 'continuous': break;
    default: { const exhaustive: never = capabilities.sampling; throw new Error(String(exhaustive)); }
    }
    const hiddenOut = alloc({ bytes: core.pointerBytes }); const stopOut = alloc({ bytes: 1 });
    let hidden = await api.llama_get_embeddings_ith(context, -1);
    if (!hidden) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    let frames = 0; let finishReason: AudioGenerationResult['finishReason'] = 'frame-limit';
    while (frames < accepted.maxFrames) {
      await yieldControl({ force: false });
      if (await api.llama_memory_seq_pos_max(memory, 0) + 1 >= capacity) {
        finishReason = 'context-limit'; break;
      }
      stage = 'audio-frame';
      // llama_sampler_sample already accepts the token; do not accept it twice.
      const token = sampler ? await api.llama_sampler_sample(sampler, context, -1) : core.constant({ name: 'LLAMA_TOKEN_NULL' });
      core.bytes({ pointer: hiddenOut, length: core.pointerBytes }).fill(0); core.bytes({ pointer: stopOut, length: 1 }).fill(0);
      if (await checked({ call: () => api.mtmd_helper_gen_audio_step_gen(helper, token, hidden, hiddenOut, stopOut) }) !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      hidden = readAudioScalar({ core, pointer: hiddenOut, kind: 'pointer' });
      const stop = readAudioScalar({ core, pointer: stopOut, kind: 'bool' }) !== 0n;
      if (hidden) frames++;
      onProgress({ progress: { phase: 'generating', completed: frames, total: accepted.maxFrames } });
      if (stop || !hidden) {
        finishReason = 'stop'; break;
      }
    }
    stage = 'audio-output';
    onProgress({ progress: { phase: 'decoding-audio', completed: 0, total: 0 } });
    await yieldControl({ force: true });
    const rateOut = alloc({ bytes: 4 }); const dataOut = alloc({ bytes: core.pointerBytes });
    const lengthOut = alloc({ bytes: core.pointerBytes }); const samplesOut = alloc({ bytes: 8 });
    if (await checked({ call: () => api.mtmd_helper_gen_audio_get_output(helper, rateOut, dataOut, lengthOut, samplesOut) }) !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const sampleRate = Number(readAudioScalar({ core, pointer: rateOut, kind: 'i32' }));
    const samples = Number(readAudioScalar({ core, pointer: samplesOut, kind: 'i64' }));
    const length = readAudioScalar({ core, pointer: lengthOut, kind: 'size' });
    const data = readAudioScalar({ core, pointer: dataOut, kind: 'pointer' });
    if (!frames || !data || length <= 44n || samples <= 0) throw new LlamaCppBrowserError({ code: 'audio-output-empty' });
    if (length > BigInt(MAX_AUDIO_BYTES) || !Number.isSafeInteger(samples)) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    // Native output is borrowed until the helper is freed/reset. Own the copy
    // before cleanup and before crossing the worker boundary.
    const wav = new Uint8Array(core.bytes({ pointer: data, length }));
    validateAudioWav({ wav, sampleRate, samples });
    return audioGenerationResultSchema.parse({ wav, sampleRate, samples, frames, finishReason, pipeline: capabilities.pipeline });
  } catch (error) {
    logFailure({ stage, error }); throw error;
  } finally {
    // Keep dependencies alive while destructing their consumers. Worker disposal
    // remains the last resort when native cleanup itself traps.
    try {
      if (helper) await api.mtmd_helper_gen_audio_free(helper);
    } finally {
      try {
        if (sampler) await api.llama_sampler_free(sampler);
      } finally {
        try {
          if (speaker) await api.mtmd_bitmap_free(speaker);
        } finally {
          if (abortCallback !== undefined) {
            await api.llama_set_abort_callback(context, 0n, 0n);
            core.module.removeFunction(abortCallback);
          }
          for (const pointer of allocations.reverse()) core.free({ pointer });
        }
      }
    }
  }
}

async function createAudioSampler({ core, temperature, topK, topP, seed }: {
  core: Core, temperature: number, topK: number, topP: number, seed: number,
}): Promise<bigint> {
  if (temperature === 0) {
    const greedy = await core.api.llama_sampler_init_greedy();
    if (!greedy) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    return greedy;
  }
  const options = core.allocRecord({ name: 'llama_sampler_chain_params' });
  let chain = 0n; let child = 0n;
  try {
    await core.api.llama_sampler_chain_default_params(options);
    chain = await core.api.llama_sampler_chain_init(options);
    if (!chain) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    for (const create of [() => core.api.llama_sampler_init_top_k(topK), () => core.api.llama_sampler_init_top_p(topP, 1n), () => core.api.llama_sampler_init_temp(temperature), () => core.api.llama_sampler_init_dist(seed)]) {
      child = await create();
      if (!child) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      await core.api.llama_sampler_chain_add(chain, child); child = 0n;
    }
    return chain;
  } catch (error) {
    try {
      if (child) await core.api.llama_sampler_free(child);
    } finally {
      if (chain) await core.api.llama_sampler_free(chain);
    }
    throw error;
  } finally {
    core.free({ pointer: options });
  }
}
export const TEST_ONLY = {
};
