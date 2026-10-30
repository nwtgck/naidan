import type { LlamaCppBrowserService } from '@/features/llama-cpp-browser/service-contract';
import type { LiveAnswer, LiveCommand, LiveEventHandler, LiveInfo, LiveScope } from '@/features/llama-cpp-browser/live-types';
import type { VolumeId } from '@/01-models/ids';
import { promiseAllKeyed } from '@/utils/promise';
import { createLiveAudioQueue } from './audio-queue';
import type { openLiveCapture, LiveCapture } from './audio-capture';
import type { createLivePlayback } from './audio-playback';
import type { openLiveWesh, LiveWesh } from './wesh';
import { readLiveShellCall } from './wesh-policy';
import { createLiveAudioMeter, liveAudioSecondsLimit, type decodeLiveAudioFile, type LiveAudioStatistics } from './audio-file';
import { createLiveAudioRetention, type LiveAudioClip } from './audio-retention';

export type LiveTurnSettings = { output: 'text' | 'audio' | 'mixed', transcription: 'on' | 'off' };
export type LiveTurnView = {
  id: string, modelId: string, inputText: string, imageNames: string[], hasAudio: boolean,
  audioSource: { kind: 'microphone' } | { kind: 'file', name: string } | undefined,
  inputAudio: LiveAudioClip | undefined, outputAudio: LiveAudioClip | undefined, inputStatistics: LiveAudioStatistics | undefined,
  transcript: string, answer: string, output: LiveTurnSettings['output'],
  status: 'pending' | 'complete' | 'limit' | 'discarded',
  toolResults: { id: string, command: string, result: string }[],
};
export type LiveViewState = {
  phase: 'idle' | 'loading' | 'ready' | 'preparing-input' | 'recording' | 'transcribing' | 'responding' | 'approval' | 'tool-running' | 'stopping' | 'closing',
  info: LiveInfo | undefined, entries: LiveTurnView[], pendingTools: LiveAnswer['toolCalls'],
  failure: string | undefined, playing: boolean, audioWarning: 'retention-limit' | 'retention-failed' | undefined,
};
export type LiveAttachments = { blob: Blob, name: string }[];
type Turn = { receivedSamples: number, keepAudio: boolean, meter: ReturnType<typeof createLiveAudioMeter>, id: string, settings: LiveTurnSettings, interrupted: boolean, microphone: AbortController,
  capture: LiveCapture | undefined, queue: ReturnType<typeof createLiveAudioQueue> | undefined, rounds: number, nativeStarted: boolean };
type Owned = { modelId: string, lifetime: AbortController, finished: PromiseWithResolvers<void>, release: PromiseWithResolvers<void>,
  ready: PromiseWithResolvers<void>, scope: LiveScope | undefined,
  playback: ReturnType<typeof createLivePlayback>, wesh: LiveWesh | undefined,
  turn: Turn | undefined, operation: Promise<void> | undefined, toolAbort: AbortController | undefined, closing: boolean, stopping: Promise<void> | undefined };

/** All session state is ephemeral. Native/model ownership ends only on close;
 * stop-response is a separate control path, never the lifetime AbortSignal. */
