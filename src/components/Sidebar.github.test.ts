import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref } from 'vue';

// Mocking useChat and useSettings
vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref(null),
    streaming: ref(false),
    chatGroups: ref([]),
    chats: ref([]),
    sidebarItems: ref([]),
    handleNewChat: vi.fn(),
    loadChats: vi.fn(),
    toggleChatGroupCollapse: vi.fn(),
    persistSidebarStructure: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ defaultModelId: 'test-model' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    save: vi.fn(),
  }),
}));

// Global constant mock
(global as any).__APP_VERSION__ = '0.1.0-dev';

describe('Sidebar GitHub and Version', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: '<div></div>' } }],
  });

  it('should display the app version next to the title', () => {
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: {
          Logo: true,
          ThemeToggle: true,
          Plus: true,
          FolderPlus: true,
          SettingsIcon: true,
          ChevronDown: true,
          Bot: true,
          draggable: true,
        }
      }
    });
    expect(wrapper.text()).toContain('v0.1.0-dev');
  });

  it('should NOT contain GitHub repository link per local-first design', async () => {
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: {
          Logo: true,
          ThemeToggle: true,
          Plus: true,
          FolderPlus: true,
          SettingsIcon: true,
          ChevronDown: true,
          Bot: true,
          draggable: true,
        }
      }
    });

    const githubLink = wrapper.find('a[href*="github.com"]');
    expect(githubLink.exists()).toBe(false);
  });
});