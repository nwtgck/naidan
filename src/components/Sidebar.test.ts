import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import Sidebar from './Sidebar.vue';
import { createRouter, createWebHistory } from 'vue-router';
import { ref, computed, nextTick, reactive } from 'vue';
import type { ChatGroup, ChatSummary, SidebarItem } from '../models/types';

// --- Mocks Data ---
// We define these in a way that vi.mock can access them safely.
// Note: Vitest hoists vi.mock, so we use variables that are either 
// hoisted or defined inside the factory.

const mockChatGroups = ref<ChatGroup[]>([]);
const mockChats = ref<ChatSummary[]>([]);
const mockSettings = reactive({
  endpointUrl: 'http://localhost:11434',
  defaultModelId: 'llama3',
});
const mockAvailableModels = ref(['llama3', 'mistral', 'phi3']);
const mockIsFetchingModels = ref(false);

const mockLoadChats = vi.fn();
const mockDeleteAllChats = vi.fn();
const mockShowConfirm = vi.fn();
const mockCreateChatGroup = vi.fn();
const mockRenameChatGroup = vi.fn();
const mockDeleteChatGroup = vi.fn();
const mockSaveSettings = vi.fn();

const mockUpdateGlobalModel = vi.fn();

// --- Vitest Mocks ---

vi.mock('../composables/useChat', () => ({
  useChat: () => ({
    currentChat: ref(null),
    currentChatGroup: ref(null),
    streaming: ref(false),
    activeGenerations: reactive(new Map()),
    chatGroups: mockChatGroups,
    chats: mockChats,
    sidebarItems: computed<SidebarItem[]>(() => {
      const items: SidebarItem[] = [];
      mockChatGroups.value.forEach(g => items.push({ id: `chat_group:${g.id}`, type: 'chat_group', chatGroup: g }));
      mockChats.value.filter(c => !c.groupId).forEach(c => items.push({ id: `chat:${c.id}`, type: 'chat', chat: c }));
      return items;
    }),
    loadChats: mockLoadChats,
    createChatGroup: mockCreateChatGroup,
    renameChatGroup: mockRenameChatGroup,
    deleteChatGroup: mockDeleteChatGroup,
    openChatGroup: vi.fn(),
    setChatGroupCollapsed: vi.fn(),
    persistSidebarStructure: vi.fn(),
    deleteAllChats: mockDeleteAllChats,
    isTaskRunning: vi.fn().mockReturnValue(false),
    isProcessing: vi.fn().mockReturnValue(false),
    abortChat: vi.fn(),
  }),
}));

vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({
    settings: ref(mockSettings),
    availableModels: mockAvailableModels,
    isFetchingModels: mockIsFetchingModels,
    save: mockSaveSettings,
    updateGlobalModel: mockUpdateGlobalModel,
  }),
}));

vi.mock('../composables/useConfirm', () => ({
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
  }),
}));

vi.mock('../composables/useTheme', () => ({
  useTheme: () => ({
    themeMode: ref('dark'),
    setTheme: vi.fn(),
  }),
}));

vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => ({
    events: ref([]),
    eventCount: ref(0),
    errorCount: ref(0),
    addEvent: vi.fn(),
    addErrorEvent: vi.fn(),
    addInfoEvent: vi.fn(),
    clearEvents: vi.fn(),
  }),
}));

// Mock draggable component
vi.mock('vuedraggable', () => ({
  default: {
    name: 'draggable',
    template: '<div class="draggable-mock"><slot name="item" v-for="element in modelValue" :element="element"></slot></div>',
    props: ['modelValue'],
  },
}));

interface SidebarComponent {
  sidebarItemsLocal: SidebarItem[];
  isDragging: boolean;
  syncLocalItems: () => void;
}

