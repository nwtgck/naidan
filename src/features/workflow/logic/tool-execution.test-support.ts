import { vi } from 'vitest';
import { createOutputStoreFixture } from './output-store.test-support';
import { executeWorkflowTool, type WorkflowToolExecutor, type WorkflowToolAuthorization } from './tool-execution';
import { toolStep, toolRequest } from './tool.test-support';
import type { WorkflowToolInput } from './runtime';
import type { WorkflowToolRequest } from './tool-input';
import { releaseValues, type RuntimeValue } from './values';

export function toolExecutionFixture({ name, onError }: { name: WorkflowToolRequest['name'], onError: 'fail' | 'continue' }) {
  const output = createOutputStoreFixture({ limits: { maxBytes: 4 * 1024 * 1024, maxOutputBytes: 2 * 1024 * 1024, maxWriteChunkBytes: 32768, maxPendingWriteBytes: 65536 } });
  const controller = new AbortController();
  const request = toolRequest({ name });
  const step = toolStep({ id: 'call', request, onError });
  const input: WorkflowToolInput = { step, request, store: output.store, signal: controller.signal };
  const authorize = vi.fn<WorkflowToolAuthorization>(async () => true);
  const execute = vi.fn<WorkflowToolExecutor>(async () => ({ outcome: { status: 'success', content: 'result' }, metadata: {} }));
  const owned: RuntimeValue[] = [];
  return {
    ...output,
    input,
    controller,
    authorize,
    execute,
    async run() {
      const outputs = await executeWorkflowTool({ input, authorize, execute });
      owned.push(...Object.values(outputs));
      return outputs;
    },
    async [Symbol.asyncDispose]() {
      controller.abort();
      await releaseValues({ values: owned });
      await output[Symbol.asyncDispose]();
    },
  };
}

export const TEST_ONLY = {
};
