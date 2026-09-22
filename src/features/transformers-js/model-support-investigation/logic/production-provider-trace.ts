import { z } from 'zod';
import type { ToolCallId } from '@/01-models/ids';
import type { ChatGenerationResult } from '@/01-models/lm';
import type { AssistantMessageNode } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import type { ToolExecutionEvent, ToolExecutionOutcome } from '@/01-models/tool';

// Frozen observation boundary for existing callback-era evidence. It must not
// obtain its shape from the current (iterable) Provider contract.
type ProviderCallbacks = {
  onChunk: ({ chunk }: { chunk: string }) => void,
  onAssistantMessageStart: () => void,
  onToolCall: ({ id, toolName, modelVisibleArguments }: { id: ToolCallId; toolName: string; modelVisibleArguments: string }) => void,
  onToolEvent: ({ id, event }: { id: ToolCallId; event: ToolExecutionEvent }) => void,
  onToolResult: ({ id, result }: { id: ToolCallId; result: ToolExecutionOutcome }) => void,
};
type Phase = 'before-settlement' | 'after-settlement';
type FailureReason = 'event-limit' | 'character-limit' | 'unreadable-callback' | 'duplicate-settlement';
type CaptureFailure = Readonly<{ reason: FailureReason; phase: Phase; sequence: number }>;
export type CaptureAssistantPart =
  | Readonly<{ id: string; type: 'text' | 'reasoning'; text: string; completeness: 'complete' | 'partial' }>
  | Readonly<{ id: string; type: 'tool_call'; toolCall: Readonly<{ id: string; type: 'function'; function: Readonly<{ name: string; arguments: string }> }> }>;

type ErrorName = 'Error' | 'TypeError' | 'RangeError' | 'SyntaxError' | 'AbortError' | 'ProductionWorkerLifecycleError' | 'unknown';
type EventPayload =
  | { kind: 'assistant_message'; messageId: string }
  | { kind: 'part_text'; messageId: string; partId: string; index: number; partType: 'text' | 'reasoning'; text: string; completeness: 'complete' | 'partial' }
  | { kind: 'part_call'; messageId: string; partId: string; index: number; toolCallId: string; toolName: string; modelVisibleArguments: string }
  | { kind: 'generation_finished'; next: 'user' | 'tool_results' }
  | { kind: 'generation_interrupted'; reason: 'aborted' | 'limit' | 'stop_sequence' | 'unknown' }
  | { kind: 'generation_error'; errorName: ErrorName }
  | { kind: 'chunk'; chunk: string }
  | { kind: 'assistant-start' }
  | { kind: 'tool-call'; toolCallId: string; toolName: string; modelVisibleArguments: string }
  | { kind: 'tool-started'; toolCallId: string }
  | { kind: 'tool-output'; toolCallId: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'tool-exit'; toolCallId: string; exitCode: number }
  | { kind: 'tool-success'; toolCallId: string; content: string }
  | { kind: 'tool-error'; toolCallId: string; code: 'invalid_arguments' | 'execution_failed' | 'timeout' | 'other'; messageCapture: 'omitted-for-privacy' };
export type ProductionProviderTraceEvent = Readonly<EventPayload & { sequence: number; phase: Phase }>;
type Outcome = Readonly<{ status: 'fulfilled' } | { status: 'rejected'; errorName: ErrorName }>;
export interface ProductionProviderSettledSnapshot {
  readonly sequence: number;
  readonly outcome: Outcome;
  readonly events: readonly ProductionProviderTraceEvent[];
  readonly completeness: 'complete' | 'incomplete';
  readonly failure: CaptureFailure | undefined;
}
/**
 * Completeness covers only this bounded projection, not generation replay eligibility.
 * Tool error messages are omitted and rejection names can be unknown; this trace
 * alone cannot reconstruct the exact prompt following an errored tool result.
 */
export interface ProductionProviderTraceSnapshot {
  readonly format: 'production-provider-trace-v2' | 'production-provider-trace-v3';
  readonly requestId: string;
  // Actual validated configuration, not the enclosing archive's policy ceilings.
  // Characters are UTF-16 code units across retained payload fields.
  readonly limits: Readonly<{
    maximumEvents: number;
    maximumCharacters: number;
    maximumFieldCharacters: 16384;
  }>;
  readonly completeness: 'complete' | 'incomplete';
  readonly failure: CaptureFailure | undefined;
  readonly events: readonly ProductionProviderTraceEvent[];
  readonly settled: ProductionProviderSettledSnapshot | undefined;
  readonly lateEvents: readonly ProductionProviderTraceEvent[];
  readonly retainedCharacters: number;
}

