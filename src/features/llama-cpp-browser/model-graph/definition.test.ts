import { describe, expect, it } from 'vitest';
import { graphFixture } from './fixtures.test-support';
import { parseModelGraphDefinitions } from './definition';
import { compileModelGraph, modelGraphTensorBytes } from './compile';
import { importModelGraphRegistrations, selectModelGraphRegistration, setModelGraphUseRule } from './registry';
import { modelGraphRequestRegistrations } from './request-registry';

const compile = () => {
  const fixture = graphFixture();
  return { ...fixture, run: () => compileModelGraph({ ...fixture, inputTokens: 2, cacheTokens: 2, capacity: 16, maximumScratchBytes: 4096 }) };
};

describe('model graph declarations', () => {
  it('accepts multiline adjacent objects without external code', () => {
    const { definition } = graphFixture();
    expect(parseModelGraphDefinitions({ input: JSON.stringify(definition, undefined, 2) + JSON.stringify({ ...definition, name: 'Other' }) })).toHaveLength(2);
  });

  it.each(['override', 'enabled', 'script', 'url', 'prototype'])('rejects an undeclared top-level field: %s', field => {
    const { definition } = graphFixture();
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify({ ...definition, [field]: true }) })).toThrow();
  });

  it('rejects future formats and malformed suffixes instead of partially importing', () => {
    const { definition } = graphFixture();
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify({ ...definition, format: 'future' }) })).toThrow();
    expect(() => parseModelGraphDefinitions({ input: JSON.stringify(definition) + ' garbage' })).toThrow();
  });

  it('rejects a forward dependency, duplicate tensor, and unreachable computation', () => {
    for (const mutate of [
      (value: ReturnType<typeof graphFixture>['definition']) => {
        value.graph.nodes[0] = { id: 'hidden', op: 'sigmoid', input: 'later' };
      },
      (value: ReturnType<typeof graphFixture>['definition']) => {
 value.graph.nodes[0]!.id = 'embedding';
      },
      (value: ReturnType<typeof graphFixture>['definition']) => {
        value.graph.nodes.push({ id: 'unused', op: 'sigmoid', input: 'hidden' });
      },
    ]) {
      const { definition } = graphFixture();
      mutate(definition);
      expect(() => parseModelGraphDefinitions({ input: JSON.stringify(definition) })).toThrow();
    }
  });

  it('compiles shape-checked operations and a precise logits contract', () => {
    const { run } = compile();
    expect(run().nodes.map(entry => entry.shape)).toEqual([[4, 2], [5, 2]]);
  });

  it('rejects mismatched weights before a native call', () => {
    const { definition, run } = compile();
    definition.weights[0]!.shape = [3, 5];
    expect(run).toThrow('Weight type or shape');
  });

  it('rejects fractional dimensions, missing parameters, and excessive memory', () => {
    const first = compile();
first.definition.parameters[0]!.value = 1.5;
expect(first.run).toThrow();
const second = compile();
second.definition.parameters = [];
expect(second.run).toThrow();
const { definition, inventory } = graphFixture();
expect(() => compileModelGraph({ definition, inventory, inputTokens: 16, cacheTokens: 16, capacity: 16, maximumScratchBytes: 16 })).toThrow('budget');
  });

  it('validates quantization block size and multiplication overflow', () => {
    expect(modelGraphTensorBytes({ shape: [256, 10], type: 'Q4_K' })).toBe(1440);
    expect(() => modelGraphTensorBytes({ shape: [255, 10], type: 'Q4_K' })).toThrow('block');
    expect(() => modelGraphTensorBytes({ shape: [2147483647, 2147483647], type: 'F32' })).toThrow('overflow');
  });
});

describe('explicit execution authority', () => {
  it('imports disabled and rejects duplicates atomically', () => {
    const source = JSON.stringify(graphFixture().definition);
    const imported = importModelGraphRegistrations({ input: source, existing: [] });
    expect(imported[0]?.rule.mode).toBe('disabled');
    expect(modelGraphRequestRegistrations({ registrations: imported })).toEqual([]);
    expect(() => importModelGraphRegistrations({ input: source + source, existing: [] })).toThrow('already');
  });

  it.each(['replaceNative', 'whenArchitectureUnknown'] as const)('requires local approval: %s', mode => {
    const imported = importModelGraphRegistrations({ input: JSON.stringify(graphFixture().definition), existing: [] });
    const approved = setModelGraphUseRule({ registration: imported[0]!, mode, registrations: imported });
    const registrations = modelGraphRequestRegistrations({ registrations: [approved] });
    expect(selectModelGraphRegistration({ registrations, architecture: 'fixture', nativeRecognized: false })).toBeDefined();
    expect(Boolean(selectModelGraphRegistration({ registrations, architecture: 'fixture', nativeRecognized: true }))).toBe(mode === 'replaceNative');
    expect(selectModelGraphRegistration({ registrations, architecture: 'other', nativeRecognized: false })).toBeUndefined();
  });

  it('does not fall back after source tampering or a conflicting approval', () => {
    const [entry] = importModelGraphRegistrations({ input: JSON.stringify(graphFixture().definition), existing: [] });
    const approved = setModelGraphUseRule({ registration: entry!, mode: 'replaceNative', registrations: [entry!] });
    const [wire] = modelGraphRequestRegistrations({ registrations: [approved] });
    expect(() => selectModelGraphRegistration({ registrations: [{ ...wire!, source: '{}' }], architecture: 'fixture', nativeRecognized: true })).toThrow('stale');
    expect(() => selectModelGraphRegistration({ registrations: [wire!, wire!], architecture: 'fixture', nativeRecognized: true })).toThrow('Conflicting');
  });

  it('can disable an unsupported old declaration without parsing it', () => {
    const [entry] = importModelGraphRegistrations({ input: JSON.stringify(graphFixture().definition), existing: [] });
    expect(setModelGraphUseRule({ registration: { ...entry!, source: '{}' }, mode: 'disabled', registrations: [] }).rule.mode).toBe('disabled');
  });
});
