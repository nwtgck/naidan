import { retainRpcEndpoint, retainedRpcEndpoint, retainRpcLeaf, retainedRpcLeaf } from './retained-rpc';
import { UnavailableRpcValue } from '@/01-models/unavailable-rpc-value';
import { z } from 'zod';

import { UI_LOCALES } from '@/01-models/ui-locale';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/zod/missingAsUndefined';

const EmptyExperimentalSchemaDto = resolveMissingAsUndefined(z.object({}));

export const ExperimentalCalculatorToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.calculator'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalChoicesToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.choices'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWikipediaToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.wikipedia'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWeshNaidanSysfsAccessScopeSchemaDto = z.enum([
  'none',
  'current_chat_only',
  'current_chat_with_chat_group',
  'main_chats',
]);


export const ExperimentalWeshToolConfigSchemaDto = resolveMissingAsUndefined(z.object({
  key: z.literal('builtin.wesh'),
  status: z.enum([
    'enabled',
    'disabled',
  ]),
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


/**
 * Experimental payload owned by ExperimentalTypeEndpointSchemaDto.
 *
 * `experimental_type` is a stable DTO-only envelope. Its concrete endpoint
 * identity is stored in this payload and mapped to a normal domain endpoint;
 * `experimental_type` itself must not appear in the domain model.
 *
 * The shared experimental reader isolates unreadable endpoint settings while
 * allowing the containing settings to load with an unsupported endpoint.
 */
// Zod's object parser intentionally ignores some prototype-named keys. RPC
// authority leaves require an exact own-key check before that normalization.
export function exactRpcObject<TSchema extends z.ZodObject>({ schema }: { schema: TSchema }) {
  return z.unknown().superRefine((value, context) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !Object.hasOwn(schema.shape, key) || !descriptor.enumerable || !('value' in descriptor)) {
        context.addIssue({ code: 'custom', message: 'Unsupported RPC own property' });
      }
    }
  }).pipe(schema);
}

export const ExperimentalExperimentalTypeEndpointSchemaDto =
  resolveMissingAsUndefined(z.object({
    endpoint: missingAsUndefined(z.union([
      exactRpcObject({ schema: resolveMissingAsUndefined(z.strictObject({ type: z.literal('naidan_rpc'), registrationId: missingAsUndefined(z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)) })) }),
      resolveMissingAsUndefined(z.object({
        type: z.literal('browser_provided_lm'),
      })),
      resolveMissingAsUndefined(z.object({
        type: z.literal('llama_cpp_browser'),
      })),
    ])),
  }));

export const ExperimentalHttpEndpointSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalTransformersJsEndpointSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalReasoningSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalLmParametersSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalSystemPromptOverrideSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalSystemPromptAppendSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalVolumeBaseSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalVolumeIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMountVolumeSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatGroupSchemaDto = resolveMissingAsUndefined(z.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
}));
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
export const ExperimentalMessageTextPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageReasoningPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageAttachmentPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageToolCallPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageToolResultPartSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageInterruptionCancelledSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMessageInterruptionErrorSchemaDto = EmptyExperimentalSchemaDto;
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

export const ExperimentalSettingsLocaleSchemaDto = z.enum(UI_LOCALES);

// Shared image settings stay here so the image records can import Endpoint
// from dto.ts without introducing a cycle through ExperimentalSettingsSchemaDto.
// Storage validates structure independently from the peer wire contract. The
// caller adapter must validate these values again before making a remote call.
const pathSchema = z.string().min(1).max(4096);
export const ExperimentalRemoteImageModelFileSchemaDto = z.object({
  location: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('opfs'), path: pathSchema }),
    z.object({ kind: z.literal('host'), directoryId: z.string().min(1).max(128), path: pathSchema }),
  ]),
  expected: z.object({ size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), lastModified: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).optional(),
});

const registrationIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const peerPublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const ExperimentalRemoteImageModelEditorSchemaDto = resolveMissingAsUndefined(z.object({
  primary: missingAsUndefined(resolveMissingAsUndefined(z.object({
    slot: z.enum(['model', 'diffusion']),
    file: ExperimentalRemoteImageModelFileSchemaDto,
    family: missingAsUndefined(z.string().min(1).max(64)),
  }))),
  components: z.array(z.object({
    slot: z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    file: ExperimentalRemoteImageModelFileSchemaDto,
  })).max(5).refine(items => new Set(items.map(item => item.slot)).size === items.length),
  loras: z.array(z.object({
    file: ExperimentalRemoteImageModelFileSchemaDto,
    strength: z.number().finite().min(-10).max(10),
    enabled: z.enum(['enabled', 'disabled']),
  })).max(8),
}));
export type ExperimentalRemoteImageModelEditorDto = z.infer<typeof ExperimentalRemoteImageModelEditorSchemaDto>;

const ImageInferenceLocationSchemaDto = z.union([
  z.object({ kind: z.literal('local') }),
  exactRpcObject({
    schema: resolveMissingAsUndefined(z.strictObject({
      kind: z.literal('naidan_rpc'),
      registration: missingAsUndefined(exactRpcObject({ schema: z.strictObject({ registrationId: registrationIdSchema, peerPublicKey: peerPublicKeySchema }) })),
    })),
  }),
]);
export const ExperimentalImageInferenceLocationPreferenceSchemaDto = z.unknown().transform((input): z.infer<typeof ImageInferenceLocationSchemaDto> => {
  const retained = retainedRpcLeaf({ value: input });
  if (retained !== undefined) return retainRpcLeaf({ value: { kind: 'naidan_rpc', registration: undefined }, raw: retained });
  const result = ImageInferenceLocationSchemaDto.safeParse(input);
  if (result.success) return result.data;
  // A present invalid routing value is never equivalent to absent preferences.
  // Keep it unavailable rather than selecting the local default.
  return retainRpcLeaf({ value: { kind: 'naidan_rpc', registration: undefined }, raw: new UnavailableRpcValue({ raw: input }) });
});
export type ExperimentalImageInferenceLocationPreferenceDto = z.infer<typeof ExperimentalImageInferenceLocationPreferenceSchemaDto>;

const RemoteImageEditorPreferenceSchemaDto = exactRpcObject({
  schema: z.strictObject({
    registrationId: registrationIdSchema,
    peerPublicKey: peerPublicKeySchema,
    editor: ExperimentalRemoteImageModelEditorSchemaDto,
  }),
});
const RemoteImageEditorValueSchemaDto = z.unknown().transform((input, context): z.infer<typeof RemoteImageEditorPreferenceSchemaDto> | { unavailableRpc: UnavailableRpcValue } => {
  const retained = retainedRpcLeaf({ value: input });
  if (retained !== undefined) return retainRpcLeaf({ value: { unavailableRpc: retained.copy() }, raw: retained });
  const result = RemoteImageEditorPreferenceSchemaDto.safeParse(input);
  if (result.success) return result.data;
  if (typeof input === 'object' && input !== null && ExperimentalRemoteImageModelEditorSchemaDto.safeParse(Object.getOwnPropertyDescriptor(input, 'editor')?.value).success) {
    const raw = new UnavailableRpcValue({ raw: input });
    return retainRpcLeaf({ value: { unavailableRpc: raw }, raw });
  }
  context.addIssue({ code: 'custom', message: 'Invalid remote image editor' });
  return z.NEVER;
});
export const ExperimentalRemoteImageModelEditorPreferencesSchemaDto = z.array(RemoteImageEditorValueSchemaDto).max(32).refine(items => {
  const keys = items.flatMap(item => 'unavailableRpc' in item ? [] : [`${item.registrationId}:${item.peerPublicKey}`]);
  return new Set(keys).size === keys.length;
});
export type ExperimentalRemoteImageModelEditorPreferenceDto = z.infer<typeof ExperimentalRemoteImageModelEditorPreferencesSchemaDto>[number];

