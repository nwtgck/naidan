import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { createTextShellSource } from '@/features/wesh/shell/source';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

describe('wesh alias', () => {
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
      source: createTextShellSource({ text: script }),
      stdin: createTestReadHandleFromText({ text: '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it('prints definitions in sorted order with shell quoting', async () => {
    const execution = await execute({
      script: `\
alias z=3 a=1 "quote=x'y"
alias
`,
    });

    expect(execution.stdout.text).toBe("alias a='1'\nalias quote='x'\\''y'\nalias z='3'\n");
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('prints all aliases through -p before processing operands', async () => {
    const execution = await execute({
      script: `\
alias a=1
alias -p a missing
`,
    });

    expect(execution.stdout.text).toBe(`\
alias a='1'
alias a='1'
`);
    expect(execution.stderr.text).toContain('alias: missing: not found');
    expect(execution.result.exitCode).toBe(1);
  });

  it('matches the empty-table -p behavior', async () => {
    const execution = await execute({ script: 'alias -p ignored=1; alias' });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('supports -- and aliases whose names begin with a hyphen', async () => {
    const execution = await execute({ script: "alias -- '-x=1'; alias -- -x" });

    expect(execution.stdout.text).toBe("alias -- -x='1'\n");
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('rejects Bash-invalid metacharacters and quoting characters in alias names', async () => {
    const invalidNames = [
      'a/b',
      'a$b',
      'a`b',
      'a"b',
      "a'b",
      'a\\b',
      'a&b',
      'a|b',
      'a;b',
      'a(b',
      'a)b',
      'a<b',
      'a>b',
    ];

    for (const name of invalidNames) {
      const operand = `${name}=value`;
      const quotedOperand = `'${operand.replaceAll("'", `'"'"'`)}'`;
      const execution = await execute({
        script: `alias -- ${quotedOperand}`,
      });

      expect(execution.stdout.text, name).toBe('');
      expect(execution.stderr.text, name).toContain('invalid alias name');
      expect(execution.result.exitCode, name).toBe(1);
    }
  });

  it('accepts punctuation that Bash permits in alias names', async () => {
    const execution = await execute({
      script: `alias -- 'a+b=1' 'a:b=2' 'a?b=3' 'a*b=4' 'é=5'; alias 'a+b' 'a:b' 'a?b' 'a*b' 'é'`,
    });

    expect(execution.stdout.text).toBe(`\
alias a+b='1'
alias a:b='2'
alias a?b='3'
alias a*b='4'
alias é='5'
`);
    expect(execution.stderr.text).toBe('');
    expect(execution.result.exitCode).toBe(0);
  });

  it('rejects invalid options before modifying aliases', async () => {
    const execution = await execute({ script: 'alias -x a=1' });

    expect(execution.stdout.text).toBe('');
    expect(execution.stderr.text).toContain('invalid option');
    expect(execution.result.exitCode).toBe(2);
  });
});
