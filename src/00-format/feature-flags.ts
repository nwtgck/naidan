import * as dtozod from '@/utils/dtozod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/utils/dtozod/missingAsUndefined';

const FeatureFlagStatusSchema = dtozod.enum(['enabled', 'disabled']);

const FeatureFlagSchemas = {
  volume: resolveMissingAsUndefined(dtozod.object({
    status: FeatureFlagStatusSchema,
    compatibilityRiskAcknowledgedAt: missingAsUndefined(dtozod.number()),
    params: dtozod.object({}),
  })),
  wesh_tool: resolveMissingAsUndefined(dtozod.object({
    status: FeatureFlagStatusSchema,
    compatibilityRiskAcknowledgedAt: missingAsUndefined(dtozod.number()),
    params: dtozod.object({}),
  })),
} as const;

const FeatureFlagsSchema = dtozod.object(FeatureFlagSchemas);

export type FeatureFlags = dtozod.infer<typeof FeatureFlagsSchema>;
export type FeatureFlagName = keyof FeatureFlags;

function createDefaultFeatureFlag<TFeature extends FeatureFlagName>({ feature }: {
  feature: TFeature,
}): FeatureFlags[TFeature] {
  // Keep each feature explicit so this file remains the template for future flags,
  // even when current experimental features ship enabled by default.
  switch (feature) {
  case 'volume':
    return {
      status: 'enabled',
      compatibilityRiskAcknowledgedAt: 0,
      params: {},
    } as FeatureFlags[TFeature];
  case 'wesh_tool':
    return {
      status: 'enabled',
      compatibilityRiskAcknowledgedAt: 0,
      params: {},
    } as FeatureFlags[TFeature];
  default: {
    const _exhaustive: never = feature;
    return _exhaustive;
  }
  }
}

export function createDefaultFeatureFlags(): FeatureFlags {
  return {
    volume: createDefaultFeatureFlag({ feature: 'volume' }),
    wesh_tool: createDefaultFeatureFlag({ feature: 'wesh_tool' }),
  };
}

function parseFeatureFlag<TFeature extends FeatureFlagName>({ feature, value }: {
  feature: TFeature,
  value: unknown,
}): FeatureFlags[TFeature] {
  switch (feature) {
  case 'volume': {
    const parsed = FeatureFlagSchemas.volume.safeParse(value);
    return parsed.success ? parsed.data as FeatureFlags[TFeature] : createDefaultFeatureFlag({ feature });
  }
  case 'wesh_tool': {
    const parsed = FeatureFlagSchemas.wesh_tool.safeParse(value);
    return parsed.success ? parsed.data as FeatureFlags[TFeature] : createDefaultFeatureFlag({ feature });
  }
  default: {
    const _exhaustive: never = feature;
    return _exhaustive;
  }
  }
}

export function featureFlagsRecord({ key }: { key: string }) {
  return {
    key,
    mount<T>({ connect }: { connect({ key, defaults, read, write }: {
      key: string,
      defaults: FeatureFlags,
      read({ text }: { text: string }): FeatureFlags,
      write({ flags }: { flags: FeatureFlags }): string,
    }): T }): T {
      return connect({
        key,
        defaults: createDefaultFeatureFlags(),
        read({ text }) {
          if (text) {
            try {
              const value: unknown = JSON.parse(text);
              if (value && typeof value === 'object') {
                const record = value as Partial<Record<FeatureFlagName, unknown>>;
                return FeatureFlagsSchema.parse({
                  volume: parseFeatureFlag({ feature: 'volume', value: record.volume }),
                  wesh_tool: parseFeatureFlag({ feature: 'wesh_tool', value: record.wesh_tool }),
                });
              }
            } catch {
              // Fall through to defaults for malformed localStorage state.
            }
          }
          return createDefaultFeatureFlags();
        },
        write({ flags }) {
          return JSON.stringify(FeatureFlagsSchema.parse(flags));
        },
      });
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
