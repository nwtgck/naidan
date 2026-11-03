import { vi } from 'vitest';
import type { WorkflowDefinition, WorkflowStep, WorkflowValue } from '@/01-models/workflow';
import { toWorkflowStepId } from '@/01-models/ids';
import { newWorkflowStep } from './editor';
import { executeWorkflow, type WorkflowRuntimeServices } from './runtime';
import { createOutputStoreFixture } from './output-store.test-support';
import { retainValue, spoolText } from './values';

export function stepId({ raw }: { raw: string }) {
  return toWorkflowStepId({ raw });
}

export function literal({ value }: { value: string | number | boolean | null }): WorkflowValue {
  return { type: 'literal', value };
}

export function reference({ id, output }: { id: string, output: string }): WorkflowValue {
  return { type: 'step_output', stepId: stepId({ raw: id }), output };
}

export function valueStep({ id, value }: { id: string, value: WorkflowValue }): Extract<WorkflowStep, { type: 'value' }> {
  return { id: stepId({ raw: id }), name: id, type: 'value', value };
}

export function baseStep({ type, id }: { type: WorkflowStep['type'], id: string }): WorkflowStep {
  return { ...newWorkflowStep({ type, name: id, endpoint: { type: 'ollama', url: 'http://localhost:11434' }, modelId: 'test', lmParameters: undefined }), id: stepId({ raw: id }) };
}

export async function runtimeFixture({ definition, overrides }: { definition: WorkflowDefinition, overrides: Partial<WorkflowRuntimeServices> }) {
  const fixture = createOutputStoreFixture({ limits: { maxBytes: 8 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxEntries: 256, maxPendingWriteBytes: 128 * 1024, maxWriteChunkBytes: 32768 } });
  const controller = new AbortController();
  const generate = vi.fn<WorkflowRuntimeServices['generate']>(async ({ input }) => {
    async function* chunks() {
      yield 'generated';
    }
    const text = await spoolText({ store: input.store, signal: input.signal, chunks: chunks() });
    return {
      text,
      conversation: { type: 'conversation', messages: [...input.conversation.map(message => ({ ...message, parts: message.parts.map(value => retainValue({ value })) })), { role: 'assistant', parts: [retainValue({ value: text })] }] },
      reasoning: { type: 'json', value: '' },
      metrics: { type: 'json', value: {} },
    };
  });
  try {
    const result = await executeWorkflow({
      definition,
      store: fixture.store,
      signal: controller.signal,
      services: {
        generate,
        requestInput: async () => 'reply',
        readFile: async () => {
          throw new Error('No file adapter.');
        },
        writeFile: async () => {
          throw new Error('No file adapter.');
        },
        onStep: async () => undefined,
        ...overrides,
      },
    });
    return {
      result,
      store: fixture.store,
      generate,
      controller,
      async [Symbol.asyncDispose]() {
        await result.release();
        await fixture[Symbol.asyncDispose]();
      },
    };
  } catch (error) {
    await fixture[Symbol.asyncDispose]();
    throw error;
  }
}

export const TEST_ONLY = {
};
