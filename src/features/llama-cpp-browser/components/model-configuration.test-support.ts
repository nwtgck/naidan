import type { VueWrapper } from '@vue/test-utils';
import SettingsSelect from '@/components/SettingsSelect.vue';

export function modelConfigurationControl({ view, field }: { view: VueWrapper, field: 'quantization' | 'companion' }) {
  return selectControl({ view, testId: `llama-model-${field}` });
}

export function modelSuggestionQuantizationControl({ view }: { view: VueWrapper }) {
  return selectControl({ view, testId: 'llama-suggestion-quantization' });
}

export function runtimeProfileControl({ view }: { view: VueWrapper }) {
  return selectControl({ view, testId: 'llama-cpp-browser-profile' });
}

function selectControl({ view, testId }: { view: VueWrapper, testId: string }) {
  const control = view.findAllComponents<typeof SettingsSelect>(SettingsSelect).find(candidate => candidate.vm.$attrs['data-testid'] === testId);
  if (!control) {
    throw new Error(`Missing model control: ${testId}`);
  }
  return control;
}
