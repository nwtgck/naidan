import { createValidatedMessagePort } from '@/utils/worker-transport';
import { z } from 'zod';
import processor from './capture.worklet.js?raw';
import hostedProcessorUrl from './capture.worklet.js?url&no-inline';
import { createLiveResampler } from './audio-resampler';

const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pcm'), pcm: z.instanceof(Float32Array).refine(value => value.length > 0 && value.length <= 2048 && value.every(Number.isFinite)) }).strict(),
  z.object({ type: z.literal('finished') }).strict(),
]);
export type LiveCaptureSettings = {
  autoGainControl: boolean | undefined,
  echoCancellation: boolean | undefined,
  noiseSuppression: boolean | undefined,
  sampleRate: number | undefined,
  channelCount: number | undefined,
  latency: number | undefined,
};
export type LiveCapture = {
  finish({ action }: { action: 'send' | 'discard' }): Promise<void>,
  getSettings?: () => LiveCaptureSettings | undefined,
};

/** Permission may resolve after navigation. The lifetime signal also owns the
 * pending permission, module load, tracks and the microphone's AudioContext. */
export async function openLiveCapture({ sampleRate, signal, onPcm, onError }: {
  sampleRate: number, signal: AbortSignal,
  onPcm: ({ pcm }: { pcm: Float32Array }) => void,
  onError: ({ error }: { error: unknown }) => void,
}): Promise<LiveCapture> {
  signal.throwIfAborted();
  const context = new AudioContext();
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let sink: GainNode | undefined;
  let closed = false;
  let transport: ReturnType<typeof createValidatedMessagePort<typeof eventSchema, z.ZodLiteral<'finish'>>> | undefined;
  let accepting = true;
  let finishing: Promise<void> | undefined;
  const flushed = Promise.withResolvers<void>();
  function clean(): void {
    if (closed) {
      return;
    }
    closed = true;
    accepting = false;
    context.onstatechange = null;
    signal.removeEventListener('abort', abort);
    stream?.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    source?.disconnect();
    if (node) {
      transport?.close();
      node.disconnect();
    }
    sink?.disconnect();
    void context.close().catch(() => {});
    flushed.resolve();
  }
  function abort(): void {
    clean();
  }
  function fail({ error }: { error: unknown }): void {
    if (!closed) {
      clean();
      onError({ error });
    }
  }
  function contextFailure(): Error | undefined {
    const state = context.state;
    switch (state) {
    case 'running': return undefined;
    case 'suspended': case 'interrupted': case 'closed': return new Error(`Live microphone audio context is ${state}`);
    default: {
      const exhaustive: never = state;
      throw new Error(String(exhaustive));
    }
    }
  }
  function contextStateChanged(): void {
    if (!closed) {
      const error = contextFailure();
      if (error) {
        fail({ error });
      }
    }
  }
  signal.addEventListener('abort', abort, { once: true });
  try {
    const resampler = createLiveResampler({ inputRate: context.sampleRate, outputRate: sampleRate });
    // Start resume in the user gesture, before awaiting microphone permission.
    const resumed = context.resume();
    void resumed.catch(() => {});
    const permission = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    // A browser permission prompt cannot be cancelled, but late tracks can.
    void permission.then(value => {
      if (signal.aborted || closed) {
        value.getTracks().forEach(track => track.stop());
      }
    }, () => {});
    const aborted = Promise.withResolvers<never>();
    const rejectAbort = () => aborted.reject(new DOMException('Live microphone cancelled', 'AbortError'));
    signal.addEventListener('abort', rejectAbort, { once: true });
    try {
      if (signal.aborted) {
        rejectAbort();
      }
      stream = await Promise.race([permission, aborted.promise]);
    } finally {
      signal.removeEventListener('abort', rejectAbort);
    }
    signal.throwIfAborted();
    await resumed;
    signal.throwIfAborted();
    if (__BUILD_MODE_IS_STANDALONE__) {
      const url = URL.createObjectURL(new Blob([processor], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    } else {
      // Hosted deployments can restrict script-src to the application origin.
      await context.audioWorklet.addModule(hostedProcessorUrl);
    }
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'naidan-live-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    sink = context.createGain();
    sink.gain.value = 0;
    transport = createValidatedMessagePort({
      port: node.port,
      incomingSchema: eventSchema,
      outgoingSchema: z.literal('finish'),
      onError: ({ reason }) => fail({ error: reason }),
      onMessage: ({ message }) => {
        if (!accepting) {
          return;
        }
        try {
          switch (message.type) {
          case 'pcm': {
            const pcm = resampler.push({ pcm: message.pcm });
            if (pcm.length) {
              onPcm({ pcm });
            }
            break;
          }
          case 'finished': {
            const pcm = resampler.finish();
            if (pcm.length) {
              onPcm({ pcm });
            }
            flushed.resolve();
            break;
          }
          default: {
            const exhaustive: never = message;
            throw new Error(String(exhaustive));
          }
          }
        } catch (error) {
          fail({ error });
        }
      },
    });
    node.onprocessorerror = () => fail({ error: new Error('Live microphone processor failed') });
    for (const track of stream.getAudioTracks()) {
      track.onended = () => fail({ error: new Error('Live microphone disconnected') });
    }
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
    const error = contextFailure();
    if (error) {
      throw error;
    }
    // Initial resume may legitimately be pending. Monitor only after capture
    // is ready, and detach before our own close so cleanup is never an error.
    context.onstatechange = contextStateChanged;
    return {
      getSettings() {
        if (closed) {
          return undefined;
        }
        try {
          const settings = stream?.getAudioTracks()[0]?.getSettings?.();
          if (settings === undefined) {
            return undefined;
          }
          const latency: unknown = Reflect.get(settings, 'latency');
          // Copy an explicit safe subset. Never expose IDs, labels or infer defaults.
          return {
            autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : undefined,
            echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : undefined,
            noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : undefined,
            sampleRate: typeof settings.sampleRate === 'number' && Number.isFinite(settings.sampleRate) && settings.sampleRate > 0 ? settings.sampleRate : undefined,
            channelCount: typeof settings.channelCount === 'number' && Number.isSafeInteger(settings.channelCount) && settings.channelCount > 0 ? settings.channelCount : undefined,
            latency: typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 ? latency : undefined,
          };
        } catch {
          return undefined;
        }
      },
      finish({ action }) {
        if (finishing) {
          return finishing;
        }
        if (closed) {
          return Promise.resolve();
        }
        switch (action) {
        case 'discard': clean();
          return Promise.resolve();
        case 'send': break;
        default: {
          const exhaustive: never = action;
          throw new Error(String(exhaustive));
        }
        }
        transport?.send({ message: 'finish', transferables: [] });
        finishing = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([flushed.promise, new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Live microphone flush timed out')), 2000);
            })]);
            signal.throwIfAborted();
          } finally {
            clearTimeout(timer);
            clean();
          }
        })();
        return finishing;
      },
    };
  } catch (error) {
    clean();
    throw error;
  }
}

export const TEST_ONLY = {
};
