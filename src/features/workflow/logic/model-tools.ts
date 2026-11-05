import { z } from 'zod';
import type { LmProvider, JsonValue } from '@/01-models/lm';
import type { ToolConfig, ToolExecutionOutcome } from '@/01-models/tool';
import type { WorkflowToolExecutionPolicy, WorkflowToolSelection } from '@/01-models/workflow';
import type { ToolCall } from '@/01-models/types';
import { resolveWorkflowToolPolicy } from './tool-policy';
import { parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { zodToJsonSchema } from '@/utils/lm-tools';
import { ChoicesArgsSchema, renderChoicesResult } from '@/features/tools/choices';
import { resolveWorkflowToolRequest, workflowToolArgumentsSchema } from './tool-input';
import { invokeWorkflowTool, type WorkflowToolAuthorization, type WorkflowToolExecutor } from './tool-execution';

export type WorkflowModelTools = {
  definitions: NonNullable<Parameters<LmProvider['chat']>[0]['tools']>,
  execute: ({ call, signal }: { call: ToolCall, signal: AbortSignal }) => Promise<ToolExecutionOutcome>,
};
export type WorkflowChoiceRequest = ({ prompt, choices, signal }: { prompt: string, choices: string[], signal: AbortSignal }) => Promise<number>;

/** Describe only enabled capabilities. Neither raw tool arguments nor historical
 * calls can select a folder, widen access, or inherit a chat approval. */
export function createWorkflowModelTools({ configs, policy, authorize, execute, requestChoice }: {
  configs: ToolConfig[], policy: WorkflowToolExecutionPolicy | undefined,
  authorize: WorkflowToolAuthorization, execute: WorkflowToolExecutor, requestChoice: WorkflowChoiceRequest,
}): WorkflowModelTools {
  const settings = resolveWorkflowToolPolicy({ policy });
  const allowed = new Map<string, WorkflowToolSelection | 'choices'>();
  const seen = new Set<string>();
  for (const config of configs) {
    if (seen.has(config.key)) {
      throw new Error('Duplicate Workflow tool configuration.');
    }
    seen.add(config.key);
    switch (config.status) {
    case 'disabled': continue;
    case 'enabled': break;
    default: {
      const exhaustive: never = config.status;
      throw new Error(String(exhaustive));
    }
    }
    switch (config.key) {
    case 'builtin.calculator': allowed.set('calculator', { name: 'calculator' });
      break;
    case 'builtin.choices': allowed.set('choices', 'choices');
      break;
    case 'builtin.wikipedia':
      allowed.set('wikipedia_search', { name: 'wikipedia_search' });
      allowed.set('wikipedia_get_page', { name: 'wikipedia_get_page' });
      break;
    case 'builtin.wesh':
      if (config.naidanSysfs.accessScope !== 'none' || !settings.shell) {
        throw new Error('Workflow shell tools require an explicit folder and no chat/sysfs access.');
      }
      allowed.set('shell_execute', { name: 'shell_execute', ...settings.shell });
      break;
    default: {
      const exhaustive: never = config;
      throw new Error(String(exhaustive));
    }
    }
  }
  const descriptions: Record<WorkflowToolSelection['name'] | 'choices', string> = {
    calculator: 'Evaluate a mathematical expression. Use the returned result rather than estimating.',
    choices: 'Present a prompt and 2–10 distinct choices, then wait for exactly one selection.',
    wikipedia_search: 'Search Wikipedia in the specified language. Returns article IDs and titles. Each external request requires approval.',
    wikipedia_get_page: 'Read a Wikipedia article by language and article ID. Each external request requires approval.',
    shell_execute: 'Execute a shell script in /workspace, the single folder selected for this Workflow. No chat data or global mounts are available. Each script requires approval. Output and execution time are bounded.',
  };
  const definitions = [...allowed].map(([name, selection]) => ({
    name,
    description: descriptions[selection === 'choices' ? 'choices' : selection.name],
    parameters: z.record(z.string(), z.json()).parse(zodToJsonSchema({ schema: selection === 'choices' ? ChoicesArgsSchema : workflowToolArgumentsSchema({ name: selection.name }) })),
  }));
  return {
    definitions,
    async execute({ call, signal }) {
      signal.throwIfAborted();
      const selection = allowed.get(call.function.name);
      if (selection === undefined) {
        throw new Error('The model requested a tool without execution authority.');
      }
      let args: JsonValue;
      try {
        if (new TextEncoder().encode(call.function.arguments).byteLength > 128 * 1024) {
          throw new Error('Tool arguments exceed 128 KiB.');
        }
        args = parseWorkflowJson({ text: call.function.arguments });
      } catch (error) {
        return { status: 'error', code: 'invalid_arguments', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) };
      }
      if (selection === 'choices') {
        const parsed = ChoicesArgsSchema.safeParse(args);
        if (!parsed.success) {
          return { status: 'error', code: 'invalid_arguments', message: parsed.error.message.slice(0, 4096) };
        }
        const index = await requestChoice({ ...parsed.data, signal });
        signal.throwIfAborted();
        const choice = parsed.data.choices[index];
        if (!Number.isSafeInteger(index) || choice === undefined) {
          throw new Error('Choice index is out of range.');
        }
        return { status: 'success', content: renderChoicesResult({ index, choice }) };
      }
      let request: ReturnType<typeof resolveWorkflowToolRequest>;
      try {
        request = resolveWorkflowToolRequest({ tool: selection, args });
      } catch (error) {
        return { status: 'error', code: 'invalid_arguments', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) };
      }
      // Approval denial, cancellation, storage/cleanup failures escape. They are
      // not recoverable model errors and must not start another provider round.
      return (await invokeWorkflowTool({ request, signal, authorize, execute })).outcome;
    },
  };
}

export const TEST_ONLY = {
};
