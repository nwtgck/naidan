import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OllamaManagementView from './OllamaManagementView.vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';

const { mockCreateOllamaProvider } = vi.hoisted(() => ({
  mockCreateOllamaProvider: vi.fn(),
}));

vi.mock('@/features/lm/ollamaProviderFactory', () => ({
  createOllamaProvider: mockCreateOllamaProvider,
}));

describe('OllamaManagementView', () => {
  beforeEach(() => {
    mockCreateOllamaProvider.mockReset();
    mockCreateOllamaProvider.mockReturnValue({ runtime: 'provider' });
  });

  it('renders the current ps screen without a one-item tab interface', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    const wrapper = mount(OllamaManagementView, {
      props: {
        endpointUrl: 'http://localhost:11434',
        endpointHttpHeaders: [['Authorization', 'Bearer token']],
        fakeLmDebugModeStatus: 'disabled',
      },
      global: {
        stubs: {
          OllamaPsView: {
            name: 'OllamaPsView',
            props: ['provider', 'endpointUrl'],
            template: '<div data-testid="ollama-ps-view-stub">Running models</div>',
          },
        },
      },
    });

    expect(wrapper.find('[data-testid="ollama-management-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="ollama-ps-view-stub"]').exists()).toBe(true);
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Ollama Runtime');
    expect(mockCreateOllamaProvider).toHaveBeenCalledWith({
      endpointUrl: 'http://localhost:11434',
      endpointHttpHeaders: [['Authorization', 'Bearer token']],
      fakeLmDebugModeStatus: 'disabled',
    });
  });

  it('uses the existing runtime in settings without a second heading or disclosure', async () => {
    await ensureAllStringsForTest({ locale: 'en' });
    const wrapper = mount(OllamaManagementView, { props: { endpointUrl: 'http://localhost:11434', endpointHttpHeaders: [], fakeLmDebugModeStatus: 'disabled', presentation: 'settings' }, global: { stubs: { OllamaPsView: { name: 'OllamaPsView', props: ['provider', 'endpointUrl', 'presentation'], template: '<div data-testid="ps" />' } } } });
    using _cleanupResource = {
      [Symbol.dispose]() {
        wrapper.unmount();
      },
    };
    expect(wrapper.find('h2').exists()).toBe(false);
    expect(wrapper.get('[data-testid="ollama-management-view"]').attributes('aria-labelledby')).toBeUndefined();
    expect(wrapper.findComponent({ name: 'OllamaPsView' }).props('presentation')).toBe('settings');
    expect(wrapper.find('button').exists()).toBe(false);
  });
});
