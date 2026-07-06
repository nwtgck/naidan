import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDuTestContext,
  executeDuTest,
  makeDuTestDirectory,
  type DuTestContext,
  writeDuTestFile,
} from './test-utils';

describe('wesh du core behavior', () => {
  let testContext: DuTestContext;

  beforeEach(async () => {
    testContext = await createDuTestContext();
  });

  async function createTree(): Promise<void> {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'abc',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/sub/b.txt',
      data: '12345',
    });
  }

  it('reports logical byte totals in post-order with -b', async () => {
    await createTree();

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b tree',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
5\ttree/sub
8\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('prints files with --all and summarizes with --summarize', async () => {
    await createTree();

    const all = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -ba tree',
      stdin: '',
    });
    expect(all.stdout.text).toBe(`\
3\ttree/a.txt
5\ttree/sub/b.txt
5\ttree/sub
8\ttree
`);
    expect(all.stderr.text).toBe('');
    expect(all.result.exitCode).toBe(0);

    const summary = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bs tree',
      stdin: '',
    });
    expect(summary.stdout.text).toBe('8\ttree\n');
    expect(summary.stderr.text).toBe('');
    expect(summary.result.exitCode).toBe(0);
  });

  it('limits displayed depth without skipping descendant accounting', async () => {
    await createTree();

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --max-depth=0 tree',
      stdin: '',
    });

    expect(stdout.text).toBe('8\ttree\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports separate directory totals and a complete grand total', async () => {
    await createTree();

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bSc tree',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
5\ttree/sub
3\ttree
8\ttotal
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('applies thresholds only to ordinary entries', async () => {
    await createTree();

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bc --threshold=6 tree',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
8\ttree
8\ttotal
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('rounds block units upward and supports human-readable output', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'exact.txt',
      data: 'x'.repeat(1024),
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'large.txt',
      data: 'x'.repeat(1025),
    });

    const exact = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bh exact.txt',
      stdin: '',
    });
    expect(exact.stdout.text).toBe('1.0K\texact.txt\n');

    const blocks = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du large.txt',
      stdin: '',
    });
    expect(blocks.stdout.text).toBe('2\tlarge.txt\n');

    const human = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bh large.txt',
      stdin: '',
    });
    expect(human.stdout.text).toBe('1.1K\tlarge.txt\n');
    expect(human.stderr.text).toBe('');
    expect(human.result.exitCode).toBe(0);
  });

  it('counts entries with --inodes', async () => {
    await createTree();

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du --inodes tree',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
2\ttree/sub
4\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses NUL record termination with --null', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -0b a.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('3\ta.txt\0');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses the current directory when no operand is provided', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'work/file.txt',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'cd work && du -b',
      stdin: '',
    });

    expect(stdout.text).toBe('3\t.\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('continues after an inaccessible operand and preserves successful output', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'good.txt',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b missing.txt good.txt',
      stdin: '',
    });

    expect(stdout.text).toBe('3\tgood.txt\n');
    expect(stderr.text).toContain("du: cannot access 'missing.txt':");
    expect(result.exitCode).toBe(1);
  });

  it('is available through command lookup and explicit /bin paths', async () => {
    const lookup = await executeDuTest({
      wesh: testContext.wesh,
      script: 'command -v du',
      stdin: '',
    });
    expect(lookup.stdout.text).toBe('du\n');
    expect(lookup.stderr.text).toBe('');
    expect(lookup.result.exitCode).toBe(0);

    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'file.txt',
      data: 'abc',
    });
    const explicit = await executeDuTest({
      wesh: testContext.wesh,
      script: '/bin/du -b file.txt',
      stdin: '',
    });
    expect(explicit.stdout.text).toBe('3\tfile.txt\n');
    expect(explicit.stderr.text).toBe('');
    expect(explicit.result.exitCode).toBe(0);
  });

  it('normalizes repeated trailing slashes in generated display paths', async () => {
    await createTree();

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b tree//',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
5\ttree/sub
8\ttree/
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports empty directories as zero logical bytes', async () => {
    await makeDuTestDirectory({
      rootHandle: testContext.rootHandle,
      path: 'empty',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b empty',
      stdin: '',
    });

    expect(stdout.text).toBe('0\tempty\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
