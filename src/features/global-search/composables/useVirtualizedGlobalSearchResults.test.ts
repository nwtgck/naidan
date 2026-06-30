import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { useVirtualizedGlobalSearchResults } from './useVirtualizedGlobalSearchResults';
import type { FlatSearchResultItem } from '@/features/global-search/types';

function createResults({ count }: { count: number }): FlatSearchResultItem[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'chat' as const,
    item: {
      type: 'chat' as const,
      chatId: `chat-${index}`,
      title: `Chat ${index}`,
      updatedAt: index,
      matchType: 'title' as const,
      titleMatch: true,
      contentMatches: [],
    },
  }));
}

function setClientHeight({ element, height }: {
  element: HTMLElement,
  height: number,
}): void {
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: height,
  });
}

describe('useVirtualizedGlobalSearchResults', () => {
  it('renders only the visible range with overscan', async () => {
    let state: ReturnType<typeof useVirtualizedGlobalSearchResults> | undefined;
    const results = ref(createResults({ count: 500 }));

    const wrapper = mount(defineComponent({
      setup() {
        const containerRef = ref<HTMLElement | null>(null);
        state = useVirtualizedGlobalSearchResults({
          containerRef,
          results,
          overscan: 4,
        });
        return { containerRef };
      },
      render() {
        return h('div', { ref: 'containerRef' });
      },
    }), { attachTo: document.body });

    const container = wrapper.element as HTMLElement;
    setClientHeight({ element: container, height: 360 });
    container.dispatchEvent(new Event('scroll'));
    await nextTick();

    expect(state).toBeDefined();
    expect(state!.TEST_ONLY.virtualizationEnabled.value).toBe(true);
    expect(state!.visibleResults.value.length).toBeLessThan(20);
    expect(state!.visibleResults.value[0]?.index).toBe(0);

    wrapper.unmount();
  });

  it('scrolls an off-screen result into view from its layout position', async () => {
    let state: ReturnType<typeof useVirtualizedGlobalSearchResults> | undefined;

    const wrapper = mount(defineComponent({
      setup() {
        const containerRef = ref<HTMLElement | null>(null);
        state = useVirtualizedGlobalSearchResults({
          containerRef,
          results: ref(createResults({ count: 500 })),
          overscan: 4,
        });
        return { containerRef };
      },
      render() {
        return h('div', { ref: 'containerRef' });
      },
    }), { attachTo: document.body });

    const container = wrapper.element as HTMLElement;
    setClientHeight({ element: container, height: 360 });
    container.dispatchEvent(new Event('scroll'));
    await nextTick();

    state!.scrollResultIntoView({ index: 499 });
    await nextTick();

    expect(container.scrollTop).toBeGreaterThan(0);
    expect(state!.visibleResults.value.some(result => result.index === 499)).toBe(true);

    wrapper.unmount();
  });
});
