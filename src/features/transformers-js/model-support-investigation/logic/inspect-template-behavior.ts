import type {
  ModelSupportInvestigationJsonObject,
  ModelSupportInvestigationRepository,
  ModelSupportInvestigationTemplateBehavior,
  ModelSupportInvestigationTemplateCase,
  ModelSupportInvestigationTemplateMessage,
  ModelSupportInvestigationToolTemplateProvenance,
} from '@/features/transformers-js/model-support-investigation/types';
import { parseInvestigationJson } from '@/features/transformers-js/model-support-investigation/logic/json-value-schema';
import { serializeInvestigationError } from '@/features/transformers-js/model-support-investigation/logic/serialize-investigation-error';

type LoadedTokenizer = Awaited<ReturnType<typeof import('@huggingface/transformers').AutoTokenizer.from_pretrained>>;
export type ModelSupportInvestigationTemplateTokenizer = Pick<
  LoadedTokenizer,
  'apply_chat_template' | 'get_chat_template'
> & {
  chat_template?: unknown,
  constructor: { name: string },
};

const TOOLS: ModelSupportInvestigationJsonObject[] = [{
  type: 'function',
  function: {
    name: 'lookup_weather',
    description: 'Return deterministic weather fixture data.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
}];

const FIXTURES: Array<{
  caseId: ModelSupportInvestigationTemplateCase['caseId'],
  messages: ModelSupportInvestigationTemplateMessage[],
  tools: ModelSupportInvestigationJsonObject[] | undefined,
  addGenerationPrompt: boolean,
}> = [
  {
    caseId: 'user-generation',
    messages: [{ role: 'user', content: 'Template probe user message.' }],
    tools: undefined,
    addGenerationPrompt: true,
  },
  {
    caseId: 'system-user-generation',
    messages: [
      { role: 'system', content: 'Template probe system instruction.' },
      { role: 'user', content: 'Template probe user message.' },
    ],
    tools: undefined,
    addGenerationPrompt: true,
  },
  {
    caseId: 'multi-turn-generation',
    messages: [
      { role: 'user', content: 'Template probe first user message.' },
      { role: 'assistant', content: 'Template probe assistant response.' },
      { role: 'user', content: 'Template probe second user message.' },
    ],
    tools: undefined,
    addGenerationPrompt: true,
  },
  {
    caseId: 'tools-generation',
    messages: [{ role: 'user', content: 'Use the weather tool for Tokyo.' }],
    tools: TOOLS,
    addGenerationPrompt: true,
  },
  {
    caseId: 'assistant-tool-call-history',
    messages: [
      { role: 'user', content: 'Use the weather tool for Tokyo.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_template_probe_1',
          type: 'function',
          function: {
            name: 'lookup_weather',
            arguments: '{"city":"Tokyo"}',
          },
        }],
      },
    ],
    tools: TOOLS,
    addGenerationPrompt: false,
  },
  {
    caseId: 'tool-result-continuation',
    messages: [
      { role: 'user', content: 'Use the weather tool for Tokyo.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_template_probe_1',
          type: 'function',
          function: {
            name: 'lookup_weather',
            arguments: '{"city":"Tokyo"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_template_probe_1',
        content: '{"temperatureC":20,"condition":"clear"}',
      },
    ],
    tools: TOOLS,
    addGenerationPrompt: true,
  },
];

function normalizeInputIds({ value }: { value: unknown }): number[] {
  if (!Array.isArray(value)) {
    throw new Error('apply_chat_template did not return an input ID array');
  }
  return value.map((item) => {
    if (typeof item !== 'number' && typeof item !== 'bigint') {
      throw new Error('apply_chat_template returned a non-numeric input ID');
    }
    return Number(item);
  });
}

function failedCase({
  fixture,
  selectedTemplate,
  renderedText,
  failureStage,
  error,
}: {
  fixture: typeof FIXTURES[number],
  selectedTemplate: string | undefined,
  renderedText: string | undefined,
  failureStage: Exclude<ModelSupportInvestigationTemplateCase['failureStage'], undefined>,
  error: unknown,
}): ModelSupportInvestigationTemplateCase {
  return {
    caseId: fixture.caseId,
    messages: fixture.messages,
    tools: fixture.tools,
    addGenerationPrompt: fixture.addGenerationPrompt,
    status: 'failed',
    selectedTemplate,
    renderedText,
    inputIds: undefined,
    failureStage,
    error: serializeInvestigationError({ error }),
  };
}