export const PRODUCTION_PROVIDER_TRACE_LIMITS = Object.freeze({
  maximumEvents: 4096,
  maximumCharacters: 262144,
  maximumFieldCharacters: 16384,
});
const limitsSchema = z.object({
  maximumEvents: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumEvents),
  // UTF-16 code units retained from payload fields, not encoded transport bytes.
  maximumCharacters: z.number().int().min(0).max(PRODUCTION_PROVIDER_TRACE_LIMITS.maximumCharacters),
}).strict();
const requestIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const characterLimit = Symbol('character-limit');
const unreadableField = Symbol('unreadable-field');

// Never evaluate callback getters or enumerate arbitrary tool/error objects.
// Proxies are not supported: a descriptor trap may fail, but cannot escape the sink.
function ownData({ source, key }: { source: unknown; key: string }): unknown {
  if ((typeof source !== 'object' && typeof source !== 'function') || source === null) throw unreadableField;
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !('value' in descriptor)) throw unreadableField;
  return descriptor.value;
}

function rejectionName({ error }: { error: unknown }): ErrorName {
  try {
    const name = ownData({ source: error, key: 'name' });
    switch (name) {
    case 'Error': case 'TypeError': case 'RangeError': case 'SyntaxError': case 'AbortError': case 'ProductionWorkerLifecycleError': return name;
    default: return 'unknown';
    }
  } catch {
    return 'unknown';
  }
}

/** One fixed synthetic Provider request. No timers, Promise reactions or generation authority. */
/** Retains the old callback observation format for reading/testing earlier evidence. */
export function createProductionProviderTrace({ requestId, limits }: {
  requestId: string;
  limits: { maximumEvents: number; maximumCharacters: number };
}) {
  return createTrace({ requestId, limits, format: 'production-provider-trace-v2' });
}

/** Current captures observe the production parts consumer and common tool loop. */
export function createProductionProviderPartsTrace({ requestId, limits }: {
  requestId: string;
  limits: { maximumEvents: number; maximumCharacters: number };
}) {
  return createTrace({ requestId, limits, format: 'production-provider-trace-v3' });
}

