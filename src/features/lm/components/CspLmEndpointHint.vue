<script setup lang="ts">
import { computed } from 'vue';
import type { Endpoint } from '@/01-models/types';
import { useSettings } from '@/composables/useSettings';
import { isFakeLmEndpointUrl, type FakeLmDebugModeStatus } from '@/features/fake-lm';
import CspMessageHint from '@/components/csp/CspMessageHint.vue';
import type { CspHintActivityForDisplayOnly } from '@/components/csp/types';
import CspRpcEndpointHint from '@/features/naidan-rpc-integration/components/CspRpcEndpointHint.vue';

/**
 * Place warnings and hints where people using Naidan are focused
 * at that point in their task.
 *
 * While editing a setting, show the warning beside the relevant field.
 * After an action fails, show the hint directly below its error message.
 *
 * Keep advance warnings compact. Expanded guidance may use more space.
 * activityForDisplayOnly selects copy, never an endpoint or an action.
 */
const props = defineProps<{
  endpoint: Endpoint | undefined,
  operation: 'models' | 'chat' | 'image' | 'running-models' | 'unload-model',
  presentation: 'compact' | 'error',
  fakeLmDebugModeStatus: FakeLmDebugModeStatus | undefined,
  activityForDisplayOnly: CspHintActivityForDisplayOnly | undefined,
}>();
const { settings } = useSettings();

const activityForDisplayOnly = computed<CspHintActivityForDisplayOnly | undefined>(() => {
  try {
    if (props.activityForDisplayOnly !== undefined) {
      return props.activityForDisplayOnly;
    }
    const operation = props.operation;
    switch (operation) {
    case 'models': return 'model-list';
    case 'chat': return 'response-generation';
    case 'image': return 'image-generation';
    case 'running-models': return 'running-models';
    case 'unload-model': return 'unload-model';
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unhandled LM display activity: ${String(exhaustive)}`);
    }
    }
  } catch {
    // Copy context is optional and must not escape into the existing controls.
    return undefined;
  }
});

// This adapter only describes the transport already selected by the feature.
// It never returns a diagnosis to the controls or changes their execution.
const target = computed(() => {
  try {
    const endpoint = props.endpoint;
    if (endpoint === undefined) {
      return undefined;
    }
    switch (endpoint.type) {
    case 'openai':
    case 'ollama': {
      if (endpoint.url === '') {
        return undefined;
      }
      const fakeStatus = props.fakeLmDebugModeStatus ?? settings.value.experimental?.fakeLm ?? 'disabled';
      if (fakeStatus === 'enabled' && isFakeLmEndpointUrl({ endpointUrl: endpoint.url })) {
        return undefined;
      }
      const endpointType = endpoint.type;
      const apiPaths = (() => {
        switch (endpointType) {
        case 'openai': return {
          models: '/models',
          chat: '/chat/completions',
          image: undefined,
          'running-models': undefined,
          'unload-model': undefined,
        };
        case 'ollama': return {
          models: '/api/tags',
          chat: '/api/chat',
          image: '/api/generate',
          'running-models': '/api/ps',
          'unload-model': '/api/generate',
        };
        default: {
          const exhaustive: never = endpointType;
          throw new Error(`Unhandled LM hint endpoint type: ${exhaustive}`);
        }
        }
      })();
      const apiPath = apiPaths[props.operation];
      return apiPath === undefined ? undefined : { kind: 'connection' as const, endpoint: endpoint.url, apiPath };
    }
    case 'naidan_rpc':
    case 'transformers_js':
    case 'llama_cpp_browser':
    case 'browser_provided_lm':
    case 'unsupported_experimental_endpoint': return undefined;
    default: {
      const exhaustive: never = endpoint;
      throw new Error(`Unhandled LM hint endpoint: ${String(exhaustive)}`);
    }
    }
  } catch {
    return undefined;
  }
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <CspRpcEndpointHint v-if="activityForDisplayOnly !== undefined && endpoint?.type === 'naidan_rpc'" :registration-id="endpoint.registrationId" :presentation="presentation" :activity-for-display-only="activityForDisplayOnly" />
  <CspMessageHint v-else-if="activityForDisplayOnly !== undefined" :target="target" :presentation="presentation" :activity-for-display-only="activityForDisplayOnly" />
</template>
