import type { BrowserImageModelSelection, Endpoint } from './types';
import { z } from 'zod';
import type { ImageGenerationRecord } from './image-generation-history';
import { idToRaw, type ChatId, type ImageGenerationAssetId, type ImageGenerationRunId, type ImageGenerationSessionId, type ImageGenerationStoreId, type ImageGenerationTagId } from './ids';

/** Image Generation metadata, not native Worker session/run correlation numbers. */
export type ImageGenerationTag = {
  id: ImageGenerationTagId,
  name: string,
  createdAt: number,
  updatedAt: number,
  state: 'active' | 'archived',
};

/** The reserved namespace is structural, never inferred from a user label. */
export type ImageGenerationTagReference =
  | { type: 'system', key: 'favorite' }
  | { type: 'user', tagId: ImageGenerationTagId };

/** Each field inherits independently: session, image-generation defaults, global settings. */
export type ImageGenerationTranslationOverride = {
  endpoint: Endpoint | undefined,
  modelId: string | undefined,
};

export type ImageGenerationPreferences = {
  assistantVisibility: 'open' | 'closed',
  translation: ImageGenerationTranslationOverride | undefined,
  experimentalNoticeDismissedAt: number | undefined,
  assistantLayout: 'floating' | 'docked',
};

export type ImageGenerationCatalog = {
  preferences: ImageGenerationPreferences,
  id: ImageGenerationStoreId,
  revision: number,
  createdAt: number,
  tags: ImageGenerationTag[],
};

export type ImageGenerationSession = {
  translation: ImageGenerationTranslationOverride | undefined,
  assistantChatId: ChatId | undefined,
  id: ImageGenerationSessionId,
  revision: number,
  title: string,
  createdAt: number,
  updatedAt: number,
  state: 'active' | 'archived' | 'deleting' | 'deleted',
};

/** An editable checkpoint, independent of immutable generation requests. */
export type ImageGenerationSessionDraft = {
  sessionId: ImageGenerationSessionId,
  revision: number,
  updatedAt: number,
  request: ImageGenerationRecord['request'],
  seedMode: 'random' | 'fixed',
  layout: 'checkpoint' | 'components',
  modelSelection: BrowserImageModelSelection | undefined,
  loraStates: { enabled: boolean, strength: number }[],
  count: number,
  debug: 'on' | 'off',
  retainModel: boolean,
  keepPreviews: boolean,
  maxPreviews: number,
  maxResults: number,
};

export type ImageGenerationSource = {
  role: 'settings' | 'initial-image' | 'reference-image',
  sessionId: ImageGenerationSessionId,
  assetId: ImageGenerationAssetId,
};

export type ImageGenerationRunExecution =
  | { type: 'queued' }
  | { type: 'running', startedAt: number }
  | { type: 'completed', finishedAt: number }
  | { type: 'cancelled', finishedAt: number }
  | { type: 'failed', finishedAt: number, message: string }
  | { type: 'interrupted', finishedAt: number };

/** Request and output plan never change after acceptance. Only execution changes. */
export type ImageGenerationRun = {
  id: ImageGenerationRunId,
  sessionId: ImageGenerationSessionId,
  revision: number,
  createdAt: number,
  request: ImageGenerationRecord['request'],
  seeds: string[],
  sources: ImageGenerationSource[],
  execution: ImageGenerationRunExecution,
};

/** Only completed outputs are assets. Pending output slots belong to a run. */
export type ImageGenerationAsset = {
  id: ImageGenerationAssetId,
  sessionId: ImageGenerationSessionId,
  runId: ImageGenerationRunId,
  index: number,
  createdAt: number,
  seed: string,
  result: ImageGenerationRecord['result'],
  previews: ImageGenerationRecord['previews'],
};

/** Mutable curation is separate from immutable generation facts and bytes. */
export type ImageGenerationAssetAnnotations = {
  assetId: ImageGenerationAssetId,
  sessionId: ImageGenerationSessionId,
  revision: number,
  state: 'active' | 'archived' | 'deleting' | 'deleted',
  tags: { tag: ImageGenerationTagReference, assignedAt: number }[],
};

export type ImageGenerationAssetSummary = Omit<ImageGenerationAsset, 'result' | 'previews'> & {
  binaryObjectId: ImageGenerationAsset['result']['binaryObjectId'],
  width: number,
  height: number,
  previewCount: number,
};

