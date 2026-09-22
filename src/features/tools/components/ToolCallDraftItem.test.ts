import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { ToolCallDraft } from '@/01-models/lm';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ToolCallDraftItem from './ToolCallDraftItem.vue';

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function draft({ name, args }: { name: string, args: string }): ToolCallDraft {
  return { partId: 'part_2', index: 2, beforePartIndex: 0, name, arguments: args };
}

describe('ToolCallDraftItem', () => {
  it('shows a generating label before the name or arguments arrive', () => {
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: '', args: '' }) } });
    expect(wrapper.text()).toBe('Generating tool call…');
    expect(wrapper.find('[data-testid="tool-call-draft-arguments"]').exists()).toBe(false);
  });

  it('renders incomplete shell script as text without executing or inventing a tool result', async () => {
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'shell_execute', args: '{"shell_script":"echo hello' }) } });
    expect(wrapper.find('pre').text()).toBe('$ echo hello');
    expect(wrapper.text()).not.toContain('Executing');
    expect(wrapper.text()).not.toContain('Result');
    const element = wrapper.find('[data-testid="tool-call-draft"]').element;
    await wrapper.setProps({ draft: draft({ name: 'shell_execute', args: '{"shell_script":"echo hello\\ncat <script>' }) });
    expect(wrapper.find('pre').text()).toBe(`\
$ echo hello
cat <script>`);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tool-call-draft"]').element).toBe(element);
  });

  it('keeps unknown tools and changed shell schemas visible as raw argument text', async () => {
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: '{"location":"Tok' }) } });
    expect(wrapper.find('pre').text()).toBe('{"location":"Tok');
    await wrapper.setProps({ draft: draft({ name: 'shell_execute', args: '{"command":"echo hello"}' }) });
    expect(wrapper.find('pre').text()).toBe('{"command":"echo hello"}');
    expect(wrapper.text()).not.toContain('$ ');
  });

  it('retains the user collapse choice while new arguments arrive', async () => {
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: '{"location":' }) } });
    await wrapper.get('[data-testid="tool-call-draft-toggle"]').trigger('click');
    await wrapper.setProps({ draft: draft({ name: 'weather', args: '{"location":"Tokyo"}' }) });
    expect(wrapper.get('[data-testid="tool-call-draft-toggle"]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('pre').exists()).toBe(false);
  });
});
