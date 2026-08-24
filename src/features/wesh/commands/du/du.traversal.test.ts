import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDuTestContext,
  executeDuTest,
  makeDuTestDirectory,
  type DuTestContext,
  writeDuTestFile,
} from './test-utils';

describe('wesh du traversal', () => {
  let testContext: DuTestContext;

  beforeEach(async () => {
    testContext = await createDuTestContext();
  });

  it('does not follow symlinks by default and follows command-line symlinks with -H', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'target/a.txt',
      data: 'abc',
    });
    await testContext.wesh.vfs.symlink({
      path: '/alias',
      targetPath: '/target',
    });

    const physical = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b alias',
      stdin: '',
    });
    expect(physical.stdout.text).toBe('7\talias\n');
    expect(physical.result.exitCode).toBe(0);

    const followed = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bH alias',
      stdin: '',
    });
    expect(followed.stdout.text).toBe('3\talias\n');
    expect(followed.stderr.text).toBe('');
    expect(followed.result.exitCode).toBe(0);
  });

  it('follows descendant symlinks with -L while preserving display paths', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'target/a.txt',
      data: 'abc',
    });
    await makeDuTestDirectory({
      rootHandle: testContext.rootHandle,
      path: 'tree',
    });
    await testContext.wesh.vfs.symlink({
      path: '/tree/link',
      targetPath: '/target',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bL tree',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
3\ttree/link
3\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('detects symbolic link cycles without recursive stack growth', async () => {
    await makeDuTestDirectory({
      rootHandle: testContext.rootHandle,
      path: 'tree',
    });
    await testContext.wesh.vfs.symlink({
      path: '/tree/loop',
      targetPath: '/tree',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bL tree',
      stdin: '',
    });

    expect(stdout.text).toBe('0\ttree\n');
    expect(stderr.text).toContain("du: cannot access 'tree/loop': symbolic link cycle");
    expect(result.exitCode).toBe(1);
  });

  it('deduplicates repeated operands unless --count-links is used', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'abc',
    });

    const deduplicated = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b tree tree',
      stdin: '',
    });
    expect(deduplicated.stdout.text).toBe('3\ttree\n');

    const counted = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bl tree tree',
      stdin: '',
    });
    expect(counted.stdout.text).toBe(`\
3\ttree
3\ttree
`);
    expect(counted.stderr.text).toBe('');
    expect(counted.result.exitCode).toBe(0);
  });

  it('excludes matching directory subtrees', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'ab',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/sub/b.txt',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --exclude=sub tree',
      stdin: '',
    });

    expect(stdout.text).toBe('2\ttree\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('loads exclusion patterns from files', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.log',
      data: 'ab',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'abc',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'patterns.txt',
      data: `\
*.log
`,
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -ba -X patterns.txt tree',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
3\ttree/a.txt
3\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads NUL-terminated operands from standard input', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'a',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'b.txt',
      data: 'bb',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --files0-from=-',
      stdin: 'a.txt\0b.txt\0',
    });

    expect(stdout.text).toBe(`\
1\ta.txt
2\tb.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves a BOM at the start of every NUL-terminated pathname', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'a',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: '\uFEFFb.txt',
      data: 'bb',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --files0-from=-',
      stdin: 'a.txt\0\uFEFFb.txt\0',
    });

    expect(stdout.text).toBe(`\
1\ta.txt
2\t\uFEFFb.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports empty records from --files0-from and continues', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'a',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --files0-from=-',
      stdin: '\0a.txt\0',
    });

    expect(stdout.text).toBe('1\ta.txt\n');
    expect(stderr.text).toContain('du: -:1: invalid zero-length file name');
    expect(result.exitCode).toBe(1);
  });

  it("rejects '-' from --files0-from standard input and continues", async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'a',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --files0-from=-',
      stdin: '-\0a.txt\0',
    });

    expect(stdout.text).toBe('1\ta.txt\n');
    expect(stderr.text).toContain("du: when reading file names from stdin, no file name of '-' allowed");
    expect(result.exitCode).toBe(1);
  });

  it('uses the last symlink traversal option', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'target/a.txt',
      data: 'abc',
    });
    await testContext.wesh.vfs.symlink({
      path: '/alias',
      targetPath: '/target',
    });

    const physicalLast = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bLP alias',
      stdin: '',
    });
    expect(physicalLast.stdout.text).toBe('7\talias\n');

    const logicalLast = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bPL alias',
      stdin: '',
    });
    expect(logicalLast.stdout.text).toBe('3\talias\n');
    expect(logicalLast.stderr.text).toBe('');
    expect(logicalLast.result.exitCode).toBe(0);
  });

  it('supports path-based exclusion patterns', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'ab',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/sub/b.txt',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: "du -ba --exclude='tree/sub' tree",
      stdin: '',
    });

    expect(stdout.text).toBe(`\
2\ttree/a.txt
2\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('preserves trailing slashes when matching exclusion patterns', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a',
      data: 'a',
    });

    const basenamePattern = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -ba --exclude=tree tree/',
      stdin: '',
    });
    expect(basenamePattern.stdout.text).toBe(`\
1\ttree/a
1\ttree/
`);
    expect(basenamePattern.stderr.text).toBe('');
    expect(basenamePattern.result.exitCode).toBe(0);

    const pathPattern = await executeDuTest({
      wesh: testContext.wesh,
      script: "du -ba --exclude='tree/' tree/",
      stdin: '',
    });
    expect(pathPattern.stdout.text).toBe('');
    expect(pathPattern.stderr.text).toBe('');
    expect(pathPattern.result.exitCode).toBe(0);
  });

  it('matches Unicode exclusion patterns by code point', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/😀.txt',
      data: 'ab',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'abc',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: "du -ba --exclude='😀.txt' tree",
      stdin: '',
    });

    expect(stdout.text).toBe(`\
3\ttree/a.txt
3\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('does not treat reversed character-class ranges as ascending ranges', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/m',
      data: 'a',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: "du -ba --exclude='[z-a]' tree",
      stdin: '',
    });

    expect(stdout.text).toBe(`\
1\ttree/m
1\ttree
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reads operand records from a file without requiring a final NUL', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'a',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'b.txt',
      data: 'bb',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'list.bin',
      data: 'a.txt\0b.txt',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --files0-from=list.bin',
      stdin: '',
    });

    expect(stdout.text).toBe(`\
1\ta.txt
2\tb.txt
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('ignores empty lines in exclude files without changing explicit empty patterns', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'tree/a.txt',
      data: 'a',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'empty-patterns.txt',
      data: `\

`,
    });

    const fromFile = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --exclude-from=empty-patterns.txt tree/',
      stdin: '',
    });
    expect(fromFile.stdout.text).toBe(`\
1\ttree/
`);
    expect(fromFile.stderr.text).toBe('');
    expect(fromFile.result.exitCode).toBe(0);

    const direct = await executeDuTest({
      wesh: testContext.wesh,
      script: "du -b --exclude='' tree/",
      stdin: '',
    });
    expect(direct.stdout.text).toBe('');
    expect(direct.stderr.text).toBe('');
    expect(direct.result.exitCode).toBe(0);
  });

  it('allows exclude patterns and file operands to share standard input in GNU order', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'a.txt',
      data: 'a',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b --exclude-from=- --files0-from=-',
      stdin: `\
a.txt\0`,
    });

    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('measures symbolic link targets as UTF-8 bytes', async () => {
    await testContext.wesh.vfs.symlink({
      path: '/unicode-link',
      targetPath: '/日本',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b unicode-link',
      stdin: '',
    });

    expect(stdout.text).toBe('7\tunicode-link\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('keeps dangling symlinks physical and reports failures when dereferenced', async () => {
    await testContext.wesh.vfs.symlink({
      path: '/dangling',
      targetPath: '/missing',
    });

    const physical = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b dangling',
      stdin: '',
    });
    expect(physical.stdout.text).toBe('8\tdangling\n');
    expect(physical.stderr.text).toBe('');
    expect(physical.result.exitCode).toBe(0);

    const logical = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bL dangling',
      stdin: '',
    });
    expect(logical.stdout.text).toBe('');
    expect(logical.stderr.text).toContain("du: cannot access 'dangling':");
    expect(logical.result.exitCode).toBe(1);
  });

  it('requires trailing-slash operands to resolve to directories', async () => {
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'plain.txt',
      data: 'x',
    });
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: 'target/a.txt',
      data: 'abc',
    });
    await testContext.wesh.vfs.symlink({
      path: '/alias',
      targetPath: '/target',
    });

    const file = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b plain.txt/',
      stdin: '',
    });
    expect(file.stdout.text).toBe('');
    expect(file.stderr.text).toContain("du: cannot access 'plain.txt/': Not a directory");
    expect(file.result.exitCode).toBe(1);

    const directoryLink = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -b alias//',
      stdin: '',
    });
    expect(directoryLink.stdout.text).toBe('3\talias/\n');
    expect(directoryLink.stderr.text).toBe('');
    expect(directoryLink.result.exitCode).toBe(0);
  });

  it('handles deep directory trees without recursive JavaScript calls', async () => {
    let path = 'deep';
    await makeDuTestDirectory({
      rootHandle: testContext.rootHandle,
      path,
    });
    for (let depth = 0; depth < 300; depth += 1) {
      path += '/d';
      await makeDuTestDirectory({
        rootHandle: testContext.rootHandle,
        path,
      });
    }
    await writeDuTestFile({
      rootHandle: testContext.rootHandle,
      path: `${path}/leaf.txt`,
      data: 'x',
    });

    const { result, stdout, stderr } = await executeDuTest({
      wesh: testContext.wesh,
      script: 'du -bs deep',
      stdin: '',
    });

    expect(stdout.text).toBe('1\tdeep\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
