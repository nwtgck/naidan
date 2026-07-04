import { describe, expect, it } from 'vitest';
import { runCalculator } from '@/features/calculator/logic/run-calculator';
import {
  CALCULATOR_CATEGORY_DEFINITIONS,
  listCalculatorConstants,
  listCalculatorFunctions,
} from '.';

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;
const DECIMAL_15 = { format: 'decimal' as const, significantDigits: 15 };

describe('calculator catalog', () => {
  it('keeps names unique and valid', () => {
    const names = [
      ...listCalculatorConstants().map(definition => definition.name),
      ...listCalculatorFunctions().map(definition => definition.name),
    ];
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(IDENTIFIER_PATTERN);
  });

  it('contains functions only from declared categories', () => {
    const categories = new Set(CALCULATOR_CATEGORY_DEFINITIONS.map(definition => definition.name));
    for (const definition of listCalculatorFunctions()) {
      expect(categories.has(definition.category), definition.name).toBe(true);
    }
  });

  it('does not expose removed transcendental functions', () => {
    const names = listCalculatorFunctions().map(definition => definition.name);
    for (const removed of ['exp', 'ln', 'log', 'log2', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2']) {
      expect(names).not.toContain(removed);
    }
  });

  it('executes every documented example with its documented exactness', () => {
    for (const definition of listCalculatorFunctions()) {
      for (const example of definition.examples) {
        const result = runCalculator({ input: example.expression, output: DECIMAL_15 });
        expect(result.status, `${definition.name}: ${example.expression}`).toBe('success');
        if (result.status !== 'success' || result.output.kind !== 'value') continue;
        expect(result.output.text, `${definition.name}: ${example.expression}`).toBe(example.result);
        expect(result.output.exactness, `${definition.name}: ${example.expression}`).toBe(example.exactness);
      }
    }
  });

  it('keeps generated help within context-oriented size limits', () => {
    const overview = runCalculator({ input: 'help' });
    expect(overview.status).toBe('success');
    if (overview.status === 'success') expect(overview.output.text.length).toBeLessThanOrEqual(4 * 1024);

    for (const definition of listCalculatorFunctions()) {
      const result = runCalculator({ input: `help ${definition.name}` });
      expect(result.status).toBe('success');
      if (result.status === 'success') expect(result.output.text.length).toBeLessThanOrEqual(4 * 1024);
    }

    const all = runCalculator({ input: 'help all' });
    expect(all.status).toBe('success');
    if (all.status === 'success') expect(all.output.text.length).toBeLessThanOrEqual(32 * 1024);
  });
});
