import { watch, onMounted } from 'vue';
import { usePreferredDark, useStorage } from '@vueuse/core';

export type ThemeMode = 'light' | 'dark' | 'system';

// Global state to share across components
const themeMode = useStorage<ThemeMode>('lm-web-ui:theme-mode', 'system');

export function useTheme() {
  const preferredDark = usePreferredDark();

  function applyTheme(mode: ThemeMode) {
    const isDark = mode === 'system' ? preferredDark.value : (mode === 'dark');
    
    if (isDark) {
      document.documentElement.classList.add('dark');
      // Set color-scheme for browser UI elements like scrollbars
      document.documentElement.style.colorScheme = 'dark';
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = 'light';
    }
  }

  onMounted(() => {
    applyTheme(themeMode.value);
  });

  watch([themeMode, preferredDark], () => {
    applyTheme(themeMode.value);
  }, { immediate: true });

  return {
    themeMode,
    setTheme: (mode: ThemeMode) => {
      themeMode.value = mode;
    },
  };
}