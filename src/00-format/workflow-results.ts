import * as dtozod from '@/utils/dtozod';
import { idToRaw, toToolCallId, type ToolCallId, type VolumeId, type WorkflowStepId } from '@/01-models/ids';
import type { ToolExecutionErrorCode } from '@/01-models/tool';
import type { WorkflowMessage, WorkflowRunRecord } from '@/01-models/workflow';
import { workflowJsonFormat } from './workflow-json';

const manifestName = 'index.json';
const textLimit = 2 * 1024 * 1024;
const maxOutputs = 1000;
const displayLimits = { image: 16 * 1024 * 1024, audio: 64 * 1024 * 1024, text: textLimit };
const resultFilePattern = /^result-[0-9]{4}\.(?:txt|json|jsonl|bin|png|wav)$/;

type ResultValue = { type: 'binary', format?: 'wav' | 'png' }
  | { type: 'text' | 'sequence' | 'json' | 'array' | 'object' | 'conversation' | 'range' | 'model' };
type ResultEncoding = 'text' | 'json' | 'jsonl' | 'binary';
type ResultOutput = { stepId: string, output: string, path: string | null, skipped: string | null, kind?: 'conversation' };
type SavedFile = { volumeId: string, relativePath: string, path: string, size: number };

function resultEncoding({ value }: { value: ResultValue }): { format: ResultEncoding, extension: string } {
  switch (value.type) {
  case 'binary': return { format: 'binary', extension: value.format ?? 'bin' };
  case 'text': return { format: 'text', extension: 'txt' };
  case 'sequence': return { format: 'jsonl', extension: 'jsonl' };
  case 'json': case 'array': case 'object': case 'conversation': return { format: 'json', extension: 'json' };
  case 'range': throw new Error('Iterate ranges before exporting them.');
  case 'model': throw new Error('Model connections cannot be exported as result data.');
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

function createWriter({ status }: { status: Extract<WorkflowRunRecord['status'], 'completed' | 'failed' | 'cancelled'> }) {
  const outputs: ResultOutput[] = [];
  const savedFiles: SavedFile[] = [];
  const volumeIndices = new Map<VolumeId, number>();

  function skipOutput({ stepId, output, reason }: { stepId: WorkflowStepId, output: string, reason: string }): void {
    outputs.push({ stepId: idToRaw({ id: stepId }), output, path: null, skipped: reason });
  }

  return {
    async writeOutput({ stepId, output, value, skipReason, write }: {
      stepId: WorkflowStepId, output: string, value: ResultValue, skipReason(): string | undefined,
      write({ name, format }: { name: string, format: ResultEncoding }): Promise<{ status: 'written' } | { status: 'skipped', reason: string }>,
    }): Promise<void> {
      const position = outputs.length + 1;
      if (position > maxOutputs) {
        throw new Error('Too many result files. Use explicit file outputs inside loops.');
      }
      const reason = skipReason();
      if (reason !== undefined) {
        skipOutput({ stepId, output, reason });
        return;
      }
      const { format, extension } = resultEncoding({ value });
      const name = `result-${String(position).padStart(4, '0')}.${extension}`;
      const result = await write({ name, format });
      switch (result.status) {
      case 'written':
        outputs.push({ stepId: idToRaw({ id: stepId }), output, path: name, skipped: null, ...(value.type === 'conversation' && { kind: 'conversation' }) });
        break;
      case 'skipped': skipOutput({ stepId, output, reason: result.reason });
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`Unknown result write outcome: ${exhaustive}`);
      }
      }
    },
    async writeSavedFile({ volumeId, parts, write }: {
      volumeId: VolumeId, parts: readonly string[], write({ path }: { path: string[] }): Promise<number>,
    }): Promise<void> {
      const folderIndex = volumeIndices.get(volumeId) ?? volumeIndices.size + 1;
      volumeIndices.set(volumeId, folderIndex);
      const path = ['files', `folder-${folderIndex}`, ...parts];
      const size = await write({ path });
      savedFiles.push({ volumeId: idToRaw({ id: volumeId }), relativePath: parts.join('/'), path: path.join('/'), size });
    },
    writeManifest({ writeText }: { writeText({ name, toText }: { name: string, toText(): string }): Promise<void> }): Promise<void> {
      return writeText({ name: manifestName, toText: () => JSON.stringify({ status, outputs, savedFiles }) });
    },
  };
}

