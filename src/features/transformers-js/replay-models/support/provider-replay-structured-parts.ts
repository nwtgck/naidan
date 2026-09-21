import { isDeepStrictEqual } from 'node:util';
import { expect } from 'vitest';
import { z } from 'zod';
import type { ProductionProviderTraceEvent } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import { exactObject } from '@/utils/exact-object';
import type { CapturedFullReplayEvidence } from './provider-replay-test-captured-full';

type Scenario = CapturedFullReplayEvidence['requests'][number]['scenario'];
type Invocation = CapturedFullReplayEvidence['invocations'][number];

export type StructuredPartsExpectedPart =
  | { type: 'reasoning' | 'text'; text: string; completeness: 'complete' | 'partial' }
  | { type: 'tool_call'; name: string; arguments: string };
export type StructuredPartsExpectedTerminal =
  | { type: 'finished'; next: 'user' | 'tool_results' }
  | { type: 'interrupted'; reason: 'aborted' | 'limit' | 'stop_sequence' | 'unknown' }
  | { type: 'error'; errorName: string }
  | { type: 'none' };
export type StructuredPartsExpectedEvent =
  | { kind: 'assistant'; parts: readonly StructuredPartsExpectedPart[]; terminal: StructuredPartsExpectedTerminal }
  | { kind: 'tool-started'; call: number }
  | { kind: 'tool-output'; call: number; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'tool-exit'; call: number; exitCode: number }
  | { kind: 'tool-success'; call: number; content: string }
  | { kind: 'tool-error'; call: number; code: 'invalid_arguments' | 'execution_failed' | 'timeout' | 'other' };

export type StructuredPartsReplayContract = {
  completionTokenIds: readonly string[];
  endTokenIds: readonly string[];
  invocations: readonly {
    callOrdinal: number;
    terminal: { kind: 'stream-end' } | { kind: 'control'; tokenId: string };
  }[];
  requests: readonly {
    scenario: Scenario;
    settlement: 'fulfilled' | 'rejected';
    events: readonly StructuredPartsExpectedEvent[];
  }[];
  legacyInputProjectionScenarios?: readonly Scenario[];
};

const tokenId = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).max(20);

export function validateStructuredPartsContract({ contract, evidence }: {
  contract: StructuredPartsReplayContract;
  evidence: CapturedFullReplayEvidence;
}): void {
  const { completionTokenIds, endTokenIds, invocations, requests, legacyInputProjectionScenarios = [], ...unhandled } = contract;
  unhandled satisfies Record<PropertyKey, never>;
  tokenId.array().min(1).parse(completionTokenIds);
  tokenId.array().min(1).parse(endTokenIds);
  if (new Set(completionTokenIds).size !== completionTokenIds.length || new Set(endTokenIds).size !== endTokenIds.length) {
    throw new Error('Duplicate structured-parts completion token');
  }
  if (endTokenIds.some(id => !completionTokenIds.includes(id))) throw new Error('Every structured-parts end token must be a completion token');
  if (new Set(invocations.map(item => item.callOrdinal)).size !== invocations.length) throw new Error('Duplicate structured-parts invocation');
  if (new Set(requests.map(item => item.scenario)).size !== requests.length) throw new Error('Duplicate structured-parts request');
  if (new Set(legacyInputProjectionScenarios).size !== legacyInputProjectionScenarios.length) throw new Error('Duplicate legacy input projection');
  for (const item of invocations) {
    if (!evidence.invocations.some(invocation => invocation.callOrdinal === item.callOrdinal)) throw new Error('Unknown structured-parts invocation');
    if (item.terminal.kind === 'control' && !completionTokenIds.includes(item.terminal.tokenId)) throw new Error('Undeclared structured-parts terminal control');
  }
  for (const item of requests) {
    if (!evidence.requests.some(request => request.scenario === item.scenario)) throw new Error('Unknown structured-parts request');
  }
  for (const scenario of legacyInputProjectionScenarios) {
    if (!requests.some(request => request.scenario === scenario)) throw new Error('Legacy input projection requires a structured-parts request');
  }
}

