import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import type { CombinedToolCall } from '@/models/types';

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    Bird: { render: () => h('span') },
    Shapes: { render: () => h('span') },
    Hammer: { render: () => h('span') },
    CheckCircle2: { render: () => h('span') },
    AlertCircle: { render: () => h('span') },
    ChevronDown: { render: () => h('span') },
    ChevronUp: { render: () => h('span') },
    Loader2: { render: () => h('span') },
  };
});

import { vi } from 'vitest';

vi.mock('@/services/storage', () => ({
  storageService: { getFile: vi.fn() },
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    getVolatileToolOutput: vi.fn().mockReturnValue(undefined),
  }),
}));

const makeToolCall = (): CombinedToolCall => ({
  id: 'tc-1',
  nodeId: 'node-1',
  call: { id: 'call-1', type: 'function', function: { name: 'shell_execute', arguments: '{}' } },
  result: { toolCallId: 'call-1', status: 'success', content: { type: 'text', text: 'done' } },
});

describe('ToolCallGroupItem in-sequence auto-expand', () => {
  it('is collapsed by default outside a sequence', () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
    });

    expect(wrapper.vm.__testOnly.isExpanded.value).toBe(false);
  });

  it('auto-expands when inSequence is provided', () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
      global: { provide: { inSequence: true } },
    });

    expect(wrapper.vm.__testOnly.isExpanded.value).toBe(true);
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

    expect(wrapper.vm.__testOnly.isExpanded.value).toBe(true);

    // Click inside the ToolCallItem (the preview area bubbles up in DOM)
    await wrapper.find('[data-testid="lm-tool-call"]').trigger('click');

    // Group should still be expanded — click.stop on content area prevents collapse
    expect(wrapper.vm.__testOnly.isExpanded.value).toBe(true);
  });

  it('clicking the group header collapses the group', async () => {
    const wrapper = mount(ToolCallGroupItem, {
      props: { toolCalls: [makeToolCall()] },
      global: { provide: { inSequence: true } },
    });

    expect(wrapper.vm.__testOnly.isExpanded.value).toBe(true);

    await wrapper.find('[data-testid="tool-call-group-header"]').trigger('click');

    expect(wrapper.vm.__testOnly.isExpanded.value).toBe(false);
  });
});
