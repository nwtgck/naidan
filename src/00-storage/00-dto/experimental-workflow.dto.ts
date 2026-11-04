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
  | { type: 'conversation', messages: WorkflowMessageShapeDto<E>[] };
type WorkflowMessageShapeDto<E> = {
  role: 'system' | 'user' | 'assistant',
  parts: ({ type: 'text', text: string } | { type: 'value', value: WorkflowValueShapeDto<E> })[],
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
  role: dtozod.enum(['system', 'user', 'assistant']),
  parts: dtozod.array(dtozod.discriminatedUnion('type', [
    dtozod.object({ type: dtozod.literal('text'), text: dtozod.string() }),
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
    type: dtozod.enum(['array', 'concat', 'path']),
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
    type: dtozod.enum(['filename', 'not_empty']),
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
  }),
  WorkflowStepBaseSchemaDto.extend({ type: dtozod.literal('request_input'), prompt: ExperimentalWorkflowValueSchemaDto, responseType: dtozod.enum(['text', 'json']) }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('repeat'),
    count: ExperimentalWorkflowValueSchemaDto,
    state: WorkflowLoopStateSchemaDto,
    body: WorkflowBlockSchemaDto,
    emit: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
  }),
  WorkflowStepBaseSchemaDto.extend({
    type: dtozod.literal('for_each'),
    source: ExperimentalWorkflowValueSchemaDto,
    state: WorkflowLoopStateSchemaDto,
    body: WorkflowBlockSchemaDto,
    emit: missingAsUndefined(ExperimentalWorkflowValueSchemaDto),
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

/**
 * Editable workflow content, not a projection made by removing storage fields.
 * Adding record metadata must not silently expose it in the form or JSON editor.
 * Step IDs remain part of this definition because output references use them.
 */
export const ExperimentalWorkflowDefinitionSchemaDto = dtozod.object({
  name: dtozod.string(),
  steps: dtozod.array(ExperimentalWorkflowStepSchemaDto),
});
export type ExperimentalWorkflowDefinitionDto = dtozod.infer<typeof ExperimentalWorkflowDefinitionSchemaDto>;

export const ExperimentalWorkflowSchemaDto = dtozod.object({
  id: dtozod.string(),
  kind: dtozod.enum(['workflow', 'part']),
  createdAt: dtozod.number(),
  updatedAt: dtozod.number(),
  definition: ExperimentalWorkflowDefinitionSchemaDto,
});
export type ExperimentalWorkflowDto = dtozod.infer<typeof ExperimentalWorkflowSchemaDto>;

export const TEST_ONLY = {
};
