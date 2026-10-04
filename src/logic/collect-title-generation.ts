import type { LmProvider, ChatGenerationItem, ChatGenerationResult } from '@/01-models/lm';
import type { ChatMessage, Endpoint, LmParameters } from '@/01-models/types';
import { isUnsupportedReasoningError } from '@/01-models/lm-errors';
import { cloneLmParameters, normalizeLmParameters } from '@/utils/lm-parameters';
import { collectChatGeneration } from './collect-chat-generation';

/** Title-only compatibility policy; never rewrite saved preferences or chat requests. */
export async function collectTitleGeneration({ provider, endpoint, messages, model, parameters, signal }: {
  provider: LmProvider,
  endpoint: Endpoint,
  messages: readonly ChatMessage[],
  model: string,
  parameters: LmParameters | undefined,
  signal: AbortSignal,
}): Promise<{ text: string, result: ChatGenerationResult }> {
  let effective = cloneLmParameters({ lmParameters: parameters });
  // Prompt API cannot express this preference. Other explicitly configured
  // parameters remain intact rather than being silently discarded.
  if (endpoint.type === 'browser_provided_lm' && effective?.reasoning.effort === 'none') {
    effective = normalizeLmParameters({ lmParameters: { ...effective, reasoning: { effort: undefined } } });
  }
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const controller = new AbortController();
    const attemptSignal = AbortSignal.any([signal, controller.signal]);
    let emitted = false;
    const canRetry = ({ error }: { error: unknown }): boolean => attempt === 0
      && effective?.reasoning.effort === 'none' && !signal.aborted && !emitted
      && isUnsupportedReasoningError({ error });
    try {
      const items = provider.chat({
        debug: undefined, messages, model, parameters: effective,
        tools: undefined, readBinaryObject: undefined, signal: attemptSignal,
      });
      async function* observe(): AsyncGenerator<ChatGenerationItem> {
        for await (const item of items) {
          switch (item.type) {
          case 'text': case 'reasoning': case 'tool_call_draft': case 'tool_call': emitted = true; break;
          case 'result': break;
          default: { const exhaustive: never = item; throw new Error(String(exhaustive)); }
          }
          yield item;
        }
      }
      const collected = await collectChatGeneration({ items: observe(), abortController: controller });
      if (collected.result.type !== 'error' || !canRetry({ error: collected.result.error })) return collected;
    } catch (error) {
      if (!canRetry({ error })) throw error;
    }
    // A new attempt controller is necessary: consuming a failed provider may
    // abort the old attempt during cleanup. Unspecified is not thinking on.
    effective = effective === undefined ? undefined : { ...effective, reasoning: { effort: undefined } };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
