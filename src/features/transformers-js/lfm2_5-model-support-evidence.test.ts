import { Template } from '@huggingface/jinja';
import { describe, expect, it, vi } from 'vitest';
import { detectReasoningStreamProtocol } from './reasoning-stream-protocol';
import {
  detectStandardToolCallProtocol,
  formatStandardMessagesForToolCallProtocol,
} from './standard-tool-call-protocol';
import { TEST_ONLY as evidenceFixtureTestOnly } from './model-support-investigation/fixtures/lfm2_5-model-support-evidence';

const { LFM2_5_MODEL_SUPPORT_EVIDENCE: evidence } = evidenceFixtureTestOnly;
type StandardToolCallTokenizer = Parameters<typeof detectStandardToolCallProtocol>[0]['tokenizer'];
const GENERATION_PROMPT_SUFFIX = `\
<|im_start|>assistant
<think>`;

function renderEvidenceTemplate({
  messages,
  tools,
  addGenerationPrompt,
}: {
  messages: readonly Record<string, unknown>[],
  tools: readonly Record<string, unknown>[] | undefined,
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
    apply_chat_template: (messages: readonly Record<string, unknown>[], options: Record<string, unknown>) => renderEvidenceTemplate({
      messages,
      tools: options['tools'] as readonly Record<string, unknown>[] | undefined,
      addGenerationPrompt: options['add_generation_prompt'] === true,
    }),
  } as unknown as StandardToolCallTokenizer;
}

describe('LFM2.5 Model Support Investigation evidence replay', () => {
  it('reproduces the recorded tools-generation template output without a browser or model', () => {
    const rendered = renderEvidenceTemplate({
      messages: evidence.toolsGeneration.messages,
      tools: evidence.toolsGeneration.tools,
      addGenerationPrompt: true,
    });

    expect(rendered).toBe(evidence.toolsGeneration.renderedText);
    expect(rendered).toContain('List of tools:');
    expect(rendered.endsWith(GENERATION_PROMPT_SUFFIX)).toBe(true);
  });

  it('reproduces the recorded JSON-string tool-history failure from the real chat template', () => {
    expect(() => renderEvidenceTemplate({
      messages: evidence.assistantToolCallHistory.messages,
      tools: evidence.assistantToolCallHistory.tools,
      addGenerationPrompt: false,
    })).toThrow(evidence.assistantToolCallHistory.errorMessage);
  });

  it('converts Naidan tool-call history to the mapping shape required by the recorded template', () => {
    const formatted = formatStandardMessagesForToolCallProtocol({
      messages: evidence.toolResultContinuation.messages,
      protocol: 'delimited-pythonic',
    });
    const rendered = renderEvidenceTemplate({
      messages: formatted,
      tools: evidence.toolResultContinuation.tools,
      addGenerationPrompt: true,
    });

    expect(rendered).toContain("<|tool_call_start|>[lookup_weather(city='Tokyo')]<|tool_call_end|>");
    expect(rendered).toContain('{"temperatureC":20,"condition":"clear"}<|im_end|>');
    expect(rendered.endsWith(GENERATION_PROMPT_SUFFIX)).toBe(true);
  });

  it('detects the Pythonic tool protocol from the recorded chat template without model-name routing', () => {
    const tokenizer = evidenceTokenizer();
    expect(detectStandardToolCallProtocol({ tokenizer, debugLog: vi.fn() })).toBe('delimited-pythonic');
  });

  it('detects prompt-open reasoning from the recorded chat template without running the model', () => {
    const renderedConversationPrompt = renderEvidenceTemplate({
      messages: evidence.userGeneration.messages,
      tools: undefined,
      addGenerationPrompt: false,
    });
    const renderedGenerationPrompt = renderEvidenceTemplate({
      messages: evidence.userGeneration.messages,
      tools: undefined,
      addGenerationPrompt: true,
    });

    expect(renderedGenerationPrompt).toBe(evidence.userGeneration.renderedText);
    expect(detectReasoningStreamProtocol({
      renderedGenerationPrompt,
      renderedConversationPrompt,
    })).toBe('prompt-open-think');
  });
});
