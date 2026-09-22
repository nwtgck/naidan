import { describe, expect, it } from 'vitest';
import { assembleProviderSequenceEvidence } from './provider-replay-evidence';
import { providerReplayCatalog } from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/provider-evidence-catalog';
import { parseCapturedFullReplay } from './provider-replay-test-captured-full';
import { assertStructuredReplayInputCompatibility, TEST_ONLY, validateStructuredPartsContract, verifyStructuredInvocationTermination, verifyStructuredPartsInventory, verifyStructuredPartsObservation } from './provider-replay-structured-parts';
import type { ProductionProviderTraceEvent } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';

const evidence = parseCapturedFullReplay({ value: assembleProviderSequenceEvidence({ catalog: providerReplayCatalog }) });

describe('structured parts Full replay contract', () => {
  it('projects stable ordered parts, caller tool execution and terminal results', () => {
    const events: ProductionProviderTraceEvent[] = [
      { kind: 'assistant_message', messageId: 'assistant-1', sequence: 0, phase: 'before-settlement' },
      { kind: 'part_text', messageId: 'assistant-1', partId: 'reasoning', index: 0, partType: 'reasoning', text: '', completeness: 'partial', sequence: 1, phase: 'before-settlement' },
      { kind: 'part_text', messageId: 'assistant-1', partId: 'reasoning', index: 0, partType: 'reasoning', text: 'private', completeness: 'complete', sequence: 2, phase: 'before-settlement' },
      { kind: 'part_call', messageId: 'assistant-1', partId: 'call', index: 1, toolCallId: 'runtime-id', toolName: 'lookup', modelVisibleArguments: '{"city":"Tokyo"}', sequence: 3, phase: 'before-settlement' },
      { kind: 'tool-success', toolCallId: 'runtime-id', content: 'clear', sequence: 4, phase: 'before-settlement' },
      { kind: 'assistant_message', messageId: 'assistant-2', sequence: 5, phase: 'before-settlement' },
      { kind: 'part_text', messageId: 'assistant-2', partId: 'text', index: 0, partType: 'text', text: 'done', completeness: 'complete', sequence: 6, phase: 'before-settlement' },
      { kind: 'generation_finished', next: 'user', sequence: 7, phase: 'before-settlement' },
    ];
    expect(TEST_ONLY.projectStructuredEvents({ events })).toEqual([
      { kind: 'assistant', parts: [
        { type: 'reasoning', text: 'private', completeness: 'complete' },
        { type: 'tool_call', name: 'lookup', arguments: '{"city":"Tokyo"}' },
      ], terminal: { type: 'none' } },
      { kind: 'tool-success', call: 1, content: 'clear' },
      { kind: 'assistant', parts: [{ type: 'text', text: 'done', completeness: 'complete' }], terminal: { type: 'finished', next: 'user' } },
    ]);
    const replaced = events.map(event => event.kind === 'part_text' && event.sequence === 1 ? { ...event, text: 'changed' } : event);
    expect(() => TEST_ONLY.projectStructuredEvents({ events: replaced })).toThrow(/accepted text/);
    const terminalBeforeTool = events.toSpliced(4, 0,
      { kind: 'generation_error', errorName: 'Error', sequence: 4, phase: 'before-settlement' });
    const resequenced = terminalBeforeTool.map((event, sequence) => ({ ...event, sequence }));
    expect(() => TEST_ONLY.projectStructuredEvents({ events: resequenced })).toThrow(/open structured call boundary/);
    expect(TEST_ONLY.projectStructuredEvents({ events: events.slice(0, -1) }).at(-1)).toEqual({
      kind: 'assistant', parts: [{ type: 'text', text: 'done', completeness: 'complete' }], terminal: { type: 'none' },
    });
  });

  it('keeps fulfilled no-result, iterator rejection and delivered errors distinct', () => {
    const noResult: ProductionProviderTraceEvent[] = [
      { kind: 'assistant_message', messageId: 'assistant', sequence: 0, phase: 'before-settlement' },
      { kind: 'part_text', messageId: 'assistant', partId: 'text', index: 0, partType: 'text', text: 'partial', completeness: 'partial', sequence: 1, phase: 'before-settlement' },
    ];
    const fulfilled = { scenario: 'first-turn' as const, settlement: 'fulfilled' as const, events: [{
      kind: 'assistant' as const, parts: [{ type: 'text' as const, text: 'partial', completeness: 'partial' as const }], terminal: { type: 'none' as const },
    }] };
    verifyStructuredPartsObservation({ events: noResult, expected: fulfilled, settlement: 'fulfilled' });
    verifyStructuredPartsObservation({ events: noResult, expected: { ...fulfilled, settlement: 'rejected' }, settlement: 'rejected' });
    expect(() => verifyStructuredPartsObservation({ events: noResult, expected: fulfilled, settlement: 'rejected' })).toThrow(/settlement/);
    expect(TEST_ONLY.projectStructuredEvents({ events: [
      ...noResult,
      { kind: 'generation_error', errorName: 'Error', sequence: 2, phase: 'before-settlement' },
    ] })).toEqual([{ kind: 'assistant', parts: [{ type: 'text', text: 'partial', completeness: 'partial' }], terminal: { type: 'error', errorName: 'Error' } }]);
  });

  it('distinguishes stream-end, native protocol markers and trailing model framing', () => {
    const source = evidence.invocations[0]!;
    const prompt = source.sequence.tokens.slice(0, source.settings.budget.promptTokenCount);
    const partial = { ...source, sequence: { ...source.sequence, tokens: [...prompt, '41', '42'] } };
    const contract = {
      completionTokenIds: ['2', '9'], endTokenIds: ['2'],
      invocations: [{ callOrdinal: source.callOrdinal, terminal: { kind: 'stream-end' as const } }],
      requests: [],
    };
    verifyStructuredInvocationTermination({ invocation: partial, expected: contract.invocations[0]!, contract });
    const completed = { ...source, sequence: { ...source.sequence, tokens: [...prompt, '41', '9', '2'] } };
    verifyStructuredInvocationTermination({
      invocation: completed,
      expected: { callOrdinal: source.callOrdinal, terminal: { kind: 'control', tokenId: '9' } },
      contract,
    });
    const wrongTerminalOrder = { ...source, sequence: { ...source.sequence, tokens: [...prompt, '2', '41', '9'] } };
    expect(() => verifyStructuredInvocationTermination({
      invocation: wrongTerminalOrder,
      expected: { callOrdinal: source.callOrdinal, terminal: { kind: 'control', tokenId: '9' } },
      contract,
    })).toThrow(/does not precede/);
    expect(() => verifyStructuredInvocationTermination({
      invocation: completed, expected: contract.invocations[0]!, contract,
    })).toThrow(/no accepted native control/);

    const framed = { ...source, sequence: { ...source.sequence, tokens: [...prompt, '7', '41', '9', '7', '2'] } };
    const framedTerminal = { callOrdinal: source.callOrdinal,
      terminal: { kind: 'control' as const, tokenId: '9', trailerTokenIds: ['7', '2'] } };
    verifyStructuredInvocationTermination({ invocation: framed, expected: framedTerminal, contract });
    for (const trailerTokenIds of [['8', '2'], ['7'], ['7', '2', '2']] as const) {
      expect(() => verifyStructuredInvocationTermination({
        invocation: framed,
        expected: { ...framedTerminal, terminal: { ...framedTerminal.terminal, trailerTokenIds } },
        contract,
      })).toThrow(/exact.*trailer/);
    }
    const repeatedMarker = { ...source, sequence: { ...source.sequence, tokens: [...prompt, '41', '9', '9', '2'] } };
    expect(() => verifyStructuredInvocationTermination({
      invocation: repeatedMarker,
      expected: { ...framedTerminal, terminal: { ...framedTerminal.terminal, trailerTokenIds: ['9', '2'] } },
      contract,
    })).toThrow(/no later non-end control/);
  });

  it('projects legacy continuity only after exact preceding parts validation', () => {
    const preceding: ProductionProviderTraceEvent[] = [
      { kind: 'assistant_message', messageId: 'assistant', sequence: 0, phase: 'before-settlement' },
      { kind: 'part_text', messageId: 'assistant', partId: 'reasoning', index: 0, partType: 'reasoning', text: 'private', completeness: 'partial', sequence: 1, phase: 'before-settlement' },
      { kind: 'generation_interrupted', reason: 'unknown', sequence: 2, phase: 'before-settlement' },
    ];
    const recordedInput = { messages: [{ role: 'user', content: 'u' }, { role: 'assistant', content: '<think>private' }], tools: [], parameters: {} };
    const input = { messages: [{ role: 'user', content: 'u' }, { role: 'assistant', parts: [{ id: 'reasoning', type: 'reasoning', text: 'private', completeness: 'partial' }] }], tools: [], parameters: {} };
    const expectedLegacyAssistant = { role: 'assistant' as const, content: '<think>private' };
    expect(assertStructuredReplayInputCompatibility({ input, recordedInput, precedingEvents: preceding, expectedLegacyAssistant })).toBeUndefined();
    const changed = structuredClone(input);
    changed.messages[1]!.parts![0]!.text = 'changed';
    expect(() => assertStructuredReplayInputCompatibility({ input: changed, recordedInput, precedingEvents: preceding, expectedLegacyAssistant })).toThrow(/preceding applied parts/);
    const changedRecorded = structuredClone(recordedInput);
    changedRecorded.messages[1]!.content = '<think>changed';
    expect(() => assertStructuredReplayInputCompatibility({ input, recordedInput: changedRecorded, precedingEvents: preceding, expectedLegacyAssistant }))
      .toThrow(/model-owned expected projection/);
  });

  it('rejects unknown declarations and duplicate controls without changing evidence', () => {
    const before = structuredClone(evidence);
    expect(() => validateStructuredPartsContract({ evidence, contract: {
      completionTokenIds: ['2', '2'], endTokenIds: ['2'], invocations: [], requests: [],
    } })).toThrow(/Duplicate/);
    expect(() => validateStructuredPartsContract({ evidence, contract: {
      completionTokenIds: ['2'], endTokenIds: ['2'],
      invocations: [{ callOrdinal: 999, terminal: { kind: 'control', tokenId: '2' } }], requests: [],
    } })).toThrow(/Unknown/);
    expect(() => validateStructuredPartsContract({ evidence, contract: {
      completionTokenIds: ['2'], endTokenIds: ['2'],
      invocations: [{ callOrdinal: evidence.invocations[0]!.callOrdinal,
        terminal: { kind: 'control', tokenId: '2', trailerTokenIds: ['not-a-token-id'] } }], requests: [],
    } })).toThrow();
    expect(evidence).toEqual(before);
  });

  it('rejects missing declarations for replayed requests and native invocations', () => {
    const source = evidence.invocations[0]!;
    const contract = {
      completionTokenIds: ['2'], endTokenIds: ['2'],
      invocations: [{ callOrdinal: source.callOrdinal, terminal: { kind: 'stream-end' as const } }],
      requests: [{ scenario: 'first-turn' as const, settlement: 'fulfilled' as const, events: [] }],
    };
    verifyStructuredPartsInventory({ contract, invocationOrdinals: [source.callOrdinal], requestScenarios: ['first-turn'] });
    expect(() => verifyStructuredPartsInventory({
      contract, invocationOrdinals: [source.callOrdinal, source.callOrdinal + 1], requestScenarios: ['first-turn'],
    })).toThrow(/every replayed structured invocation/);
    expect(() => verifyStructuredPartsInventory({
      contract, invocationOrdinals: [source.callOrdinal], requestScenarios: ['first-turn', 'continuity'],
    })).toThrow(/every settled structured request/);
  });
});
