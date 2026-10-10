import { z } from 'zod';
import type { ChatGroupId } from './ids';

// These source descriptors contain no model bytes or credentials. They are
// used by the session-local launch flow and the Hugging Face download boundary.
export function isModelSourceSegment({ name }: { name: string }): boolean {
  return name.length > 0 && name !== '.' && name !== '..'
    && !/[\\/]/.test(name)
    && !Array.from(name).some(character => character.charCodeAt(0) < 32)
    && new TextEncoder().encode(name).length <= 255;
}

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

export function huggingFaceModelId({ repository, modelPath }: { repository: string, modelPath: string }): string {
  modelSourceRepositorySchema.parse(repository);
  if (!modelPath.split('/').every(name => isModelSourceSegment({ name })) || !/\.gguf$/i.test(modelPath)) {
    throw new Error('Invalid model source path');
  }
  return `hf.co/${repository}:${encodeURIComponent(modelPath)}`;
}

export const modelLaunchTargetSchema = z.object({
  selection: modelSourceSelectionSchema,
  mainFilePath: z.string(),
  modelId: z.string().min(1).max(512),
}).strict().refine(value => value.selection.files.some(file => file.path === value.mainFilePath)
  && value.modelId === `hf.co/${value.selection.repository}:${encodeURIComponent(value.mainFilePath)}`);
export type ModelLaunchTarget = z.infer<typeof modelLaunchTargetSchema>;
export const modelLaunchPhaseSchema = z.enum(['reserved', 'active', 'detached']);
export type ModelLaunchPhase = z.infer<typeof modelLaunchPhaseSchema>;

export type ChatModelLaunch = {
  version: 1,
  input: string,
  requestedVariant: string | undefined,
  target: ModelLaunchTarget,
  chatGroupId: ChatGroupId,
  phase: ModelLaunchPhase,
};

export async function modelLaunchChatGroupPrefix({ modelId }: { modelId: string }): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(modelId));
  return `model-launch-${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export const TEST_ONLY = {
};
