import { describe, expect, it } from 'vitest';
import * as hosted from './profile-policy';
import * as standalone from './profile-policy-standalone';
import { chatProfileSchema, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';

describe('build-specific llama profile policy', () => {
  it('keeps auto and only the four ordinary hosted profiles', () => {
    expect(hosted.defaultRuntimeOptions()).toEqual({ profile: 'auto' });
    expect(new Set(hosted.selectableProfiles)).toEqual(new Set(['auto', ...chatProfileSchema.options]));
    expect(hosted.selectableProfiles).toEqual(['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'cpu-wasm32']);
    for (const profile of hosted.selectableProfiles) {
      expect(hosted.parseRuntimeOptions({ options: { profile } })).toEqual({ profile });
    }
  });

  it('defaults standalone to auto and exposes only the two embedded JSPI profiles', () => {
    expect(standalone.defaultRuntimeOptions()).toEqual({ profile: 'auto' });
    expect(standalone.selectableProfiles).toEqual(['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi']);
    for (const profile of standalone.selectableProfiles) {
      expect(standalone.parseRuntimeOptions({ options: { profile } })).toEqual({ profile });
    }
    expect(standalone.parseRuntimeOptions({ options: { profile: 'webgpu-wasm64-jspi' } })).toEqual({ profile: 'webgpu-wasm64-jspi' });
  });

  it.each(['cpu-wasm32', 'webgpu-wasm64-jspi-gpu-profile', 'webgpu-wasm32-asyncify'] as const)('rejects %s rather than falling back in standalone', profile => {
    expect(() => standalone.parseRuntimeOptions({ options: { profile } })).toThrow('unavailable');
  });
});

it('allows profiling only through the performance policy, never normal chat', () => {
  const options = { profile: 'webgpu-wasm64-jspi-gpu-profile' } as const;
  expect(() => hosted.parseRuntimeOptions({ options })).toThrow('unavailable');
  expect(hosted.parsePerformanceRuntimeOptions({ options })).toEqual(options);
  expect(() => standalone.parsePerformanceRuntimeOptions({ options })).toThrow('unavailable');
  expect(runtimeOptionsSchema.safeParse({ profile: 'cpu-wasm64' }).success).toBe(false);
});
