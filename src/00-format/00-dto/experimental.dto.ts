import * as dtozod from '@/utils/dtozod';

import { optionalExperimentalFieldDtoSchema } from '@/00-format/00-dto/compatibility/experimental-field';
import { UI_LOCALES } from '@/01-models/ui-locale';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';

const EmptyExperimentalDtoSchema = resolveMissingAsUndefined(dtozod.object({}));

export const ExperimentalCalculatorToolConfigDtoSchema = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.calculator'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalChoicesToolConfigDtoSchema = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.choices'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWikipediaToolConfigDtoSchema = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.wikipedia'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
}));

export const ExperimentalWeshNaidanSysfsAccessScopeDtoSchema = dtozod.enum([
  'none',
  'current_chat_only',
  'current_chat_with_chat_group',
  'main_chats',
]);


export const ExperimentalWeshToolConfigDtoSchema = resolveMissingAsUndefined(dtozod.object({
  key: dtozod.literal('builtin.wesh'),
  status: dtozod.enum([
    'enabled',
    'disabled',
  ]),
  naidanSysfs: resolveMissingAsUndefined(dtozod.object({
    accessScope: ExperimentalWeshNaidanSysfsAccessScopeDtoSchema,
  })),
}));

export const ExperimentalToolConfigDtoSchema = dtozod.discriminatedUnion('key', [
  ExperimentalCalculatorToolConfigDtoSchema,
  ExperimentalChoicesToolConfigDtoSchema,
  ExperimentalWikipediaToolConfigDtoSchema,
  ExperimentalWeshToolConfigDtoSchema,
]);
export type ExperimentalToolConfigDto = dtozod.infer<typeof ExperimentalToolConfigDtoSchema>;

export const ExperimentalToolConfigsDtoSchema = dtozod.array(ExperimentalToolConfigDtoSchema);
export type ExperimentalToolConfigsDto = dtozod.infer<typeof ExperimentalToolConfigsDtoSchema>;


/**
 * Experimental payload owned by ExperimentalTypeEndpointDtoSchema.
 *
 * `experimental_type` is a DTO-only envelope for experimental endpoint types
 * and legacy llama_cpp_browser records. Its concrete endpoint identity is
 * stored in this payload and mapped to a normal domain endpoint;
 * `experimental_type` itself must not appear in the domain model.
 *
 * The shared experimental reader isolates unreadable endpoint settings while
 * allowing the containing settings to load with an unsupported endpoint.
 */
export const ExperimentalExperimentalTypeEndpointDtoSchema =
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

export const ExperimentalHttpEndpointDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalTransformersJsEndpointDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalLlamaCppBrowserEndpointDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalReasoningDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalLmParametersDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalSystemPromptOverrideDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalSystemPromptAppendDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalVolumeBaseDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalVolumeIndexDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMountVolumeDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalChatGroupDtoSchema = resolveMissingAsUndefined(dtozod.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsDtoSchema),
}));
export const ExperimentalHierarchyChatNodeDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalHierarchyChatGroupNodeDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalHierarchyDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalBinaryObjectDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalBinaryShardIndexDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalAttachmentDtoV1Schema = EmptyExperimentalDtoSchema;
export const ExperimentalAttachmentDtoV2Schema = EmptyExperimentalDtoSchema;
export const ExperimentalToolCallDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalToolCallFunctionDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalTextOrBinaryObjectTextDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalTextOrBinaryObjectBinaryObjectDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalToolExecutionResultExecutingDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalToolExecutionResultSuccessDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalToolExecutionResultErrorDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalToolExecutionResultErrorObjectDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageTextPartDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageReasoningPartDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageAttachmentPartDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageToolCallPartDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageToolResultPartDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageInterruptionCancelledDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageInterruptionErrorDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageNodeUserDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageNodeAssistantDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageNodeSystemDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageNodeToolDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMessageBranchDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalChatMetaDtoSchema = resolveMissingAsUndefined(dtozod.object({
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsDtoSchema),
}));
export const ExperimentalChatMetaIndexDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalChatContentDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalProviderProfileDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalCompletedMigrationDtoSchema = EmptyExperimentalDtoSchema;
export const ExperimentalMigrationStateDtoSchema = EmptyExperimentalDtoSchema;

export const ExperimentalSettingsLocaleDtoSchema = dtozod.enum(UI_LOCALES);

// Shared image settings stay here so the image records can import Endpoint
// from dto.ts without introducing a cycle through ExperimentalSettingsDtoSchema.
// Storage validates structure independently from the peer wire contract. The
// caller adapter must validate these values again before making a remote call.
const pathSchema = dtozod.string();
export const ExperimentalRemoteImageModelFileDtoSchema = dtozod.object({
  location: dtozod.discriminatedUnion('kind', [
    dtozod.object({ kind: dtozod.literal('opfs'), path: pathSchema }),
    dtozod.object({ kind: dtozod.literal('temp'), path: pathSchema }),
    dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string(), path: pathSchema }),
  ]),
  expected: dtozod.object({ size: dtozod.number(), lastModified: dtozod.number() }).optional(),
});


