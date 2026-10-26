import { computed, inject, provide, type ComputedRef, type InjectionKey } from 'vue';

const settingsTypographyKey: InjectionKey<ComputedRef<boolean>> = Symbol('llama-cpp-browser-settings-typography');

// Keep the settings scale local to this manager, including its teleported menus.
export function provideLlamaCppBrowserSettingsTypography({ presentation }: { presentation: () => 'settings' | 'embedded' }): void {
  provide(settingsTypographyKey, computed(() => presentation() === 'settings'));
}

export function useLlamaCppBrowserSettingsTypography(): ComputedRef<boolean> {
  return inject(settingsTypographyKey, undefined) ?? computed(() => false);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
