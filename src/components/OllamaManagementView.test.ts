import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OllamaManagementView from './OllamaManagementView.vue';
import { ensureAllStringsForTest } from '@/strings/test-utils';

const { mockCreateOllamaProvider } = vi.hoisted(() => ({
  mockCreateOllamaProvider: vi.fn(),
}));

vi.mock('@/features/lm/providerFactory', () => ({
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
});
