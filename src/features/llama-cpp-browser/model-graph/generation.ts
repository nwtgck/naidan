import { classifyFailure, logDiagnostic, type Diagnostic } from '@/features/llama-cpp-browser/debug-log';
import { copyNativeUtf8 } from '@/features/llama-cpp-browser/runtime/native-utf8';
import { LlamaCppBrowserError, errorCode, gpuProfilingProfile, type GenerationCallback, type GenerationResult, type Progress } from '@/features/llama-cpp-browser/types';
import type { WorkerGenerateInput } from '@/features/llama-cpp-browser/worker/types';
import { createChatSampler } from '@/features/llama-cpp-browser/worker/chat-sampler';
import { createGenerationPerformance } from '@/features/llama-cpp-browser/worker/generation-performance';
import { createGenerationSpeedTracker } from '@/features/llama-cpp-browser/worker/generation-speed';
import { createGenerationYieldPacing } from '@/features/llama-cpp-browser/worker/generation-yield-pacing';
import { createOutputPacing } from '@/features/llama-cpp-browser/worker/output-pacing';
import { createOutputStream } from '@/features/llama-cpp-browser/worker/output-stream';
import { createTokenRenderer } from '@/features/llama-cpp-browser/worker/token-renderer';
import { encodeChatPrompt, tokenizeChatPrompt } from '@/features/llama-cpp-browser/worker/tokenize-chat-prompt';
import { prepareRegisteredGraph, releaseRegisteredGraph } from './session';
import type { ModelGraphStepTimings } from './engine';

/** Separate generation entry: no model-definition dispatch is inserted into the
 * existing native token loop. Chat formatting, grammar and parsing stay native. */
