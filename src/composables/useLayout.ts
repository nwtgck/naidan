import { ref } from 'vue';

export type FocusArea = 'sidebar' | 'chat' | 'chat-group-settings' | 'chat-settings' | 'settings' | 'onboarding' | 'dialog' | 'none' | 'search';

const isSidebarOpen = ref(true);
const isDebugOpen = ref(false);
const activeFocusArea = ref<FocusArea>('chat');

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

  return {
    isSidebarOpen,
    isDebugOpen,
    activeFocusArea,
    toggleSidebar,
    setSidebarOpen,
    toggleDebug,
    setDebugOpen,
    setActiveFocusArea,
    __testOnly: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  };
}