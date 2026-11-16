import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { LiveConversationNavigation, LiveConversationPanel } from '@/features/live-conversation/navigation';
import LiveConversationSidebar from './LiveConversationSidebar.vue';
import LiveConversationSidebarActions from './LiveConversationSidebarActions.vue';

const expanded = ref(true);
vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isSidebarOpen: expanded }) }));

beforeEach(async () => {
  expanded.value = true;
  await ensureAllStringsForTest({ locale: 'en' });
});

function fixture() {
  const busy = ref(false), panel = ref<LiveConversationPanel>('conversation');
  const canReset = ref(true), fileName = ref<string>();
  const navigation: LiveConversationNavigation = {
    panel,
    modelName: ref('Haru'),
    fileName,
    busy,
    canReset,
    openConversation: vi.fn(),
    openDiagnostics: vi.fn(),
    newConversation: vi.fn(async () => {}),
    openSettings: vi.fn(),
  };
  const wrapper = mount(defineComponent({
    setup() {
      return () => h('div', [h(LiveConversationSidebarActions, { navigation, expanded: expanded.value }), h(LiveConversationSidebar, { navigation })]);
    },
  }));
  return {
    wrapper,
    navigation,
    busy,
    panel,
    canReset,
    fileName,
    [Symbol.dispose]() {
      wrapper.unmount();
    },
  };
}

describe('Live Conversation sidebar content and actions', () => {
  it('delegates conversation, investigation tools and conversation settings', async () => {
    using f = fixture();
    await f.wrapper.get('[data-testid="live-sidebar-microphone"]').trigger('click');
    expect(f.navigation.openConversation).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').trigger('click');
    expect(f.navigation.openDiagnostics).toHaveBeenCalledOnce();
    await f.wrapper.get('[data-testid="live-sidebar-settings"]').trigger('click');
    expect(f.navigation.openSettings).toHaveBeenCalledOnce();
  });

  it('places investigation tools below conversation settings', () => {
    using f = fixture();
    const settings = f.wrapper.get('[data-testid="live-sidebar-settings"]').element;
    const tools = f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').element;
    expect(settings.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(f.wrapper.find('[data-testid="live-sidebar-file"]').exists()).toBe(false);
  });

  it('prevents changing input sources during inference and remains usable when collapsed', async () => {
    using f = fixture();
    expanded.value = false;
    f.busy.value = true;
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-sidebar-microphone"]').attributes('disabled')).toBeDefined();
    expect(f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').attributes('aria-label')).toBe('Diagnostics');
    expect(f.wrapper.find('[data-testid="live-sidebar-settings"]').exists()).toBe(true);
  });

  it.each([true, false])('keeps new conversation governed by canReset when expanded is %s', async isExpanded => {
    expanded.value = isExpanded;
    using f = fixture();
    f.canReset.value = false;
    await flushPromises();
    const action = f.wrapper.get('[data-testid="live-sidebar-new"]');
    expect(action.attributes('disabled')).toBeDefined();
    expect(action.attributes('aria-label')).toBe('New conversation');
    await action.trigger('click');
    expect(f.navigation.newConversation).not.toHaveBeenCalled();
    f.canReset.value = true;
    await flushPromises();
    await action.trigger('click');
    expect(f.navigation.newConversation).toHaveBeenCalledOnce();
  });

  it('updates selection and investigation file context without recreating the owner', async () => {
    using f = fixture();
    const owner = f.wrapper.get('[data-testid="live-conversation-sidebar"]').element;
    f.panel.value = 'diagnostics';
    f.fileName.value = 'recording.wav';
    await flushPromises();
    expect(f.wrapper.get('[data-testid="live-conversation-sidebar"]').element).toBe(owner);
    expect(f.wrapper.get('[data-testid="live-sidebar-diagnostics"]').attributes('aria-current')).toBe('page');
    expect(f.wrapper.get('[data-testid="live-sidebar-microphone"]').attributes('aria-current')).toBeUndefined();
    expect(f.wrapper.text()).toContain('recording.wav');
  });
});