export const ExperimentalImageGenerationPathSchemaDto = z.string().min(1).refine(value =>
  !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const BrowserImageModelLocationSchemaDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opfs'), path: ExperimentalImageGenerationPathSchemaDto.refine(path => path.startsWith('models/')) }),
  z.object({ kind: z.literal('host'), directoryId: z.string().min(1), path: ExperimentalImageGenerationPathSchemaDto }),
]);
export const ExperimentalBrowserImageModelSelectionSchemaDto = z.object({
  primary: z.object({
    slot: z.enum(['model', 'diffusion']),
    location: BrowserImageModelLocationSchemaDto,
  }),
  components: z.array(z.object({
    slot: z.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    choice: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('file'), location: BrowserImageModelLocationSchemaDto }),
      z.object({ kind: z.literal('none') }),
    ]),
  })).max(5).refine(components => new Set(components.map(component => component.slot)).size === components.length),
  loras: z.array(z.object({
    location: BrowserImageModelLocationSchemaDto,
    enabled: z.enum(['enabled', 'disabled']),
    strength: z.number().finite().min(-10).max(10),
  })).max(16),
});
export const ExperimentalLlamaCppBrowserSettingsSchemaDto = resolveMissingAsUndefined(z.object({
  modelDownloadDestination: missingAsUndefined(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('opfs') }),
    z.object({ kind: z.literal('host'), directoryId: z.string().min(1) }),
  ])),
}));

export const ExperimentalBrowserImageGenerationSettingsSchemaDto = resolveMissingAsUndefined(z.object({
  width: missingAsUndefined(z.number().int().min(128).max(2048).multipleOf(64)),
  height: missingAsUndefined(z.number().int().min(128).max(2048).multipleOf(64)),
  seedMode: missingAsUndefined(z.enum(['random', 'fixed'])),
  seed: missingAsUndefined(z.string().max(20).regex(/^-?(0|[1-9][0-9]*)$/).pipe(z.string().refine(value => BigInt(value) >= -1n && BigInt(value) <= 9223372036854775807n))),
  debug: missingAsUndefined(z.enum(['off', 'on'])),
  historyPersistence: missingAsUndefined(z.enum(['enabled', 'disabled'])),
  modelDownloadDestination: missingAsUndefined(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('opfs') }),
    z.object({ kind: z.literal('host'), directoryId: z.string().min(1) }),
  ])),
  imageDownload: missingAsUndefined(resolveMissingAsUndefined(z.object({
    format: missingAsUndefined(z.enum(['png', 'webp', 'jpeg'])),
    metadata: missingAsUndefined(z.enum(['include', 'omit'])),
  }))),
  modelSelection: missingAsUndefined(ExperimentalBrowserImageModelSelectionSchemaDto),
  inferenceLocation: missingAsUndefined(ExperimentalImageInferenceLocationPreferenceSchemaDto),
  remoteModelEditors: missingAsUndefined(ExperimentalRemoteImageModelEditorPreferencesSchemaDto),
  preview: missingAsUndefined(resolveMissingAsUndefined(z.object({
    enabled: missingAsUndefined(z.enum(['enabled', 'disabled'])),
    mode: missingAsUndefined(z.enum(['projection', 'vae'])),
    interval: missingAsUndefined(z.number().int().min(1).max(100)),
    startStep: missingAsUndefined(z.number().int().min(1).max(100)),
    maxEdge: missingAsUndefined(z.union([z.literal(0), z.number().int().min(64).max(2048)])),
  }))),
  keepPreviews: missingAsUndefined(z.enum(['enabled', 'disabled'])),
  maxPreviews: missingAsUndefined(z.number().int().min(1).max(100)),
  maxResults: missingAsUndefined(z.number().int().min(1).max(100)),
  bf16WeightType: missingAsUndefined(z.enum(['f32', 'f16'])),
}));

