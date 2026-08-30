import { describe, expect, it, vi } from 'vitest';
import type { ModelSupportInvestigationRepository } from '@/features/transformers-js/model-support-investigation/types';
import { detectReasoningStreamProtocol } from '@/features/transformers-js/reasoning-stream-protocol';
import {
  inspectTemplateBehavior,
  type ModelSupportInvestigationTemplateTokenizer,
} from './inspect-template-behavior';

function repository(): ModelSupportInvestigationRepository {
  return {
    requestedModelId: 'hf.co/org/model',
    normalizedModelId: 'org/model',
    requestedRevision: 'main',
    resolvedRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    apiUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    responseUrl: 'https://huggingface.co/api/models/org/model/revision/main?blobs=true',
    fileCount: 1,
    files: [],
    pipelineTag: 'text-generation',
    libraryName: 'transformers',
    metadata: {},
  };
}

function tokenizer(): ModelSupportInvestigationTemplateTokenizer {
  return {
    constructor: { name: 'ProbeTokenizer' },
    chat_template: '{{ messages }}',
    get_chat_template: vi.fn(({ tools }) => tools ? 'tool template' : 'default template'),
    apply_chat_template: vi.fn((messages, options) => {
      if (options?.tokenize === false) return 'rendered prompt';
      return messages.length > 1 ? [1, 2, 3, 4, 5] : [1, 2, 3];
    }),
  } as unknown as ModelSupportInvestigationTemplateTokenizer;
}

