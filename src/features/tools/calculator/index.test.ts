import { describe, expect, it } from 'vitest';
import { CalculatorTool, TEST_ONLY as CALCULATOR_TOOL_TEST_ONLY } from '.';

describe('CalculatorTool', () => {
  it('preserves the calculator Tool contract', async () => {
    const tool = new CalculatorTool();
    expect(tool.name).toBe('calculator');
    expect(tool.description).toContain('help <topic>');
    await expect(tool.execute({ args: { expression: '2 + 3 * 4' } })).resolves.toEqual({
      status: 'success',
      content: '14',
    });
  });

  it('exposes calculator help through the expression argument', async () => {
    const tool = new CalculatorTool();
    const result = await tool.execute({ args: { expression: 'help log' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.content).toContain('Usage: log(value, base)');
  });

  it('separates invalid Tool arguments from calculator execution errors', async () => {
    const tool = new CalculatorTool();
    const invalidArguments = await tool.execute({ args: { expression: '' } });
    expect(invalidArguments.status).toBe('error');
    if (invalidArguments.status === 'error') expect(invalidArguments.code).toBe('invalid_arguments');

    const invalidExpression = await tool.execute({ args: { expression: 'sqrt(-1)' } });
    expect(invalidExpression.status).toBe('error');
    if (invalidExpression.status === 'error') expect(invalidExpression.code).toBe('execution_failed');
  });

  it('throws AbortError instead of returning a calculator error', async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = new CalculatorTool();
    await expect(tool.execute({ args: { expression: '1 + 1' }, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('keeps source offsets by validating without trimming the expression', () => {
    const parsed = CALCULATOR_TOOL_TEST_ONLY.CalculatorArgsSchema.parse({ expression: '  1 + 1' });
    expect(parsed.expression).toBe('  1 + 1');
  });
});
