import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { capturedFullEvidenceSchema, capturedInvocationSchema, parseCapturedFullReplay } from './provider-replay-test-captured-full';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const scenarioSchema = capturedInvocationSchema.shape.scenario;
const referenceSchema = z.object({ caseId: scenarioSchema, sha256: digestSchema }).strict();
const localInvocationSchema = capturedInvocationSchema.omit({ scenario: true, callOrdinal: true }).extend({ localOrdinal: z.number().int().positive() }).strict();
const localGapSchema = localInvocationSchema.pick({ localOrdinal: true, preInputs: true, inputs: true, settings: true }).extend({ requestInput: z.json() }).strict();
const contextSchema = capturedFullEvidenceSchema.pick({ modelId: true, metadataRevision: true, observedCacheRevision: true, loadReceipt: true, localMetadataPaths: true, metadata: true }).extend({ format: z.literal('provider-resource-context-v1') }).strict();
const caseSchema = z.object({
  format: z.literal('provider-request-evidence-v1'), caseId: scenarioSchema, contextSha256: digestSchema, provenanceSha256: digestSchema,
  request: capturedFullEvidenceSchema.shape.requests.element.omit({ scenario: true }).optional(),
  invocations: z.array(localInvocationSchema), inputGaps: z.array(localGapSchema),
  unavailableOutputOrdinals: z.array(z.number().int().positive()),
}).strict();
const correlationSchema = z.object({ caseId: scenarioSchema, localOrdinal: z.number().int().positive(), sourceCallOrdinal: z.number().int().positive() }).strict();
const provenanceSchema = z.object({
  format: z.literal('provider-source-provenance-v1'), sourceDigests: capturedFullEvidenceSchema.shape.sourceDigests,
  attributions: z.array(z.object({ caseId: scenarioSchema, sourceDigests: capturedFullEvidenceSchema.shape.sourceDigests }).strict()),
  requestOrder: z.array(scenarioSchema), invocations: z.array(correlationSchema), inputGaps: z.array(correlationSchema),
  optionalFields: z.object({ unavailableRecordedCalls: z.boolean(), nativeInputGaps: z.boolean() }).strict(),
}).strict();
const sequenceSchema = z.object({
  format: z.literal('provider-sequence-evidence-v1'), contextSha256: digestSchema, provenanceSha256: digestSchema,
  cases: z.array(referenceSchema),
}).strict();

export type ProviderReplayCatalog = {
  context: unknown; provenance: unknown; sequence: unknown;
  cases: Readonly<Record<string, unknown>>;
};

/** Semantic JSON pins do not depend on indentation or property insertion order. */
export function providerEvidenceDigest({ value }: { value: unknown }): string {
  function canonical({ value: item }: { value: z.infer<ReturnType<typeof z.json>> }): string {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(value => canonical({ value })).join(',')}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical({ value: item[key]! })}`).join(',')}}`;
  }
  return createHash('sha256').update(canonical({ value: z.json().parse(value) })).digest('hex');
}

/** Only this case's attribution is pinned; an unrelated capture may be appended. */
export function providerCaseSourceDigest({ provenance: value, caseId }: { provenance: unknown; caseId: z.infer<typeof scenarioSchema> }): string {
  const provenance = provenanceSchema.parse(value);
  const matches = provenance.attributions.filter(row => row.caseId === caseId);
  if (matches.length !== 1) throw new Error('Missing or duplicate request source attribution');
  return providerEvidenceDigest({ value: {
    sourceDigests: matches[0]!.sourceDigests,
    requestPresent: provenance.requestOrder.includes(caseId),
    invocations: provenance.invocations.filter(row => row.caseId === caseId),
    inputGaps: provenance.inputGaps.filter(row => row.caseId === caseId),
  } });
}