export function createLiveController({ engine, capture, playback, wesh, decodeFile, onChange }: {
  engine: Pick<LlamaCppBrowserService, 'runLiveSession'>,
  capture: typeof openLiveCapture, playback: typeof createLivePlayback, wesh: typeof openLiveWesh, decodeFile: typeof decodeLiveAudioFile,
  onChange: ({ state }: { state: LiveViewState }) => void,
}) {
  let state: LiveViewState = { phase: 'idle', info: undefined, entries: [], pendingTools: [], failure: undefined, playing: false, audioWarning: undefined };
  const retained = createLiveAudioRetention({ maximumBytes: 64 * 1024 * 1024 });
  let owned: Owned | undefined;
  let disposed = false;
  const publish = ({ change }: { change: Partial<LiveViewState> }) => {
    state = { ...state, ...change };
    if (!disposed) {
      onChange({ state });
    }
  };
  const entry = ({ id, change }: { id: string, change: Partial<LiveTurnView> }) => {
    publish({ change: { entries: state.entries.map(item => item.id === id ? { ...item, ...change } : item) } });
  };
  const report = ({ error }: { error: unknown }) => publish({ change: { failure: error instanceof Error ? error.message : String(error) } });
  const current = () => {
    if (!owned?.scope || owned.closing) {
      throw new Error('Live session is not ready');
    }
    return { session: owned, scope: owned.scope };
  };
  function retentionFailed({ turn }: { turn: Turn }): void {
    turn.keepAudio = false;
    retained.drop({ key: `${turn.id}/input` });
    retained.drop({ key: `${turn.id}/output` });
    entry({ id: turn.id, change: { inputAudio: undefined, outputAudio: undefined } });
    publish({ change: { audioWarning: 'retention-failed' } });
  }
  const retain = ({ turn, side, pcm, sampleRate }: { turn: Turn, side: 'input' | 'output', pcm: Float32Array, sampleRate: number }) => {
    if (!turn.keepAudio) {
      return;
    }
    try {
      const result = retained.append({ key: `${turn.id}/${side}`, sampleRate, pcm });
      switch (result) {
      case 'kept': case 'skipped': break;
      case 'limit': publish({ change: { audioWarning: 'retention-limit' } });
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
    } catch {
      retentionFailed({ turn });
    }
  };
  function retainedClip({ turn, side, status }: { turn: Turn, side: 'input' | 'output', status: LiveAudioClip['status'] }): LiveAudioClip | undefined {
    try {
      return retained.finish({ key: `${turn.id}/${side}`, status });
    } catch {
      retentionFailed({ turn });
      return undefined;
    }
  }
  const inputPcm = ({ turn, pcm, sampleRate }: { turn: Turn, pcm: Float32Array, sampleRate: number }) => {
    turn.meter.append({ pcm });
    if (turn.meter.read().seconds > liveAudioSecondsLimit) {
      throw new Error('Live audio input exceeds 180 seconds');
    }
    retain({ turn, side: 'input', pcm, sampleRate });
  };
  const finishInput = ({ turn, status }: { turn: Turn, status: LiveAudioClip['status'] }) => {
    if (!state.entries.find(item => item.id === turn.id)?.hasAudio) {
      return;
    }
    entry({
      id: turn.id,
      change: {
        inputAudio: retainedClip({ turn, side: 'input', status }),
        inputStatistics: turn.meter.read(),
      },
    });
  };
  const events = ({ session, turn, target }: { session: Owned, turn: Turn, target: 'answer' | 'transcript' }): LiveEventHandler => async ({ event }) => {
    if (owned !== session || session.closing || turn.interrupted || session.turn !== turn) {
      return;
    }
    switch (event.type) {
    case 'text':
      switch (target) {
      case 'answer': entry({ id: turn.id, change: { answer: event.text } });
        break;
      case 'transcript': entry({ id: turn.id, change: { transcript: event.text } });
        break;
      default: {
        const exhaustive: never = target;
        throw new Error(String(exhaustive));
      }
      }
      break;
    case 'audio':
      switch (target) {
      case 'answer':
        retain({ turn, side: 'output', pcm: event.pcm, sampleRate: event.sampleRate });
        await session.playback.append({ pcm: event.pcm, sampleRate: event.sampleRate });
        break;
      case 'transcript': throw new Error('Unexpected audio in a text-only transcription');
      default: {
        const exhaustive: never = target;
        throw new Error(String(exhaustive));
      }
      }
      break;
    default: {
      const exhaustive: never = event;
      throw new Error(String(exhaustive));
    }
    }
  };
  const request = async ({ scope, command }: { scope: LiveScope, command: LiveCommand }) => scope.request({ command, onEvent: async () => {} });
  const discard = async ({ session, turn }: { session: Owned, turn: Turn }) => {
    turn.interrupted = true;
    session.playback.stop();
    turn.microphone.abort();
    await turn.capture?.finish({ action: 'discard' });
    await turn.queue?.discard();
    if (turn.nativeStarted && session.scope && !session.closing) {
      await request({ scope: session.scope, command: { type: 'rollback', turnId: turn.id } });
    }
    if (session.turn === turn) {
      session.turn = undefined;
    }
    if (state.entries.some(item => item.id === turn.id)) {
      finishInput({ turn, status: 'partial' });
      entry({ id: turn.id, change: { status: 'discarded', outputAudio: retainedClip({ turn, side: 'output', status: 'partial' }) } });
    } else {
      retained.drop({ key: `${turn.id}/input` });
      retained.drop({ key: `${turn.id}/output` });
    }
    publish({ change: { pendingTools: [] } });
  };
  const exclusive = ({ session, rollback, action }: { session: Owned, rollback: 'new-turn' | 'current-turn' | 'close', action: () => Promise<void> }): Promise<void> => {
    if (session.operation) {
      return Promise.resolve();
    }
    const previousTurn = session.turn;
    const operation = Promise.resolve().then(async () => {
      try {
        await action();
      } catch (error) {
        const interrupted = session.turn?.interrupted;
        if (!session.closing) {
          if (!interrupted) {
            report({ error });
          }
          let turn: Turn | undefined;
          switch (rollback) {
          case 'new-turn': turn = session.turn !== previousTurn ? session.turn : undefined;
            break;
          case 'current-turn': turn = session.turn;
            break;
          case 'close': session.release.resolve();
            break;
          default: {
            const exhaustive: never = rollback;
            throw new Error(String(exhaustive));
          }
          }
          if (turn) {
            try {
              await discard({ session, turn });
            } catch (cleanupError) {
              report({ error: cleanupError });
              session.release.resolve();
            }
          }
        }
      } finally {
        session.operation = undefined;
        if (owned === session && !session.closing && !liveControls({ phase: state.phase }).recording && !liveControls({ phase: state.phase }).approval) {
          publish({ change: { phase: 'ready' } });
        }
      }
    });
    session.operation = operation;
    return operation;
  };
  async function answer({ session, turn, command }: { session: Owned, turn: Turn, command: Extract<LiveCommand, { type: 'respond' | 'tool-results' }> }): Promise<void> {
    if (turn.interrupted || session.closing || !session.scope) {
      return;
    }
    publish({ change: { phase: 'responding', pendingTools: [] } });
    session.playback.begin();
    const result = await session.scope.request({ command, onEvent: events({ session, turn, target: 'answer' }) });
    if (session.closing) {
      return;
    }
    if (result.type !== 'answer' || result.turnId !== turn.id) {
      throw new Error('Invalid live response');
    }
    let status: LiveTurnView['status'];
    let audioStatus: LiveAudioClip['status'];
    switch (result.finishReason) {
    case 'stop': status = 'complete';
      audioStatus = 'complete';
      break;
    case 'limit': status = 'limit';
      audioStatus = 'partial';
      break;
    case 'interrupted': status = 'discarded';
      audioStatus = 'partial';
      break;
    default: {
      const exhaustive: never = result.finishReason;
      throw new Error(String(exhaustive));
    }
    }
    entry({ id: turn.id, change: { answer: result.text, status } });
    if (result.finishReason === 'interrupted' || turn.interrupted) {
      await discard({ session, turn });
      return;
    }
    if (!result.toolCalls.length) {
      entry({ id: turn.id, change: { outputAudio: retainedClip({ turn, side: 'output', status: audioStatus }) } });
    }
    if (result.toolCalls.length) {
      if (!session.wesh || ++turn.rounds > 8) {
        throw new Error('Live tool round limit reached or tools are disabled');
      }
      // Validate every command before offering approval; never execute raw model data.
      for (const call of result.toolCalls) {
        readLiveShellCall({ call });
      }
      session.playback.stop();
      publish({ change: { phase: 'approval', pendingTools: result.toolCalls } });
    }
  }
  const newTurn = ({ session, settings }: { session: Owned, settings: LiveTurnSettings }): Turn => {
    if (state.entries.length >= 64) {
      throw new Error('Clear this conversation before adding more turns');
    }
    session.playback.stop();
    const turn: Turn = { receivedSamples: 0, keepAudio: retained.isEnabled(), meter: createLiveAudioMeter({ sampleRate: session.scope!.info.inputSampleRate }), id: crypto.randomUUID(), settings: { ...settings }, interrupted: false, microphone: new AbortController(), capture: undefined, queue: undefined, rounds: 0, nativeStarted: false };
    session.turn = turn;
    return turn;
  };
  const begin = async ({ session, scope, turn, text, images, audioSource }: {
    session: Owned, scope: LiveScope, turn: Turn, text: string, images: LiveAttachments, audioSource: LiveTurnView['audioSource'],
  }): Promise<void> => {
    await request({ scope, command: { type: 'begin', turnId: turn.id, text, images: images.map(image => image.blob), transcription: audioSource ? turn.settings.transcription : 'off' } });
    turn.nativeStarted = true;
    publish({ change: { failure: undefined, pendingTools: [], entries: [...state.entries, { id: turn.id, modelId: session.modelId, inputText: text, imageNames: images.map(image => image.name), hasAudio: audioSource !== undefined, audioSource, inputAudio: undefined, outputAudio: undefined, inputStatistics: undefined, transcript: '', answer: '', output: turn.settings.output, status: 'pending', toolResults: [] }] } });
    if (turn.interrupted && !session.closing) {
      await discard({ session, turn });
    }
  };
  async function transcribeAndAnswer({ session, scope, turn }: { session: Owned, scope: LiveScope, turn: Turn }): Promise<void> {
    switch (turn.settings.transcription) {
    case 'off': break;
    case 'on': {
      publish({ change: { phase: 'transcribing' } });
      const result = await scope.request({ command: { type: 'transcribe', turnId: turn.id }, onEvent: events({ session, turn, target: 'transcript' }) });
      switch (result.type) {
      case 'transcript':
        if (result.turnId !== turn.id) {
          throw new Error('Invalid live transcript turn');
        }
        if (!turn.interrupted && !session.closing) {
          entry({ id: turn.id, change: { transcript: result.text } });
        }
        break;
      case 'answer': case 'opened': case 'accepted': throw new Error('Invalid live transcript');
      default: {
        const exhaustive: never = result;
        throw new Error(String(exhaustive));
      }
      }
      break;
    }
    default: {
      const exhaustive: never = turn.settings.transcription;
      throw new Error(String(exhaustive));
    }
    }
    if (turn.interrupted || session.closing) {
      return;
    }
    await answer({ session, turn, command: { type: 'respond', turnId: turn.id, output: turn.settings.output, maxSteps: 4096 } });
  }
  async function performInterrupt(): Promise<void> {
    const session = owned;
    const turn = session?.turn;
    if (!session || !turn || session.closing) {
      return;
    }
    turn.interrupted = true;
    session.playback.stop();
    turn.microphone.abort();
    session.toolAbort?.abort();
    publish({ change: { phase: 'stopping', pendingTools: [] } });
    try {
      await session.scope?.interrupt({ turnId: turn.id });
      if (session.operation) {
        await session.operation;
      }
      if (session.turn === turn && !session.closing) {
        await discard({ session, turn });
      }
    } catch (error) {
      report({ error });
      session.release.resolve();
    } finally {
      if (owned === session && !session.closing) {
        publish({ change: { phase: 'ready' } });
      }
    }
  }
  function interrupt(): Promise<void> {
    const session = owned;
    if (!session) {
      return Promise.resolve();
    }
    if (session.stopping) {
      return session.stopping;
    }
    const stopping = Promise.resolve().then(performInterrupt).finally(() => {
      session.stopping = undefined;
    });
    session.stopping = stopping;
    return stopping;
  }
  async function close(): Promise<void> {
    const session = owned;
    if (!session) {
      return;
    }
    if (!session.closing) {
      session.closing = true;
      publish({ change: { phase: 'closing', pendingTools: [] } });
      session.playback.stop();
      session.turn?.microphone.abort();
      session.toolAbort?.abort();
      if (session.turn) {
        session.turn.interrupted = true;
        void session.scope?.interrupt({ turnId: session.turn.id }).catch(() => {});
      }
      session.release.resolve();
      if (!session.scope) {
        session.lifetime.abort();
      }
    }
    // A wedged native call must not keep the microphone or shared lane alive.
    const timer = setTimeout(() => session.lifetime.abort(), 10000);
    try {
      await session.finished.promise;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    getState: () => state,
    async open({ modelId, instructions, folder }: {
      modelId: string, instructions: string, folder: { volumeId: VolumeId, access: 'read-only' | 'read-write' } | undefined,
    }): Promise<void> {
      if (owned || disposed) {
        return;
      }
      retained.clear();
      const session: Owned = {
        modelId,
        lifetime: new AbortController(),
        finished: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
        ready: Promise.withResolvers<void>(),
        scope: undefined,
        playback: playback({
          onPlaying: ({ playing }) => {
            if (owned === session) {
              publish({ change: { playing } });
            }
          },
        }),
        wesh: undefined,
        turn: undefined,
        operation: undefined,
        toolAbort: undefined,
        closing: false,
        stopping: undefined,
      };
      owned = session;
      publish({ change: { phase: 'loading', failure: undefined, entries: [], pendingTools: [], info: undefined, audioWarning: undefined } });
      // Start the AudioContext inside the user gesture, before model loading.
      const activated = session.playback.activate();
      void (async () => {
        try {
          await activated;
          if (folder) {
            session.wesh = await wesh({ ...folder, signal: session.lifetime.signal });
          }
          session.lifetime.signal.throwIfAborted();
          await engine.runLiveSession({
            modelId,
            instructions,
            tools: session.wesh?.tools ?? [],
            signal: session.lifetime.signal,
            onProgress: () => {},
            operation: async ({ scope }) => {
              session.scope = scope;
              if (session.closing) {
                return;
              }
              publish({ change: { phase: 'ready', info: scope.info } });
              session.ready.resolve();
              await session.release.promise;
              await session.operation;
              await session.turn?.capture?.finish({ action: 'discard' });
              await session.turn?.queue?.discard();
            },
          });
        } catch (error) {
          if (!session.closing) {
            report({ error });
          }
        } finally {
          session.closing = true;
          session.turn?.microphone.abort();
          session.toolAbort?.abort();
          try {
            await session.wesh?.close();
          } catch (error) {
            report({ error });
          }
          try {
            await session.playback.close();
          } catch (error) {
            report({ error });
          }
          if (owned === session) {
            owned = undefined;
            publish({ change: { phase: 'idle', info: undefined, pendingTools: [], playing: false } });
          }
          session.ready.resolve();
          session.finished.resolve();
        }
      })();
      await session.ready.promise;
    },
    send({ text, images, settings }: { text: string, images: LiveAttachments, settings: LiveTurnSettings }): Promise<void> {
      if (!liveControls({ phase: state.phase }).ready || state.playing) {
        return Promise.resolve();
      }
      const { session, scope } = current();
      publish({ change: { phase: 'responding' } });
      return exclusive({
        session,
        rollback: 'new-turn',
        action: async () => {
          await session.playback.activate();
          const turn = newTurn({ session, settings });
          await begin({ session, scope, turn, text, images, audioSource: undefined });
          if (session.closing) {
            return;
          }
          await answer({ session, turn, command: { type: 'respond', turnId: turn.id, output: turn.settings.output, maxSteps: 4096 } });
        },
      });
    },
    sendAudioFile({ text, images, settings, file }: { text: string, images: LiveAttachments, settings: LiveTurnSettings, file: { blob: Blob, name: string } }): Promise<void> {
      if (!liveControls({ phase: state.phase }).ready || state.playing) {
        return Promise.resolve();
      }
      const { session, scope } = current();
      publish({ change: { phase: 'preparing-input', failure: undefined } });
      return exclusive({
        session,
        rollback: 'new-turn',
        action: async () => {
          await session.playback.activate();
          const turn = newTurn({ session, settings });
          // Decode before touching native conversation memory. A corrupt file
          // must not overwrite or roll back the previous completed turn.
          const pcm = await decodeFile({ file: file.blob, sampleRate: scope.info.inputSampleRate, signal: turn.microphone.signal });
          if (turn.interrupted || session.closing) {
            return;
          }
          await begin({ session, scope, turn, text, images, audioSource: { kind: 'file', name: file.name } });
          const size = Math.min(32000, Math.round(scope.info.inputSampleRate * 0.32));
          let sequence = 0;
          for (let offset = 0; offset < pcm.length; offset += size) {
            if (turn.interrupted || session.closing) {
              return;
            }
            const chunk = pcm.slice(offset, offset + size);
            await request({ scope, command: { type: 'audio', turnId: turn.id, pcm: Float32Array.from(chunk), sequence: sequence++ } });
            inputPcm({ turn, pcm: chunk, sampleRate: scope.info.inputSampleRate });
          }
          if (!turn.interrupted && !session.closing) {
            finishInput({ turn, status: 'complete' });
            await transcribeAndAnswer({ session, scope, turn });
          }
        },
      });
    },
    record({ text, images, settings }: { text: string, images: LiveAttachments, settings: LiveTurnSettings }): Promise<void> {
      if (!liveControls({ phase: state.phase }).ready || state.playing) {
        return Promise.resolve();
      }
      const { session, scope } = current();
      publish({ change: { phase: 'preparing-input' } });
      return exclusive({
        session,
        rollback: 'new-turn',
        action: async () => {
          const turn = newTurn({ session, settings });
          // Open capture before awaiting native input/checkpoint work. Both browser
          // permission and AudioContext.resume start in the record button gesture.
          const begun = begin({ session, scope, turn, text, images, audioSource: { kind: 'microphone' } });
          turn.queue = createLiveAudioQueue({
            maximumSamples: scope.info.inputSampleRate * 8,
            send: async ({ pcm, sequence }) => {
              await begun;
              if (session.closing || turn.interrupted) {
                return;
              }
              await request({ scope, command: { type: 'audio', turnId: turn.id, pcm: Float32Array.from(pcm), sequence } });
              inputPcm({ turn, pcm, sampleRate: scope.info.inputSampleRate });
            },
            onError: ({ error }) => {
              report({ error });
              void interrupt();
            },
          });
          const captured = capture({
            sampleRate: scope.info.inputSampleRate,
            signal: turn.microphone.signal,
            onPcm: ({ pcm }) => {
              if (turn.receivedSamples + pcm.length > scope.info.inputSampleRate * liveAudioSecondsLimit) {
                throw new Error('Live audio input exceeds 180 seconds');
              }
              turn.receivedSamples += pcm.length;
              turn.queue?.push({ pcm });
            },
            onError: ({ error }) => {
              report({ error });
              void interrupt();
            },
          });
          try {
            const result = await promiseAllKeyed({ begun, captured });
            turn.capture = result.captured;
          } catch (error) {
            turn.microphone.abort();
            // Permission can still be pending. The capture layer stops late tracks.
            void captured.then(value => value.finish({ action: 'discard' }), () => {});
            throw error;
          }
          if (session.closing || turn.interrupted) {
            await turn.capture.finish({ action: 'discard' });
            return;
          }
          publish({ change: { phase: 'recording' } });
        },
      });
    },
    finishRecording(): Promise<void> {
      if (!liveControls({ phase: state.phase }).recording) {
        return Promise.resolve();
      }
      const { session, scope } = current();
      const turn = session.turn;
      if (!turn) {
        return Promise.resolve();
      }
      publish({ change: { phase: 'responding' } });
      return exclusive({
        session,
        rollback: 'current-turn',
        action: async () => {
          await session.playback.activate();
          await turn.capture?.finish({ action: 'send' });
          await turn.queue?.finish();
          if (turn.interrupted || session.closing) {
            return;
          }
          if (!turn.meter.read().samples) {
            throw new Error('No microphone audio was received');
          }
          finishInput({ turn, status: 'complete' });
          await transcribeAndAnswer({ session, scope, turn });
        },
      });
    },
    approve({ decision }: { decision: 'run' | 'deny' }): Promise<void> {
      if (!liveControls({ phase: state.phase }).approval) {
        return Promise.resolve();
      }
      const { session } = current();
      const turn = session.turn;
      const tool = session.wesh;
      if (!turn || !tool) {
        return Promise.resolve();
      }
      const calls = state.pendingTools;
      publish({ change: { phase: 'tool-running', pendingTools: [] } });
      return exclusive({
        session,
        rollback: 'current-turn',
        action: async () => {
          const controller = new AbortController();
          session.toolAbort = controller;
          const results: { id: string, content: string }[] = [];
          try {
            for (const call of calls) {
              controller.signal.throwIfAborted();
              let content: string;
              switch (decision) {
              case 'run': content = await tool.execute({ call, signal: controller.signal });
                break;
              case 'deny': content = 'The user declined this tool call. Do not retry without a new request.';
                break;
              default: {
                const exhaustive: never = decision;
                throw new Error(String(exhaustive));
              }
              }
              results.push({ id: call.id, content });
              const previous = state.entries.find(value => value.id === turn.id)?.toolResults ?? [];
              entry({ id: turn.id, change: { toolResults: [...previous, { id: call.id, command: readLiveShellCall({ call }).shell_script, result: content }] } });
            }
            await answer({ session, turn, command: { type: 'tool-results', turnId: turn.id, results, output: turn.settings.output, maxSteps: 4096 } });
          } finally {
            session.toolAbort = undefined;
          }
        },
      });
    },
    interrupt,
    mute({ value }: { value: 'on' | 'off' }): void {
      owned?.playback.mute({ value });
    },
    retainAudio({ value }: { value: 'on' | 'off' }): void {
      retained.setEnabled({ value });
      switch (value) {
      case 'on': break;
      case 'off': {
        if (owned?.turn) {
          owned.turn.keepAudio = false;
        }
        publish({ change: { audioWarning: undefined, entries: state.entries.map(item => ({ ...item, inputAudio: undefined, outputAudio: undefined })) } });
        break;
      }
      default: {
        const exhaustive: never = value;
        throw new Error(String(exhaustive));
      }
      }
    },
    reset(): Promise<void> {
      if (!owned) {
        retained.clear();
        publish({ change: { entries: [], pendingTools: [], failure: undefined, audioWarning: undefined } });
        return Promise.resolve();
      }
      if (!liveControls({ phase: state.phase }).ready) {
        return Promise.resolve();
      }
      const { session, scope } = current();
      publish({ change: { phase: 'stopping' } });
      return exclusive({
        session,
        rollback: 'close',
        action: async () => {
          session.playback.stop();
          await request({ scope, command: { type: 'reset' } });
          session.turn = undefined;
          retained.clear();
          publish({ change: { entries: [], pendingTools: [], failure: undefined, audioWarning: undefined } });
        },
      });
    },
    close,
    async dispose(): Promise<void> {
      disposed = true;
      await close();
      retained.clear();
    },
  };
}

export function liveControls({ phase }: { phase: LiveViewState['phase'] }): { ready: boolean, recording: boolean, approval: boolean } {
  switch (phase) {
  case 'ready': return { ready: true, recording: false, approval: false };
  case 'recording': return { ready: false, recording: true, approval: false };
  case 'approval': return { ready: false, recording: false, approval: true };
  case 'idle': case 'loading': case 'preparing-input': case 'transcribing': case 'responding': case 'tool-running': case 'stopping': case 'closing':
    return { ready: false, recording: false, approval: false };
  default: {
    const exhaustive: never = phase;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
