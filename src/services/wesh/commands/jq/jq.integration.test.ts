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

  it('supports try and catch', async () => {
    const fallback = await execute({
      script: `\
jq '.items[] | try .name catch "missing"'`,
      stdinText: `\
{"items":[{"name":"alice"},1,{"name":"bob"}]}`,
    });

    expect(fallback.stdout.text).toBe(`\
"alice"
"missing"
"bob"
`);
    expect(fallback.stderr.text).toBe('');
    expect(fallback.result.exitCode).toBe(0);

    const errorMessage = await execute({
      script: `\
jq '.items[] | try .name catch .'`,
      stdinText: `\
{"items":[1]}`,
    });

    expect(errorMessage.stdout.text).toContain('cannot access field');
    expect(errorMessage.stderr.text).toBe('');
    expect(errorMessage.result.exitCode).toBe(0);
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

  it('supports split, explode, implode, inside, ltrimstr, and rtrimstr', async () => {
    const split = await execute({
      script: `\
jq '.text | split(",")'`,
      stdinText: `\
{"text":"a,b,c"}`,
    });

    expect(split.stdout.text).toBe('["a","b","c"]\n');
    expect(split.stderr.text).toBe('');
    expect(split.result.exitCode).toBe(0);

    const explode = await execute({
      script: `\
jq '.text | explode'`,
      stdinText: `\
{"text":"A😀"}`,
    });

    expect(explode.stdout.text).toBe('[65,128512]\n');
    expect(explode.stderr.text).toBe('');
    expect(explode.result.exitCode).toBe(0);

    const implode = await execute({
      script: `\
jq '.codes | implode'`,
      stdinText: `\
{"codes":[65,128512]}`,
    });

    expect(implode.stdout.text).toBe('"A😀"\n');
    expect(implode.stderr.text).toBe('');
    expect(implode.result.exitCode).toBe(0);

    const inside = await execute({
      script: `\
jq '.item | inside({"name":"alice","role":"admin"})'`,
      stdinText: `\
{"item":{"name":"alice"},"container":{"name":"alice","role":"admin"}}`,
    });

    expect(inside.stdout.text).toBe('true\n');
    expect(inside.stderr.text).toBe('');
    expect(inside.result.exitCode).toBe(0);

    const ltrimstr = await execute({
      script: `\
jq '.text | ltrimstr("pre-")'`,
      stdinText: `\
{"text":"pre-value"}`,
    });

    expect(ltrimstr.stdout.text).toBe('"value"\n');
    expect(ltrimstr.stderr.text).toBe('');
    expect(ltrimstr.result.exitCode).toBe(0);

    const rtrimstr = await execute({
      script: `\
jq '.text | rtrimstr(".tmp")'`,
      stdinText: `\
{"text":"report.tmp"}`,
    });

    expect(rtrimstr.stdout.text).toBe('"report"\n');
    expect(rtrimstr.stderr.text).toBe('');
    expect(rtrimstr.result.exitCode).toBe(0);
  });

  it('supports first and last', async () => {
    const first = await execute({
      script: `\
jq 'first(.items[])'`,
      stdinText: `\
{"items":[3,1,2]}`,
    });

    expect(first.stdout.text).toBe('3\n');
    expect(first.stderr.text).toBe('');
    expect(first.result.exitCode).toBe(0);

    const last = await execute({
      script: `\
jq 'last(.items[] | .name)'`,
      stdinText: `\
{"items":[{"name":"alice"},{"name":"bob"}]}`,
    });

    expect(last.stdout.text).toBe('"bob"\n');
    expect(last.stderr.text).toBe('');
    expect(last.result.exitCode).toBe(0);
  });

  it('supports ascii case conversion builtins', async () => {
    const downcase = await execute({
      script: `\
jq '.text | ascii_downcase'`,
      stdinText: `\
{"text":"AbC-123"}`,
    });

    expect(downcase.stdout.text).toBe('"abc-123"\n');
    expect(downcase.stderr.text).toBe('');
    expect(downcase.result.exitCode).toBe(0);

    const upcase = await execute({
      script: `\
jq '.text | ascii_upcase'`,
      stdinText: `\
{"text":"AbC-123"}`,
    });

    expect(upcase.stdout.text).toBe('"ABC-123"\n');
    expect(upcase.stderr.text).toBe('');
    expect(upcase.result.exitCode).toBe(0);
  });

  it('supports range and tonumber', async () => {
    const range = await execute({
      script: `\
jq 'range(1, 6, 2)'`,
      stdinText: 'null',
    });

    expect(range.stdout.text).toBe(`\
1
3
5
`);
    expect(range.stderr.text).toBe('');
    expect(range.result.exitCode).toBe(0);

    const tonumber = await execute({
      script: `\
jq '.items[] | tonumber'`,
      stdinText: `\
{"items":["10","-2.5",3]}`,
    });

    expect(tonumber.stdout.text).toBe(`\
10
-2.5
3
`);
    expect(tonumber.stderr.text).toBe('');
    expect(tonumber.result.exitCode).toBe(0);
  });

  it('supports floor, ceil, and round', async () => {
    const numeric = await execute({
      script: `\
jq '.items[] | [floor, ceil, round]'`,
      stdinText: `\
{"items":[1.2,1.5,-1.2]}`,
    });

    expect(numeric.stdout.text).toBe(`\
[1,2,1]
[1,2,2]
[-2,-1,-1]
`);
    expect(numeric.stderr.text).toBe('');
    expect(numeric.result.exitCode).toBe(0);
  });

  it('supports as variable bindings', async () => {
    const objectBinding = await execute({
      script: `\
jq '.user.name as $name | {name: $name, age: .user.age}'`,
      stdinText: `\
{"user":{"name":"alice","age":20}}`,
    });

    expect(objectBinding.stdout.text).toBe('{"name":"alice","age":20}\n');
    expect(objectBinding.stderr.text).toBe('');
    expect(objectBinding.result.exitCode).toBe(0);

    const iterateBinding = await execute({
      script: `\
jq '.items[] as $item | $item.name'`,
      stdinText: `\
{"items":[{"name":"alice"},{"name":"bob"}]}`,
    });

    expect(iterateBinding.stdout.text).toBe(`\
"alice"
"bob"
`);
    expect(iterateBinding.stderr.text).toBe('');
    expect(iterateBinding.result.exitCode).toBe(0);
  });

  it('supports sort_by, unique, unique_by, group_by, and map_values', async () => {
    const sortBy = await execute({
      script: `\
jq '.items | sort_by(.id)'`,
      stdinText: `\
{"items":[{"id":2},{"id":1},{"id":3}]}`,
    });

    expect(sortBy.stdout.text).toBe('[{"id":1},{"id":2},{"id":3}]\n');
    expect(sortBy.stderr.text).toBe('');
    expect(sortBy.result.exitCode).toBe(0);

    const unique = await execute({
      script: `\
jq '.items | unique'`,
      stdinText: `\
{"items":[3,1,2,1,3]}`,
    });

    expect(unique.stdout.text).toBe('[1,2,3]\n');
    expect(unique.stderr.text).toBe('');
    expect(unique.result.exitCode).toBe(0);

    const uniqueBy = await execute({
      script: `\
jq '.items | unique_by(.id)'`,
      stdinText: `\
{"items":[{"id":2,"name":"b"},{"id":1,"name":"a"},{"id":2,"name":"bb"}]}`,
    });

    expect(uniqueBy.stdout.text).toBe('[{"id":1,"name":"a"},{"id":2,"name":"b"}]\n');
    expect(uniqueBy.stderr.text).toBe('');
    expect(uniqueBy.result.exitCode).toBe(0);

    const groupBy = await execute({
      script: `\
jq '.items | group_by(.kind)'`,
      stdinText: `\
{"items":[{"kind":"a","id":1},{"kind":"b","id":2},{"kind":"a","id":3}]}`,
    });

    expect(groupBy.stdout.text).toBe('[[{"kind":"a","id":1},{"kind":"a","id":3}],[{"kind":"b","id":2}]]\n');
    expect(groupBy.stderr.text).toBe('');
    expect(groupBy.result.exitCode).toBe(0);

    const mapValues = await execute({
      script: `\
jq '.metrics | map_values(. + 1)'`,
      stdinText: `\
{"metrics":{"a":1,"b":2}}`,
    });

    expect(mapValues.stdout.text).toBe('{"a":2,"b":3}\n');
    expect(mapValues.stderr.text).toBe('');
    expect(mapValues.result.exitCode).toBe(0);
  });

  it('supports paths and pick', async () => {
    const paths = await execute({
      script: `\
jq 'paths'`,
      stdinText: `\
{"user":{"name":"alice"},"items":[1,2]}`,
    });

    expect(paths.stdout.text).toBe(`\
["user"]
["user","name"]
["items"]
["items",0]
["items",1]
`);
    expect(paths.stderr.text).toBe('');
    expect(paths.result.exitCode).toBe(0);

    const pick = await execute({
      script: `\
jq 'pick(.user.name, .items[1])'`,
      stdinText: `\
{"user":{"name":"alice","role":"admin"},"items":[1,2,3],"other":true}`,
    });

    expect(pick.stdout.text).toBe('{"user":{"name":"alice"},"items":[null,2]}\n');
    expect(pick.stderr.text).toBe('');
    expect(pick.result.exitCode).toBe(0);
  });

  it('supports type filter builtins', async () => {
    const filtered = await execute({
      script: `\
jq '.items[] | (arrays, booleans, nulls, numbers, objects, scalars, strings)'`,
      stdinText: `\
{"items":[[1],true,null,2,{"a":1},"x"]}`,
    });

    expect(filtered.stdout.text).toBe(`\
[1]
true
true
null
null
2
2
{"a":1}
"x"
"x"
`);
    expect(filtered.stderr.text).toBe('');
    expect(filtered.result.exitCode).toBe(0);
  });

  it('supports walk', async () => {
    const walked = await execute({
      script: `\
jq 'walk(if type == "number" then . + 1 else . end)'`,
      stdinText: `\
{"a":1,"items":[2,{"b":3}],"name":"x"}`,
    });

    expect(walked.stdout.text).toBe('{"a":2,"items":[3,{"b":4}],"name":"x"}\n');
    expect(walked.stderr.text).toBe('');
    expect(walked.result.exitCode).toBe(0);
  });

  it('supports recurse', async () => {
    const recurseTree = await execute({
      script: `\
jq '.tree | recurse(.children[]?) | .name'`,
      stdinText: `\
{"tree":{"name":"root","children":[{"name":"a","children":[]},{"name":"b","children":[{"name":"c","children":[]}]}]}}`,
    });

    expect(recurseTree.stdout.text).toBe(`\
"root"
"a"
"b"
"c"
`);
    expect(recurseTree.stderr.text).toBe('');
    expect(recurseTree.result.exitCode).toBe(0);

    const recurseBare = await execute({
      script: `\
jq '.data | recurse | numbers'`,
      stdinText: `\
{"data":[1,[2,3],{"x":4}]}`,
    });

    expect(recurseBare.stdout.text).toBe(`\
1
2
3
4
`);
    expect(recurseBare.stderr.text).toBe('');
    expect(recurseBare.result.exitCode).toBe(0);
  });

  it('supports index, rindex, and indices', async () => {
    const stringSearch = await execute({
      script: `\
jq '.text | (index("ana"), rindex("ana"), indices("ana"))'`,
      stdinText: `\
{"text":"bananas"}`,
    });

    expect(stringSearch.stdout.text).toBe(`\
1
3
[1,3]
`);
    expect(stringSearch.stderr.text).toBe('');
    expect(stringSearch.result.exitCode).toBe(0);

    const arraySearch = await execute({
      script: `\
jq '.items | (index(2), rindex(2), indices(2))'`,
      stdinText: `\
{"items":[1,2,3,2]}`,
    });

    expect(arraySearch.stdout.text).toBe(`\
1
3
[1,3]
`);
    expect(arraySearch.stderr.text).toBe('');
    expect(arraySearch.result.exitCode).toBe(0);
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
