import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import MessageActionsMenu from './MessageActionsMenu.vue';
import SidebarDebugControls from './SidebarDebugControls.vue';

const mockIsDebugOpen = ref(false);
const mockErrorCount = ref(0);
const mockToggleDebug = vi.fn(() => {
  mockIsDebugOpen.value = !mockIsDebugOpen.value;
});
const mockToggleWeshTerminal = vi.fn();
const mockOpenFileExplorer = vi.fn();
const mockOpenRecent = vi.fn();

vi.mock('@/composables/useLayout', () => ({ useLayout: () => ({ isDebugOpen: mockIsDebugOpen, toggleDebug: mockToggleDebug, toggleWeshTerminal: mockToggleWeshTerminal }) }));
vi.mock('@/composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({ errorCount: mockErrorCount }) }));
vi.mock('@/features/file-explorer/composables/useFileExplorerModal', () => ({ useFileExplorerModal: () => ({ openFileExplorer: mockOpenFileExplorer }) }));
vi.mock('@/composables/useRecentChats', () => ({ useRecentChats: () => ({ openRecent: mockOpenRecent }) }));
// File recovery dialogs are outside these navigation and control-layout tests.
vi.mock('@/features/llama-cpp-browser/components/LlamaCppBrowserLocalFileRecovery.vue', () => ({ default: { template: '<div />' } }));
vi.mock('@/features/stable-diffusion-cpp-browser/components/ImageModelLocalFileRecovery.vue', () => ({ default: { template: '<div />' } }));

const globalStubs = {
  Teleport: true,
  MessageActionsMenu: { props: ['isOpen'], emits: ['close'], template: '<div><slot /></div>' },
};
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  mockIsDebugOpen.value = false;
  mockErrorCount.value = 0;
  await ensureAllStringsForTest({ locale: 'en' });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
});

it('keeps the icon-only download control before debug and More', () => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { stubs: globalStubs } });
  const trigger = wrapper.get('[data-testid="model-downloads-trigger"]');
  expect(trigger.attributes('aria-label')).toBeTruthy();
  expect(trigger.attributes('title')).toBe(trigger.attributes('aria-label'));
  expect(trigger.text()).toBe('');
  const buttons = wrapper.findAll('button');
  expect(buttons[0]?.element).toBe(trigger.element);
  expect(buttons[1]?.attributes('data-testid')).toBe('sidebar-debug-button');
  expect(buttons[2]?.attributes('data-testid')).toBe('sidebar-opfs-menu-button');
  expect(wrapper.text()).not.toContain('Downloads');
});

it('keeps the icon-only download control in the collapsed action stack', () => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: false }, global: { stubs: globalStubs } });
  const trigger = wrapper.get('[data-testid="model-downloads-trigger"]');
  expect(trigger.text()).toBe('');
  const buttons = wrapper.findAll('button');
  expect(buttons).toHaveLength(3);
  expect(buttons[0]?.element).toBe(trigger.element);
  expect(wrapper.get('[data-testid="sidebar-opfs-menu-button"]').attributes('aria-expanded')).toBe('false');
});

it.each([true, false])('opens and closes downloads when sidebar expanded is %s', async isSidebarOpen => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen }, global: { stubs: globalStubs } });
  const trigger = wrapper.get('[data-testid="model-downloads-trigger"]');
  expect(trigger.attributes('aria-expanded')).toBe('false');
  await trigger.trigger('click');
  await flushPromises();
  expect(trigger.attributes('aria-expanded')).toBe('true');
  expect(wrapper.get('[data-testid="model-downloads-panel"]').attributes('role')).toBe('dialog');
  await trigger.trigger('click');
  expect(trigger.attributes('aria-expanded')).toBe('false');
  expect(wrapper.find('[data-testid="model-downloads-panel"]').exists()).toBe(false);
});

