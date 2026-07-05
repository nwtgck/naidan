import type { PromptApiCreateCoreOptions, PromptApiInputMode } from './language-model';

export const BROWSER_PROVIDED_LM_MODEL_ID = 'browser-provided-language-model';

const PROMPT_API_TEXT_CORE_OPTIONS = {
  expectedInputs: [{ type: 'text' }],
  expectedOutputs: [{ type: 'text' }],
} satisfies PromptApiCreateCoreOptions;

const PROMPT_API_IMAGE_CORE_OPTIONS = {
  expectedInputs: [{ type: 'image' }],
  expectedOutputs: [{ type: 'text' }],
} satisfies PromptApiCreateCoreOptions;

export function getPromptApiCoreOptions({ inputMode }: {
  inputMode: PromptApiInputMode,
}): PromptApiCreateCoreOptions {
  switch (inputMode) {
  case 'text':
    return PROMPT_API_TEXT_CORE_OPTIONS;
  case 'image':
    return PROMPT_API_IMAGE_CORE_OPTIONS;
  default: {
    const _ex: never = inputMode;
    throw new Error(`Unhandled Prompt API input mode: ${_ex}`);
  }
  }
}

export const TEST_ONLY = {};
