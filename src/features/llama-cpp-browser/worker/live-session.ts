import { liveInfoSchema, type LiveAnswer, type LiveEventHandler, type LiveInfo, type LiveRequest, type LiveResult } from '@/features/llama-cpp-browser/live-types';
import { LlamaCppBrowserError, type Progress } from '@/features/llama-cpp-browser/types';
import { prepareLiveSession, releaseSession } from './session';
import { readAudioField } from './audio-memory';
import { createAudioCooperator } from './audio-cooperate';
import { captureLiveCheckpoint, createLiveAllocations, freeLiveCheckpoint, restoreLiveCheckpoint, type LiveCheckpoint, type LiveNative } from './live-memory';
import { createLiveTemplateRenderer, deriveLiveTemplate, sliceLivePrompt, type LiveTemplate } from './live-template';
import { evaluateLiveParts, decodeLiveRows } from './live-input';
import { generateLiveAnswer } from './live-output';

type Turn = {
  id: string, phase: 'input' | 'responding' | 'tools' | 'complete',
  checkpoint: LiveCheckpoint, previousFooter: string, previousTurns: number,
  sequence: number, samples: number, hasContent: boolean, answer: LiveAnswer | undefined,
  audio: Float32Array[] | undefined,
};
type Session = {
  id: string, native: LiveNative, info: LiveInfo, template: LiveTemplate,
  render: ReturnType<typeof createLiveTemplateRenderer>,
  footer: string, turns: number, usedToolIds: Set<string>, stream: bigint, turn: Turn | undefined, discardedTurnId: string | undefined,
};

/** Exactly one owner in the ordinary Worker. Public API admission serializes
 * commands; interrupt only sets a flag and never enters native code reentrantly. */
