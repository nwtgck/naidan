import type { Endpoint, LmParameters, SystemPrompt } from './types';
import type { JsonValue } from './lm';
import type { ToolConfig, ToolExecutionErrorCode } from './tool';
import type { WorkflowId, WorkflowStepId, WorkflowRunId, VolumeId, ToolCallId } from './ids';

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
  | { type: 'arithmetic', operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'remainder', left: WorkflowValue, right: WorkflowValue }
  | { type: 'compare', operator: 'less' | 'less_or_equal' | 'greater' | 'greater_or_equal', left: WorkflowValue, right: WorkflowValue }
  | { type: 'all' | 'any', items: WorkflowValue[] }
  | { type: 'not', value: WorkflowValue }
  | { type: 'not_empty', value: WorkflowValue }
  | { type: 'conversation', messages: WorkflowMessage[] };

/** Historical tool records describe a conversation, never execution authority. */
export type WorkflowMessagePart =
  | { type: 'text', text: string }
  | { type: 'reasoning', text: string }
  | { type: 'value', value: WorkflowValue }
  | { type: 'tool_call', id: ToolCallId, name: string, arguments: string }
  | { type: 'tool_result', id: ToolCallId, status: 'success' | 'error', code: ToolExecutionErrorCode | undefined, content: WorkflowValue };

export type WorkflowMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool',
  parts: WorkflowMessagePart[],
};

/** Limits bound autonomous calls inside one text Step. Shell access never
 * inherits chat/global mounts or the chat's sysfs visibility. */
export type WorkflowToolExecutionPolicy = {
  maxRounds: number,
  maxCalls: number,
  shell: { volumeId: VolumeId, access: 'read-only' | 'read-write' } | undefined,
};

export type WorkflowImageInputs = {
  initImage: WorkflowValue | undefined,
  referenceImages: WorkflowValue[],
  strength: WorkflowValue,
};
export type WorkflowImagePreview = {
  enabled: boolean, interval: number, startStep: number,
  mode: 'projection' | 'vae', maxEdge: number,
};

export type WorkflowBlock = { steps: WorkflowStep[] };
export type WorkflowBranch = WorkflowBlock & { outputs: Record<string, WorkflowValue> };
export type WorkflowLoopState = Record<string, { initial: WorkflowValue, next: WorkflowValue }>;

export type WorkflowModelConfiguration = { endpoint: Endpoint, modelId: string, lmParameters: LmParameters | undefined };

/** Expressions are resolved before the local audio engine is prepared. */
export type WorkflowAudioParameters = {
  language: WorkflowValue,
  audioBackend: WorkflowValue,
  contextTokens: WorkflowValue,
  maxFrames: WorkflowValue,
  temperature: WorkflowValue,
  topK: WorkflowValue,
  topP: WorkflowValue,
  seed: WorkflowValue,
};

/** A single local image invocation; compose batches with the existing loop steps. */
export type WorkflowImageParameters = {
  negativePrompt: WorkflowValue,
  width: WorkflowValue,
  height: WorkflowValue,
  steps: WorkflowValue,
  guidance: WorkflowValue,
  seed: WorkflowValue,
  sampler: WorkflowValue,
  scheduler: WorkflowValue,
  distilledGuidance: WorkflowValue,
  vaeTiling: WorkflowValue,
  vaeTileSize: WorkflowValue,
  flashAttention: WorkflowValue,
  bf16WeightType: WorkflowValue,
  qwenVaePolicy: WorkflowValue,
  conditioningCacheSize: WorkflowValue,
  modelArguments: WorkflowValue,
  profile: WorkflowValue,
  weightResidency: WorkflowValue,
};

export type WorkflowToolSelection =
  | { name: 'calculator' | 'wikipedia_search' | 'wikipedia_get_page' }
  | { name: 'shell_execute', volumeId: VolumeId, access: 'read-only' | 'read-write' };

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
      toolExecution?: WorkflowToolExecutionPolicy | undefined,
    }
  | {
      type: 'audio_generation',
      modelId: WorkflowValue,
      text: WorkflowValue,
      reference: WorkflowValue | undefined,
      parameters: WorkflowAudioParameters,
      onLimit: 'error' | 'keep',
    }
  | {
      type: 'image_generation',
      model: WorkflowValue,
      prompt: WorkflowValue,
      parameters: WorkflowImageParameters,
      gpuBudgetMiB: WorkflowValue | undefined,
      imageInputs?: WorkflowImageInputs | undefined,
      preview?: WorkflowImagePreview | undefined,
    }
  | { type: 'tool_call', tool: WorkflowToolSelection, arguments: WorkflowValue, onError: 'fail' | 'continue' }
  | { type: 'request_input', prompt: WorkflowValue, responseType: 'text' | 'json', choices?: WorkflowValue | undefined }
  | { type: 'repeat', count: WorkflowValue, state: WorkflowLoopState, body: WorkflowBlock, emit: WorkflowValue | undefined, stopWhen?: WorkflowValue | undefined }
  | { type: 'for_each', source: WorkflowValue, state: WorkflowLoopState, body: WorkflowBlock, emit: WorkflowValue | undefined, stopWhen?: WorkflowValue | undefined }
  | { type: 'if', condition: WorkflowValue, then: WorkflowBranch, else: WorkflowBranch }
  | { type: 'read_file', volumeId: VolumeId, relativePath: WorkflowValue }
  | { type: 'write_file', volumeId: VolumeId, relativePath: WorkflowValue, source: WorkflowValue, format: 'text' | 'json' | 'jsonl' | 'binary', onConflict: 'error' | 'overwrite' }
);

/** Editable content is shared by forms and JSON. Document identity and timestamps are not inputs. */
export type WorkflowDefinition = { name: string, steps: WorkflowStep[], executionLimits?: WorkflowExecutionLimits | undefined };

/** Execution-wide budgets are independent of a sequence's finite or open end. */
export type WorkflowExecutionLimits = {
  maxLoopIterations: number,
  maxStepExecutions: number,
  maxValueEvaluations: number,
  timeoutMs: number | undefined,
};
export type WorkflowDocument = {
  id: WorkflowId,
  kind: 'workflow' | 'part',
  createdAt: number,
  updatedAt: number,
  definition: WorkflowDefinition,
};

/** A run owns a definition snapshot, not a link to the editor's mutable draft.
 * Results are temporary files; losing them never removes this record or its snapshot.
 */
export type WorkflowRunEntry = {
  number: number, name: string, stepId: WorkflowStepId, trace: number[],
  phase: 'running' | 'completed', preview: string, inputPreview: string,
};
export type WorkflowRunRecord = {
  id: WorkflowRunId,
  workflowId: WorkflowId | undefined,
  definition: WorkflowDefinition,
  startedAt: number,
  finishedAt: number | undefined,
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted',
  /** Only records created under a lifetime Web Lock can be checked for abandonment. */
  ownership: 'web_lock' | undefined,
  checkpointAt: number | undefined,
  entries: WorkflowRunEntry[],
  error: string | undefined,
  resultsPath: string[] | undefined,
  resultError: string | undefined,
};

export const TEST_ONLY = {
};