export const ExperimentalSettingsSchemaDto = resolveMissingAsUndefined(z.object({
  locale: missingAsUndefined(ExperimentalSettingsLocaleSchemaDto),
  markdownRendering: missingAsUndefined(z.union([
    z.literal('block_markdown'),
    z.literal('monolithic_html'),
  ])),
  toolConfigPersistence: missingAsUndefined(z.literal('enabled')),
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
  fakeLm: missingAsUndefined(z.literal('enabled')),
  naidanRpc: missingAsUndefined(z.literal('enabled')),
  sidebarSendMessageReorder: missingAsUndefined(z.union([
    z.literal('disabled'),
    z.literal('move_sent_chat'),
  ])),
  globalSearch: missingAsUndefined(resolveMissingAsUndefined(z.object({
    scope: missingAsUndefined(z.enum(['all', 'current_thread', 'title_only'])),
    roleFilter: missingAsUndefined(z.enum(['all', 'user', 'assistant'])),
    previewMode: missingAsUndefined(z.enum(['always', 'peek', 'disabled'])),
    previewContextSize: missingAsUndefined(z.union([
      z.number(),
      z.literal('full'),
    ])),
  }))),
  llamaCppBrowser: missingAsUndefined(ExperimentalLlamaCppBrowserSettingsSchemaDto),
  browserImageGeneration: missingAsUndefined(ExperimentalBrowserImageGenerationSettingsSchemaDto),
  hostModelDirectories: missingAsUndefined(z.array(z.object({
    id: z.string(),
    name: z.string(),
  }))),
}));

const ExperimentalUnreadableRootKey = '_root';

type ExperimentalUnreadable = Readonly<Record<string, unknown>>;

type ExperimentalOutput<TSchema extends z.ZodObject> = z.output<TSchema> & {
  readonly unreadable?: ExperimentalUnreadable,
};

const attachUnreadable = <T extends object>({
  value,
  unreadable,
}: {
  value: T,
  unreadable: ExperimentalUnreadable,
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
  schema: TSchema,
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
    const retainedEndpoint = input.endpoint === undefined ? retainedRpcEndpoint({ value: raw }) : undefined;
    const unreadable: Record<string, unknown> = retainedEndpoint === undefined ? {} : { endpoint: retainedEndpoint.read() };

    for (const [key, rawValue] of Object.entries(input)) {
      if (key === 'endpoint' && retainedEndpoint !== undefined) continue;
      const fieldSchema = Object.hasOwn(schema.shape, key) ? schema.shape[key] : undefined;

      if (fieldSchema === undefined) {
        Object.defineProperty(unreadable, key, { value: rawValue, enumerable: true, configurable: true, writable: true });
        continue;
      }

      const result = fieldSchema.safeParse(rawValue);

      if (result.success) {
        Object.defineProperty(valueInput, key, { value: result.data, enumerable: true, configurable: true, writable: true });
      } else {
        Object.defineProperty(unreadable, key, { value: rawValue, enumerable: true, configurable: true, writable: true });
      }
    }

    const value = schema.parse(valueInput) as ExperimentalOutput<TSchema>;
    const unsupportedEndpoint = unreadable.endpoint;
    if (Object.is(schema, ExperimentalExperimentalTypeEndpointSchemaDto) && typeof unsupportedEndpoint === 'object'
      && unsupportedEndpoint !== null && Object.getOwnPropertyDescriptor(unsupportedEndpoint, 'type')?.value === 'naidan_rpc') {
      retainRpcEndpoint({ value, raw: retainedEndpoint ?? new UnavailableRpcValue({ raw: unsupportedEndpoint }) });
    }

    return Object.keys(unreadable).length === 0
      ? value
      : attachUnreadable({ value, unreadable });
  }) as z.ZodType<ExperimentalOutput<TSchema>, unknown>;

  return transformed.optional();
};


// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
