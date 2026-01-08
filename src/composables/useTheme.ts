import { watch, onMounted } from 'vue';
import { useDark, usePreferredDark } from '@vueuse/core';
import { useSettings } from './useSettings';

export function useTheme() {
  const { settings } = useSettings();
  const preferredDark = usePreferredDark();
  
  const isDark = useDark({
    selector: 'html',
    attribute: 'class',
    valueDark: 'dark',
    valueLight: '',
  });

  function updateTheme() {
    if (settings.value.theme === 'system') {
      isDark.value = preferredDark.value;
    } else {
      isDark.value = settings.value.theme === 'dark';
    }
  }

  onMounted(() => {
    updateTheme();
  });

  watch(() => [settings.value.theme, preferredDark.value], () => {
    updateTheme();
  });

  return {
    isDark
  };
}
