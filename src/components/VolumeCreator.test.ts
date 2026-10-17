import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { toVolumeId } from '@/01-models/ids';
import type { Volume } from '@/01-models/types';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import VolumeCreator from './VolumeCreator.vue';

const mocks = vi.hoisted(() => ({
  checkOPFSSupport: vi.fn(),
  checkFileSystemAccessSupport: vi.fn(),
  createVolume: vi.fn(),
  createVolumeFromFiles: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { createVolume: mocks.createVolume, createVolumeFromFiles: mocks.createVolumeFromFiles } }));
vi.mock('@/utils/opfs-detection', () => ({ checkOPFSSupport: mocks.checkOPFSSupport, checkFileSystemAccessSupport: mocks.checkFileSystemAccessSupport }));
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ addToast: mocks.addToast }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createdVolume({ type }: { type: Volume['type'] }): Volume {
  return { id: toVolumeId({ raw: 'new-volume' }), name: 'My Docs', type, createdAt: 0 };
}

function mountCreator({ operationContext }: { operationContext: string | undefined }) {
  const wrapper = mount(VolumeCreator, { attachTo: document.body, props: { operationContext, existingMountPaths: ['/home/user/my-docs'], mountPathPrefix: '/home/user/' } });
  return {
    wrapper,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

function pickedFile({ directory }: { directory: boolean }) {
  const file = new File(['readme'], 'readme.md', { type: 'text/plain' });
  Object.defineProperty(file, 'webkitRelativePath', { value: directory ? 'My Docs/readme.md' : '' });
  return file;
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.checkOPFSSupport.mockResolvedValue(true);
  mocks.checkFileSystemAccessSupport.mockReturnValue(true);
  mocks.createVolume.mockResolvedValue(createdVolume({ type: 'host' }));
  mocks.createVolumeFromFiles.mockResolvedValue(createdVolume({ type: 'opfs' }));
  vi.stubGlobal('showDirectoryPicker', undefined);
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('VolumeCreator operation contexts', () => {
  it('keeps the starting owner and suggested path while a native picker is pending', async () => {
    const picker = deferred<FileSystemDirectoryHandle>();
    const showDirectoryPicker = vi.fn(() => picker.promise);
    vi.stubGlobal('showDirectoryPicker', showDirectoryPicker);
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-readwrite-btn"]')!.click();
    await flushPromises();
    expect(showDirectoryPicker).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(view.wrapper.get('[data-testid="copy-folder-btn"]').attributes('disabled')).toBeDefined();
    await view.wrapper.setProps({ operationContext: 'chat_group:b', existingMountPaths: [], mountPathPrefix: '/new/' });
    expect(view.wrapper.find('[data-testid="copy-progress"]').exists()).toBe(false);
    picker.resolve({ name: 'My Docs' } as FileSystemDirectoryHandle);
    await flushPromises();
    expect(view.wrapper.emitted('created')).toEqual([[{ volumeId: toVolumeId({ raw: 'new-volume' }), mountPath: '/home/user/my-docs-2', readOnly: false, operationContext: 'chat:a' }]]);
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('operation-state')).toEqual([[{ operationContext: 'chat:a', pending: true }], [{ operationContext: 'chat:a', pending: false }]]);
  });

  it('retains live conflict checks for existing unscoped callers', async () => {
    const picker = deferred<FileSystemDirectoryHandle>();
    vi.stubGlobal('showDirectoryPicker', vi.fn(() => picker.promise));
    using view = mountCreator({ operationContext: undefined });
    await flushPromises();
    await view.wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    await view.wrapper.setProps({ existingMountPaths: ['/home/user/my-docs', '/home/user/my-docs-2'] });
    picker.resolve({ name: 'My Docs' } as FileSystemDirectoryHandle);
    await flushPromises();
    expect(view.wrapper.emitted('created')?.[0]?.[0]).toEqual({ volumeId: toVolumeId({ raw: 'new-volume' }), mountPath: '/home/user/my-docs-3', readOnly: true, operationContext: undefined });
    expect(mocks.addToast).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an earlier owner after input cancellation and a new single-file picker', async () => {
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    await flushPromises();
    await view.wrapper.get('[data-testid="copy-directory-input"]').trigger('cancel');
    await view.wrapper.setProps({ operationContext: 'chat_group:b', mountPathPrefix: '/next/' });
    await view.wrapper.get('[data-testid="copy-folder-info-btn"]').trigger('click');
    const pickerClick = vi.spyOn(view.wrapper.get<HTMLInputElement>('[data-testid="copy-file-input"]').element, 'click');
    document.querySelector<HTMLButtonElement>('[data-testid="copy-single-file-btn"]')!.click();
    expect(pickerClick).toHaveBeenCalledTimes(1);
    await view.wrapper.setProps({ operationContext: 'chat:c', mountPathPrefix: '/third/' });
    const input = view.wrapper.get<HTMLInputElement>('[data-testid="copy-file-input"]');
    Object.defineProperty(input.element, 'files', { value: [pickedFile({ directory: false })], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(mocks.createVolumeFromFiles).toHaveBeenCalledWith(expect.objectContaining({ name: 'readme.md', entries: [{ file: expect.any(File), relativePath: 'readme.md' }], signal: expect.any(AbortSignal) }));
    expect(view.wrapper.emitted('created')?.[0]?.[0]).toEqual({ volumeId: toVolumeId({ raw: 'new-volume' }), mountPath: '/next/readme-md', readOnly: true, operationContext: 'chat_group:b' });
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('passes cancellation to fallback copying and never emits a mount before success', async () => {
    const copy = deferred<Volume>();
    let signal: AbortSignal | undefined;
    mocks.createVolumeFromFiles.mockImplementation(({ signal: copySignal, onProgress }: { signal: AbortSignal, onProgress: ({ processed, total }: { processed: number, total: number }) => void }) => {
      signal = copySignal;
      onProgress({ processed: 1, total: 2 });
      copySignal.addEventListener('abort', () => {
        copy.reject(new DOMException('Cancelled', 'AbortError'));
      }, { once: true });
      return copy.promise;
    });
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    await flushPromises();
    const input = view.wrapper.get<HTMLInputElement>('[data-testid="copy-directory-input"]');
    Object.defineProperty(input.element, 'files', { value: [pickedFile({ directory: true })], configurable: true });
    await input.trigger('change');
    await flushPromises();
    const progressbar = view.wrapper.get('[data-testid="copy-progressbar"]');
    const actions = view.wrapper.get('[data-testid="volume-creator-actions"]').element;
    expect(actions.compareDocumentPosition(view.wrapper.get('[data-testid="copy-progress"]').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(progressbar.attributes('role')).toBe('progressbar');
    expect(progressbar.attributes('aria-valuenow')).toBe('50');
    expect(progressbar.attributes('aria-valuetext')).toBe('1 / 2 files');
    expect(view.wrapper.get(`[id="${progressbar.attributes('aria-labelledby')}"]`).text()).toContain('Copying folder to browser');
    expect(view.wrapper.get('[data-testid="copy-progress-count"]').text()).toBe('1 / 2 files');
    expect(view.wrapper.emitted('created')).toBeUndefined();
    await view.wrapper.get('[data-testid="copy-cancel-btn"]').trigger('click');
    await flushPromises();
    expect(signal?.aborted).toBe(true);
    expect(view.wrapper.find('[data-testid="copy-progress"]').exists()).toBe(false);
    expect(view.wrapper.emitted('created')).toBeUndefined();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('does not offer a nonfunctional cancel button during native copying', async () => {
    const copy = deferred<Volume>();
    mocks.createVolume.mockReturnValue(copy.promise);
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'My Docs' }));
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="copy-progress"]').text()).toContain('Copying folder to browser');
    expect(view.wrapper.get('[data-testid="copy-progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(view.wrapper.get<HTMLElement>('[data-testid="copy-progress-fill"]').element.style.width).toBe('');
    expect(view.wrapper.find('[data-testid="copy-progress-count"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="copy-cancel-btn"]').exists()).toBe(false);
    expect(view.wrapper.get('[data-testid="copy-folder-btn"]').attributes('disabled')).toBeDefined();
    copy.resolve(createdVolume({ type: 'opfs' }));
    await flushPromises();
    expect(view.wrapper.emitted('created')).toHaveLength(1);
  });

  it('keeps unknown totals indeterminate and only displays finite bounded progress', async () => {
    const copy = deferred<Volume>();
    let updateProgress: (({ processed, total }: { processed: number, total: number }) => void) | undefined;
    mocks.createVolumeFromFiles.mockImplementation(({ onProgress }: { onProgress: ({ processed, total }: { processed: number, total: number }) => void }) => {
      updateProgress = onProgress;
      return copy.promise;
    });
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    await flushPromises();
    const input = view.wrapper.get<HTMLInputElement>('[data-testid="copy-directory-input"]');
    Object.defineProperty(input.element, 'files', { value: [pickedFile({ directory: true })], configurable: true });
    await input.trigger('change');
    await flushPromises();
    expect(view.wrapper.get('[data-testid="copy-progressbar"]').attributes('aria-valuenow')).toBeUndefined();
    expect(view.wrapper.get<HTMLElement>('[data-testid="copy-progress-fill"]').element.style.width).toBe('');
    expect(view.wrapper.find('[data-testid="copy-progress-count"]').exists()).toBe(false);
    expect(view.wrapper.find('[data-testid="copy-cancel-btn"]').exists()).toBe(true);
    if (!updateProgress) {
      throw new Error('Expected the copy progress callback');
    }

    for (const { processed, total, percentage, count } of [
      { processed: 1, total: 2, percentage: 50, count: '1 / 2 files' },
      { processed: -1, total: 2, percentage: 0, count: '0 / 2 files' },
      { processed: 3, total: 2, percentage: 100, count: '2 / 2 files' },
      { processed: 0, total: 0, percentage: undefined, count: undefined },
      { processed: 1, total: -1, percentage: undefined, count: undefined },
      { processed: 1, total: Number.POSITIVE_INFINITY, percentage: undefined, count: undefined },
      { processed: Number.NaN, total: 2, percentage: undefined, count: undefined },
      { processed: Number.POSITIVE_INFINITY, total: 2, percentage: undefined, count: undefined },
      { processed: 2, total: 2, percentage: 100, count: '2 / 2 files' },
    ]) {
      updateProgress({ processed, total });
      await view.wrapper.vm.$nextTick();
      const progressbar = view.wrapper.get('[data-testid="copy-progressbar"]');
      expect(progressbar.attributes('aria-valuenow')).toBe(percentage === undefined ? undefined : String(percentage));
      expect(progressbar.attributes('aria-valuetext')).toBe(count);
      expect(view.wrapper.get<HTMLElement>('[data-testid="copy-progress-fill"]').element.style.width).toBe(percentage === undefined ? '' : `${percentage}%`);
      const visibleCount = view.wrapper.find('[data-testid="copy-progress-count"]');
      expect(visibleCount.exists()).toBe(count !== undefined);
      if (count !== undefined) {
        expect(visibleCount.text()).toBe(count);
      }
      expect(view.wrapper.get('[data-testid="copy-progress"]').text()).not.toMatch(/NaN|Infinity/);
      expect(view.wrapper.emitted('created')).toBeUndefined();
    }

    copy.resolve(createdVolume({ type: 'opfs' }));
    await flushPromises();
    expect(view.wrapper.find('[data-testid="copy-progress"]').exists()).toBe(false);
    expect(view.wrapper.emitted('created')).toHaveLength(1);
  });

  it('treats a dismissed native picker as cancellation', async () => {
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockRejectedValue(new DOMException('Dismissed', 'AbortError')));
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    await flushPromises();
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(view.wrapper.emitted('created')).toBeUndefined();
    expect(mocks.addToast).not.toHaveBeenCalled();
    expect(view.wrapper.get('[data-testid="add-folder-btn"]').attributes('disabled')).toBeUndefined();
  });

  it('opens an anchored access menu with keyboard dismissal and returns focus to the trigger', async () => {
    const picker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', picker);
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    const trigger = view.wrapper.get('[data-testid="add-folder-btn"]');
    await trigger.trigger('keydown', { key: 'ArrowUp' });
    await flushPromises();
    const menu = document.querySelector<HTMLElement>('[data-testid="add-folder-mode-panel"]')!;
    expect(document.body.contains(menu)).toBe(true);
    expect(view.wrapper.element.contains(menu)).toBe(false);
    expect(menu.style.position).toBe('fixed');
    expect(trigger.attributes('aria-expanded')).toBe('true');
    expect(menu.id).toBe(trigger.attributes('aria-controls'));
    const readOnly = menu.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!;
    const readWrite = menu.querySelector<HTMLButtonElement>('[data-testid="add-folder-readwrite-btn"]')!;
    expect(document.activeElement).toBe(readOnly);
    readOnly.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(readWrite);
    readWrite.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    readOnly.click();
    expect(picker).not.toHaveBeenCalled();

    await trigger.trigger('click');
    await flushPromises();
    document.querySelector('[data-testid="add-folder-read-only-btn"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
  });

  it('ignores clicks inside the teleported menu and closes it on outside interaction and owner changes', async () => {
    const picker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', picker);
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    const trigger = view.wrapper.get('[data-testid="add-folder-btn"]');
    await trigger.trigger('click');
    await flushPromises();
    const menu = document.querySelector<HTMLElement>('[data-testid="add-folder-mode-panel"]')!;
    menu.querySelector('p')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    menu.querySelector('p')!.click();
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('true');
    const staleChoice = menu.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!;
    await view.wrapper.setProps({ operationContext: 'chat:b' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    staleChoice.click();
    expect(picker).not.toHaveBeenCalled();
    await trigger.trigger('click');
    await flushPromises();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    document.body.click();
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
  });

  it('makes a leaving access menu inert before its close animation completes', async () => {
    const picker = vi.fn();
    vi.stubGlobal('showDirectoryPicker', picker);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    const wrapper = mount(VolumeCreator, {
      attachTo: document.body,
      props: { operationContext: 'chat:a', existingMountPaths: [], mountPathPrefix: '/home/user/' },
      global: { stubs: { transition: false } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const trigger = wrapper.get('[data-testid="add-folder-btn"]');
    await trigger.trigger('click');
    await flushPromises();
    const menu = document.querySelector<HTMLElement>('[data-testid="add-folder-mode-panel"]')!;
    const choice = menu.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!;
    choice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();
    expect(menu.isConnected).toBe(true);
    expect(menu.hasAttribute('inert')).toBe(true);
    expect(menu.getAttribute('aria-hidden')).toBe('true');
    expect(menu.style.pointerEvents).toBe('none');
    expect(choice.disabled).toBe(true);
    choice.click();
    expect(picker).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger.element);
  });

  it.each(['add', 'copy'] as const)('keeps %s information above the trigger and closes on Escape, owner change and disclosure close', async kind => {
    mocks.checkFileSystemAccessSupport.mockReturnValue(kind !== 'add');
    vi.stubGlobal('innerHeight', 700);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 400, 220, 36));
    const disclosureOpen = ref(true);
    const returnFocus = document.createElement('button');
    document.body.append(returnFocus);
    const wrapper = mount(VolumeCreator, {
      attachTo: document.body,
      props: { operationContext: 'chat:a', existingMountPaths: [], mountPathPrefix: '/home/user/' },
      global: { provide: { 'settings-disclosure-open': disclosureOpen, 'settings-disclosure-focus-return': () => returnFocus } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        returnFocus.remove();
      },
    };
    await flushPromises();
    const trigger = wrapper.get(`[data-testid="${kind}-folder-info-btn"]`);
    const selector = `[data-testid="${kind}-folder-info-panel"]`;
    await trigger.trigger('click');
    await flushPromises();
    const panel = document.querySelector<HTMLElement>(selector)!;
    expect(wrapper.element.contains(panel)).toBe(false);
    expect(panel.style.position).toBe('fixed');
    expect(panel.getAttribute('data-placement')).toBe('top');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.textContent).toContain(kind === 'add' ? 'Chromium' : 'original folder');
    panel.querySelector('p')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    panel.querySelector('p')!.click();
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('true');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(trigger.attributes('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger('click');
    await flushPromises();
    await wrapper.setProps({ operationContext: 'chat:b' });
    expect(trigger.attributes('aria-expanded')).toBe('false');
    await trigger.trigger('click');
    await flushPromises();
    disclosureOpen.value = false;
    await flushPromises();
    expect(document.querySelector(selector)).toBeNull();
    expect(document.activeElement).toBe(returnFocus);
  });

  it.each(['add', 'copy'] as const)('makes leaving %s information noninteractive before animation completion', async kind => {
    mocks.checkFileSystemAccessSupport.mockReturnValue(kind !== 'add');
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    const wrapper = mount(VolumeCreator, {
      attachTo: document.body,
      props: { operationContext: 'chat:a', existingMountPaths: [], mountPathPrefix: '/home/user/' },
      global: { stubs: { transition: false } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    await flushPromises();
    const trigger = wrapper.get(`[data-testid="${kind}-folder-info-btn"]`);
    await trigger.trigger('click');
    await flushPromises();
    const panel = document.querySelector<HTMLElement>(`[data-testid="${kind}-folder-info-panel"]`)!;
    const pickerClick = vi.spyOn(wrapper.get<HTMLInputElement>('[data-testid="copy-file-input"]').element, 'click');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();
    expect(panel.isConnected).toBe(true);
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(panel.style.pointerEvents).toBe('none');
    const singleFile = panel.querySelector<HTMLButtonElement>('[data-testid="copy-single-file-btn"]');
    if (kind === 'copy') {
      expect(singleFile?.disabled).toBe(true);
      singleFile?.click();
    }
    expect(pickerClick).not.toHaveBeenCalled();
  });

  it('keeps unsupported copy information available without a single-file action', async () => {
    mocks.checkOPFSSupport.mockResolvedValue(false);
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    expect(view.wrapper.get('[data-testid="copy-folder-btn"]').attributes('disabled')).toBeDefined();
    await view.wrapper.get('[data-testid="copy-folder-info-btn"]').trigger('click');
    await flushPromises();
    const panel = document.querySelector<HTMLElement>('[data-testid="copy-folder-info-panel"]')!;
    expect(panel.textContent).toMatch(/not supported/i);
    expect(panel.querySelector('[data-testid="copy-single-file-btn"]')).toBeNull();
  });

  it('reports a current-owner copy failure and does not create a mount', async () => {
    mocks.createVolume.mockRejectedValue(new Error('Copy failed'));
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue({ name: 'My Docs' }));
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    await flushPromises();
    expect(view.wrapper.emitted('created')).toBeUndefined();
    expect(mocks.addToast).toHaveBeenCalledWith({ message: expect.stringContaining('Copy failed') });
  });

  it('suppresses native completion toasts after unmounting', async () => {
    const picker = deferred<FileSystemDirectoryHandle>();
    vi.stubGlobal('showDirectoryPicker', vi.fn(() => picker.promise));
    using view = mountCreator({ operationContext: 'chat:a' });
    await flushPromises();
    await view.wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    document.querySelector<HTMLButtonElement>('[data-testid="add-folder-read-only-btn"]')!.click();
    view.wrapper.unmount();
    picker.resolve({ name: 'My Docs' } as FileSystemDirectoryHandle);
    await flushPromises();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('keeps copying disabled while capabilities are being detected', async () => {
    const support = deferred<boolean>();
    mocks.checkOPFSSupport.mockReturnValue(support.promise);
    mocks.checkFileSystemAccessSupport.mockReturnValue(false);
    using view = mountCreator({ operationContext: 'chat:a' });
    expect(view.wrapper.get('[data-testid="copy-folder-btn"]').attributes('disabled')).toBeDefined();
    support.resolve(true);
    await flushPromises();
    expect(view.wrapper.get('[data-testid="copy-folder-btn"]').attributes('disabled')).toBeUndefined();
    expect(view.wrapper.find('[data-testid="add-folder-btn"]').exists()).toBe(false);
    expect(view.wrapper.text()).toContain('Add Folder');
  });

  it('closes disclosure popups while preserving a running fallback copy', async () => {
    const disclosureOpen = ref(true);
    const returnFocus = document.createElement('button');
    document.body.append(returnFocus);
    const copy = deferred<Volume>();
    let signal: AbortSignal | undefined;
    mocks.createVolumeFromFiles.mockImplementation(({ signal: copySignal }: { signal: AbortSignal }) => {
      signal = copySignal;
      return copy.promise;
    });
    vi.stubGlobal('showDirectoryPicker', vi.fn());
    const wrapper = mount(VolumeCreator, {
      attachTo: document.body,
      props: { operationContext: 'chat:a', existingMountPaths: [], mountPathPrefix: '/home/user/' },
      global: { provide: { 'settings-disclosure-open': disclosureOpen, 'settings-disclosure-focus-return': () => returnFocus } },
    });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
        returnFocus.remove();
      },
    };
    await flushPromises();
    await wrapper.get('[data-testid="add-folder-btn"]').trigger('click');
    expect(document.querySelector('[data-testid="add-folder-mode-panel"]') !== null).toBe(true);
    await flushPromises();
    expect(document.activeElement).toBe(document.querySelector('[data-testid="add-folder-read-only-btn"]'));
    disclosureOpen.value = false;
    await flushPromises();
    expect(document.querySelector('[data-testid="add-folder-mode-panel"]') !== null).toBe(false);
    expect(document.activeElement).toBe(returnFocus);
    disclosureOpen.value = true;
    vi.stubGlobal('showDirectoryPicker', undefined);
    await wrapper.get('[data-testid="copy-folder-btn"]').trigger('click');
    await flushPromises();
    const input = wrapper.get<HTMLInputElement>('[data-testid="copy-directory-input"]');
    Object.defineProperty(input.element, 'files', { value: [pickedFile({ directory: true })], configurable: true });
    await input.trigger('change');
    await flushPromises();
    disclosureOpen.value = false;
    await flushPromises();
    expect(signal?.aborted).toBe(false);
    copy.resolve(createdVolume({ type: 'opfs' }));
    await flushPromises();
    expect(wrapper.emitted('created')).toHaveLength(1);
  });
});