export function verifyStructuredPartsInventory({ contract, invocationOrdinals, requestScenarios }: {
  contract: StructuredPartsReplayContract;
  invocationOrdinals: readonly number[];
  requestScenarios: readonly Scenario[];
}): void {
  expect(contract.invocations.map(item => item.callOrdinal).sort((left, right) => left - right), 'every replayed structured invocation is declared exactly once')
    .toEqual([...invocationOrdinals].sort((left, right) => left - right));
  expect(contract.requests.map(item => item.scenario).sort(), 'every settled structured request is declared exactly once')
    .toEqual([...requestScenarios].sort());
}

export function verifyStructuredInvocationTermination({ invocation, expected, contract }: {
  invocation: Invocation;
  expected: StructuredPartsReplayContract['invocations'][number];
  contract: StructuredPartsReplayContract;
}): void {
  expect(expected.callOrdinal, 'structured-parts invocation identity').toBe(invocation.callOrdinal);
  const generated = invocation.sequence.tokens.slice(invocation.settings.budget.promptTokenCount);
  const controls = generated.flatMap((id, index) => contract.completionTokenIds.includes(id) ? [{ id, index }] : []);
  switch (expected.terminal.kind) {
  case 'stream-end':
    expect(controls, 'partial structured output has no accepted native control').toEqual([]);
    break;
  case 'control': {
    const position = generated.lastIndexOf(expected.terminal.tokenId);
    expect(position, 'declared native terminal is present').toBeGreaterThanOrEqual(0);
    expect(generated.slice(0, position).some(id => contract.endTokenIds.includes(id)), 'model end token does not precede the logical terminal').toBe(false);
    expect(generated.slice(position + 1).every(id => contract.endTokenIds.includes(id)), 'only native end tokens follow the logical terminal').toBe(true);
    const laterControls = controls.filter(control => control.index > position);
    expect(laterControls.every(control => contract.endTokenIds.includes(control.id)), 'no later non-end control follows the logical terminal').toBe(true);
    break;
  }
  default: { const exhaustive: never = expected.terminal; throw new Error(String(exhaustive)); }
  }
}

