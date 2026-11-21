import { z } from 'zod';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also consumed by the independently checked Service Worker.
import { UI_LOCALES } from '../../01-models/ui-locale';
// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Also consumed by the independently checked Service Worker.
import { chatProfileSchema, type ChatProfile } from '../../features/llama-cpp-browser/runtime/chat-profiles';

export const READ_ASSET_SELECTION = 'NAIDAN_PWA_READ_ASSET_SELECTION_V1';
export const ASSET_SELECTION_CHANGED = 'NAIDAN_PWA_ASSET_SELECTION_CHANGED_V1';
export const PREPARE_OFFLINE_ASSETS = 'NAIDAN_PWA_PREPARE_OFFLINE_ASSETS_V1';

const localeSchema = z.enum(UI_LOCALES);
const transformersVariantSchema = z.enum(['standard', 'asyncify']);

export const assetSelectionSchema = z.object({
  locales: z.array(localeSchema).min(1).max(UI_LOCALES.length),
  transformers: transformersVariantSchema.optional(),
  llama: z.array(chatProfileSchema).min(1).max(chatProfileSchema.options.length).optional(),
});
export type AssetSelection = z.infer<typeof assetSelectionSchema>;

export type DeferredAssetGroup =
  | { kind: 'locale'; locale: z.infer<typeof localeSchema> }
  | { kind: 'transformers'; variant: z.infer<typeof transformersVariantSchema> }
  | { kind: 'llama'; profile: ChatProfile }
  | { kind: 'standalone-package' };

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
