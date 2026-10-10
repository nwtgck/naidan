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

/** @effects `none` */
export function useLayout() {
  /** @effects `none` */
  const toggleSidebar = () => {
    isSidebarOpen.value = !isSidebarOpen.value;
  };

  /** @effects `none` */
  const setSidebarOpen = ({ open }: { open: boolean }) => {
    isSidebarOpen.value = open;
  };

  /** @effects `none` */
  const toggleDebug = () => {
    isDebugOpen.value = !isDebugOpen.value;
  };

  /** @effects `none` */
  const setDebugOpen = ({ open }: { open: boolean }) => {
    isDebugOpen.value = open;
  };

  /** @effects `none` */
  const toggleWeshTerminal = () => {
    isWeshTerminalOpen.value = !isWeshTerminalOpen.value;
  };

  /** @effects `none` */
  const setWeshTerminalOpen = ({ open }: { open: boolean }) => {
    isWeshTerminalOpen.value = open;
  };

  /** @effects `none` */
  const toggleChatWeshTerminal = () => {
    isChatWeshTerminalOpen.value = !isChatWeshTerminalOpen.value;
  };

  /** @effects `none` */
  const setChatWeshTerminalOpen = ({ open }: { open: boolean }) => {
    isChatWeshTerminalOpen.value = open;
  };

  /** @effects `none` */
  const setActiveFocusArea = ({ area }: { area: FocusArea }) => {
    activeFocusArea.value = area;
    activeFocusAreaVersion.value += 1;
  };

  /** @effects `none` */
  const setMediaShelfVisibility = ({ visibility }: { visibility: MediaShelfVisibility }) => {
    mediaShelfVisibility.value = visibility;
  };

  /** @effects `none` */
  const setPreferredEditorMode = ({ mode }: { mode: 'advanced' | 'textarea' }) => {
    preferredEditorMode.value = mode;
  };

  /** @effects `none` */
  const toggleMediaShelf = () => {
    mediaShelfVisibility.value = (/** @effects `none` */ () => {
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
