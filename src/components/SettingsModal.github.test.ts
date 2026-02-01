import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SettingsModal from './SettingsModal.vue';

// Mocking dependencies
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: { value: { endpointType: 'openai', providerProfiles: [] } },
    save: vi.fn(),
    availableModels: { value: [] },
    isFetchingModels: { value: false },
    fetchModels: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    deleteAllChats: vi.fn(),
  }),
}));

vi.mock('../composables/useSampleChat', () => ({
  useSampleChat: () => ({
    createSampleChat: vi.fn(),
  }),
}));

vi.mock('../composables/useToast', () => ({
  useToast: () => ({
    addToast: vi.fn(),
  }),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: vi.fn(),
  }),
}));

vi.mock('../composables/usePrompt', () => ({
  usePrompt: () => ({
    showPrompt: vi.fn(),
  }),
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
  useRoute: () => ({
    path: '/',
    params: {},
  }),
}));

// Global constant mock
(global as any).__BUILD_MODE_IS_HOSTED__ = true;

describe('SettingsModal GitHub Link', () => {
  it('should contain GitHub link with External badge in the footer', async () => {
    const wrapper = mount(SettingsModal, {
      props: {
        isOpen: true,
      },
      global: {
        stubs: {
          'router-link': true,
          'router-view': true,
          'LmParametersEditor': true,
          'Transition': {
            template: '<slot />'
          },
          // Icons
          Github: true,
          ExternalLink: true,
          AlertTriangle: true,
          X: true,
          Settings2: true,
          Globe: true,
          BookmarkPlus: true,
          Database: true,
          Cpu: true,
          Download: true,
          Save: true,
          HardDrive: true,
          Info: true,
          Trash2: true,
          FlaskConical: true,
        }
      }
    });

    const githubLink = wrapper.find('a[href*="github.com/nwtgck/naidan"]');
    expect(githubLink.exists()).toBe(true);
    
    // Check for the "External" badge text
    expect(githubLink.text()).toContain('External');
    
    // Check for the "GitHub Repository" title
    expect(githubLink.text()).toContain('GitHub Repository');
  });
});
