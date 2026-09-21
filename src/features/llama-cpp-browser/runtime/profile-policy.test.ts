import { describe, expect, it } from 'vitest';
import * as hosted from './profile-policy';
import * as standalone from './profile-policy-standalone';
import { profileSchema } from '@/features/llama-cpp-browser/types';

describe('build-specific llama profile policy', () => {
  it('keeps auto and all five hosted profiles', () => {
    expect(hosted.defaultRuntimeOptions()).toEqual({ profile: 'auto' });
    expect(new Set(hosted.selectableProfiles)).toEqual(new Set(['auto', ...profileSchema.options]));
    expect(hosted.selectableProfiles).toEqual(['auto', 'webgpu-wasm64-jspi', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify', 'cpu-wasm64', 'cpu-wasm32']);
    for (const profile of hosted.selectableProfiles) expect(hosted.parseRuntimeOptions({ options: { profile } })).toEqual({ profile });
  });
  it('fixes standalone to the one embedded profile', () => {
    expect(standalone.defaultRuntimeOptions()).toEqual({ profile: 'webgpu-wasm64-jspi' });
    expect(standalone.selectableProfiles).toEqual(['webgpu-wasm64-jspi']);
    expect(standalone.parseRuntimeOptions({ options: { profile: 'webgpu-wasm64-jspi' } })).toEqual({ profile: 'webgpu-wasm64-jspi' });
  });
  it.each(['auto', 'cpu-wasm32', 'cpu-wasm64', 'webgpu-wasm32-jspi', 'webgpu-wasm32-asyncify'] as const)('rejects %s rather than falling back in standalone', profile => {
    expect(() => standalone.parseRuntimeOptions({ options: { profile } })).toThrow('unavailable');
  });
});
