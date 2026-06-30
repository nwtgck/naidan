import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, h } from 'vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import type { CombinedToolCall } from '@/01-models/types';
import { useToolCallOutput } from '@/composables/chat/ui/useToolCallOutput';
import { toMessageId, toToolCallId } from '@/01-models/ids';

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    BirdIcon: { render: () => h('span') },
    ShapesIcon: { render: () => h('span') },
    HammerIcon: { render: () => h('span') },
    CheckCircle2Icon: { render: () => h('span') },
    AlertCircleIcon: { render: () => h('span') },
    ChevronDownIcon: { render: () => h('span') },
    ChevronUpIcon: { render: () => h('span') },
    Loader2Icon: { render: () => h('span') },
  };
});

import { vi } from 'vitest';

vi.mock('@/00-storage/service', () => ({
  storageService: { getFile: vi.fn() },
}));

vi.mock('@/composables/chat/ui/useToolCallOutput', () => ({
  useToolCallOutput: vi.fn(),
}));

const makeToolCall = (): CombinedToolCall => ({
  id: toToolCallId({ raw: 'tc-1' }),
  nodeId: toMessageId({ raw: 'node-1' }),
  call: { id: toToolCallId({ raw: 'call-1' }), type: 'function', function: { name: 'shell_execute', arguments: '{}' } },
  result: { toolCallId: toToolCallId({ raw: 'call-1' }), status: 'success', content: { type: 'text', text: 'done' } },
});

describe('ToolCallGroupItem in-sequence auto-expand', () => {
  beforeEach(() => {
    vi.mocked(useToolCallOutput).mockReturnValue({
      getOutput: vi.fn().mockReturnValue(computed(() => undefined)),
      TEST_ONLY: {},
    });
  });

  it('is collapsed by default outside a sequence', () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
    });

    expect(wrapper.vm.TEST_ONLY.isExpanded.value).toBe(false);
  });

  it('auto-expands when inSequence is provided', () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
      global: { provide: { inSequence: true } },
    });

    expect(wrapper.vm.TEST_ONLY.isExpanded.value).toBe(true);
  });

  it('renders ToolCallItem contents when inSequence', () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
      global: { provide: { inSequence: true } },
    });

    expect(wrapper.find('[data-testid="lm-tool-call"]').exists()).toBe(true);
  });

  it('clicking inside expanded content does not collapse the group', async () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
      global: { provide: { inSequence: true } },
    });

    expect(wrapper.vm.TEST_ONLY.isExpanded.value).toBe(true);

    // Click inside the ToolCallItem (the preview area bubbles up in DOM)
    await wrapper.find('[data-testid="lm-tool-call"]').trigger('click');

    // Group should still be expanded — click.stop on content area prevents collapse
    expect(wrapper.vm.TEST_ONLY.isExpanded.value).toBe(true);
  });

  it('clicking the group header collapses the group', async () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
      global: { provide: { inSequence: true } },
    });

    expect(wrapper.vm.TEST_ONLY.isExpanded.value).toBe(true);

    await wrapper.find('[data-testid="tool-call-group-header"]').trigger('click');

    expect(wrapper.vm.TEST_ONLY.isExpanded.value).toBe(false);
  });
});