const historicalPart = dtozod.discriminatedUnion('type', [
  dtozod.object({ type: dtozod.literal('text'), text: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('reasoning'), text: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('tool_call'), id: dtozod.string(), name: dtozod.string(), arguments: dtozod.string() }),
  dtozod.object({ type: dtozod.literal('tool_result'), id: dtozod.string(), status: dtozod.enum(['success', 'error']), code: dtozod.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']).optional(), content: dtozod.string() }),
]);
const historicalConversation = dtozod.array(dtozod.object({ role: dtozod.enum(['system', 'user', 'assistant', 'tool']), parts: dtozod.array(historicalPart) }));

function readConversation({ text }: { text: string }) {
  if (new TextEncoder().encode(text).byteLength > textLimit) {
    throw new Error('Conversation exceeds the display limit.');
  }
  const messages = historicalConversation.parse(workflowJsonFormat.toDto({ text }));
  if (messages.length > 256 || messages.some(message => message.parts.length > 64)) {
    throw new Error('Conversation exceeds the display limit.');
  }
  return messages.map(({ role, parts }) => ({
    role,
    parts: parts.map(part => {
      switch (part.type) {
      case 'text': case 'reasoning': return part;
      case 'tool_call': case 'tool_result': return { ...part, id: toToolCallId({ raw: part.id }) };
      default: {
        const exhaustive: never = part;
        throw new Error(`Unknown archived conversation part: ${exhaustive}`);
      }
      }
    }),
  }));
}

const manifestSchema = dtozod.object({
  outputs: dtozod.array(dtozod.object({
    stepId: dtozod.string(),
    output: dtozod.string(),
    path: dtozod.string().nullable(),
    kind: dtozod.enum(['conversation']).optional(),
  })),
});

type OpenResultFile = ({ name }: { name: string }) => Promise<Pick<File, 'size' | 'arrayBuffer'>>;

function decodeText({ bytes }: { bytes: ArrayBuffer }): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function listViewableResults({ openFile, signal }: { openFile: OpenResultFile, signal: AbortSignal }) {
  const index = await openFile({ name: manifestName });
  if (index.size > textLimit) {
    throw new Error('Result index exceeds its display limit.');
  }
  signal.throwIfAborted();
  const manifest = manifestSchema.parse(workflowJsonFormat.toDto({ text: decodeText({ bytes: await index.arrayBuffer() }) }));
  if (manifest.outputs.length > maxOutputs || manifest.outputs.some(({ stepId, output, path }) => stepId.length > 4096 || output.length > 4096 || path !== null && !resultFilePattern.test(path))) {
    throw new Error('Invalid Workflow result index.');
  }
  signal.throwIfAborted();
  return manifest.outputs.flatMap((item, offset) => {
    const name = item.path;
    if (name === null || name.endsWith('.bin') || name.endsWith('.jsonl')) {
      return [];
    }
    const type = name.endsWith('.png') ? 'image' : name.endsWith('.wav') ? 'audio' : 'text';
    return [{
      offset,
      name,
      stepId: item.stepId,
      output: item.output,
      async read({ signal }: { signal: AbortSignal }) {
        signal.throwIfAborted();
        const file = await openFile({ name });
        if (file.size > displayLimits[type]) {
          throw new Error('Result exceeds the display limit; use the file browser or archive.');
        }
        const bytes = await file.arrayBuffer();
        signal.throwIfAborted();
        switch (type) {
        case 'image': case 'audio': return { type, bytes } as const;
        case 'text': {
          const text = decodeText({ bytes });
          switch (item.kind) {
          case 'conversation': {
            signal.throwIfAborted();
            return { type: 'conversation', messages: readConversation({ text }) } as const;
          }
          // Old archives without an explicit conversation marker remain ordinary text.
          case undefined: return { type: 'text', text } as const;
          default: {
            const exhaustive: never = item.kind;
            throw new Error(`Unknown result kind: ${exhaustive}`);
          }
          }
        }
        default: {
          const exhaustive: never = type;
          throw new Error(`Unknown result file: ${exhaustive}`);
        }
        }
      },
    }];
  });
}

type ConversationPart =
  | { type: 'tool_call', id: ToolCallId, name: string, arguments: string }
  | { type: 'reasoning' | 'text', content: AsyncIterable<string> }
  | { type: 'tool_result', id: ToolCallId, status: 'success' | 'error', code: ToolExecutionErrorCode | undefined, content: AsyncIterable<string> };

/** The caller streams runtime values; this operation writes the conversation envelope. */
async function* serializeConversation<M extends { role: WorkflowMessage['role'] }>({ messages, parts }: {
  messages: readonly M[], parts({ message }: { message: M }): Iterable<ConversationPart>,
}): AsyncGenerator<string> {
  yield '[';
  for (const [index, message] of messages.entries()) {
    if (index) {
      yield ',';
    }
    yield '{"role":' + JSON.stringify(message.role) + ',"parts":[';
    let first = true;
    for (const part of parts({ message })) {
      if (!first) {
        yield ',';
      }
      first = false;
      switch (part.type) {
      case 'tool_call': {
        const { type, id, name, arguments: args, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        yield JSON.stringify({ type, id: idToRaw({ id }), name, arguments: args });
        break;
      }
      case 'reasoning': case 'text':
        yield '{"type":' + JSON.stringify(part.type) + ',"text":';
        yield* part.content;
        yield '}';
        break;
      case 'tool_result': {
        const { type, id, status, code, content, ...unhandled } = part;
        unhandled satisfies Record<PropertyKey, never>;
        yield JSON.stringify({ type, id: idToRaw({ id }), status, code }).slice(0, -1) + ',"content":';
        yield* content;
        yield '}';
        break;
      }
      default: {
        const exhaustive: never = part;
        throw new Error(`Unknown conversation part: ${exhaustive}`);
      }
      }
    }
    yield ']}';
  }
  yield ']';
}

export const workflowResultsFormat = { createWriter, listViewableResults, readConversation, serializeConversation };

export const TEST_ONLY = {
};
