import type { VueWrapper } from '@vue/test-utils';
import SettingsSelect from '@/components/SettingsSelect.vue';

export function modelConfigurationControl({ view, field }: { view: VueWrapper, field: 'quantization' | 'companion' }) {
  const control = view.findAllComponents<typeof SettingsSelect>(SettingsSelect).find(candidate => candidate.vm.$attrs['data-testid'] === `llama-model-${field}`);
  if (!control) {
    throw new Error(`Missing model ${field} control`);
  }
  return control;
}
