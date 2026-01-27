import { ref } from 'vue';

const isSidebarOpen = ref(true);

export function useLayout() {
  const toggleSidebar = () => {
    isSidebarOpen.value = !isSidebarOpen.value;
  };

  const setSidebarOpen = (open: boolean) => {
    isSidebarOpen.value = open;
  };

  return {
    isSidebarOpen,
    toggleSidebar,
    setSidebarOpen,
  };
}