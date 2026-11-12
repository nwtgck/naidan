import { describe, expect, it } from 'vitest';
import { createGraphExpressionEvaluator, graphConditionSchema, graphNumberSchema, type GraphMetadataValue, type GraphNumber } from './expressions';

function evaluator({ metadata }: { metadata: readonly [string, GraphMetadataValue][] }) {
  return createGraphExpressionEvaluator({
    environment: { parameters: new Map(), variables: new Map([['layer', 2]]), metadata: new Map(metadata), tensors: new Map(), inputTokens: undefined, cacheTokens: undefined, capacity: undefined },
    maximumSteps: 1000,
  });
}

const layered = { metadata: 'fixture.limit', index: { variable: 'layer' }, length: 3, scalar: 'broadcast' } as const;

describe('explicit model metadata forms', () => {
  it('keeps existing indexed references strict and distinguishes scalar, missing and bounds errors', () => {
    const value = { metadata: 'fixture.limit', index: 2 };
    expect(() => evaluator({ metadata: [['fixture.limit', 7]] }).number({ value })).toThrow('Expected metadata array: fixture.limit (received number');
    expect(() => evaluator({ metadata: [] }).number({ value })).toThrow('Missing model metadata array: fixture.limit');
    expect(() => evaluator({ metadata: [['fixture.limit', [7, 8]]] }).number({ value })).toThrow('index 2, actual length 2');
    expect(evaluator({ metadata: [['fixture.limit', [7, 8, 9]]] }).number({ value })).toBe(9);
  });

  it('reads scalar or exact-length vectors only with declared broadcast semantics', () => {
    expect(evaluator({ metadata: [['fixture.limit', 7]] }).number({ value: layered })).toBe(7);
    expect(evaluator({ metadata: [['fixture.limit', [7, 8, 9]]] }).number({ value: layered })).toBe(9);
    expect(graphNumberSchema.parse(layered)).toEqual(layered);
    expect(graphConditionSchema.parse({ ...layered, equals: 7 })).toEqual({ ...layered, equals: 7 });
    expect(evaluator({ metadata: [['fixture.limit', 7]] }).condition({ value: { ...layered, equals: 7 } })).toBe(true);
  });

  it.each([[], [7], [7, 8], [7, 8, 9, 10]].map(values => ({ values })))('does not broadcast or pad an incorrectly sized array $values', ({ values }) => {
    const value = { ...layered, index: 0, fallback: 0 };
    expect(() => evaluator({ metadata: [['fixture.limit', values]] }).number({ value })).toThrow(`expected 3, received ${values.length}`);
  });

  it.each([-1, 0.5, 3, Number.MAX_SAFE_INTEGER])('validates index %s even when metadata is scalar or missing with a fallback', index => {
    for (const metadata of [[['fixture.limit', 7]], []] satisfies [string, GraphMetadataValue][][]) {
      expect(() => evaluator({ metadata }).number({ value: { ...layered, index, fallback: 0 } })).toThrow('index');
    }
  });

  it.each([0, -1, 1.5])('rejects invalid declared length %s', length => {
    expect(() => evaluator({ metadata: [['fixture.limit', 7]] }).number({ value: { ...layered, index: 0, length } })).toThrow('positive integer');
  });

  it.each([true, '7', NaN, Infinity, -Infinity])('does not hide invalid metadata %s behind a fallback', value => {
    expect(() => evaluator({ metadata: [['fixture.limit', value]] }).number({ value: { ...layered, fallback: 0 } })).toThrow();
  });

  it('distinguishes a present zero from absent metadata, and evaluates fallback lazily', () => {
    expect(evaluator({ metadata: [] }).number({ value: { ...layered, fallback: 0 } })).toBe(0);
    expect(evaluator({ metadata: [['fixture.limit', 0]] }).number({ value: { ...layered, fallback: 11 } })).toBe(0);
    expect(() => evaluator({ metadata: [] }).number({ value: layered })).toThrow('Missing model metadata: fixture.limit');
    const invalidFallback = { quotient: [1, 0] } satisfies GraphNumber;
    expect(evaluator({ metadata: [['fixture.limit', 7]] }).number({ value: { ...layered, fallback: invalidFallback } })).toBe(7);
    expect(() => evaluator({ metadata: [] }).number({ value: { ...layered, fallback: invalidFallback } })).toThrow('Division by zero');
    expect(evaluator({ metadata: [['base', 10000]] }).number({ value: { metadata: 'alternate', fallback: { metadata: 'base' } } })).toBe(10000);
    expect(() => evaluator({ metadata: [['alternate', true], ['base', 10000]] }).number({ value: { metadata: 'alternate', fallback: { metadata: 'base' } } })).toThrow('Expected numeric');
  });

  it('applies declared length to strict boolean metadata conditions as well', () => {
    const value = { metadata: 'flags', index: 0, length: 3, equals: true };
    expect(evaluator({ metadata: [['flags', [true, false, true]]] }).condition({ value })).toBe(true);
    expect(() => evaluator({ metadata: [['flags', [true]]] }).condition({ value })).toThrow('Metadata array length mismatch');
    expect(() => evaluator({ metadata: [['flags', true]] }).condition({ value })).toThrow('Expected metadata array');
    expect(() => evaluator({ metadata: [['flags', [1, 0, 1]]] }).condition({ value })).toThrow('condition expects boolean');
    expect(() => evaluator({ metadata: [['flags', ['true', 'false', 'true']]] }).condition({ value })).toThrow('condition expects boolean');
    expect(evaluator({ metadata: [['flags', true]] }).condition({ value: { ...value, scalar: 'broadcast' } })).toBe(true);
  });

  it.each([
    { metadata: 'x', length: 3 }, { metadata: 'x', scalar: 'broadcast' },
    { metadata: 'x', scalar: 'broadcast', index: 0 }, { metadata: 'x', index: 0, fallback: 1 },
    { metadata: 'x', index: 0, length: 3, scalar: 'repeat' },
    { metadata: 'x', index: 0, length: 3, scalar: 'broadcast', fallback: 'guess' },
    { metadata: 'x', fallback: { javascript: 'return 7' } },
  ])('rejects ambiguous or executable metadata syntax %j', value => {
    expect(graphNumberSchema.safeParse(value).success).toBe(false);
    expect(graphConditionSchema.safeParse({ ...value, equals: 1 }).success).toBe(false);
  });

  it('charges fallback recursion and index/length calculations to the shared budget', () => {
    const environment = { parameters: new Map(), variables: new Map(), metadata: new Map(), tensors: new Map(), inputTokens: undefined, cacheTokens: undefined, capacity: undefined };
    const limited = createGraphExpressionEvaluator({ environment, maximumSteps: 3 });
    expect(() => limited.number({ value: { ...layered, index: 0, length: 3, fallback: 0 } })).toThrow('budget');
    let value: GraphNumber = 0;
    for (let i = 0; i < 50; i++) {
      value = { metadata: 'missing', fallback: value };
    }
    expect(() => createGraphExpressionEvaluator({ environment, maximumSteps: 1000 }).number({ value })).toThrow('budget');
  });
});
