import type { ImageModelRecipe } from './model-recipes';
import type { ImageFileIdentity } from './logic/catalog-source';

/** Optional acquisitions, independent of a base recipe's required components.
 * These entries never select adapters or change generation parameters. */
export type ImageCatalogLora = {
  id: string; recipeId: ImageModelRecipe['id']; title: string;
  usage: 'style-reference'; source: ImageFileIdentity;
};
export const imageCatalogLoras: readonly ImageCatalogLora[] = [{
  id: 'krea2-style-reference', recipeId: 'krea2-turbo', title: 'Krea2 Style Reference', usage: 'style-reference',
  source: {
    repository: 'ostris/krea2_turbo_style_reference', revision: '4a268dbb75d196182b200e9e1ce89cde314f7b65',
    path: 'krea2_style_reference.safetensors', size: 457111760,
    sha256: 'f50df5a9e62e4be8aa926a63dd5bb1a64770c4004f763c1208007ae13daa82b8',
  },
}];

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
