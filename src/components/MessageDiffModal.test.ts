import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import MessageDiffModal from './MessageDiffModal.vue';
import type { MessageNode } from '../models/types';
import { nextTick } from 'vue';

describe('MessageDiffModal', () => {
  const createMessage = (id: string, content: string, timestamp: number): MessageNode => ({
    id,
    role: 'assistant',
    content,
    timestamp,
    replies: { items: [] },
  });

  const siblings: MessageNode[] = [
    createMessage('v1', 'Original content.', 1000),
    createMessage('v2', 'Modified content.', 2000),
    createMessage('v3', 'Latest content!', 3000),
  ];

  beforeEach(() => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('renders all message versions in list view by default', () => {
    const wrapper = mount(MessageDiffModal, {
      props: {
        isOpen: true,
        siblings,
        currentMessageId: 'v3'
      }
    });

    const labels = wrapper.findAll('.tracking-widest').map(b => b.text().toLowerCase());
    expect(labels).toContain('v3');
    expect(labels).toContain('v2');
    expect(labels).toContain('v1');

    // Check order (latest first in DOM)
    const text = wrapper.text().toLowerCase();
    expect(text.indexOf('v3')).toBeLessThan(text.indexOf('v1'));
  });

  it('allows selecting base and target versions from the list', async () => {
    const wrapper = mount(MessageDiffModal, {
      props: {
        isOpen: true,
        siblings,
        currentMessageId: 'v3'
      }
    });

    // Find "Base" button for v1
    const v1Card = wrapper.findAll('.group\\/card').find(c => c.text().includes('v1'));
    const baseBtn = v1Card?.findAll('button').find(b => b.text().includes('Base'));
    await baseBtn?.trigger('click');

    // Find "Target" button for v3
    const v3Card = wrapper.findAll('.group\\/card').find(c => c.text().includes('v3'));
    const targetBtn = v3Card?.findAll('button').find(b => b.text().includes('Target'));
    await targetBtn?.trigger('click');

    // Sticky custom diff panel should appear
    await nextTick();
    expect(wrapper.text()).toContain('Comparing Base v1');
    expect(wrapper.text()).toContain('Target v3');

    // Diff content should show removals and additions
    const removedPart = wrapper.find('.bg-red-100, .dark\\:bg-red-900\\/40');
    expect(removedPart.text()).toBe('Original');

    const addedPart = wrapper.find('.bg-green-100, .dark\\:bg-green-900\\/40');
    expect(addedPart.text()).toBe('Latest');
  });

  it('can clear selection', async () => {
    const wrapper = mount(MessageDiffModal, {
      props: {
        isOpen: true,
        siblings,
        currentMessageId: 'v3'
      }
    });

    // Select Base for v1
    const v1Card = wrapper.findAll('.group\\/card').find(c => c.text().includes('v1'));
    const baseBtn = v1Card?.findAll('button').find(b => b.text().includes('Base'));
    await baseBtn?.trigger('click');

    // Select Target for v2 to ensure customDiff panel is visible (where Reset button lives)
    const v2Card = wrapper.findAll('.group\\/card').find(c => c.text().includes('v2'));
    const targetBtn = v2Card?.findAll('button').find(b => b.text().includes('Target'));
    await targetBtn?.trigger('click');

    await nextTick();

    // "Reset Selection" button should appear in the customDiff panel
    const resetBtn = wrapper.find('[data-testid="reset-selection-button"]');
    expect(resetBtn.exists()).toBe(true);

    await resetBtn.trigger('click');
    await nextTick();

    expect(wrapper.text()).not.toContain('Comparing Base');
  });

  it('handles copying sequential version content from the list', async () => {
    vi.useFakeTimers();
    const wrapper = mount(MessageDiffModal, {
      props: {
        isOpen: true,
        siblings,
        currentMessageId: 'v3'
      }
    });

    const copyButtons = wrapper.findAll('button[title="Copy this version"]');
    // Latest is v3 (index 0), v2 (index 1), v1 (index 2)
    await copyButtons[1]!.trigger('click');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Modified content.');

    await nextTick();
    expect(wrapper.findComponent({ name: 'Check' }).exists() || wrapper.find('.lucide-check').exists()).toBe(true);

    vi.advanceTimersByTime(2100);
    await nextTick();
    expect(wrapper.findComponent({ name: 'Check' }).exists() || wrapper.find('.lucide-check').exists()).toBe(false);

    vi.useRealTimers();
  });

  it('toggles diff visibility', async () => {
    const wrapper = mount(MessageDiffModal, {
      props: {
        isOpen: true,
        siblings,
        currentMessageId: 'v3'
      }
    });

    // Default: Diff On (check for a sequential diff highlight)
    // v2 compared to v1: "Original" is removed
    expect(wrapper.find('.bg-red-50\\/50, .dark\\:bg-red-900\\/20').exists()).toBe(true);

    // Toggle Off
    const offBtn = wrapper.findAll('button').find(b => b.text().includes('Off'));
    await offBtn?.trigger('click');

    // Highlights should disappear
    expect(wrapper.find('.bg-red-50\\/50, .dark\\:bg-red-900\\/20').exists()).toBe(false);
    expect(wrapper.text()).toContain('Original content.'); // Should show plain text

    // Toggle On again
    const onBtn = wrapper.findAll('button').find(b => b.text().includes('Diff On'));
    await onBtn?.trigger('click');

    expect(wrapper.find('.bg-red-50\\/50, .dark\\:bg-red-900\\/20').exists()).toBe(true);
  });

  it('allows skipping a version to recalculate sequential diffs', async () => {
    const wrapper = mount(MessageDiffModal, {
      props: {
        isOpen: true,
        siblings,
        currentMessageId: 'v3'
      }
    });

    // v3 sequential diff is normally against v2.
    const v3Card = wrapper.findAll('.group\\/card').find(c => c.text().includes('v3'));
    expect(v3Card?.text()).toContain('Modified');

    // Skip v2
    const v2Card = wrapper.findAll('.group\\/card').find(c => c.text().includes('v2'));
    const skipBtn = v2Card?.findAll('button').find(b => b.text().includes('Skip'));
    await skipBtn?.trigger('click');
    await nextTick();

    // Verify v2 content is hidden (collapsed)
    const v2Content = v2Card?.find('.p-5.font-mono');
    expect(v2Content?.exists()).toBe(false);

    // Now v3 sequential diff should be against v1.
    expect(v3Card?.text()).toContain('Original');
    expect(v3Card?.text()).not.toContain('Modified');

    // Unskip v2
    const skippedBtn = v2Card?.findAll('button').find(b => b.text().includes('Include'));
    await skippedBtn?.trigger('click');
    await nextTick();

    // Should be back to normal
    expect(v3Card?.text()).toContain('Modified');
  });
});