describe('inspectTemplateBehavior', () => {
  it('loads the tokenizer from the resolved commit and records deterministic template cases', async () => {
    const loadTokenizer = vi.fn().mockResolvedValue(tokenizer());
    const result = await inspectTemplateBehavior({ repository: repository(), loadTokenizer });

    expect(loadTokenizer).toHaveBeenCalledWith({
      modelId: 'org/model',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.tokenizerClass).toBe('ProbeTokenizer');
    expect(result.cases).toHaveLength(6);
    expect(result.cases.every(item => item.status === 'passed')).toBe(true);
    expect(result.cases[0]?.inputIds).toEqual([1, 2, 3]);
    expect(result.cases[3]?.selectedTemplate).toBe('tool template');
    expect(result.cases[4]).toMatchObject({
      caseId: 'assistant-tool-call-history',
      addGenerationPrompt: false,
      status: 'passed',
      selectedTemplate: 'tool template',
      messages: [
        { role: 'user' },
        { role: 'assistant', tool_calls: [{ id: 'call_template_probe_1' }] },
      ],
    });
    expect(result.cases[5]).toMatchObject({
      caseId: 'tool-result-continuation',
      status: 'passed',
      selectedTemplate: 'tool template',
      messages: [
        { role: 'user' },
        { role: 'assistant', tool_calls: [{ id: 'call_template_probe_1' }] },
        { role: 'tool', tool_call_id: 'call_template_probe_1' },
      ],
    });
    const getTemplate = (await loadTokenizer.mock.results[0]!.value).get_chat_template;
    expect(getTemplate).toHaveBeenNthCalledWith(1, {});
    expect(getTemplate).toHaveBeenNthCalledWith(4, { tools: expect.any(Array) });
    expect(getTemplate).toHaveBeenNthCalledWith(5, { tools: expect.any(Array) });
    expect(getTemplate).toHaveBeenNthCalledWith(6, { tools: expect.any(Array) });
    expect(result.toolTemplateProvenance).toEqual({
      status: 'observed',
      source: 'chat-template-render',
      generationCaseId: 'tools-generation',
      assistantToolCallCaseId: 'assistant-tool-call-history',
      toolResultContinuationCaseId: 'tool-result-continuation',
      generationInputIds: [1, 2, 3],
      assistantToolCallInputIds: [1, 2, 3, 4, 5],
      toolResultContinuationInputIds: [1, 2, 3, 4, 5],
      generationPromptPrefixMatch: true,
      firstMismatchIndex: undefined,
      assistantToolCallSuffixTokenIds: [4, 5],
    });
  });

  it('records the first tool template token difference without inferring a suffix', async () => {
    const value = tokenizer();
    value.apply_chat_template = vi.fn((messages, options) => {
      if (options?.tokenize === false) return 'rendered prompt';
      return messages.length > 1 ? [1, 9, 3] : [1, 2, 3];
    }) as unknown as ModelSupportInvestigationTemplateTokenizer['apply_chat_template'];
    const result = await inspectTemplateBehavior({
      repository: repository(),
      loadTokenizer: vi.fn().mockResolvedValue(value),
    });

    expect(result.toolTemplateProvenance).toMatchObject({
      status: 'observed',
      generationPromptPrefixMatch: false,
      firstMismatchIndex: 1,
      assistantToolCallSuffixTokenIds: undefined,
    });
  });

  it('records an unsupported template case without failing the whole matrix', async () => {
    const value = tokenizer();
    value.get_chat_template = vi.fn(({ tools }) => {
      if (tools) throw new Error('tool template unavailable');
      return 'default template';
    });
    const result = await inspectTemplateBehavior({
      repository: repository(),
      loadTokenizer: vi.fn().mockResolvedValue(value),
    });

    expect(result.cases.filter(item => item.status === 'passed')).toHaveLength(3);
    expect(result.cases.find(item => item.caseId === 'tools-generation')).toMatchObject({
      status: 'failed',
      failureStage: 'template-selection',
      error: 'tool template unavailable',
    });
    expect(result.cases.find(item => item.caseId === 'assistant-tool-call-history')).toMatchObject({
      status: 'failed',
      failureStage: 'template-selection',
      error: 'tool template unavailable',
    });
    expect(result.cases.find(item => item.caseId === 'tool-result-continuation')).toMatchObject({
      status: 'failed',
      failureStage: 'template-selection',
      error: 'tool template unavailable',
    });
    expect(result.toolTemplateProvenance).toMatchObject({
      status: 'unavailable',
      source: 'chat-template-render',
    });
  });

  it('records enough rendered prompt evidence to reproduce prompt-open thinking without a browser', async () => {
    const value = tokenizer();
    value.apply_chat_template = vi.fn((_messages, options) => {
      if (options?.tokenize === false) {
        return `\
<|startoftext|><|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
<think>
`;
      }
      return [1, 2, 3];
    }) as unknown as ModelSupportInvestigationTemplateTokenizer['apply_chat_template'];
    const result = await inspectTemplateBehavior({
      repository: repository(),
      loadTokenizer: vi.fn().mockResolvedValue(value),
    });
    const userGeneration = result.cases.find(item => item.caseId === 'user-generation');

    expect(userGeneration).toMatchObject({
      status: 'passed',
      addGenerationPrompt: true,
    });
    expect(userGeneration?.renderedText).toBeDefined();
    expect(detectReasoningStreamProtocol({
      renderedGenerationPrompt: userGeneration!.renderedText!,
      renderedConversationPrompt: undefined,
    })).toBe('prompt-open-think');
  });

  it('preserves selected template and rendered text when tokenization fails', async () => {
    const value = tokenizer();
    value.apply_chat_template = vi.fn((_messages, options) => {
      if (options?.tokenize === false) return 'rendered before tokenization';
      throw new Error('tokenization failed');
    }) as unknown as ModelSupportInvestigationTemplateTokenizer['apply_chat_template'];
    const result = await inspectTemplateBehavior({
      repository: repository(),
      loadTokenizer: vi.fn().mockResolvedValue(value),
    });

    expect(result.cases[0]).toMatchObject({
      status: 'failed',
      selectedTemplate: 'default template',
      renderedText: 'rendered before tokenization',
      failureStage: 'tokenize',
      error: 'tokenization failed',
    });
  });

});
