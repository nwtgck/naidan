import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
import { EndpointSchemaDto, LmParametersSchemaDto, SystemPromptSchemaDto } from './dto';
import { ExperimentalToolConfigsSchemaDto } from './experimental.dto';

// An explicit recursive shape bounds TypeScript's expansion of the expression
// union. The assignment below still checks every branch against this contract;
// all runtime validation is built from dtozod's structural constructors.
type WorkflowValueShapeDto<E> =
  | { type: 'literal', value: unknown }
  | { type: 'model', endpoint: E, modelId: string }
  | { type: 'step_output', stepId: string, output: string }
  | { type: 'loop_item' | 'loop_index', stepId: string }
  | { type: 'loop_state', stepId: string, key: string }
  | { type: 'array' | 'concat' | 'path', items: WorkflowValueShapeDto<E>[] }
  | { type: 'object', properties: Record<string, WorkflowValueShapeDto<E>> }
  | { type: 'json_compose', base: unknown, assignments: { path: (string | number)[], value: WorkflowValueShapeDto<E> }[] }
  | { type: 'range', start: WorkflowValueShapeDto<E>, end?: WorkflowValueShapeDto<E> | undefined, step: WorkflowValueShapeDto<E> }
  | { type: 'get', value: WorkflowValueShapeDto<E>, path: (string | number)[] }
  | { type: 'filename' | 'not_empty', value: WorkflowValueShapeDto<E> }
  | { type: 'format_number', value: WorkflowValueShapeDto<E>, minDigits: number }
  | { type: 'equals', left: WorkflowValueShapeDto<E>, right: WorkflowValueShapeDto<E> }
  | { type: 'arithmetic', operator: 'add' | 'subtract' | 'multiply' | 'divide' | 'remainder', left: WorkflowValueShapeDto<E>, right: WorkflowValueShapeDto<E> }
  | { type: 'compare', operator: 'less' | 'less_or_equal' | 'greater' | 'greater_or_equal', left: WorkflowValueShapeDto<E>, right: WorkflowValueShapeDto<E> }
  | { type: 'all' | 'any', items: WorkflowValueShapeDto<E>[] }
  | { type: 'not', value: WorkflowValueShapeDto<E> }
  | { type: 'conversation', messages: WorkflowMessageShapeDto<E>[] };
type WorkflowMessageShapeDto<E> = {
  role: 'system' | 'user' | 'assistant' | 'tool',
  parts: (
    | { type: 'text', text: string }
    | { type: 'reasoning', text: string }
    | { type: 'value', value: WorkflowValueShapeDto<E> }
    | { type: 'tool_call', id: string, name: string, arguments: string }
    | { type: 'tool_result', id: string, status: 'success' | 'error', code?: 'invalid_arguments' | 'execution_failed' | 'timeout' | 'other' | undefined, content: WorkflowValueShapeDto<E> }
  )[],
};
export interface ExperimentalWorkflowValueSchemaTypeDto extends dtozod.DtoSchema {
  readonly _zod: {
    readonly optin?: 'optional',
    readonly optout?: 'optional',
    readonly input: WorkflowValueShapeDto<dtozod.input<typeof EndpointSchemaDto>>,
    readonly output: WorkflowValueShapeDto<dtozod.output<typeof EndpointSchemaDto>>,
  };
}

