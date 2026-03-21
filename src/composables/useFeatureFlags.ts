import { computed } from 'vue';
import { useStorage } from '@vueuse/core';
import {
  createDefaultFeatureFlags,
  FEATURE_FLAGS_STORAGE_KEY,
  FeatureFlagsSchema,
  parseFeatureFlag,
  type FeatureFlagName,
  type FeatureFlags,
} from '@/models/feature-flags';

const featureFlags = useStorage<FeatureFlags>(
  FEATURE_FLAGS_STORAGE_KEY,
  createDefaultFeatureFlags(),
  localStorage,
  {
    serializer: {
      read: (value) => {
        if (!value) {
          return createDefaultFeatureFlags();
        }

        try {
          const parsed = JSON.parse(value) as unknown;
          if (parsed && typeof parsed === 'object') {
            const record = parsed as Partial<Record<FeatureFlagName, unknown>>;
            const recovered: FeatureFlags = {
              volume: parseFeatureFlag({
                feature: 'volume',
                value: record.volume,
              }),
              wesh_tool: parseFeatureFlag({
                feature: 'wesh_tool',
                value: record.wesh_tool,
              }),
            };

            return FeatureFlagsSchema.parse(recovered);
          }
        } catch {
          // Fall through to defaults for malformed localStorage state.
        }

        return createDefaultFeatureFlags();
      },
      write: (value) => JSON.stringify(FeatureFlagsSchema.parse(value)),
    },
  }
);

export function useFeatureFlags() {
  const isFeatureEnabled = ({ feature }: { feature: FeatureFlagName }) => {
    return featureFlags.value[feature].status === 'enabled';
  };

  const setFeatureEnabled = ({ feature, enabled }: {
    feature: FeatureFlagName;
    enabled: boolean;
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
    feature: TFeature;
    params: FeatureFlags[TFeature]['params'];
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
    __testOnly: {
      reset: () => {
        featureFlags.value = createDefaultFeatureFlags();
      },
    },
  };
}
