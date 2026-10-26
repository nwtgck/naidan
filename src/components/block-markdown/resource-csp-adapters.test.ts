import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import type { CombinedToolCall } from '@/01-models/types';
import { useExternalResourceSettings } from '@/composables/useExternalResourceSettings';
import ExternalImage from './ExternalImage.vue';
import MarkdownInline from './MarkdownInline.vue';
import ToolCallItem from '@/features/tools/components/ToolCallItem.vue';

vi.mock('@/components/csp/CspMessageHint.vue', () => ({
  default: defineComponent({
    inheritAttrs: false,
    props: ['target', 'presentation', 'activityForDisplayOnly'],
    setup(props) {
      return () => props.target === undefined ? null : h('aside', { 'data-testid': 'csp-adapter-notice', 'data-presentation': props.presentation, 'data-activity': props.activityForDisplayOnly }, 'Current connection environment');
    },
  }),
}));
vi.mock('@/00-storage/service', () => ({ storageService: { getFile: vi.fn() } }));
vi.mock('@/composables/chat/ui/useToolCallOutput', () => ({
  useToolCallOutput: () => ({ getOutput: () => computed(() => undefined), TEST_ONLY: {} }),
}));

beforeEach(async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  useExternalResourceSettings().TEST_ONLY.__testOnlyReset();
});

function wikipediaFailure({ code }: { code: 'execution_failed' | 'invalid_arguments' }): CombinedToolCall {
  const id = toToolCallId({ raw: 'wiki-csp' });
  return {
    id,
    nodeId: toMessageId({ raw: 'wiki-node' }),
    call: { id, type: 'function', function: { name: 'wikipedia_search', arguments: '{}' } },
    result: { status: 'error', toolCallId: id, error: { code, message: { type: 'text', text: 'Original tool failure' } } },
  };
}

describe('resource CSP display adapters', () => {
  it('keeps image permission actions and the original image active while a notice is shown', async () => {
    using host = {
      element: document.createElement('div'),
      [Symbol.dispose]() {
        this.element.remove();
      },
    };
    document.body.append(host.element);
    using view = {
      wrapper: mount(ExternalImage, { props: { src: 'https://images.invalid/picture', alt: 'Picture', title: undefined }, attachTo: host.element }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    expect(view.wrapper.find('[data-testid="csp-adapter-notice"]').exists()).toBe(true);
    expect(view.wrapper.get('[data-testid="csp-adapter-notice"]').attributes('data-activity')).toBeUndefined();
    expect(view.wrapper.find('img').exists()).toBe(false);
    await view.wrapper.get('.naidan-external-image-placeholder > span').trigger('click');
    expect(view.wrapper.get('img').attributes('src')).toBe('https://images.invalid/picture');
    Object.defineProperty(view.wrapper.get('img').element, 'currentSrc', { configurable: true, value: 'https://images.invalid/picture' });
    await view.wrapper.get('img').trigger('error');
    expect(view.wrapper.get('[data-testid="csp-adapter-notice"]').attributes('data-presentation')).toBe('error');
    expect(view.wrapper.get('img').attributes('src')).toBe('https://images.invalid/picture');
    await view.wrapper.get('img').trigger('load');
    expect(view.wrapper.find('[data-testid="csp-adapter-notice"]').exists()).toBe(false);
    expect(view.wrapper.find('img').exists()).toBe(true);
  });

  it('places the Wikipedia supplement outside the clipped preview and preserves the result', async () => {
    const call = wikipediaFailure({ code: 'execution_failed' });
    const original = JSON.stringify(call);
    using view = {
      wrapper: mount(ToolCallItem, { props: { toolCall: call }, global: { provide: { inSequence: true } } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    const notice = view.wrapper.get('[data-testid="csp-adapter-notice"]');
    expect(notice.attributes('data-activity')).toBe('wikipedia');
    expect(notice.element.closest('[data-testid="tool-detail-preview"]')).toBeNull();
    expect(view.wrapper.text()).toContain('Original tool failure');
    await view.wrapper.get('[data-testid="tool-detail-preview"]').trigger('click');
    expect(view.wrapper.get('[data-testid="csp-adapter-notice"]').text()).toBe('Current connection environment');
    expect(JSON.stringify(call)).toBe(original);
    await view.wrapper.setProps({ toolCall: wikipediaFailure({ code: 'invalid_arguments' }) });
    expect(view.wrapper.find('[data-testid="csp-adapter-notice"]').exists()).toBe(false);
    expect(view.wrapper.text()).toContain('Original tool failure');
  });

  it('observes the existing sanitized HTML and renders one compact supplement without altering its controls', async () => {
    using view = {
      wrapper: mount(MarkdownInline, { props: { mode: 'html', text: '<video src="https://media.invalid/video" controls></video><form action="https://forms.invalid/send" method="post"><button>Send</button></form>' } }),
      [Symbol.dispose]() {
        this.wrapper.unmount();
      },
    };
    await flushPromises();
    await vi.waitFor(() => expect(view.wrapper.findAll('[data-testid="csp-adapter-notice"]')).toHaveLength(1));
    expect(view.wrapper.get('[data-testid="csp-adapter-notice"]').attributes('data-activity')).toBeUndefined();
    expect(view.wrapper.get('video').attributes('src')).toBe('https://media.invalid/video');
    expect(view.wrapper.get('video').attributes('controls')).toBeDefined();
    expect(view.wrapper.get('form').attributes('action')).toBe('https://forms.invalid/send');
    expect(view.wrapper.get('form').attributes('method')).toBe('post');
    expect(view.wrapper.get('button').attributes('disabled')).toBeUndefined();
  });
});