export const ExperimentalWorkflowMessageSchemaDto = dtozod.object({
  role: dtozod.enum(['system', 'user', 'assistant', 'tool']),
  parts: dtozod.array(dtozod.discriminatedUnion('type', [
    dtozod.object({ type: dtozod.literal('tool_call'), id: dtozod.string(), name: dtozod.string(), arguments: dtozod.string() }),
    resolveMissingAsUndefined(dtozod.object({
      type: dtozod.literal('tool_result'),
      id: dtozod.string(),
      status: dtozod.enum(['success', 'error']),
      code: missingAsUndefined(dtozod.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other'])),
      get content(): ExperimentalWorkflowValueSchemaTypeDto {
        return ExperimentalWorkflowValueSchemaDto;
      },
    })),
    dtozod.object({ type: dtozod.literal('text'), text: dtozod.string() }),
    dtozod.object({ type: dtozod.literal('reasoning'), text: dtozod.string() }),
    dtozod.object({
      type: dtozod.literal('value'),
      get value(): ExperimentalWorkflowValueSchemaTypeDto {
        return ExperimentalWorkflowValueSchemaDto;
      },
    }),
  ])),
});
export type ExperimentalWorkflowMessageDto = dtozod.infer<typeof ExperimentalWorkflowMessageSchemaDto>;

export const ExperimentalWorkflowValueSchemaDto: ExperimentalWorkflowValueSchemaTypeDto = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('literal'), value: dtozod.unknown() }),
  dtozod.object({ type: dtozod.literal('model'), endpoint: EndpointSchemaDto, modelId: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('step_output'), stepId: dtozod.string(), output: dtozod.string() }),
  dtozod.object({ type: dtozod.enum(['loop_item', 'loop_index']), stepId: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('loop_state'), stepId: dtozod.string(), key: dtozod.string() }),
  dtozod.object({
    type: dtozod.enum(['array', 'concat', 'path', 'all', 'any']),
    get items(): dtozod.DtoArray<ExperimentalWorkflowValueSchemaTypeDto> {
      return dtozod.array(ExperimentalWorkflowValueSchemaDto);
    },
  }),
  dtozod.object({
    type: dtozod.literal('object'),
    get properties(): dtozod.DtoRecord<ReturnType<typeof dtozod.string>, ExperimentalWorkflowValueSchemaTypeDto> {
      return dtozod.record(dtozod.string(), ExperimentalWorkflowValueSchemaDto);
    },
  }),
  dtozod.object({
    type: dtozod.literal('get'),
    get value(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
    path: dtozod.array(dtozod.union([dtozod.string(), dtozod.number()])),
  }),
  dtozod.object({
    type: dtozod.enum(['filename', 'not_empty', 'not']),
    get value(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
  }),
  dtozod.object({
    type: dtozod.literal('format_number'),
    get value(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
    minDigits: dtozod.number(),
  }),
  dtozod.object({
    type: dtozod.literal('equals'),
    get left(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
    get right(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
  }),
  dtozod.object({
    type: dtozod.literal('arithmetic'),
    operator: dtozod.enum(['add', 'subtract', 'multiply', 'divide', 'remainder']),
    get left(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
    get right(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
  }),
  dtozod.object({
    type: dtozod.literal('compare'),
    operator: dtozod.enum(['less', 'less_or_equal', 'greater', 'greater_or_equal']),
    get left(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
    get right(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
  }),
  dtozod.object({
    type: dtozod.literal('json_compose'),
    base: dtozod.unknown(),
    assignments: dtozod.array(dtozod.object({
      path: dtozod.array(dtozod.union([dtozod.string(), dtozod.number()])),
      get value(): ExperimentalWorkflowValueSchemaTypeDto {
        return ExperimentalWorkflowValueSchemaDto;
      },
    })),
  }),
  resolveMissingAsUndefined(dtozod.object({
    type: dtozod.literal('range'),
    get start(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
    get end() {
      return missingAsUndefined(ExperimentalWorkflowValueSchemaDto);
    },
    get step(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueSchemaDto;
    },
  })),
  dtozod.object({ type: dtozod.literal('conversation'), messages: dtozod.array(ExperimentalWorkflowMessageSchemaDto) }),
]);
export type ExperimentalWorkflowValueDto = dtozod.infer<typeof ExperimentalWorkflowValueSchemaDto>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Required for recursive schema inference.
export interface ExperimentalWorkflowBlockSchemaTypeDto extends dtozod.DtoObject<{ steps: dtozod.DtoArray<typeof ExperimentalWorkflowStepSchemaDto> }> {}
const WorkflowBlockSchemaDto: ExperimentalWorkflowBlockSchemaTypeDto = dtozod.object({
  get steps(): dtozod.DtoArray<typeof ExperimentalWorkflowStepSchemaDto> {
    return dtozod.array(ExperimentalWorkflowStepSchemaDto);
  },
});
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Required for recursive schema inference.
export interface WorkflowBranchSchemaTypeDto extends dtozod.DtoObject<{
  steps: dtozod.DtoArray<typeof ExperimentalWorkflowStepSchemaDto>;
  outputs: dtozod.DtoRecord<ReturnType<typeof dtozod.string>, typeof ExperimentalWorkflowValueSchemaDto>;
}> {}
const WorkflowBranchSchemaDto: WorkflowBranchSchemaTypeDto = dtozod.object({
  get steps(): dtozod.DtoArray<typeof ExperimentalWorkflowStepSchemaDto> {
    return dtozod.array(ExperimentalWorkflowStepSchemaDto);
  },
  outputs: dtozod.record(dtozod.string(), ExperimentalWorkflowValueSchemaDto),
});
const WorkflowLoopStateSchemaDto = dtozod.record(dtozod.string(), dtozod.object({ initial: ExperimentalWorkflowValueSchemaDto, next: ExperimentalWorkflowValueSchemaDto }));
const WorkflowStepBaseSchemaDto = dtozod.object({ id: dtozod.string(), name: dtozod.string() });

export const ExperimentalWorkflowModelConfigurationSchemaDto = resolveMissingAsUndefined(dtozod.object({
  endpoint: EndpointSchemaDto,
  modelId: dtozod.string(),
  lmParameters: missingAsUndefined(LmParametersSchemaDto),
}));
export type ExperimentalWorkflowModelConfigurationDto = dtozod.infer<typeof ExperimentalWorkflowModelConfigurationSchemaDto>;


export const ExperimentalWorkflowStepSchemaDto = resolveMissingAsUndefined(dtozod.discriminatedUnion('type', [
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('value'), value: ExperimentalWorkflowValueSchemaDto }),
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('model_selection'), targets: dtozod.array(ExperimentalWorkflowModelConfigurationSchemaDto) }),
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('parse_json'), source: ExperimentalWorkflowValueSchemaDto }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('text_generation'),
    target: ExperimentalWorkflowValueSchemaDto,
    conversation: ExperimentalWorkflowValueSchemaDto,
    appendMessages: dtozod.array(ExperimentalWorkflowMessageSchemaDto),
    systemPrompt: missingAsUndefined(SystemPromptSchemaDto),
    lmParameters: missingAsUndefined(LmParametersSchemaDto),
    toolConfigs: ExperimentalToolConfigsSchemaDto,
    toolExecution: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
      maxRounds: dtozod.number(),
      maxCalls: dtozod.number(),
      shell: missingAsUndefined(dtozod.object({ volumeId: dtozod.string(), access: dtozod.enum(['read-only', 'read-write']) })),
    }))),
  }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('audio_generation'),
    modelId: ExperimentalWorkflowValueSchemaDto,
    text: ExperimentalWorkflowValueSchemaDto,
    reference: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
    parameters: dtozod.object({
      language: ExperimentalWorkflowValueSchemaDto,
      audioBackend: ExperimentalWorkflowValueSchemaDto,
      contextTokens: ExperimentalWorkflowValueSchemaDto,
      maxFrames: ExperimentalWorkflowValueSchemaDto,
      temperature: ExperimentalWorkflowValueSchemaDto,
      topK: ExperimentalWorkflowValueSchemaDto,
      topP: ExperimentalWorkflowValueSchemaDto,
      seed: ExperimentalWorkflowValueSchemaDto,
    }),
    onLimit: dtozod.enum(['error', 'keep']),
  }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('image_generation'),
    model: ExperimentalWorkflowValueSchemaDto,
    prompt: ExperimentalWorkflowValueSchemaDto,
    parameters: dtozod.object({
      negativePrompt: ExperimentalWorkflowValueSchemaDto,
      width: ExperimentalWorkflowValueSchemaDto,
      height: ExperimentalWorkflowValueSchemaDto,
      steps: ExperimentalWorkflowValueSchemaDto,
      guidance: ExperimentalWorkflowValueSchemaDto,
      seed: ExperimentalWorkflowValueSchemaDto,
      sampler: ExperimentalWorkflowValueSchemaDto,
      scheduler: ExperimentalWorkflowValueSchemaDto,
      distilledGuidance: ExperimentalWorkflowValueSchemaDto,
      vaeTiling: ExperimentalWorkflowValueSchemaDto,
      vaeTileSize: ExperimentalWorkflowValueSchemaDto,
      flashAttention: ExperimentalWorkflowValueSchemaDto,
      bf16WeightType: ExperimentalWorkflowValueSchemaDto,
      qwenVaePolicy: ExperimentalWorkflowValueSchemaDto,
      conditioningCacheSize: ExperimentalWorkflowValueSchemaDto,
      modelArguments: ExperimentalWorkflowValueSchemaDto,
      profile: ExperimentalWorkflowValueSchemaDto,
      weightResidency: ExperimentalWorkflowValueSchemaDto,
    }),
    gpuBudgetMiB: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
    imageInputs: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
      initImage: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
      referenceImages: dtozod.array(ExperimentalWorkflowValueSchemaDto),
      strength: ExperimentalWorkflowValueSchemaDto,
    }))),
    preview: missingAsUndefined(dtozod.object({
      enabled: dtozod.boolean(),
      interval: dtozod.number(),
      startStep: dtozod.number(),
      mode: dtozod.enum(['projection', 'vae']),
      maxEdge: dtozod.number(),
    })),
  }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('tool_call'),
    tool: dtozod.discriminatedUnion('name', [
      dtozod.object({ name: dtozod.literal('calculator') }),
      dtozod.object({ name: dtozod.literal('wikipedia_search') }),
      dtozod.object({ name: dtozod.literal('wikipedia_get_page') }),
      dtozod.object({ name: dtozod.literal('shell_execute'), volumeId: dtozod.string(), access: dtozod.enum(['read-only', 'read-write']) }),
    ]),
    arguments: ExperimentalWorkflowValueSchemaDto,
    onError: dtozod.enum(['fail', 'continue']),
  }),
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('request_input'), prompt: ExperimentalWorkflowValueSchemaDto, responseType: dtozod.enum(['text', 'json']), choices: missingAsUndefined(ExperimentalWorkflowValueSchemaDto) }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('repeat'),
    count: ExperimentalWorkflowValueSchemaDto,
    state: WorkflowLoopStateSchemaDto,
    body: WorkflowBlockSchemaDto,
    emit: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
    stopWhen: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
  }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('for_each'),
    source: ExperimentalWorkflowValueSchemaDto,
    state: WorkflowLoopStateSchemaDto,
    body: WorkflowBlockSchemaDto,
    emit: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
    stopWhen: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
  }),
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('if'), condition: ExperimentalWorkflowValueSchemaDto, then: WorkflowBranchSchemaDto, else: WorkflowBranchSchemaDto }),
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('read_file'), volumeId: dtozod.string(), relativePath: ExperimentalWorkflowValueSchemaDto }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('write_file'),
    volumeId: dtozod.string(),
    relativePath: ExperimentalWorkflowValueSchemaDto,
    source: ExperimentalWorkflowValueSchemaDto,
    format: dtozod.enum(['text', 'json', 'jsonl', 'binary']),
    onConflict: dtozod.enum(['error', 'overwrite']),
  }),
]));
export type ExperimentalWorkflowStepDto = dtozod.infer<typeof ExperimentalWorkflowStepSchemaDto>;

