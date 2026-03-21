import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { FEATURE_FLAGS_STORAGE_KEY } from '@/models/feature-flags';

describe('useFeatureFlags', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('defaults all feature flags to disabled', async () => {
    const { useFeatureFlags } = await import('./useFeatureFlags');
    const { featureFlags, isFeatureEnabled } = useFeatureFlags();

    expect(featureFlags.value.volume.status).toBe('disabled');
    expect(featureFlags.value.wesh_tool.status).toBe('disabled');
    expect(isFeatureEnabled({ feature: 'volume' })).toBe(false);
    expect(isFeatureEnabled({ feature: 'wesh_tool' })).toBe(false);
  });

  it('falls back to defaults when localStorage contains invalid data', async () => {
    localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, '{"volume":{"status":"broken"}}');
    const { useFeatureFlags } = await import('./useFeatureFlags');
    const { featureFlags } = useFeatureFlags();

    expect(featureFlags.value.volume.status).toBe('disabled');
    expect(featureFlags.value.wesh_tool.status).toBe('disabled');
  });

  it('falls back only the invalid feature while preserving other valid features', async () => {
    localStorage.setItem(
      FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({
        volume: {
          status: 'enabled',
          compatibilityRiskAcknowledgedAt: 123,
          params: {},
        },
        wesh_tool: {
          status: 'broken',
          compatibilityRiskAcknowledgedAt: 456,
          params: {},
        },
      })
    );

    const { useFeatureFlags } = await import('./useFeatureFlags');
    const { featureFlags } = useFeatureFlags();

    expect(featureFlags.value.volume.status).toBe('enabled');
    expect(featureFlags.value.volume.compatibilityRiskAcknowledgedAt).toBe(123);
    expect(featureFlags.value.wesh_tool.status).toBe('disabled');
    expect(featureFlags.value.wesh_tool.compatibilityRiskAcknowledgedAt).toBeUndefined();
  });

  it('persists compatibility acknowledgment when enabling a feature', async () => {
    const { useFeatureFlags } = await import('./useFeatureFlags');
    const { featureFlags, setFeatureEnabled } = useFeatureFlags();

    setFeatureEnabled({
      feature: 'volume',
      enabled: true,
    });
    await nextTick();

    expect(featureFlags.value.volume.status).toBe('enabled');
    expect(featureFlags.value.volume.compatibilityRiskAcknowledgedAt).toEqual(expect.any(Number));

    const raw = localStorage.getItem(FEATURE_FLAGS_STORAGE_KEY);
    expect(raw).toContain('"status":"enabled"');
  });
});
