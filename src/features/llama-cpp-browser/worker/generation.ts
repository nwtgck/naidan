import { prepareMultimodal } from './multimodal';
import { LlamaCppBrowserError, type GenerationResult, type GenerationCallback, type Progress } from '@/features/llama-cpp-browser/types';
import { logDiagnostic, logFailure, type Diagnostic, type DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { WorkerGenerateInput } from './types';
import { createOutputStream } from './output-stream';
import { prepareSession } from './session';
import { prepareChat } from './native-chat';
import { createChatSampler } from './chat-sampler';

/** Reuse only a verified decoded prefix; sampling and parsing stay request-local. */
export async function generate({ request, onEvent, onProgress, signal }: {
  request: WorkerGenerateInput,
  signal: AbortSignal | undefined,
  onEvent: GenerationCallback,
  onProgress: ({ progress }: { progress: Progress }) => void,
}): Promise<GenerationResult> {
  const started = performance.now();
  let stage: DiagnosticStage = 'session';
  let generated = 0;
  let flushPartial: (() => Promise<void>) | undefined;
  const progress = ({ phase, completed, total }: Progress): void => onProgress({ progress: { phase, completed, total } });
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  const { core, model, context, sequenceRemoval, cache, projector } = await prepareSession({ request, onProgress, signal });
  const api = core.api;
  let chat: ReturnType<typeof prepareChat> | undefined;
  let multimodal: Awaited<ReturnType<typeof prepareMultimodal>> | undefined;
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
          try {
            if (multimodal) await multimodal.dispose();
          } finally {
            chat?.dispose();
          }
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
    const vocab = await api.llama_model_get_vocab(model);
    const capacity = await api.llama_n_ctx(context);
    let promptTokens: number[];
    let tokens: bigint;
    if (chat.images.length) {
      // Image identity and native positions are not represented by a token prefix.
      cache.validity = 'invalid'; cache.tokens = [];
      multimodal = await prepareMultimodal({ core, projector, prompt: promptText, images: chat.images });
      promptTokens = multimodal.textTokens;
      tokens = alloc({ bytes: Math.max(4, promptTokens.length * 4) });
      const bytes = core.bytes({ pointer: tokens, length: promptTokens.length * 4 }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      promptTokens.forEach((token, index) => view.setInt32(index * 4, token, true));
    } else {
      const prompt = string({ text: promptText });
      const countResult = await api.llama_tokenize(vocab, prompt, promptLength, 0n, 0, 1, 1);
      const count = Math.abs(countResult);
      if (count < 1 || count >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
      tokens = alloc({ bytes: count * 4 });
      if (await api.llama_tokenize(vocab, prompt, promptLength, tokens, count, 1, 1) !== count) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      const bytes = core.bytes({ pointer: tokens, length: count * 4 }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      promptTokens = Array.from({ length: count }, (_, index) => view.getInt32(index * 4, true));
    }
    const tokenCount = multimodal?.tokenCount ?? promptTokens.length;
    let nextPosition = multimodal?.positions ?? tokenCount;
    if (tokenCount >= capacity || nextPosition >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
    const cacheValid = (() => {
      switch (cache.validity) {
      case 'valid': return true;
      case 'invalid': return false;
      default: { const exhaustive: never = cache.validity; throw new Error(`Unknown cache validity: ${exhaustive}`); }
      }
    })();
    const cachedTokens = cache.tokens.length;
    let commonPrefixTokens = 0;
    while (commonPrefixTokens < Math.min(cachedTokens, promptTokens.length)
      && cache.tokens[commonPrefixTokens] === promptTokens[commonPrefixTokens]) commonPrefixTokens++;
    // Report only lengths and positions, never token IDs or prompt text. A
    // shorter prompt and a differing token require different investigations.
    const cacheComparison = cachedTokens === 0 ? 'empty-cache'
      : commonPrefixTokens < Math.min(cachedTokens, promptTokens.length) ? 'token-mismatch'
        : cachedTokens > promptTokens.length ? 'prompt-shorter'
          : cachedTokens === promptTokens.length ? 'identical' : 'prompt-extension';
    const nativePositionMin = memory === 0n ? undefined : await api.llama_memory_seq_pos_min(memory, 0);
    const nativePositionMax = memory === 0n ? undefined : await api.llama_memory_seq_pos_max(memory, 0);
    const nativeMemoryKind = memory === 0n ? 'none'
      : await api.llama_model_is_hybrid(model) ? 'hybrid'
        : await api.llama_model_is_recurrent(model) ? 'recurrent' : 'attention';
    const nativeRollbackTokens = await api.llama_n_rs_seq(context);
    const prefixMatches = cacheValid && cachedTokens > 0 && commonPrefixTokens === cachedTokens;
    // The last successful decode owns the context logits. Native CPU sampling
    // copies them into candidates; no evaluation runs between resident requests.
    const cachePositionMatches = nativePositionMax === cachedTokens - 1;
    const reuse = !multimodal && memory !== 0n && prefixMatches && cachePositionMatches;
    const canRemoveSuffix = (() => {
      switch (sequenceRemoval) {
      case 'partial': case 'bounded': return true;
      case 'none': case 'full-only': return false;
      default: { const exhaustive: never = sequenceRemoval; throw new Error(`Unknown sequence removal capability: ${exhaustive}`); }
      }
    })();
    let reusedTokens = reuse ? cachedTokens : 0;
    let reason: Diagnostic['reason'] = reuse ? 'prefix-match' : !cacheValid ? 'cache-invalid'
      : !cachePositionMatches ? 'cache-position' : 'prefix-mismatch';
    cache.validity = 'invalid';
    if (!reuse && canRemoveSuffix && !multimodal && memory !== 0n && cacheValid && cachePositionMatches && commonPrefixTokens > 0) {
      // Require the entire original prefix to remain resident. llama.cpp's
      // attention cache keeps every position between min/max; composite memory
      // reports its narrowest retained range. Let native seq_rm decide whether
      // that memory can actually rewind, without model-specific dispatch.
      if (nativePositionMin === 0) {
        // Removing a suffix does not refresh logits. Even a shortened prompt
        // must decode at least its final token before sampling again.
        const retained = Math.min(commonPrefixTokens, tokenCount - 1);
        if (retained > 0) {
          const removed = await api.llama_memory_seq_rm(memory, 0, retained, -1);
          if (removed && await api.llama_memory_seq_pos_min(memory, 0) === 0
            && await api.llama_memory_seq_pos_max(memory, 0) === retained - 1) {
            reusedTokens = retained;
            cache.tokens.length = retained;
            reason = 'prefix-partial-match';
          } else reason = 'cache-rollback-failed';
        }
      } else reason = 'cache-window';
    }
    logDiagnostic({ diagnostic: { event: 'cache-reuse', reusedTokens, evaluatedTokens: tokenCount - reusedTokens,
      tokens: tokenCount, cachedTokens, commonPrefixTokens, cacheComparison,
      nativeMemoryKind, nativePositionMin, nativePositionMax, nativeRollbackTokens,
      reason } });
    if (reusedTokens === 0) {
      cache.tokens = [];
      if (memory !== 0n) await api.llama_memory_clear(memory, 1);
    }
    const batch = record({ name: 'llama_batch' });
    stage = 'prefill-decode';
    if (multimodal) {
      checkCancelled();
      nextPosition = await multimodal.evaluate({ context, capacity });
      checkCancelled();
    } else for (let offset = reusedTokens; offset < tokenCount; offset += 128) {
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
      for (let index = 0; index < promptTokens.length; index++) {
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
    let output = ''; let content = ''; let reasoning = ''; let pendingCalls = 0;
    let deliveryFailed = false;
    const send: GenerationCallback = async ({ event }) => {
      stage = 'stream-emit';
      try {
        await onEvent({ event });
      } catch (error) {
        deliveryFailed = true; throw error;
      }
    };
    const emitParsed = async ({ parsed }: { parsed: Omit<GenerationResult, 'finishReason'> }): Promise<void> => {
      stage = 'stream-emit';
      if (!parsed.content.startsWith(content) || !parsed.reasoningContent.startsWith(reasoning) || parsed.toolCalls.length < pendingCalls) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, tokens: generated,
          reason: !parsed.content.startsWith(content) ? 'non-monotonic-content' : 'non-monotonic-reasoning' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      const thought = parsed.reasoningContent.slice(reasoning.length);
      const text = parsed.content.slice(content.length);
      // Commit the accepted parser snapshot before awaiting delivery; never resend a delta.
      content = parsed.content; reasoning = parsed.reasoningContent;
      if (thought) await send({ event: { type: 'reasoning', text: thought } });
      if (text) await send({ event: { type: 'text', text } });
      while (pendingCalls < parsed.toolCalls.length) {
        const index = pendingCalls++;
        await send({ event: { type: 'tool_call_start', index } });
      }
    };
    let finishReason: GenerationResult['finishReason'] = 'length';
    const decoder = new TextDecoder(); const nextToken = alloc({ bytes: 4 });
    flushPartial = async () => {
      if (deliveryFailed) return;
      output += stream.push({ text: decoder.decode() }).text + stream.finish();
      await emitParsed({ parsed: chat!.parse({ text: output, partial: true }) });
    };
    const position = multimodal ? alloc({ bytes: 4 }) : undefined;
    let piece = alloc({ bytes: 256 }); let pieceCapacity = 256;
    const remaining = capacity - Math.max(tokenCount, nextPosition);
    const maximum = request.maxTokens === undefined ? remaining : Math.min(request.maxTokens, remaining);
    logDiagnostic({ diagnostic: { event: 'generation-start', imageCount: chat.images.length, tokens: tokenCount, pointerBytes: core.pointerBytes, toolCount: request.tools?.length ?? 0 } });
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
      await emitParsed({ parsed: chat.parse({ text: output, partial: true }) });
      if (rendered.done || endOfGeneration) {
        const stop = stream.getMatchedStop();
        finishReason = stop !== undefined && request.stop.includes(stop) ? 'stop_sequence' : 'stop'; break;
      }
      stage = 'generation-decode';
      const tokenBytes = core.bytes({ pointer: nextToken, length: 4 }); new DataView(tokenBytes.buffer, tokenBytes.byteOffset, 4).setInt32(0, token, true);
      await api.llama_batch_get_one(batch, nextToken, 1);
      if (position !== undefined) {
        const bytes = core.bytes({ pointer: position, length: 4 }); new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(0, nextPosition, true);
        core.setField({ name: 'llama_batch', pointer: batch, field: 'pos', value: position });
      }
      const status = await api.llama_decode(context, batch);
      checkCancelled();
      if (status !== 0) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, reason: 'decode-status' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      // Sampled stop/EOG tokens are deliberately excluded until actually decoded.
      if (!multimodal) cache.tokens.push(token);
      nextPosition++;
      progress({ phase: 'generating', completed: generated + 1, total: maximum });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    checkCancelled();
    const tail = stream.push({ text: decoder.decode() }).text + stream.finish();
    output += tail;
    stage = 'final-parse';
    const parsed = chat.parse({ text: output, partial: finishReason !== 'stop' });
    await emitParsed({ parsed });
    // Only a completed native turn confirms calls. JSON validity alone does not.
    switch (finishReason) {
    case 'stop':
      for (const [index, toolCall] of parsed.toolCalls.entries()) await send({ event: { type: 'tool_call', index, toolCall } });
      break;
    case 'length': case 'stop_sequence': break;
    default: { const exhaustive: never = finishReason; throw new Error(`Unknown completion: ${exhaustive}`); }
    }
    flushPartial = undefined;
    logDiagnostic({ diagnostic: { event: 'generation-complete', tokens: generated, elapsedMs: performance.now() - started } });
    cache.validity = !multimodal && memory !== 0n ? 'valid' : 'invalid';
    return { ...parsed, finishReason };
  } catch (error) {
    // Drain already accepted bytes before reporting a cooperative cancellation or failure.
    // Do not retry delivery after a consumer failure or replace the original error.
    try {
      await flushPartial?.();
    } catch (drainError) {
      logFailure({ stage: 'stream-emit', error: drainError });
    }
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
