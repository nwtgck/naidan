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

    const shorthand = await execute({
      script: `\
jq '{name, count}'`,
      stdinText: `\
{"name":"alice","count":2,"ignored":true}`,
    });

    expect(shorthand.stdout.text).toBe('{"name":"alice","count":2}\n');
    expect(shorthand.stderr.text).toBe('');
    expect(shorthand.result.exitCode).toBe(0);
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

    const negativeIndex = await execute({
      script: `\
jq '.[-1].name |= . + "!"'`,
      stdinText: `\
[{"name":"alice"},{"name":"bob"}]`,
    });
    expect(negativeIndex.stdout.text).toBe('[{"name":"alice"},{"name":"bob!"}]\n');
    expect(negativeIndex.stderr.text).toBe('');
    expect(negativeIndex.result.exitCode).toBe(0);
  });

  it('supports del on object and array paths', async () => {
    const objectDelete = await execute({
      script: `\
jq 'del(.user.name)'`,
      stdinText: `\
{"user":{"name":"alice","role":"admin"},"other":1}`,
    });
    expect(objectDelete.stdout.text).toBe('{"user":{"role":"admin"},"other":1}\n');
    expect(objectDelete.stderr.text).toBe('');
    expect(objectDelete.result.exitCode).toBe(0);

    const arrayDelete = await execute({
      script: `\
jq 'del(.[-1])'`,
      stdinText: `\
[1,2,3]`,
    });
    expect(arrayDelete.stdout.text).toBe('[1,2]\n');
    expect(arrayDelete.stderr.text).toBe('');
    expect(arrayDelete.result.exitCode).toBe(0);
  });

  it('supports conditional filters', async () => {
    const conditional = await execute({
      script: `\
jq '.items[] | if .active then .name else empty end'`,
      stdinText: `\
{"items":[{"name":"a","active":true},{"name":"b","active":false},{"name":"c","active":true}]}`,
    });

    expect(conditional.stdout.text).toBe(`\
"a"
"c"
`);
    expect(conditional.stderr.text).toBe('');
    expect(conditional.result.exitCode).toBe(0);

    const elifConditional = await execute({
      script: `\
jq '.items[] | if .kind == "a" then .name elif .kind == "b" then .name + "-b" else empty end'`,
      stdinText: `\
{"items":[{"kind":"a","name":"one"},{"kind":"b","name":"two"},{"kind":"c","name":"three"}]}`,
    });

    expect(elifConditional.stdout.text).toBe(`\
"one"
"two-b"
`);
    expect(elifConditional.stderr.text).toBe('');
    expect(elifConditional.result.exitCode).toBe(0);
  });

  it('supports any and all', async () => {
    const any = await execute({
      script: `\
jq '.groups | any(.active)'`,
      stdinText: `\
{"groups":[{"active":false},{"active":true}]}`,
    });

    expect(any.stdout.text).toBe('true\n');
    expect(any.stderr.text).toBe('');
    expect(any.result.exitCode).toBe(0);

    const all = await execute({
      script: `\
jq '.groups | all(.active)'`,
      stdinText: `\
{"groups":[{"active":true},{"active":true}]}`,
    });

    expect(all.stdout.text).toBe('true\n');
    expect(all.stderr.text).toBe('');
    expect(all.result.exitCode).toBe(0);
  });

  it('supports reverse and sort', async () => {
    const reverse = await execute({
      script: `\
jq '.items | reverse'`,
      stdinText: `\
{"items":[3,1,2]}`,
    });

    expect(reverse.stdout.text).toBe('[2,1,3]\n');
    expect(reverse.stderr.text).toBe('');
    expect(reverse.result.exitCode).toBe(0);

    const sort = await execute({
      script: `\
jq '.items | sort'`,
      stdinText: `\
{"items":[3,1,2]}`,
    });

    expect(sort.stdout.text).toBe('[1,2,3]\n');
    expect(sort.stderr.text).toBe('');
    expect(sort.result.exitCode).toBe(0);
  });

  it('supports contains, startswith, and endswith', async () => {
    const contains = await execute({
      script: `\
jq '.items[] | select(.name | contains("ali")) | .name'`,
      stdinText: `\
{"items":[{"name":"alice"},{"name":"bob"},{"name":"alicia"}]}`,
    });

    expect(contains.stdout.text).toBe(`\
"alice"
"alicia"
`);
    expect(contains.stderr.text).toBe('');
    expect(contains.result.exitCode).toBe(0);

    const startswith = await execute({
      script: `\
jq '.items[] | select(.name | startswith("al")) | .name'`,
      stdinText: `\
{"items":[{"name":"alice"},{"name":"bob"}]}`,
    });

    expect(startswith.stdout.text).toBe('"alice"\n');
    expect(startswith.stderr.text).toBe('');
    expect(startswith.result.exitCode).toBe(0);

    const endswith = await execute({
      script: `\
jq '.items[] | select(.name | endswith("ce")) | .name'`,
      stdinText: `\
{"items":[{"name":"alice"},{"name":"alicia"}]}`,
    });

    expect(endswith.stdout.text).toBe('"alice"\n');
    expect(endswith.stderr.text).toBe('');
    expect(endswith.result.exitCode).toBe(0);
  });

  it('supports flatten, join, min, max, and add', async () => {
    const flatten = await execute({
      script: `\
jq '.items | flatten'`,
      stdinText: `\
{"items":[1,[2,[3]],4]}`,
    });

    expect(flatten.stdout.text).toBe('[1,2,3,4]\n');
    expect(flatten.stderr.text).toBe('');
    expect(flatten.result.exitCode).toBe(0);

    const join = await execute({
      script: `\
jq '.items | join("-")'`,
      stdinText: `\
{"items":["a","b","c"]}`,
    });

    expect(join.stdout.text).toBe('"a-b-c"\n');
    expect(join.stderr.text).toBe('');
    expect(join.result.exitCode).toBe(0);

    const min = await execute({
      script: `\
jq '.items | min'`,
      stdinText: `\
{"items":[3,1,2]}`,
    });

    expect(min.stdout.text).toBe('1\n');
    expect(min.stderr.text).toBe('');
    expect(min.result.exitCode).toBe(0);

    const max = await execute({
      script: `\
jq '.items | max'`,
      stdinText: `\
{"items":[3,1,2]}`,
    });

    expect(max.stdout.text).toBe('3\n');
    expect(max.stderr.text).toBe('');
    expect(max.result.exitCode).toBe(0);

    const add = await execute({
      script: `\
jq '.items | add'`,
      stdinText: `\
{"items":[1,2,3]}`,
    });

    expect(add.stdout.text).toBe('6\n');
    expect(add.stderr.text).toBe('');
    expect(add.result.exitCode).toBe(0);
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
