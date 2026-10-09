import { sampleMemoryDiagnostics } from '@/features/llama-cpp-browser/runtime/memory-diagnostics';
import { createCheckpointPerformance } from './checkpoint-performance';
import { copyNativeUtf8 } from '@/features/llama-cpp-browser/runtime/native-utf8';
import { createDeliveryDecode } from './delivery-decode';
import { createGenerationYieldPacing } from './generation-yield-pacing';
import { createPrefillOutputs } from './prefill-outputs';
import { createTokenRenderer } from './token-renderer';
import { createOutputPacing } from './output-pacing';
import { createPrefillYieldPacing } from './prefill-yield-pacing';
import { createGenerationPerformance } from './generation-performance';
import { tokenizePrompt } from './tokenize-prompt';
import { prepareMultimodal } from './multimodal';
import { errorCode, LlamaCppBrowserError, usesWebGpu, type GenerationResult, type GenerationCallback, type Progress } from '@/features/llama-cpp-browser/types';
import { classifyFailure, logDiagnostic, logFailure, type Diagnostic, type DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { WorkerGenerateInput } from './types';
import { createOutputStream } from './output-stream';
import { prepareGenerationSession } from './session';
import { prepareChat } from './native-chat';
import { createChatSampler } from './chat-sampler';
import { capturePromptCheckpoint, disposePromptCheckpoint, promptCheckpointBoundary, restorePromptCheckpoint } from './prompt-checkpoint';

/** Cancellation describes the actual error, not merely a concurrently set
 * signal. This keeps native failures visible to diagnostics and recovery. */
function failureOutcome({ error }: { error: unknown }): 'aborted' | 'failed' {
  const code = errorCode({ error });
  switch (code) {
  case 'aborted': return 'aborted';
  case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model':
  case 'storage-error': case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full':
  case 'unsupported-input': case 'busy': case 'worker-failed': case 'audio-model-unsupported':
  case 'audio-reference-required': case 'audio-reference-invalid': case 'audio-output-empty': return 'failed';
  default: { const exhaustive: never = code; throw new Error(String(exhaustive)); }
  }
}

/** Reuse only a verified decoded prefix; sampling and parsing stay request-local. */
export async function generate({ request, onEvent, onProgress, signal, onSummary }: {
  request: WorkerGenerateInput,
  onSummary?: ({ diagnostic }: { diagnostic: Diagnostic }) => void,
  signal: AbortSignal | undefined,
  onEvent: GenerationCallback,
  onProgress: ({ progress }: { progress: Progress }) => void,
}): Promise<GenerationResult> {
  const started = performance.now();
  let stage: DiagnosticStage = 'session';
  let session: Awaited<ReturnType<typeof prepareGenerationSession>> | undefined;
  const measurements = createGenerationPerformance({ enabled: request.debug === 'on' || request.measurement !== undefined, now: () => performance.now() });
  const checkpointObservation = request.measurement ? createCheckpointPerformance({ now: () => performance.now() }) : undefined;
  measurements.counters.runtimeAssetBaseURL = request.assetBaseURL;
  measurements.counters.sampling = {
    temperature: request.temperature,
    topP: request.topP,
    presencePenalty: request.presencePenalty,
    frequencyPenalty: request.frequencyPenalty,
  };
  const setStage = ({ value }: { value: DiagnosticStage }): void => {
    stage = value;
    measurements.enter({ next: value });
    if (session?.census) {
      switch (value) {
      case 'prefill-decode': session.census.setPhase({ value: 'prefill' }); break;
      case 'generation-decode': case 'generation-overlap': session.census.setPhase({ value: 'decode' }); break;
      case 'audio-info': case 'audio-reference': case 'audio-input': case 'audio-prompt': case 'audio-frame': case 'audio-output':
      case 'media-encode': case 'media-decode': case 'model-resolve': case 'projector-trace': case 'projector-load':
      case 'image-decode': case 'image-tokenize': case 'image-evaluate': case 'session': case 'cache-prepare': case 'cache-probe':
      case 'cache-checkpoint': case 'prefill': case 'template': case 'tokenize': case 'sampler-create': case 'reasoning-state':
      case 'grammar-switch': case 'native-sample': case 'reasoning-accept': case 'reasoning-replay': case 'token-render':
      case 'partial-parse': case 'stream-emit': case 'final-parse': case 'cleanup': case 'event-loop-yield':
      case 'worker-operation': case 'worker-callback': case 'worker-rpc': case 'worker-error': case 'worker-messageerror':
        session.census.setPhase({ value: 'other' }); break;
      default: { const exhaustive: never = value; throw new Error(String(exhaustive)); }
      }
    }
  };
  let outcome: 'completed' | 'aborted' | 'failed' = 'failed';
  let failure: Pick<Diagnostic, 'stage' | 'failureKind'> | undefined;
  const recordFailure = ({ error, stage }: { error: unknown, stage: DiagnosticStage }) => {
    if (request.measurement && !failure) failure = { stage, failureKind: classifyFailure({ error }) };
  };
  const reportPerformance = (): void => {
    try {
      if (session && request.measurement) {
        measurements.counters.backendCensus = session.census?.snapshot();
        const memory = measurements.counters.memoryObservation;
        if (memory) {
          memory.wasmHeapAfterBytes = session.core.module.HEAPU8.byteLength; memory.checkpointRetainedBytes = session.cache.checkpoint?.bytes ?? 0;
        }
      }
      measurements.counters.checkpoint = checkpointObservation?.snapshot();
      const diagnostic = measurements.finish({ outcome, profile: request.options.profile });
      if (diagnostic) {
        if (request.measurement) onSummary?.({ diagnostic: { ...diagnostic, ...failure } });
        switch (request.debug) {
        case 'on': logDiagnostic({ diagnostic }); break;
        case 'off': case undefined: break;
        default: { const exhaustive: never = request.debug; void exhaustive; }
        }
      }
    } catch { /* A performance report must not replace an inference result/error. */ }
  };
  let generated = 0;
  let flushPartial: (() => Promise<void>) | undefined;
  const progress = ({ phase, completed, total }: Progress): void => onProgress({ progress: { phase, completed, total } });
  const checkCancelled = (): void => {
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
  };
  try {
    session = await prepareGenerationSession({ request, onProgress, signal });
  } catch (error) {
    outcome = failureOutcome({ error });
    recordFailure({ error, stage });
    reportPerformance();
    throw error;
  }
  const { core, model, context, sequenceRemoval, slidingWindow, cache, projector, vocab, contextTokens: capacity, memory, nativeRollbackTokens, prefillBatchTokens } = session;
  const measuredMemory = request.measurement ? { wasmHeapBeforeBytes: core.module.HEAPU8.byteLength } : undefined;
  measurements.counters.memoryObservation = measuredMemory;
  measurements.counters.sessionPreparation = session.preparation;
  measurements.counters.prefillBatchTokens = session.prefillBatchTokens;
  const api = core.api;
  // Consume before template/media preparation, cancellation or any native
  // mutation. A failed request must never lend this proof to its successor.
  const initialMemoryState = cache.initialMemoryState;
  cache.initialMemoryState = 'unknown';
  const memoryReset = measurements.counters.memoryReset = { requestedClears: 0, skippedInitialClears: 0 };
  const discardCheckpoint = (): void => {
    const checkpoint = cache.checkpoint; cache.checkpoint = undefined;
    disposePromptCheckpoint({ core, checkpoint });
  };
  let chat: ReturnType<typeof prepareChat> | undefined;
  let multimodal: Awaited<ReturnType<typeof prepareMultimodal>> | undefined;
  let chatSampler: Awaited<ReturnType<typeof createChatSampler>> | undefined;
  let tokenRenderer: ReturnType<typeof createTokenRenderer> | undefined;
  let prefillOutputs: ReturnType<typeof createPrefillOutputs> | undefined;
  const allocations: bigint[] = []; let sampler = 0n; let abortCallback: number | bigint | undefined;
  const alloc = ({ bytes }: { bytes: number | bigint }): bigint => {
    const p = core.alloc({ bytes: bytes }); allocations.push(p); return p;
  };
  const record = ({ name }: { name: string }): bigint => {
    const p = core.allocRecord({ name: name }); allocations.push(p); return p;
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
            try {
              chat?.dispose();
            } finally {
              try {
                tokenRenderer?.dispose();
              } finally {
                prefillOutputs?.dispose();
              }
            }
          }
        } finally {
          if (abortCallback !== undefined) core.module.removeFunction(abortCallback);
          for (const pointer of allocations.reverse()) core.free({ pointer });
        }
      }
    } catch (error) {
      outcome = 'failed';
      recordFailure({ error, stage: 'cleanup' });
      cache.validity = 'invalid';
      discardCheckpoint();
      logFailure({ stage: 'cleanup', error }); throw error;
    }
  };
  try {
    checkCancelled();
    const measurementSequence = request.measurement?.sequence;
    switch (measurementSequence) {
    case 'fresh':
      cache.validity = 'invalid'; cache.tokens = [];
      discardCheckpoint();
      break;
    case 'continue': case undefined: break;
    default: { const exhaustive: never = measurementSequence; throw new Error(String(exhaustive)); }
    }
    // Prompt preparation is an ordinary response wait, not another model load.
    sampleMemoryDiagnostics({ core, checkpoint: 'prefill-start' });
    setStage({ value: 'prefill' });
    progress({ phase: 'prefill', completed: 0, total: 0 });
    logDiagnostic({ diagnostic: { event: 'prefill-start' } });
    abortCallback = core.module.addFunction(() => signal?.aborted ? 1 : 0, core.pointerBytes === 8 ? 'ij' : 'ii');
    await api.llama_set_abort_callback(context, BigInt(abortCallback), 0n);
    setStage({ value: 'template' });
    chat = prepareChat({ core, model, request });
    measurements.counters.input = chat.images.length ? 'multimodal' : 'text';
    setStage({ value: 'tokenize' });
    const promptText = chat.params.prompt;
    let promptLength: number;
    let promptPointer = 0n;
    {
      // Use the same bytes for the limit, tokenizer length, and native string.
      // Keep the host buffer out of the asynchronous generation lifetime.
      const data = new TextEncoder().encode(promptText);
      promptLength = data.byteLength;
      if (promptLength > 4 * 1024 * 1024) throw new LlamaCppBrowserError({ code: 'context-full' });
      if (!chat.images.length) {
        promptPointer = copyNativeUtf8({ core, data });
        allocations.push(promptPointer);
      }
    }
    measurements.counters.contextTokens = capacity;
    let promptTokens: number[];
    let tokens: bigint;
    if (chat.images.length) {
      // Image identity and native positions are not represented by a token prefix.
      cache.validity = 'invalid'; cache.tokens = [];
      discardCheckpoint();
      multimodal = await prepareMultimodal({ core, projector, prompt: promptText, images: chat.images });
      promptTokens = multimodal.textTokens;
      tokens = alloc({ bytes: Math.max(4, promptTokens.length * 4) });
      const bytes = core.bytes({ pointer: tokens, length: promptTokens.length * 4 }); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      promptTokens.forEach((token, index) => view.setInt32(index * 4, token, true));
    } else {
      const tokenized = await tokenizePrompt({
        core,
        vocab,
        prompt: promptPointer,
        promptBytes: promptLength,
        contextTokens: capacity,
        onTokenize: () => {
          measurements.counters.tokenizeCalls++;
        },
      });
      tokens = tokenized.pointer;
      // The helper transfers ownership only after native tokenization has settled.
      allocations.push(tokens);
      promptTokens = tokenized.tokens;
      checkCancelled();
    }
    const tokenCount = multimodal?.tokenCount ?? promptTokens.length;
    measurements.counters.promptTokens = tokenCount;
    let nextPosition = multimodal?.positions ?? tokenCount;
    if (tokenCount >= capacity || nextPosition >= capacity) throw new LlamaCppBrowserError({ code: 'context-full' });
    setStage({ value: 'cache-prepare' });
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
    const checkpointEnabled = !multimodal && memory !== 0n && (() => {
      switch (sequenceRemoval) {
      case 'none': return false;
      case 'full-only': case 'bounded': return true;
      case 'partial': return slidingWindow > 0;
      default: { const exhaustive: never = sequenceRemoval; throw new Error(`Unknown sequence removal capability: ${exhaustive}`); }
      }
    })();
    if (!cacheValid) discardCheckpoint();
    let reusedTokens = reuse ? cachedTokens : 0;
    let reason: Diagnostic['reason'] = reuse ? 'prefix-match' : !cacheValid ? 'cache-invalid'
      : !cachePositionMatches ? 'cache-position' : 'prefix-mismatch';
    cache.validity = 'invalid';
    let attemptedRemoval = false;
    if (!reuse && canRemoveSuffix && !multimodal && memory !== 0n && cacheValid && cachePositionMatches && commonPrefixTokens > 0) {
      // Require the entire original prefix to remain resident. llama.cpp's
      // attention cache keeps every position between min/max; composite memory
      // reports its narrowest retained range. Let native seq_rm decide whether
      // that memory can actually rewind, without model-specific dispatch.
      if (nativePositionMin === 0) {
        // Removing a suffix does not refresh logits. Even a shortened prompt
        // must decode at least its final token before sampling again.
        const retained = Math.min(commonPrefixTokens, tokenCount - 1);
        // Avoid a knowingly unsupported mutation: a checkpoint may still
        // restore an older boundary beyond the native recurrent rollback bound.
        if (retained > 0 && (sequenceRemoval !== 'bounded' || cachedTokens - retained <= nativeRollbackTokens)) {
          attemptedRemoval = true;
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
    const checkpoint = cache.checkpoint;
    let restoredCheckpoint = false;
    // A failed direct mutation may have damaged ordinary attention, which a
    // partial snapshot cannot replace. Only restore an untouched native prefix.
    if (!reuse && reusedTokens === 0 && !attemptedRemoval && checkpointEnabled && cacheValid && cachePositionMatches
      && checkpoint && checkpoint.tokens.length <= commonPrefixTokens && checkpoint.tokens.length < tokenCount
      && checkpoint.tokens.every((token, index) => token === promptTokens[index])) {
      setStage({ value: 'cache-checkpoint' });
      if (await restorePromptCheckpoint({ core, context, checkpoint, observer: checkpointObservation })) {
        reusedTokens = checkpoint.tokens.length;
        cache.tokens = checkpoint.tokens.slice();
        reason = 'checkpoint-match';
        restoredCheckpoint = true;
      } else reason = 'checkpoint-invalid';
    }
    // Full-prefix appends need no restoration. Keeping their earlier checkpoint
    // avoids repeated copies and preserves a boundary before generated thinking.
    if (!reuse && !restoredCheckpoint) discardCheckpoint();
    measurements.counters.reusedTokens = reusedTokens;
    logDiagnostic({
      diagnostic: {
        event: 'cache-reuse',
        reusedTokens,
        evaluatedTokens: tokenCount - reusedTokens,
        tokens: tokenCount,
        cachedTokens,
        commonPrefixTokens,
        cacheComparison,
        nativeMemoryKind,
        nativePositionMin,
        nativePositionMax,
        nativeRollbackTokens,
        reason,
      },
    });
    if (reusedTokens === 0) {
      cache.tokens = [];
      if (memory !== 0n) {
        // Empty positions alone do not prove that recurrent tensors are zero.
        // Require the one-use synchronized probe proof and untouched metadata.
        if (initialMemoryState === 'probe-cleared' && !multimodal && !cacheValid
          && cachedTokens === 0 && nativePositionMin === -1 && nativePositionMax === -1) {
          memoryReset.skippedInitialClears++;
        } else {
          memoryReset.requestedClears++;
          await api.llama_memory_clear(memory, 1);
        }
      }
    }
    let checkpointBoundary: number | undefined;
    if (checkpointEnabled && (!cache.checkpoint || restoredCheckpoint)) {
      setStage({ value: 'cache-checkpoint' });
      checkpointObservation?.enter({ phase: 'boundary-tokenize' });
      let boundary: number;
      try {
        boundary = await promptCheckpointBoundary({
          core,
          vocab,
          prompt: promptText,
          promptPointer,
          generationPrompt: chat.params.generation_prompt,
          tokens: promptTokens,
          onTokenize: () => {
            measurements.counters.checkpointTokenizeCalls++;
          },
        });
      } finally {
        checkpointObservation?.end();
      }
      // The successfully restored host snapshot is still the exact checkpoint
      // when the new generation boundary is unchanged. Do not serialize the
      // very same native state back to the host before decoding any new token.
      // A moved boundary still gets a new checkpoint, preserving retry behavior.
      if (restoredCheckpoint) {
        if (cache.checkpoint?.tokens.length !== boundary) discardCheckpoint();
        else checkpointObservation?.retained();
      }
      if (!cache.checkpoint && boundary > 0 && boundary < tokenCount && boundary >= reusedTokens) checkpointBoundary = boundary;
    }
    const captureAtBoundary = async ({ offset }: { offset: number }): Promise<void> => {
      if (offset !== checkpointBoundary) return;
      setStage({ value: 'cache-checkpoint' });
      // The pointer is published only after the native writer has finished.
      // Cancellation cannot free a buffer while that writer still owns it.
      cache.checkpoint = await capturePromptCheckpoint({ core, context, tokens: cache.tokens, observer: checkpointObservation });
      checkCancelled();
    };
    await captureAtBoundary({ offset: reusedTokens });
    const batch = record({ name: 'llama_batch' });
    if (!multimodal) {
      prefillOutputs = createPrefillOutputs({ core, mode: memory === 0n ? 'per-batch' : 'final-only' });
      measurements.counters.prefillOutputs = prefillOutputs.counters;
    }
    const prefillYield = createPrefillYieldPacing({ now: () => performance.now() });
    setStage({ value: 'prefill-decode' });
    if (multimodal) {
      checkCancelled();
      nextPosition = await multimodal.evaluate({ context, capacity });
      measurements.counters.prefillDecodedTokens += tokenCount;
      checkCancelled();
    } else for (let offset = reusedTokens; offset < tokenCount;) {
      checkCancelled();
      setStage({ value: 'prefill-decode' });
      const boundaryLimit = checkpointBoundary !== undefined && offset < checkpointBoundary ? checkpointBoundary - offset : tokenCount - offset;
      const count = Math.min(prefillBatchTokens, tokenCount - offset, boundaryLimit);
      await api.llama_batch_get_one(batch, tokens + BigInt(offset * 4), count);
      prefillOutputs!.configure({ batch, count, final: offset + count === tokenCount });
      const status = await api.llama_decode(context, batch);
      sampleMemoryDiagnostics({ core, checkpoint: 'decode' });
      measurements.counters.prefillDecodeCalls++;
      measurements.counters.maximumPrefillBatchTokens = Math.max(measurements.counters.maximumPrefillBatchTokens, count);
      if (status === 0) measurements.counters.prefillDecodedTokens += count;
      if (status === 2) checkCancelled();
      if (status !== 0) {
        logDiagnostic({ diagnostic: { event: 'failed', stage, reason: 'decode-status' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      checkCancelled();
      cache.tokens.push(...promptTokens.slice(offset, offset + count));
      offset += count;
      await captureAtBoundary({ offset });
      progress({ phase: 'prefill', completed: offset, total: tokenCount });
      if (prefillYield.shouldYield({ decodedTokens: count })) {
        setStage({ value: 'event-loop-yield' });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        prefillYield.yielded();
      }
    }
    checkCancelled();
    progress({ phase: 'prefill', completed: tokenCount, total: tokenCount });
    checkCancelled();
    sampleMemoryDiagnostics({ core, checkpoint: 'prefill-complete' });
    logDiagnostic({ diagnostic: { event: 'prefill-complete', tokens: tokenCount, reusedTokens, evaluatedTokens: tokenCount - reusedTokens } });
    setStage({ value: 'sampler-create' });
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
      for (const token of promptTokens) await api.llama_sampler_accept(sampler, token);
    }
    if (request.temperature === 0) await addSampler({ child: await api.llama_sampler_init_greedy() });
    else {
      await addSampler({ child: await api.llama_sampler_init_top_k(40) });
      await addSampler({ child: await api.llama_sampler_init_top_p(request.topP, 1n) });
      await addSampler({ child: await api.llama_sampler_init_temp(request.temperature) });
      const seed = crypto.getRandomValues(new Uint32Array(1))[0];
      if (seed === undefined) throw new LlamaCppBrowserError({ code: 'runtime-error' });
      measurements.counters.sampling.seed = seed;
      await addSampler({ child: await api.llama_sampler_init_dist(seed) });
    }
    const samplingChain = sampler; sampler = 0n;
    chatSampler = await createChatSampler({ core, vocab, chain: samplingChain, params: chat.params });
    const stream = createOutputStream({ stops: [...request.stop, ...chat.additionalStops], harmony: false, initialChannel: 'final' });
    let output = ''; let content = ''; let reasoning = ''; let pendingCalls = 0;
    const callDrafts: { name: string, arguments: string }[] = [];
    // Keep tool previews and multimodal behavior per-token for now. Ordinary
    // text/reasoning can avoid reparsing a growing prefix for every token.
    const outputPacing = createOutputPacing({
      mode: chat.images.length || request.tools?.length ? 'per-token' : 'coalesced',
      now: () => performance.now(),
    });
    const streaming = measurements.counters.streaming = {
      mode: outputPacing.mode,
      partialParseCalls: 0,
      finalParseCalls: 0,
      parsedCodeUnits: 0,
      skippedPartialParses: 0,
      deliveredEvents: 0,
    };
    const parseOutput = ({ partial }: { partial: boolean }): Omit<GenerationResult, 'finishReason'> => {
      outputPacing.parsed({ outputLength: output.length });
      streaming.parsedCodeUnits += output.length;
      if (partial) streaming.partialParseCalls++; else streaming.finalParseCalls++;
      return chat!.parse({ text: output, partial });
    };
    let deliveryFailed = false;
    let deliveryDecodeActive = false;
    const deliveryDecode = createDeliveryDecode({
      mode: usesWebGpu({ profile: request.options.profile }) && !multimodal && !request.tools?.length ? 'overlap' : 'serial',
      signal,
      now: (() => {
        switch (request.debug) {
        case 'on': return () => performance.now();
        case 'off': case undefined: return undefined;
        default: { const exhaustive: never = request.debug; throw new Error(String(exhaustive)); }
        }
      })(),
    });
    measurements.counters.deliveryDecode = deliveryDecode.counters;
    const send: GenerationCallback = async ({ event }) => {
      if (!deliveryDecodeActive) setStage({ value: 'stream-emit' });
      try {
        await onEvent({ event });
        streaming.deliveredEvents++;
        outputPacing.delivered();
        if (event.type === 'text' || event.type === 'reasoning') measurements.delivered();
      } catch (error) {
        deliveryFailed = true; throw error;
      }
    };
    const validateParsed = ({ parsed }: { parsed: Omit<GenerationResult, 'finishReason'> }): void => {
      if (!parsed.content.startsWith(content) || !parsed.reasoningContent.startsWith(reasoning) || parsed.toolCalls.length < pendingCalls) {
        logDiagnostic({
          diagnostic: {
            event: 'failed',
            stage,
            tokens: generated,
            reason: !parsed.content.startsWith(content) ? 'non-monotonic-content' : 'non-monotonic-reasoning',
          },
        });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
    };
    const deliverParsed = async ({ parsed }: { parsed: Omit<GenerationResult, 'finishReason'> }): Promise<void> => {
      if (!deliveryDecodeActive) setStage({ value: 'stream-emit' });
      const thought = parsed.reasoningContent.slice(reasoning.length);
      const text = parsed.content.slice(content.length);
      // Commit the accepted parser snapshot before awaiting delivery; never resend a delta.
      content = parsed.content; reasoning = parsed.reasoningContent;
      if (thought) await send({ event: { type: 'reasoning', text: thought } });
      if (text) await send({ event: { type: 'text', text } });
      while (pendingCalls < parsed.toolCalls.length) {
        const index = pendingCalls++;
        callDrafts.push({ name: '', arguments: '' });
        await send({ event: { type: 'tool_call_start', index } });
      }
      for (const [index, call] of parsed.toolCalls.entries()) {
        const previous = callDrafts[index]!;
        const name = previous.name === call.function.name ? undefined : call.function.name;
        let offset = 0;
        while (offset < previous.arguments.length && offset < call.function.arguments.length && previous.arguments[offset] === call.function.arguments[offset]) offset++;
        const changedArguments = offset !== previous.arguments.length || offset !== call.function.arguments.length;
        callDrafts[index] = { name: call.function.name, arguments: call.function.arguments };
        if (!changedArguments) {
          if (name !== undefined) await send({ event: { type: 'tool_call_draft', index, name, arguments: undefined } });
          continue;
        }
        // Native partial parsing can revise an earlier suffix. Do not append a
        // normalized snapshot to the preview or retransmit its growing prefix.
        const suffix = call.function.arguments.slice(offset);
        for (let start = 0; start < suffix.length || start === 0; start += 8192) {
          const text = suffix.slice(start, start + 8192);
          await send({ event: { type: 'tool_call_draft', index, name: start === 0 ? name : undefined, arguments: { offset: offset + start, text } } });
        }
      }
    };
    const emitParsed = ({ parsed }: { parsed: Omit<GenerationResult, 'finishReason'> }): Promise<void> => {
      // Validate synchronously, before the pair helper can start native work.
      // Do this once per snapshot, not again for every delivered delta.
      validateParsed({ parsed });
      return deliverParsed({ parsed });
    };
    let finishReason: GenerationResult['finishReason'] = 'length';
    const renderer = tokenRenderer = createTokenRenderer({ core, vocab, cacheMode: 'bounded' });
    measurements.counters.tokenRendering = renderer.counters;
    const nextToken = alloc({ bytes: 4 });
    flushPartial = async () => {
      if (deliveryFailed) return;
      output += stream.push({ text: renderer.finish() }).text + stream.finish();
      setStage({ value: 'partial-parse' });
      await emitParsed({ parsed: parseOutput({ partial: true }) });
    };
    const position = multimodal ? alloc({ bytes: 4 }) : undefined;
    const remaining = capacity - Math.max(tokenCount, nextPosition);
    const maximum = request.maxTokens === undefined ? remaining : Math.min(request.maxTokens, remaining);
    measurements.counters.maximumTokens = maximum;
    logDiagnostic({ diagnostic: { event: 'generation-start', imageCount: chat.images.length, tokens: tokenCount, pointerBytes: core.pointerBytes, toolCount: request.tools?.length ?? 0 } });
    // Cooperation is independent of parse pacing: enabling tool-preview
    // coalescing later must not also relax the task-yield policy implicitly.
    const generationYield = createGenerationYieldPacing({
      mode: chat.images.length || request.tools?.length ? 'per-token' : 'coalesced',
      now: () => performance.now(),
    });
    measurements.counters.generationYield = generationYield.counters;
    const decodeToken = async ({ token }: { token: number }): Promise<void> => {
      // A synchronous delivery failure/cancellation can be known before the
      // pair helper observes its nested promise. Do not start work then.
      checkCancelled();
      if (deliveryFailed) return;
      if (!deliveryDecodeActive) setStage({ value: 'generation-decode' });
      const tokenBytes = core.bytes({ pointer: nextToken, length: 4 }); new DataView(tokenBytes.buffer, tokenBytes.byteOffset, 4).setInt32(0, token, true);
      await api.llama_batch_get_one(batch, nextToken, 1);
      checkCancelled();
      if (deliveryFailed) return;
      if (position !== undefined) {
        const bytes = core.bytes({ pointer: position, length: 4 }); new DataView(bytes.buffer, bytes.byteOffset, 4).setInt32(0, nextPosition, true);
        core.setField({ name: 'llama_batch', pointer: batch, field: 'pos', value: position });
      }
      const status = await api.llama_decode(context, batch);
      sampleMemoryDiagnostics({ core, checkpoint: 'decode' });
      if (status === 0) measurements.counters.decodedTokens++;
      if (status === 2) checkCancelled();
      if (status !== 0) {
        logDiagnostic({ diagnostic: { event: 'failed', stage: 'generation-decode', reason: 'decode-status' } });
        throw new LlamaCppBrowserError({ code: 'runtime-error' });
      }
      checkCancelled();
    };
    for (; generated < maximum; generated++) {
      checkCancelled();
      setStage({ value: 'native-sample' });
      const token = await chatSampler.sample({ context });
      const throughput = measurements.sampled();
      if (throughput) {
        try {
          logDiagnostic({ diagnostic: { ...throughput, profile: request.options.profile } });
        } catch { /* Progress telemetry must not interrupt inference. */ }
      }
      if (generated === 0) logDiagnostic({ diagnostic: { event: 'first-token-sampled' } });
      setStage({ value: 'token-render' });
      checkCancelled();
      const { text: tokenText, endOfGeneration } = await renderer.render({ token, special: chatSampler.preservedTokens.has(token) });
      measurements.rendered({ endOfGeneration: Boolean(endOfGeneration) });
      const rendered = stream.push({ text: tokenText });
      checkCancelled();
      output += rendered.text;
      let partial: Omit<GenerationResult, 'finishReason'> | undefined;
      if (outputPacing.shouldParse({
        outputLength: output.length,
        force: rendered.done || Boolean(endOfGeneration) || generated + 1 === maximum,
      })) {
        setStage({ value: 'partial-parse' });
        partial = parseOutput({ partial: true });
        // Finish every native read before pairing. emitParsed validates the
        // snapshot synchronously; only owned JS strings cross the interval.
      } else streaming.skippedPartialParses++;
      const terminal = rendered.done || endOfGeneration || (!multimodal && generated + 1 === maximum);
      const pair = partial !== undefined && !terminal && !multimodal && !request.tools?.length
        && partial.toolCalls.length === 0 && pendingCalls === 0
        && (partial.content.length > content.length || partial.reasoningContent.length > reasoning.length);
      if (partial && !pair) {
        await emitParsed({ parsed: partial });
        checkCancelled();
      }
      if (rendered.done || endOfGeneration) {
        const stop = stream.getMatchedStop();
        finishReason = stop !== undefined && request.stop.includes(stop) ? 'stop_sequence' : 'stop'; break;
      }
      if (!multimodal && generated + 1 === maximum) {
        // This answer needs no further logits. Leave its last sampled token
        // outside the decoded cache; a later prompt will evaluate it normally.
        // Do not advance nextPosition or publish an unevaluated cache prefix.
        measurements.counters.terminalDecodeDeferred = true;
        generated++;
        progress({ phase: 'generating', completed: generated, total: maximum });
        break;
      }
      if (pair && partial) {
        const parsed = partial;
        deliveryDecodeActive = deliveryDecode.mode === 'overlap';
        if (deliveryDecodeActive) setStage({ value: 'generation-overlap' });
        try {
          await deliveryDecode.run({ deliver: () => emitParsed({ parsed }), decode: () => decodeToken({ token }) });
        } finally {
          deliveryDecodeActive = false;
        }
      } else await decodeToken({ token });
      checkCancelled();
      // Sampled stop/EOG tokens are deliberately excluded until actually decoded.
      if (!multimodal) cache.tokens.push(token);
      nextPosition++;
      progress({ phase: 'generating', completed: generated + 1, total: maximum });
      checkCancelled();
      if (generationYield.shouldYield()) {
        setStage({ value: 'event-loop-yield' });
        // Keep a real task boundary so queued worker cancellation can run.
        // Native calls remain serialized, including during failed delivery.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        generationYield.yielded();
        checkCancelled();
      }
    }
    checkCancelled();
    const tail = stream.push({ text: renderer.finish() }).text + stream.finish();
    output += tail;
    setStage({ value: 'final-parse' });
    const parsed = parseOutput({ partial: finishReason !== 'stop' });
    await emitParsed({ parsed });
    checkCancelled();
    // Only a completed native turn confirms calls. JSON validity alone does not.
    switch (finishReason) {
    case 'stop':
      for (const [index, toolCall] of parsed.toolCalls.entries()) {
        await send({ event: { type: 'tool_call', index, toolCall } });
        checkCancelled();
      }
      break;
    case 'length': case 'stop_sequence': break;
    default: { const exhaustive: never = finishReason; throw new Error(`Unknown completion: ${exhaustive}`); }
    }
    flushPartial = undefined;
    sampleMemoryDiagnostics({ core, checkpoint: 'generation-complete' });
    logDiagnostic({ diagnostic: { event: 'generation-complete', tokens: generated, elapsedMs: performance.now() - started } });
    cache.validity = !multimodal && memory !== 0n ? 'valid' : 'invalid';
    outcome = 'completed';
    return { ...parsed, finishReason };
  } catch (error) {
    sampleMemoryDiagnostics({ core, checkpoint: 'generation-interrupted' });
    outcome = failureOutcome({ error });
    const failedStage = stage;
    recordFailure({ error, stage: failedStage });
    // Drain already accepted bytes before reporting a cooperative cancellation or failure.
    // Do not retry delivery after a consumer failure or replace the original error.
    try {
      await flushPartial?.();
    } catch (drainError) {
      logFailure({ stage: 'stream-emit', error: drainError });
    }
    cache.validity = 'invalid';
    discardCheckpoint();
    logFailure({ stage: failedStage, error });
    logDiagnostic({ diagnostic: { event: 'failed', stage: failedStage, tokens: generated } });
    throw error;
  } finally {
    setStage({ value: 'cleanup' });
    try {
      await cleanup();
    } finally {
      sampleMemoryDiagnostics({ core, checkpoint: 'generation-cleaned' });
      reportPerformance();
    }
    // The owning worker or a model/profile/file change releases the resident cache.
  }
}
export const TEST_ONLY = {
};
