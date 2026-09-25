import { computed, ref, shallowRef } from 'vue';
import type { ImageLibraryView } from './library-view';

/** Display-only state. No file access, model inspection, Worker or native imports. */
export function createDisabledImageLibrary(): ImageLibraryView {
  return {
    models: computed(() => []), main: ref(''), components: computed(() => []),
    scanState: ref('idle'), showAll: ref(false), importProgress: shallowRef(),
    importing: computed(() => false), downloading: computed(() => false), downloadProgress: shallowRef(), downloadState: ref('idle'), downloadRecipeId: ref(''),
    async downloadRecipe() {}, chooseRecipe() {}, cancelDownload() {}, async resumeDownload() {}, resetDownloadIntent() {}, downloadSelections: shallowRef({}),
    recipeAvailability() {
      return { available: 0, total: 3, selected: false, bytes: 0 };
    }, failure: ref(''), issues: computed(() => []), ready: computed(() => false),
    async refresh() {}, chooseMain() {}, chooseComponent() {}, async importDirectory() {},
    async dropDirectory() {}, cancelImport() {}, useManualFiles() {}, selectedModels() {
      return undefined;
    },
  };
}
export const TEST_ONLY = {
};
