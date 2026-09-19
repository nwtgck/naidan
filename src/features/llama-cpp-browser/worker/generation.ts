import { LlamaCppBrowserError, type Progress } from '@/features/llama-cpp-browser/types';
import { logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import type { WorkerGenerateInput } from './types';
import { createOutputStream } from './output-stream';
import { prepareSession } from './session';

/** Request-local tokens/sampling; weights and the context allocation stay resident. */
export async function generate({ request, onChunk, onProgress, signal }: {
  request: WorkerGenerateInput,
  signal: AbortSignal | undefined,
  onChunk: ({ chunk }: { chunk: string }) => void,
  onProgress: ({ progress }: { progress: Progress }) => void,
}): Promise<void> {
  const started = performance.now();
  const progress = ({ phase, completed, total }: Progress): void => onProgress({ progress: { phase, completed, total } });
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  const { core, model, context } = await prepareSession({ request, onProgress, signal });
  const api = core.api;
  const allocations: bigint[] = []; let sampler = 0n; let abortCallback: number | bigint | undefined;
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
    checkCancelled();
    // Prompt preparation is an ordinary response wait, not another model load.
    progress({ phase: 'prefill', completed: 0, total: 0 });
    logDiagnostic({ diagnostic: { event: 'prefill-start' } });
    const memory = await api.llama_get_memory(context);
    if (memory !== 0n) await api.llama_memory_clear(memory, 1);
    abortCallback = core.module.addFunction(() => signal?.aborted ? 1 : 0, core.pointerBytes === 8 ? 'ij' : 'ii');
    await api.llama_set_abort_callback(context, BigInt(abortCallback), 0n);
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
      checkCancelled();
      const count = Math.min(128, tokenCount - offset);
      await api.llama_batch_get_one(batch, tokens + BigInt(offset * 4), count);
      const status = await api.llama_decode(context, batch);
      checkCancelled();
      if (status !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      progress({ phase: 'prefill', completed: offset + count, total: tokenCount });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCancelled();
    logDiagnostic({ diagnostic: { event: 'prefill-complete', tokens: tokenCount } });
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
      checkCancelled();
      const token = await api.llama_sampler_sample(sampler, context, -1);
      checkCancelled();
      if (await api.llama_vocab_is_eog(vocab, token)) break;
      let length = await api.llama_token_to_piece(vocab, token, piece, pieceCapacity, 0, 1);
      if (length < 0) {
        if (-length > 1024 * 1024) throw new LlamaCppBrowserError({ code: 'runtime-error' });
        pieceCapacity = -length; piece = alloc({ bytes: pieceCapacity });
        length = await api.llama_token_to_piece(vocab, token, piece, pieceCapacity, 0, 1);
      }
      if (length < 0 || length > pieceCapacity) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      const rendered = stream.push({ text: decoder.decode(core.bytes(piece, length), { stream: true }) });
      checkCancelled();
      if (rendered.text) onChunk({ chunk: rendered.text });
      if (rendered.done) break;
      const tokenBytes = core.bytes(nextToken, 4); new DataView(tokenBytes.buffer, tokenBytes.byteOffset, 4).setInt32(0, token, true);
      await api.llama_batch_get_one(batch, nextToken, 1);
      const status = await api.llama_decode(context, batch);
      checkCancelled();
      if (status !== 0) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      progress({ phase: 'generating', completed: generated + 1, total: maximum });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCancelled();
    const tail = stream.push({ text: decoder.decode() }).text + stream.finish();
    if (tail) onChunk({ chunk: tail });
    logDiagnostic({ diagnostic: { event: 'generation-complete', tokens: generated, elapsedMs: performance.now() - started } });
  } finally {
    try {
      await api.llama_set_abort_callback(context, 0n, 0n);
      if (sampler !== 0n) await api.llama_sampler_free(sampler);
    } finally {
      if (abortCallback !== undefined) core.module.removeFunction(abortCallback);
      for (const pointer of allocations.reverse()) core.free(pointer);
    }
    // Do not free model/context here: the next request clears KV before prefill.
    // The owning Worker or a model/profile/context change releases these resources.
  }
}
export const TEST_ONLY = {
};
