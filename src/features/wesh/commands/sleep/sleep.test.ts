import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh sleep', () => {
  let wesh: Wesh;
  let originalWaitForSignalOrTimeout: Wesh['kernel']['waitForSignalOrTimeout'] | undefined;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
    originalWaitForSignalOrTimeout = wesh.kernel.waitForSignalOrTimeout.bind(wesh.kernel);
  });

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('accepts zero seconds', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep 0',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports fractional values, suffixes, and multiple operands', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    const fractional = await execute({
      script: 'sleep 0.5',
    });
    const suffixed = await execute({
      script: 'sleep 2m 1.5h 1d',
    });

    expect(fractional.stdout.text).toBe('');
    expect(fractional.stderr.text).toBe('');
    expect(fractional.result.exitCode).toBe(0);

    expect(suffixed.stdout.text).toBe('');
    expect(suffixed.stderr.text).toBe('');
    expect(suffixed.result.exitCode).toBe(0);

    expect(recordedTimeouts).toEqual([
      500,
      ((2 * 60) + (1.5 * 60 * 60) + (24 * 60 * 60)) * 1000,
    ]);

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });


  it('accepts leading-decimal and scientific notation', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    const leadingDecimal = await execute({
      script: 'sleep .001',
    });
    const scientific = await execute({
      script: 'sleep 1e-3',
    });

    expect(leadingDecimal.stdout.text).toBe('');
    expect(leadingDecimal.stderr.text).toBe('');
    expect(leadingDecimal.result.exitCode).toBe(0);
    expect(scientific.stdout.text).toBe('');
    expect(scientific.stderr.text).toBe('');
    expect(scientific.result.exitCode).toBe(0);
    expect(recordedTimeouts).toEqual([1, 1]);

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });


  it('accepts negative zero and hexadecimal floating intervals', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    const execution = await execute({
      script: 'sleep -- -0 -0.0 -0x0 0x0 0X0s 0x1.8p1',
    });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
    expect(recordedTimeouts).toEqual([3_000]);

    const negative = await execute({
      script: 'sleep -- -0x1',
    });
    expect(negative.stdout.text).toBe('');
    expect(negative.stderr.text).toContain("invalid time interval '-0x1'");
    expect(negative.result.exitCode).toBe(1);
    expect(recordedTimeouts).toEqual([3_000]);

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });

  it('accepts positive infinite intervals for signal-driven waits', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    for (const operand of [
      'inf',
      'INF',
      'Infinity',
      'infinity',
      'InFiNiTy',
      '+inf',
      'infs',
      'Infm',
      'infinityh',
      'Infinityd',
      '+infs',
    ]) {
      const execution = await execute({ script: `sleep ${operand}` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['-inf', 'infS', 'infinityM']) {
      const invalid = await execute({ script: `sleep -- ${operand}` });
      expect(invalid.stdout.text).toBe('');
      expect(invalid.stderr.text).toContain(`invalid time interval '${operand}'`);
      expect(invalid.result.exitCode).toBe(1);
    }
    expect(recordedTimeouts).toEqual(Array.from({ length: 11 }, () => Number.POSITIVE_INFINITY));

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });


  it('rejects negative nonzero underflow but accepts signed lexical zero', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    for (const operand of ['-1e-9999s', '-0x1p-99999h']) {
      const execution = await execute({ script: `sleep -- ${operand}` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain(`invalid time interval '${operand}'`);
      expect(execution.result.exitCode).toBe(1);
    }

    for (const operand of ['-0e9999s', '-0x0p+99999h', '+0x0p+99999m']) {
      const execution = await execute({ script: `sleep -- ${operand}` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    expect(recordedTimeouts).toEqual([0, 0, 0]);

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });

  it('treats positive numeric overflow as an infinite interval', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    for (const operand of [
      '1e999',
      '1E999s',
      '+1e999m',
      '9.9e999h',
      '1e999d',
      '0x1p99999',
      '0X1.FP+99999s',
      '+0x1p99999m',
      '0x1p99999h',
      '0x1p99999d',
    ]) {
      const execution = await execute({ script: `sleep ${operand}` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['-1e999', '-inf', '-0x1p99999m']) {
      const execution = await execute({ script: `sleep -- ${operand}` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid time interval');
      expect(execution.result.exitCode).toBe(1);
    }

    expect(recordedTimeouts).toEqual(Array.from({ length: 10 }, () => Number.POSITIVE_INFINITY));

    if (originalWaitForSignalOrTimeout !== undefined) {
      wesh.kernel.waitForSignalOrTimeout = originalWaitForSignalOrTimeout;
    }
  });

  it('accepts only leading C-locale whitespace in intervals', async () => {
    const recordedTimeouts: number[] = [];
    wesh.kernel.waitForSignalOrTimeout = async ({
      timeoutMs,
    }: {
      timeoutMs: number,
    }) => {
      recordedTimeouts.push(timeoutMs);
      return undefined;
    };

    for (const whitespace of [' ', '\t', '\n', '\v', '\f', '\r']) {
      const execution = await execute({ script: `sleep '${whitespace}0'` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toBe('');
      expect(execution.result.exitCode).toBe(0);
    }

    for (const operand of ['0 ', '\u00a00', '\u20030', '\ufeff0']) {
      const execution = await execute({ script: `sleep '${operand}'` });
      expect(execution.stdout.text).toBe('');
      expect(execution.stderr.text).toContain('invalid time interval');
      expect(execution.result.exitCode).toBe(1);
    }

    expect(recordedTimeouts).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('reports option-like operands unless option parsing is stopped', async () => {
    const optionLike = await execute({
      script: 'sleep 0 -0.1',
    });
    const explicitOperand = await execute({
      script: 'sleep 0 -- -0.1',
    });

    expect(optionLike.stdout.text).toBe('');
    expect(optionLike.stderr.text).toContain("sleep: invalid option -- '0'");
    expect(optionLike.result.exitCode).toBe(1);

    expect(explicitOperand.stdout.text).toBe('');
    expect(explicitOperand.stderr.text).toContain("sleep: invalid time interval '-0.1'");
    expect(explicitOperand.result.exitCode).toBe(1);
  });

  it('reports invalid intervals with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep nope',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain("sleep: invalid time interval 'nope'");
    expect(stderr.text).toContain('usage: sleep NUMBER[SUFFIX]...');
    expect(stderr.text).toContain('try:');
    expect(stderr.text).toContain('--help');
    expect(result.exitCode).toBe(1);
  });

  it('reports missing operands with usage', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep',
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('sleep: missing operand');
    expect(stderr.text).toContain('usage: sleep NUMBER[SUFFIX]...');
    expect(result.exitCode).toBe(1);
  });

  it('prints help with --help', async () => {
    const { result, stdout, stderr } = await execute({
      script: 'sleep --help',
    });

    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('Delay for a specified amount of time');
    expect(stdout.text).toContain('usage: sleep NUMBER[SUFFIX]...');
    expect(stdout.text).toContain('--help');
    expect(result.exitCode).toBe(0);
  });
});
