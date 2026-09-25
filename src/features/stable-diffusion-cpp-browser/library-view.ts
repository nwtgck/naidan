import type { CatalogDownloadProgress } from './logic/catalog-download';
import type { ImageRecipeSelection } from './model-recipes';
import type { ComputedRef, Ref, ShallowRef } from 'vue';
import type { ModelSlot, Request } from './types';

export type ImageModelChoice = {
  id: string; label: string; detail: string; evidence: string[];
  status: 'matching' | 'unverified' | 'incompatible'; issue: string | undefined;
};
export type ImageComponentChoice = {
  slot: ModelSlot; selected: string; required: boolean; choices: ImageModelChoice[];
};
export type ImageLibraryView = {
  models: ComputedRef<ImageModelChoice[]>;
  main: Ref<string>;
  components: ComputedRef<ImageComponentChoice[]>;
  scanState: Ref<'idle' | 'scanning'>;
  showAll: Ref<boolean>;
  importProgress: ShallowRef<{ completed: number, total: number } | undefined>;
  importing: ComputedRef<boolean>;
  downloading: ComputedRef<boolean>;
  downloadProgress: ShallowRef<CatalogDownloadProgress | undefined>;
  downloadState: Ref<'idle' | 'downloading' | 'complete' | 'cancelled' | 'failed'>;
  downloadRecipeId: Ref<string>;
  downloadRecipe({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): Promise<void>;
  chooseRecipe({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): void;
  cancelDownload(): void;
  failure: Ref<string>;
  issues: ComputedRef<string[]>;
  ready: ComputedRef<boolean>;
  refresh(): Promise<void>;
  chooseMain({ id }: { id: string }): void;
  chooseComponent({ slot, id }: { slot: ModelSlot, id: string }): void;
  importDirectory({ event }: { event: Event }): Promise<void>;
  dropDirectory({ event }: { event: DragEvent }): Promise<void>;
  cancelImport(): void;
  useManualFiles(): void;
  selectedModels(): Request['models'] | undefined;
};
export const TEST_ONLY = {
};
