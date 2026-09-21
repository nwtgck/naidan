// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ProductionProviderTraceEvent } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import { projectSingleTextReplayInput, validateSingleTextPartsContract, verifySingleTextPartsObservation } from './provider-replay-single-text-parts';

const contract = { endTokenIds: ['2'] };
const recordedEvents = [
  { kind: 'assistant-start', sequence: 0, phase: 'before-settlement' },
  { kind: 'chunk', chunk: 'Hi ', sequence: 1, phase: 'before-settlement' },
  { kind: 'chunk', chunk: 'there', sequence: 2, phase: 'before-settlement' },
];
const sourceInvocation: Parameters<typeof verifySingleTextPartsObservation>[0]['invocation'] = {
  stream: [{ operation: 'put', groups: [['10']] }, { operation: 'put', groups: [['31']] }, { operation: 'end' }],
  finalized: [{ text: 'Hi ', streamEnd: false }, { text: 'there', streamEnd: true }],
};
const finalized = [{ text: 'H', streamEnd: false }, { text: 'i ', streamEnd: false }, { text: 'there', streamEnd: true }];
const observedEvents: ProductionProviderTraceEvent[] = [
  { sequence: 0, phase: 'before-settlement', kind: 'assistant_message', messageId: 'assistant' },
  { sequence: 1, phase: 'before-settlement', kind: 'part_text', messageId: 'assistant', partId: 'part', index: 0, partType: 'text', text: '', completeness: 'partial' },
  { sequence: 2, phase: 'before-settlement', kind: 'part_text', messageId: 'assistant', partId: 'part', index: 0, partType: 'text', text: 'H', completeness: 'partial' },
  { sequence: 3, phase: 'before-settlement', kind: 'part_text', messageId: 'assistant', partId: 'part', index: 0, partType: 'text', text: 'Hi ', completeness: 'partial' },
  { sequence: 4, phase: 'before-settlement', kind: 'part_text', messageId: 'assistant', partId: 'part', index: 0, partType: 'text', text: 'Hi there', completeness: 'partial' },
  { sequence: 5, phase: 'before-settlement', kind: 'generation_interrupted', reason: 'unknown' },
];

