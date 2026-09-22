import { describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SyntaxHighlightedCode from './SyntaxHighlightedCode.vue';

describe('SyntaxHighlightedCode', () => {
  it('renders exact source as escaped text without creating payload elements', async () => {
    const code = `\
cat <<'EOF'
<img src=x onerror=alert(1)><script>alert('x')</script>
EOF
`;
    const wrapper = mount(SyntaxHighlightedCode, { props: { code, language: 'shell' } });
    await flushPromises();
    expect(wrapper.get('[data-testid="syntax-highlighted-code"]').element.textContent).toBe(code);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('script').exists()).toBe(false);
    expect(wrapper.find('[data-syntax="command"]').text()).toBe('cat');
  });

  it('recolors incomplete and corrected snapshots without retaining old text', async () => {
    const wrapper = mount(SyntaxHighlightedCode, { props: { code: 'echo "par', language: 'shell' } });
    await flushPromises();
    expect(wrapper.get('[data-syntax="string"]').text()).toBe('"par');
    await wrapper.setProps({ code: 'echo "partial"; $NEXT' });
    await flushPromises();
    expect(wrapper.get('[data-syntax="variable"]').text()).toBe('$NEXT');
    await wrapper.setProps({ code: "printf 'replaced'" });
    await flushPromises();
    expect(wrapper.element.textContent).toBe("printf 'replaced'");
    expect(wrapper.find('[data-syntax="variable"]').exists()).toBe(false);
    await wrapper.setProps({ language: 'plain' });
    await flushPromises();
    expect(wrapper.get('[data-syntax="plain"]').element.textContent).toBe("printf 'replaced'");
    expect(wrapper.find('[data-syntax="command"]').exists()).toBe(false);
  });

  it('keeps the latest language and code when an earlier stream is still pending', async () => {
    const wrapper = mount(SyntaxHighlightedCode, { props: { code: 'echo first', language: 'shell' } });
    await wrapper.setProps({ code: 'printf "second"', language: 'plain' });
    await wrapper.setProps({ code: 'cat final', language: 'shell' });
    await flushPromises();
    expect(wrapper.element.textContent).toBe('cat final');
    expect(wrapper.get('[data-syntax="command"]').text()).toBe('cat');
    wrapper.unmount();
    await flushPromises();
  });
});
