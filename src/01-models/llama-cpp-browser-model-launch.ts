import { z } from 'zod';
import type { ChatGroupId } from './ids';
import type { DownloadDestination } from './download';
import type { SettingsTitleGeneration } from './types';
import { cloneDownloadDestination } from './download';
import { cloneSettingsTitleGeneration } from './title-generation';
import { exactObject } from '@/utils/exact-object';
import { formatHuggingFaceModelId, isModelSourceSegment } from './llama-cpp-browser-model-id';
export { isModelSourceSegment } from './llama-cpp-browser-model-id';

// These source descriptors contain no model bytes or credentials. They are
// used by page-local launch receipts and the Hugging Face download boundary.
export const modelSourceRepositorySchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .refine(value => value.split('/').every(name => isModelSourceSegment({ name })));
export const modelSourceRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/i);
export const modelSourceFileSchema = z.object({
  path: z.string().refine(value => value.split('/').every(name => isModelSourceSegment({ name }))).refine(value => /\.gguf$/i.test(value)),
  size: z.number().int().min(24).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const modelSourceSelectionSchema = z.object({
  repository: modelSourceRepositorySchema,
  revision: modelSourceRevisionSchema,
  files: z.array(modelSourceFileSchema).min(1).max(10000),
}).strict()
  .refine(value => new Set(value.files.map(file => file.path)).size === value.files.length)
  .refine(value => Number.isSafeInteger(value.files.reduce((sum, file) => sum + file.size, 0)));

export const modelLaunchTargetSchema = z.object({
  selection: modelSourceSelectionSchema,
  mainFilePath: z.string(),
  modelId: z.string().min(1).max(512),
}).strict().refine(value => {
  if (!value.selection.files.some(file => file.path === value.mainFilePath)) {
    return false;
  }
  try {
    return value.modelId === formatHuggingFaceModelId({ repository: value.selection.repository, mainFilePath: value.mainFilePath });
  } catch {
    return false;
  }
});
export type ModelLaunchTarget = z.infer<typeof modelLaunchTargetSchema>;
export type ModelLaunchPhase = 'reserved' | 'active' | 'detached';

export type ChatModelLaunch = {
  input: string,
  requestedVariant: string | undefined,
  target: ModelLaunchTarget,
  destination: DownloadDestination,
  effectiveModelId: string,
  chatGroupId: ChatGroupId,
  previousChatGroupId?: ChatGroupId,
  chatGroupName: string,
  titleGeneration: SettingsTitleGeneration,
  phase: ModelLaunchPhase,
};

export function cloneModelLaunchTarget({ target }: { target: ModelLaunchTarget }): ModelLaunchTarget {
  const { selection, mainFilePath, modelId, ...unhandled } = target;
  unhandled satisfies Record<PropertyKey, never>;
  const { repository, revision, files, ...unhandledSelection } = selection;
  unhandledSelection satisfies Record<PropertyKey, never>;
  return exactObject<ModelLaunchTarget>()({
    selection: exactObject<ModelLaunchTarget['selection']>()({
      repository,
      revision,
      files: files.map(file => {
        const { path, size, ...unhandledFile } = file;
    unhandledFile satisfies Record<PropertyKey, never>;
    return exactObject<ModelLaunchTarget['selection']['files'][number]>()({ path, size });
      }),
    }),
    mainFilePath,
    modelId,
  });
}

export function cloneChatModelLaunch({ launch }: { launch: ChatModelLaunch }): ChatModelLaunch {
  const { input, requestedVariant, target, destination, effectiveModelId, chatGroupId, previousChatGroupId, chatGroupName, titleGeneration, phase, ...unhandled } = launch;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ChatModelLaunch>()({ input, requestedVariant, target: cloneModelLaunchTarget({ target }), destination: cloneDownloadDestination({ destination }), effectiveModelId, chatGroupId, previousChatGroupId, chatGroupName, titleGeneration: cloneSettingsTitleGeneration({ source: titleGeneration }), phase });
}

export async function modelLaunchChatGroupPrefix({ modelId }: { modelId: string }): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(modelId));
  return `model-launch-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const TEST_ONLY = {
};
