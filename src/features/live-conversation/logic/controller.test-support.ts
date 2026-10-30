import { vi } from 'vitest';
import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import { liveCommandSchema, type LiveScope, type LiveResult, type LiveAnswer } from '@/features/llama-cpp-browser/live-types';
import { createLiveController } from './controller';
import type { decodeLiveAudioFile } from './audio-file';
import type { openLiveCapture } from './audio-capture';
import type { createLivePlayback } from './audio-playback';
import type { openLiveWesh } from './wesh';

export function createLiveControllerFixture() {
  const request = vi.fn<LiveScope['request']>(async ({ command: input, onEvent }) => {
    const command = liveCommandSchema.parse(input);
    switch (command.type) {
    case 'respond': case 'tool-results':
      await onEvent({ event: { type: 'text', text: 'Answer' } });
      return { type: 'answer', turnId: command.turnId, text: 'Answer', toolCalls: [], finishReason: 'stop' };
    case 'transcribe': return { type: 'transcript', turnId: command.turnId, text: 'Recognized words' };
    case 'begin': case 'audio': case 'rollback': case 'reset': case 'close': return { type: 'accepted' };
    default: {
      const exhaustive: never = command;
      throw new Error(String(exhaustive));
    }
    }
  });
  const interrupt = vi.fn<LiveScope['interrupt']>(async () => {});
  const scope: LiveScope = { info: { type: 'opened', sessionId: 'session', inputSampleRate: 16000, outputSampleRate: 24000, vision: 'available', contextTokens: 8192 }, request, interrupt };
  const runLiveSession = vi.fn<LlamaCppBrowserService['runLiveSession']>(async ({ operation, signal }) => {
    signal.throwIfAborted();
    const aborted = Promise.withResolvers<never>();
    const stop = () => aborted.reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    try {
      await Promise.race([operation({ scope }), aborted.promise]);
    } finally {
      signal.removeEventListener('abort', stop);
    }
  });
  const finish = vi.fn(async (_request: { action: 'send' | 'discard' }) => {});
  const capture = vi.fn<typeof openLiveCapture>(async () => ({ finish }));
  const player = { activate: vi.fn(async () => {}), begin: vi.fn(), append: vi.fn(async (_chunk: { pcm: Float32Array, sampleRate: number }) => {}), mute: vi.fn(), stop: vi.fn(), close: vi.fn(async () => {}) };
  const playback = vi.fn<typeof createLivePlayback>(() => player);
  const tools = { tools: [{ type: 'function' as const, function: { name: 'shell_execute', description: 'test shell', parameters: { type: 'object' } } }], execute: vi.fn(async () => 'result'), close: vi.fn(async () => {}) };
  const wesh = vi.fn<typeof openLiveWesh>(async () => tools);
  const decodeFile = vi.fn<typeof decodeLiveAudioFile>(async () => new Float32Array([0.1, 0.2]));
  const onChange = vi.fn();
  const controller = createLiveController({ engine: { runLiveSession }, capture, playback, wesh, decodeFile, onChange });
  return {
    controller,
    decodeFile,
    runLiveSession,
    scope,
    request,
    interrupt,
    capture,
    finish,
    playback,
    player,
    wesh,
    tools,
    onChange,
    async [Symbol.asyncDispose]() {
      await controller.dispose();
    },
  };
}

export function liveAnswer({ turnId, calls }: { turnId: string, calls: LiveAnswer['toolCalls'] }): LiveResult {
  return { type: 'answer', turnId, text: 'Answer', toolCalls: calls, finishReason: 'stop' };
}

export const shellCall: LiveAnswer['toolCalls'][number] = { id: 'call-1', type: 'function', function: { name: 'shell_execute', arguments: '{"shell_script":"ls /workspace"}' } };
export const TEST_ONLY = {
};
