import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { h } from 'vue';
import ToolCallItem from './ToolCallItem.vue';
import type { CombinedToolCall } from '@/models/types';

vi.mock('lucide-vue-next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    Hammer: { render: () => h('span') },
    CheckCircle2: { render: () => h('span') },
    AlertCircle: { render: () => h('span') },
    ChevronDown: { render: () => h('span') },
    ChevronUp: { render: () => h('span') },
    Loader2: { render: () => h('span') },
  };
});

vi.mock('@/services/storage', () => ({
  storageService: { getFile: vi.fn() },
}));

const makeToolCall = (): CombinedToolCall => ({
  id: 'tc-1',
  nodeId: 'node-1',
  call: { id: 'call-1', type: 'function', function: { name: 'shell_execute', arguments: '{}' } },
  result: { toolCallId: 'call-1', status: 'success', content: { type: 'text', text: 'done' } },
});

describe('ToolCallItem in-sequence height limit', () => {
  it('shows details without height limit outside a sequence', () => {
    const wrapper = mount(ToolCallItem, {
      props: { toolCall: makeToolCall() },
    });

    const details = wrapper.find('.p-3.flex.flex-col');
    expect(details.classes()).not.toContain('max-h-40');
    expect(details.classes()).not.toContain('overflow-hidden');
  });

  it('applies max-h-40 and overflow-hidden on details when inSequence', () => {
    const wrapper = mount(ToolCallItem, {
      props: { toolCall: makeToolCall() },
      global: { provide: { inSequence: true } },
    });

    const details = wrapper.find('.p-3.flex.flex-col');
    expect(details.classes()).toContain('max-h-40');
    expect(details.classes()).toContain('overflow-hidden');
  });
});
