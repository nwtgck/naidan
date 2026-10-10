import * as dtozod from '@/utils/dtozod';

import { UI_LOCALES } from '@/01-models/ui-locale';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';

const EmptyExperimentalSchemaDto = resolveMissingAsUndefined(dtozod.object({}));

export const ExperimentalCalculatorToolConfigSchemaDto = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.calculator'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalChoicesToolConfigSchemaDto = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.choices'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWikipediaToolConfigSchemaDto = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.wikipedia'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWeshNaidanSysfsAccessScopeSchemaDto = dtozod.enum([
  'none',
  'current_chat_only',
  'current_chat_with_chat_group',
  'main_chats',
]);


export const ExperimentalWeshToolConfigSchemaDto = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.wesh'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
  naidanSysfs: resolveMissingAsUndefined(dtozod.object({
    accessScope: ExperimentalWeshNaidanSysfsAccessScopeSchemaDto,
  })),
}));

export const ExperimentalToolConfigSchemaDto = dtozod.discriminatedUnion('key', [
  ExperimentalCalculatorToolConfigSchemaDto,
  ExperimentalChoicesToolConfigSchemaDto,
  ExperimentalWikipediaToolConfigSchemaDto,
  ExperimentalWeshToolConfigSchemaDto,
]);
export type ExperimentalToolConfigDto = dtozod.infer<typeof ExperimentalToolConfigSchemaDto>;

export const ExperimentalToolConfigsSchemaDto = dtozod.array(ExperimentalToolConfigSchemaDto);
export type ExperimentalToolConfigsDto = dtozod.infer<typeof ExperimentalToolConfigsSchemaDto>;


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
export const ExperimentalExperimentalTypeEndpointSchemaDto =
  resolveMissingAsUndefined(dtozod.object({
    endpoint: missingAsUndefined(dtozod.union([
      resolveMissingAsUndefined(dtozod.object({ type: dtozod.literal('naidan_rpc'), registrationId: missingAsUndefined(dtozod.string()) })),
      resolveMissingAsUndefined(dtozod.object({
        type: dtozod.literal('browser_provided_lm'),
      })),
      resolveMissingAsUndefined(dtozod.object({
        type: dtozod.literal('llama_cpp_browser'),
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
export const ExperimentalChatGroupSchemaDto = resolveMissingAsUndefined(dtozod.object({
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
export const ExperimentalChatMetaSchemaDto = resolveMissingAsUndefined(dtozod.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
}));
export const ExperimentalChatMetaIndexSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalChatContentSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalProviderProfileSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalCompletedMigrationSchemaDto = EmptyExperimentalSchemaDto;
export const ExperimentalMigrationStateSchemaDto = EmptyExperimentalSchemaDto;

export const ExperimentalSettingsLocaleSchemaDto = dtozod.enum(UI_LOCALES);

// Shared image settings stay here so the image records can import Endpoint
// from dto.ts without introducing a cycle through ExperimentalSettingsSchemaDto.
// Storage validates structure independently from the peer wire contract. The
// caller adapter must validate these values again before making a remote call.
const pathSchema = dtozod.string();
export const ExperimentalRemoteImageModelFileSchemaDto = dtozod.object({
  location: dtozod.discriminatedUnion('kind', [
    dtozod.object({ kind: dtozod.literal('opfs'), path: pathSchema }),
    dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string(), path: pathSchema }),
  ]),
  expected: dtozod.object({ size: dtozod.number(), lastModified: dtozod.number() }).optional(),
});


export const ExperimentalRemoteImageModelEditorSchemaDto = resolveMissingAsUndefined(dtozod.object({
  primary: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    slot: dtozod.enum(['model', 'diffusion']),
    file: ExperimentalRemoteImageModelFileSchemaDto,
    family: missingAsUndefined(dtozod.string()),
  }))),
  components: dtozod.array(dtozod.object({
    slot: dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    file: ExperimentalRemoteImageModelFileSchemaDto,
  })),
  loras: dtozod.array(dtozod.object({
    file: ExperimentalRemoteImageModelFileSchemaDto,
    strength: dtozod.number(),
    enabled: dtozod.enum(['enabled', 'disabled']),
  })),
}));
export type ExperimentalRemoteImageModelEditorDto = dtozod.infer<typeof ExperimentalRemoteImageModelEditorSchemaDto>;

export const ExperimentalImageInferenceLocationPreferenceSchemaDto = dtozod.union([
  dtozod.object({ kind: dtozod.literal('local') }),
  dtozod.object({ kind: dtozod.literal('unavailable') }),
  resolveMissingAsUndefined(dtozod.object({
    kind: dtozod.literal('naidan_rpc'),
    registration: missingAsUndefined(dtozod.object({ registrationId: dtozod.string(), peerPublicKey: dtozod.string() })),
  })),
]);
export type ExperimentalImageInferenceLocationPreferenceDto = dtozod.infer<typeof ExperimentalImageInferenceLocationPreferenceSchemaDto>;

export const ExperimentalRemoteImageModelEditorPreferencesSchemaDto = dtozod.array(dtozod.object({
  registrationId: dtozod.string(),
  peerPublicKey: dtozod.string(),
  editor: ExperimentalRemoteImageModelEditorSchemaDto,
}));
export type ExperimentalRemoteImageModelEditorPreferenceDto = dtozod.infer<typeof ExperimentalRemoteImageModelEditorPreferencesSchemaDto>[number];

export const ExperimentalImageGenerationPathSchemaDto = dtozod.string();
const BrowserImageModelLocationSchemaDto = dtozod.discriminatedUnion('kind', [
  dtozod.object({ kind: dtozod.literal('opfs'), path: ExperimentalImageGenerationPathSchemaDto }),
  dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string(), path: ExperimentalImageGenerationPathSchemaDto }),
]);
export const ExperimentalBrowserImageModelSelectionSchemaDto = dtozod.object({
  primary: dtozod.object({
    slot: dtozod.enum(['model', 'diffusion']),
    location: BrowserImageModelLocationSchemaDto,
  }),
  components: dtozod.array(dtozod.object({
    slot: dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    choice: dtozod.discriminatedUnion('kind', [
      dtozod.object({ kind: dtozod.literal('file'), location: BrowserImageModelLocationSchemaDto }),
      dtozod.object({ kind: dtozod.literal('none') }),
    ]),
  })),
  loras: dtozod.array(dtozod.object({
    location: BrowserImageModelLocationSchemaDto,
    enabled: dtozod.enum(['enabled', 'disabled']),
    strength: dtozod.number(),
  })),
});
export const ExperimentalLlamaCppBrowserSettingsSchemaDto = resolveMissingAsUndefined(dtozod.object({
  modelDownloadDestination: missingAsUndefined(dtozod.discriminatedUnion('kind', [
    dtozod.object({ kind: dtozod.literal('opfs') }),
    dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string() }),
  ])),
}));