const WorkflowExecutionLimitsSchemaDto = resolveMissingAsUndefined(dtozod.object({
  maxLoopIterations: dtozod.number(),
  maxStepExecutions: dtozod.number(),
  maxValueEvaluations: dtozod.number(),
  timeoutMs: missingAsUndefined(dtozod.number()),
}));

/**
 * Editable workflow content, not a projection made by removing storage fields.
 * Adding record metadata must not silently expose it in the form or JSON editor.
 * Step IDs remain part of this definition because output references use them.
 */
export const ExperimentalWorkflowDefinitionSchemaDto = resolveMissingAsUndefined(dtozod.object({
  name: dtozod.string(),
  steps: dtozod.array(ExperimentalWorkflowStepSchemaDto),
  executionLimits: missingAsUndefined(WorkflowExecutionLimitsSchemaDto),
}));
export type ExperimentalWorkflowDefinitionDto = dtozod.infer<typeof ExperimentalWorkflowDefinitionSchemaDto>;

export const ExperimentalWorkflowSchemaDto = dtozod.object({
  id: dtozod.string(),
  kind: dtozod.enum(['workflow', 'part']),
  createdAt: dtozod.number(),
  updatedAt: dtozod.number(),
  definition: ExperimentalWorkflowDefinitionSchemaDto,
});
export type ExperimentalWorkflowDto = dtozod.infer<typeof ExperimentalWorkflowSchemaDto>;

/** Run snapshots retain their own definition even if the source document is edited
 * or removed. Result paths locate runtime-owned temporary files, not durable data.
 */
export const ExperimentalWorkflowRunSchemaDto = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  workflowId: missingAsUndefined(dtozod.string()),
  definition: ExperimentalWorkflowDefinitionSchemaDto,
  startedAt: dtozod.number(),
  finishedAt: missingAsUndefined(dtozod.number()),
  status: dtozod.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  ownership: missingAsUndefined(dtozod.literal('web_lock')),
  checkpointAt: missingAsUndefined(dtozod.number()),
  entries: dtozod.array(dtozod.object({
    number: dtozod.number(),
    name: dtozod.string(),
    stepId: dtozod.string(),
    trace: dtozod.array(dtozod.number()),
    phase: dtozod.enum(['running', 'completed']),
    preview: dtozod.string(),
    inputPreview: dtozod.string(),
  })),
  error: missingAsUndefined(dtozod.string()),
  resultsPath: missingAsUndefined(dtozod.array(dtozod.string())),
  resultError: missingAsUndefined(dtozod.string()),
}));
export type ExperimentalWorkflowRunDto = dtozod.infer<typeof ExperimentalWorkflowRunSchemaDto>;

export const TEST_ONLY = {
};
