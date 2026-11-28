import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';
import { EndpointDtoSchema, LmParametersDtoSchema, SystemPromptDtoSchema } from './dto';
import { ExperimentalToolConfigsDtoSchema } from './experimental.dto';

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
    readonly optin?: dtozod.DtoSchema['_zod']['optin'],
    readonly optout?: dtozod.DtoSchema['_zod']['optout'],
    readonly input: WorkflowValueShapeDto<dtozod.input<typeof EndpointDtoSchema>>,
    readonly output: WorkflowValueShapeDto<dtozod.output<typeof EndpointDtoSchema>>,
  };
}

export const ExperimentalWorkflowMessageDtoSchema = dtozod.object({
  role: dtozod.enum(['system', 'user', 'assistant', 'tool']),
  parts: dtozod.array(dtozod.discriminatedUnion('type', [
    dtozod.object({ type: dtozod.literal('tool_call'), id: dtozod.string(), name: dtozod.string(), arguments: dtozod.string() }),
    resolveMissingAsUndefined(dtozod.object({
      type: dtozod.literal('tool_result'),
      id: dtozod.string(),
      status: dtozod.enum(['success', 'error']),
      code: missingAsUndefined(dtozod.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other'])),
      get content(): ExperimentalWorkflowValueSchemaTypeDto {
        return ExperimentalWorkflowValueDtoSchema;
      },
    })),
    dtozod.object({ type: dtozod.literal('text'), text: dtozod.string() }),
    dtozod.object({ type: dtozod.literal('reasoning'), text: dtozod.string() }),
    dtozod.object({
      type: dtozod.literal('value'),
      get value(): ExperimentalWorkflowValueSchemaTypeDto {
        return ExperimentalWorkflowValueDtoSchema;
      },
    }),
  ])),
});
export type ExperimentalWorkflowMessageDto = dtozod.infer<typeof ExperimentalWorkflowMessageDtoSchema>;

export const ExperimentalWorkflowValueDtoSchema: ExperimentalWorkflowValueSchemaTypeDto = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('literal'), value: dtozod.unknown() }),
  dtozod.object({ type: dtozod.literal('model'), endpoint: EndpointDtoSchema, modelId: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('step_output'), stepId: dtozod.string(), output: dtozod.string() }),
  dtozod.object({ type: dtozod.enum(['loop_item', 'loop_index']), stepId: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('loop_state'), stepId: dtozod.string(), key: dtozod.string() }),
  dtozod.object({
    type: dtozod.enum(['array', 'concat', 'path', 'all', 'any']),
    get items(): dtozod.DtoArray<ExperimentalWorkflowValueSchemaTypeDto> {
      return dtozod.array(ExperimentalWorkflowValueDtoSchema);
    },
  }),
  dtozod.object({
    type: dtozod.literal('object'),
    get properties(): dtozod.DtoRecord<ReturnType<typeof dtozod.string>, ExperimentalWorkflowValueSchemaTypeDto> {
      return dtozod.record(dtozod.string(), ExperimentalWorkflowValueDtoSchema);
    },
  }),
  dtozod.object({
    type: dtozod.literal('get'),
    get value(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
    path: dtozod.array(dtozod.union([dtozod.string(), dtozod.number()])),
  }),
  dtozod.object({
    type: dtozod.enum(['filename', 'not_empty', 'not']),
    get value(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
  }),
  dtozod.object({
    type: dtozod.literal('format_number'),
    get value(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
    minDigits: dtozod.number(),
  }),
  dtozod.object({
    type: dtozod.literal('equals'),
    get left(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
    get right(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
  }),
  dtozod.object({
    type: dtozod.literal('arithmetic'),
    operator: dtozod.enum(['add', 'subtract', 'multiply', 'divide', 'remainder']),
    get left(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
    get right(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
  }),
  dtozod.object({
    type: dtozod.literal('compare'),
    operator: dtozod.enum(['less', 'less_or_equal', 'greater', 'greater_or_equal']),
    get left(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
    get right(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
  }),
  dtozod.object({
    type: dtozod.literal('json_compose'),
    base: dtozod.unknown(),
    assignments: dtozod.array(dtozod.object({
      path: dtozod.array(dtozod.union([dtozod.string(), dtozod.number()])),
      get value(): ExperimentalWorkflowValueSchemaTypeDto {
        return ExperimentalWorkflowValueDtoSchema;
      },
    })),
  }),
  resolveMissingAsUndefined(dtozod.object({
    type: dtozod.literal('range'),
    get start(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
    get end() {
      return missingAsUndefined(ExperimentalWorkflowValueDtoSchema);
    },
    get step(): ExperimentalWorkflowValueSchemaTypeDto {
      return ExperimentalWorkflowValueDtoSchema;
    },
  })),
  dtozod.object({ type: dtozod.literal('conversation'), messages: dtozod.array(ExperimentalWorkflowMessageDtoSchema) }),
]);
export type ExperimentalWorkflowValueDto = dtozod.infer<typeof ExperimentalWorkflowValueDtoSchema>;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Required for recursive schema inference.
export interface ExperimentalWorkflowBlockSchemaTypeDto extends dtozod.DtoObject<{ steps: dtozod.DtoArray<typeof ExperimentalWorkflowStepDtoSchema> }> {}
const WorkflowBlockDtoSchema: ExperimentalWorkflowBlockSchemaTypeDto = dtozod.object({
  get steps(): dtozod.DtoArray<typeof ExperimentalWorkflowStepDtoSchema> {
    return dtozod.array(ExperimentalWorkflowStepDtoSchema);
  },
});
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Required for recursive schema inference.
export interface WorkflowBranchSchemaTypeDto extends dtozod.DtoObject<{
  steps: dtozod.DtoArray<typeof ExperimentalWorkflowStepDtoSchema>;
  outputs: dtozod.DtoRecord<ReturnType<typeof dtozod.string>, typeof ExperimentalWorkflowValueDtoSchema>;
}> {}
const WorkflowBranchDtoSchema: WorkflowBranchSchemaTypeDto = dtozod.object({
  get steps(): dtozod.DtoArray<typeof ExperimentalWorkflowStepDtoSchema> {
    return dtozod.array(ExperimentalWorkflowStepDtoSchema);
  },
  outputs: dtozod.record(dtozod.string(), ExperimentalWorkflowValueDtoSchema),
});
const WorkflowLoopStateDtoSchema = dtozod.record(dtozod.string(), dtozod.object({ initial: ExperimentalWorkflowValueDtoSchema, next: ExperimentalWorkflowValueDtoSchema }));
const WorkflowStepBaseDtoSchema = dtozod.object({ id: dtozod.string(), name: dtozod.string() });

export const ExperimentalWorkflowModelConfigurationDtoSchema = resolveMissingAsUndefined(dtozod.object({
  endpoint: EndpointDtoSchema,
  modelId: dtozod.string(),
  lmParameters: missingAsUndefined(LmParametersDtoSchema),
}));
export type ExperimentalWorkflowModelConfigurationDto = dtozod.infer<typeof ExperimentalWorkflowModelConfigurationDtoSchema>;


export const ExperimentalWorkflowStepDtoSchema = resolveMissingAsUndefined(dtozod.discriminatedUnion('type', [
  WorkflowStepBaseDtoSchema.extend({ type: dtozod.literal('value'), value: ExperimentalWorkflowValueDtoSchema }),
  WorkflowStepBaseDtoSchema.extend({ type: dtozod.literal('model_selection'), targets: dtozod.array(ExperimentalWorkflowModelConfigurationDtoSchema) }),
  WorkflowStepBaseDtoSchema.extend({ type: dtozod.literal('parse_json'), source: ExperimentalWorkflowValueDtoSchema }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('text_generation'),
    target: ExperimentalWorkflowValueDtoSchema,
    conversation: ExperimentalWorkflowValueDtoSchema,
    appendMessages: dtozod.array(ExperimentalWorkflowMessageDtoSchema),
    systemPrompt: missingAsUndefined(SystemPromptDtoSchema),
    lmParameters: missingAsUndefined(LmParametersDtoSchema),
    toolConfigs: ExperimentalToolConfigsDtoSchema,
    toolExecution: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
      maxRounds: dtozod.number(),
      maxCalls: dtozod.number(),
      shell: missingAsUndefined(dtozod.object({ volumeId: dtozod.string(), access: dtozod.enum(['read-only', 'read-write']) })),
    }))),
  }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('audio_generation'),
    modelId: ExperimentalWorkflowValueDtoSchema,
    text: ExperimentalWorkflowValueDtoSchema,
    reference: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
    parameters: dtozod.object({
      language: ExperimentalWorkflowValueDtoSchema,
      audioBackend: ExperimentalWorkflowValueDtoSchema,
      contextTokens: ExperimentalWorkflowValueDtoSchema,
      maxFrames: ExperimentalWorkflowValueDtoSchema,
      temperature: ExperimentalWorkflowValueDtoSchema,
      topK: ExperimentalWorkflowValueDtoSchema,
      topP: ExperimentalWorkflowValueDtoSchema,
      seed: ExperimentalWorkflowValueDtoSchema,
    }),
    onLimit: dtozod.enum(['error', 'keep']),
  }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('image_generation'),
    model: ExperimentalWorkflowValueDtoSchema,
    prompt: ExperimentalWorkflowValueDtoSchema,
    parameters: dtozod.object({
      negativePrompt: ExperimentalWorkflowValueDtoSchema,
      width: ExperimentalWorkflowValueDtoSchema,
      height: ExperimentalWorkflowValueDtoSchema,
      steps: ExperimentalWorkflowValueDtoSchema,
      guidance: ExperimentalWorkflowValueDtoSchema,
      seed: ExperimentalWorkflowValueDtoSchema,
      sampler: ExperimentalWorkflowValueDtoSchema,
      scheduler: ExperimentalWorkflowValueDtoSchema,
      distilledGuidance: ExperimentalWorkflowValueDtoSchema,
      vaeTiling: ExperimentalWorkflowValueDtoSchema,
      vaeTileSize: ExperimentalWorkflowValueDtoSchema,
      flashAttention: ExperimentalWorkflowValueDtoSchema,
      bf16WeightType: ExperimentalWorkflowValueDtoSchema,
      qwenVaePolicy: ExperimentalWorkflowValueDtoSchema,
      conditioningCacheSize: ExperimentalWorkflowValueDtoSchema,
      modelArguments: ExperimentalWorkflowValueDtoSchema,
      profile: ExperimentalWorkflowValueDtoSchema,
      weightResidency: ExperimentalWorkflowValueDtoSchema,
    }),
    gpuBudgetMiB: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
    imageInputs: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
      initImage: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
      referenceImages: dtozod.array(ExperimentalWorkflowValueDtoSchema),
      strength: ExperimentalWorkflowValueDtoSchema,
    }))),
    preview: missingAsUndefined(dtozod.object({
      enabled: dtozod.boolean(),
      interval: dtozod.number(),
      startStep: dtozod.number(),
      mode: dtozod.enum(['projection', 'vae']),
      maxEdge: dtozod.number(),
    })),
  }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('tool_call'),
    tool: dtozod.discriminatedUnion('name', [
      dtozod.object({ name: dtozod.literal('calculator') }),
      dtozod.object({ name: dtozod.literal('wikipedia_search') }),
      dtozod.object({ name: dtozod.literal('wikipedia_get_page') }),
      dtozod.object({ name: dtozod.literal('shell_execute'), volumeId: dtozod.string(), access: dtozod.enum(['read-only', 'read-write']) }),
    ]),
    arguments: ExperimentalWorkflowValueDtoSchema,
    onError: dtozod.enum(['fail', 'continue']),
  }),
  WorkflowStepBaseDtoSchema.extend({ type: dtozod.literal('request_input'), prompt: ExperimentalWorkflowValueDtoSchema, responseType: dtozod.enum(['text', 'json']), choices: missingAsUndefined(ExperimentalWorkflowValueDtoSchema) }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('repeat'),
    count: ExperimentalWorkflowValueDtoSchema,
    state: WorkflowLoopStateDtoSchema,
    body: WorkflowBlockDtoSchema,
    emit: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
    stopWhen: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
  }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('for_each'),
    source: ExperimentalWorkflowValueDtoSchema,
    state: WorkflowLoopStateDtoSchema,
    body: WorkflowBlockDtoSchema,
    emit: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
    stopWhen: missingAsUndefined(ExperimentalWorkflowValueDtoSchema),
  }),
  WorkflowStepBaseDtoSchema.extend({ type: dtozod.literal('if'), condition: ExperimentalWorkflowValueDtoSchema, then: WorkflowBranchDtoSchema, else: WorkflowBranchDtoSchema }),
  WorkflowStepBaseDtoSchema.extend({ type: dtozod.literal('read_file'), volumeId: dtozod.string(), relativePath: ExperimentalWorkflowValueDtoSchema }),
  WorkflowStepBaseDtoSchema.extend({
    type: dtozod.literal('write_file'),
    volumeId: dtozod.string(),
    relativePath: ExperimentalWorkflowValueDtoSchema,
    source: ExperimentalWorkflowValueDtoSchema,
    format: dtozod.enum(['text', 'json', 'jsonl', 'binary']),
    onConflict: dtozod.enum(['error', 'overwrite']),
  }),
]));
export type ExperimentalWorkflowStepDto = dtozod.infer<typeof ExperimentalWorkflowStepDtoSchema>;

