import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import ChatAttachMenu from './ChatAttachMenu.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

const bounds = { top: ref(400), bottom: ref(436), left: ref(280), width: ref(36) };
const windowSize = { width: ref(360), height: ref(640) };
vi.mock('@vueuse/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@vueuse/core')>()),
  useElementBounding: () => bounds,
  useWindowSize: () => windowSize,
}));
enableAutoUnmount(afterEach);

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  bounds.top.value = 400;
  bounds.bottom.value = 436;
  windowSize.width.value = 360;
  windowSize.height.value = 640;
});

afterEach(() => vi.unstubAllGlobals());

describe('ChatAttachMenu', () => {
  it('keeps the menu and its information panels inside a narrow viewport', async () => {
    const wrapper = mount(ChatAttachMenu, { props: { hasFileSystemAccess: false, surface: 'composer' }, attachTo: document.body });
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    const menu = document.body.querySelector<HTMLElement>('[data-testid="attach-menu"]')!;
    expect(wrapper.element.contains(menu)).toBe(false);
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(16);
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(344);
    const information = menu.querySelector<HTMLButtonElement>('button[title]')!;
    information.click();
    await flushPromises();
    expect(menu.textContent).toContain('Chromium');
    expect(menu.style.maxHeight).not.toBe('');
  });

  it('clamps its height and width to the visual viewport when a software keyboard is open', async () => {
    const visible = Object.assign(new EventTarget(), { width: 300, height: 250, offsetLeft: 20, offsetTop: 80 });
    vi.stubGlobal('visualViewport', visible);
    bounds.top.value = 240;
    bounds.bottom.value = 276;
    const wrapper = mount(ChatAttachMenu, { props: { hasFileSystemAccess: true }, attachTo: document.body });
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    const menu = document.body.querySelector<HTMLElement>('[data-testid="attach-menu"]')!;
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(304);
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(136);
    visible.height = 180;
    visible.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(136);
  });

  it('preserves file input behavior and closes after choosing files', async () => {
    const wrapper = mount(ChatAttachMenu, { props: { hasFileSystemAccess: true }, attachTo: document.body });
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    document.body.querySelector<HTMLButtonElement>('[data-testid="attach-files-button"]')!.click();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="attach-menu"]')).toBeNull();
    const file = new File(['image'], 'picture.png', { type: 'image/png' });
    const input = wrapper.get<HTMLInputElement>('[data-testid="attach-file-input"]');
    Object.defineProperty(input.element, 'files', { value: [file] });
    await input.trigger('change');
    expect(wrapper.emitted('files-selected')).toEqual([[[file]]]);
  });

  it('emits the existing folder link action without hiding unavailable actions', async () => {
    const wrapper = mount(ChatAttachMenu, { props: { hasFileSystemAccess: true }, attachTo: document.body });
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    document.body.querySelector<HTMLButtonElement>('[data-testid="attach-folder-link-button"]')!.click();
    await flushPromises();
    expect(wrapper.emitted('folder-link')).toEqual([[]]);
    await wrapper.setProps({ hasFileSystemAccess: false });
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    expect(document.body.querySelector('[data-testid="attach-menu"] button:disabled')).toBeTruthy();
  });

  it('keeps teleported interactions open and returns focus on Escape', async () => {
    const wrapper = mount(ChatAttachMenu, { props: { hasFileSystemAccess: true }, attachTo: document.body });
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="attach-button"]');
    await trigger.trigger('click');
    const fileButton = document.body.querySelector<HTMLButtonElement>('[data-testid="attach-files-button"]')!;
    fileButton.focus();
    await flushPromises();
    expect(document.body.querySelector('[data-testid="attach-menu"]')).toBeTruthy();
    fileButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[data-testid="attach-menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger.element);
    expect(wrapper.emitted('update:open')).toEqual([[true], [false]]);
  });

  it('closes on outside focus and removes a teleported menu on unmount', async () => {
    const wrapper = mount(ChatAttachMenu, { props: { hasFileSystemAccess: true }, attachTo: document.body });
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector('[data-testid="attach-menu"]')).toBeNull();
    await wrapper.get('[data-testid="attach-button"]').trigger('click');
    wrapper.unmount();
    expect(document.body.querySelector('[data-testid="attach-menu"]')).toBeNull();
  });
});
