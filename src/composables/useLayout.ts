import { ref } from 'vue';

export type FocusArea = 'sidebar' | 'chat' | 'settings' | 'none';

const isSidebarOpen = ref(true);
const activeFocusArea = ref<FocusArea>('chat');

export function useLayout() {
  const toggleSidebar = () => {
    isSidebarOpen.value = !isSidebarOpen.value;
  };

  const setSidebarOpen = (open: boolean) => {
    isSidebarOpen.value = open;
  };

  const setActiveFocusArea = (area: FocusArea) => {
    activeFocusArea.value = area;
  };

  return {
    isSidebarOpen,
    activeFocusArea,
    toggleSidebar,
    setSidebarOpen,
    setActiveFocusArea,
  };
}