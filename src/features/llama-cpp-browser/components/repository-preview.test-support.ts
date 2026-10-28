import { computed, ref, type Ref } from 'vue';
import { vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import type { HostModelDirectoryChoice } from '@/composables/useHostModelDirectories';
import type { useSettings } from '@/composables/useSettings';
import type { RepositoryCatalog } from '@/features/llama-cpp-browser/hugging-face/catalog';
import { parseRepository } from '@/features/llama-cpp-browser/hugging-face/repository-input';
import { TEST_ONLY as destinationTest } from '@/features/llama-cpp-browser/composables/useModelDownloadDestination';

const previewTest = vi.hoisted(() => ({
  inspect: vi.fn(),
  installed: vi.fn(),
  permission: vi.fn(),
  add: vi.fn(),
  reconnect: vi.fn(),
  rootRead: vi.fn(),
  settings: undefined as Ref<Settings> | undefined,
  entries: undefined as Ref<HostModelDirectoryChoice[]> | undefined,
  busy: undefined as Ref<boolean> | undefined,
  root: undefined as FileSystemDirectoryHandle | undefined,
}));
export { previewTest };
vi.mock('@/composables/useSettings', () => ({
  useSettings: () => ({
    settings: previewTest.settings,
    captureExperimentalStorage: () => () => true,
    updateExperimentalForStorage: async ({ isCurrent, updater }: { isCurrent: Parameters<ReturnType<typeof useSettings>['updateExperimentalForStorage']>[0]['isCurrent'], updater: Parameters<ReturnType<typeof useSettings>['updateExperimentalForStorage']>[0]['updater'] }) => {
      if (!isCurrent()) {
        return 'changed';
      }
      const settings = previewTest.settings!;
      settings.value = { ...settings.value, experimental: updater({ experimental: settings.value.experimental }) };
      return 'saved';
    },
  }),
}));
vi.mock('@/composables/useHostModelDirectories', () => ({
  useHostModelDirectories: () => ({
    registrations: () => previewTest.entries!.value,
    refresh: async () => {},
    currentHandle: () => previewTest.root,
    hostDownloadDestination: previewTest.permission,
    view: {
      supported: computed(() => true),
      entries: computed(() => previewTest.entries!.value),
      busy: previewTest.busy,
      destination: ref('opfs'),
      add: previewTest.add,
      reconnect: previewTest.reconnect,
      remove: vi.fn(),
      selectDestination: vi.fn(),
    },
  }),
}));
vi.mock('@/features/llama-cpp-browser/runtime/model-destination', async () => ({
  ...await import('@/features/llama-cpp-browser/runtime/model-destination-types'),
  hostModelRoot: previewTest.rootRead,
}));
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: previewTest.inspect }) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: previewTest.installed }));

export function repositoryCatalog({ repository }: { repository: string }): RepositoryCatalog {
  return { repository, revision: 'a'.repeat(40), projectors: [], models: ['Q8_0', 'Q4_K_M'].map(quantization => ({ label: quantization, files: [{ path: `Model-${quantization}.gguf`, size: quantization === 'Q8_0' ? 512 : 256 }], size: quantization === 'Q8_0' ? 512 : 256 })) };
}

export function resetRepositoryPreviewTest(): void {
  destinationTest.reset();
  previewTest.settings = ref({ ...structuredClone(DEFAULT_SETTINGS), storageType: 'memory', endpoint: { type: 'openai', url: '' } });
  previewTest.entries = ref([{ id: 'root-a', name: 'Models A', access: 'readwrite', error: undefined }, { id: 'root-b', name: 'Models B', access: 'readwrite', error: undefined }]);
  previewTest.busy = ref(false);
  previewTest.root = { kind: 'directory', name: 'Models', isSameEntry: async () => true } as unknown as FileSystemDirectoryHandle;
  previewTest.inspect.mockReset().mockImplementation(async ({ input }: { input: string }) => repositoryCatalog({ repository: parseRepository({ input }).repository }));
  previewTest.installed.mockReset().mockResolvedValue(undefined);
  previewTest.permission.mockReset().mockImplementation(async ({ id }: { id: string }) => ({ kind: 'host', directoryId: id }));
  previewTest.rootRead.mockReset().mockImplementation(async () => previewTest.root);
  previewTest.add.mockClear();
  previewTest.reconnect.mockClear();
}
