import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import LlamaCppBrowserModelImport from './LlamaCppBrowserModelImport.vue';
import LinkedModelDirectories from '@/components/LinkedModelDirectories.vue';
import type { HostModelDirectoriesView } from '@/composables/useHostModelDirectories';

const mocks = vi.hoisted(() => ({ supported: false, add: vi.fn(async () => {}), drop: vi.fn(async () => {}), importModel: vi.fn(async () => {}), importDirectory: vi.fn(async () => {}) }));
vi.mock('@/features/llama-cpp-browser', () => ({ llamaCppBrowserService: { importModel: mocks.importModel, importDirectory: mocks.importDirectory } }));
vi.mock('@/features/llama-cpp-browser/composables/useModelDownloadDestination', () => ({
  useModelDownloadDestination: () => ({ view: view(), failure: ref(false) }),
  hostModelDirectoryLabel: ({ name }: { name: string }) => name,
}));

function view(): HostModelDirectoriesView {
  return { supported: computed(() => mocks.supported), busy: ref(false), destination: ref('opfs'), entries: computed(() => []), add: mocks.add, addDroppedDirectory: mocks.drop, reconnect: vi.fn(async () => {}), remove: vi.fn(async () => {}), selectDestination: vi.fn() };
}

const wrappers: VueWrapper[] = [];

function render(): VueWrapper {
  const wrapper = mount(LlamaCppBrowserModelImport, { props: { disabled: false }, global: { stubs: { LlamaCppBrowserLoadingIndicator: true } } });
  wrappers.push(wrapper);
  return wrapper;
}

function renderLinks(): VueWrapper {
  const wrapper = mount(LinkedModelDirectories, { props: { disabled: false, view: view() } });
  wrappers.push(wrapper);
  return wrapper;
}

function drop({ wrapper, transfer, target }: { wrapper: VueWrapper, transfer: object, target: string }): void {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  wrapper.get(`[data-testid="${target}"]`).element.dispatchEvent(event);
}

beforeEach(async () => {
  mocks.supported = false;
  vi.clearAllMocks();
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) {
    wrapper.unmount();
  }
});

