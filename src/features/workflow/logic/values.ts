import { parseWorkflowJson, parseWorkflowModelConfiguration } from '@/00-storage/service/workflow-json';
import type { JsonValue } from '@/01-models/lm';
import type { WorkflowMessage } from '@/01-models/workflow';
import type { ToolCallId } from '@/01-models/ids';
import type { ToolExecutionErrorCode } from '@/01-models/tool';
import type { WorkflowNumberRange } from './range';
import type { Endpoint, LmParameters } from '@/01-models/types';
import type { WorkflowOutput, WorkflowOutputStore, WorkflowOutputWriter } from './output-store';

export type RuntimeToolCall = { type: 'tool_call', id: ToolCallId, name: string, arguments: string };
export type RuntimeToolResult = { type: 'tool_result', id: ToolCallId, status: 'success' | 'error', code: ToolExecutionErrorCode | undefined, content: RuntimeValue };
export type RuntimeMessagePart = RuntimeValue | RuntimeToolCall | RuntimeToolResult | { type: 'reasoning', content: RuntimeValue };
export type RuntimeMessage = { role: WorkflowMessage['role'], parts: RuntimeMessagePart[] };

/** Only value-bearing parts own leases. Historical calls never own authority. */
export function runtimeMessageValues({ messages }: { messages: RuntimeMessage[] }): RuntimeValue[] {
  return messages.flatMap(message => message.parts.flatMap(part => {
    switch (part.type) {
    case 'tool_call': return [];
    case 'reasoning': case 'tool_result': return [part.content];
    default: return [part];
    }
  }));
}

export function retainRuntimeMessage({ message }: { message: RuntimeMessage }): RuntimeMessage {
  return {
    role: message.role,
    parts: message.parts.map(part => {
      switch (part.type) {
      case 'tool_call': return { ...part };
      case 'reasoning': case 'tool_result': return { ...part, content: retainValue({ value: part.content }) };
      default: return retainValue({ value: part });
      }
    }),
  };
}

export type RuntimeValue =
  | { type: 'json', value: JsonValue }
  | { type: 'model', endpoint: Endpoint, modelId: string, lmParameters?: LmParameters | undefined }
  | ({ type: 'range' } & WorkflowNumberRange)
  | { type: 'text', output: WorkflowOutput }
  | { type: 'binary', output: WorkflowOutput, format?: 'wav' | 'png' }
  | { type: 'sequence', output: WorkflowOutput }
  | { type: 'array', items: RuntimeValue[] }
  | { type: 'object', properties: Record<string, RuntimeValue> }
  | { type: 'conversation', messages: RuntimeMessage[] };

