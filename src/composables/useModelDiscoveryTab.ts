import { computed, hasInjectionContext, inject, provide, ref, shallowRef, type InjectionKey, type Ref } from 'vue';
import type { Settings } from '@/01-models/types';
import type { ModelDiscoveryTab } from '@/components/browser-model-presentation';

type SavedModelDiscoveryTab = NonNullable<NonNullable<Settings['experimental']>['modelDiscoveryTab']>;

function restoredTab({ tab }: { tab: SavedModelDiscoveryTab | undefined }): ModelDiscoveryTab {
  switch (tab) {
  case undefined: case 'candidates': return 'candidates';
  case 'hugging_face': return 'hugging-face';
  case 'local_files': return 'local-files';
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
}

function savedTab({ tab }: { tab: ModelDiscoveryTab }): SavedModelDiscoveryTab {
  switch (tab) {
  case 'candidates': return 'candidates';
  case 'hugging-face': return 'hugging_face';
  case 'local-files': return 'local_files';
  default: {
    const exhaustive: never = tab;
    throw new Error(String(exhaustive));
  }
  }
}

type ModelDiscoverySettingsSource = {
  settings: Readonly<Ref<Settings>>,
  captureExperimentalStorage(): () => boolean,
  updateExperimentalForStorage({ isCurrent, updater }: {
    isCurrent(): boolean,
    updater: ({ experimental }: { experimental: Settings['experimental'] }) => Settings['experimental'],
  }): Promise<'saved' | 'changed'>,
};

const pending = shallowRef<{ tab: ModelDiscoveryTab, isCurrent(): boolean }>();
let saveTail = Promise.resolve();

/** Remember discovery navigation independently from chat input and model settings. */
function createPreference({ source: settings }: { source: ModelDiscoverySettingsSource }) {
  const remembered = computed(() => {
    const stored = restoredTab({ tab: settings.settings.value.experimental?.modelDiscoveryTab });
    return pending.value?.isCurrent() ? pending.value.tab : stored;
  });

  async function remember({ tab }: { tab: ModelDiscoveryTab }): Promise<void> {
    const selection = { tab, isCurrent: settings.captureExperimentalStorage() };
    pending.value = selection;
    const save = saveTail.then(async () => {
      await settings.updateExperimentalForStorage({
        isCurrent: selection.isCurrent,
        updater: ({ experimental }) => ({ ...experimental, modelDiscoveryTab: savedTab({ tab }) }),
      });
    });
    saveTail = save.catch(() => {});
    void save.finally(() => {
      if (pending.value === selection) {
        pending.value = undefined;
      }
    }).catch(() => {});
    return save;
  }

  return { remembered, remember, ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) };
}

type ModelDiscoveryTabPreference = ReturnType<typeof createPreference>;
const preferenceKey: InjectionKey<ModelDiscoveryTabPreference> = Symbol('model-discovery-tab');

/** The late auxiliary UI owns settings; the discovery chunk stays runtime-free. */
export function provideModelDiscoveryTab({ source }: { source: ModelDiscoverySettingsSource }): void {
  provide(preferenceKey, createPreference({ source }));
}

export function useModelDiscoveryTab(): ModelDiscoveryTabPreference {
  const provided = hasInjectionContext() ? inject(preferenceKey, undefined) : undefined;
  if (provided !== undefined) {
    return provided;
  }
  // Isolated component hosts can navigate without an application settings owner.
  const selected = ref<ModelDiscoveryTab>('candidates');
  const remembered = computed(() => selected.value);
  return {
    remembered,
    remember: async ({ tab }: { tab: ModelDiscoveryTab }) => {
      selected.value = tab;
    },
    ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}),
  };
}

export const TEST_ONLY = {
  createPreference,
};
