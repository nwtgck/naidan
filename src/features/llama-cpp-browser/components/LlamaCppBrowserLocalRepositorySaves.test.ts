import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { toLocalModelSourceId } from '@/01-models/ids';
import type { LocalRepositorySource } from '@/features/llama-cpp-browser/runtime/local-repository-store';
import type { LocalRepositorySaveState } from '@/features/llama-cpp-browser/model-files';
import LlamaCppBrowserLocalRepositorySaves from './LlamaCppBrowserLocalRepositorySaves.vue';

const jobs = vi.hoisted(() => ({ entries: [] as { source: LocalRepositorySource, state: LocalRepositorySaveState }[], listeners: new Set<() => void>(), save: vi.fn(), cancel: vi.fn() }));
vi.mock('../model-files', () => ({
  localRepositorySaveEntries: () => [...jobs.entries],
  subscribeLocalRepositorySaves: ({ listener }: { listener(): void }) => {
    jobs.listeners.add(listener);
    return () => {
      jobs.listeners.delete(listener);
    };
  },
  saveLocalRepository: jobs.save,
  cancelLocalRepositorySave: jobs.cancel,
}));

beforeEach(async () => {
  jobs.entries = [];
  jobs.listeners.clear();
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

it('shows shared copy progress, disables cancellation during finalization, and offers the same source on failure', async () => {
  const file = new File(['GGUF'], 'Model.gguf');
  const entry = { relativePath: 'Model.gguf', file, storageKind: 'temp' as const, registrationRevision: 1 };
  const source: LocalRepositorySource = {
    sourceId: toLocalModelSourceId({ raw: 'source' }),
    rootName: 'Repo',
    configurations: [{ selector: 'Model', directory: { files: [entry], primaryFile: entry, projectorFile: undefined } }],
    root: { rootPath: 'temp/Repo', rootName: 'Repo', sourceRootName: 'Repo', registrationRevision: 1, files: [{ relativePath: 'Model.gguf', file }] },
  };
  jobs.entries = [{ source, state: { phase: 'saving', progress: { phase: 'importing', completed: 7, total: 10 }, error: undefined } }];
  const wrapper = mount(LlamaCppBrowserLocalRepositorySaves, { props: { offeredVisibility: 'visible' } });
  using _wrapper = { [Symbol.dispose]: () => wrapper.unmount() };
  await wrapper.setProps({ offeredVisibility: 'hidden' });
  expect(wrapper.find('[role="progressbar"]').exists()).toBe(true);
  expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('70');
  await wrapper.get('[data-testid="temporary-model-cancel"]').trigger('click');
  expect(jobs.cancel).toHaveBeenCalledExactlyOnceWith({ source });
  jobs.entries[0]!.state = { phase: 'finalizing', progress: undefined, error: undefined };
  for (const listener of jobs.listeners) {
    listener();
  }
  await flushPromises();
  expect(wrapper.find('[data-testid="temporary-model-cancel"]').exists()).toBe(false);
  jobs.entries[0]!.state = { phase: 'failed', progress: undefined, error: 'storage-error' };
  for (const listener of jobs.listeners) {
    listener();
  }
  await flushPromises();
  await wrapper.get('[data-testid="temporary-model-retry"]').trigger('click');
  expect(jobs.save).toHaveBeenCalledExactlyOnceWith({ source });
  jobs.entries[0]!.state = { phase: 'offered', progress: undefined, error: undefined };
  for (const listener of jobs.listeners) {
    listener();
  }
  await flushPromises();
  expect(wrapper.find('[data-testid="local-repository-saves"]').exists()).toBe(false);
  await wrapper.setProps({ offeredVisibility: 'visible' });
  expect(wrapper.find('[data-testid="temporary-model-save"]').exists()).toBe(true);
  expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
  jobs.entries = [];
  for (const listener of jobs.listeners) {
    listener();
  }
  await flushPromises();
  expect(wrapper.find('[data-testid="local-repository-saves"]').exists()).toBe(false);
});
