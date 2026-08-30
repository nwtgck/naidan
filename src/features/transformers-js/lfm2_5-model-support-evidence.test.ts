import { Template } from '@huggingface/jinja';
import { describe, expect, it, vi } from 'vitest';
import { resolveGenerationBudget } from './generation-budget';
import {
  createReasoningStreamNormalizer,
  detectReasoningStreamProtocol,
} from './reasoning-stream-protocol';
import {
  createStandardToolCallStreamParser,
  detectStandardToolCallProtocol,
  formatStandardMessagesForToolCallProtocol,
} from './standard-tool-call-protocol';
import type { WorkerToolDefinition } from './types';
import { TEST_ONLY as evidenceFixtureTestOnly } from './model-support-investigation/fixtures/lfm2_5-model-support-evidence';

const { LFM2_5_MODEL_SUPPORT_EVIDENCE: evidence } = evidenceFixtureTestOnly;
type StandardToolCallTokenizer = Parameters<typeof detectStandardToolCallProtocol>[0]['tokenizer'];
type StandardToolCallMessages = Parameters<typeof formatStandardMessagesForToolCallProtocol>[0]['messages'];
type EvidenceTemplateCase = {
  readonly caseId: string,
  readonly status: 'passed' | 'failed',
  readonly messages: StandardToolCallMessages,
  readonly tools?: readonly Record<string, unknown>[],
  readonly addGenerationPrompt: boolean,
  readonly renderedText?: string,
  readonly inputIds?: readonly number[] | null,
  readonly failureStage?: string,
  readonly errorMessage?: string,
};

const GENERATION_PROMPT_SUFFIX = `\
<|im_start|>assistant
<think>`;
const PASSED_TEMPLATE_CASE_IDS = [
  'user-generation',
  'system-user-generation',
  'multi-turn-generation',
  'tools-generation',
] as const;
const FAILED_TOOL_HISTORY_CASE_IDS = [
  'assistant-tool-call-history',
  'tool-result-continuation',
] as const;

function templateCase({ caseId }: { caseId: string }): EvidenceTemplateCase {
  const found = (evidence.templateBehavior.cases as readonly EvidenceTemplateCase[])
    .find(testCase => testCase.caseId === caseId);
  if (!found) throw new Error(`Missing LFM2.5 Evidence template case: ${caseId}`);
  return found;
}

function renderEvidenceTemplate({
  messages,
  tools,
  addGenerationPrompt,
}: {
  messages: readonly unknown[],
  tools: readonly unknown[] | undefined,
  addGenerationPrompt: boolean,
}): string {
  const template = new Template(evidence.tokenizerConfig.chatTemplate);
  return template.render({
    messages,
    tools: tools ?? null,
    documents: null,
    add_generation_prompt: addGenerationPrompt,
    bos_token: evidence.tokenizerConfig.bosToken,
    eos_token: evidence.tokenizerConfig.eosToken,
    pad_token: evidence.tokenizerConfig.padToken,
  });
}

function evidenceTokenizer(): StandardToolCallTokenizer {
  return {
    apply_chat_template: (messages: readonly unknown[], options: Record<string, unknown>) => renderEvidenceTemplate({
      messages,
      tools: options['tools'] as readonly unknown[] | undefined,
      addGenerationPrompt: options['add_generation_prompt'] === true,
    }),
  } as unknown as StandardToolCallTokenizer;
}

function workerToolsFromEvidence({ tools }: {
  tools: readonly Record<string, unknown>[],
}): WorkerToolDefinition[] {
  return tools.map(tool => JSON.parse(JSON.stringify(tool)) as WorkerToolDefinition);
}

function normalizedPromptOpenStream({ chunks }: { chunks: readonly string[] }): string {
  const output: string[] = [];
  const normalizer = createReasoningStreamNormalizer({
    protocol: 'prompt-open-think',
    onOutput: ({ output: chunk }) => output.push(chunk),
  });
  for (const chunk of chunks) normalizer.feed({ output: chunk });
  normalizer.flush();
  return output.join('');
}

function parseRenderedToolCalls({
  rendered,
  tools,
  oneCharacterAtATime = false,
}: {
  rendered: string,
  tools: WorkerToolDefinition[],
  oneCharacterAtATime?: boolean,
}) {
  const visibleText: string[] = [];
  const parser = createStandardToolCallStreamParser({
    protocol: 'delimited-pythonic',
    tools,
    onText: ({ text }) => visibleText.push(text),
  });

  const start = rendered.indexOf('<|tool_call_start|>');
  const endMarker = '<|tool_call_end|>';
  const end = rendered.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Rendered Evidence prompt did not contain a complete tool-call block.');
  const block = rendered.slice(start, end + endMarker.length);
  if (oneCharacterAtATime) {
    for (const character of block) parser.feed({ output: character });
  } else {
    parser.feed({ output: block });
  }
  parser.flush();
  return {
    calls: parser.drainToolCalls(),
    visibleText: visibleText.join(''),
    block,
  };
}

