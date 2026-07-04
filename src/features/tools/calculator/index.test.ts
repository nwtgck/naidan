import { describe, expect, it } from 'vitest';
import { CalculatorTool, TEST_ONLY as CALCULATOR_TOOL_TEST_ONLY } from '.';

describe('CalculatorTool', () => {
  it('uses decimal output with 15 significant digits by default', async () => {
    const tool = new CalculatorTool();
    await expect(tool.execute({ args: { expression: '1 / 3' } })).resolves.toEqual({
      status: 'success',
      content: '0.333333333333333',
    });
    await expect(tool.execute({ args: { expression: 'pi * 2' } })).resolves.toEqual({
      status: 'success',
      content: '6.28318530717959',
    });
  });

  it('supports explicit decimal significant digits', async () => {
    const tool = new CalculatorTool();
    await expect(tool.execute({
      args: {
        expression: '1 / 3',
        output: { format: 'decimal', significantDigits: 30 },
      },
    })).resolves.toEqual({
      status: 'success',
      content: '0.333333333333333333333333333333',
    });
  });

  it('supports strict rational output', async () => {
    const tool = new CalculatorTool();
    await expect(tool.execute({
      args: { expression: '1 / 3', output: { format: 'rational' } },
    })).resolves.toEqual({ status: 'success', content: '1/3' });

    const approximate = await tool.execute({
      args: { expression: 'pi * 2', output: { format: 'rational' } },
    });
    expect(approximate.status).toBe('error');
    if (approximate.status === 'error') expect(approximate.code).toBe('execution_failed');
  });

  it('exposes calculator precision help', async () => {
    const tool = new CalculatorTool();
    const result = await tool.execute({ args: { expression: 'help precision' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.content).toContain('Rational Tool output');
  });

  it('strictly rejects invalid Tool argument combinations', async () => {
    const tool = new CalculatorTool();
    const invalidArguments = [
      { expression: '' },
      { expression: '1 / 3', output: { format: 'decimal', significantDigits: 0 } },
      { expression: '1 / 3', output: { format: 'decimal', significantDigits: 51 } },
      { expression: '1 / 3', output: { format: 'decimal', significantDigits: 1.5 } },
      { expression: '1 / 3', output: { format: 'rational', significantDigits: 15 } },
      { expression: '1 / 3', extra: true },
    ];
    for (const args of invalidArguments) {
      const result = await tool.execute({ args });
      expect(result.status, JSON.stringify(args)).toBe('error');
      if (result.status === 'error') expect(result.code).toBe('invalid_arguments');
    }
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
