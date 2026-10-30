import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { ChatPromptPart } from '@/features/llama-cpp-browser/runtime/chat-bindings';
import type { GenerateInput } from '@/features/llama-cpp-browser/types';

export type LiveTemplate = { firstHeader: string, userHeader: string, userFooter: string, assistantHeader: string, assistantFooter: string };

/** Same public-template derivation as upstream server-realtime, with unique
 * sentinels and prefix proofs. No model-specific ChatML strings are invented. */
export function deriveLiveTemplate({ render }: {
  render: ({ messages, generationPrompt }: { messages: GenerateInput['messages'], generationPrompt: 'include' | 'omit' }) => string,
}): LiveTemplate {
  const user = `user-${crypto.randomUUID()}`;
  const reply = `reply-${crypto.randomUUID()}`;
  const u = { role: 'user', content: user } as const;
  const a = { role: 'assistant', content: reply } as const;
  const one = render({ messages: [u], generationPrompt: 'omit' });
  const generation = render({ messages: [u], generationPrompt: 'include' });
  const answered = render({ messages: [u, a], generationPrompt: 'omit' });
  const next = render({ messages: [u, a, u], generationPrompt: 'omit' });
  const first = one.indexOf(user);
  const response = answered.indexOf(reply);
  const second = next.indexOf(user, answered.length);
  if (first < 0 || response < one.length || second < answered.length
    || !answered.startsWith(one) || !next.startsWith(answered) || !generation.startsWith(one)
    || one.indexOf(user, first + user.length) !== -1 || answered.indexOf(reply, response + reply.length) !== -1) {
    throw new Error('The model template does not support incremental live turns');
  }
  return {
    firstHeader: one.slice(0, first),
    userFooter: one.slice(first + user.length),
    assistantHeader: generation.slice(one.length),
    assistantFooter: answered.slice(response + reply.length),
    userHeader: next.slice(answered.length, second),
  };
}

/** Preserve input provenance while extracting a suffix, including tool results.
 * Tool output containing token spellings must never become template syntax. */
export function sliceLivePrompt({ parts, offset }: { parts: readonly ChatPromptPart[], offset: number }): ChatPromptPart[] {
  const total = parts.reduce((sum, part) => sum + part.text.length, 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > total) {
    throw new Error('Invalid live prompt boundary');
  }
  let position = 0;
  return parts.flatMap(part => {
    const start = position;
    position += part.text.length;
    return position > offset ? [{ text: part.text.slice(Math.max(0, offset - start)), isInput: part.isInput }] : [];
  });
}

export function createLiveTemplateRenderer({ core, model, instructions, tools }: {
  core: Core, model: bigint, instructions: string, tools: NonNullable<GenerateInput['tools']>,
}) {
  return ({ messages, generationPrompt }: { messages: GenerateInput['messages'], generationPrompt: 'include' | 'omit' }) => core.chat.prepareWithGenerationPrompt({
    assertIdle: core.assertIdle,
    model,
    generationPrompt,
    request: { messages: [...(instructions ? [{ role: 'system' as const, content: instructions }] : []), ...messages], tools, reasoningEffort: 'none' },
  });
}

export const TEST_ONLY = {
};
