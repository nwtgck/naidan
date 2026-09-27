import { computed, ref, shallowRef } from 'vue';
import type { ImageLibraryView } from './library-view';
import { imageModelRecipes } from './model-recipes';

/** Display-only state. No file access, model inspection, Worker or native imports. */
export function createDisabledImageLibrary(): ImageLibraryView {
  return {
    hostDirectories: { supported: computed(() => false), entries: computed(() => []), busy: ref(false), destination: ref('opfs'),
      async add() {}, async reconnect() {}, async remove() {}, selectDestination() {} },
    benchmarkTargets: () => [], selectedFacts: computed(() => undefined), models: computed(() => []), savedLoras: computed(() => []), main: ref(''), components: computed(() => []),
    scanState: ref('idle'), scanProgress: shallowRef(), cancelScan() {}, showAll: ref(false), importProgress: shallowRef(),
    importing: computed(() => false), downloading: computed(() => false), downloadProgress: shallowRef(), downloadState: ref('idle'), downloadRecipeId: computed(() => ''), downloadLoraId: computed(() => ''),
    async downloadRecipe() {}, chooseRecipe() {}, async downloadLora() {}, loraAvailable: () => false, cancelDownload() {}, async resumeDownload() {}, resetDownloadIntent() {}, downloadSelections: computed(() => ({})),
    recipeAvailability({ recipeId }) {
      return { available: 0, total: imageModelRecipes.find(recipe => recipe.id === recipeId)?.components.length ?? 0, selected: false, bytes: 0 };
    }, failure: ref(''), issues: computed(() => []), ready: computed(() => false),
    async refresh() {}, chooseMain() {}, chooseComponent() {}, async importDirectory() {},
    async dropDirectory() {}, cancelImport() {}, useManualFiles() {}, selectedModels() {
      return undefined;
    },
  };
}
export const TEST_ONLY = {
};
