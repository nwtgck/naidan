import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, nextTick, reactive } from 'vue';
import { useLayout } from '../composables/useLayout';

vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

vi.mock('../composables/useLayout', () => ({
  useLayout: vi.fn(() => ({
    isSidebarOpen: ref(true),
    activeFocusArea: ref('chat'),
    setActiveFocusArea: vi.fn(),
    toggleSidebar: vi.fn(),
  })),
}));

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref(null),
    currentChatGroup: ref(null),
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: ref([]),
    chats: ref([{ id: '1', title: 'Test Chat' }]),
    sidebarItems: ref([{ id: 'chat:1', type: 'chat', chat: { id: '1', title: 'Test Chat' } }]),
    loadChats: vi.fn(),
    openChat: vi.fn(),
    openChatGroup: vi.fn(),
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref({ endpointUrl: 'http://localhost' }),
    availableModels: ref([]),
    isFetchingModels: ref(false),
    save: vi.fn(),
  }),
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
    setTheme: vi.fn(),
  }),
}));

describe('Sidebar Collapse Functionality', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const isSidebarOpen = ref(true);

  beforeEach(() => {
    isSidebarOpen.value = true;
    (useLayout as any).mockReturnValue({
      isSidebarOpen,
      activeFocusArea: ref('chat'),
      setActiveFocusArea: vi.fn(),
      toggleSidebar: vi.fn(),
    });
  });

  it('toggles isSidebarOpen when the toggle button is clicked', async () => {
    const toggleSidebar = vi.fn(() => {
      isSidebarOpen.value = !isSidebarOpen.value;
    });
    (useLayout as any).mockReturnValue({
      isSidebarOpen,
      activeFocusArea: ref('chat'),
      setActiveFocusArea: vi.fn(),
      toggleSidebar,
    });

    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });

    const toggleBtn = wrapper.find('[data-testid="sidebar-toggle"]');
    await toggleBtn.trigger('click');
    expect(toggleSidebar).toHaveBeenCalled();
    expect(isSidebarOpen.value).toBe(false);
  });

  it('hides elements when collapsed', async () => {
    isSidebarOpen.value = false;
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    // Logo should be hidden
    expect(wrapper.find('logo-stub').exists()).toBe(false);
    
    // Title should be hidden
    expect(wrapper.find('h1').exists()).toBe(false);

    // Chat list (nav) content should be hidden (using template v-if)
    const nav = wrapper.find('[data-testid="sidebar-nav"]');
    expect(nav.text()).toBe('');

    // Version text in footer should be hidden
    expect(wrapper.text()).not.toContain('v0.1.0');

    // New Chat button should NOT have text
    const newChatBtn = wrapper.find('[data-testid="new-chat-button"]');
    expect(newChatBtn.text()).not.toContain('New Chat');
  });

  it('shows elements when expanded', async () => {
    isSidebarOpen.value = true;
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    expect(wrapper.find('logo-stub').exists()).toBe(true);
    expect(wrapper.find('h1').exists()).toBe(true);
    const nav = wrapper.find('[data-testid="sidebar-nav"]');
    expect(nav.text()).not.toBe('');
    expect(wrapper.text()).toContain('New Chat');
  });

  it('applies correct sizing classes in collapsed mode', async () => {
    isSidebarOpen.value = false;
    const wrapper = mount(Sidebar, {
      global: { plugins: [router], stubs: { 'lucide-vue-next': true, 'Logo': true } },
    });
    await nextTick();

    const newChatBtn = wrapper.find('[data-testid="new-chat-button"]');
    expect(newChatBtn.classes()).toContain('w-8');
    expect(newChatBtn.classes()).toContain('h-8');

    const settingsBtn = wrapper.find('button[title="Settings"]');
    expect(settingsBtn.classes()).toContain('w-8');
    expect(settingsBtn.classes()).toContain('h-8');
  });
});