function inspectCase({
  tokenizer,
  fixture,
}: {
  tokenizer: ModelSupportInvestigationTemplateTokenizer,
  fixture: typeof FIXTURES[number],
}): ModelSupportInvestigationTemplateCase {
  const options = {
    add_generation_prompt: fixture.addGenerationPrompt,
    ...(fixture.tools === undefined ? {} : { tools: fixture.tools }),
  };
  let selectedTemplate: string;
  try {
    selectedTemplate = tokenizer.get_chat_template(
      fixture.tools === undefined ? {} : { tools: fixture.tools },
    );
  } catch (error) {
    return failedCase({
      fixture,
      selectedTemplate: undefined,
      renderedText: undefined,
      failureStage: 'template-selection',
      error,
    });
  }

  let renderedText: string;
  try {
    renderedText = tokenizer.apply_chat_template(
      fixture.messages as Parameters<ModelSupportInvestigationTemplateTokenizer['apply_chat_template']>[0],
      { ...options, tokenize: false },
    );
  } catch (error) {
    return failedCase({
      fixture,
      selectedTemplate,
      renderedText: undefined,
      failureStage: 'render',
      error,
    });
  }

  try {
    const inputIds = tokenizer.apply_chat_template(
      fixture.messages as Parameters<ModelSupportInvestigationTemplateTokenizer['apply_chat_template']>[0],
      { ...options, tokenize: true, return_tensor: false, return_dict: false },
    );
    return {
      caseId: fixture.caseId,
      messages: fixture.messages,
      tools: fixture.tools,
      addGenerationPrompt: fixture.addGenerationPrompt,
      status: 'passed',
      selectedTemplate,
      renderedText,
      inputIds: normalizeInputIds({ value: inputIds }),
      failureStage: undefined,
      error: undefined,
    };
  } catch (error) {
    return failedCase({
      fixture,
      selectedTemplate,
      renderedText,
      failureStage: 'tokenize',
      error,
    });
  }
}

function deriveToolTemplateProvenance({
  cases,
}: {
  cases: ModelSupportInvestigationTemplateCase[],
}): ModelSupportInvestigationToolTemplateProvenance {
  const generation = cases.find(item => item.caseId === 'tools-generation');
  const assistantToolCall = cases.find(item => item.caseId === 'assistant-tool-call-history');
  const toolResultContinuation = cases.find(item => item.caseId === 'tool-result-continuation');
  if (generation?.status !== 'passed' || generation.inputIds === undefined) {
    return {
      status: 'unavailable',
      source: 'chat-template-render',
      generationCaseId: 'tools-generation',
      assistantToolCallCaseId: 'assistant-tool-call-history',
      toolResultContinuationCaseId: 'tool-result-continuation',
      reason: 'The tools-generation template case did not produce token IDs.',
    };
  }
  if (assistantToolCall?.status !== 'passed' || assistantToolCall.inputIds === undefined) {
    return {
      status: 'unavailable',
      source: 'chat-template-render',
      generationCaseId: 'tools-generation',
      assistantToolCallCaseId: 'assistant-tool-call-history',
      toolResultContinuationCaseId: 'tool-result-continuation',
      reason: 'The assistant-tool-call-history template case did not produce token IDs.',
    };
  }
  const commonLength = Math.min(generation.inputIds.length, assistantToolCall.inputIds.length);
  let firstMismatchIndex: number | undefined;
  for (let index = 0; index < commonLength; index += 1) {
    if (generation.inputIds[index] !== assistantToolCall.inputIds[index]) {
      firstMismatchIndex = index;
      break;
    }
  }
  if (firstMismatchIndex === undefined && assistantToolCall.inputIds.length < generation.inputIds.length) {
    firstMismatchIndex = assistantToolCall.inputIds.length;
  }
  const generationPromptPrefixMatch = firstMismatchIndex === undefined;
  const toolResultContinuationInputIds = (() => {
    if (toolResultContinuation === undefined) return undefined;
    const status = toolResultContinuation.status;
    switch (status) {
    case 'passed':
      return toolResultContinuation.inputIds;
    case 'failed':
      return undefined;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled template case status: ${String(_ex)}`);
    }
    }
  })();
  return {
    status: 'observed',
    source: 'chat-template-render',
    generationCaseId: 'tools-generation',
    assistantToolCallCaseId: 'assistant-tool-call-history',
    toolResultContinuationCaseId: 'tool-result-continuation',
    generationInputIds: generation.inputIds,
    assistantToolCallInputIds: assistantToolCall.inputIds,
    toolResultContinuationInputIds,
    generationPromptPrefixMatch,
    firstMismatchIndex,
    assistantToolCallSuffixTokenIds: generationPromptPrefixMatch
      ? assistantToolCall.inputIds.slice(generation.inputIds.length)
      : undefined,
  };
}

export async function inspectTemplateBehavior({
  repository,
  loadTokenizer,
}: {
  repository: ModelSupportInvestigationRepository,
  loadTokenizer: ({ modelId, revision }: {
    modelId: string,
    revision: string,
  }) => Promise<ModelSupportInvestigationTemplateTokenizer>,
}): Promise<ModelSupportInvestigationTemplateBehavior> {
  const tokenizer = await loadTokenizer({
    modelId: repository.normalizedModelId,
    revision: repository.resolvedRevision,
  });
  const cases = FIXTURES.map(fixture => inspectCase({ tokenizer, fixture }));
  return {
    normalizedModelId: repository.normalizedModelId,
    resolvedRevision: repository.resolvedRevision,
    tokenizerClass: tokenizer.constructor.name,
    declaredChatTemplate: tokenizer.chat_template === undefined
      ? undefined
      : parseInvestigationJson({ value: tokenizer.chat_template, label: 'Tokenizer chat_template' }),
    cases,
    toolTemplateProvenance: deriveToolTemplateProvenance({ cases }),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