describe('LFM2.5 Model Support Investigation Evidence replay', () => {
  it('uses the repository-declared 128k context as the model-free default generation ceiling', () => {
    const inputTokenCount = evidence.productionLane.firstTurn.inputTokenIds.length;
    const budget = resolveGenerationBudget({
      modelConfig: {
        model_type: evidence.repositoryDeclarations.modelType,
        is_encoder_decoder: false,
        max_position_embeddings: evidence.repositoryDeclarations.maxPositionEmbeddings,
      },
      inputs: { input_ids: { dims: [1, inputTokenCount] } },
      pastKeyValues: null,
      maxCompletionTokens: undefined,
    });

    expect(budget).toMatchObject({
      maxNewTokens: evidence.repositoryDeclarations.maxPositionEmbeddings - inputTokenCount,
      source: 'model-context',
      contextLimit: 128_000,
      promptTokenCount: inputTokenCount,
    });
  });
  describe('recorded chat-template behavior', () => {
    it.each(PASSED_TEMPLATE_CASE_IDS)('reproduces the recorded %s render exactly', (caseId) => {
      const testCase = templateCase({ caseId });
      expect(testCase.status).toBe('passed');
      const rendered = renderEvidenceTemplate({
        messages: testCase.messages,
        tools: testCase.tools,
        addGenerationPrompt: testCase.addGenerationPrompt,
      });

      expect(rendered).toBe(testCase.renderedText);
      expect(rendered.endsWith(GENERATION_PROMPT_SUFFIX)).toBe(true);
    });

    it.each(FAILED_TOOL_HISTORY_CASE_IDS)('reproduces the recorded %s JSON-string failure exactly', (caseId) => {
      const testCase = templateCase({ caseId });
      expect(testCase.status).toBe('failed');
      expect(testCase.failureStage).toBe('render');
      expect(() => renderEvidenceTemplate({
        messages: testCase.messages,
        tools: testCase.tools,
        addGenerationPrompt: testCase.addGenerationPrompt,
      })).toThrow(testCase.errorMessage);
    });

    it('keeps the recorded system/tool declaration ordering and generation prompt', () => {
      const testCase = templateCase({ caseId: 'tools-generation' });
      const rendered = renderEvidenceTemplate({
        messages: testCase.messages,
        tools: testCase.tools,
        addGenerationPrompt: true,
      });

      const systemIndex = rendered.indexOf(`\
<|im_start|>system
List of tools:`);
      const userIndex = rendered.indexOf(`\
<|im_start|>user
Use the weather tool for Tokyo.`);
      const assistantIndex = rendered.lastIndexOf(GENERATION_PROMPT_SUFFIX);
      expect(systemIndex).toBeGreaterThanOrEqual(0);
      expect(userIndex).toBeGreaterThan(systemIndex);
      expect(assistantIndex).toBeGreaterThan(userIndex);
    });
  });

  describe('Production routing and reasoning', () => {
    it.each(PASSED_TEMPLATE_CASE_IDS)('detects prompt-open reasoning from the recorded %s template case', (caseId) => {
      const testCase = templateCase({ caseId });
      const renderedConversationPrompt = renderEvidenceTemplate({
        messages: testCase.messages,
        tools: testCase.tools,
        addGenerationPrompt: false,
      });
      const renderedGenerationPrompt = renderEvidenceTemplate({
        messages: testCase.messages,
        tools: testCase.tools,
        addGenerationPrompt: true,
      });

      expect(renderedGenerationPrompt).toBe(testCase.renderedText);
      expect(detectReasoningStreamProtocol({
        renderedGenerationPrompt,
        renderedConversationPrompt,
      })).toBe('prompt-open-think');
    });

    it('replays the recorded first-turn stream without losing or duplicating model output', () => {
      const turn = evidence.productionLane.firstTurn;
      expect(turn.streamChunks.join('')).toBe(turn.generatedText);
      expect(normalizedPromptOpenStream({ chunks: turn.streamChunks }))
        .toBe(`<think>${turn.generatedText}`);
    });

    it('replays the recorded continuity stream without losing or duplicating model output', () => {
      const turn = evidence.productionLane.continuity.secondTurn;
      expect(turn.streamChunks.join('')).toBe(turn.generatedText);
      expect(normalizedPromptOpenStream({ chunks: turn.streamChunks }))
        .toBe(`<think>${turn.generatedText}`);
    });

    it('preserves the recorded Reference/Production first-turn input parity as an Evidence invariant', () => {
      const userCase = templateCase({ caseId: 'user-generation' });
      expect(evidence.laneComparison.exactInputMatch).toBe(true);
      expect(evidence.productionLane.firstTurn.inputTokenIds).toEqual(userCase.inputIds);
      expect(evidence.laneComparison.productionInputTokenIds).toEqual(userCase.inputIds);
      expect(evidence.laneComparison.referenceInputTokenIds).toEqual(userCase.inputIds);
    });
  });

  describe('Pythonic function-call protocol', () => {
    it('detects the protocol from the recorded template without model-name routing', () => {
      expect(detectStandardToolCallProtocol({ tokenizer: evidenceTokenizer(), debugLog: vi.fn() }))
        .toBe('delimited-pythonic');
    });

    it.each(FAILED_TOOL_HISTORY_CASE_IDS)('repairs the recorded %s failure by mapping stored JSON arguments before render', (caseId) => {
      const testCase = templateCase({ caseId });
      const formatted = formatStandardMessagesForToolCallProtocol({
        messages: testCase.messages,
        protocol: 'delimited-pythonic',
      });
      const rendered = renderEvidenceTemplate({
        messages: formatted,
        tools: testCase.tools,
        addGenerationPrompt: testCase.addGenerationPrompt,
      });

      expect(rendered).toContain("<|tool_call_start|>[lookup_weather(city='Tokyo')]<|tool_call_end|>");
      if (caseId === 'tool-result-continuation') {
        expect(rendered).toContain('{"temperatureC":20,"condition":"clear"}<|im_end|>');
        expect(rendered.endsWith(GENERATION_PROMPT_SUFFIX)).toBe(true);
      } else {
        expect(rendered.endsWith('<|im_end|>\n')).toBe(true);
      }
    });

    it('round-trips the corrected recorded assistant tool call through the Production parser', () => {
      const testCase = templateCase({ caseId: 'assistant-tool-call-history' });
      if (!testCase.tools) throw new Error('Expected tools in Evidence case.');
      const formatted = formatStandardMessagesForToolCallProtocol({
        messages: testCase.messages,
        protocol: 'delimited-pythonic',
      });
      const rendered = renderEvidenceTemplate({
        messages: formatted,
        tools: testCase.tools,
        addGenerationPrompt: false,
      });
      const parsed = parseRenderedToolCalls({
        rendered,
        tools: workerToolsFromEvidence({ tools: testCase.tools }),
        oneCharacterAtATime: true,
      });

      expect(parsed.visibleText).toBe('');
      expect(parsed.calls).toHaveLength(1);
      expect(parsed.calls[0]?.function.name).toBe('lookup_weather');
      expect(JSON.parse(parsed.calls[0]!.function.arguments)).toEqual({ city: 'Tokyo' });
    });

    it('round-trips all argument shapes emitted by the recorded chat-template formatter', () => {
      const argumentsObject = {
        text: "line\nquote'slash\\\r",
        object: { nested: [1, true, null, 'x'] },
        array: ['a', 2, false, null],
        count: -2.5,
        enabled: true,
      };
      const tools: WorkerToolDefinition[] = [{
        type: 'function',
        function: {
          name: 'complex_tool',
          description: 'Evidence-derived template round-trip fixture.',
          parameters: { type: 'object' },
        },
      }];
      const formatted = formatStandardMessagesForToolCallProtocol({
        messages: [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_complex',
            type: 'function',
            function: { name: 'complex_tool', arguments: JSON.stringify(argumentsObject) },
          }],
        }],
        protocol: 'delimited-pythonic',
      });
      const rendered = renderEvidenceTemplate({
        messages: formatted,
        tools,
        addGenerationPrompt: false,
      });
      const parsed = parseRenderedToolCalls({ rendered, tools, oneCharacterAtATime: true });

      expect(parsed.calls).toHaveLength(1);
      expect(JSON.parse(parsed.calls[0]!.function.arguments)).toEqual(argumentsObject);
    });

    it('round-trips multiple calls and empty arguments through the recorded template', () => {
      const tools: WorkerToolDefinition[] = [
        {
          type: 'function',
          function: { name: 'first_tool', description: 'First.', parameters: { type: 'object' } },
        },
        {
          type: 'function',
          function: { name: 'second_tool', description: 'Second.', parameters: { type: 'object' } },
        },
      ];
      const formatted = formatStandardMessagesForToolCallProtocol({
        messages: [{
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_first',
              type: 'function',
              function: { name: 'first_tool', arguments: '{}' },
            },
            {
              id: 'call_second',
              type: 'function',
              function: { name: 'second_tool', arguments: JSON.stringify({ value: 'second' }) },
            },
          ],
        }],
        protocol: 'delimited-pythonic',
      });
      const rendered = renderEvidenceTemplate({
        messages: formatted,
        tools,
        addGenerationPrompt: false,
      });
      const parsed = parseRenderedToolCalls({ rendered, tools, oneCharacterAtATime: true });

      expect(parsed.block).toContain("<|tool_call_start|>[first_tool(), second_tool(value='second')]<|tool_call_end|>");
      expect(parsed.calls.map(call => ({
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as unknown,
      }))).toEqual([
        { name: 'first_tool', arguments: {} },
        { name: 'second_tool', arguments: { value: 'second' } },
      ]);
    });
  });
});
