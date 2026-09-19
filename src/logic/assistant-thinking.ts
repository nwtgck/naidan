/** Applies Naidan's stored ordinary-assistant thinking policy to settled text. */
export function splitAssistantThinking({ content }: { content: string }): {
  content: string;
  thinking: string | undefined;
} {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = [...content.matchAll(thinkRegex)];
  if (matches.length === 0) return { content, thinking: undefined };
  return {
    content: content.replace(thinkRegex, '').trim(),
    thinking: matches.map(match => match[1]?.trim()).filter(Boolean).join('\n\n---\n\n'),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
