import type { ModelCandidate } from './logic/model-candidates';
import type { InspectionProgress } from './inventory-worker/types';
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
export type ImageRecipeAvailability = { available: number, total: number, selected: boolean, bytes: number };
export type HostModelDirectoryChoice = {
  id: string, name: string,
  access: 'readwrite' | 'read' | 'prompt' | 'missing' | 'error' | 'unsupported',
  error: string | undefined,
};
export type HostModelDirectoriesView = {
  supported: ComputedRef<boolean>, entries: ComputedRef<HostModelDirectoryChoice[]>, busy: Ref<boolean>,
  destination: Ref<string>,
  add(): Promise<void>,
  reconnect({ id }: { id: string }): Promise<void>,
  remove({ id }: { id: string }): Promise<void>,
  selectDestination({ id }: { id: string }): void,
};
/** Known primary model, with its explicitly resolved local component set. */
export type ImageBenchmarkTarget = {
  id: string; label: string; detail: string;
  facts: Pick<ModelCandidate, 'family' | 'variant' | 'evidence'>;
  composition: 'selected' | 'automatic'; models: Request['models'] | undefined;
  components: ImageComponentChoice[];
  missing: ModelSlot[]; issue: string | undefined;
};
export type ImageLibraryView = {
  hostDirectories: HostModelDirectoriesView;
  benchmarkTargets({ selections }: { selections: Readonly<Record<string, Partial<Record<ModelSlot, string>>>> }): ImageBenchmarkTarget[];
  selectedFacts: ComputedRef<Pick<ModelCandidate, 'family' | 'variant' | 'evidence'> | undefined>;
  models: ComputedRef<ImageModelChoice[]>;
  main: Ref<string>;
  components: ComputedRef<ImageComponentChoice[]>;
  scanState: Ref<'idle' | 'scanning'>;
  scanProgress: ShallowRef<InspectionProgress | undefined>;
  cancelScan(): void;
  showAll: Ref<boolean>;
  importProgress: ShallowRef<{ completed: number, total: number } | undefined>;
  importing: ComputedRef<boolean>;
  downloading: ComputedRef<boolean>;
  downloadProgress: ShallowRef<CatalogDownloadProgress | undefined>;
  downloadState: Ref<'idle' | 'downloading' | 'complete' | 'paused' | 'failed' | 'incomplete'>;
  downloadRecipeId: Ref<string>;
  downloadRecipe({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): Promise<void>;
  chooseRecipe({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): void;
  cancelDownload(): void;
  resumeDownload(): Promise<void>;
  resetDownloadIntent(): void;
  downloadSelections: ShallowRef<ImageRecipeSelection>;
  recipeAvailability({ recipeId, selections }: { recipeId: string, selections: ImageRecipeSelection }): ImageRecipeAvailability;
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
