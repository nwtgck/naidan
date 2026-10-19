import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { captureChatOptions } from './chat-options';
import { defaultChatContextTokens, runtimeOptionsSchema } from '@/features/llama-cpp-browser/types';

const host = vi.hoisted(() => ({ load: vi.fn<() => Promise<Settings | null>>() }));
vi.mock('@/00-storage/service', () => ({ storageService: { loadSettings: host.load } }));

beforeEach(() => {
  host.load.mockReset().mockResolvedValue(null);
});

function settings({ contextTokens }: { contextTokens: number | undefined }): Settings {
  return { ...DEFAULT_SETTINGS, endpoint: { type: 'llama_cpp_browser' }, storageType: 'local', experimental: { llamaCppBrowser: { contextTokens } } };
}

describe('accepted chat context preferences', () => {
  it('keeps old options unchanged when the persisted field is absent', async () => {
    expect(defaultChatContextTokens).toBe(32768);
    expect(await captureChatOptions({ options: { profile: 'auto' } })).toStrictEqual({ profile: 'auto' });
    host.load.mockResolvedValue(settings({ contextTokens: undefined }));
    expect(await captureChatOptions({ options: { profile: 'cpu-wasm32' } })).toStrictEqual({ profile: 'cpu-wasm32' });
  });

  it.each([512, 32768, 65536, 131072, 1048576])('accepts an explicit safe allocation target %s', async contextTokens => {
    host.load.mockResolvedValue(settings({ contextTokens }));
    expect(await captureChatOptions({ options: { profile: 'auto' } })).toStrictEqual({ profile: 'auto', contextTokens });
  });

  it('gives explicit runtime options precedence without reading settings', async () => {
    host.load.mockRejectedValue(new Error('must not load'));
    expect(await captureChatOptions({ options: { profile: 'auto', contextTokens: 65536 } })).toStrictEqual({ profile: 'auto', contextTokens: 65536 });
    expect(host.load).not.toHaveBeenCalled();
  });

  it('snapshots caller options before the settings read settles', async () => {
    const pending = Promise.withResolvers<Settings | null>();
    host.load.mockReturnValue(pending.promise);
    const options = { profile: 'auto' as const };
    const accepted = captureChatOptions({ options });
    Object.assign(options, { profile: 'cpu-wasm32', contextTokens: 4096 });
    pending.resolve(settings({ contextTokens: 65536 }));
    expect(await accepted).toStrictEqual({ profile: 'auto', contextTokens: 65536 });
  });

  it.each([0, 511, -1, 65536.5, NaN, Infinity, 1048577])('rejects unsafe stored target %s instead of silently using another capacity', async contextTokens => {
    host.load.mockResolvedValue(settings({ contextTokens }));
    await expect(captureChatOptions({ options: { profile: 'auto' } })).rejects.toThrow();
    expect(runtimeOptionsSchema.safeParse({ profile: 'auto', contextTokens }).success).toBe(false);
  });

  it('preserves storage failures and owns a rejection from an abandoned warmup', async () => {
    const failure = new Error('settings unavailable');
    host.load.mockRejectedValue(failure);
    const pending = captureChatOptions({ options: { profile: 'auto' } });
    await Promise.resolve();
    await expect(pending).rejects.toBe(failure);
  });
});
