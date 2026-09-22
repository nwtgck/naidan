import { expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SyntaxHighlightedCode from './SyntaxHighlightedCode.vue';

vi.mock('@/features/syntax-highlight/stream', () => ({
  highlightSyntaxStream: () => ({
    [Symbol.asyncIterator]: () => ({ next: async () => {
      throw new Error('Failed lexer');
    } }),
  }),
}));

it('keeps source updates visible as plain text after highlighting fails', async () => {
  const wrapper = mount(SyntaxHighlightedCode, { props: { code: 'echo initial', language: 'shell' } });
  await flushPromises();
  expect(wrapper.get('[data-syntax="plain"]').text()).toBe('echo initial');
  await wrapper.setProps({ code: 'printf "new source"' });
  expect(wrapper.element.textContent).toBe('printf "new source"');
  expect(wrapper.find('[data-syntax="command"]').exists()).toBe(false);
  wrapper.unmount();
});
