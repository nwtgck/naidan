import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { ToolCallDraft } from '@/01-models/lm';
import { ensureAllStringsForTest } from '@/strings/test-utils';
import ToolCallDraftItem from './ToolCallDraftItem.vue';

enableAutoUnmount(afterEach);
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
});

function draft({ name, args }: { name: string, args: string }): ToolCallDraft {
  return { partId: 'part_2', index: 2, beforePartIndex: 0, name, arguments: args };
}

function mockArgumentLayout({ height, viewportHeight }: { height: number, viewportHeight: number }): { height: number } {
  const layout = { height };
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'tool-call-draft-arguments' ? layout.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'tool-call-draft-arguments' ? viewportHeight : 0;
  });
  return layout;
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

  it('follows the latest generated arguments and ignores its own queued scroll event', async () => {
    const layout = mockArgumentLayout({ height: 400, viewportHeight: 100 });
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: 'first' }) } });
    await nextTick();
    const preview = wrapper.get<HTMLElement>('[data-testid="tool-call-draft-arguments"]');
    expect(preview.element.scrollTop).toBe(300);

    // A queued scroll event may arrive after layout grows but before Vue updates.
    layout.height = 600;
    await preview.trigger('scroll');
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second' }) });
    expect(preview.element.scrollTop).toBe(500);
    await preview.trigger('scroll');
    layout.height = 700;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second third' }) });
    expect(preview.element.scrollTop).toBe(600);
  });

  it('pauses while the user reads earlier arguments and resumes on returning to the bottom', async () => {
    const layout = mockArgumentLayout({ height: 400, viewportHeight: 100 });
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: 'first' }) } });
    await nextTick();
    const preview = wrapper.get<HTMLElement>('[data-testid="tool-call-draft-arguments"]');
    preview.element.scrollTop = 180;
    await preview.trigger('scroll');
    layout.height = 500;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second' }) });
    expect(preview.element.scrollTop).toBe(180);

    preview.element.scrollTop = 400;
    await preview.trigger('scroll');
    layout.height = 600;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second third' }) });
    expect(preview.element.scrollTop).toBe(500);
  });

  it('respects a user scroll before its scroll event is delivered', async () => {
    const layout = mockArgumentLayout({ height: 400, viewportHeight: 100 });
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: 'first' }) } });
    await nextTick();
    const preview = wrapper.get<HTMLElement>('[data-testid="tool-call-draft-arguments"]');
    preview.element.scrollTop = 100;
    layout.height = 600;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second' }) });
    expect(preview.element.scrollTop).toBe(100);
    await preview.trigger('scroll');
    layout.height = 700;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second third' }) });
    expect(preview.element.scrollTop).toBe(100);
  });

  it('retains a paused reading position when collapsed arguments are reopened', async () => {
    const layout = mockArgumentLayout({ height: 400, viewportHeight: 100 });
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: 'first' }) } });
    await nextTick();
    const preview = wrapper.get<HTMLElement>('[data-testid="tool-call-draft-arguments"]');
    preview.element.scrollTop = 160;
    await preview.trigger('scroll');
    await wrapper.get('[data-testid="tool-call-draft-toggle"]').trigger('click');
    layout.height = 600;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first second' }) });
    await wrapper.get('[data-testid="tool-call-draft-toggle"]').trigger('click');
    const reopened = wrapper.get<HTMLElement>('[data-testid="tool-call-draft-arguments"]');
    expect(reopened.element).not.toBe(preview.element);
    expect(reopened.element.scrollTop).toBe(160);
  });

  it('keeps following after a corrected argument snapshot shortens the content', async () => {
    const layout = mockArgumentLayout({ height: 600, viewportHeight: 100 });
    const wrapper = mount(ToolCallDraftItem, { props: { draft: draft({ name: 'weather', args: 'first second third' }) } });
    await nextTick();
    const preview = wrapper.get<HTMLElement>('[data-testid="tool-call-draft-arguments"]');
    layout.height = 250;
    // Browsers clamp the old offset when the rendered content becomes shorter.
    preview.element.scrollTop = 150;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first' }) });
    await preview.trigger('scroll');
    layout.height = 400;
    await wrapper.setProps({ draft: draft({ name: 'weather', args: 'first corrected' }) });
    expect(preview.element.scrollTop).toBe(300);
  });
});