export const ExperimentalBrowserImageGenerationSettingsSchemaDto = resolveMissingAsUndefined(dtozod.object({
  width: missingAsUndefined(dtozod.number()),
  height: missingAsUndefined(dtozod.number()),
  seedMode: missingAsUndefined(dtozod.enum(['random', 'fixed'])),
  seed: missingAsUndefined(dtozod.string()),
  debug: missingAsUndefined(dtozod.enum(['off', 'on'])),
  historyPersistence: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
  modelDownloadDestination: missingAsUndefined(dtozod.discriminatedUnion('kind', [
    dtozod.object({ kind: dtozod.literal('opfs') }),
    dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string() }),
  ])),
  imageDownload: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    format: missingAsUndefined(dtozod.enum(['png', 'webp', 'jpeg'])),
    metadata: missingAsUndefined(dtozod.enum(['include', 'omit'])),
  }))),
  modelSelection: missingAsUndefined(ExperimentalBrowserImageModelSelectionSchemaDto),
  inferenceLocation: missingAsUndefined(ExperimentalImageInferenceLocationPreferenceSchemaDto),
  remoteModelEditors: missingAsUndefined(ExperimentalRemoteImageModelEditorPreferencesSchemaDto),
  preview: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    enabled: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
    mode: missingAsUndefined(dtozod.enum(['projection', 'vae'])),
    interval: missingAsUndefined(dtozod.number()),
    startStep: missingAsUndefined(dtozod.number()),
    maxEdge: missingAsUndefined(dtozod.union([dtozod.literal(0), dtozod.number()])),
  }))),
  keepPreviews: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
  maxPreviews: missingAsUndefined(dtozod.number()),
  maxResults: missingAsUndefined(dtozod.number()),
  bf16WeightType: missingAsUndefined(dtozod.enum(['f32', 'f16'])),
}));

export const ExperimentalSettingsSchemaDto = resolveMissingAsUndefined(dtozod.object({
  locale: missingAsUndefined(ExperimentalSettingsLocaleSchemaDto),
  markdownRendering: missingAsUndefined(dtozod.union([
    dtozod.literal('block_markdown'),
    dtozod.literal('monolithic_html'),
  ])),
  toolConfigPersistence: missingAsUndefined(dtozod.literal('enabled')),
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsSchemaDto),
  fakeLm: missingAsUndefined(dtozod.literal('enabled')),
  naidanRpc: missingAsUndefined(dtozod.literal('enabled')),
  sidebarSendMessageReorder: missingAsUndefined(dtozod.union([
    dtozod.literal('disabled'),
    dtozod.literal('move_sent_chat'),
  ])),
  globalSearch: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    scope: missingAsUndefined(dtozod.enum(['all', 'current_thread', 'title_only'])),
    roleFilter: missingAsUndefined(dtozod.enum(['all', 'user', 'assistant'])),
    previewMode: missingAsUndefined(dtozod.enum(['always', 'peek', 'disabled'])),
    previewContextSize: missingAsUndefined(dtozod.union([
      dtozod.number(),
      dtozod.literal('full'),
    ])),
  }))),
  llamaCppBrowser: missingAsUndefined(ExperimentalLlamaCppBrowserSettingsSchemaDto),
  browserImageGeneration: missingAsUndefined(ExperimentalBrowserImageGenerationSettingsSchemaDto),
  hostModelDirectories: missingAsUndefined(dtozod.array(dtozod.object({
    id: dtozod.string(),
    name: dtozod.string(),
  }))),
}));

export { optionalExperimentalFieldSchemaDto } from './compatibility/experimental-field';

export const TEST_ONLY = {
};
