import type { Endpoint, LmParameters, SystemPrompt } from './types';
import type { JsonValue } from './lm';
import type { ToolConfig } from './tool';
import type { WorkflowId, WorkflowStepId, VolumeId } from './ids';

/** The shared document contract. Runtime output handles and editor state do not belong here. */
export type WorkflowValue =
  | { type: 'literal', value: JsonValue }
  | { type: 'model', endpoint: Endpoint, modelId: string }
  | { type: 'step_output', stepId: WorkflowStepId, output: string }
  | { type: 'loop_item' | 'loop_index', stepId: WorkflowStepId }
  | { type: 'loop_state', stepId: WorkflowStepId, key: string }
  | { type: 'array' | 'concat' | 'path', items: WorkflowValue[] }
  | { type: 'object', properties: Record<string, WorkflowValue> }
  | { type: 'json_compose', base: JsonValue, assignments: { path: (string | number)[], value: WorkflowValue }[] }
  | { type: 'range', start: WorkflowValue, end: WorkflowValue | undefined, step: WorkflowValue }
  | { type: 'get', value: WorkflowValue, path: (string | number)[] }
  | { type: 'filename', value: WorkflowValue }
  | { type: 'format_number', value: WorkflowValue, minDigits: number }
  | { type: 'equals', left: WorkflowValue, right: WorkflowValue }
  | { type: 'not_empty', value: WorkflowValue }
  | { type: 'conversation', messages: WorkflowMessage[] };

export type WorkflowMessage = {
  role: 'system' | 'user' | 'assistant',
  parts: ({ type: 'text', text: string } | { type: 'value', value: WorkflowValue })[],
};

export type WorkflowBlock = { steps: WorkflowStep[] };
export type WorkflowBranch = WorkflowBlock & { outputs: Record<string, WorkflowValue> };
export type WorkflowLoopState = Record<string, { initial: WorkflowValue, next: WorkflowValue }>;

export type WorkflowModelConfiguration = { endpoint: Endpoint, modelId: string, lmParameters: LmParameters | undefined };

type WorkflowStepBase = { id: WorkflowStepId, name: string };
export type WorkflowStep = WorkflowStepBase & (
  | { type: 'value', value: WorkflowValue }
  | { type: 'model_selection', targets: WorkflowModelConfiguration[] }
  | { type: 'parse_json', source: WorkflowValue }
  | {
      type: 'text_generation',
      target: WorkflowValue,
      conversation: WorkflowValue,
      appendMessages: WorkflowMessage[],
      systemPrompt: SystemPrompt | undefined,
      lmParameters: LmParameters | undefined,
      toolConfigs: ToolConfig[],
    }
  | { type: 'request_input', prompt: WorkflowValue, responseType: 'text' | 'json' }
  | { type: 'repeat', count: WorkflowValue, state: WorkflowLoopState, body: WorkflowBlock, emit: WorkflowValue | undefined }
  | { type: 'for_each', source: WorkflowValue, state: WorkflowLoopState, body: WorkflowBlock, emit: WorkflowValue | undefined }
  | { type: 'if', condition: WorkflowValue, then: WorkflowBranch, else: WorkflowBranch }
  | { type: 'read_file', volumeId: VolumeId, relativePath: WorkflowValue }
  | { type: 'write_file', volumeId: VolumeId, relativePath: WorkflowValue, source: WorkflowValue, format: 'text' | 'json' | 'jsonl' | 'binary', onConflict: 'error' | 'overwrite' }
);

/** Editable content is shared by forms and JSON. Document identity and timestamps are not inputs. */
export type WorkflowDefinition = { name: string, steps: WorkflowStep[] };
export type WorkflowDocument = {
  id: WorkflowId,
  kind: 'workflow' | 'part',
  createdAt: number,
  updatedAt: number,
  definition: WorkflowDefinition,
};

export const TEST_ONLY = {
};
