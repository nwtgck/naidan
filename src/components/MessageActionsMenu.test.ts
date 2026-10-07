import { afterEach, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import MessageActionsMenu from './MessageActionsMenu.vue';
let wrapper: VueWrapper | undefined;
let trigger: HTMLButtonElement | undefined;
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined; trigger?.remove(); trigger = undefined;
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function open({ width, height, top, menuWidth }: { width: number, height: number, top: number, menuWidth: number | undefined }) {
  vi.stubGlobal('innerWidth', width); vi.stubGlobal('innerHeight', height);
  trigger = document.createElement('button'); document.body.appendChild(trigger);
  vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(new DOMRect(16, top, 32, 32));
  wrapper = mount(MessageActionsMenu, { props: { isOpen: true, triggerEl: trigger, width: menuWidth }, slots: { default: '<button>Action</button>' }, global: { stubs: { Teleport: true } } });
  await nextTick();
  return wrapper.get('div').element as HTMLDivElement;
}
it('keeps the normal shared width instead of globally widening every message menu', async () => {
  const menu = await open({ width: 1000, height: 800, top: 100, menuWidth: undefined });
  expect(menu.style.width).toBe('192px'); expect(menu.style.left).toBe('8px'); expect(menu.style.top).toBe('136px');
});
it('bounds width and downward height on a small viewport', async () => {
  const menu = await open({ width: 220, height: 360, top: 20, menuWidth: 240 });
  expect(menu.style.width).toBe('204px'); expect(menu.style.left).toBe('8px');
  expect(menu.style.top).toBe('56px'); expect(menu.style.maxHeight).toBe('296px');
});
it('keeps an open menu onscreen when its trigger has moved below the viewport', async () => {
  const menu = await open({ width: 220, height: 360, top: 650, menuWidth: 240 });
  expect(menu.style.bottom).toBe('8px'); expect(menu.style.maxHeight).toBe('344px');
});
it('keeps an open menu onscreen when its trigger has moved above the viewport', async () => {
  const menu = await open({ width: 220, height: 360, top: -100, menuWidth: 240 });
  expect(menu.style.top).toBe('8px'); expect(menu.style.maxHeight).toBe('344px');
});
it('recomputes its actual width and available height when the viewport shrinks', async () => {
  const menu = await open({ width: 1000, height: 800, top: 650, menuWidth: 240 });
  expect(menu.style.width).toBe('240px');
  vi.stubGlobal('innerWidth', 220); vi.stubGlobal('innerHeight', 360);
  window.dispatchEvent(new Event('resize')); await nextTick();
  expect(menu.style.width).toBe('204px'); expect(menu.style.bottom).toBe('8px'); expect(menu.style.maxHeight).toBe('344px');
});
