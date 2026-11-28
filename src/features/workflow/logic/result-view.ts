import { opfsFormat } from '@/00-format/01-layout/layout';
import { boundedImageDimensions } from '@/utils/image-bounds';
import type { ChatMessage } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
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

const livePreviewLimits = { text: 2 * 1024 * 1024, image: 16 * 1024 * 1024, audio: 64 * 1024 * 1024 };

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
    const bytes = await readWorkflowBinary({ output: value.output, maxBytes: livePreviewLimits[kind], signal });
    return mediaView({ bytes, kind });
  }
  case 'conversation': return { type: 'conversation', messages: (await materializeWorkflowConversation({ messages: value.messages, signal })).messages };
  case 'text': return { type: 'text', text: await readText({ value, signal, maxBytes: livePreviewLimits.text }) };
  case 'json': case 'array': case 'object': {
    let text = '', size = 0;
    const encoder = new TextEncoder();
    for await (const part of serializeValue({ value, signal })) {
      size += encoder.encode(part).byteLength;
      if (size > livePreviewLimits.text) {
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

/** Old archives without a kind marker remain ordinary JSON, never executable input. */
export async function readWorkflowArchivedConversation({ text, signal }: { text: string, signal: AbortSignal }): Promise<ChatMessage[]> {
  signal.throwIfAborted();
  return materializeArchive({ archived: opfsFormat.tmp.workflowResults.readConversation({ text }), signal });
}

async function materializeArchive({ archived, signal }: {
  archived: ReturnType<typeof opfsFormat.tmp.workflowResults.readConversation>, signal: AbortSignal,
}): Promise<ChatMessage[]> {
  const messages: RuntimeMessage[] = archived.map(message => ({
    role: message.role,
    parts: message.parts.map(part => {
      switch (part.type) {
      case 'text': return { type: 'json', value: part.text };
      case 'reasoning': return { type: 'reasoning', content: { type: 'json', value: part.text } };
      case 'tool_call': return { type: 'tool_call', id: part.id, name: part.name, arguments: part.arguments };
      case 'tool_result': return { type: 'tool_result', id: part.id, status: part.status, code: part.code, content: { type: 'json', value: part.content } };
      default: {
        const exhaustive: never = part;
        throw new Error(String(exhaustive));
      }
      }
    }),
  }));
  return (await materializeWorkflowConversation({ messages, signal })).messages;
}

export async function archivedWorkflowResultSources({ directory, signal }: { directory: FileSystemDirectoryHandle, signal: AbortSignal }): Promise<WorkflowResultSource[]> {
  const results = await opfsFormat.tmp.workflowResults.listViewableResults({
    signal,
    openFile: async ({ name }) => (await directory.getFileHandle(name)).getFile(),
  });
  return results.map(result => ({
    id: `${result.offset}:${result.name}`,
    label: `${result.stepId} / ${result.output}`,
    async load({ signal }) {
      const value = await result.read({ signal });
      switch (value.type) {
      case 'image': case 'audio': return mediaView({ bytes: new Uint8Array(value.bytes), kind: value.type });
      case 'conversation': return { type: 'conversation', messages: await materializeArchive({ archived: value.messages, signal }) };
      case 'text': return { type: 'text', text: value.text };
      default: {
        const exhaustive: never = value;
        throw new Error(`Unknown result: ${exhaustive}`);
      }
      }
    },
  }));
}

export const TEST_ONLY = {
  textLimit: livePreviewLimits.text,
  imageLimit: livePreviewLimits.image,
  audioLimit: livePreviewLimits.audio,
};
