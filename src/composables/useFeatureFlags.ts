import { localStorageFormat } from '@/00-format/01-layout/layout';
import { computed } from 'vue';
import { useStorage } from '@vueuse/core';
import {
  createDefaultFeatureFlags,
  type FeatureFlagName,
  type FeatureFlags,
} from '@/00-format/feature-flags';

const featureFlags = localStorageFormat.featureFlags.mount({
  connect: ({ key, defaults, read, write }) => useStorage<FeatureFlags>(key, defaults, localStorage, {
    serializer: { read: text => read({ text }), write: flags => write({ flags }) },
  }),
});

export function useFeatureFlags() {
  const isFeatureEnabled = ({ feature }: { feature: FeatureFlagName }) => {
    return featureFlags.value[feature].status === 'enabled';
  };

  const setFeatureEnabled = ({ feature, enabled }: {
    feature: FeatureFlagName,
    enabled: boolean,
  }) => {
    const current = featureFlags.value[feature];
    featureFlags.value = {
      ...featureFlags.value,
      [feature]: {
        ...current,
        status: enabled ? 'enabled' : 'disabled',
        compatibilityRiskAcknowledgedAt: enabled ? Date.now() : undefined,
      },
    };
  };

  const setFeatureParams = <TFeature extends FeatureFlagName>({ feature, params }: {
    feature: TFeature,
    params: FeatureFlags[TFeature]['params'],
  }) => {
    featureFlags.value = {
      ...featureFlags.value,
      [feature]: {
        ...featureFlags.value[feature],
        params,
      },
    };
  };

  const enabledFeatures = computed(() => {
    return Object.entries(featureFlags.value)
      .filter(([, value]) => value.status === 'enabled')
      .map(([key]) => key as FeatureFlagName);
  });

  return {
    featureFlags,
    enabledFeatures,
    isFeatureEnabled,
    setFeatureEnabled,
    setFeatureParams,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        reset: () => {
          featureFlags.value = createDefaultFeatureFlags();
        },
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