export type ImageGenerationRunSummary = Pick<ImageGenerationRun, 'id' | 'sessionId' | 'revision' | 'createdAt' | 'execution'> & {
  prompt: string,
  modelName: string,
  requestedCount: number,
};

export type ImageGenerationReadWarning = { path: string, message: string };
export type ImageGenerationReadResult<T> = { items: T[], warnings: ImageGenerationReadWarning[], warningCount: number };

export type ImageGenerationAssetCursor = { createdAt: number, id: ImageGenerationAssetId };
export type ImageGenerationAssetQuery = {
  visibility: 'active' | 'archived' | 'all',
  text: string,
  tags: ImageGenerationTagReference[],
  match: 'all' | 'any',
  runId: ImageGenerationRunId | undefined,
  cursor: ImageGenerationAssetCursor | undefined,
  limit: number,
};
export type ImageGenerationAssetPage = ImageGenerationReadResult<ImageGenerationAssetSummary & { annotations: ImageGenerationAssetAnnotations | undefined }> & {
  total: number,
  nextCursor: ImageGenerationAssetCursor | undefined,
};

// Labels are Unicode text, not filesystem paths or persistent identities. NFC
// preserves compatibility distinctions; do not silently NFKC-fold user labels.
export function normalizeImageGenerationTagName({ name }: { name: string }): string {
  return name.trim().normalize('NFC');
}

export function imageGenerationTagNameKey({ name }: { name: string }): string {
  // Locale-independent matching keeps an imported catalog consistent across UI locales.
  return normalizeImageGenerationTagName({ name }).toLowerCase();
}

export const imageGenerationTagNameSchema = z.string().max(1024)
  .refine(name => !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u.test(name), 'Tag names cannot contain controls, line separators, unpaired surrogates or bidi overrides.')
  .transform(name => normalizeImageGenerationTagName({ name }))
  .refine(name => Array.from(name).length >= 1 && Array.from(name).length <= 64, 'Tag names must contain 1 to 64 Unicode code points.')
  .refine(name => /[^\p{White_Space}\p{Default_Ignorable_Code_Point}]/u.test(name), 'Tag names must have visible content.')
  .refine(name => !name.normalize('NFKC').replace(/^[\p{White_Space}\p{Default_Ignorable_Code_Point}]+/u, '').startsWith('@'), 'The @ prefix is reserved for system tags.');

export function imageGenerationTagReferenceKey({ tag }: { tag: ImageGenerationTagReference }): string {
  switch (tag.type) {
  case 'system': return `system:${tag.key}`;
  case 'user': return `user:${idToRaw({ id: tag.tagId })}`;
  default: { const exhaustive: never = tag; throw new Error(String(exhaustive)); }
  }
}

export const IMAGE_GENERATION_MAX_RUN_IMAGES = 64;
const seedSchema = z.string().max(19).regex(/^(0|[1-9][0-9]*)$/)
  .refine(seed => BigInt(seed) <= 9223372036854775807n, 'Seed exceeds the signed 64-bit range.');

/** An explicit plan makes seeds known before execution and independent of retries. */
export function planImageGenerationSeeds({ baseSeed, count }: { baseSeed: string, count: number }): string[] {
  const first = BigInt(seedSchema.parse(baseSeed));
  z.number().int().min(1).max(IMAGE_GENERATION_MAX_RUN_IMAGES).parse(count);
  if (first + BigInt(count - 1) > 9223372036854775807n) throw new Error('The image seed plan exceeds the signed 64-bit range.');
  return Array.from({ length: count }, (_, index) => String(first + BigInt(index)));
}

/** Missing in THIS tab is not evidence of interruption: another tab may own a run. */
export function canTransitionImageGenerationRun({ from, to }: { from: ImageGenerationRunExecution['type'], to: ImageGenerationRunExecution['type'] }): boolean {
  switch (from) {
  case 'queued':
    switch (to) {
    case 'running': case 'cancelled': case 'failed': case 'interrupted': return true;
    case 'queued': case 'completed': return false;
    default: { const exhaustive: never = to; throw new Error(String(exhaustive)); }
    }
  case 'running':
    switch (to) {
    case 'completed': case 'cancelled': case 'failed': case 'interrupted': return true;
    case 'queued': case 'running': return false;
    default: { const exhaustive: never = to; throw new Error(String(exhaustive)); }
    }
  case 'completed': case 'cancelled': case 'failed': case 'interrupted': return false;
  default: { const exhaustive: never = from; throw new Error(String(exhaustive)); }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
