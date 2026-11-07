import { z } from 'zod';
import { boundedImageDimensions } from '@/utils/image-bounds';
import type { ChatMessage } from '@/01-models/types';
import { idToRaw, toToolCallId } from '@/01-models/ids';
import { parseWorkflowJson } from '@/00-storage/service/workflow-json';
import { materializeWorkflowConversation } from './conversation';
import { readWorkflowBinary } from './binary';
import { readText, serializeValue, retainValue, releaseValue, type RuntimeValue, type RuntimeMessage } from './values';
import { exportable } from './files';
import type { WorkflowRunResult } from './runtime';

export type WorkflowResultView =
  | { type: 'image' | 'audio', blob: Blob }
  | { type: 'text', text: string }
  | { type: 'conversation', messages: ChatMessage[] };
export type WorkflowResultSource = {
  id: string, label: string,
  load: ({ signal }: { signal: AbortSignal }) => Promise<WorkflowResultView>,
};
const textLimit = 2 * 1024 * 1024;
const imageLimit = 16 * 1024 * 1024;
const audioLimit = 64 * 1024 * 1024;

const mediaLimits = { image: imageLimit, audio: audioLimit, text: textLimit };

function mediaView({ bytes, kind }: { bytes: Uint8Array<ArrayBuffer>, kind: 'image' | 'audio' }): WorkflowResultView {
  switch (kind) {
  case 'image':
    boundedImageDimensions({ bytes, mimeType: 'image/png', maxEdge: 8192, maxPixels: 16 * 1024 * 1024 });
    return { type: 'image', blob: new Blob([bytes], { type: 'image/png' }) };
  case 'audio': return { type: 'audio', blob: new Blob([bytes], { type: 'audio/wav' }) };
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
}

export function workflowResultSources({ result }: { result: WorkflowRunResult }): WorkflowResultSource[] {
  const sources: WorkflowResultSource[] = [];
  for (const [id, outputs] of result.outputs) {
    for (const [name, value] of Object.entries(outputs)) {
      if (!exportable({ value }) || value.type === 'range' || value.type === 'sequence' || value.type === 'binary' && value.format === undefined) {
        continue;
      }
      sources.push({
        id: `${idToRaw({ id })}:${name}`,
        label: `${idToRaw({ id })} / ${name}`,
        async load({ signal }) {
          signal.throwIfAborted();
          const held = retainValue({ value });
          try {
            return await viewValue({ value: held, signal });
          } finally {
            await releaseValue({ value: held });
          }
        },
      });
      if (sources.length >= 1000) {
        return sources;
      }
    }
  }
  return sources;
}

async function viewValue({ value, signal }: { value: RuntimeValue, signal: AbortSignal }): Promise<WorkflowResultView> {
  switch (value.type) {
  case 'binary': {
    const kind = (() => {
      switch (value.format) {
      case 'png': return 'image' as const;
      case 'wav': return 'audio' as const;
      case undefined: throw new Error('Unknown binary media format.');
      default: {
        const exhaustive: never = value.format;
        throw new Error(String(exhaustive));
      }
      }
    })();
    const bytes = await readWorkflowBinary({ output: value.output, maxBytes: mediaLimits[kind], signal });
    return mediaView({ bytes, kind });
  }
  case 'conversation': return { type: 'conversation', messages: (await materializeWorkflowConversation({ messages: value.messages, signal })).messages };
  case 'text': return { type: 'text', text: await readText({ value, signal, maxBytes: textLimit }) };
  case 'json': case 'array': case 'object': {
    let text = '', size = 0;
    const encoder = new TextEncoder();
    for await (const part of serializeValue({ value, signal })) {
      size += encoder.encode(part).byteLength;
      if (size > textLimit) {
        throw new Error('Result exceeds the display limit; use the file browser or archive.');
      }
      text += part;
    }
    return { type: 'text', text };
  }
  case 'model': case 'sequence': case 'range': throw new Error('Use an explicit file output to view this result.');
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

const historicalPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), status: z.enum(['success', 'error']), code: z.enum(['invalid_arguments', 'execution_failed', 'timeout', 'other']).optional(), content: z.string() }),
]);
const historicalConversation = z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool']), parts: z.array(historicalPart).max(64) })).max(256);

/** Old archives without a kind marker remain ordinary JSON, never executable input. */
export async function readWorkflowArchivedConversation({ text, signal }: { text: string, signal: AbortSignal }): Promise<ChatMessage[]> {
  signal.throwIfAborted();
  if (new TextEncoder().encode(text).byteLength > textLimit) {
    throw new Error('Conversation exceeds the display limit.');
  }
  const messages: RuntimeMessage[] = historicalConversation.parse(parseWorkflowJson({ text })).map(message => ({
    role: message.role,
    parts: message.parts.map(part => {
      switch (part.type) {
      case 'text': return { type: 'json', value: part.text };
      case 'reasoning': return { type: 'reasoning', content: { type: 'json', value: part.text } };
      case 'tool_call': return { type: 'tool_call', id: toToolCallId({ raw: part.id }), name: part.name, arguments: part.arguments };
      case 'tool_result': return { type: 'tool_result', id: toToolCallId({ raw: part.id }), status: part.status, code: part.code, content: { type: 'json', value: part.content } };
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }),
  }));
  return (await materializeWorkflowConversation({ messages, signal })).messages;
}

const manifestSchema = z.object({
  outputs: z.array(z.object({
    stepId: z.string().max(4096),
    output: z.string().max(4096),
    path: z.string().regex(/^result-[0-9]{4}\.(?:txt|json|jsonl|bin|png|wav)$/).nullable(),
    kind: z.enum(['conversation']).optional(),
  })).max(1000),
});

export async function archivedWorkflowResultSources({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal }): Promise<WorkflowResultSource[]> {
  const index = await (await directory.getFileHandle('index.json')).getFile();
  if (index.size > textLimit) {
    throw new Error('Result index exceeds its display limit.');
  }
  signal.throwIfAborted();
  const manifest = manifestSchema.parse(parseWorkflowJson({ text: new TextDecoder('utf-8', { fatal: true }).decode(await index.arrayBuffer()) }));
  signal.throwIfAborted();
  return manifest.outputs.flatMap((item, offset) => {
    const path = item.path;
    if (path === null || path.endsWith('.bin') || path.endsWith('.jsonl')) {
      return [];
    }
    return [{
      id: `${offset}:${path}`,
      label: `${item.stepId} / ${item.output}`,
      async load({ signal }: { signal: AbortSignal }): Promise<WorkflowResultView> {
        signal.throwIfAborted();
        const file = await (await directory.getFileHandle(path)).getFile();
        const type = path.endsWith('.png') ? 'image' : path.endsWith('.wav') ? 'audio' : 'text';
        const limit = mediaLimits[type];
        if (file.size > limit) {
          throw new Error('Result exceeds the display limit; use the file browser or archive.');
        }
        const bytes = await file.arrayBuffer();
        signal.throwIfAborted();
        switch (type) {
        case 'image': case 'audio': return mediaView({ bytes: new Uint8Array(bytes), kind: type });
        case 'text': {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          switch (item.kind) {
          case 'conversation': return { type: 'conversation', messages: await readWorkflowArchivedConversation({ text, signal }) };
          case undefined: return { type: 'text', text };
          default: {
            const exhaustive: never = item.kind;
            throw new Error(String(exhaustive));
          }
          }
        }
        default: {
          const exhaustive: never = type;
          throw new Error(String(exhaustive));
        }
        }
      },
    }];
  });
}

export const TEST_ONLY = {
  textLimit,
  imageLimit,
  audioLimit,
};
