// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { NaidanRpcLmProvider } from './lm-provider';
import { NaidanPeerManager } from '@/features/naidan-peer-rpc/runtime/manager';
import { getRpcManager } from '@/features/naidan-peer-rpc/runtime/feature';
import { naidanPeerContract } from '@/features/naidan-peer-rpc/contract';
import { createNaidanPeerImplementation } from '@/features/naidan-peer-rpc/implementation';
import { createInferenceBudget } from '@/features/naidan-peer-rpc/handlers/inference/budget';
import type { ReadOnlyInferenceResources } from '@/features/naidan-peer-rpc/handlers/inference/resources';
import { NaidanRpcPeer, expose } from '@/features/naidan-rpc';
import { transportPair } from '@/features/naidan-rpc/test-transport';
import { toNaidanRpcConnectionId, toMessageId } from '@/01-models/ids';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import type { LmParameters } from '@/01-models/types';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';
import { collectTitleGeneration } from '@/logic/collect-title-generation';
import { collectChatGeneration } from '@/logic/collect-chat-generation';

vi.mock('@/features/naidan-peer-rpc/runtime/feature', () => ({ getRpcManager: vi.fn() }));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.clearAllMocks();
});
const connectionId = toNaidanRpcConnectionId({ raw: 'title-compatibility' });
const messages = [{ id: toMessageId({ raw: 'title-input' }), role: 'user' as const, parts: [{ type: 'text' as const, text: 'A title', completeness: 'complete' as const }] }];
const parameters: LmParameters = { ...EMPTY_LM_PARAMETERS, temperature: 0.2, reasoning: { effort: 'none' } };
function fixture({ generate }: { generate: ReadOnlyInferenceResources['generateChat'] }) {
  const transport = transportPair({ capacity: 8, fragmentBytes: 79 }), lifetime = new AbortController();
  const unexpected = (): never => {
    throw new Error('Unexpected inference method');
  };
  const inputBudget = createInferenceBudget({ capacity: 64 * 1024 * 1024 });
  const deliveryBudget = createInferenceBudget({ capacity: 64 * 1024 * 1024 });
  const callee = new NaidanRpcPeer({
    transport: transport.b,
    signal: lifetime.signal,
    limits: { maxCalls: 4, maxCallTimeoutMs: 1000 },
    exports: [expose({
      contract: naidanPeerContract,
      allowedMethods: ['generateChat'],
      implementation: createNaidanPeerImplementation({
        providedMethods: () => ({ status: 'ready', methods: [] }),
        inference: {
          inputBudget,
          deliveryBudget,
          resources: { generateChat: generate, listChatModels: unexpected, listImageModels: unexpected, generateImage: unexpected },
        },
      }),
    })],
  });
  const caller = new NaidanRpcPeer({ transport: transport.a, exports: [], signal: lifetime.signal, limits: { maxCalls: 4, maxCallTimeoutMs: 1000 } });
  // Replace only connection discovery; the provider, protocol and handlers below are real.
  const manager = new NaidanPeerManager({
    dependencies: {
      storage: { readIdentity: unexpected, list: unexpected, update: unexpected, remember: unexpected, remove: unexpected },
      identity: unexpected,
      acquireOwner: unexpected,
      open: unexpected,
      retireResources: unexpected,
      changed: () => {},
      inference: { inputBudget, deliveryBudget, resources: { generateChat: generate, listChatModels: unexpected, listImageModels: unexpected, generateImage: unexpected } },
    },
  });
  vi.spyOn(manager, 'client').mockImplementation(() => caller.client({ contract: naidanPeerContract }));
  vi.mocked(getRpcManager).mockResolvedValue(manager);
  cleanups.push(async () => {
    lifetime.abort(); transport.close(); await Promise.all([caller.retire(), callee.retire()]);
    expect(inputBudget.reserved).toBe(0);
  });
  const provider = new NaidanRpcLmProvider({ connectionId });
  return {
    provider,
    title: ({ effective }: { effective: LmParameters }) => collectTitleGeneration({
      provider,
      endpoint: { type: 'naidan_rpc', connectionId },
      messages,
      model: 'models/local.gguf',
      parameters: effective,
      signal: new AbortController().signal,
    }),
  };
}
const successful: ReadOnlyInferenceResources['generateChat'] = async ({ onEvent }) => {
  await onEvent({ event: { type: 'text', text: 'Title' } });
  return { content: 'Title', reasoningContent: '', toolCalls: [], finishReason: 'stop' };
};

it('preserves 124 title-only off fallback across the typed RPC boundary', async () => {
  const generate = vi.fn<ReadOnlyInferenceResources['generateChat']>().mockRejectedValueOnce(new LlamaCppBrowserError({ code: 'reasoning-unsupported' })).mockImplementation(successful);
  const { title } = fixture({ generate });
  const output = await title({ effective: parameters });
  expect(output.text).toBe('Title'); expect(output.result).toEqual({ type: 'finished', next: 'user' });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[0]?.[0].input.reasoningEffort).toBe('none');
  expect(generate.mock.calls[1]?.[0].input.reasoningEffort).toBeUndefined();
  expect(generate.mock.calls[1]?.[0].input.temperature).toBe(0.2);
  expect(parameters.reasoning.effort).toBe('none');
});

it('never retries regular chat or discloses the provider error text', async () => {
  const generate = vi.fn<ReadOnlyInferenceResources['generateChat']>().mockRejectedValue(new LlamaCppBrowserError({ code: 'reasoning-unsupported' }));
  const { provider } = fixture({ generate }); const abortController = new AbortController();
  const output = await collectChatGeneration({
    items: provider.chat({
      messages,
      model: 'models/local.gguf',
      parameters,
      tools: undefined,
      readBinaryObject: undefined,
      debug: undefined,
      signal: abortController.signal,
    }),
    abortController,
  });
  expect(output.result.type).toBe('error'); expect(generate).toHaveBeenCalledOnce();
});

it('does not treat arbitrary internal error prose as an unsupported reasoning control', async () => {
  const generate = vi.fn<ReadOnlyInferenceResources['generateChat']>().mockRejectedValue(new Error('reasoning is unsupported; secret provider path /private/file'));
  const { title } = fixture({ generate }); const output = await title({ effective: parameters });
  expect(output.result.type).toBe('error'); expect(generate).toHaveBeenCalledOnce();
  if (output.result.type !== 'error') throw new Error('Expected an error');
  expect(output.result.error.message).not.toContain('secret provider');
});

it('does not retry a title after any native output preceded the typed rejection', async () => {
  const generate = vi.fn<ReadOnlyInferenceResources['generateChat']>(async ({ onEvent }) => {
    await onEvent({ event: { type: 'text', text: 'Partial' } });
    throw new LlamaCppBrowserError({ code: 'reasoning-unsupported' });
  });
  const { title } = fixture({ generate }); const output = await title({ effective: parameters });
  expect(output.text).toBe('Partial'); expect(output.result.type).toBe('error'); expect(generate).toHaveBeenCalledOnce();
});

it.each([undefined, 'high'] as const)('does not rewrite the title preference %s', async effort => {
  const generate = vi.fn<ReadOnlyInferenceResources['generateChat']>().mockRejectedValue(new LlamaCppBrowserError({ code: 'reasoning-unsupported' }));
  const { title } = fixture({ generate });
  const output = await title({ effective: { ...parameters, reasoning: { effort } } });
  expect(output.result.type).toBe('error'); expect(generate).toHaveBeenCalledOnce();
});

export const TEST_ONLY = {
};