describe('model import modes', () => {
  it('keeps a visible gap between the folder and file picker buttons', () => {
    const wrapper = render();
    const folder = wrapper.get('[data-testid="llama-cpp-browser-choose-directory"]').element;
    const files = wrapper.get('[data-testid="llama-cpp-browser-choose-files"]').element;
    expect(folder.parentElement).toBe(files.parentElement);
    expect(folder.parentElement?.classList).toContain('gap-3');
    expect(folder.parentElement?.classList).toContain('flex-wrap');
  });

  it('defaults to browser storage and keeps an unavailable link mode selectable and inspectable', async () => {
    const wrapper = render();
    const saved = wrapper.get('[data-testid="llama-import-mode-opfs"]');
    const linked = wrapper.get('[data-testid="llama-import-mode-host"]');
    expect(saved.attributes('aria-pressed')).toBe('true');
    expect(linked.text()).toContain('Unavailable');
    expect(linked.attributes('disabled')).toBeUndefined();
    expect(linked.attributes('aria-disabled')).toBeUndefined();
    expect(linked.classes()).toContain('opacity-50');
    await linked.trigger('click');
    expect(linked.attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('[data-testid="linked-host-folder-layout"]').text()).toContain('owner/');
    expect(wrapper.get('[data-testid="linked-host-folder-layout"]').text()).toContain('subdir/');
    expect(wrapper.get('[data-testid="linked-add-model-directory"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="llama-cpp-browser-directory"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="linked-host-folders-unavailable"]').text()).toContain('showDirectoryPicker');
    await wrapper.get('[data-testid="llama-import-mode-temp"]').trigger('click');
    expect(wrapper.find('[data-testid="linked-host-folder-layout"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="llama-import-mode-description"]').text()).toContain('reloaded or closed');
    expect(wrapper.find('[data-testid="llama-cpp-browser-file"]').exists()).toBe(true);
  });

  it('keeps mode explanations selectable when the parent disables file operations', async () => {
    const wrapper = render();
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    expect(wrapper.get<HTMLInputElement>('[data-testid="llama-cpp-browser-file"]').element.matches(':disabled')).toBe(true);
    const linked = wrapper.get<HTMLButtonElement>('[data-testid="llama-import-mode-host"]');
    expect(linked.element.matches(':disabled')).toBe(false);
    await linked.trigger('click');
    expect(wrapper.get('[data-testid="linked-host-folder-layout"]').text()).toContain('repository/');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="linked-add-model-directory"]').element.matches(':disabled')).toBe(true);
    await wrapper.get('[data-testid="llama-import-mode-temp"]').trigger('click');
    expect(wrapper.get('[data-testid="llama-import-mode-temp"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get<HTMLButtonElement>('[data-testid="llama-cpp-browser-choose-files"]').element.matches(':disabled')).toBe(true);
    drop({ wrapper, transfer: { types: ['Files'], files: [new File(['model'], 'model.gguf')], items: [] }, target: 'llama-cpp-browser-drop-zone' });
    await flushPromises();
    expect(mocks.importModel).not.toHaveBeenCalled();
  });

  it('routes default imports through existing browser storage and temporary imports through the explicit storage choice', async () => {
    const wrapper = render();
    const file = new File(['model'], 'model.gguf');
    const transfer = { types: ['Files'], items: [], files: [file] };
    drop({ wrapper, transfer, target: 'llama-cpp-browser-drop-zone' });
    await flushPromises();
    expect(mocks.importModel).toHaveBeenLastCalledWith({ file, signal: expect.any(AbortSignal) });
    await wrapper.get('[data-testid="llama-import-mode-temp"]').trigger('click');
    drop({ wrapper, transfer, target: 'llama-cpp-browser-drop-zone' });
    await flushPromises();
    expect(mocks.importModel).toHaveBeenLastCalledWith({ file, signal: expect.any(AbortSignal), storage: 'temp' });
    wrapper.unmount();
    const next = render();
    expect(next.get('[data-testid="llama-import-mode-opfs"]').attributes('aria-pressed')).toBe('true');
  });

  it('cancels a pending temporary directory traversal before registration', async () => {
    const wrapper = render();
    await wrapper.get('[data-testid="llama-import-mode-temp"]').trigger('click');
    const read = Promise.withResolvers<File>();
    const file = new File(['model'], 'model.gguf');
    const entry = {
      isFile: true,
      isDirectory: false,
      name: file.name,
      file: (resolve: FileCallback, reject: ErrorCallback) => {
        void read.promise.then(resolve, reject);
      },
    };
    drop({ wrapper, transfer: { types: ['Files'], items: [{ kind: 'file', webkitGetAsEntry: () => entry }], files: [file] }, target: 'llama-cpp-browser-drop-zone' });
    await flushPromises();
    await wrapper.get('[data-testid="llama-cpp-browser-cancel"]').trigger('click');
    read.resolve(file);
    await flushPromises();
    expect(mocks.importModel).not.toHaveBeenCalled();
    expect(mocks.importDirectory).not.toHaveBeenCalled();
  });
});

describe('durable linked-directory drops', () => {
  it('captures a directory handle during dispatch and delegates registration without copying files', async () => {
    mocks.supported = true;
    const wrapper = renderLinks();
    const directory = { kind: 'directory', name: 'Models' };
    const getAsFileSystemHandle = vi.fn(async () => directory);
    drop({ wrapper, transfer: { items: [{ kind: 'file', getAsFileSystemHandle }] }, target: 'linked-linked-folders-panel' });
    expect(getAsFileSystemHandle).toHaveBeenCalledOnce();
    await flushPromises();
    expect(mocks.drop).toHaveBeenCalledWith({ directory, signal: expect.any(AbortSignal) });
    expect(mocks.importModel).not.toHaveBeenCalled();
    expect(mocks.importDirectory).not.toHaveBeenCalled();
  });

  it('rejects standalone files without switching mode or falling back to another import', async () => {
    mocks.supported = true;
    const wrapper = renderLinks();
    drop({ wrapper, transfer: { items: [{ kind: 'file', getAsFileSystemHandle: async () => ({ kind: 'file', name: 'model.gguf' }) }] }, target: 'linked-linked-folders-panel' });
    await flushPromises();
    expect(wrapper.get('[data-testid="linked-link-drop-error"]').text()).toContain('not an individual file');
    expect(mocks.drop).not.toHaveBeenCalled();
    expect(mocks.importModel).not.toHaveBeenCalled();
  });

  it('directs legacy-only drops to the folder picker instead of pretending a File can be linked', async () => {
    mocks.supported = true;
    const wrapper = renderLinks();
    drop({ wrapper, transfer: { items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] }, target: 'linked-linked-folders-panel' });
    await flushPromises();
    expect(wrapper.get('[data-testid="linked-link-drop-error"]').text()).toContain('folder button');
    expect(mocks.drop).not.toHaveBeenCalled();
  });

  it('does not register a handle that arrives after the panel is unmounted', async () => {
    mocks.supported = true;
    const wrapper = renderLinks();
    const pending = Promise.withResolvers<object>();
    drop({ wrapper, transfer: { items: [{ kind: 'file', getAsFileSystemHandle: () => pending.promise }] }, target: 'linked-linked-folders-panel' });
    wrapper.unmount();
    pending.resolve({ kind: 'directory', name: 'Models' });
    await flushPromises();
    expect(mocks.drop).not.toHaveBeenCalled();
  });
});

it.each(['disabled', 'reconnectDisabled'] as const)('does not register a dropped handle when %s changes during handle acquisition', async prop => {
  mocks.supported = true;
  const wrapper = renderLinks();
  const handle = Promise.withResolvers<{ kind: 'directory', name: string }>();
  drop({ wrapper, transfer: { items: [{ kind: 'file', getAsFileSystemHandle: () => handle.promise }] }, target: 'linked-linked-folders-panel' });
  await wrapper.setProps({ [prop]: true });
  handle.resolve({ kind: 'directory', name: 'Models' });
  await flushPromises();
  expect(mocks.drop).not.toHaveBeenCalled();
});
