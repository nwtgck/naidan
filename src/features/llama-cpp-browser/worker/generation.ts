import { LlamaCppBrowserError, type GenerationResult, type Progress } from '@/features/llama-cpp-browser/types';
import { logDiagnostic, logFailure, type DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { WorkerGenerateInput } from './types';
import { createOutputStream } from './output-stream';
import { prepareSession } from './session';
import { prepareChat } from './native-chat';
import { createChatSampler } from './chat-sampler';

/** Reuse only a verified decoded prefix; sampling and parsing stay request-local. */
export async function generate({ request, onChunk, onProgress, signal }: {
  request: WorkerGenerateInput,
  signal: AbortSignal | undefined,
  onChunk: ({ chunk }: { chunk: string }) => void,
  onProgress: ({ progress }: { progress: Progress }) => void,
}): Promise<GenerationResult> {
  const started = performance.now();
  let stage: DiagnosticStage = 'session';
  let generated = 0;
  const progress = ({ phase, completed, total }: Progress): void => onProgress({ progress: { phase, completed, total } });
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  const { core, model, context, cache } = await prepareSession({ request, onProgress, signal });
  const api = core.api;
  let chat: ReturnType<typeof prepareChat> | undefined;
  let chatSampler: Awaited<ReturnType<typeof createChatSampler>> | undefined;
  const allocations: bigint[] = []; let sampler = 0n; let abortCallback: number | bigint | undefined;
  const alloc = ({ bytes }: { bytes: number | bigint }): bigint => {
    const p = core.alloc({ bytes: bytes }); allocations.push(p); return p;
  };
  const record = ({ name }: { name: string }): bigint => {
    const p = core.allocRecord({ name: name }); allocations.push(p); return p;
  };
  const string = ({ text }: { text: string }): bigint => {
    const p = core.utf8({ text: text }); allocations.push(p); return p;
  };
  const cleanup = async (): Promise<void> => {
    try {
      try {
        try {
          await api.llama_set_abort_callback(context, 0n, 0n);
        } finally {
          if (chatSampler) await chatSampler.dispose();
          if (sampler !== 0n) await api.llama_sampler_free(sampler);
        }
      } finally {
        try {
          chat?.dispose();
        } finally {
          if (abortCallback !== undefined) core.module.removeFunction(abortCallback);
          for (const pointer of allocations.reverse()) core.free({ pointer });
        }
      }
    } catch (error) {
      cache.validity = 'invalid';
      logFailure({ stage: 'cleanup', error }); throw error;
    }
  };
  try {
    checkCancelled();
    // Prompt preparation is an ordinary response wait, not another model load.
    stage = 'prefill';
    progress({ phase: 'prefill', completed: 0, total: 0 });
    logDiagnostic({ diagnostic: { event: 'prefill-start' } });
    const memory = await api.llama_get_memory(context);
    abortCallback = core.module.addFunction(() => signal?.aborted ? 1 : 0, core.pointerBytes === 8 ? 'ij' : 'ii');
    await api.llama_set_abort_callback(context, BigInt(abortCallback), 0n);
    stage = 'template';
    chat = prepareChat({ core, model, request });
    stage = 'tokenize';
    const promptText = chat.params.prompt;
    const promptLength = new TextEncoder().encode(promptText).length;
    if (promptLength > 4 * 1024 * 1024) throw new LlamaCppBrowserError({ code: 'context-full' });
    const prompt = string({ text: promptText });
    const vocab = await api.llama_model_get_vocab(model);
    const countResult = await api.llama_tokenize(vocab, prompt, promptLength, 0n, 0, 1, 1);
    const tokenCount = Math.abs(countResult);
    const capacity = await api.llama_n_ctx(context);
    if (tokenCount < 1 || tokenCount >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
    const tokens = alloc({ bytes: tokenCount * 4 });
    if (await api.llama_tokenize(vocab, prompt, promptLength, tokens, tokenCount, 1, 1) !== tokenCount) throw new LlamaCppBrowserError({ code: 'runtime-error' });
    const promptBytes = core.bytes({ pointer: tokens, length: tokenCount * 4 });
    const promptView = new DataView(promptBytes.buffer, promptBytes.byteOffset, promptBytes.byteLength);
    const promptTokens = Array.from({ length: tokenCount }, (_, index) => promptView.getInt32(index * 4, true));
    const cacheValid = (() => {
      switch (cache.validity) {
      case 'valid': return true;
      case 'invalid': return false;
      default: { const exhaustive: never = cache.validity; throw new Error(`Unknown cache validity: ${exhaustive}`); }
      }
    })();
    const prefixMatches = cacheValid && cache.tokens.length > 0
      && cache.tokens.length <= tokenCount && cache.tokens.every((token, index) => token === promptTokens[index]);
    // The last successful decode owns the context logits. Native CPU sampling
    // copies them into candidates; no evaluation runs between resident requests.
    const reuse = memory !== 0n && prefixMatches
      && await api.llama_memory_seq_pos_max(memory, 0) === cache.tokens.length - 1;
    const reusedTokens = reuse ? cache.tokens.length : 0;
    logDiagnostic({ diagnostic: { event: 'cache-reuse', reusedTokens, evaluatedTokens: tokenCount - reusedTokens,
      reason: reuse ? 'prefix-match' : !cacheValid ? 'cache-invalid' : !prefixMatches ? 'prefix-mismatch' : 'cache-position' } });
    // No rollback or state transfer: edited/shortened prompts and uncertain state
    // rebuild the cache, including for recurrent and sliding-window models.
    cache.validity = 'invalid';
    if (!reuse) {
      cache.tokens = [];
      if (memory !== 0n) await api.llama_memory_clear(memory, 1);
    }
    const batch = record({ name: 'llama_batch' });
    stage = 'prefill-decode';
    for (let offset = reusedTokens; offset < tokenCount; offset += 128) {
      checkCancelled();
      const count = Math.min(128, tokenCount - offset);
      await api.llama_batch_get_one(batch, tokens + BigInt(offset * 4), count);
      const status = await api.llama_decode(context, batch);
      checkCancelled();
      if (status !== 0) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, reason: 'decode-status' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      cache.tokens.push(...promptTokens.slice(offset, offset + count));
      progress({ phase: 'prefill', completed: offset + count, total: tokenCount });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCancelled();
    progress({ phase: 'prefill', completed: tokenCount, total: tokenCount });
    checkCancelled();
    logDiagnostic({ diagnostic: { event: 'prefill-complete', tokens: tokenCount, reusedTokens, evaluatedTokens: tokenCount - reusedTokens } });
    stage = 'sampler-create';
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
    if (request.presencePenalty !== 0 || request.frequencyPenalty !== 0) {
      for (let index = 0; index < tokenCount; index++) {
        const bytes = core.bytes({ pointer: tokens + BigInt(index * 4), length: 4 });
        await api.llama_sampler_accept(sampler, new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true));
      }
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
    const samplingChain = sampler; sampler = 0n;
    chatSampler = await createChatSampler({ core, vocab, chain: samplingChain, params: chat.params });
    const stream = createOutputStream({ stops: [...request.stop, ...chat.additionalStops], harmony: false, initialChannel: 'final' });
    let output = ''; let content = ''; let reasoning = ''; let thinkingOpen = false;
    const emitParsed = ({ parsed }: { parsed: Omit<GenerationResult, 'finishReason'> }): void => {
      stage = 'stream-emit';
      if (!parsed.content.startsWith(content) || !parsed.reasoningContent.startsWith(reasoning)) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, tokens: generated,
          reason: !parsed.content.startsWith(content) ? 'non-monotonic-content' : 'non-monotonic-reasoning' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      const thought = parsed.reasoningContent.slice(reasoning.length);
      if (thought) {
        if (!thinkingOpen) {
          onChunk({ chunk: '<think>' }); thinkingOpen = true; checkCancelled();
        }
        onChunk({ chunk: thought }); checkCancelled();
      }
      const text = parsed.content.slice(content.length);
      if (text) {
        if (thinkingOpen) {
          onChunk({ chunk: '</think>' }); thinkingOpen = false; checkCancelled();
        }
        onChunk({ chunk: text }); checkCancelled();
      }
      content = parsed.content; reasoning = parsed.reasoningContent;
    };
    let finishReason: GenerationResult['finishReason'] = 'length';
    const decoder = new TextDecoder(); const nextToken = alloc({ bytes: 4 });
    let piece = alloc({ bytes: 256 }); let pieceCapacity = 256;
    const maximum = Math.min(request.maxTokens, capacity - tokenCount);
    logDiagnostic({ diagnostic: { event: 'generation-start', tokens: tokenCount, pointerBytes: core.pointerBytes, toolCount: request.tools?.length ?? 0 } });
    for (; generated < maximum; generated++) {
      checkCancelled();
      stage = 'native-sample';
      const token = await chatSampler.sample({ context });
      if (generated === 0) logDiagnostic({ diagnostic: { event: 'first-token-sampled' } });
      stage = 'token-render';
      checkCancelled();
      const endOfGeneration = await api.llama_vocab_is_eog(vocab, token);
      let length = await api.llama_token_to_piece(vocab, token, piece, pieceCapacity, 0, chatSampler.preservedTokens.has(token) ? 1 : 0);
      if (length < 0) {
        if (-length > 1024 * 1024) throw new LlamaCppBrowserError({ code: 'runtime-error' });
        pieceCapacity = -length; piece = alloc({ bytes: pieceCapacity });
        length = await api.llama_token_to_piece(vocab, token, piece, pieceCapacity, 0, chatSampler.preservedTokens.has(token) ? 1 : 0);
      }
      if (length < 0 || length > pieceCapacity) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, reason: 'invalid-token-piece' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      const rendered = stream.push({ text: decoder.decode(core.bytes({ pointer: piece, length: length }), { stream: true }) });
      checkCancelled();
      output += rendered.text;
      stage = 'partial-parse';
      emitParsed({ parsed: chat.parse({ text: output, partial: true }) });
      if (rendered.done || endOfGeneration) {
        finishReason = 'stop'; break;
      }
      stage = 'generation-decode';
      const tokenBytes = core.bytes({ pointer: nextToken, length: 4 }); new DataView(tokenBytes.buffer, tokenBytes.byteOffset, 4).setInt32(0, token, true);
      await api.llama_batch_get_one(batch, nextToken, 1);
      const status = await api.llama_decode(context, batch);
      checkCancelled();
      if (status !== 0) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, reason: 'decode-status' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      // Sampled stop/EOG tokens are deliberately excluded until actually decoded.
      cache.tokens.push(token);
      progress({ phase: 'generating', completed: generated + 1, total: maximum });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCancelled();
    const tail = stream.push({ text: decoder.decode() }).text + stream.finish();
    output += tail;
    stage = 'final-parse';
    const parsed = chat.parse({ text: output, partial: finishReason === 'length' });
    emitParsed({ parsed });
    if (thinkingOpen) {
      onChunk({ chunk: '</think>' }); checkCancelled();
    }
    logDiagnostic({ diagnostic: { event: 'generation-complete', tokens: generated, elapsedMs: performance.now() - started } });
    cache.validity = memory !== 0n ? 'valid' : 'invalid';
    return { ...parsed, finishReason };
  } catch (error) {
    cache.validity = 'invalid';
    logFailure({ stage, error });
    logDiagnostic({ diagnostic: { event: 'failed', stage, tokens: generated } });
    throw error;
  } finally {
    await cleanup();
    // The owning worker or a model/profile/file change releases the resident cache.
  }
}
export const TEST_ONLY = {
};