function projectStructuredEvents({ events }: { events: readonly ProductionProviderTraceEvent[] }): StructuredPartsExpectedEvent[] {
  const projected: StructuredPartsExpectedEvent[] = [];
  const callIds = new Map<string, number>();
  let assistant: { messageId: string; parts: Map<string, { index: number; value: StructuredPartsExpectedPart }>; callIds: Set<string> } | undefined;

  function finishAssistant({ terminal }: { terminal: StructuredPartsExpectedTerminal }): void {
    if (assistant === undefined) throw new Error('Structured terminal outside an assistant');
    const ordered = [...assistant.parts.values()].sort((left, right) => left.index - right.index);
    expect(ordered.map(item => item.index), 'contiguous structured part indices').toEqual(ordered.map((_item, index) => index));
    projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'assistant' }>>()({
      kind: 'assistant',
      parts: ordered.map(item => item.value),
      terminal,
    }));
    assistant = undefined;
  }
  function callOrdinal({ rawId }: { rawId: string }): number {
    const ordinal = callIds.get(rawId);
    if (ordinal === undefined) throw new Error('Tool event before its structured call');
    return ordinal;
  }
  function beginToolPhase({ rawId }: { rawId: string }): void {
    if (assistant === undefined) return;
    if (!assistant.callIds.has(rawId)) throw new Error('Tool execution started without a structured call');
    finishAssistant({ terminal: exactObject<Extract<StructuredPartsExpectedTerminal, { type: 'finished' }>>()({
      type: 'finished',
      next: 'tool_results',
    }) });
  }

  for (const [sequence, event] of events.entries()) {
    expect(event.sequence, 'structured trace sequence').toBe(sequence);
    expect(event.phase, 'structured trace settlement phase').toBe('before-settlement');
    switch (event.kind) {
    case 'assistant_message': {
      const { kind: _kind, messageId, sequence: _sequence, phase: _phase, ...unhandled } = event;
      unhandled satisfies Record<PropertyKey, never>;
      if (assistant !== undefined) throw new Error('New structured assistant before prior terminal');
      assistant = { messageId, parts: new Map(), callIds: new Set() };
      break;
    }
    case 'part_text': {
      const { kind: _kind, messageId, partId, index, partType, text, completeness, sequence: _sequence, phase: _phase, ...unhandled } = event;
      unhandled satisfies Record<PropertyKey, never>;
      if (assistant?.messageId !== messageId) throw new Error('Structured text outside its assistant');
      const previous = assistant.parts.get(partId);
      if (previous !== undefined) {
        if (previous.index !== index || previous.value.type === 'tool_call' || previous.value.type !== partType
          || !text.startsWith(previous.value.text)
          || (previous.value.completeness === 'complete' && completeness !== 'complete')) {
          throw new Error('Structured text part revision changed identity or accepted text');
        }
      } else if ([...assistant.parts.values()].some(item => item.index === index)) {
        throw new Error('Structured part index was reused');
      }
      assistant.parts.set(partId, { index, value: exactObject<Extract<StructuredPartsExpectedPart, { type: 'reasoning' | 'text' }>>()({
        type: partType,
        text,
        completeness,
      }) });
      break;
    }
    case 'part_call': {
      const { kind: _kind, messageId, partId, index, toolCallId, toolName, modelVisibleArguments, sequence: _sequence, phase: _phase, ...unhandled } = event;
      unhandled satisfies Record<PropertyKey, never>;
      if (assistant?.messageId !== messageId || assistant.parts.has(partId)
        || [...assistant.parts.values()].some(item => item.index === index) || callIds.has(toolCallId)) {
        throw new Error('Invalid structured tool call identity or order');
      }
      callIds.set(toolCallId, callIds.size + 1);
      assistant.callIds.add(toolCallId);
      assistant.parts.set(partId, { index, value: exactObject<Extract<StructuredPartsExpectedPart, { type: 'tool_call' }>>()({
        type: 'tool_call',
        name: toolName,
        arguments: modelVisibleArguments,
      }) });
      break;
    }
    case 'generation_finished': {
      const { kind: _kind, next, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      finishAssistant({ terminal: exactObject<Extract<StructuredPartsExpectedTerminal, { type: 'finished' }>>()({ type: 'finished', next }) }); break;
    }
    case 'generation_interrupted': {
      const { kind: _kind, reason, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      finishAssistant({ terminal: exactObject<Extract<StructuredPartsExpectedTerminal, { type: 'interrupted' }>>()({ type: 'interrupted', reason }) }); break;
    }
    case 'generation_error': {
      const { kind: _kind, errorName, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      finishAssistant({ terminal: exactObject<Extract<StructuredPartsExpectedTerminal, { type: 'error' }>>()({ type: 'error', errorName }) }); break;
    }
    case 'tool-started': {
      const { kind, toolCallId, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      beginToolPhase({ rawId: toolCallId });
      projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'tool-started' }>>()({ kind, call: callOrdinal({ rawId: toolCallId }) })); break;
    }
    case 'tool-output': {
      const { kind, toolCallId, stream, text, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      beginToolPhase({ rawId: toolCallId });
      projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'tool-output' }>>()({ kind, call: callOrdinal({ rawId: toolCallId }), stream, text })); break;
    }
    case 'tool-exit': {
      const { kind, toolCallId, exitCode, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      beginToolPhase({ rawId: toolCallId });
      projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'tool-exit' }>>()({ kind, call: callOrdinal({ rawId: toolCallId }), exitCode })); break;
    }
    case 'tool-success': {
      const { kind, toolCallId, content, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      beginToolPhase({ rawId: toolCallId });
      projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'tool-success' }>>()({ kind, call: callOrdinal({ rawId: toolCallId }), content })); break;
    }
    case 'tool-error': {
      const { kind, toolCallId, code, messageCapture: _messageCapture, sequence: _sequence, phase: _phase, ...unhandled } = event; unhandled satisfies Record<PropertyKey, never>;
      beginToolPhase({ rawId: toolCallId });
      projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'tool-error' }>>()({ kind, call: callOrdinal({ rawId: toolCallId }), code })); break;
    }
    case 'chunk': case 'assistant-start': case 'tool-call': throw new Error('Legacy callback event in structured-parts observation');
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  }
  if (assistant !== undefined) projected.push(exactObject<Extract<StructuredPartsExpectedEvent, { kind: 'assistant' }>>()({
    kind: 'assistant',
    parts: [...assistant.parts.values()].sort((left, right) => left.index - right.index).map(item => item.value),
    terminal: exactObject<Extract<StructuredPartsExpectedTerminal, { type: 'none' }>>()({ type: 'none' }),
  }));
  return projected;
}