export const ExperimentalRemoteImageModelEditorDtoSchema = resolveMissingAsUndefined(dtozod.object({
  automaticSlots: dtozod.array(dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm'])).optional(),
  primary: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    slot: dtozod.enum(['model', 'diffusion']),
    file: ExperimentalRemoteImageModelFileDtoSchema,
    family: missingAsUndefined(dtozod.string()),
  }))),
  components: dtozod.array(dtozod.object({
    slot: dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    file: ExperimentalRemoteImageModelFileDtoSchema,
  })),
  loras: dtozod.array(dtozod.object({
    file: ExperimentalRemoteImageModelFileDtoSchema,
    strength: dtozod.number(),
    enabled: dtozod.enum(['enabled', 'disabled']),
  })),
}));
export type ExperimentalRemoteImageModelEditorDto = dtozod.infer<typeof ExperimentalRemoteImageModelEditorDtoSchema>;

export const ExperimentalImageInferenceLocationPreferenceDtoSchema = dtozod.union([
  dtozod.object({ kind: dtozod.literal('local') }),
  dtozod.object({ kind: dtozod.literal('unavailable') }),
  resolveMissingAsUndefined(dtozod.object({
    kind: dtozod.literal('naidan_rpc'),
    registration: missingAsUndefined(dtozod.object({ registrationId: dtozod.string(), peerPublicKey: dtozod.string() })),
  })),
]);
export type ExperimentalImageInferenceLocationPreferenceDto = dtozod.infer<typeof ExperimentalImageInferenceLocationPreferenceDtoSchema>;

export const ExperimentalRemoteImageModelEditorPreferencesDtoSchema = dtozod.array(dtozod.object({
  registrationId: dtozod.string(),
  peerPublicKey: dtozod.string(),
  editor: ExperimentalRemoteImageModelEditorDtoSchema,
}));
export type ExperimentalRemoteImageModelEditorPreferenceDto = dtozod.infer<typeof ExperimentalRemoteImageModelEditorPreferencesDtoSchema>[number];

export const ExperimentalImageGenerationPathDtoSchema = dtozod.string();
const BrowserImageModelLocationDtoSchema = dtozod.discriminatedUnion('kind', [
  dtozod.object({ kind: dtozod.literal('opfs'), path: ExperimentalImageGenerationPathDtoSchema }),
  dtozod.object({ kind: dtozod.literal('temp'), path: ExperimentalImageGenerationPathDtoSchema }),
  dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string(), path: ExperimentalImageGenerationPathDtoSchema }),
]);
export const ExperimentalBrowserImageModelSelectionDtoSchema = dtozod.object({
  primary: dtozod.object({
    slot: dtozod.enum(['model', 'diffusion']),
    location: BrowserImageModelLocationDtoSchema,
  }),
  components: dtozod.array(dtozod.object({
    slot: dtozod.enum(['vae', 'clipL', 'clipG', 't5', 'lm']),
    choice: dtozod.discriminatedUnion('kind', [
      dtozod.object({ kind: dtozod.literal('file'), location: BrowserImageModelLocationDtoSchema }),
      dtozod.object({ kind: dtozod.literal('none') }),
    ]),
  })),
  loras: dtozod.array(dtozod.object({
    location: BrowserImageModelLocationDtoSchema,
    enabled: dtozod.enum(['enabled', 'disabled']),
    strength: dtozod.number(),
  })),
});
export const ExperimentalLlamaCppBrowserSettingsDtoSchema = resolveMissingAsUndefined(dtozod.object({
  visionBf16Storage: missingAsUndefined(dtozod.enum(['legacy-expand', 'retain-checked'])),
  contextTokens: missingAsUndefined(dtozod.number()),
  modelDownloadDestination: missingAsUndefined(dtozod.discriminatedUnion('kind', [
    dtozod.object({ kind: dtozod.literal('opfs') }),
    dtozod.object({ kind: dtozod.literal('host'), directoryId: dtozod.string() }),
  ])),
}));

export const ExperimentalBrowserImageGenerationSettingsDtoSchema = resolveMissingAsUndefined(dtozod.object({
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
  modelSelection: missingAsUndefined(ExperimentalBrowserImageModelSelectionDtoSchema),
  inferenceLocation: missingAsUndefined(ExperimentalImageInferenceLocationPreferenceDtoSchema),
  remoteModelEditors: missingAsUndefined(ExperimentalRemoteImageModelEditorPreferencesDtoSchema),
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
  bf16WeightType: missingAsUndefined(dtozod.enum(['f32', 'f16', 'bf16'])),
}));

export const ExperimentalTranslationAutoTranslateDtoSchema = resolveMissingAsUndefined(dtozod.object({
  enabled: missingAsUndefined(dtozod.boolean()),
  debounceMs: missingAsUndefined(dtozod.number()),
}));

