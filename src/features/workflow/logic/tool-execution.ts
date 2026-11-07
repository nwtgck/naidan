import type { JsonValue } from '@/01-models/lm';
import type { ToolExecutionOutcome } from '@/01-models/tool';
import type { WorkflowOutputs, WorkflowToolInput } from './runtime';
import { resolveWorkflowToolRequest, type WorkflowToolRequest } from './tool-input';
import { freezeWorkflowData, spoolText, releaseValues } from './values';

export type WorkflowToolExecution = { outcome: ToolExecutionOutcome, metadata: Record<string, JsonValue> };
export type WorkflowToolExecutor = ({ request, signal }: { request: WorkflowToolRequest, signal: AbortSignal }) => Promise<WorkflowToolExecution>;
export type WorkflowToolAuthorization = ({ request, signal }: { request: WorkflowToolRequest, signal: AbortSignal }) => Promise<boolean>;

/** Approval belongs to this invocation, not a chat or a persisted definition.
 * Never abandon an executing tool: cancellation must settle before releasing it.
 * Storage/cleanup failures and denial are not converted by the continue policy. */
export async function executeWorkflowTool({ input, authorize, execute }: {
  input: WorkflowToolInput, authorize: WorkflowToolAuthorization, execute: WorkflowToolExecutor,
}): Promise<WorkflowOutputs> {
  const { signal, store, step } = input;
  const result = await invokeWorkflowTool({ request: input.request, signal, authorize, execute });
  const request = input.request;
  const { outcome } = result;
  const ok = outcome.status === 'success';
  let text: string;
  let code: string | undefined;
  switch (outcome.status) {
  case 'success': text = outcome.content;
    break;
  case 'error':
    code = outcome.code;
    switch (step.onError) {
    case 'fail': throw new Error(`${request.name}: ${outcome.code}: ${outcome.message}`);
    case 'continue': text = outcome.message;
      break;
    default: {
      const exhaustive: never = step.onError;
      throw new Error(String(exhaustive));
    }
    }
    break;
  default: {
    const exhaustive: never = outcome;
    throw new Error(String(exhaustive));
  }
  }
  async function* chunks() {
    yield text;
  }
  const outputs: WorkflowOutputs = {};
  try {
    outputs.text = await spoolText({ store, signal, chunks: chunks() });
    signal.throwIfAborted();
    outputs.ok = { type: 'json', value: ok };
    outputs.metadata = { type: 'json', value: { ...result.metadata, tool: request.name, status: outcome.status, ...(code === undefined ? {} : { code }) } };
    return outputs;
  } catch (error) {
    await releaseValues({ values: Object.values(outputs) });
    throw error;
  }
}

/** A model tool and an explicit Step share the same invocation boundary. */
export async function invokeWorkflowTool({ request: requestInput, signal, authorize, execute }: {
  request: WorkflowToolRequest, signal: AbortSignal, authorize: WorkflowToolAuthorization, execute: WorkflowToolExecutor,
}): Promise<WorkflowToolExecution> {
  signal.throwIfAborted();
  const request = resolveWorkflowToolRequest({ tool: requestInput, args: requestInput.args });
  freezeWorkflowData({ value: request });
  switch (request.name) {
  case 'calculator': break;
  case 'wikipedia_search': case 'wikipedia_get_page': case 'shell_execute': {
    const allowed = await authorize({ request, signal });
    signal.throwIfAborted();
    if (!allowed) {
      throw new Error('Workflow tool permission was denied.');
    }
    break;
  }
  default: {
    const exhaustive: never = request;
    throw new Error(String(exhaustive));
  }
  }
  signal.throwIfAborted();
  const result = await execute({ request, signal });
  signal.throwIfAborted();
  return result;
}

export const TEST_ONLY = {
};
