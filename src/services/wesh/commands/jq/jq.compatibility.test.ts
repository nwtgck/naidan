import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh jq compatibility', () => {
  let wesh: Wesh;
  let rootHandle: MockFileSystemDirectoryHandle;

  beforeEach(async () => {
    rootHandle = new MockFileSystemDirectoryHandle({ name: 'root' });
    wesh = new Wesh({ rootHandle: rootHandle as unknown as FileSystemDirectoryHandle });
    await wesh.init();
  });

  async function execute({
    script,
    stdinText,
  }: {
    script: string,
    stdinText?: string,
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      script,
      stdin: createTestReadHandleFromText({ text: stdinText ?? '' }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  async function writeFile({
    path,
    data,
  }: {
    path: string,
    data: string,
  }): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    const fileName = segments.pop();
    if (fileName === undefined) throw new Error('path must include a file name');

    let directory = rootHandle;
    for (const segment of segments) {
      directory = await directory.getDirectoryHandle(segment, { create: true });
    }
    const handle = await directory.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  it('matches jq output modes', async () => {
    const pretty = await execute({
      script: `jq '.'`,
      stdinText: '{"b":1,"a":"é"}',
    });
    expect(pretty.stdout.text).toBe(`{
  "b": 1,
  "a": "é"
}
`);
    expect(pretty.stderr.text).toBe('');
    expect(pretty.result.exitCode).toBe(0);

    const compactSortedAscii = await execute({
      script: `jq -cSa '.'`,
      stdinText: '{"b":1,"a":"é"}',
    });
    expect(compactSortedAscii.stdout.text).toBe('{"a":"\\u00e9","b":1}\n');
    expect(compactSortedAscii.stderr.text).toBe('');
    expect(compactSortedAscii.result.exitCode).toBe(0);

    const rawJoined = await execute({
      script: `jq -rj '.[]'`,
      stdinText: '["a","b"]',
    });
    expect(rawJoined.stdout.text).toBe('ab');
    expect(rawJoined.stderr.text).toBe('');
    expect(rawJoined.result.exitCode).toBe(0);

    const rawZero = await execute({
      script: `jq --raw-output0 '.[]'`,
      stdinText: '["a","b"]',
    });
    expect(rawZero.stdout.text).toBe('a\0b\0');
    expect(rawZero.stderr.text).toBe('');
    expect(rawZero.result.exitCode).toBe(0);
  });

  it('supports null, raw, and slurped input', async () => {
    const nullInput = await execute({
      script: `jq -nc '[., $ARGS]' --args one two`,
    });
    expect(nullInput.stdout.text).toBe('[null,{"positional":["one","two"],"named":{}}]\n');
    expect(nullInput.stderr.text).toBe('');
    expect(nullInput.result.exitCode).toBe(0);

    const rawLines = await execute({
      script: `jq -Rc '.'`,
      stdinText: `\
a
b
`,
    });
    expect(rawLines.stdout.text).toBe(`\
"a"
"b"
`);
    expect(rawLines.stderr.text).toBe('');
    expect(rawLines.result.exitCode).toBe(0);

    const rawSlurp = await execute({
      script: `jq -Rsc '.'`,
      stdinText: `\
a
b
`,
    });
    expect(rawSlurp.stdout.text).toBe('"a\\nb\\n"\n');
    expect(rawSlurp.stderr.text).toBe('');
    expect(rawSlurp.result.exitCode).toBe(0);

    const jsonSlurp = await execute({
      script: `jq -sc '.'`,
      stdinText: `\
1
2
`,
    });
    expect(jsonSlurp.stdout.text).toBe('[1,2]\n');
    expect(jsonSlurp.stderr.text).toBe('');
    expect(jsonSlurp.result.exitCode).toBe(0);
  });

  it('supports jq variables and file-backed arguments', async () => {
    await writeFile({ path: '/filter.jq', data: '{raw: $raw, values: $values}' });
    await writeFile({ path: '/raw.txt', data: `\
hello
world
` });
    await writeFile({ path: '/values.json', data: `\
1
{"x":2}
` });

    const injected = await execute({
      script: `jq -nc --arg name alice --argjson count 2 '{name: $name, count: $count, named: $ARGS.named}'`,
    });
    expect(injected.stdout.text).toBe('{"name":"alice","count":2,"named":{"name":"alice","count":2}}\n');
    expect(injected.stderr.text).toBe('');
    expect(injected.result.exitCode).toBe(0);

    const fromFiles = await execute({
      script: `jq -nc -f /filter.jq --rawfile raw /raw.txt --slurpfile values /values.json`,
    });
    expect(fromFiles.stdout.text).toBe('{"raw":"hello\\nworld\\n","values":[1,{"x":2}]}\n');
    expect(fromFiles.stderr.text).toBe('');
    expect(fromFiles.result.exitCode).toBe(0);
  });

  it('supports comments, interpolation, dynamic access, and update operators', async () => {
    const transformed = await execute({
      script: `jq -c --arg key x '# comment\n{label: "\\(.name):\\u2603", chosen: [.items[1,2]], dynamic: {($key): .nested[$key]}, slice: .items[1:]}'`,
      stdinText: '{"name":"alice","items":[10,20,30],"nested":{"x":1}}',
    });
    expect(transformed.stdout.text).toBe('{"label":"alice:☃","chosen":[20,30],"dynamic":{"x":1},"slice":[20,30]}\n');
    expect(transformed.stderr.text).toBe('');
    expect(transformed.result.exitCode).toBe(0);

    const recursive = await execute({
      script: `jq -c '[.. | numbers]'`,
      stdinText: '{"a":[1,{"b":2}],"c":3}',
    });
    expect(recursive.stdout.text).toBe('[1,2,3]\n');
    expect(recursive.stderr.text).toBe('');
    expect(recursive.result.exitCode).toBe(0);

    const updated = await execute({
      script: `jq -c '.count %= 4 | .name //= "unknown" | .items[0] += 5'`,
      stdinText: '{"count":10,"name":null,"items":[1,2]}',
    });
    expect(updated.stdout.text).toBe('{"count":2,"name":"unknown","items":[6,2]}\n');
    expect(updated.stderr.text).toBe('');
    expect(updated.result.exitCode).toBe(0);
  });

  it('supports entries, paths, stream controls, and collection builtins', async () => {
    const entries = await execute({
      script: `jq -c '{entries: to_entries, rebuilt: (to_entries | from_entries), changed: with_entries(.key |= ascii_upcase)}'`,
      stdinText: '{"a":1,"b":2}',
    });
    expect(entries.stdout.text).toBe('{"entries":[{"key":"a","value":1},{"key":"b","value":2}],"rebuilt":{"a":1,"b":2},"changed":{"A":1,"B":2}}\n');
    expect(entries.stderr.text).toBe('');
    expect(entries.result.exitCode).toBe(0);

    const paths = await execute({
      script: `jq -c '[getpath(["a","b"]), setpath(["a","b"]; 2), delpaths([["a","b"]])]'`,
      stdinText: '{"a":{"b":1},"x":3}',
    });
    expect(paths.stdout.text).toBe('[1,{"a":{"b":2},"x":3},{"a":{},"x":3}]\n');
    expect(paths.stderr.text).toBe('');
    expect(paths.result.exitCode).toBe(0);

    const streamControls = await execute({
      script: `jq -nc '[limit(2; range(0;5)), nth(3; range(0;5)), isempty(empty), isempty(1)]'`,
    });
    expect(streamControls.stdout.text).toBe('[0,1,3,true,false]\n');
    expect(streamControls.stderr.text).toBe('');
    expect(streamControls.result.exitCode).toBe(0);

    const collections = await execute({
      script: `jq -nc '[([1,3,5] | bsearch(3)), ([[1,2],[3]] | transpose), ([ [[1,2],["a","b"]] | combinations ])]'`,
    });
    expect(collections.stdout.text).toBe('[1,[[1,3],[2,null]],[[1,"a"],[1,"b"],[2,"a"],[2,"b"]]]\n');
    expect(collections.stderr.text).toBe('');
    expect(collections.result.exitCode).toBe(0);
  });

  it('preserves jq ordering and safely handles prototype-like keys', async () => {
    const ordering = await execute({
      script: `jq -nc '[(1,2) + (10,20)], ([null,false,true,1,"a",[],{}] | sort)'`,
    });
    expect(ordering.stdout.text).toBe(`\
[11,12,21,22]
[null,false,true,1,"a",[],{}]
`);
    expect(ordering.stderr.text).toBe('');
    expect(ordering.result.exitCode).toBe(0);

    const prototypeKeys = await execute({
      script: `jq -c '. + ([{"key":"__proto__","value":1},{"key":"constructor","value":2},{"key":"prototype","value":3}] | from_entries)'`,
      stdinText: '{"safe":true}',
    });
    expect(prototypeKeys.stdout.text).toBe('{"safe":true,"__proto__":1,"constructor":2,"prototype":3}\n');
    expect(prototypeKeys.stderr.text).toBe('');
    expect(prototypeKeys.result.exitCode).toBe(0);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('stops processing files after a JSON parse error', async () => {
    await writeFile({ path: '/invalid.json', data: 'invalid\n' });
    await writeFile({ path: '/later.json', data: '1\n' });

    const result = await execute({
      script: `jq -c '.' /invalid.json /later.json`,
    });

    expect(result.stdout.text).toBe('');
    expect(result.stderr.text).toContain('jq: parse error:');
    expect(result.result.exitCode).toBe(5);
  });

  it('matches jq exit-status behavior and compile-time diagnostics', async () => {
    const empty = await execute({ script: `jq -ne 'empty'` });
    const falseValue = await execute({ script: `jq -ne 'false'` });
    const trueValue = await execute({ script: `jq -ne 'true'` });
    const badArity = await execute({ script: `jq -n 'length(1)'` });
    const missingVariable = await execute({ script: `jq -n '$missing'` });

    expect(empty.result.exitCode).toBe(4);
    expect(falseValue.result.exitCode).toBe(1);
    expect(trueValue.result.exitCode).toBe(0);
    expect(badArity.stderr.text).toContain('length/1 is not defined');
    expect(badArity.result.exitCode).toBe(3);
    expect(missingVariable.stderr.text).toContain('$missing is not defined');
    expect(missingVariable.result.exitCode).toBe(3);
  });
});
