// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { providerReplayCatalog } from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/provider-evidence-catalog';
import { createProviderRequestReplay } from './provider-replay-request';

// A small real Provider/Worker fixture for native-plan ownership, not a public
// scenario dispatcher. Every chat and its callback observations remain below.
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
    const chunks: string[] = [];
    try {
      replay.beginNativeRequest({ caseId: 'first-turn', parameters });
      // The captured native request used 16. Mutating the same object to match
      // it must not retroactively change the independently begun 17-token plan.
      parameters.maxCompletionTokens = 16;
      await expect(replay.provider.chat({
        model: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        messages: [{ role: 'user', content: 'Template probe user message.' }],
        parameters, tools: [], signal: new AbortController().signal,
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
      })).rejects.toThrow('requested parameters');
      expect(chunks).toEqual([]);
      expect(put).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
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
      expect(() => replay.assertComplete({ requests: 1, nativeCalls: 0 })).toThrow();
      expect(replay.observations.inferenceCalls).toEqual([]);
    } finally {
      await replay.close();
    }
  }, 30_000);
});