export async function generateWithRegisteredGraph({ request, signal, onEvent, onProgress, onSummary, native }: {
  request: WorkerGenerateInput, signal: AbortSignal | undefined, onEvent: GenerationCallback,
  onProgress: ({ progress }: { progress: Progress }) => void, onSummary: (({ diagnostic }: { diagnostic: Diagnostic }) => void) | undefined,
  native: () => Promise<GenerationResult>,
}): Promise<GenerationResult> {
  const measured = createGenerationPerformance({ enabled: request.debug === 'on' || request.measurement !== undefined, now: () => performance.now() });
  const session = await prepareRegisteredGraph({ request, signal, onProgress, purpose: request.messages.some(message => typeof message.content !== 'string' && message.content.some(part => part.type !== 'text')) ? 'vision' : 'text' });
  if (!session) {
    return native();
  }
  const { core, engine, vocabulary, vocabularySize, contextSize, batchSize, boundary, execution } = session;
  const { api } = core;
  measured.counters.modelExecution = execution;
  measured.counters.contextTokens = contextSize;
  measured.counters.prefillBatchTokens = batchSize;
  measured.counters.runtimeAssetBaseURL = request.assetBaseURL;
  measured.counters.sampling = { temperature: request.temperature, topP: request.topP, presencePenalty: request.presencePenalty, frequencyPenalty: request.frequencyPenalty };
  measured.counters.input = 'text';
  const graphTiming = measured.counters.registeredGraphTiming = { builds: 0, reuseHits: 0, graphBuildMs: 0, allocationMs: 0, inputMs: 0, computeMs: 0, readbackMs: 0 };
  const observeStep = ({ timing }: { timing: ModelGraphStepTimings }): void => {
    graphTiming.reuseHits += timing.reuseHits;
    graphTiming.builds += timing.builds;
    graphTiming.graphBuildMs += timing.graphBuildMs;
    graphTiming.allocationMs += timing.allocationMs;
    graphTiming.inputMs += timing.inputMs;
    graphTiming.computeMs += timing.computeMs;
    graphTiming.readbackMs += timing.readbackMs;
  };
  let flushAccepted: (() => Promise<void>) | undefined;
  let deliveryFailed = false;
  let outcome: 'completed' | 'aborted' | 'failed' = 'failed';
  let failure: Pick<Diagnostic, 'failureKind'> | undefined;
  let result: GenerationResult | undefined;
  let completionFailure: unknown;
  let chat: ReturnType<typeof core.chat.prepareFromVocabulary> | undefined;
  let sampler: Awaited<ReturnType<typeof createChatSampler>> | undefined;
  let workspace: ReturnType<typeof boundary.createSamplerWorkspace> | undefined;
  let renderer: ReturnType<typeof createTokenRenderer> | undefined;
  let chain = 0n;
  const allocations: bigint[] = [];
  const check = (): void => {
    signal?.throwIfAborted();
  };
  const speed = createGenerationSpeedTracker({ onEvent });
  const progress = ({ phase, completed, total }: { phase: Progress['phase'], completed: number, total: number }): void => onProgress({ progress: { phase, completed, total } });
  try {
    check();
    if (request.options.profile === gpuProfilingProfile || request.messages.some(message => typeof message.content !== 'string' && message.content.some(part => part.type !== 'text'))) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input', details: 'The registered graph currently supports text generation, not media input or the specialized GPU profiling artifact.' });
    }
    logDiagnostic({ diagnostic: { event: 'generation-start', modelExecution: execution, profile: request.options.profile } });
    measured.enter({ next: 'template' });
    chat = core.chat.prepareFromVocabulary({ assertIdle: core.assertIdle, owner: vocabulary.owner, request });
    measured.enter({ next: 'tokenize' });
    const encoded = encodeChatPrompt({ parts: chat.promptParts });
    const prompt = copyNativeUtf8({ core, data: encoded.data });
    allocations.push(prompt);
    const tokenized = await tokenizeChatPrompt({
      core,
      vocab: vocabulary.vocab,
      prompt,
      parts: encoded.parts,
      contextTokens: contextSize,
      onTokenize: () => {
        measured.counters.tokenizeCalls++;
      },
    });
    allocations.push(tokenized.pointer);
    const promptTokens = tokenized.tokens;
    if (!promptTokens.length || promptTokens.length >= contextSize) {
      throw new LlamaCppBrowserError({ code: 'context-full' });
    }
    measured.counters.promptTokens = promptTokens.length;
    measured.counters.reusedTokens = 0;
    measured.enter({ next: 'cache-prepare' });
    await engine.reset();
    measured.counters.memoryReset = { requestedClears: 1, skippedInitialClears: 0 };
    logDiagnostic({ diagnostic: { event: 'prefill-start', modelExecution: execution } });
    for (let offset = 0; offset < promptTokens.length; offset += batchSize) {
      check();
      measured.enter({ next: 'prefill-decode' });
      const tokens = promptTokens.slice(offset, offset + batchSize);
      const timing = await engine.step({ tokens, signal });
      observeStep({ timing });
      measured.counters.prefillDecodedTokens += tokens.length;
      measured.counters.prefillDecodeCalls += timing.computeCalls;
      measured.counters.maximumPrefillBatchTokens = Math.max(measured.counters.maximumPrefillBatchTokens, timing.maximumBatchTokens);
      progress({ phase: 'prefill', completed: offset + tokens.length, total: promptTokens.length });
      // A task boundary lets cancellation messages run even with CPU Wasm.
      measured.enter({ next: 'event-loop-yield' });
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    check();
    logDiagnostic({ diagnostic: { event: 'prefill-complete', tokens: promptTokens.length, reusedTokens: 0, evaluatedTokens: promptTokens.length, modelExecution: execution } });
    measured.enter({ next: 'sampler-create' });
    const params = core.allocRecord({ name: 'llama_sampler_chain_params' });
    allocations.push(params);
    await api.llama_sampler_chain_default_params(params);
    chain = await api.llama_sampler_chain_init(params);
    if (!chain) {
      throw new Error('Registered graph sampler allocation failed');
    }
    const add = async ({ child }: { child: bigint }): Promise<void> => {
      if (!child) {
        throw new Error('Registered graph sampling operation is unavailable');
      }
      try {
        await api.llama_sampler_chain_add(chain, child);
      } catch (error) {
        await api.llama_sampler_free(child);
        throw error;
      }
    };
    if (request.presencePenalty !== 0 || request.frequencyPenalty !== 0) {
      await add({ child: await api.llama_sampler_init_penalties(vocabularySize, contextSize, 1, request.frequencyPenalty, request.presencePenalty) });
      for (const token of promptTokens) {
        await api.llama_sampler_accept(chain, token);
      }
    }
    if (request.temperature === 0) {
      await add({ child: await api.llama_sampler_init_greedy() });
    } else {
      await add({ child: await api.llama_sampler_init_top_k(40) });
      await add({ child: await api.llama_sampler_init_top_p(request.topP, 1n) });
      await add({ child: await api.llama_sampler_init_temp(request.temperature) });
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
      measured.counters.sampling.seed = seed;
      await add({ child: await api.llama_sampler_init_dist(seed) });
    }
    const ownedChain = chain;
    chain = 0n;
    sampler = await createChatSampler({ core, vocab: vocabulary.vocab, chain: ownedChain, params: chat.params });
    workspace = boundary.createSamplerWorkspace({ vocabularySize });
    renderer = createTokenRenderer({ core, vocab: vocabulary.vocab, cacheMode: 'bounded' });
    measured.counters.tokenRendering = renderer.counters;
    const stream = createOutputStream({ stops: [...request.stop, ...chat.additionalStops], harmony: false, initialChannel: 'final' });
    const pacing = createOutputPacing({ mode: request.tools?.length ? 'per-token' : 'coalesced', now: () => performance.now() });
    const yieldPacing = createGenerationYieldPacing({ mode: 'coalesced', now: () => performance.now() });
    measured.counters.generationYield = yieldPacing.counters;
    const streaming = measured.counters.streaming = { mode: pacing.mode, partialParseCalls: 0, finalParseCalls: 0, parsedCodeUnits: 0, skippedPartialParses: 0, deliveredEvents: 0 };
    let output = '', content = '', reasoning = '';
    const drafts: { name: string, arguments: string }[] = [];
    const send: GenerationCallback = async ({ event }) => {
      measured.enter({ next: 'stream-emit' });
      try {
        await onEvent({ event });
      } catch (error) {
        deliveryFailed = true;
        throw error;
      }
      streaming.deliveredEvents++;
      pacing.delivered();
      if (event.type === 'text' || event.type === 'reasoning') {
        measured.delivered();
      }
    };
    const emit = async ({ partial }: { partial: boolean }): Promise<Omit<GenerationResult, 'finishReason'>> => {
      measured.enter({ next: partial ? 'partial-parse' : 'final-parse' });
      pacing.parsed({ outputLength: output.length });
      streaming.parsedCodeUnits += output.length;
      if (partial) {
        streaming.partialParseCalls++;
      } else {
        streaming.finalParseCalls++;
      }
      const parsed = chat!.parse({ text: output, partial });
      if (!parsed.content.startsWith(content) || !parsed.reasoningContent.startsWith(reasoning) || parsed.toolCalls.length < drafts.length) {
        throw new Error('Native graph output parsing is not monotonic');
      }
      const thought = parsed.reasoningContent.slice(reasoning.length), text = parsed.content.slice(content.length);
      reasoning = parsed.reasoningContent;
      content = parsed.content;
      if (thought) {
        await send({ event: { type: 'reasoning', text: thought } });
      }
      if (text) {
        await send({ event: { type: 'text', text } });
      }
      for (const [index, call] of parsed.toolCalls.entries()) {
        if (index === drafts.length) {
          drafts.push({ name: '', arguments: '' });
          await send({ event: { type: 'tool_call_start', index } });
        }
        const old = drafts[index]!;
        const name = old.name === call.function.name ? undefined : call.function.name;
        let offset = 0;
        while (offset < old.arguments.length && offset < call.function.arguments.length && old.arguments[offset] === call.function.arguments[offset]) {
          offset++;
        }
        const changed = offset !== old.arguments.length || offset !== call.function.arguments.length;
        drafts[index] = { name: call.function.name, arguments: call.function.arguments };
        if (!changed) {
          if (name !== undefined) {
            await send({ event: { type: 'tool_call_draft', index, name, arguments: undefined } });
          }
          continue;
        }
        const suffix = call.function.arguments.slice(offset);
        for (let start = 0; start === 0 || start < suffix.length; start += 8192) {
          await send({ event: { type: 'tool_call_draft', index, name: start === 0 ? name : undefined, arguments: { offset: offset + start, text: suffix.slice(start, start + 8192) } } });
        }
      }
      return parsed;
    };
    flushAccepted = async () => {
      // Stop drains only already sampled content, not a new token or tool call.
      output += stream.push({ text: renderer!.finish() }).text + stream.finish();
      await emit({ partial: true });
    };
    const maximum = Math.min(request.maxTokens ?? contextSize, contextSize - promptTokens.length);
    measured.counters.maximumTokens = maximum;
    let finishReason: GenerationResult['finishReason'] = 'length';
    for (let generated = 0; generated < maximum; generated++) {
      check();
      measured.enter({ next: 'native-sample' });
      const token = await sampler.sampleFromLogits({ sample: ({ sampler }) => workspace!.sample({ sampler, logits: engine.logitsPointer }) });
      const sampledAt = performance.now();
      const throughput = measured.sampled();
      if (throughput) {
        logDiagnostic({ diagnostic: { ...throughput, modelExecution: execution, profile: request.options.profile } });
      }
      if (!generated) {
        logDiagnostic({ diagnostic: { event: 'first-token-sampled', modelExecution: execution } });
      }
      measured.enter({ next: 'token-render' });
      const rendered = await renderer.render({ token, special: sampler.preservedTokens.has(token) });
      measured.rendered({ endOfGeneration: rendered.endOfGeneration });
      speed.sample({ sampledAt, endOfGeneration: rendered.endOfGeneration });
      const chunk = stream.push({ text: rendered.text });
      output += chunk.text;
      const terminal = chunk.done || rendered.endOfGeneration || generated + 1 === maximum;
      if (pacing.shouldParse({ outputLength: output.length, force: terminal })) {
        await emit({ partial: true });
      } else {
        streaming.skippedPartialParses++;
      }
      check();
      progress({ phase: 'generating', completed: generated + 1, total: maximum });
      if (chunk.done || rendered.endOfGeneration) {
        finishReason = stream.getMatchedStop() !== undefined && request.stop.includes(stream.getMatchedStop()!) ? 'stop_sequence' : 'stop';
        break;
      }
      if (terminal) {
        measured.counters.terminalDecodeDeferred = true;
        break;
      }
      measured.enter({ next: 'generation-decode' });
      observeStep({ timing: await engine.step({ tokens: [token], signal }) });
      measured.counters.decodedTokens++;
      if (yieldPacing.shouldYield()) {
        measured.enter({ next: 'event-loop-yield' });
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        yieldPacing.yielded();
      }
    }
    check();
    flushAccepted = undefined;
    output += stream.push({ text: renderer.finish() }).text + stream.finish();
    const parsed = await emit({ partial: finishReason !== 'stop' });
    switch (finishReason) {
    case 'length': case 'stop_sequence': break;
    case 'stop': {
      for (const [index, toolCall] of parsed.toolCalls.entries()) {
        await send({ event: { type: 'tool_call', index, toolCall } });
        check();
      }
      break;
    }
    default: {
      const exhaustive: never = finishReason;
      throw new Error(String(exhaustive));
    }
    }
    const generationMetrics = speed.finish();
    outcome = 'completed';
    logDiagnostic({ diagnostic: { event: 'generation-complete', modelExecution: execution, tokens: measured.counters.sampledTokens } });
    result = { ...parsed, finishReason, ...(generationMetrics === undefined ? {} : { generationMetrics }) };
  } catch (caught) {
    let error = caught;
    if (errorCode({ error }) === 'aborted' && !deliveryFailed && flushAccepted) {
      const flush = flushAccepted;
      flushAccepted = undefined;
      try {
        await flush();
      } catch (deliveryError) {
        error = deliveryError;
      }
    }
    const code = errorCode({ error });
    switch (code) {
    case 'aborted': outcome = 'aborted';
      break;
    case 'unavailable': case 'invalid-gguf': case 'duplicate-model': case 'missing-model': case 'storage-error': case 'runtime-error': case 'template-unsupported': case 'reasoning-unsupported': case 'context-full': case 'unsupported-input': case 'busy': case 'worker-failed': case 'audio-model-unsupported': case 'audio-reference-required': case 'audio-reference-invalid': case 'audio-output-empty': outcome = 'failed';
      break;
    default: {
      const exhaustive: never = code;
      throw new Error(String(exhaustive));
    }
    }
    failure = { failureKind: classifyFailure({ error }) };
    throw error;
  } finally {
    measured.enter({ next: 'cleanup' });
    let cleanupFailure: unknown;
    const cleanup = [
      async () => {
        await sampler?.dispose();
      },
      async () => {
        if (chain) {
          await api.llama_sampler_free(chain);
        }
      },
      () => {
        workspace?.close();
      }, () => {
        renderer?.dispose();
      }, () => {
        chat?.dispose();
      },
      ...allocations.reverse().map(pointer => () => core.free({ pointer })),
    ];
    for (const operation of cleanup) {
      try {
        await operation();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    const completed = outcome === 'completed';
    if (cleanupFailure !== undefined) {
      outcome = 'failed';
    }
    // A failed generation must release its owner even if reporting or cleanup
    // also fails. Preserve the original generation/delivery error in that case.
    let ownerReleased = false;
    const releaseOwner = async (): Promise<void> => {
      ownerReleased = true;
      try {
        await releaseRegisteredGraph();
      } catch (error) {
        cleanupFailure ??= error;
      }
    };
    switch (outcome) {
    case 'completed': break;
    case 'aborted': case 'failed': await releaseOwner();
      break;
    default: {
      const exhaustive: never = outcome;
      cleanupFailure ??= new Error(String(exhaustive));
    }
    }
    try {
      const diagnostic = measured.finish({ outcome, profile: request.options.profile });
      if (diagnostic) {
        const evidence = { ...diagnostic, ...failure, modelExecution: execution };
        onSummary?.({ diagnostic: evidence });
        switch (request.debug) {
        case 'on': logDiagnostic({ diagnostic: evidence });
          break;
        case 'off': case undefined: break;
        default: {
          const exhaustive: never = request.debug;
          cleanupFailure ??= new Error(String(exhaustive));
        }
        }
      }
    } catch (error) {
      cleanupFailure ??= error;
    }
    if (cleanupFailure !== undefined && !ownerReleased) {
      await releaseOwner();
    }
    if (completed) {
      completionFailure = cleanupFailure;
    }
  }
  // Do not throw from finally: a reporting/cleanup failure may replace only a
  // successful result, never an earlier generation or delivery failure.
  if (completionFailure !== undefined) {
    throw completionFailure;
  }
  if (result === undefined) {
    throw new Error('Registered graph generation did not produce a result');
  }
  return result;
}

export const TEST_ONLY = {
};
