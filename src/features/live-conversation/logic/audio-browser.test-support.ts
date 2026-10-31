import { vi } from 'vitest';

/** Deliberately local Web Audio fakes. Tests assert ownership and packet order,
 * not real hardware, browser permissions or device latency. */
export function liveAudioBrowserFixture() {
  const track = { stop: vi.fn(), onended: undefined as (() => void) | undefined };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const permission = Promise.withResolvers<typeof stream>();
  const media = { getUserMedia: vi.fn(() => permission.promise) };
  const contexts: FakeAudioContext[] = [];
  const nodes: FakeWorklet[] = [];
  const buffers: Float32Array[] = [];
  const sourceNodes: { start: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn>, disconnect: ReturnType<typeof vi.fn>, onended: (() => void) | null }[] = [];
  class FakeAudioContext {
    sampleRate = 48000;
    currentTime = 0;
    state: 'running' | 'suspended' | 'closed' = 'running';
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => {}) };
    resume = vi.fn(async () => {
      this.state = 'running';
    });
    close = vi.fn(async () => {
      this.state = 'closed';
    });
    createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
    createBuffer = vi.fn((_channels: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: vi.fn((pcm: Float32Array) => {
        buffers.push(pcm.slice());
      }),
    }));
    createBufferSource = vi.fn(() => {
      const node = { buffer: undefined, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
      sourceNodes.push(node);
      return node;
    });

    constructor() {
      contexts.push(this);
    }
  }
  class FakeWorklet {
    port = {
      onmessage: undefined as (({ data }: { data: unknown }) => void) | undefined,
      onmessageerror: null as (() => void) | null,
      close: vi.fn(),
      start: vi.fn(),
      postMessage: vi.fn((message: unknown) => {
        if (message === 'finish') {
          this.deliver({ data: { type: 'finished' } });
        }
      }),
    };
    connect = vi.fn(); disconnect = vi.fn(); onprocessorerror: (() => void) | undefined;

    constructor() {
      nodes.push(this);
    }

    deliver({ data }: { data: unknown }): void {
      this.port.onmessage?.({ data });
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorklet);
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media });
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:live-audio-test');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  return {
    contexts,
    nodes,
    permission,
    media,
    stream,
    track,
    buffers,
    sourceNodes,
    createUrl,
    revokeUrl,
    [Symbol.dispose]() {
      if (descriptor) {
        Object.defineProperty(navigator, 'mediaDevices', descriptor);
      } else {
        Reflect.deleteProperty(navigator, 'mediaDevices');
      }
      createUrl.mockRestore();
      revokeUrl.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

export const TEST_ONLY = {
};
