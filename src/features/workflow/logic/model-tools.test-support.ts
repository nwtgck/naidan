import { vi } from 'vitest';
import type { LmProvider, ChatGenerationItem } from '@/01-models/lm';
import type { ToolConfig } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import { createWorkflowModelTools } from './model-tools';
import type { WorkflowToolExecutor, WorkflowToolAuthorization } from './tool-execution';
import { createOutputStoreFixture } from './output-store.test-support';
import { stepId } from './workflow.test-support';
import { generateWorkflowText } from './generation';
import type { WorkflowGenerationInput, WorkflowOutputs } from './runtime';
import { releaseValues } from './values';

export function modelCall({ id, name, args, index }: { id: string, name: string, args: string, index: number }): Extract<ChatGenerationItem, { type: 'tool_call' }> {
  return { type: 'tool_call', partId: id, index, toolCall: { id: toToolCallId({ raw: id }), type: 'function', function: { name, arguments: args } } };
}

export function modelText({ text }: { text: string }): ChatGenerationItem {
  return {
    type: 'text',
    index: 0,
    partId: 'text',
    chunks: (async function* () {
      yield text;
    })(),
    completeness: Promise.resolve('complete'),
  };
}

export function modelToolsFixture({ configs }: { configs: ToolConfig[] }) {
  const fixture = createOutputStoreFixture({ limits: { maxBytes: 8 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxEntries: 128, maxPendingWriteBytes: 128 * 1024, maxWriteChunkBytes: 32768 } });
  const step: Extract<import('@/01-models/workflow').WorkflowStep, { type: 'text_generation' }> = {
    type: 'text_generation',
    id: stepId({ raw: 'model' }),
    name: 'Model',
    target: { type: 'model', endpoint: { type: 'ollama', url: 'http://localhost' }, modelId: 'test' },
    conversation: { type: 'conversation', messages: [] },
    appendMessages: [],
    systemPrompt: undefined,
    lmParameters: undefined,
    toolConfigs: configs,
  };
  step.toolConfigs = configs;
  const controller = new AbortController();
  const authorize = vi.fn<WorkflowToolAuthorization>(async () => true);
  const execute = vi.fn<WorkflowToolExecutor>(async () => ({ outcome: { status: 'success', content: '2' }, metadata: {} }));
  const requestChoice = vi.fn(async () => 1);
  const input: WorkflowGenerationInput = {
    step,
    target: { type: 'model', endpoint: { type: 'ollama', url: 'http://localhost' }, modelId: 'test' },
    targetSources: ['definition'],
    conversation: [{ role: 'user', parts: [{ type: 'json', value: 'question' }] }],
    signal: controller.signal,
    store: fixture.store,
  };
  const owned: WorkflowOutputs[] = [];
  return {
    ...fixture,
    input,
    controller,
    authorize,
    execute,
    requestChoice,
    tools() {
      return createWorkflowModelTools({ configs: step.toolConfigs, policy: step.toolExecution, authorize, execute, requestChoice });
    },
    async generate({ provider }: { provider: LmProvider }): Promise<WorkflowOutputs> {
      const outputs = await generateWorkflowText({ input, provider, tools: this.tools(), onProgress: undefined });
      owned.push(outputs);
      return outputs;
    },
    async [Symbol.asyncDispose]() {
      controller.abort();
      await releaseValues({ values: owned.flatMap(Object.values) });
      await fixture[Symbol.asyncDispose]();
    },
  };
}

export const TEST_ONLY = {
};