function same({ label, actual, expected }: { label: string; actual: unknown; expected: unknown }) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Provider evidence identity mismatch: ${label}`);
}

/** Check only the selected request, not unrelated case bodies. No discovery glob. */
export function readProviderRequestEvidence({ catalog, caseId }: { catalog: ProviderReplayCatalog; caseId: z.infer<typeof scenarioSchema> }) {
  const context = contextSchema.parse(catalog.context);
  const sequence = sequenceSchema.parse(catalog.sequence);
  const reference = sequence.cases.filter(item => item.caseId === caseId);
  same({ label: 'one explicit request reference', actual: reference.length, expected: 1 });
  const source = catalog.cases[caseId];
  same({ label: `${caseId}/case pin`, actual: providerEvidenceDigest({ value: source }), expected: reference[0]!.sha256 });
  const evidence = caseSchema.parse(source);
  same({ label: 'case identity', actual: evidence.caseId, expected: caseId });
  const contextDigest = providerEvidenceDigest({ value: catalog.context });
  same({ label: 'sequence context pin', actual: contextDigest, expected: sequence.contextSha256 });
  same({ label: `${caseId}/context pin`, actual: contextDigest, expected: evidence.contextSha256 });
  const provenance = provenanceSchema.parse(catalog.provenance);
  const sourceDigest = providerEvidenceDigest({ value: catalog.provenance });
  same({ label: 'sequence source pin', actual: sourceDigest, expected: sequence.provenanceSha256 });
  same({ label: `${caseId}/source pin`, actual: providerCaseSourceDigest({ provenance, caseId }), expected: evidence.provenanceSha256 });
  const ordinals = [...evidence.invocations, ...evidence.inputGaps].map(item => item.localOrdinal).sort((a, b) => a - b);
  same({ label: `${caseId}/local invocation inventory`, actual: ordinals, expected: ordinals.map((_item, index) => index + 1) });
  if (evidence.unavailableOutputOrdinals.some(ordinal => !evidence.invocations.some(item => item.localOrdinal === ordinal))) throw new Error('Unowned unavailable output');
  if (!provenance.optionalFields.unavailableRecordedCalls && evidence.unavailableOutputOrdinals.length !== 0) throw new Error('Unavailable output cannot be omitted from original evidence');
  if (!provenance.optionalFields.nativeInputGaps && evidence.inputGaps.length !== 0) throw new Error('Input gaps cannot be omitted from original evidence');
  same({ label: `${caseId}/source request membership`, actual: provenance.requestOrder.filter(scenario => scenario === caseId).length, expected: evidence.request === undefined ? 0 : 1 });
  for (const [kind, correlations, calls] of [
    ['native', provenance.invocations, evidence.invocations], ['input gap', provenance.inputGaps, evidence.inputGaps],
  ] as const) same({ label: `${caseId}/${kind} source correlation`, actual: correlations.filter(row => row.caseId === caseId).map(row => row.localOrdinal).sort((a, b) => a - b), expected: calls.map(call => call.localOrdinal).sort((a, b) => a - b) });
  const sourceOrdinals = [...provenance.invocations, ...provenance.inputGaps].filter(row => row.caseId === caseId).map(row => row.sourceCallOrdinal);
  if (new Set(sourceOrdinals).size !== sourceOrdinals.length) throw new Error('Duplicate source invocation ordinal');
  return { context, evidence };
}

/** Lossless original projection for the whole-owner regression, not execution IDs. */
export function assembleProviderSequenceEvidence({ catalog }: { catalog: ProviderReplayCatalog }) {
  const sequence = sequenceSchema.parse(catalog.sequence);
  const provenance = provenanceSchema.parse(catalog.provenance);
  same({ label: 'source provenance pin', actual: providerEvidenceDigest({ value: catalog.provenance }), expected: sequence.provenanceSha256 });
  same({ label: 'explicit case inventory', actual: Object.keys(catalog.cases).sort(), expected: sequence.cases.map(item => item.caseId).sort() });
  if (new Set(sequence.cases.map(item => item.caseId)).size !== sequence.cases.length) throw new Error('Duplicate sequence case');
  const selected = sequence.cases.map(({ caseId }) => readProviderRequestEvidence({ catalog, caseId }));
  same({ label: 'whole source attribution inventory', actual: provenance.attributions.map(row => row.caseId).sort(), expected: sequence.cases.map(row => row.caseId).sort() });
  for (const attribution of provenance.attributions) same({ label: 'whole sequence must belong to its original capture', actual: attribution.sourceDigests, expected: provenance.sourceDigests });
  same({ label: 'original whole-sequence order', actual: sequence.cases.map(row => row.caseId), expected: [...new Set([...provenance.requestOrder, ...provenance.inputGaps.map(row => row.caseId)])] });
  const context = selected[0]?.context;
  if (context === undefined) throw new Error('Empty Provider sequence');
  const { format: _format, ...resources } = context;
  const requests = provenance.requestOrder.map(scenario => {
    const request = selected.find(item => item.evidence.caseId === scenario)?.evidence.request;
    if (request === undefined) throw new Error('Missing source request');
    return { scenario, ...request };
  });
  same({ label: 'source request inventory', actual: [...provenance.requestOrder].sort(), expected: selected.filter(item => item.evidence.request !== undefined).map(item => item.evidence.caseId).sort() });
  const invocations = provenance.invocations.map(({ caseId: scenario, localOrdinal, sourceCallOrdinal: callOrdinal }) => {
    const item = selected.find(item => item.evidence.caseId === scenario)?.evidence.invocations.find(item => item.localOrdinal === localOrdinal);
    if (item === undefined) throw new Error('Missing correlated native invocation');
    const { localOrdinal: _localOrdinal, ...facts } = item;
    return { scenario, callOrdinal, ...facts };
  });
  const nativeInputGaps = provenance.inputGaps.map(({ caseId: scenario, localOrdinal, sourceCallOrdinal: callOrdinal }) => {
    const item = selected.find(item => item.evidence.caseId === scenario)?.evidence.inputGaps.find(item => item.localOrdinal === localOrdinal);
    if (item === undefined) throw new Error('Missing correlated input gap');
    const { localOrdinal: _localOrdinal, ...facts } = item;
    return { scenario, callOrdinal, ...facts };
  });
  for (const [kind, rows, expected] of [
    ['native', provenance.invocations, selected.flatMap(item => item.evidence.invocations.map(call => `${item.evidence.caseId}/${call.localOrdinal}`))],
    ['input gap', provenance.inputGaps, selected.flatMap(item => item.evidence.inputGaps.map(call => `${item.evidence.caseId}/${call.localOrdinal}`))],
  ] as const) same({ label: `${kind} correlation inventory`, actual: rows.map(item => `${item.caseId}/${item.localOrdinal}`).sort(), expected: [...expected].sort() });
  const unavailableRecordedCalls = provenance.invocations.filter(item => selected.find(source => source.evidence.caseId === item.caseId)!.evidence.unavailableOutputOrdinals.includes(item.localOrdinal)).map(item => item.sourceCallOrdinal);
  return parseCapturedFullReplay({ value: {
    format: 'captured-production-full-replay-v1', ...resources, sourceDigests: provenance.sourceDigests,
    requests, invocations,
    ...(provenance.optionalFields.unavailableRecordedCalls ? { unavailableRecordedCalls } : {}),
    ...(provenance.optionalFields.nativeInputGaps ? { nativeInputGaps } : {}),
  } });
}

export const TEST_ONLY = {
};
