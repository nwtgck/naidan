import { z } from 'zod';

import { missingAsUndefined, resolveMissingAsUndefined } from '@/lib/zod/missingAsUndefined';

const EmptyExperimentalSchemaDto = resolveMissingAsUndefined(z.object({}));

export const ExperimentalCalculatorToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.calculator'),
}));

export const ExperimentalChoicesToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.choices'),
}));

export const ExperimentalWikipediaToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.wikipedia'),
}));

export const ExperimentalWeshNaidanSysfsAccessScopeSchemaDto = z.enum([
  'none',
  'current_chat_only',
  'current_chat_with_chat_group',
  'main_chats',
]);


export const ExperimentalWeshToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.wesh'),
  naidanSysfs: resolveMissingAsUndefined(z.object({
    accessScope: ExperimentalWeshNaidanSysfsAccessScopeSchemaDto,
  })),
}));

export const ExperimentalToolConfigSchemaDto = z.discriminatedUnion('key', [
  ExperimentalCalculatorToolConfigSchemaDto,
  ExperimentalChoicesToolConfigSchemaDto,
  ExperimentalWikipediaToolConfigSchemaDto,
  ExperimentalWeshToolConfigSchemaDto,
]);
export type ExperimentalToolConfigDto = z.infer<typeof ExperimentalToolConfigSchemaDto>;

export const ExperimentalToolConfigsSchemaDto = z.array(ExperimentalToolConfigSchemaDto);
export type ExperimentalToolConfigsDto = z.infer<typeof ExperimentalToolConfigsSchemaDto>;


export const ExperimentalHttpEndpointSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTransformersJsEndpointSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalReasoningSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalLmParametersSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalSystemPromptOverrideSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalSystemPromptAppendSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalVolumeBaseSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalVolumeIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMountVolumeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatGroupSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalHierarchyChatNodeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalHierarchyChatGroupNodeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalHierarchySchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalBinaryObjectSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalBinaryShardIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalAttachmentSchemaDtoV1 = EmptyExperimentalSchemaDto;
export const ExperimentalAttachmentSchemaDtoV2 = EmptyExperimentalSchemaDto;
export const ExperimentalToolCallSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolCallFunctionSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTextOrBinaryObjectTextSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTextOrBinaryObjectBinaryObjectSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultExecutingSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultSuccessSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultErrorSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalToolExecutionResultErrorObjectSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeUserSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeAssistantSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeSystemSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageNodeToolSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageBranchSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatMetaSchemaDto = resolveMissingAsUndefined(z.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
}));
export const ExperimentalChatMetaIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatContentSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalProviderProfileSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalCompletedMigrationSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMigrationStateSchemaDto = EmptyExperimentalSchemaDto;

export const ExperimentalSettingsSchemaDto = resolveMissingAsUndefined(z.object({
  markdownRendering: missingAsUndefined(z.union([
    z.literal('block_markdown'),
    z.literal('monolithic_html'),
  ])),
  toolConfigPersistence: missingAsUndefined(z.literal('enabled')),
  fakeLm: missingAsUndefined(z.literal('enabled')),
  sidebarSendMessageReorder: missingAsUndefined(z.union([
    z.literal('disabled'),
    z.literal('move_sent_chat'),
  ])),
}));

const ExperimentalUnreadableRootKey = '_root';

type ExperimentalUnreadable = Readonly<Record<string, unknown>>;

type ExperimentalOutput<TSchema extends z.ZodObject> = z.output<TSchema> & {
  readonly unreadable?: ExperimentalUnreadable;
};

const attachUnreadable = <T extends object>({
  value,
  unreadable,
}: {
  value: T;
  unreadable: ExperimentalUnreadable;
}): T => {
  Object.defineProperty(value, 'unreadable', {
    value: unreadable,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return value;
};

export const optionalExperimentalFieldSchemaDto = <TSchema extends z.ZodObject>({
  schema,
}: {
  schema: TSchema;
}) => {
  // Experimental fields intentionally break the normal DTO rule that new optional
  // persisted fields should materialize as `key: undefined`. This helper is used
  // broadly across DTO objects, so emitting `experimental: undefined` everywhere
  // would add runtime overhead and review noise. The field itself is therefore
  // optional, while fields inside the experimental object still use normal DTO
  // schema rules.
  const transformed = z.unknown().transform((raw): ExperimentalOutput<TSchema> => {
    const empty = schema.parse({}) as ExperimentalOutput<TSchema>;

    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return attachUnreadable({
        value: empty,
        unreadable: { [ExperimentalUnreadableRootKey]: raw },
      });
    }

    const input = raw as Record<string, unknown>;
    const valueInput: Record<string, unknown> = {};
    const unreadable: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(input)) {
      const fieldSchema = schema.shape[key];

      if (fieldSchema === undefined) {
        unreadable[key] = rawValue;
        continue;
      }

      const result = fieldSchema.safeParse(rawValue);

      if (result.success) {
        valueInput[key] = result.data;
      } else {
        unreadable[key] = rawValue;
      }
    }

    const value = schema.parse(valueInput) as ExperimentalOutput<TSchema>;

    return Object.keys(unreadable).length === 0
      ? value
      : attachUnreadable({ value, unreadable });
  }) as z.ZodType<ExperimentalOutput<TSchema>, unknown>;

  return transformed.optional();
};
