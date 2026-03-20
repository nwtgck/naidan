import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh jq core', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string;
    stdinText?: string;
  }) {
    const stdout = createWeshWriteCaptureHandle();
    const stderr = createWeshWriteCaptureHandle();

    const result = await wesh.execute({
      script,
      stdin: createWeshReadFileHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    return { result, stdout, stderr };
  }

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'jq --help' });
    const missing = await execute({ script: 'jq' });
    const invalid = await execute({ script: 'jq --bogus' });

    expect(help.stdout.text).toContain('Query and transform JSON values');
    expect(help.stdout.text).toContain('usage: jq [FILTER] [FILE]...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stderr.text).toContain('jq: missing filter');
    expect(missing.stderr.text).toContain('usage: jq [FILTER] [FILE]...');
    expect(missing.result.exitCode).toBe(1);

    expect(invalid.stderr.text).toContain("jq: unrecognized option '--bogus'");
    expect(invalid.result.exitCode).toBe(2);
  });

  it('supports core path queries and pipes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
jq '.items[] | .name'`,
      stdinText: `\
{"items":[{"name":"alice"},{"name":"bob"}]}`,
    });

    expect(stdout.text).toBe(`\
"alice"
"bob"
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports builtins and value-producing commas', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
jq '.name, length, keys, type, has("name")'`,
      stdinText: `\
{"name":"alice","age":10}`,
    });

    expect(stdout.text).toBe(`\
"alice"
2
["age","name"]
"object"
true
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports parse and input errors', async () => {
    const parse = await execute({
      script: `\
jq '.foo ='`,
      stdinText: '{}',
    });
    expect(parse.stderr.text).toContain('jq: parse error:');
    expect(parse.result.exitCode).toBe(3);

    const input = await execute({
      script: `\
jq '.'`,
      stdinText: '{invalid',
    });
    expect(input.stderr.text).toContain('jq: invalid JSON input');
    expect(input.result.exitCode).toBe(4);
  });

  it('reports unsupported syntax clearly', async () => {
    const identifier = await execute({
      script: `\
jq 'foo'`,
      stdinText: '{}',
    });
    expect(identifier.stderr.text).toContain("jq: parse error: unsupported syntax: identifier 'foo'");
    expect(identifier.result.exitCode).toBe(3);

    const bracketSyntax = await execute({
      script: `\
jq '.[1:3]'`,
      stdinText: '[1,2,3]',
    });
    expect(bracketSyntax.stderr.text).toContain('jq: parse error: unsupported syntax inside []');
    expect(bracketSyntax.result.exitCode).toBe(3);
  });
});