const WorkflowExecutionLimitsDtoSchema = resolveMissingAsUndefined(dtozod.object({
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
export const ExperimentalWorkflowDefinitionDtoSchema = resolveMissingAsUndefined(dtozod.object({
  name: dtozod.string(),
  steps: dtozod.array(ExperimentalWorkflowStepDtoSchema),
  executionLimits: missingAsUndefined(WorkflowExecutionLimitsDtoSchema),
}));
export type ExperimentalWorkflowDefinitionDto = dtozod.infer<typeof ExperimentalWorkflowDefinitionDtoSchema>;

export const ExperimentalWorkflowDtoSchema = dtozod.object({
  id: dtozod.string(),
  kind: dtozod.enum(['workflow', 'part']),
  createdAt: dtozod.number(),
  updatedAt: dtozod.number(),
  definition: ExperimentalWorkflowDefinitionDtoSchema,
});
export type ExperimentalWorkflowDto = dtozod.infer<typeof ExperimentalWorkflowDtoSchema>;

/** Run snapshots retain their own definition even if the source document is edited
 * or removed. Result paths locate runtime-owned temporary files, not durable data.
 */
export const ExperimentalWorkflowRunDtoSchema = resolveMissingAsUndefined(dtozod.object({
  id: dtozod.string(),
  workflowId: missingAsUndefined(dtozod.string()),
  definition: ExperimentalWorkflowDefinitionDtoSchema,
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
export type ExperimentalWorkflowRunDto = dtozod.infer<typeof ExperimentalWorkflowRunDtoSchema>;

export const TEST_ONLY = {
};