export function createLiveSessionController() {
  let session: Session | undefined;
  let interrupted = false;
  const freeStream = async ({ current }: { current: Session }) => {
    const stream = current.stream;
    current.stream = 0n;
    if (stream) {
      await current.native.core.api.mtmd_audio_stream_free(stream);
    }
  };
  const rollback = async ({ current }: { current: Session }) => {
    await freeStream({ current });
    const turn = current.turn;
    if (!turn) {
      return;
    }
    await restoreLiveCheckpoint({ native: current.native, checkpoint: turn.checkpoint });
    current.footer = turn.previousFooter;
    current.turns = turn.previousTurns;
    current.turn = undefined;
    current.discardedTurnId = turn.id;
    freeLiveCheckpoint({ native: current.native, checkpoint: turn.checkpoint });
  };
  const close = async () => {
    const current = session;
    session = undefined;
    if (!current) {
      return;
    }
    try {
      await freeStream({ current });
    } finally {
      try {
        freeLiveCheckpoint({ native: current.native, checkpoint: current.turn?.checkpoint });
      } finally {
        await releaseSession({ releaseRuntime: false });
      }
    }
  };
  const drain = async ({ current, signal }: { current: Session, signal: AbortSignal | undefined }) => {
    const { core, projector: _projector } = current.native;
    const cooperate = createAudioCooperator({ signal });
    while (true) {
      await cooperate({ force: false });
      const count = await core.api.mtmd_audio_stream_step(current.stream, core.constant({ name: 'LLAMA_TOKEN_NULL' }));
      if (count === -2) {
        throw new Error('Live audio encoder failed');
      }
      if (count === -1 || count === 0) {
        return;
      }
      if (count < -2) {
        throw new Error('Invalid live audio stream status');
      }
      const rows = await core.api.mtmd_audio_stream_get_output_embd(current.stream);
      if (!rows) {
        throw new Error('Missing live audio embeddings');
      }
      await decodeLiveRows({ native: current.native, rows, count });
    }
  };
  return {
    ownsSession: () => session !== undefined,
    interrupt({ sessionId, turnId }: { sessionId: string, turnId: string }): void {
      if (session?.id === sessionId && session.turn?.id === turnId) {
        interrupted = true;
      }
    },
    async execute({ request, signal, onEvent, onProgress }: {
      request: LiveRequest, signal: AbortSignal | undefined, onEvent: LiveEventHandler,
      onProgress: ({ progress }: { progress: Progress }) => void,
    }): Promise<LiveResult> {
      signal?.throwIfAborted();
      switch (request.type) {
      case 'open': {
        if (session) {
          throw new LlamaCppBrowserError({ code: 'busy' });
        }
        try {
          const loaded = await prepareLiveSession({ request: request.prepare, onProgress, signal });
          signal?.throwIfAborted();
          const { core, model, context, projector } = loaded;
          if (!projector || !await core.api.mtmd_support_audio_stream(projector)) {
            throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
          }
          const allocations = createLiveAllocations({ core });
          let outputSampleRate: number;
          try {
            const info = allocations.record({ name: 'mtmd_gen_audio_info' });
            await core.api.mtmd_gen_audio_get_info(info, projector);
            const kind = Number(readAudioField({ core, pointer: info, name: 'mtmd_gen_audio_info', field: 'type', kind: 'i32' }));
            if (kind !== core.constant({ name: 'MTMD_GEN_AUDIO_TYPE_LFM3A' })) {
              throw new LlamaCppBrowserError({ code: 'audio-model-unsupported' });
            }
            outputSampleRate = Number(readAudioField({ core, pointer: info, name: 'mtmd_gen_audio_info', field: 'sample_rate', kind: 'i32' }));
          } finally {
            allocations.release();
          }
          const info = liveInfoSchema.parse({
            type: 'opened',
            sessionId: request.sessionId,
            inputSampleRate: await core.api.mtmd_get_audio_sample_rate(projector),
            outputSampleRate,
            vision: await core.api.mtmd_support_vision(projector) ? 'available' : 'unavailable',
            contextTokens: await core.api.llama_n_ctx(context),
          });
          const vocab = await core.api.llama_model_get_vocab(model);
          const memory = await core.api.llama_get_memory(context);
          if (!memory || !vocab) {
            throw new Error('Missing live model memory');
          }
          const render = createLiveTemplateRenderer({ core, model, instructions: request.instructions, tools: request.tools });
          const template = deriveLiveTemplate({
            render: ({ messages, generationPrompt }) => {
              const prepared = render({ messages, generationPrompt });
              try {
                return prepared.prompt;
              } finally {
                prepared.dispose();
              }
            },
          });
          session = {
            id: request.sessionId,
            info,
            template,
            render,
            footer: '',
            turns: 0,
            usedToolIds: new Set(),
            stream: 0n,
            turn: undefined,
            discardedTurnId: undefined,
            native: { core, model, context, projector, vocab, memory, capacity: info.contextTokens, position: 0 },
          };
          return info;
        } catch (error) {
          await releaseSession({ releaseRuntime: false });
          throw error;
        }
      }
      case 'command': break;
      default: {
        const exhaustive: never = request;
        throw new Error(String(exhaustive));
      }
      }
      const current = session;
      if (!current || current.id !== request.sessionId) {
        throw new Error('Expired live session');
      }
      const { command } = request;
      const { native } = current;
      const { core } = native;
      if (command.type === 'rollback' && !current.turn && command.turnId === current.discardedTurnId) {
        return { type: 'accepted' };
      }
      // Stale control messages must not roll back a newer turn.
      if ('turnId' in command && command.type !== 'begin' && command.turnId !== current.turn?.id) {
        throw new Error('Expired live turn');
      }
      // Admission failures must not rewind a previously completed response.
      switch (command.type) {
      case 'begin':
        if (current.turn && current.turn.phase !== 'complete') {
          throw new Error('Finish or discard the current live turn first');
        }
        if (command.images.length && current.info.vision !== 'available') {
          throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        }
        if (current.turn?.id === command.turnId) {
          throw new Error('Duplicate live turn');
        }
        break;
      case 'audio':
        if (current.turn?.phase !== 'input' || command.sequence !== current.turn.sequence) {
          throw new Error('Out-of-order live audio');
        }
        break;
      case 'respond':
        if (current.turn?.phase !== 'input' || !current.turn.hasContent) {
          throw new Error('Live input is empty or already committed');
        }
        break;
      case 'transcribe':
        if (current.turn?.phase !== 'input' || !current.turn.audio?.length) {
          throw new Error('Live transcription was not enabled for this audio turn');
        }
        break;
      case 'tool-results': {
        const answer = current.turn?.answer;
        if (current.turn?.phase !== 'tools' || !answer || command.results.length !== answer.toolCalls.length
          || command.results.some((result, index) => result.id !== answer.toolCalls[index]?.id)) {
          throw new Error('Tool results do not match the pending live calls');
        }
        break;
      }
      case 'close': case 'reset': case 'rollback': break;
      default: {
        const exhaustive: never = command;
        throw new Error(String(exhaustive));
      }
      }
      try {
        switch (command.type) {
        case 'close': await close();
          return { type: 'accepted' };
        case 'reset': {
          await freeStream({ current });
          const previous = current.turn;
          current.turn = undefined;
          freeLiveCheckpoint({ native, checkpoint: previous?.checkpoint });
          await core.api.llama_memory_clear(native.memory, 1);
          native.position = 0;
          current.footer = '';
          current.turns = 0;
          current.usedToolIds.clear();
          current.discardedTurnId = undefined;
          return { type: 'accepted' };
        }
        case 'rollback': await rollback({ current });
          return { type: 'accepted' };
        case 'begin': {
          const previous = current.turn;
          current.turn = undefined;
          freeLiveCheckpoint({ native, checkpoint: previous?.checkpoint });
          const checkpoint = await captureLiveCheckpoint({ native });
          current.discardedTurnId = undefined;
          let audio: Float32Array[] | undefined;
          switch (command.transcription) {
          case 'on': audio = [];
            break;
          case 'off': audio = undefined;
            break;
          default: {
            const exhaustive: never = command.transcription;
            throw new Error(String(exhaustive));
          }
          }
          current.turn = {
            id: command.turnId,
            phase: 'input',
            checkpoint,
            previousFooter: current.footer,
            previousTurns: current.turns,
            sequence: 0,
            samples: 0,
            audio,
            hasContent: command.text.trim().length > 0 || command.images.length > 0,
            answer: undefined,
          };
          interrupted = false;
          await evaluateLiveParts({
            native,
            parts: [
              { type: 'text', text: current.turns === 0 ? current.template.firstHeader : current.footer + current.template.userHeader, isInput: false },
              ...command.images.map(blob => ({ type: 'image' as const, blob })),
              { type: 'text', text: command.text, isInput: true },
            ],
          });
          return { type: 'accepted' };
        }
        case 'audio': {
          const turn = current.turn!;
          if (turn.samples + command.pcm.length > current.info.inputSampleRate * 180) {
            throw new Error('Live input exceeded three minutes');
          }
          const allocations = createLiveAllocations({ core });
          try {
            if (!current.stream) {
              const params = allocations.record({ name: 'mtmd_audio_stream_params' });
              await core.api.mtmd_audio_stream_params_default(params);
              current.stream = await core.api.mtmd_audio_stream_init(native.projector, params);
              if (!current.stream) {
                throw new Error('Cannot open live audio stream');
              }
            }
            const pointer = allocations.alloc({ bytes: command.pcm.byteLength });
            core.bytes({ pointer, length: command.pcm.byteLength }).set(new Uint8Array(command.pcm.buffer, command.pcm.byteOffset, command.pcm.byteLength));
            if (await core.api.mtmd_audio_stream_push(current.stream, pointer, BigInt(command.pcm.length)) !== 0) {
              throw new Error('Live audio stream is closed');
            }
            await drain({ current, signal });
            turn.audio?.push(command.pcm.slice());
            turn.sequence++;
            turn.samples += command.pcm.length;
            turn.hasContent = true;
          } finally {
            allocations.release();
          }
          return { type: 'accepted' };
        }
        case 'transcribe': {
          const turn = current.turn!;
          // Finish the source encoder before a side inference uses the projector.
          if (current.stream) {
            if (await core.api.mtmd_audio_stream_flush(current.stream, 1) !== 0) {
              throw new Error('Cannot finish live audio input');
            }
            await drain({ current, signal });
            await freeStream({ current });
          }
          const checkpoint = await captureLiveCheckpoint({ native });
          let prepared: ReturnType<Session['render']> | undefined;
          try {
            const render = createLiveTemplateRenderer({ core, model: native.model, instructions: 'Perform ASR.', tools: [] });
            prepared = render({ messages: [{ role: 'user', content: 'Live transcription' }], generationPrompt: 'include' });
            const template = deriveLiveTemplate({
              render: ({ messages, generationPrompt }) => {
                const prompt = render({ messages, generationPrompt });
                try {
                  return prompt.prompt;
                } finally {
                  prompt.dispose();
                }
              },
            });
            await core.api.llama_memory_clear(native.memory, 1);
            const temporary: Session = { ...current, stream: 0n, native: { ...native, position: 0 } };
            try {
              await evaluateLiveParts({ native: temporary.native, parts: [{ type: 'text', text: template.firstHeader, isInput: false }] });
              const allocations = createLiveAllocations({ core });
              try {
                const params = allocations.record({ name: 'mtmd_audio_stream_params' });
                await core.api.mtmd_audio_stream_params_default(params);
                temporary.stream = await core.api.mtmd_audio_stream_init(native.projector, params);
                if (!temporary.stream) {
                  throw new Error('Cannot open transcription audio stream');
                }
                const pointer = allocations.alloc({ bytes: 32000 * 4 });
                for (const pcm of turn.audio!) {
                  signal?.throwIfAborted();
                  if (interrupted) {
                    throw new Error('Live transcription interrupted');
                  }
                  core.bytes({ pointer, length: pcm.byteLength }).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
                  if (await core.api.mtmd_audio_stream_push(temporary.stream, pointer, BigInt(pcm.length)) !== 0) {
                    throw new Error('Cannot encode transcription audio');
                  }
                  await drain({ current: temporary, signal });
                }
                if (await core.api.mtmd_audio_stream_flush(temporary.stream, 1) !== 0) {
                  throw new Error('Cannot finish transcription audio');
                }
                await drain({ current: temporary, signal });
              } finally {
                allocations.release();
              }
              await freeStream({ current: temporary });
              const answer = await generateLiveAnswer({
                native: temporary.native,
                prepared,
                prompt: template.userFooter + template.assistantHeader,
                turnId: turn.id,
                output: 'text',
                maxSteps: 1024,
                interrupted: () => interrupted,
                signal,
                onEvent,
              });
              switch (answer.finishReason) {
              case 'stop': break;
              case 'limit': case 'interrupted': throw new Error('Live transcription did not complete');
              default: {
                const exhaustive: never = answer.finishReason;
                throw new Error(String(exhaustive));
              }
              }
              turn.audio = undefined;
              return { type: 'transcript', turnId: turn.id, text: answer.text };
            } finally {
              await freeStream({ current: temporary });
            }
          } finally {
            try {
              prepared?.dispose();
            } finally {
              try {
                await restoreLiveCheckpoint({ native, checkpoint });
              } finally {
                freeLiveCheckpoint({ native, checkpoint });
              }
            }
          }
        }
        case 'respond': case 'tool-results': {
          const turn = current.turn!;
          let prepared: ReturnType<Session['render']>;
          let prompt: string;
          switch (command.type) {
          case 'respond': {
            if (turn.phase !== 'input' || !turn.hasContent) {
              throw new Error('Live input is empty or already committed');
            }
            if (current.stream) {
              if (await core.api.mtmd_audio_stream_flush(current.stream, 1) !== 0) {
                throw new Error('Cannot finish live audio input');
              }
              await drain({ current, signal });
              await freeStream({ current });
            }
            prepared = current.render({ messages: [{ role: 'user', content: 'Live conversation' }], generationPrompt: 'include' });
            prompt = current.template.userFooter + current.template.assistantHeader;
            break;
          }
          case 'tool-results': {
            const answer = turn.answer;
            if (turn.phase !== 'tools' || !answer || command.results.length !== answer.toolCalls.length
              || command.results.some((result, index) => result.id !== answer.toolCalls[index]?.id)) {
              throw new Error('Tool results do not match the pending live calls');
            }
            const messages = [
              { role: 'user' as const, content: 'Live conversation' },
              { role: 'assistant' as const, content: answer.text, tool_calls: answer.toolCalls },
            ];
            const before = current.render({ messages, generationPrompt: 'omit' });
            let continuation: ReturnType<Session['render']> | undefined;
            try {
              continuation = current.render({ messages: [...messages, ...command.results.map(result => ({ role: 'tool' as const, tool_call_id: result.id, content: result.content }))], generationPrompt: 'include' });
              const prefix = continuation.params.generation_prompt;
              if (!continuation.prompt.startsWith(before.prompt) || !prefix || !continuation.prompt.endsWith(prefix)) {
                throw new Error('Unsupported live tool continuation template');
              }
              const suffix = sliceLivePrompt({ parts: continuation.promptParts, offset: before.prompt.length });
              const end = suffix.reduce((sum, part) => sum + part.text.length, 0) - prefix.length;
              let offset = 0;
              const inputParts = suffix.flatMap(part => {
                const start = offset;
                offset += part.text.length;
                return start < end ? [{ type: 'text' as const, text: part.text.slice(0, end - start), isInput: part.isInput }] : [];
              });
              await evaluateLiveParts({ native, parts: [{ type: 'text', text: current.template.assistantFooter, isInput: false }, ...inputParts] });
              prepared = continuation;
              continuation = undefined;
              prompt = prefix;
            } finally {
              try {
                before.dispose();
              } finally {
                continuation?.dispose();
              }
            }
            break;
          }
          default: {
            const exhaustive: never = command;
            throw new Error(String(exhaustive));
          }
          }
          try {
            turn.phase = 'responding';
            const answer = await generateLiveAnswer({
              native,
              prepared,
              prompt,
              turnId: turn.id,
              output: command.output,
              maxSteps: command.maxSteps,
              interrupted: () => interrupted,
              signal,
              onEvent,
            });
            switch (answer.finishReason) {
            case 'interrupted': await rollback({ current });
              break;
            case 'stop': case 'limit': {
              // The native parser may leave IDs empty. Like the ordinary chat
              // provider/server, assign stable IDs only after a complete call.
              answer.toolCalls = answer.toolCalls.map(call => {
                const { id: sourceId, type, function: fn, ...unhandled } = call;
                unhandled satisfies Record<PropertyKey, never>;
                let id = sourceId;
                if (!id || id.length > 128 || current.usedToolIds.has(id)) {
                  do {
                    id = crypto.randomUUID();
                  } while (current.usedToolIds.has(id));
                }
                if (current.usedToolIds.size >= 4096) {
                  throw new Error('Live tool call history is full');
                }
                current.usedToolIds.add(id);
                return { id, type, function: fn };
              });
              turn.phase = answer.toolCalls.length ? 'tools' : 'complete';
              turn.answer = answer;
              current.footer = current.template.assistantFooter;
              current.turns = turn.previousTurns + 1;
              break;
            }
            default: {
              const exhaustive: never = answer.finishReason;
              throw new Error(String(exhaustive));
            }
            }
            return answer;
          } finally {
            prepared.dispose();
          }
        }
        default: {
          const exhaustive: never = command;
          throw new Error(String(exhaustive));
        }
        }
      } catch (error) {
        // Never continue from partially encoded audio, failed codec state or a
        // partially rendered tool result. Recovery failure retires this session.
        if (session === current) {
          try {
            await rollback({ current });
          } catch {
            await close();
          }
        }
        throw error;
      }
    },
  };
}

export const TEST_ONLY = {
};
