import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createWeshReadFileHandleFromText,
  createWeshWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh jq integration', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle('root');
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function writeFile({
    path,
    data,
  }: {
    path: string;
    data: string;
  }) {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let dir = rootHandle;
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment, { create: true });
    }

    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

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

  it('supports select and map', async () => {
    const select = await execute({
      script: `\
jq '.items[] | select(.active == true) | .name'`,
      stdinText: `\
{"items":[{"name":"a","active":true},{"name":"b","active":false}]}`,
    });

    expect(select.stdout.text).toBe(`\
"a"
`);
    expect(select.stderr.text).toBe('');
    expect(select.result.exitCode).toBe(0);

    const map = await execute({
      script: `\
jq 'map(.id)'`,
      stdinText: `\
[{"id":1},{"id":2}]`,
    });

    expect(map.stdout.text).toBe('[1,2]\n');
    expect(map.stderr.text).toBe('');
    expect(map.result.exitCode).toBe(0);
  });

  it('supports array and object construction', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
jq '{user: .name, tags: [.tags[]]}'`,
      stdinText: `\
{"name":"alice","tags":["x","y"]}`,
    });

    expect(stdout.text).toBe('{"user":"alice","tags":["x","y"]}\n');
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('supports assignment and update assignment', async () => {
    const assign = await execute({
      script: `\
jq '.user.name = "bob"'`,
      stdinText: `\
{"user":{"name":"alice"}}`,
    });
    expect(assign.stdout.text).toBe('{"user":{"name":"bob"}}\n');
    expect(assign.stderr.text).toBe('');
    expect(assign.result.exitCode).toBe(0);

    const update = await execute({
      script: `\
jq '.count |= . + 1'`,
      stdinText: `\
{"count":1}`,
    });
    expect(update.stdout.text).toBe('{"count":2}\n');
    expect(update.stderr.text).toBe('');
    expect(update.result.exitCode).toBe(0);
  });

  it('supports multiple input JSON values and file input', async () => {
    await writeFile({
      path: 'input.json',
      data: `\
{"id":1}
{"id":2}
`,
    });

    const { result, stdout, stderr } = await execute({
      script: `\
jq '.id' input.json`,
    });

    expect(stdout.text).toBe(`\
1
2
`);
    expect(stderr.text).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('reports update cardinality errors', async () => {
    const runtime = await execute({
      script: `\
jq '.foo |= (., 2)'`,
      stdinText: `\
{"foo":1,"bar":2}`,
    });

    expect(runtime.stderr.text).toContain('|= right-hand side must yield exactly one value');
    expect(runtime.result.exitCode).toBe(4);
  });
});
