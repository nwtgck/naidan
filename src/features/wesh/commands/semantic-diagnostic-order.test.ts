import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

interface OrderingCase {
  readonly name: string,
  readonly semanticArgs: string,
  readonly semanticFragment: string,
}

const orderingCases: readonly OrderingCase[] = [
  { name: 'sort', semanticArgs: '-t xx', semanticFragment: 'multi-character field separator' },
  { name: 'strings', semanticArgs: '-n BADVAL', semanticFragment: 'invalid minimum string length' },
  { name: 'wc', semanticArgs: '--total=BADVAL', semanticFragment: "invalid argument 'BADVAL' for '--total'" },
  { name: 'date', semanticArgs: '--iso-8601=BADVAL', semanticFragment: "invalid argument 'BADVAL' for '--iso-8601'" },
  { name: 'shuf', semanticArgs: '-i BADVAL', semanticFragment: "invalid input range 'BADVAL'" },
  { name: 'cut', semanticArgs: '-f 1 -d xx', semanticFragment: 'delimiter must be a single character' },
  { name: 'cp', semanticArgs: '--update=BADVAL', semanticFragment: "invalid argument 'BADVAL' for '--update'" },
  { name: 'mv', semanticArgs: '--update=BADVAL', semanticFragment: "invalid argument 'BADVAL' for '--update'" },
  { name: 'cmp', semanticArgs: '-n BADVAL', semanticFragment: "invalid --bytes value 'BADVAL'" },
  { name: 'grep', semanticArgs: '-m BADVAL', semanticFragment: 'invalid max count' },
  { name: 'ps', semanticArgs: '-p BADVAL', semanticFragment: 'invalid process ID: BADVAL' },
  { name: 'touch', semanticArgs: '-t BADVAL', semanticFragment: "invalid date format 'BADVAL'" },
  { name: 'du', semanticArgs: '-B BADVAL', semanticFragment: "invalid size suffix in 'BADVAL'" },
];


interface SemanticOrderingCase {
  readonly name: string,
  readonly firstArgs: string,
  readonly firstFragment: string,
  readonly secondArgs: string,
  readonly secondFragment: string,
}

const semanticOrderingCases: readonly SemanticOrderingCase[] = [
  { name: 'sort', firstArgs: '-t xx', firstFragment: 'multi-character field separator', secondArgs: '-o a -o b', secondFragment: 'multiple output files specified' },
  { name: 'strings', firstArgs: '-n BADVAL', firstFragment: 'invalid minimum string length', secondArgs: '-t z', secondFragment: "invalid radix: 'z'" },
  { name: 'shuf', firstArgs: '-i BADVAL', firstFragment: "invalid input range 'BADVAL'", secondArgs: '-o a -o b', secondFragment: 'multiple output files specified' },
  { name: 'touch', firstArgs: '-t BADVAL', firstFragment: "invalid date format 'BADVAL'", secondArgs: '--time=BADVAL', secondFragment: "invalid argument 'BADVAL' for '--time'" },
  { name: 'du', firstArgs: '-B BADVAL', firstFragment: "invalid size suffix in 'BADVAL'", secondArgs: '-t BADVAL', secondFragment: "invalid -t argument 'BADVAL'" },
];

interface RepeatedValueOrderingCase {
  readonly name: string,
  readonly args: string,
  readonly fragment: string,
}

const repeatedValueOrderingCases: readonly RepeatedValueOrderingCase[] = [
  { name: 'strings', args: '-n BADVAL -n 4', fragment: 'invalid minimum string length' },
  { name: 'strings', args: '-n 4 -n BADVAL', fragment: 'invalid minimum string length' },
  { name: 'shuf', args: '-i BADVAL -i 1-2', fragment: "invalid input range 'BADVAL'" },
  { name: 'shuf', args: '-i 1-2 -i BADVAL', fragment: 'multiple -i options specified' },
  { name: 'touch', args: '-t BADVAL -t 202001010000', fragment: "invalid date format 'BADVAL'" },
  { name: 'touch', args: '-t 202001010000 -t BADVAL', fragment: "invalid date format 'BADVAL'" },
  { name: 'wc', args: '--total=BADVAL --total=always', fragment: "invalid argument 'BADVAL' for '--total'" },
  { name: 'wc', args: '--total=always --total=BADVAL', fragment: "invalid argument 'BADVAL' for '--total'" },
  { name: 'date', args: '--iso-8601=BADVAL --iso-8601=date', fragment: "invalid argument 'BADVAL' for '--iso-8601'" },
  { name: 'date', args: '--rfc-3339=BADVAL --rfc-3339=seconds', fragment: "invalid argument 'BADVAL' for '--rfc-3339'" },
  { name: 'cut', args: '-f 1 -d xx -d ,', fragment: 'delimiter must be a single character' },
  { name: 'cut', args: '-f 1 -d , -d xx', fragment: 'delimiter must be a single character' },
];

describe('command semantic and parser diagnostic ordering', () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({ script }: { script: string }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout: stdout.text, stderr: stderr.text };
  }

  it('reports whichever invalid argv condition appears first', async () => {
    for (const orderingCase of orderingCases) {
      const semanticFirst = await execute({
        script: `${orderingCase.name} ${orderingCase.semanticArgs} --NOPE`,
      });
      expect(semanticFirst.result.exitCode, `${orderingCase.name} semantic-first exit`).not.toBe(0);
      expect(semanticFirst.stderr, `${orderingCase.name} semantic-first stderr`)
        .toContain(orderingCase.semanticFragment);
      expect(semanticFirst.stderr, `${orderingCase.name} semantic-first should not report later unknown`)
        .not.toContain('NOPE');

      const diagnosticFirst = await execute({
        script: `${orderingCase.name} --NOPE ${orderingCase.semanticArgs}`,
      });
      expect(diagnosticFirst.result.exitCode, `${orderingCase.name} diagnostic-first exit`).not.toBe(0);
      expect(diagnosticFirst.stderr, `${orderingCase.name} diagnostic-first stderr`).toContain('NOPE');
    }
  });

  it('reports whichever command semantic issue becomes observable first', async () => {
    for (const orderingCase of semanticOrderingCases) {
      const firstThenSecond = await execute({
        script: `${orderingCase.name} ${orderingCase.firstArgs} ${orderingCase.secondArgs}`,
      });
      expect(firstThenSecond.result.exitCode, `${orderingCase.name} first semantic exit`).not.toBe(0);
      expect(firstThenSecond.stderr, `${orderingCase.name} first semantic stderr`)
        .toContain(orderingCase.firstFragment);

      const secondThenFirst = await execute({
        script: `${orderingCase.name} ${orderingCase.secondArgs} ${orderingCase.firstArgs}`,
      });
      expect(secondThenFirst.result.exitCode, `${orderingCase.name} second semantic exit`).not.toBe(0);
      expect(secondThenFirst.stderr, `${orderingCase.name} second semantic stderr`)
        .toContain(orderingCase.secondFragment);
    }
  });

  it('preserves semantic errors across repeated value option occurrences', async () => {
    for (const orderingCase of repeatedValueOrderingCases) {
      const execution = await execute({
        script: `${orderingCase.name} ${orderingCase.args}`,
      });
      expect(execution.result.exitCode, `${orderingCase.name} repeated-value exit`).not.toBe(0);
      expect(execution.stderr, `${orderingCase.name} repeated-value stderr`)
        .toContain(orderingCase.fragment);
    }
  });

});
