// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { providerReplayCatalog } from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/provider-evidence-catalog';
import { assembleProviderSequenceEvidence, providerCaseSourceDigest, providerEvidenceDigest, readProviderRequestEvidence } from './provider-replay-evidence';
import { captureScenarioSchema } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-plan';

function repin({ catalog }: { catalog: typeof providerReplayCatalog }) {
  catalog.sequence.provenanceSha256 = providerEvidenceDigest({ value: catalog.provenance });
  for (const reference of catalog.sequence.cases) {
    const source = catalog.cases[reference.caseId as keyof typeof catalog.cases];
    source.provenanceSha256 = providerCaseSourceDigest({ provenance: catalog.provenance, caseId: captureScenarioSchema.parse(source.caseId) });
    reference.sha256 = providerEvidenceDigest({ value: source });
  }
}

describe('Provider request evidence ownership', () => {
  it('reassembles every original Full field without changing its semantic digest', () => {
    const evidence = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(providerEvidenceDigest({ value: evidence })).toBe('931543c6ce517df3fac15456dc56a76e0b6c656059c5d2ca179b8762388fa047');
    expect(evidence.requests).toHaveLength(13);
    expect(evidence.invocations).toHaveLength(13);
  });

  it('keeps source-global ordinals separate from a selected request local ordinal', () => {
    const source = readProviderRequestEvidence({ catalog: providerReplayCatalog, caseId: 'reasoning-high' });
    expect(source.evidence.invocations.map(call => call.localOrdinal)).toEqual([1]);
    expect(providerReplayCatalog.provenance.invocations.filter(row => row.caseId === 'reasoning-high')).toEqual([{ caseId: 'reasoning-high', localOrdinal: 1, sourceCallOrdinal: 9 }]);
  });

  it('rejects changed context or source attribution before reading a request', () => {
    const changedContext = structuredClone(providerReplayCatalog);
    changedContext.context.observedCacheRevision = 'main';
    expect(() => readProviderRequestEvidence({ catalog: changedContext, caseId: 'first-turn' })).toThrow('context pin');
    const changedSource = structuredClone(providerReplayCatalog);
    changedSource.provenance.attributions[0]!.sourceDigests.native = 'a'.repeat(64);
    changedSource.sequence.provenanceSha256 = providerEvidenceDigest({ value: changedSource.provenance });
    expect(() => readProviderRequestEvidence({ catalog: changedSource, caseId: 'first-turn' })).toThrow('source pin');
  });

  it('rejects unavailable output facts hidden by an absent original-field flag', () => {
    const catalog = structuredClone(providerReplayCatalog);
    const mutated = { ...catalog, cases: { ...catalog.cases, 'first-turn': { ...catalog.cases['first-turn'], unavailableOutputOrdinals: [1] } } };
    mutated.sequence.cases[0]!.sha256 = providerEvidenceDigest({ value: mutated.cases['first-turn'] });
    expect(() => readProviderRequestEvidence({ catalog: mutated, caseId: 'first-turn' })).toThrow('Unavailable output cannot be omitted');
    expect(() => assembleProviderSequenceEvidence({ catalog: mutated })).toThrow('Unavailable output cannot be omitted');
  });

  it('rejects input gap facts hidden by an absent original-field flag', () => {
    const catalog = structuredClone(providerReplayCatalog);
    const invocation = catalog.cases['first-turn'].invocations[0]!;
    const gap = { localOrdinal: 2, preInputs: invocation.preInputs, inputs: invocation.inputs, settings: invocation.settings, requestInput: catalog.cases['first-turn'].request.input };
    // The fixture starts with an empty gap array; this mutation deliberately
    // adds the complete alternate evidence shape at the serialized boundary.
    const cases = { ...catalog.cases, 'first-turn': { ...catalog.cases['first-turn'], inputGaps: [gap] } };
    const mutated = { ...catalog, cases, provenance: { ...catalog.provenance, inputGaps: [{ caseId: 'first-turn', localOrdinal: 2, sourceCallOrdinal: 14 }] } };
    mutated.sequence.provenanceSha256 = providerEvidenceDigest({ value: mutated.provenance });
    cases['first-turn'].provenanceSha256 = providerCaseSourceDigest({ provenance: mutated.provenance, caseId: 'first-turn' });
    mutated.sequence.cases[0]!.sha256 = providerEvidenceDigest({ value: cases['first-turn'] });
    expect(() => readProviderRequestEvidence({ catalog: mutated, caseId: 'first-turn' })).toThrow('Input gaps cannot be omitted');
  });

  it('rejects missing local-to-source membership even when outer pins are updated', () => {
    const catalog = structuredClone(providerReplayCatalog);
    catalog.provenance.invocations = catalog.provenance.invocations.filter(row => row.caseId !== 'first-turn');
    repin({ catalog });
    expect(() => readProviderRequestEvidence({ catalog, caseId: 'first-turn' })).toThrow('source correlation');
  });

  it('allows another capture to supply a new independent case without refreshing an old case', () => {
    const catalog = structuredClone(providerReplayCatalog);
    const original = structuredClone(catalog.cases['first-turn']);
    const firstReference = catalog.sequence.cases.find(row => row.caseId === 'first-turn')!;
    const addedReference = catalog.sequence.cases.find(row => row.caseId === 'system-user')!;
    const added = catalog.provenance.attributions.find(row => row.caseId === 'system-user')!;
    added.sourceDigests = { native: 'a'.repeat(64), provider: 'b'.repeat(64), inventory: 'c'.repeat(64) };
    // Start with one case, then append another already recorded contract from a
    // different synthetic capture. No old semantic body or attribution changes.
    const before = { ...catalog, sequence: { ...catalog.sequence, cases: [firstReference], provenanceSha256: providerEvidenceDigest({ value: catalog.provenance }) }, cases: { 'first-turn': catalog.cases['first-turn'] } };
    expect(readProviderRequestEvidence({ catalog: before, caseId: 'first-turn' }).evidence).toEqual(original);
    catalog.cases['system-user'].provenanceSha256 = providerCaseSourceDigest({ provenance: catalog.provenance, caseId: 'system-user' });
    addedReference.sha256 = providerEvidenceDigest({ value: catalog.cases['system-user'] });
    const after = { ...before, sequence: { ...before.sequence, cases: [firstReference, addedReference] }, cases: { ...before.cases, 'system-user': catalog.cases['system-user'] } };
    expect(readProviderRequestEvidence({ catalog: after, caseId: 'first-turn' }).evidence).toEqual(original);
    expect(readProviderRequestEvidence({ catalog: after, caseId: 'system-user' }).evidence.request).toEqual(providerReplayCatalog.cases['system-user'].request);
    expect(after.cases['first-turn']).toEqual(providerReplayCatalog.cases['first-turn']);
    catalog.sequence.provenanceSha256 = after.sequence.provenanceSha256;
    expect(() => assembleProviderSequenceEvidence({ catalog })).toThrow('original capture');
  });

  it('rejects changed whole-sequence order instead of using source ordinals as a hidden scheduler', () => {
    const catalog = structuredClone(providerReplayCatalog);
    [catalog.sequence.cases[0], catalog.sequence.cases[1]] = [catalog.sequence.cases[1]!, catalog.sequence.cases[0]!];
    expect(() => assembleProviderSequenceEvidence({ catalog })).toThrow('whole-sequence order');
  });
});