export const ExperimentalTranslationSettingsDtoSchema = resolveMissingAsUndefined(dtozod.object({
  modelId: missingAsUndefined(dtozod.string()),
  autoTranslate: missingAsUndefined(ExperimentalTranslationAutoTranslateDtoSchema),
}));
export type ExperimentalTranslationSettingsDto = dtozod.infer<typeof ExperimentalTranslationSettingsDtoSchema>;

const FileExplorerPaneVisibilityDtoSchema = dtozod.enum(['visible', 'hidden']);

export const ExperimentalFileExplorerSettingsDtoSchema = resolveMissingAsUndefined(dtozod.object({
  viewMode: missingAsUndefined(dtozod.enum(['icon', 'list', 'column', 'tree'])),
  previewVisibility: missingAsUndefined(FileExplorerPaneVisibilityDtoSchema),
  previewWidthPx: missingAsUndefined(dtozod.number()),
  treeVisibility: missingAsUndefined(FileExplorerPaneVisibilityDtoSchema),
  treeWidthPx: missingAsUndefined(dtozod.number()),
  fileInformationVisibility: missingAsUndefined(FileExplorerPaneVisibilityDtoSchema),
  sortField: missingAsUndefined(dtozod.enum(['name', 'size', 'dateModified', 'type'])),
  sortDirection: missingAsUndefined(dtozod.enum(['ascending', 'descending'])),
  wordWrap: missingAsUndefined(dtozod.enum(['wrap', 'no_wrap'])),
  editorLineNumbers: missingAsUndefined(dtozod.enum(['shown', 'hidden'])),
}));

export const ExperimentalSettingsDtoSchema = resolveMissingAsUndefined(dtozod.object({
  locale: missingAsUndefined(ExperimentalSettingsLocaleDtoSchema),
  /**
   * Development convenience only. This does not improve security and MUST NOT
   * be used for security. A late-applied CSP meta cannot prevent loads that
   * already occurred. NEVER use this value for feature permissions or ON/OFF
   * decisions. Clearing the setting means undefined, not an empty string.
   */
  metaCsp: missingAsUndefined(dtozod.string()),
  chatBrowserModelPickerTab: missingAsUndefined(dtozod.enum(['files', 'linked-folders', 'hugging-face', 'saved'])),
  modelDiscoveryTab: missingAsUndefined(dtozod.enum(['candidates', 'hugging_face', 'local_files'])),
  huggingFaceModelSearch: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    autoSearch: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
  }))),
  markdownRendering: missingAsUndefined(dtozod.union([
    dtozod.literal('block_markdown'),
    dtozod.literal('monolithic_html'),
  ])),
  toolConfigPersistence: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
  toolConfigs: missingAsUndefined(ExperimentalToolConfigsDtoSchema),
  fakeLm: missingAsUndefined(dtozod.literal('enabled')),
  naidanRpc: missingAsUndefined(dtozod.literal('enabled')),
  unimplementedLauncherEntries: missingAsUndefined(dtozod.enum(['show', 'hide'])),
  audioTranscription: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    microphoneAutoCopy: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
    modelId: missingAsUndefined(dtozod.string()),
    modelAutoLoad: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
    microphoneSegmentMaxSeconds: missingAsUndefined(dtozod.number()),
    recognitionLanguage: missingAsUndefined(dtozod.enum(['auto', 'ja', 'en'])),
  }))),
  generationSpeed: missingAsUndefined(resolveMissingAsUndefined(dtozod.object({
    status: missingAsUndefined(dtozod.enum(['enabled', 'disabled'])),
    inlineStats: missingAsUndefined(dtozod.enum(['on_demand', 'always'])),
    llamaCppServerTimings: missingAsUndefined(dtozod.enum(['auto', 'enabled', 'disabled'])),
  }))),
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
  fileExplorer: missingAsUndefined(optionalExperimentalFieldDtoSchema({ schema: ExperimentalFileExplorerSettingsDtoSchema })),
  liveConversationModelId: missingAsUndefined(dtozod.string()),
  // Isolate the deliberately removed Boolean autoTranslate without losing the model.
  translation: missingAsUndefined(optionalExperimentalFieldDtoSchema({ schema: ExperimentalTranslationSettingsDtoSchema })),
  llamaCppBrowser: missingAsUndefined(ExperimentalLlamaCppBrowserSettingsDtoSchema),
  browserImageGeneration: missingAsUndefined(ExperimentalBrowserImageGenerationSettingsDtoSchema),
  hostModelDirectories: missingAsUndefined(dtozod.array(dtozod.object({
    id: dtozod.string(),
    name: dtozod.string(),
  }))),
}));

export { optionalExperimentalFieldDtoSchema } from '@/00-format/00-dto/compatibility/experimental-field';

export const TEST_ONLY = {
};
