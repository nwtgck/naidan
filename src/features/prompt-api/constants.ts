import type { PromptApiCreateCoreOptions } from './language-model';

export const PROMPT_API_MODEL_ID = 'browser-provided-language-model';

export const PROMPT_API_CORE_OPTIONS = {
  expectedInputs: [{ type: 'text' }],
  expectedOutputs: [{ type: 'text' }],
} satisfies PromptApiCreateCoreOptions;

export const TEST_ONLY = {};