export function verifyStructuredPartsObservation({ events, expected, settlement }: {
  events: readonly ProductionProviderTraceEvent[];
  expected: StructuredPartsReplayContract['requests'][number];
  settlement: 'fulfilled' | 'rejected';
}): void {
  expect(settlement, `${expected.scenario}/structured settlement`).toBe(expected.settlement);
  expect(projectStructuredEvents({ events }), `${expected.scenario}/ordered parts and caller tool events`).toEqual(expected.events);
}

/** Post-materialization comparison only. This never supplies messages to the
 * runtime. Native template/token/tensor equality remains owned by Full replay. */
export function assertStructuredReplayInputCompatibility({ input, recordedInput, precedingEvents, allowLegacyProjection }: {
  input: unknown;
  recordedInput: unknown;
  precedingEvents: readonly ProductionProviderTraceEvent[] | undefined;
  allowLegacyProjection: 'allowed' | 'forbidden';
}): void {
  if (isDeepStrictEqual(input, recordedInput)) return;
  switch (allowLegacyProjection) {
  case 'forbidden':
    expect(input, 'structured Provider input without a reviewed legacy projection').toEqual(recordedInput);
    return;
  case 'allowed': break;
  default: { const exhaustive: never = allowLegacyProjection; throw new Error(String(exhaustive)); }
  }
  const current = z.object({ messages: z.array(z.unknown()) }).passthrough().parse(input);
  const recorded = z.object({ messages: z.array(z.unknown()) }).passthrough().parse(recordedInput);
  if (current.messages.length !== recorded.messages.length || precedingEvents === undefined) throw new Error('Legacy structured input projection has no matching history');
  const assistantIndices = current.messages.flatMap((message, index) => {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return [];
    return (message as { role?: unknown }).role === 'assistant' && 'parts' in message ? [index] : [];
  });
  if (assistantIndices.length !== 1) throw new Error('Legacy structured input projection requires one parts assistant');
  const index = assistantIndices[0]!;
  const revisions = new Map<string, { index: number; part: unknown }>();
  let messageId: string | undefined;
  for (const event of precedingEvents) {
    switch (event.kind) {
    case 'assistant_message': messageId = event.messageId; revisions.clear(); break;
    case 'part_text':
      if (event.messageId !== messageId) throw new Error('Legacy projection text outside its assistant');
      revisions.set(event.partId, { index: event.index, part: exactObject<{
        id: string; type: 'text' | 'reasoning'; text: string; completeness: 'complete' | 'partial';
      }>()({ id: event.partId, type: event.partType, text: event.text, completeness: event.completeness }) });
      break;
    case 'part_call':
      if (event.messageId !== messageId) throw new Error('Legacy projection call outside its assistant');
      revisions.set(event.partId, { index: event.index, part: exactObject<{
        id: string; type: 'tool_call'; toolCall: { id: string; type: 'function'; function: { name: string; arguments: string } };
      }>()({ id: event.partId, type: 'tool_call', toolCall: {
        id: event.toolCallId, type: 'function', function: { name: event.toolName, arguments: event.modelVisibleArguments },
      } }) });
      break;
    case 'generation_finished': case 'generation_interrupted': case 'generation_error':
    case 'tool-started': case 'tool-output': case 'tool-exit': case 'tool-success': case 'tool-error':
    case 'chunk': case 'assistant-start': case 'tool-call': break;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  }
  const parts = [...revisions.values()].sort((left, right) => left.index - right.index);
  expect(parts.map(item => item.index), 'legacy projection keeps contiguous preceding parts').toEqual(parts.map((_item, partIndex) => partIndex));
  expect(current.messages[index], 'continuation keeps the immediately preceding applied parts exactly')
    .toEqual({ role: 'assistant', parts: parts.map(item => item.part) });
  const projected = { ...current, messages: current.messages.map((message, messageIndex) => messageIndex === index ? recorded.messages[index] : message) };
  expect(projected, 'legacy projection changes only the verified assistant representation').toEqual(recorded);
}

export const TEST_ONLY = {
  projectStructuredEvents,
};