export async function requireModelValue({ value, signal }: { value: RuntimeValue, signal: AbortSignal }): Promise<Extract<RuntimeValue, { type: 'model' }>> {
  switch (value.type) {
  case 'model': return value;
  case 'json': case 'object': return { type: 'model', ...parseWorkflowModelConfiguration({ value: await materializeJson({ value, signal }) }) };
  case 'text': case 'binary': case 'sequence': case 'range': case 'array': case 'conversation': throw new Error('Expected a model connection or its JSON configuration.');
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

export function requireConversationValue({ value }: { value: RuntimeValue }): Extract<RuntimeValue, { type: 'conversation' }> {
  switch (value.type) {
  case 'conversation': return value;
  case 'json': case 'range': case 'text': case 'binary': case 'sequence': case 'array': case 'object': case 'model': throw new Error('Expected a conversation value.');
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

/** Freeze data recursively even when an outer object was already frozen.
 * Output leases are opaque capabilities and are deliberately not traversed.
 */
export function freezeWorkflowData({ value }: { value: unknown }): void {
  const seen = new WeakSet<object>();
  function visit({ value }: { value: unknown }): void {
    if (value === null || typeof value !== 'object' || seen.has(value)) {
      return;
    }
    seen.add(value);
    for (const child of Object.values(value)) {
      visit({ value: child });
    }
    Object.freeze(value);
  }
  visit({ value });
}

export function freezeRuntimeValue({ value }: { value: RuntimeValue }): void {
  switch (value.type) {
  case 'range': break;
  case 'json': freezeWorkflowData({ value: value.value });
    break;
  case 'model': freezeWorkflowData({ value: value.endpoint });
    freezeWorkflowData({ value: value.lmParameters });
    break;
  case 'text': case 'binary': case 'sequence': break;
  case 'array':
    value.items.forEach(value => freezeRuntimeValue({ value }));
    Object.freeze(value.items);
    break;
  case 'object':
    Object.values(value.properties).forEach(value => freezeRuntimeValue({ value }));
    Object.freeze(value.properties);
    break;
  case 'conversation':
    value.messages.forEach(message => {
      message.parts.forEach(part => {
        switch (part.type) {
        case 'tool_call': Object.freeze(part);
          break;
        case 'reasoning': case 'tool_result': freezeRuntimeValue({ value: part.content });
          Object.freeze(part);
          break;
        default: freezeRuntimeValue({ value: part });
        }
      });
      Object.freeze(message.parts);
      Object.freeze(message);
    });
    Object.freeze(value.messages);
    break;
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
  Object.freeze(value);
}

export const WORKFLOW_INPUT_LIMIT = 2 * 1024 * 1024;
export const WORKFLOW_CHUNK_BYTES = 32 * 1024;

export function retainValue({ value }: { value: RuntimeValue }): RuntimeValue {
  switch (value.type) {
  case 'json': case 'range': case 'model': return value;
  case 'text': case 'binary': case 'sequence': return { ...value, output: value.output.retain() };
  case 'array': return { ...value, items: value.items.map(value => retainValue({ value })) };
  case 'object': return { ...value, properties: Object.fromEntries(Object.entries(value.properties).map(([key, value]) => [key, retainValue({ value })])) };
  case 'conversation': return { ...value, messages: value.messages.map(message => retainRuntimeMessage({ message })) };
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown runtime value: ${exhaustive}`);
  }
  }
}

export async function releaseValue({ value }: { value: RuntimeValue }): Promise<void> {
  switch (value.type) {
  case 'json': case 'range': case 'model': return;
  case 'text': case 'binary': case 'sequence': await value.output.release();
    return;
  case 'array': await releaseValues({ values: value.items });
    return;
  case 'object': await releaseValues({ values: Object.values(value.properties) });
    return;
  case 'conversation': await releaseValues({ values: runtimeMessageValues({ messages: value.messages }) });
    return;
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown runtime value: ${exhaustive}`);
  }
  }
}

export async function releaseValues({ values }: { values: RuntimeValue[] }): Promise<void> {
  const results = await Promise.allSettled(values.map(value => releaseValue({ value })));
  const errors = results.filter(result => result.status === 'rejected');
  if (errors.length) {
    throw new AggregateError(errors.map(result => result.reason), 'Could not release workflow output.');
  }
}

export async function* readOutput({ output, signal }: { output: WorkflowOutput, signal: AbortSignal | undefined }): AsyncGenerator<Uint8Array> {
  const reader = output.openStream({ signal }).getReader();
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) {
        break;
      }
      yield result.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Decoding is distinct from storage and cancellation failures. Binary file
 * outputs also expose a lazy text view; display/export may skip only this error.
 */
export class WorkflowTextDecodingError extends Error {
  constructor({ cause }: { cause: unknown }) {
    super('Output is not valid UTF-8 text.', { cause });
    this.name = 'WorkflowTextDecodingError';
  }
}

export async function* textChunks({ value, signal }: { value: RuntimeValue, signal: AbortSignal | undefined }): AsyncGenerator<string> {
  switch (value.type) {
  case 'json':
    if (typeof value.value !== 'string') {
      throw new Error('Expected a text value.');
    }
    yield value.value;
    return;
  case 'text': {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = ({ bytes, stream }: { bytes: Uint8Array | undefined, stream: boolean }): string => {
      try {
        return decoder.decode(bytes, { stream });
      } catch (cause) {
        throw new WorkflowTextDecodingError({ cause });
      }
    };
    for await (const chunk of readOutput({ output: value.output, signal })) {
      yield decode({ bytes: chunk, stream: true });
    }
    yield decode({ bytes: undefined, stream: false });
    return;
  }
  case 'range': case 'model': case 'binary': case 'sequence': case 'array': case 'object': case 'conversation':
    throw new Error('Expected text, not an implicit conversion from another value.');
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown value: ${exhaustive}`);
  }
  }
}

export async function readText({ value, maxBytes, signal }: { value: RuntimeValue, maxBytes: number, signal: AbortSignal | undefined }): Promise<string> {
  if (value.type === 'text' && value.output.byteLength > maxBytes) {
    throw new Error('Text exceeds the input limit.');
  }
  let result = '', size = 0;
  const encoder = new TextEncoder();
  for await (const chunk of textChunks({ value, signal })) {
    size += encoder.encode(chunk).byteLength;
    if (size > maxBytes) {
      throw new Error('Text exceeds the input limit.');
    }
    result += chunk;
  }
  return result;
}

export async function writeText({ writer, text }: { writer: WorkflowOutputWriter, text: string }): Promise<void> {
  // Split before encoding, but never cut a surrogate pair at the boundary.
  const encoder = new TextEncoder();
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 8192);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) {
      end--;
    }
    await writer.write({ chunk: encoder.encode(text.slice(offset, end)) });
    offset = end;
  }
}

export async function spoolText({ store, signal, chunks }: { store: WorkflowOutputStore, signal: AbortSignal, chunks: AsyncIterable<string> }): Promise<Extract<RuntimeValue, { type: 'text' }>> {
  const writer = await store.createWriter({ signal });
  try {
    for await (const text of chunks) {
      signal.throwIfAborted();
      await writeText({ writer, text });
    }
    return { type: 'text', output: await writer.seal() };
  } catch (error) {
    await writer.abort({ reason: error });
    throw error;
  }
}

/** Replay one bounded JSON Lines record at a time; never collect a full sequence. */
export async function* sequenceValues({ output, signal }: { output: WorkflowOutput, signal: AbortSignal | undefined }): AsyncGenerator<JsonValue> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const chunk of readOutput({ output, signal })) {
    pending += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line) {
        yield parseWorkflowJson({ text: line });
      }
    }
    if (pending.length > WORKFLOW_INPUT_LIMIT) {
      throw new Error('Sequence item exceeds input limit.');
    }
  }
  pending += decoder.decode();
  if (pending) {
    yield parseWorkflowJson({ text: pending });
  }
}

/** Serialize lazily; text outputs remain file-backed even when included in a result object. */
export async function* serializeValue({ value, signal }: { value: RuntimeValue, signal: AbortSignal | undefined }): AsyncGenerator<string> {
  signal?.throwIfAborted();
  switch (value.type) {
  case 'json': yield JSON.stringify(value.value);
    return;
  case 'text':
    yield '"';
    for await (const chunk of textChunks({ value, signal })) {
      yield JSON.stringify(chunk).slice(1, -1);
    }
    yield '"';
    return;
  case 'array':
    yield '[';
    for (const [index, child] of value.items.entries()) {
      if (index) {
        yield ',';
      }
      yield* serializeValue({ value: child, signal });
    }
    yield ']';
    return;
  case 'object':
    yield '{';
    for (const [index, [key, child]] of Object.entries(value.properties).entries()) {
      if (index) {
        yield ',';
      }
      yield JSON.stringify(key) + ':';
      yield* serializeValue({ value: child, signal });
    }
    yield '}';
    return;
  case 'conversation':
    yield '[';
    for (const [index, message] of value.messages.entries()) {
      if (index) {
        yield ',';
      }
      yield '{"role":' + JSON.stringify(message.role) + ',"parts":[';
      for (const [partIndex, part] of message.parts.entries()) {
        if (partIndex) {
          yield ',';
        }
        switch (part.type) {
        case 'tool_call': yield JSON.stringify(part);
          break;
        case 'reasoning':
          yield '{"type":"reasoning","text":';
          yield* serializeValue({ value: part.content, signal });
          yield '}';
          break;
        case 'tool_result':
          yield JSON.stringify({ type: part.type, id: part.id, status: part.status, code: part.code }).slice(0, -1) + ',"content":';
          yield* serializeValue({ value: part.content, signal });
          yield '}';
          break;
        default:
          yield '{"type":"text","text":';
          yield* serializeValue({ value: part, signal });
          yield '}';
        }
      }
      yield ']}';
    }
    yield ']';
    return;
  case 'sequence': {
    yield '[';
    let first = true;
    for await (const item of sequenceValues({ output: value.output, signal })) {
      if (!first) {
        yield ',';
      }
      first = false;
      yield JSON.stringify(item);
    }
    yield ']';
    return;
  }
  case 'range': throw new Error('Iterate a number range before exporting it.');
  case 'model': throw new Error('Model connections are not exported as result data because they may contain credentials.');
  case 'binary': throw new Error('Binary output must be saved as binary, not embedded into JSON.');
  default: {
    const exhaustive: never = value;
    throw new Error(`Unknown runtime value: ${exhaustive}`);
  }
  }
}

export async function materializeJson({ value, signal }: { value: RuntimeValue, signal: AbortSignal | undefined }): Promise<JsonValue> {
  let text = '', bytes = 0;
  const encoder = new TextEncoder();
  for await (const chunk of serializeValue({ value, signal })) {
    bytes += encoder.encode(chunk).byteLength;
    if (bytes > WORKFLOW_INPUT_LIMIT) {
      throw new Error('Structured input exceeds the materialization limit.');
    }
    text += chunk;
  }
  // Parsing is delegated to the public storage codec at trust boundaries; this is our own serialized value.
  return JSON.parse(text) as JsonValue;
}

export function safeRelativePath({ path }: { path: string }): string[] {
  const segments = path.split('/');
  // eslint-disable-next-line no-control-regex -- Reject control characters in user-controlled file paths.
  if (!segments.length || segments.length > 32 || segments.some(segment => !segment || segment === '.' || segment === '..' || /[\\\x00-\x1f\x7f]/u.test(segment) || segment.length > 240) || path.length > 2048) {
    throw new Error('Expected a nonempty relative file path with safe segments.');
  }
  return segments;
}

export const TEST_ONLY = {
};
