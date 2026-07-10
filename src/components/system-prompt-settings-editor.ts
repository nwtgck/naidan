import type { SystemPrompt } from '@/01-models/types';

export type SystemPromptUiMode = 'parent' | 'no_prompt' | 'replace' | 'append';

export function systemPromptUiModeFromValue({
  systemPrompt,
}: {
  systemPrompt: SystemPrompt | undefined,
}): SystemPromptUiMode {
  if (systemPrompt === undefined) return 'parent';
  switch (systemPrompt.behavior) {
  case 'override':
    return systemPrompt.content === null ? 'no_prompt' : 'replace';
  case 'append':
    return 'append';
  default: {
    const _ex: never = systemPrompt;
    throw new Error(`Unhandled system prompt behavior: ${String(_ex)}`);
  }
  }
}

export const TEST_ONLY = {
};
