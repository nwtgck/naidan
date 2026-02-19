import { ref } from 'vue';

export type FocusArea = 'sidebar' | 'chat' | 'chat-group-settings' | 'chat-settings' | 'settings' | 'onboarding' | 'dialog' | 'none' | 'search';
export type MediaShelfVisibility = 'visible' | 'hidden';

const isSidebarOpen = ref(true);
const isDebugOpen = ref(false);
const activeFocusArea = ref<FocusArea>('chat');
const mediaShelfVisibility = ref<MediaShelfVisibility>('hidden');

export function useLayout() {
  const toggleSidebar = () => {
    isSidebarOpen.value = !isSidebarOpen.value;
  };

  const setSidebarOpen = (open: boolean) => {
    isSidebarOpen.value = open;
  };

  const toggleDebug = () => {
    isDebugOpen.value = !isDebugOpen.value;
  };

  const setDebugOpen = (open: boolean) => {
    isDebugOpen.value = open;
  };

  const setActiveFocusArea = (area: FocusArea) => {
    activeFocusArea.value = area;
  };

  const setMediaShelfVisibility = ({ visibility }: { visibility: MediaShelfVisibility }) => {
    mediaShelfVisibility.value = visibility;
  };

  const toggleMediaShelf = () => {
    mediaShelfVisibility.value = (() => {
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
    activeFocusArea,
    mediaShelfVisibility,
    toggleSidebar,
    setSidebarOpen,
    toggleDebug,
    setDebugOpen,
    setActiveFocusArea,
    setMediaShelfVisibility,
    toggleMediaShelf,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}