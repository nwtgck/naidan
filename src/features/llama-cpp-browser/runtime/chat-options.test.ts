import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/01-models/types';
import { captureChatOptions, captureProjectorOptions, captureChatInputOptions, createOperationOptionsCapture } from './chat-options';
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

describe('modality-aware storage preference capture', () => {
  const text = [{ role: 'user' as const, content: 'text' }];
  const image = [{ role: 'user' as const, content: [{ type: 'image' as const, blob: new Blob(['fixture'], { type: 'image/png' }) }] }];

  it('captures projector preferences for explicit warmup even with an explicit text context', async () => {
    const saved = settings({ contextTokens: 65536 });
    saved.experimental!.llamaCppBrowser!.visionBf16Storage = 'legacy-expand';
    host.load.mockResolvedValue(saved);
    expect(await captureProjectorOptions({ options: { profile: 'auto', contextTokens: 4096 } })).toEqual({ profile: 'auto', contextTokens: 4096, visionBf16Storage: 'legacy-expand' });
    expect(host.load).toHaveBeenCalledOnce();
    host.load.mockClear();
    expect(await captureProjectorOptions({ options: { profile: 'auto', contextTokens: 4096, visionBf16Storage: 'retain-checked' } })).toEqual({ profile: 'auto', contextTokens: 4096, visionBf16Storage: 'retain-checked' });
    expect(host.load).not.toHaveBeenCalled();
  });

  it('keeps explicit-context text requests at zero settings reads', async () => {
    host.load.mockRejectedValue(new Error('must not read settings'));
    expect(await captureChatInputOptions({ options: { profile: 'auto', contextTokens: 4096 }, messages: text })).toEqual({ profile: 'auto', contextTokens: 4096 });
    expect(host.load).not.toHaveBeenCalled();
  });

  it('piggybacks storage mode on the existing context read and preserves explicit caller values', async () => {
    const saved = settings({ contextTokens: 65536 });
    saved.experimental!.llamaCppBrowser!.visionBf16Storage = 'legacy-expand';
    host.load.mockResolvedValue(saved);
    expect(await captureChatInputOptions({ options: { profile: 'auto' }, messages: image })).toEqual({ profile: 'auto', contextTokens: 65536, visionBf16Storage: 'legacy-expand' });
    expect(host.load).toHaveBeenCalledOnce();
    host.load.mockClear();
    expect(await captureChatInputOptions({ options: { profile: 'auto', contextTokens: 4096, visionBf16Storage: 'retain-checked' }, messages: image })).toEqual({ profile: 'auto', contextTokens: 4096, visionBf16Storage: 'retain-checked' });
    expect(host.load).not.toHaveBeenCalled();
  });

  it('captures mode exactly once at the first image acceptance when the scope began with explicit context', async () => {
    const saved = settings({ contextTokens: 65536 });
    saved.experimental!.llamaCppBrowser!.visionBf16Storage = 'legacy-expand';
    host.load.mockResolvedValue(saved);
    const scope = createOperationOptionsCapture({ options: { profile: 'auto', contextTokens: 4096 }, kind: 'chat' });
    await scope.initial;
    await scope.forMessages({ messages: text });
    expect(host.load).not.toHaveBeenCalled();
    const first = scope.forMessages({ messages: image });
    expect(await first).toEqual({ profile: 'auto', contextTokens: 4096, visionBf16Storage: 'legacy-expand' });
    saved.experimental!.llamaCppBrowser!.visionBf16Storage = 'retain-checked';
    expect(scope.forMessages({ messages: image })).toBe(first);
    expect((await scope.forMessages({ messages: image })).visionBf16Storage).toBe('legacy-expand');
    expect(host.load).toHaveBeenCalledOnce();
  });

  it('freezes an absent/default mode without re-reading, including a rejected abandoned capture', async () => {
    host.load.mockResolvedValue(settings({ contextTokens: undefined }));
    const scope = createOperationOptionsCapture({ options: { profile: 'auto', contextTokens: 4096 }, kind: 'measurement' });
    const first = scope.forMessages({ messages: image });
    expect((await first).visionBf16Storage).toBeUndefined();
    host.load.mockRejectedValue(new Error('later storage error'));
    expect(scope.forMessages({ messages: image })).toBe(first);
    await scope.forMessages({ messages: text });
    expect(host.load).toHaveBeenCalledOnce();
    const abandoned = createOperationOptionsCapture({ options: { profile: 'auto', contextTokens: 4096 }, kind: 'chat' });
    const rejected = abandoned.forMessages({ messages: image });
    await Promise.resolve();
    await expect(rejected).rejects.toThrow('later storage error');
  });

  it('does not repeat the initial settings read for an image scope whose context was inherited', async () => {
    host.load.mockResolvedValue(settings({ contextTokens: 65536 }));
    const scope = createOperationOptionsCapture({ options: { profile: 'auto' }, kind: 'measurement' });
    const initial = await scope.initial;
    expect(await scope.forMessages({ messages: image })).toBe(initial);
    expect(host.load).toHaveBeenCalledOnce();
  });
});
