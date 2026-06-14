import { z } from 'zod';
import { missingAsUndefined, resolveMissingAsUndefined } from '@/lib/zod/missingAsUndefined';
import { STORAGE_KEY_PREFIX } from '@/models/constants';

const FeatureFlagStatusSchema = z.enum(['enabled', 'disabled']);

export const FeatureFlagSchemas = {
  volume: resolveMissingAsUndefined(z.object({
    status: FeatureFlagStatusSchema,
    compatibilityRiskAcknowledgedAt: missingAsUndefined(z.number()),
    params: z.object({}),
  })),
  wesh_tool: resolveMissingAsUndefined(z.object({
    status: FeatureFlagStatusSchema,
    compatibilityRiskAcknowledgedAt: missingAsUndefined(z.number()),
    params: z.object({}),
  })),
} as const;

export const FeatureFlagsSchema = z.object(FeatureFlagSchemas);

export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;
export type FeatureFlagName = keyof FeatureFlags;

export const FEATURE_FLAGS_STORAGE_KEY = `${STORAGE_KEY_PREFIX}feature_flags`;

export function createDefaultFeatureFlag<TFeature extends FeatureFlagName>({ feature }: {
  feature: TFeature;
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

export function parseFeatureFlag<TFeature extends FeatureFlagName>({ feature, value }: {
  feature: TFeature;
  value: unknown;
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
