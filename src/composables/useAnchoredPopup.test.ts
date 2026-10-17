import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import { useAnchoredPopup } from './useAnchoredPopup';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('useAnchoredPopup placement preferences', () => {
  it.each([
    { preference: undefined, top: 250, expected: 'bottom' },
    { preference: { direction: 'top' as const, minHeightPx: 224 }, top: 250, expected: 'top' },
    { preference: { direction: 'top' as const, minHeightPx: 224 }, top: 40, expected: 'bottom' },
    { preference: { direction: 'top' as const, minHeightPx: 224 }, top: 560, expected: 'top' },
    { preference: { direction: 'bottom' as const, minHeightPx: 224 }, top: 560, expected: 'top' },
  ])('places a popup at $expected for top=$top and preference=$preference', async ({ preference, top, expected }) => {
    vi.stubGlobal('innerWidth', 800);
    vi.stubGlobal('innerHeight', 700);
    vi.stubGlobal('visualViewport', undefined);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(740, top, 140, 36));
    const Host = defineComponent({
      setup() {
        const anchor = ref<HTMLElement | null>(null);
        const popup = useAnchoredPopup({ anchor, preferredWidth: { unit: 'rem', value: 18 }, maxWidthPx: 360, preferredPlacement: preference });
        return { anchor, placement: popup.placement, refresh: popup.refresh };
      },
      template: '<button ref="anchor">Open</button><div data-testid="popup" :data-placement="placement.direction" :style="placement.style" />',
    });
    const wrapper = mount(Host, { attachTo: document.body });
    using _cleanup = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    wrapper.vm.refresh();
    await nextTick();
    const popup = wrapper.get<HTMLElement>('[data-testid="popup"]');
    expect(popup.attributes('data-placement')).toBe(expected);
    expect(popup.element.style.position).toBe('fixed');
    const left = parseFloat(popup.element.style.left);
    const width = parseFloat(popup.element.style.width);
    expect(left).toBeGreaterThanOrEqual(16);
    expect(left + width).toBeLessThanOrEqual(784);
    const availableHeight = expected === 'top' ? top - 24 : 700 - top - 36 - 24;
    expect(parseFloat(popup.element.style.maxHeight)).toBe(availableHeight);
  });
});
