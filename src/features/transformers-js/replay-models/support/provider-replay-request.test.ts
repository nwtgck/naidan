// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { providerReplayCatalog } from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/provider-evidence-catalog';
import { createProviderRequestReplay } from './provider-replay-request';
import { captureProviderChat } from './capture-provider-chat';
import { toMessageId } from '@/01-models/ids';

// A small real Provider/Worker fixture for native-plan ownership, not a public
// scenario dispatcher. Every chat and its structured observations remain below.
const nativePlan = {
  catalog: providerReplayCatalog, caseIds: ['first-turn'] as const,
  artifactPaths: ['onnx/model_q4f16.onnx'], imagePlatform: undefined,
};

describe('explicit Provider native request ownership', () => {
  it('does not let mutation of caller parameters move the native expected settings', async () => {
    const replay = await createProviderRequestReplay(nativePlan);
    const put = vi.spyOn(replay.runtime.TextStreamer.prototype, 'put');
    const end = vi.spyOn(replay.runtime.TextStreamer.prototype, 'end');
    const parameters = {
      temperature: 0, topP: 1, maxCompletionTokens: 17,
      presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined,
      reasoning: { effort: undefined },
    };
    try {
      replay.beginNativeRequest({ caseId: 'first-turn', parameters });
      // The captured native request used 16. Mutating the same object to match
      // it must not retroactively change the independently begun 17-token plan.
      parameters.maxCompletionTokens = 16;
      const capture = captureProviderChat({ provider: replay.provider, request: {
        model: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        messages: [{ id: toMessageId({ raw: 'user' }), role: 'user', parts: [
          { id: 'text', type: 'text', text: 'Template probe user message.', completeness: 'complete' },
        ] }],
        parameters, tools: [], signal: new AbortController().signal,
        debug: undefined, readBinaryObject: undefined,
      } });
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.result).toMatchObject({ type: 'error', error: { message: expect.stringContaining('requested parameters') } });
      expect(observed.parts).toEqual([]);
      expect(() => replay.endRejectedRequest({ outcome: { status: 'fulfilled', result: observed.result } })).toThrow('no rejected native invocation');
      expect(put).not.toHaveBeenCalled();
      // Structured generation flushes cleanup after failure without releasing tokens.
      expect(end).toHaveBeenCalledOnce();
      expect(replay.observations.inferenceCalls).toHaveLength(1);
      expect(replay.observations.forbiddenTransport).toEqual([]);
      expect(replay.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      put.mockRestore(); end.mockRestore();
      await replay.close();
    }
  }, 30_000);

  it('cannot complete a selected request without executing its native call', async () => {
    const replay = await createProviderRequestReplay(nativePlan);
    try {
      expect(() => replay.assertComplete({ requests: 0, nativeCalls: 0 })).toThrow();
      replay.beginNativeRequest({ caseId: 'first-turn', parameters: {
        temperature: 0, topP: 1, maxCompletionTokens: 16,
        presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined,
        reasoning: { effort: undefined },
      } });
      expect(() => replay.endNativeRequest()).toThrow('attempted native inventory');
      expect(() => replay.endRejectedRequest({ outcome: { status: 'fulfilled', result: undefined } })).toThrow('explicit current rejection');
      expect(() => replay.endRejectedRequest({ outcome: { status: 'fulfilled', result: { type: 'finished', next: 'user' } } })).toThrow('explicit current rejection');
      expect(() => replay.assertComplete({ requests: 1, nativeCalls: 0 })).toThrow();
      expect(replay.observations.inferenceCalls).toEqual([]);
    } finally {
      await replay.close();
    }
  }, 30_000);
});