it.each([true, false])('keeps error feedback and the debug action when sidebar expanded is %s', async isSidebarOpen => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen }, global: { stubs: globalStubs } });
  const debugButton = wrapper.findAll('button')[1];
  expect(debugButton).toBeDefined();
  if (!debugButton) {
    throw new Error('Expected the debug action beside downloads');
  }
  expect(debugButton.find('div').exists()).toBe(false);
  mockErrorCount.value = 3;
  await flushPromises();
  expect(debugButton.get('div').classes()).toContain('bg-red-500');
  if (isSidebarOpen) {
    expect(wrapper.get('[data-testid="sidebar-error-badge"]').text()).toBe('3');
  } else {
    expect(wrapper.get('[data-testid="sidebar-error-badge"]').text()).toBe('');
    expect(debugButton.classes()).toContain('w-8');
    expect(debugButton.classes()).not.toContain('shadow-sm');
  }
  await debugButton.trigger('click');
  expect(mockToggleDebug).toHaveBeenCalledOnce();
  expect(mockIsDebugOpen.value).toBe(true);
  mockErrorCount.value = 0;
  await flushPromises();
  expect(debugButton.find('div').exists()).toBe(false);
});

it('limits Quick Access to recent chats, the file explorer, and Wesh', async () => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { stubs: globalStubs } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const menu = wrapper.getComponent(MessageActionsMenu);
  expect(menu.findAll('button').map(button => button.get('span').text())).toEqual(['Recent Chats', 'File Explorer', 'Wesh Terminal']);
  expect(menu.findAll('a')).toHaveLength(0);
});

it.each(['recent', 'files', 'wesh'] as const)('performs the %s Quick Access action and closes the menu', async action => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { stubs: globalStubs } });
  await wrapper.get('[data-testid="sidebar-opfs-menu-button"]').trigger('click');
  const menu = wrapper.getComponent(MessageActionsMenu);
  switch (action) {
  case 'recent':
    await menu.get('[data-testid="sidebar-recent-button"]').trigger('click');
    expect(mockOpenRecent).toHaveBeenCalledOnce();
    break;
  case 'files':
    await menu.get('[data-testid="sidebar-file-explorer-button"]').trigger('click');
    expect(mockOpenFileExplorer).toHaveBeenCalledExactlyOnceWith({ options: { kind: 'opfs-root' } });
    break;
  case 'wesh': {
    const button = menu.findAll('button').find(button => button.text() === 'Wesh Terminal');
    if (!button) {
      throw new Error('Expected the Wesh Terminal action');
    }
    await button.trigger('click');
    expect(mockToggleWeshTerminal).toHaveBeenCalledOnce();
    break;
  }
  default: {
    const exhaustive: never = action;
    throw new Error(String(exhaustive));
  }
  }
  expect(mockOpenRecent).toHaveBeenCalledTimes(action === 'recent' ? 1 : 0);
  expect(mockOpenFileExplorer).toHaveBeenCalledTimes(action === 'files' ? 1 : 0);
  expect(mockToggleWeshTerminal).toHaveBeenCalledTimes(action === 'wesh' ? 1 : 0);
  expect(wrapper.findComponent(MessageActionsMenu).exists()).toBe(false);
});

it('closes Quick Access when the menu requests dismissal and can reopen it', async () => {
  wrapper = mount(SidebarDebugControls, { props: { isSidebarOpen: true }, global: { stubs: globalStubs } });
  const trigger = wrapper.get('[data-testid="sidebar-opfs-menu-button"]');
  await trigger.trigger('click');
  wrapper.getComponent(MessageActionsMenu).vm.$emit('close');
  await flushPromises();
  expect(wrapper.findComponent(MessageActionsMenu).exists()).toBe(false);
  expect(mockOpenRecent).not.toHaveBeenCalled();
  expect(mockOpenFileExplorer).not.toHaveBeenCalled();
  expect(mockToggleWeshTerminal).not.toHaveBeenCalled();
  await trigger.trigger('click');
  expect(wrapper.findComponent(MessageActionsMenu).exists()).toBe(true);
});