function createTrace({ requestId: inputRequestId, limits, format }: {
  requestId: string;
  limits: { maximumEvents: number; maximumCharacters: number };
  format: ProductionProviderTraceSnapshot['format'];
}) {
  const requestId = requestIdSchema.parse(inputRequestId);
  const { maximumEvents, maximumCharacters } = limitsSchema.parse(limits);
  const configuredLimits = Object.freeze({
    maximumEvents, maximumCharacters,
    maximumFieldCharacters: PRODUCTION_PROVIDER_TRACE_LIMITS.maximumFieldCharacters,
  });
  let events: readonly ProductionProviderTraceEvent[] = [];
  const lateEvents: ProductionProviderTraceEvent[] = [];
  let pendingEvents: ProductionProviderTraceEvent[] = [];
  let settled: ProductionProviderSettledSnapshot | undefined;
  let failure: CaptureFailure | undefined;
  let sequence = 0;
  let retainedCharacters = 0;

  function markIncomplete({ reason }: { reason: FailureReason }): void {
    failure ??= Object.freeze({ reason, phase: settled === undefined ? 'before-settlement' : 'after-settlement', sequence });
  }

  function append({ project }: { project: ({ text }: { text: ({ value }: { value: unknown }) => string }) => EventPayload }): void {
    if (failure !== undefined) return;
    if (pendingEvents.length + events.length + lateEvents.length >= maximumEvents) {
      markIncomplete({ reason: 'event-limit' });
      return;
    }
    let characters = 0;
    function text({ value }: { value: unknown }): string {
      if (typeof value !== 'string') throw unreadableField;
      characters += value.length;
      if (value.length > PRODUCTION_PROVIDER_TRACE_LIMITS.maximumFieldCharacters || characters > maximumCharacters - retainedCharacters) throw characterLimit;
      return value;
    }
    try {
      const payload = project({ text });
      const event: ProductionProviderTraceEvent = Object.freeze({ ...payload, sequence, phase: settled === undefined ? 'before-settlement' : 'after-settlement' });
      if (settled === undefined) pendingEvents.push(event);
      else lateEvents.push(event);
      sequence += 1;
      retainedCharacters += characters;
    } catch (error) {
      markIncomplete({ reason: error === characterLimit ? 'character-limit' : 'unreadable-callback' });
    }
  }

  // Only synthetic transcript strings are captured. Arbitrary error messages,
  // stacks, environment details and tool-object extensions are intentionally absent.
  const callbacks: ProviderCallbacks = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Preserve the external Provider callback object for descriptor-only reads; destructuring would execute getters.
    onChunk: input => append({ project: ({ text }) => ({ kind: 'chunk', chunk: text({ value: ownData({ source: input, key: 'chunk' }) }) }) }),
    onAssistantMessageStart: () => append({ project: () => ({ kind: 'assistant-start' }) }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- External Provider callback payload is inspected without invoking accessors.
    onToolCall: input => append({ project: ({ text }) => ({
      kind: 'tool-call', toolCallId: text({ value: ownData({ source: input, key: 'id' }) }),
      toolName: text({ value: ownData({ source: input, key: 'toolName' }) }),
      modelVisibleArguments: text({ value: ownData({ source: input, key: 'modelVisibleArguments' }) }),
    }) }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- External Provider callback payload is inspected without invoking accessors.
    onToolEvent: input => append({ project: ({ text }) => {
      const toolCallId = text({ value: ownData({ source: input, key: 'id' }) });
      const event = ownData({ source: input, key: 'event' });
      const type = ownData({ source: event, key: 'type' });
      switch (type) {
      case 'started': return { kind: 'tool-started', toolCallId };
      case 'output': {
        const stream = ownData({ source: event, key: 'stream' });
        if (stream !== 'stdout' && stream !== 'stderr') throw unreadableField;
        return { kind: 'tool-output', toolCallId, stream, text: text({ value: ownData({ source: event, key: 'text' }) }) };
      }
      case 'exit': {
        const exitCode = ownData({ source: event, key: 'exitCode' });
        if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode)) throw unreadableField;
        return { kind: 'tool-exit', toolCallId, exitCode };
      }
      default: throw unreadableField;
      }
    } }),
    // eslint-disable-next-line local-rules-named-args/require-named-args -- External Provider callback payload is inspected without invoking accessors.
    onToolResult: input => append({ project: ({ text }) => {
      const toolCallId = text({ value: ownData({ source: input, key: 'id' }) });
      const result = ownData({ source: input, key: 'result' });
      switch (ownData({ source: result, key: 'status' })) {
      case 'success': return { kind: 'tool-success', toolCallId, content: text({ value: ownData({ source: result, key: 'content' }) }) };
      case 'error': {
        const code = ownData({ source: result, key: 'code' });
        if (code !== 'invalid_arguments' && code !== 'execution_failed' && code !== 'timeout' && code !== 'other') throw unreadableField;
        return { kind: 'tool-error', toolCallId, code, messageCapture: 'omitted-for-privacy' };
      }
      default: throw unreadableField;
      }
    } }),
  };

  // Keep only the latest revision for each part. A text snapshot records the
  // consumer's applied content, not raw token chunks or a normalized transcript.
  let assistantId: string | undefined;
  const partRevisions = new Map<AssistantMessageNode['parts'][number], { index: number; part: CaptureAssistantPart }>();
  function observeAssistant({ message }: { message: AssistantMessageNode }): void {
    switch (format) {
    case 'production-provider-trace-v3': break;
    case 'production-provider-trace-v2': throw new Error('Parts observations require the parts trace format');
    default: { const exhaustive: never = format; throw new Error('Unhandled trace format: ' + exhaustive); }
    }
    if (failure !== undefined) return;
    const messageId = idToRaw({ id: message.id });
    if (assistantId !== messageId) {
      assistantId = messageId;
      partRevisions.clear();
      append({ project: ({ text }) => ({ kind: 'assistant_message', messageId: text({ value: messageId }) }) });
    }
    for (const [index, part] of message.parts.entries()) {
      if (failure !== undefined) break;
      const previous = partRevisions.get(part);
      // Capture IDs identify revisions within this observation. They are not
      // history fields, and remain stable if another part is inserted earlier.
      const id = previous?.part.id ?? `part_${partRevisions.size}`;
      switch (part.type) {
      case 'text': case 'reasoning': {
        const { type, text: value, completeness, ...rest } = part; rest satisfies Record<PropertyKey, never>;
        if (previous?.index === index && previous.part.type === type && previous.part.text === value && previous.part.completeness === completeness) break;
        append({ project: ({ text }) => ({ kind: 'part_text', messageId: text({ value: messageId }), partId: text({ value: id }), index, partType: type, text: text({ value }), completeness }) });
        if (failure === undefined) partRevisions.set(part, { index, part: Object.freeze({ id, type, text: value, completeness }) });
        break;
      }
      case 'tool_call': {
        const { type, toolCall, ...rest } = part; rest satisfies Record<PropertyKey, never>;
        const { id: callId, type: callType, function: fn, ...restCall } = toolCall; restCall satisfies Record<PropertyKey, never>;
        const { name, arguments: args, ...restFunction } = fn; restFunction satisfies Record<PropertyKey, never>;
        const rawId = idToRaw({ id: callId });
        if (previous?.index === index && previous.part.type === type && previous.part.toolCall.id === rawId && previous.part.toolCall.function.name === name && previous.part.toolCall.function.arguments === args) break;
        append({ project: ({ text }) => ({ kind: 'part_call', messageId: text({ value: messageId }), partId: text({ value: id }), index,
          toolCallId: text({ value: rawId }), toolName: text({ value: name }), modelVisibleArguments: text({ value: args }) }) });
        if (failure === undefined) partRevisions.set(part, { index, part: Object.freeze({ id, type, toolCall: Object.freeze({ id: rawId, type: callType, function: Object.freeze({ name, arguments: args }) }) }) });
        break;
      }
      default: { const exhaustive: never = part; throw new Error('Unhandled assistant part: ' + exhaustive); }
      }
    }
  }

  function observeResult({ result }: { result: ChatGenerationResult }): void {
    switch (format) {
    case 'production-provider-trace-v3': break;
    case 'production-provider-trace-v2': throw new Error('Generation results require the parts trace format');
    default: { const exhaustive: never = format; throw new Error('Unhandled trace format: ' + exhaustive); }
    }
    switch (result.type) {
    case 'finished': append({ project: () => ({ kind: 'generation_finished', next: result.next }) }); break;
    case 'interrupted': append({ project: () => ({ kind: 'generation_interrupted', reason: result.reason }) }); break;
    case 'error': append({ project: () => ({ kind: 'generation_error', errorName: rejectionName({ error: result.error }) }) }); break;
    default: { const exhaustive: never = result; throw new Error('Unhandled generation result: ' + exhaustive); }
    }
  }

  return {
    callbacks: Object.freeze(callbacks),
    observeAssistant, observeResult,
    /** Call synchronously immediately after the caller's direct await or catch. */
    settle({ outcome: requestedOutcome, error }: { outcome: 'fulfilled'; error: undefined } | { outcome: 'rejected'; error: unknown }): ProductionProviderSettledSnapshot {
      if (settled !== undefined) {
        markIncomplete({ reason: 'duplicate-settlement' });
        return settled;
      }
      let outcome: Outcome;
      switch (requestedOutcome) {
      case 'fulfilled': outcome = Object.freeze({ status: 'fulfilled' }); break;
      case 'rejected': outcome = Object.freeze({ status: 'rejected', errorName: rejectionName({ error }) }); break;
      default: {
        const exhaustive: never = requestedOutcome;
        throw new Error(`Unhandled Provider settlement: ${exhaustive}`);
      }
      }
      // Transfer ownership at the boundary instead of cloning a transcript.
      partRevisions.clear();
      events = Object.freeze(pendingEvents);
      pendingEvents = [];
      settled = Object.freeze({ sequence, outcome, events, completeness: failure === undefined ? 'complete' : 'incomplete', failure });
      sequence += 1;
      return settled;
    },
    snapshot(): ProductionProviderTraceSnapshot {
      return Object.freeze({
        format, requestId, limits: configuredLimits,
        completeness: failure === undefined ? 'complete' : 'incomplete', failure,
        events: settled === undefined ? Object.freeze(pendingEvents.slice()) : events,
        settled, lateEvents: Object.freeze(lateEvents.slice()), retainedCharacters,
      });
    },
  };
}

export const TEST_ONLY = {
};
