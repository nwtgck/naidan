import { beforeEach, describe, expect, it, vi } from 'vitest';
import { liveNativeFixture } from './live-native.test-support';
import { generateLiveAnswer } from './live-output';
import type { LiveNative } from './live-memory';
import type { LiveEvent, LiveCommand } from '@/features/llama-cpp-browser/live-types';
import type { createChatSampler } from './chat-sampler';

vi.mock('./chat-sampler', () => ({
  createChatSampler: vi.fn<typeof createChatSampler>(async ({ core, chain }) => ({
    preservedTokens: new Set<number>(),
    sample: async ({ context }) => core.api.llama_sampler_sample(chain, context, -1),
    dispose: async () => core.api.llama_sampler_free(chain),
  })),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function fixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const f = liveNativeFixture({ pointerBytes });
  f.state.position = 3;
  const native: LiveNative = { core: f.core, model: 10n, context: 20n, projector: 30n, memory: 70n, vocab: 90n, position: 3, capacity: 4096 };
  const prepared = f.prepare({ request: { messages: [{ role: 'user', content: 'hello' }] }, generationPrompt: 'include' });
  const events: LiveEvent[] = [];
  const cancelled = { value: false };
  const run = ({ output, maxSteps, onEvent }: { output: Extract<LiveCommand, { type: 'respond' }>['output'], maxSteps: number, onEvent: ({ event }: { event: LiveEvent }) => Promise<void> }) => generateLiveAnswer({ native, prepared, prompt: '<assistant>', turnId: 'turn', output, maxSteps, interrupted: () => cancelled.value, signal: undefined, onEvent });
  const receive = async ({ event }: { event: LiveEvent }) => {
    events.push(event);
  };
  return {
    ...f,
    native,
    prepared,
    events,
    cancelled,
    run,
    receive,
    [Symbol.dispose]() {
      prepared.dispose();
      expect(f.owned.size).toBe(0);
    },
  };
}

describe.each([4, 8] as const)('live output with %i-byte pointers', pointerBytes => {
  it.each(['text', 'audio', 'mixed'] as const)('sets per-response %s output without reloading weights', async output => {
    using f = fixture({ pointerBytes });
    const result = await f.run({ output, maxSteps: 20, onEvent: f.receive });
    expect(result.finishReason).toBe('stop');
    expect(f.fields.get('mtmd_helper_gen_audio_inp.out_mode')).toBe(({ text: 1, audio: 2, mixed: 3 })[output]);
    expect(f.fields.get('mtmd_helper_gen_audio_inp.n_past')).toBe(3);
    expect(f.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce();
    expect(f.api.llama_sampler_free).toHaveBeenCalledWith(81n);
    const audio = f.events.find(event => event.type === 'audio');
    expect(audio?.type === 'audio' ? Array.from(audio.pcm) : []).toEqual([0.25, 0.5]);
  });

  it('refreshes views after memory growth during a native step', async () => {
    using f = fixture({ pointerBytes });
    f.controls.growDuringStep = true;
    await expect(f.run({ output: 'mixed', maxSteps: 20, onEvent: f.receive })).resolves.toMatchObject({ finishReason: 'stop', text: 'word' });
  });

  it('cooperatively interrupts without flushing unplayed audio', async () => {
    using f = fixture({ pointerBytes });
    const result = await f.run({
      output: 'mixed',
      maxSteps: 20,
      onEvent: async ({ event }) => {
        await f.receive({ event });
        f.cancelled.value = true;
      },
    });
    expect(result.finishReason).toBe('interrupted');
    expect(result.toolCalls).toEqual([]);
    expect(f.api.mtmd_helper_gen_audio_flush).not.toHaveBeenCalled();
  });

  it('releases helper, sampler and records after a consumer failure', async () => {
    using f = fixture({ pointerBytes });
    await expect(f.run({
      output: 'mixed',
      maxSteps: 20,
      onEvent: async () => {
        throw new Error('consumer failed');
      },
    })).rejects.toThrow('consumer failed');
    expect(f.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce();
    expect(f.owned.size).toBe(0);
  });

  it('does not return partially generated tool calls when the step budget runs out', async () => {
    using f = fixture({ pointerBytes });
    f.controls.stopAfter = 20;
    const result = await f.run({ output: 'mixed', maxSteps: 1, onEvent: f.receive });
    expect(result.finishReason).toBe('limit');
    expect(result.toolCalls).toEqual([]);
  });

  it('fails closed on an invalid borrowed output length', async () => {
    using f = fixture({ pointerBytes });
    f.api.mtmd_helper_gen_audio_get_output.mockImplementation(async (_helper, _rate, _data, length) => {
      f.write({ pointer: length, value: 3, size: pointerBytes, signed: false });
      return 0;
    });
    await expect(f.run({ output: 'mixed', maxSteps: 20, onEvent: f.receive })).rejects.toThrow('length');
    expect(f.api.mtmd_helper_gen_audio_free).toHaveBeenCalledOnce();
  });
});