describe('Sidebar Logic Stability', () => {
  const router = createRouter({
    history: createWebHistory(),
    routes: [{ path: '/', component: { template: 'div' } }],
  });

  const globalStubs = {
    'lucide-vue-next': true,
    'Logo': true,
    'ThemeToggle': true,
    'ModelSelector': {
      name: 'ModelSelector',
      template: '<div data-testid="model-selector-mock" :model-value="modelValue" :allow-clear="allowClear">{{ modelValue }}<div v-if="loading" class="animate-spin-mock"></div></div>',
      props: {
        modelValue: String,
        loading: {
          type: Boolean,
          default: false
        },
        allowClear: {
          type: Boolean,
          default: false
        }
      }
    },
  };

  beforeEach(() => {
    mockChatGroups.value = [];
    mockChats.value = [{ id: '1', title: 'Initial Chat', updatedAt: 0 }];
    mockSettings.endpointUrl = 'http://localhost:11434';
    mockSettings.defaultModelId = 'llama3';
    mockAvailableModels.value = ['llama3', 'mistral', 'phi3'];
    vi.clearAllMocks();
  });

  describe('Default Model Selector', () => {
    it('renders the model selector when endpoint is configured', async () => {
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      await nextTick();

      const selector = wrapper.find('[data-testid="model-selector-mock"]');
      expect(selector.exists()).toBe(true);
      expect(wrapper.text()).toContain('Default model');
    });

    it('does not render the selector if endpointUrl is missing', async () => {
      mockSettings.endpointUrl = '';
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      await nextTick();

      const selector = wrapper.find('[data-testid="model-selector-mock"]');
      expect(selector.exists()).toBe(false);
    });

    it('displays the current model via ModelSelector', async () => {
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      await nextTick();

      const selector = wrapper.get('[data-testid="model-selector-mock"]');
      expect(selector.attributes('model-value')).toBe('llama3');
    });

    it('does not enable allowClear for the global model selector', async () => {
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      await nextTick();

      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      expect(selector.props('allowClear')).toBe(false);
    });

    it('calls save when ModelSelector emits update:modelValue', async () => {
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      await nextTick();

      const selector = wrapper.getComponent({ name: 'ModelSelector' });
      await selector.vm.$emit('update:modelValue', 'mistral');

      expect(mockUpdateGlobalModel).toHaveBeenCalledWith('mistral');
    });

    it('shows a loading spinner when models are being fetched', async () => {
      mockIsFetchingModels.value = true;
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      await nextTick();

      expect(wrapper.find('.animate-spin-mock').exists()).toBe(true);
    });
  });

  it('should not update sidebarItemsLocal while dragging to prevent SortableJS crashes', async () => {
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const vm = wrapper.vm as unknown as SidebarComponent;

    // 1. Initial state
    await nextTick();
    vm.syncLocalItems(); // Manually sync for testing
    await nextTick();
    
    expect(vm.sidebarItemsLocal).toHaveLength(1);
    expect(vm.sidebarItemsLocal[0]?.type).toBe('chat');
    if (vm.sidebarItemsLocal[0]?.type === 'chat') {
      expect(vm.sidebarItemsLocal[0].chat.title).toBe('Initial Chat');
    }

    // 2. Simulate drag start
    vm.isDragging = true;

    // 3. Simulate an external data update (e.g. a new chat group added)
    mockChatGroups.value = [{ id: 'g1', name: 'New Group', isCollapsed: false, updatedAt: 0, items: [] }];
    await nextTick();

    // 4. Verification: sidebarItemsLocal should NOT have changed yet
    expect(vm.sidebarItemsLocal).toHaveLength(1);
    if (vm.sidebarItemsLocal[0]?.type === 'chat') {
      expect(vm.sidebarItemsLocal[0].chat.title).toBe('Initial Chat');
    }

    // 5. Simulate drag end
    vm.isDragging = false;
    vm.syncLocalItems();
    await nextTick();
    
    // Now it should finally reflect the change
    expect(vm.sidebarItemsLocal).toHaveLength(2);
  });

  it('should apply the .handle class to both chat groups and chats for drag-and-drop', async () => {
    mockChatGroups.value = [{ id: 'g1', name: 'Group', isCollapsed: false, updatedAt: 0, items: [] }];
    mockChats.value = [{ id: 'c1', title: 'Chat', updatedAt: 0 }];
    
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const vm = wrapper.vm as unknown as SidebarComponent;
    vm.syncLocalItems();
    await nextTick();

    // Verify chat group has handle
    const chatGroupItem = wrapper.find('[data-testid="chat-group-item"]');
    expect(chatGroupItem.classes()).toContain('handle');

    // Verify chat has handle
    const chatItems = wrapper.findAll('.sidebar-chat-item');
    expect(chatItems.length).toBeGreaterThan(0);
    chatItems.forEach(item => {
      expect(item.classes()).toContain('handle');
    });
  });

  describe('Chat Group Creation UI', () => {
    it('should show input when create button is clicked', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(false);
      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(true);
    });

    it('should create chat group on enter if name is not empty', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      const input = wrapper.find('[data-testid="chat-group-name-input"]');
      
      await input.setValue('My New Group');
      await input.trigger('keydown.enter');

      expect(mockCreateChatGroup).toHaveBeenCalledWith('My New Group');
      expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(false);
    });

    it('should close input on blur IF empty', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      const input = wrapper.find('[data-testid="chat-group-name-input"]');
      
      await input.setValue('');
      await input.trigger('blur');

      expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(false);
    });

    it('should NOT close input on blur IF NOT empty', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      const input = wrapper.find('[data-testid="chat-group-name-input"]');
      
      await input.setValue('Retain Me');
      await input.trigger('blur');

      expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(true);
      expect(mockCreateChatGroup).not.toHaveBeenCalled();
    });

    it('should cancel on escape', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      const input = wrapper.find('[data-testid="chat-group-name-input"]');
      
      await input.setValue('Going to escape');
      await input.trigger('keyup.esc');

      expect(wrapper.find('[data-testid="chat-group-name-input"]').exists()).toBe(false);
      expect(mockCreateChatGroup).not.toHaveBeenCalled();
    });

    it('should apply skip-leave class when confirming', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      const input = wrapper.find('[data-testid="chat-group-name-input"]');
      const container = wrapper.find('[data-testid="chat-group-creation-container"]');

      await input.setValue('New Group');
      await input.trigger('keydown.enter');
      expect(container.classes()).toContain('skip-leave');
    });

    it('should NOT apply skip-leave class when cancelling', async () => {
      const wrapper = mount(Sidebar, {
        global: {
          plugins: [router],
          stubs: { 'lucide-vue-next': true, 'Logo': true },
        },
      });

      await wrapper.find('[data-testid="create-chat-group-button"]').trigger('click');
      const input = wrapper.find('[data-testid="chat-group-name-input"]');
      const container = wrapper.find('[data-testid="chat-group-creation-container"]');
      
      await input.trigger('keyup.esc');
      expect(container.classes()).not.toContain('skip-leave');
    });
  });

  it('should display the New Chat shortcut key when sidebar is open', async () => {
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    // Sidebar is open by default in Sidebar.vue (actually it depends on useLayout)
    // In our test, useLayout is not mocked, so it uses the real one.
    // Let's ensure it's open.
    const newChatButton = wrapper.find('[data-testid="new-chat-button"]');
    expect(newChatButton.exists()).toBe(true);
    
    // The shortcut text is platform dependent. 
    // In the test environment, we can check for either Ctrl+Shift+O or ⌘⇧O 
    // depending on what navigator.platform returns.
    const text = newChatButton.text();
    expect(text).toContain('New Chat');
    expect(text).toMatch(/(Ctrl\+Shift\+O|⌘⇧O)/);
  });

  it("should display 'New Chat' when a chat title is empty in the sidebar", async () => {
    mockChats.value = [
      { id: 'chat-empty-1', title: '', updatedAt: 0 },
      { id: 'chat-null-1', title: null as any, updatedAt: 0 },
    ];
    
    const wrapper = mount(Sidebar, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const vm = wrapper.vm as unknown as SidebarComponent;
    vm.syncLocalItems();
    await nextTick();

    const chatItems = wrapper.findAll('.sidebar-chat-item');
    expect(chatItems).toHaveLength(2);
    expect(chatItems[0]!.text()).toContain('New Chat');
    expect(chatItems[1]!.text()).toContain('New Chat');
  });

  describe('Group Deletion Confirmation', () => {
    it('should prompt for confirmation when deleting a group with chats', async () => {
      // Setup group with items
      const groupWithChats: ChatGroup = { 
        id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0,
        items: [{ id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } }] 
      };
      mockChatGroups.value = [groupWithChats];
      
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      const vm = wrapper.vm as unknown as SidebarComponent;
      vm.syncLocalItems();
      await nextTick();

      // Find delete button and click
      const deleteBtn = wrapper.find('[data-testid="delete-group-button"]');
      await deleteBtn.trigger('click');

      expect(mockShowConfirm).toHaveBeenCalled();
    });

    it('should prompt for confirmation when deleting an empty group with custom settings', async () => {
      // Setup group with custom settings but no items
      const groupWithSettings: ChatGroup = { 
        id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [],
        systemPrompt: { content: 'sys', behavior: 'append' }
      };
      mockChatGroups.value = [groupWithSettings];
      
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      const vm = wrapper.vm as unknown as SidebarComponent;
      vm.syncLocalItems();
      await nextTick();

      const deleteBtn = wrapper.find('[data-testid="delete-group-button"]');
      await deleteBtn.trigger('click');

      expect(mockShowConfirm).toHaveBeenCalled();
    });

    it('should delete IMMEDIATELY without confirmation for an empty group with no settings', async () => {
      // Setup vanilla group
      const emptyGroup: ChatGroup = { 
        id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, items: [] 
      };
      mockChatGroups.value = [emptyGroup];
      
      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      const vm = wrapper.vm as unknown as SidebarComponent;
      vm.syncLocalItems();
      await nextTick();

      const deleteBtn = wrapper.find('[data-testid="delete-group-button"]');
      await deleteBtn.trigger('click');

      expect(mockShowConfirm).not.toHaveBeenCalled();
      expect(mockDeleteChatGroup).toHaveBeenCalledWith('g1');
    });

    it('should call deleteChatGroup after confirmation is accepted', async () => {
      const group: ChatGroup = { 
        id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, 
        items: [{ id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } }]
      };
      mockChatGroups.value = [group];
      mockShowConfirm.mockResolvedValue(true); // User accepts

      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      const vm = wrapper.vm as unknown as SidebarComponent;
      vm.syncLocalItems();
      await nextTick();

      await wrapper.find('[data-testid="delete-group-button"]').trigger('click');
      
      // Wait for promise resolution
      await nextTick();
      await nextTick();

      expect(mockDeleteChatGroup).toHaveBeenCalledWith('g1');
    });

    it('should NOT call deleteChatGroup if confirmation is cancelled', async () => {
      const group: ChatGroup = { 
        id: 'g1', name: 'Group 1', isCollapsed: false, updatedAt: 0, 
        items: [{ id: 'chat:c1', type: 'chat', chat: { id: 'c1', title: 'C1', updatedAt: 0 } }]
      };
      mockChatGroups.value = [group];
      mockShowConfirm.mockResolvedValue(false); // User cancels

      const wrapper = mount(Sidebar, {
        global: { plugins: [router], stubs: globalStubs },
      });
      const vm = wrapper.vm as unknown as SidebarComponent;
      vm.syncLocalItems();
      await nextTick();

      await wrapper.find('[data-testid="delete-group-button"]').trigger('click');
      
      await nextTick();
      await nextTick();

      expect(mockDeleteChatGroup).not.toHaveBeenCalled();
    });
  });
});