import { ref } from 'vue';

export type FocusArea = 'sidebar' | 'chat' | 'chat-group-settings' | 'chat-settings' | 'settings' | 'onboarding' | 'dialog' | 'none' | 'search';
export type MediaShelfVisibility = 'visible' | 'hidden';

const isSidebarOpen = ref(true);
const isDebugOpen = ref(false);
const isWeshTerminalOpen = ref(false);
const isChatWeshTerminalOpen = ref(false);
const activeFocusArea = ref<FocusArea>('chat');
const activeFocusAreaVersion = ref(0);
const mediaShelfVisibility = ref<MediaShelfVisibility>('hidden');
const preferredEditorMode = ref<'advanced' | 'textarea'>('advanced');

/** @effects [] */
export function useLayout() {
  /** @effects [] */
  const toggleSidebar = () => {
    isSidebarOpen.value = !isSidebarOpen.value;
  };

  /** @effects [] */
  const setSidebarOpen = ({ open }: { open: boolean }) => {
    isSidebarOpen.value = open;
  };

  /** @effects [] */
  const toggleDebug = () => {
    isDebugOpen.value = !isDebugOpen.value;
  };

  /** @effects [] */
  const setDebugOpen = ({ open }: { open: boolean }) => {
    isDebugOpen.value = open;
  };

  /** @effects [] */
  const toggleWeshTerminal = () => {
    isWeshTerminalOpen.value = !isWeshTerminalOpen.value;
  };

  /** @effects [] */
  const setWeshTerminalOpen = ({ open }: { open: boolean }) => {
    isWeshTerminalOpen.value = open;
  };

  /** @effects [] */
  const toggleChatWeshTerminal = () => {
    isChatWeshTerminalOpen.value = !isChatWeshTerminalOpen.value;
  };

  /** @effects [] */
  const setChatWeshTerminalOpen = ({ open }: { open: boolean }) => {
    isChatWeshTerminalOpen.value = open;
  };

  /** @effects [] */
  const setActiveFocusArea = ({ area }: { area: FocusArea }) => {
    activeFocusArea.value = area;
    activeFocusAreaVersion.value += 1;
  };

  /** @effects [] */
  const setMediaShelfVisibility = ({ visibility }: { visibility: MediaShelfVisibility }) => {
    mediaShelfVisibility.value = visibility;
  };

  /** @effects [] */
  const setPreferredEditorMode = ({ mode }: { mode: 'advanced' | 'textarea' }) => {
    preferredEditorMode.value = mode;
  };

  /** @effects [] */
  const toggleMediaShelf = () => {
    mediaShelfVisibility.value = (/** @effects [] */ () => {
      switch (mediaShelfVisibility.value) {
      case 'visible': return 'hidden';
      case 'hidden': return 'visible';
      default: {
        const _ex: never = mediaShelfVisibility.value;
        return _ex;
      }
      }
    })();
  };

  return {
    isSidebarOpen,
    isDebugOpen,
    isWeshTerminalOpen,
    activeFocusArea,
    activeFocusAreaVersion,
    mediaShelfVisibility,
    toggleSidebar,
    setSidebarOpen,
    toggleDebug,
    setDebugOpen,
    toggleWeshTerminal,
    setWeshTerminalOpen,
    isChatWeshTerminalOpen,
    toggleChatWeshTerminal,
    setChatWeshTerminalOpen,
    setActiveFocusArea,
    setMediaShelfVisibility,
    setPreferredEditorMode,
    toggleMediaShelf,
    preferredEditorMode,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        // Export internal state and logic used only for testing here. Do not reference these in production logic.
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
