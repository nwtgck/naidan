import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { TEST_ONLY } from '@/features/wesh/commands/test';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh test', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) {
      throw new Error('path must include a file name');
    }

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function mkdir({
    path,
  }: {
    path: string,
  }) {
    const segments = path.split('/').filter(Boolean);
    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }
  }

  async function execute({
    script,
  }: {
    script: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('supports string truthiness and equality operators', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test value
echo $?
test alpha = alpha
echo $?
test alpha != beta
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });


  it('treats operator-looking values as operands in three-argument string comparisons', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test '!' = '!'
echo $?
test -n != value
echo $?
test -z '<' value
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports lexical string ordering and explicitly signed integers', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test alpha '<' beta
echo $?
test beta '>' alpha
echo $?
test +1 -eq 1
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports bare operand truthiness and negation', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test ""
echo $?
test ! ""
echo $?
[ ! value ]
echo $?`,
    });

    expect(stdout.text).toBe(`\
1
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats operator-looking single operands as ordinary non-empty strings', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test '!'
echo $?
test -n
echo $?
test '('
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('negates operator-looking single operands using the two-argument form', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test ! '!'
echo $?
test ! -n
echo $?`,
    });

    expect(stdout.text).toBe(`\
1
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('treats no-argument test as false and keeps -a higher precedence than -o', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test
echo $?
test value -o "" -a ""
echo $?
test "" -o value -a ""
echo $?`,
    });

    expect(stdout.text).toBe(`\
1
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports integer comparisons including -l string length', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test 5 -gt 3
echo $?
test -l alpha -eq 5
echo $?
test 3 -le 1
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('uses Bash integer operand whitespace rules for test and bracket syntax', async () => {
    const acceptedOperands = [
      ' 1',
      '\t1',
      '\n1',
      '\v1',
      '\f1',
      '\r1',
      '1 ',
      '1\t',
      '\n\t1 \t',
    ];
    const rejectedOperands = [
      '1\n',
      '1\v',
      '1\f',
      '1\r',
      '\u00A01',
      '1\u00A0',
      '\u20031',
      '1\u2003',
      '\uFEFF1',
      '1\uFEFF',
    ];

    for (const operand of acceptedOperands) {
      const quotedOperand = `'${operand}'`;
      const testResult = await execute({ script: `test ${quotedOperand} -eq 1` });
      const bracketResult = await execute({ script: `[ ${quotedOperand} -eq 1 ]` });

      expect(testResult.result.exitCode, JSON.stringify({ command: 'test', operand })).toBe(0);
      expect(testResult.stderr.text).toBe('');
      expect(bracketResult.result.exitCode, JSON.stringify({ command: '[', operand })).toBe(0);
      expect(bracketResult.stderr.text).toBe('');
    }

    for (const operand of rejectedOperands) {
      const quotedOperand = `'${operand}'`;
      const testResult = await execute({ script: `test ${quotedOperand} -eq 1` });
      const bracketResult = await execute({ script: `[ ${quotedOperand} -eq 1 ]` });

      expect(testResult.result.exitCode, JSON.stringify({ command: 'test', operand })).toBe(2);
      expect(testResult.stderr.text).toContain('integer');
      expect(bracketResult.result.exitCode, JSON.stringify({ command: '[', operand })).toBe(2);
      expect(bracketResult.stderr.text).toContain('integer');
    }
  });

  it('compares arbitrarily large signed integers without losing precision', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test 9223372036854775807 -eq 9223372036854775807
echo $?
test 9223372036854775808 -eq 9223372036854775808
echo $?
test 999999999999999999999999999999 -gt 1
echo $?
test -999999999999999999999999999999 -lt -1
echo $?
test +000000000000000000000000000001 -eq 1
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
0
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches GNU arity rules for operator-looking string operands', async () => {
    const context = {} as never;

    const fourArgumentNegation = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['!', '!', '=', '0'],
    });
    const groupedBangOperand = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['(', '!', '=', '0', ')'],
    });
    const groupedUnaryLookingOperand = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['(', '-n', '=', '-n', ')'],
    });
    const generalExpressionBang = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['-n', '0', '-o', '(', 'a', '-o', '!', '=', 'a', ')'],
    });

    expect(fourArgumentNegation).toEqual({ kind: 'success', value: 'true' });
    expect(groupedBangOperand).toEqual({ kind: 'success', value: 'false' });
    expect(groupedUnaryLookingOperand).toEqual({ kind: 'success', value: 'true' });
    expect(generalExpressionBang).toEqual({ kind: 'syntax_error', message: "missing ')'" });
  });

  it('reapplies GNU small-arity rules inside parenthesized expressions', async () => {
    const context = {} as never;

    const groupedOr = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['(', '!', 'b', '-o', '0', ')'],
    });
    const groupedAnd = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['(', '!', 'b', '-a', '', ')'],
    });
    const outerNegation = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: ['!', '(', '!', '', '-o', 'a', ')'],
    });

    expect(groupedOr).toEqual({ kind: 'success', value: 'false' });
    expect(groupedAnd).toEqual({ kind: 'success', value: 'true' });
    expect(outerNegation).toEqual({ kind: 'success', value: 'true' });
  });

  it('evaluates deeply nested negation and grouping without host call-stack recursion', async () => {
    const depth = 20_000;
    const context = {} as never;

    const negated = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: [...Array.from({ length: depth }, () => '!'), 'value'],
    });
    const grouped = await TEST_ONLY.evaluateTestExpression({
      context,
      tokens: [
        ...Array.from({ length: depth }, () => '('),
        'value',
        ...Array.from({ length: depth }, () => ')'),
      ],
    });

    expect(negated).toEqual({ kind: 'success', value: 'true' });
    expect(grouped).toEqual({ kind: 'success', value: 'true' });
  });

  it('supports logical composition with !, -a, -o, and parentheses via bracket syntax', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
[ \\( alpha = beta -o alpha = alpha \\) -a ! -z value ]
echo $?
[ ]
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches symlink semantics for file predicates', async () => {
    await writeFile({ path: 'target.txt', data: 'payload' });
    await mkdir({ path: 'dir' });
    await wesh.vfs.symlink({
      path: '/target.link',
      targetPath: '/target.txt',
    });
    await wesh.vfs.symlink({
      path: '/dir.link',
      targetPath: '/dir',
    });

    const { result, stdout, stderr } = await execute({
      script: `\
test -L target.link
echo $?
test -f target.link
echo $?
test -d dir.link
echo $?
test -L missing.link
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports -h as an alias for -L on symlinks', async () => {
    await writeFile({ path: 'real.txt', data: 'payload' });
    await wesh.vfs.symlink({
      path: '/real.link',
      targetPath: '/real.txt',
    });

    const { result, stdout, stderr } = await execute({
      script: `\
test -h real.link
echo $?`,
    });

    expect(stdout.text).toBe('0\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports file comparisons and special file predicates', async () => {
    await writeFile({ path: 'older.txt', data: 'old' });
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    });
    await writeFile({ path: 'newer.txt', data: 'new' });
    await wesh.vfs.symlink({
      path: '/same.link',
      targetPath: '/older.txt',
    });
    await wesh.vfs.mknod({
      path: '/pipe.fifo',
      type: 'fifo',
    });
    await wesh.vfs.mknod({
      path: '/tty.dev',
      type: 'chardev',
    });

    const { result, stdout, stderr } = await execute({
      script: `\
test older.txt -ef same.link
echo $?
test newer.txt -nt older.txt
echo $?
test -p pipe.fifo
echo $?
test -c tty.dev
echo $?
test -S older.txt
echo $?
test -S missing.sock
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
0
0
1
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('matches missing-file rules for -nt and -ot', async () => {
    await writeFile({ path: 'present.txt', data: 'data' });

    const { result, stdout, stderr } = await execute({
      script: `\
test present.txt -nt missing.txt
echo $?
test missing.txt -ot present.txt
echo $?
test missing-left.txt -nt missing-right.txt
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns false for non-matching file comparisons', async () => {
    await writeFile({ path: 'left.txt', data: 'left' });
    await new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    });
    await writeFile({ path: 'right.txt', data: 'right' });

    const { result, stdout, stderr } = await execute({
      script: `\
test left.txt -ef right.txt
echo $?
test left.txt -nt right.txt
echo $?
test right.txt -ot left.txt
echo $?`,
    });

    expect(stdout.text).toBe(`\
1
1
1
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports access predicates and empty-string checks', async () => {
    await writeFile({ path: 'script.sh', data: 'echo hi\n' });

    const { result, stdout, stderr } = await execute({
      script: `\
test -r script.sh
echo $?
test -w script.sh
echo $?
test -x script.sh
echo $?
test -z ""
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
1
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports file predicates from / with relative operands', async () => {
    await writeFile({ path: 'root.txt', data: 'payload' });

    const { result, stdout, stderr } = await execute({
      script: `\
cd /
test -e root.txt
echo $?
test -f root.txt
echo $?`,
    });

    expect(stdout.text).toBe(`\
0
0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('returns exit status 2 for syntax errors', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test 1 -eq
echo $?
[ alpha = alpha
echo $?
test value extra
echo $?`,
    });

    expect(stdout.text).toBe(`\
2
2
2
`);
    expect(stderr.text).toContain("test: expected integer after '-eq'");
    expect(stderr.text).toContain('usage: test EXPRESSION');
    expect(stderr.text).toContain("[: missing ']'");
    expect(stderr.text).toContain('usage: [ EXPRESSION ]');
    expect(stderr.text).toContain("test: unexpected argument 'extra'");
    expect(result.exitCode).toBe(0);
  });

  it('treats option-looking standalone operands as expressions', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
test --help
printf 'test-help=%s\n' "$?"
test --version
printf 'test-version=%s\n' "$?"
[ --help ]
printf 'bracket-help=%s\n' "$?"`,
    });

    expect(stdout.text).toBe(`\
test-help=0
test-version=0
bracket-help=0
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
