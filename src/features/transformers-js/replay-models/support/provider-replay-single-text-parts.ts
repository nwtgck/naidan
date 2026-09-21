import { expect } from 'vitest';
import { z } from 'zod';
import type { ProductionProviderTraceEvent } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import type { CapturedFullReplayEvidence } from './provider-replay-test-captured-full';

/** Explicit model-owned admission for old captures containing one plain text body.
 * Old callback fulfillment does not establish a native end-of-turn marker. */
export type SingleTextPartsReplayContract = { endTokenIds: readonly string[] };
type Invocation = Pick<CapturedFullReplayEvidence['invocations'][number], 'stream' | 'finalized'>;
type Finalized = Invocation['finalized'];
const legacyEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assistant-start'), sequence: z.number().int().nonnegative(), phase: z.literal('before-settlement') }).strict(),
  z.object({ kind: z.literal('chunk'), chunk: z.string(), sequence: z.number().int().nonnegative(), phase: z.literal('before-settlement') }).strict(),
]);
const textPartSchema = z.object({ id: z.string().min(1), type: z.literal('text'), text: z.string(), completeness: z.enum(['complete', 'partial']) }).strict();
const assistantPartsSchema = z.object({ role: z.literal('assistant'), parts: z.tuple([textPartSchema]) }).strict();
const inputSchema = z.object({ messages: z.array(z.json()), tools: z.json(), parameters: z.json() }).strict();

export function validateSingleTextPartsContract({ contract }: { contract: SingleTextPartsReplayContract }): void {
  const { endTokenIds, ...unhandled } = contract;
  unhandled satisfies Record<PropertyKey, never>;
  z.array(z.string().regex(/^(?:0|[1-9][0-9]*)$/u).max(20)).min(1).parse(endTokenIds);
  if (new Set(endTokenIds).size !== endTokenIds.length) throw new Error('Duplicate plain-text end token');
}

function singleTextTermination({ invocation, contract }: { invocation: Invocation; contract: SingleTextPartsReplayContract }) {
  const generated = invocation.stream.slice(1).flatMap(event => {
    switch (event.operation) {
    case 'put': return event.groups.flat();
    case 'end': return [];
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  });
  const ends = generated.flatMap((id, index) => contract.endTokenIds.includes(id) ? [index] : []);
  if (ends.length > 1 || (ends.length === 1 && ends[0] !== generated.length - 1)) {
    throw new Error('Plain-text replay requires at most one final native end token');
  }
  return ends.length === 1 ? 'complete' : 'partial';
}

/** Native token grouping and tensor/setting gates remain in the native replay.
 * Decoder chunks may split differently after the streamer change. Their exact
 * text must still match the immutable legacy callbacks and each nonempty native
 * delivery must appear in the new consumer's applied part snapshots. */
export function verifySingleTextPartsObservation({ recordedEvents, invocation, contract, observedEvents, finalized }: {
  recordedEvents: readonly unknown[];
  invocation: Invocation;
  contract: SingleTextPartsReplayContract;
  observedEvents: readonly ProductionProviderTraceEvent[];
  finalized: Finalized;
}): void {
  validateSingleTextPartsContract({ contract });
  const legacy = z.array(legacyEventSchema).parse(recordedEvents);
  expect(legacy.map(event => event.sequence), 'legacy event order').toEqual(legacy.map((_event, index) => index));
  if (legacy[0]?.kind !== 'assistant-start' || legacy.slice(1).some(event => event.kind !== 'chunk')) {
    throw new Error('Plain-text comparison requires exactly one legacy assistant');
  }
  const text = legacy.filter(event => event.kind === 'chunk').map(event => event.chunk).join('');
  expect(invocation.finalized.map(event => event.text).join(''), 'recorded native text and public text').toBe(text);
  expect(finalized.map(event => event.text).join(''), 'unchanged decoded text').toBe(text);
  const completeness = singleTextTermination({ invocation, contract });
  expect(finalized.at(-1)?.streamEnd, 'native streamer ended').toBe(true);
  const assistant = observedEvents[0];
  const part = observedEvents[1];
  if (assistant?.kind !== 'assistant_message' || part?.kind !== 'part_text' || !assistant.messageId || !part.partId) {
    throw new Error('Expected one observed assistant and text part');
  }
  const { messageId } = assistant;
  const { partId } = part;
  const expected: ProductionProviderTraceEvent[] = [];
  expected.push({ kind: 'assistant_message', messageId, sequence: 0, phase: 'before-settlement' });
  let applied = '';
  const snapshot = ({ completeness }: { completeness: 'partial' | 'complete' }) => {
    expected.push({ kind: 'part_text', messageId, partId, index: 0, partType: 'text', text: applied, completeness,
      sequence: expected.length, phase: 'before-settlement' });
  };
  snapshot({ completeness: 'partial' });
  for (const event of finalized) {
    if (event.text.length === 0) continue;
    applied += event.text;
    snapshot({ completeness: 'partial' });
  }
  switch (completeness) {
  case 'complete':
    // The structured streamer flushes at the real end token, then at end().
    expect(finalized.filter(event => event.streamEnd)).toHaveLength(2);
    expect(finalized.at(-1)).toEqual({ text: '', streamEnd: true });
    snapshot({ completeness });
    expected.push({ kind: 'generation_finished', next: 'user', sequence: expected.length, phase: 'before-settlement' });
    break;
  case 'partial':
    expect(finalized.filter(event => event.streamEnd)).toHaveLength(1);
    expected.push({ kind: 'generation_interrupted', reason: 'unknown', sequence: expected.length, phase: 'before-settlement' });
    break;
  default: { const exhaustive: never = completeness; throw new Error(String(exhaustive)); }
  }
  expect(observedEvents, 'plain-text parts, every native delivery and native termination').toEqual(expected);
}

/** Compare the inert old input shape only after checking that current parts are
 * exactly the caller's preceding applied history, including IDs/completeness.
 * This is a test projection; neither the real request nor stored data changes. */
export function projectSingleTextReplayInput({ input, precedingEvents }: {
  input: unknown;
  precedingEvents: readonly ProductionProviderTraceEvent[] | undefined;
}): unknown {
  const checked = inputSchema.parse(input);
  return { ...checked, messages: checked.messages.map(message => {
    if (typeof message !== 'object' || message === null || Array.isArray(message) || !('parts' in message)) return message;
    const current = assistantPartsSchema.parse(message);
    const precedingPart = (() => {
      if (precedingEvents === undefined) return undefined;
      const events = precedingEvents;
      const starts = events.filter(event => event.kind === 'assistant_message');
      const revisions = events.filter(event => event.kind === 'part_text');
      const last = revisions.at(-1);
      if (starts.length !== 1 || !last || last.partType !== 'text' || last.index !== 0
        || revisions.some(event => event.messageId !== starts[0]!.messageId || event.partId !== last.partId || event.partType !== 'text' || event.index !== 0)
        || events.some(event => event.kind === 'part_call')) return undefined;
      return { id: last.partId, type: 'text', text: last.text, completeness: last.completeness };
    })();
    expect(precedingPart, 'continuation keeps the immediately preceding applied part exactly').toEqual(current.parts[0]);
    return { role: current.role, content: current.parts[0].text };
  }) };
}

export const TEST_ONLY = {
};
