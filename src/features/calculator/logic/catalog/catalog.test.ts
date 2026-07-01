import { describe, expect, it } from 'vitest';
import { runCalculator } from '@/features/calculator/logic/run-calculator';
import {
  CALCULATOR_CATEGORY_DEFINITIONS,
  listCalculatorConstants,
  listCalculatorFunctions,
} from '.';

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]*$/;

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

  it('executes every documented example', () => {
    for (const definition of listCalculatorFunctions()) {
      for (const example of definition.examples) {
        const result = runCalculator({ input: example.expression });
        expect(result.status, `${definition.name}: ${example.expression}`).toBe('success');
        if (result.status !== 'success') continue;
        expect(result.output.kind).toBe('value');
        expect(result.output.text, `${definition.name}: ${example.expression}`).toBe(example.result);
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
