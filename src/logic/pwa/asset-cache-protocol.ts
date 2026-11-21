import { z } from 'zod';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also consumed by the independently checked Service Worker.
import { UI_LOCALES } from '../../01-models/ui-locale';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also consumed by the independently checked Service Worker.
import { chatProfileSchema } from '../../features/llama-cpp-browser/chat-profiles';
import { pwaRuntimeEngines, type PWARuntimeEngine } from './cache-policy';

export const READ_ASSET_SELECTION = 'NAIDAN_PWA_READ_ASSET_SELECTION_V1';
export const READ_CACHED_LOCALES = 'NAIDAN_PWA_READ_CACHED_LOCALES_V1';
export const ASSET_SELECTION_CHANGED = 'NAIDAN_PWA_ASSET_SELECTION_CHANGED_V1';
export const PREPARE_OFFLINE_ASSETS = 'NAIDAN_PWA_PREPARE_OFFLINE_ASSETS_V1';

const localeSchema = z.enum(UI_LOCALES);
export const cachedLocalesReplySchema = z.array(localeSchema).max(UI_LOCALES.length);
const transformersVariantSchema = z.enum(['standard', 'asyncify']);
const runtimeSelectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('known'), profiles: z.array(z.string().min(1)) }),
  z.object({ status: z.literal('unknown') }),
]);
export type RuntimeSelection = z.infer<typeof runtimeSelectionSchema>;
const optionalRuntimeSelection = runtimeSelectionSchema.optional().catch({ status: 'unknown' });
const runtimeSelectionsSchema = z.object(Object.fromEntries(pwaRuntimeEngines.map(engine =>
  [engine, optionalRuntimeSelection])) as Record<PWARuntimeEngine, typeof optionalRuntimeSelection>);

export const assetSelectionSchema = z.object({
  locales: z.array(localeSchema).min(1).max(UI_LOCALES.length),
  transformers: transformersVariantSchema.optional(),
  llama: z.array(chatProfileSchema).min(1).max(chatProfileSchema.options.length).optional(),
  runtimes: runtimeSelectionsSchema.optional(),
});
export type AssetSelection = z.infer<typeof assetSelectionSchema>;

export type DeferredAssetGroup =
  | { kind: 'locale'; locale: z.infer<typeof localeSchema> }
  | { kind: 'runtime'; engine: PWARuntimeEngine; profile: string }
  | { kind: 'manual' };

export function readRuntimeSelection({ selection, engine }: {
  selection: AssetSelection;
  engine: PWARuntimeEngine;
}): RuntimeSelection {
  const current = selection.runtimes?.[engine];
  if (current !== undefined) {
    return current;
  }
  // The previous Worker and page can coexist during an update.
  if (engine === 'transformers-js' && selection.transformers !== undefined) {
    return { status: 'known', profiles: [selection.transformers] };
  }
  if (engine === 'llama-cpp-browser' && selection.llama !== undefined) {
    return { status: 'known', profiles: selection.llama };
  }
  return { status: 'unknown' };
}

export type DeferredAssetMetadata = {
  group: DeferredAssetGroup;
  integrity: string;
};

export const prepareOfflineAssetsRequestSchema = z.object({
  type: z.literal(PREPARE_OFFLINE_ASSETS),
  buildId: z.string().min(1),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('remaining') }),
    z.object({ kind: z.literal('selection'), selection: assetSelectionSchema }),
  ]),
});
export type PrepareOfflineAssetsRequest = z.infer<typeof prepareOfflineAssetsRequestSchema>;

export const prepareOfflineAssetsReplySchema = z.union([
  z.enum(['complete', 'failed', 'unavailable']),
  z.object({ remaining: z.number().int().nonnegative() }),
]);
export type PrepareOfflineAssetsReply = z.infer<typeof prepareOfflineAssetsReplySchema>;

export const TEST_ONLY = {
};
