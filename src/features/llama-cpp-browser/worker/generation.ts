import type { Core } from 'llama-cpp-browser-core';
import { mountReadOnlyFile } from 'llama-cpp-browser-core';
import { LlamaCppBrowserError, usesWebGpu, type Progress } from '@/features/llama-cpp-browser/types';
import { storedModelHandle } from '@/features/llama-cpp-browser/runtime/model-store';
import { loadRuntime } from '@/features/llama-cpp-browser/runtime/load-runtime';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { WorkerGenerateInput } from './types';
import { createOutputStream } from './output-stream';

let cachedRuntime: { profile: WorkerGenerateInput['options']['profile'], assetBaseURL: string, core: Core } | undefined;

/** A request owns its model/context and file handle. A new request never reuses stale KV. */
export async function generate({ request, onChunk, onProgress }: {
  request: WorkerGenerateInput,
  onChunk: ({ chunk }: { chunk: string }) => void,
  onProgress: ({ progress }: { progress: Progress }) => void,
}): Promise<void> {
  const started = performance.now();
  const progress = ({ phase, completed, total }: Progress): void => onProgress({ progress: { phase, completed, total } });
  progress({ phase: 'initializing', completed: 0, total: 0 });
  if (!cachedRuntime || cachedRuntime.profile !== request.options.profile || cachedRuntime.assetBaseURL !== request.assetBaseURL) {
    if (cachedRuntime) await cachedRuntime.core.api.llama_backend_free();
    cachedRuntime = undefined;
    cachedRuntime = { profile: request.options.profile, assetBaseURL: request.assetBaseURL, core: await loadRuntime({ profile: request.options.profile, assetBaseURL: request.assetBaseURL }) };
  }
  const core = cachedRuntime.core; const api = core.api;
  const handle = await storedModelHandle({ name: request.model });
  // This API is deliberately Worker-only and is not in lib.dom.d.ts.
  const syncHandle = handle as FileSystemFileHandle & {
    createSyncAccessHandle?: () => Promise<{
      getSize(): number,
      // eslint-disable-next-line local-rules-named-args/require-named-args -- Native FileSystemSyncAccessHandle signature is positional.
      read(destination: Uint8Array, options: { at: number }): number,
      close(): void,
    }>,
  };
  if (!syncHandle.createSyncAccessHandle) throw new LlamaCppBrowserError({ code: 'unavailable' });
  const access = await syncHandle.createSyncAccessHandle();
  const allocations: bigint[] = []; let model = 0n; let context = 0n; let sampler = 0n;
  let callback: number | bigint | undefined;
  let mounted: ReturnType<typeof mountReadOnlyFile> | undefined;
  const alloc = ({ bytes }: { bytes: number | bigint }): bigint => {
    const p = core.alloc(bytes); allocations.push(p); return p;
  };
  const record = ({ name }: { name: string }): bigint => {
    const p = core.allocRecord(name); allocations.push(p); return p;
  };
  const string = ({ text }: { text: string }): bigint => {
    const p = core.utf8(text); allocations.push(p); return p;
  };
  try {
    mounted = mountReadOnlyFile(core, '/models/model.gguf', {
      size: access.getSize(), read(destination, offset) {
        return access.read(destination, { at: offset });
      },
    }, { maxChunkBytes: 8 * 1024 * 1024 });
    const params = record({ name: 'llama_model_params' }); await api.llama_model_default_params(params);
    for (const [field, value] of Object.entries({ n_gpu_layers: usesWebGpu({ profile: request.options.profile }) ? 999 : 0,
      load_mode: core.constant('LLAMA_LOAD_MODE_NONE'), lazy_mode: core.constant('LLAMA_LAZY_MODE_OFF'), check_tensors: 0 })) {
      core.setField('llama_model_params', params, field, value);
    }
    let lastProgress = 0;
    callback = core.module.addFunction((amount: number) => {
      if (performance.now() - lastProgress > 150) {
        progress({ phase: 'loading', completed: Math.max(0, Math.min(1, amount)), total: 1 }); lastProgress = performance.now();
      }
      return 1;
    }, core.pointerBytes === 8 ? 'ifj' : 'ifi');
    core.setField('llama_model_params', params, 'progress_callback', BigInt(callback));
    progress({ phase: 'loading', completed: 0, total: 1 });
    model = await api.llama_model_load_from_file(string({ text: mounted.path }), params);
    if (model === 0n) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    logDiagnostic({ diagnostic: { event: 'load-complete', elapsedMs: performance.now() - started, profile: request.options.profile } });
    const cp = record({ name: 'llama_context_params' }); await api.llama_context_default_params(cp);
    for (const [field, value] of Object.entries({ n_ctx: request.options.contextSize, n_batch: 128, n_ubatch: 128, n_threads: 1, n_threads_batch: 1 })) {
      core.setField('llama_context_params', cp, field, value);
    }
    context = await api.llama_init_from_model(model, cp);
    if (context === 0n) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const template = await api.llama_model_chat_template(model, 0n);
    if (template === 0n) throw new LlamaCppBrowserError({ code: 'template-unsupported' });
    const messageSize = core.recordSize('llama_chat_message');
    const chat = alloc({ bytes: messageSize * request.messages.length });
    request.messages.forEach((message, index) => {
      const address = chat + BigInt(index * messageSize);
      core.setField('llama_chat_message', address, 'role', string({ text: message.role }));
      core.setField('llama_chat_message', address, 'content', string({ text: message.content }));
    });
    const required = await api.llama_chat_apply_template(template, chat, BigInt(request.messages.length), 1, 0n, 0);
    if (required < 0) throw new LlamaCppBrowserError({ code: 'template-unsupported' });
    if (required > 4 * 1024 * 1024) throw new LlamaCppBrowserError({ code: 'context-full' });
    const prompt = alloc({ bytes: required + 1 });
    const promptLength = await api.llama_chat_apply_template(template, chat, BigInt(request.messages.length), 1, prompt, required + 1);
    if (promptLength < 0 || promptLength > required) throw new LlamaCppBrowserError({ code: 'template-unsupported' });
    const promptText = new TextDecoder().decode(core.bytes(prompt, promptLength));
    const vocab = await api.llama_model_get_vocab(model);
    const countResult = await api.llama_tokenize(vocab, prompt, promptLength, 0n, 0, 1, 1);
    const tokenCount = Math.abs(countResult);
    const capacity = await api.llama_n_ctx(context);
    if (tokenCount < 1 || tokenCount >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
    const tokens = alloc({ bytes: tokenCount * 4 });
    if (await api.llama_tokenize(vocab, prompt, promptLength, tokens, tokenCount, 1, 1) !== tokenCount) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const batch = record({ name: 'llama_batch' });
    for (let offset = 0; offset < tokenCount; offset += 128) {
      const count = Math.min(128, tokenCount - offset);
      await api.llama_batch_get_one(batch, tokens + BigInt(offset * 4), count);
      if (await api.llama_decode(context, batch) !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      progress({ phase: 'prefill', completed: offset + count, total: tokenCount });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const sp = record({ name: 'llama_sampler_chain_params' }); await api.llama_sampler_chain_default_params(sp);
    sampler = await api.llama_sampler_chain_init(sp);
    if (sampler === 0n) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const addSampler = async ({ child }: { child: bigint }): Promise<void> => {
      if (child === 0n) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      try {
        await api.llama_sampler_chain_add(sampler, child);
      } catch (error) {
        await api.llama_sampler_free(child); throw error;
      }
    };
    if (request.presencePenalty !== 0 || request.frequencyPenalty !== 0) {
      await addSampler({ child: await api.llama_sampler_init_penalties(await api.llama_vocab_n_tokens(vocab), capacity, 1, request.frequencyPenalty, request.presencePenalty) });
    }
    if (request.temperature === 0) await addSampler({ child: await api.llama_sampler_init_greedy() });
    else {
      await addSampler({ child: await api.llama_sampler_init_top_k(40) });
      await addSampler({ child: await api.llama_sampler_init_top_p(request.topP, 1n) });
      await addSampler({ child: await api.llama_sampler_init_temp(request.temperature) });
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      if (seed === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      await addSampler({ child: await api.llama_sampler_init_dist(seed) });
    }
    if (request.presencePenalty !== 0 || request.frequencyPenalty !== 0) {
      for (let index = 0; index < tokenCount; index++) {
        const bytes = core.bytes(tokens + BigInt(index * 4), 4);
        await api.llama_sampler_accept(sampler, new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true));
      }
    }
    // Prime only the unfinished assistant header, never prompt body text. This
    // handles templates ending before or after the Harmony message separator.
    const harmonyHeader = promptText.match(/<\|start\|>assistant(?:<\|channel\|>[a-z_]+)?(?:<\|message\|>)?$/)?.[0];
    const stream = createOutputStream({ stops: request.stop, harmony: harmonyHeader !== undefined, initialChannel: 'final' });
    if (harmonyHeader !== undefined) stream.push({ text: harmonyHeader });
    const decoder = new TextDecoder(); const nextToken = alloc({ bytes: 4 });
    let piece = alloc({ bytes: 256 }); let pieceCapacity = 256; let generated = 0;
    const maximum = Math.min(request.maxTokens, capacity - tokenCount);
    logDiagnostic({ diagnostic: { event: 'generation-start', tokens: tokenCount } });
    for (; generated < maximum; generated++) {
      const token = await api.llama_sampler_sample(sampler, context, -1);
      if (await api.llama_vocab_is_eog(vocab, token)) break;
      let length = await api.llama_token_to_piece(vocab, token, piece, pieceCapacity, 0, 1);
      if (length < 0) {
        if (-length > 1024 * 1024) throw new LlamaCppBrowserError({ code: 'runtime-error' });
        pieceCapacity = -length; piece = alloc({ bytes: pieceCapacity });
        length = await api.llama_token_to_piece(vocab, token, piece, pieceCapacity, 0, 1);
      }
      if (length < 0 || length > pieceCapacity) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      const rendered = stream.push({ text: decoder.decode(core.bytes(piece, length), { stream: true }) });
      if (rendered.text) onChunk({ chunk: rendered.text });
      if (rendered.done) break;
      const tokenBytes = core.bytes(nextToken, 4); new DataView(tokenBytes.buffer, tokenBytes.byteOffset, 4).setInt32(0, token, true);
      await api.llama_batch_get_one(batch, nextToken, 1);
      if (await api.llama_decode(context, batch) !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      progress({ phase: 'generating', completed: generated + 1, total: maximum });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const tail = stream.push({ text: decoder.decode() }).text + stream.finish();
    if (tail) onChunk({ chunk: tail });
    logDiagnostic({ diagnostic: { event: 'generation-complete', tokens: generated, elapsedMs: performance.now() - started } });
  } finally {
    try {
      if (sampler !== 0n) await api.llama_sampler_free(sampler);
      if (context !== 0n) await api.llama_free(context);
      if (model !== 0n) await api.llama_model_free(model);
      if (callback !== undefined) core.module.removeFunction(callback);
      for (const pointer of allocations.reverse()) core.free(pointer);
    } finally {
      try {
        mounted?.remove();
      } finally {
        access.close();
      }
    }
    logDiagnostic({ diagnostic: { event: 'released' } });
  }
}
export const TEST_ONLY = {
};
