import { defineComponent, h, nextTick, ref } from 'vue';
import type { Ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { LIST_ROW_HEIGHT, VIRTUAL_SCROLL_OVERSCAN } from '@/features/file-explorer/logic/constants';
import { useVirtualizedFileExplorerList } from './useVirtualizedFileExplorerList';
import type { FileExplorerEntry } from '@/features/file-explorer/logic/types';

function makeEntry({ index }: { index: number }): FileExplorerEntry {
  const name = `file-${String(index).padStart(4, '0')}.txt`;
  return {
    path: `/${name}`,
    name,
    kind: 'file',
    size: index,
    lastModified: index,
    extension: '.txt',
    mimeCategory: 'text',
    readOnly: false,
    canNavigate: false,
    canMutate: true,
  };
}

function makeEntries({ count }: { count: number }): FileExplorerEntry[] {
  return Array.from({ length: count }, (_, index) => makeEntry({ index }));
}

function setClientHeight({ element, height }: { element: HTMLElement, height: number }): void {
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: height,
  });
}

describe('useVirtualizedFileExplorerList', () => {
  it('limits visible entries based on viewport height and overscan', async () => {
    let state: ReturnType<typeof useVirtualizedFileExplorerList> | undefined;
    const entries = ref(makeEntries({ count: 100 }));

    const wrapper = mount(defineComponent({
      setup() {
        const containerRef = ref<HTMLElement | undefined>(undefined);
        state = useVirtualizedFileExplorerList({
          containerRef,
          entries: entries as Ref<FileExplorerEntry[]>,
          rowHeight: LIST_ROW_HEIGHT,
          overscan: VIRTUAL_SCROLL_OVERSCAN,
        });
        return {
          containerRef,
        };
      },
      render() {
        return h('div', {
          ref: 'containerRef',
        });
      },
    }), { attachTo: document.body });

    const container = wrapper.element as HTMLElement;
    setClientHeight({ element: container, height: LIST_ROW_HEIGHT * 5 });
    container.dispatchEvent(new Event('scroll'));
    await nextTick();

    expect(state).toBeDefined();
    expect(state!.TEST_ONLY.virtualizationEnabled.value).toBe(true);
    expect(state!.visibleEntries.value).toHaveLength(5 + VIRTUAL_SCROLL_OVERSCAN * 2);
    expect(state!.visibleEntries.value[0]?.name).toBe('file-0000.txt');
    expect(state!.topSpacerHeight.value).toBe(0);
    expect(state!.bottomSpacerHeight.value).toBe(
      (entries.value.length - state!.visibleEntries.value.length) * LIST_ROW_HEIGHT,
    );

    wrapper.unmount();
  });

  it('updates visible range and scrolls target entries into view', async () => {
    let state: ReturnType<typeof useVirtualizedFileExplorerList> | undefined;

    const wrapper = mount(defineComponent({
      setup() {
        const containerRef = ref<HTMLElement | undefined>(undefined);
        state = useVirtualizedFileExplorerList({
          containerRef,
          entries: ref(makeEntries({ count: 120 })),
          rowHeight: LIST_ROW_HEIGHT,
          overscan: VIRTUAL_SCROLL_OVERSCAN,
        });
        return {
          containerRef,
        };
      },
      render() {
        return h('div', {
          ref: 'containerRef',
        });
      },
    }), { attachTo: document.body });

    const container = wrapper.element as HTMLElement;
    setClientHeight({ element: container, height: LIST_ROW_HEIGHT * 4 });
    container.scrollTop = LIST_ROW_HEIGHT * 40;
    container.dispatchEvent(new Event('scroll'));
    await nextTick();

    expect(state).toBeDefined();
    expect(state!.startIndex.value).toBe(30);
    expect(state!.visibleEntries.value[0]?.name).toBe('file-0030.txt');

    state!.scrollEntryIntoView({ entryName: 'file-0090.txt' });

    expect(container.scrollTop).toBe((91 * LIST_ROW_HEIGHT) - container.clientHeight);

    wrapper.unmount();
  });
});