describe('explicit single-text replay observations', () => {
  it('preserves old text with changed native chunk boundaries and a partial result', () => {
    const before = structuredClone({ recordedEvents, sourceInvocation, finalized, observedEvents });
    verifySingleTextPartsObservation({ recordedEvents, invocation: sourceInvocation, contract, observedEvents, finalized });
    expect({ recordedEvents, sourceInvocation, finalized, observedEvents }).toEqual(before);
  });

  it('requires a real native end token for complete parts and a finished result', () => {
    const invocation = { ...sourceInvocation, stream: [
      ...sourceInvocation.stream.slice(0, -1), { operation: 'put' as const, groups: [['2']] }, { operation: 'end' as const },
    ] };
    const completed: ProductionProviderTraceEvent[] = [
      ...observedEvents.slice(0, -1),
      { sequence: 5, phase: 'before-settlement', kind: 'part_text', messageId: 'assistant', partId: 'part', index: 0, partType: 'text', text: 'Hi there', completeness: 'complete' },
      { sequence: 6, phase: 'before-settlement', kind: 'generation_finished', next: 'user' },
    ];
    const flushed = [...finalized, { text: '', streamEnd: true }];
    verifySingleTextPartsObservation({ recordedEvents, invocation, contract, observedEvents: completed, finalized: flushed });
    expect(() => verifySingleTextPartsObservation({ recordedEvents, invocation: sourceInvocation, contract, observedEvents: completed, finalized })).toThrow();
    expect(() => verifySingleTextPartsObservation({ recordedEvents, invocation, contract, observedEvents, finalized: flushed })).toThrow();
  });

  it.each([0, 1, 2, 3, 4, 5])('rejects dropped applied event %i even when later snapshots survive', dropped => {
    const events = observedEvents.filter((_event, index) => index !== dropped).map((event, sequence) => ({ ...event, sequence }));
    expect(() => verifySingleTextPartsObservation({ recordedEvents, invocation: sourceInvocation, contract, observedEvents: events, finalized })).toThrow();
  });

  it.each(['id', 'index', 'type', 'text', 'completeness', 'phase'] as const)('rejects changed part %s', field => {
    const events = observedEvents.map(event => {
      if (event.sequence !== 3 || event.kind !== 'part_text') return event;
      switch (field) {
      case 'id': return { ...event, partId: 'other' };
      case 'index': return { ...event, index: 1 };
      case 'type': return { ...event, partType: 'reasoning' as const };
      case 'text': return { ...event, text: 'Rewritten' };
      case 'completeness': return { ...event, completeness: 'complete' as const };
      case 'phase': return { ...event, phase: 'after-settlement' as const };
      default: { const exhaustive: never = field; throw new Error(String(exhaustive)); }
      }
    });
    expect(() => verifySingleTextPartsObservation({ recordedEvents, invocation: sourceInvocation, contract, observedEvents: events, finalized })).toThrow();
  });

  it('rejects lost native text and refuses to reinterpret tool or multi-assistant evidence', () => {
    expect(() => verifySingleTextPartsObservation({ recordedEvents, invocation: sourceInvocation, contract, observedEvents, finalized: finalized.slice(1) })).toThrow('unchanged decoded text');
    for (const extra of [
      { kind: 'assistant-start', sequence: 3, phase: 'before-settlement' },
      { kind: 'tool-call', sequence: 3, phase: 'before-settlement', toolCallId: 'call', toolName: 'weather', modelVisibleArguments: '{}' },
    ]) {
      expect(() => verifySingleTextPartsObservation({ recordedEvents: [...recordedEvents, extra], invocation: sourceInvocation, contract, observedEvents, finalized })).toThrow();
    }
  });

  it('rejects ambiguous termination declarations and tokens after a native end', () => {
    for (const endTokenIds of [[], ['2', '2'], ['not-a-token']]) {
      expect(() => validateSingleTextPartsContract({ contract: { endTokenIds } })).toThrow();
    }
    expect(() => verifySingleTextPartsObservation({ recordedEvents, invocation: { ...sourceInvocation, stream: [
      { operation: 'put', groups: [['10']] }, { operation: 'put', groups: [['2', '31']] }, { operation: 'end' },
    ] }, contract, observedEvents, finalized })).toThrow('final native end token');
  });
});

describe('continuation input observation', () => {
  const part = { id: 'part', type: 'text', text: 'Hi there', completeness: 'partial' };
  const input = { messages: [{ role: 'user', content: 'Prompt' }, { role: 'assistant', parts: [part] }], tools: [], parameters: { temperature: 0 } };

  it('compares old text only after retaining the exact applied part identity and completeness', () => {
    const before = structuredClone(input);
    expect(projectSingleTextReplayInput({ input, precedingEvents: observedEvents })).toEqual({
      messages: [{ role: 'user', content: 'Prompt' }, { role: 'assistant', content: 'Hi there' }], tools: [], parameters: { temperature: 0 },
    });
    expect(input).toEqual(before);
  });

  it.each([
    { ...part, id: 'new-id' }, { ...part, text: 'Changed' }, { ...part, completeness: 'complete' }, { ...part, type: 'reasoning' },
  ])('rejects unobserved or rewritten history $id/$type/$completeness', changed => {
    expect(() => projectSingleTextReplayInput({ input: { ...input, messages: [{ role: 'assistant', parts: [changed] }] }, precedingEvents: observedEvents })).toThrow();
  });

  it('does not invent a part from legacy callback history or merge multiple parts', () => {
    expect(() => projectSingleTextReplayInput({ input, precedingEvents: undefined })).toThrow();
    expect(() => projectSingleTextReplayInput({ input: { ...input, messages: [{ role: 'assistant', parts: [part, part] }] }, precedingEvents: observedEvents })).toThrow();
  });

  it('rejects an older part when the immediately preceding request produced the same text under another identity', () => {
    const preceding = observedEvents.map(event => event.kind === 'part_text' ? { ...event, partId: 'new-part' } : event);
    expect(() => projectSingleTextReplayInput({ input, precedingEvents: preceding })).toThrow('immediately preceding');
  });
});
