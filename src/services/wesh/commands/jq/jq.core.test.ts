import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/services/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/services/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/services/wesh/utils/test-stream';

describe('wesh jq core', () => {
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

  it('prints help and usage errors', async () => {
    const help = await execute({ script: 'jq --help' });
    const missing = await execute({ script: 'jq' });
    const invalid = await execute({ script: 'jq --bogus' });

    expect(help.stdout.text).toContain('Query and transform JSON values');
    expect(help.stdout.text).toContain('usage: jq [OPTION]... FILTER [FILE]...');
    expect(help.stdout.text).toContain('--help');
    expect(help.stderr.text).toBe('');
    expect(help.result.exitCode).toBe(0);

    expect(missing.stderr.text).toContain('jq: missing filter');
    expect(missing.stderr.text).toContain('usage: jq [OPTION]... FILTER [FILE]...');
    expect(missing.result.exitCode).toBe(2);

    expect(invalid.stderr.text).toContain("jq: unrecognized option '--bogus'");
    expect(invalid.result.exitCode).toBe(2);
  });

  it('supports core path queries and pipes', async () => {
    const { result, stdout, stderr } = await execute({
      script: `\
jq -c '.items[] | .name'`,
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
jq -c '.name, length, keys, type, has("name")'`,
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

  it('supports values and tostring', async () => {
    const values = await execute({
      script: `\
jq -c '.items[] | values'`,
      stdinText: `\
{"items":[1,null,false,"x"]}`,
    });

    expect(values.stdout.text).toBe(`\
1
"x"
`);
    expect(values.stderr.text).toBe('');
    expect(values.result.exitCode).toBe(0);

    const tostring = await execute({
      script: `\
jq -c '.items[] | tostring'`,
      stdinText: `\
{"items":[1,true,{"a":1},"x"]}`,
    });

    expect(tostring.stdout.text).toBe([
      '"1"',
      '"true"',
      JSON.stringify('{"a":1}'),
      '"x"',
      '',
    ].join('\n'));
    expect(tostring.stderr.text).toBe('');
    expect(tostring.result.exitCode).toBe(0);

    const tojson = await execute({
      script: `\
jq -c '.payload | tojson'`,
      stdinText: `\
{"payload":{"a":1,"b":[2,3]}}`,
    });

    expect(tojson.stdout.text).toBe(`${JSON.stringify('{"a":1,"b":[2,3]}')}\n`);
    expect(tojson.stderr.text).toBe('');
    expect(tojson.result.exitCode).toBe(0);

    const fromjson = await execute({
      script: `\
jq -c '.payload | fromjson'`,
      stdinText: JSON.stringify({
        payload: JSON.stringify({ a: 1, b: [2, 3] }),
      }),
    });

    expect(fromjson.stdout.text).toBe('{"a":1,"b":[2,3]}\n');
    expect(fromjson.stderr.text).toBe('');
    expect(fromjson.result.exitCode).toBe(0);
  });

  it('supports optional access and keys_unsorted', async () => {
    const optionalField = await execute({
      script: `\
jq -c '.items[] | .name?'`,
      stdinText: `\
{"items":[{"name":"alice"},1,{"name":"bob"}]}`,
    });

    expect(optionalField.stdout.text).toBe(`\
"alice"
"bob"
`);
    expect(optionalField.stderr.text).toBe('');
    expect(optionalField.result.exitCode).toBe(0);

    const optionalIterate = await execute({
      script: `\
jq -c '.items[] | .tags[]?'`,
      stdinText: `\
{"items":[{"tags":["x","y"]},{"tags":null},{"tags":["z"]}]}`,
    });

    expect(optionalIterate.stdout.text).toBe(`\
"x"
"y"
"z"
`);
    expect(optionalIterate.stderr.text).toBe('');
    expect(optionalIterate.result.exitCode).toBe(0);

    const unsortedKeys = await execute({
      script: `\
jq -c 'keys_unsorted'`,
      stdinText: `\
{"b":1,"a":2,"c":3}`,
    });

    expect(unsortedKeys.stdout.text).toBe('["b","a","c"]\n');
    expect(unsortedKeys.stderr.text).toBe('');
    expect(unsortedKeys.result.exitCode).toBe(0);
  });

  it('supports alternative operator', async () => {
    const fallback = await execute({
      script: `\
jq -c '.missing // "fallback"'`,
      stdinText: `\
{"value":1}`,
    });

    expect(fallback.stdout.text).toBe('"fallback"\n');
    expect(fallback.stderr.text).toBe('');
    expect(fallback.result.exitCode).toBe(0);

    const keepTruthy = await execute({
      script: `\
jq -c '.items[] // 99'`,
      stdinText: `\
{"items":[null,false,2]}`,
    });

    expect(keepTruthy.stdout.text).toBe('2\n');
    expect(keepTruthy.stderr.text).toBe('');
    expect(keepTruthy.result.exitCode).toBe(0);
  });

  it('supports arithmetic operators and unary minus', async () => {
    const arithmetic = await execute({
      script: `\
jq -c '.n * 4 - 3 / 3'`,
      stdinText: `\
{"n":2}`,
    });

    expect(arithmetic.stdout.text).toBe('7\n');
    expect(arithmetic.stderr.text).toBe('');
    expect(arithmetic.result.exitCode).toBe(0);

    const unaryMinus = await execute({
      script: `\
jq -c -- '-.n'`,
      stdinText: `\
{"n":5}`,
    });

    expect(unaryMinus.stdout.text).toBe('-5\n');
    expect(unaryMinus.stderr.text).toBe('');
    expect(unaryMinus.result.exitCode).toBe(0);
  });

  it('supports empty and bracket field/index access', async () => {
    const bracketField = await execute({
      script: `\
jq -c '.["name"], .items[-1]'`,
      stdinText: `\
{"name":"alice","items":[1,2,3]}`,
    });

    expect(bracketField.stdout.text).toBe(`\
"alice"
3
`);
    expect(bracketField.stderr.text).toBe('');
    expect(bracketField.result.exitCode).toBe(0);

    const empty = await execute({
      script: `\
jq -c '.items[] | (. + 10, empty)'`,
      stdinText: `\
{"items":[1,2]}`,
    });

    expect(empty.stdout.text).toBe(`\
11
12
`);
    expect(empty.stderr.text).toBe('');
    expect(empty.result.exitCode).toBe(0);
  });

  it('supports slice access on arrays and strings', async () => {
    const arraySlice = await execute({
      script: `\
jq -c '.items[1:3], .items[:2], .items[2:]'`,
      stdinText: `\
{"items":[1,2,3,4]}`,
    });

    expect(arraySlice.stdout.text).toBe(`\
[2,3]
[1,2]
[3,4]
`);
    expect(arraySlice.stderr.text).toBe('');
    expect(arraySlice.result.exitCode).toBe(0);

    const stringSlice = await execute({
      script: `\
jq -c '.name[1:4]'`,
      stdinText: `\
{"name":"alice"}`,
    });

    expect(stringSlice.stdout.text).toBe('"lic"\n');
    expect(stringSlice.stderr.text).toBe('');
    expect(stringSlice.result.exitCode).toBe(0);
  });

  it('reports parse and input errors', async () => {
    const parse = await execute({
      script: `\
jq -c '.foo ='`,
      stdinText: '{}',
    });
    expect(parse.stderr.text).toContain('jq: parse error:');
    expect(parse.result.exitCode).toBe(3);

    const input = await execute({
      script: `\
jq -c '.'`,
      stdinText: '{invalid',
    });
    expect(input.stderr.text).toContain('jq: parse error: invalid JSON input');
    expect(input.result.exitCode).toBe(5);
  });

  it('reports unsupported syntax clearly', async () => {
    const identifier = await execute({
      script: `\
jq -c 'foo'`,
      stdinText: '{}',
    });
    expect(identifier.stderr.text).toContain("jq: parse error: unsupported syntax: identifier 'foo'");
    expect(identifier.result.exitCode).toBe(3);

    const dynamicIndex = await execute({
      script: `\
jq -c '.[1,2]'`,
      stdinText: '[1,2,3]',
    });
    expect(dynamicIndex.stdout.text).toBe(`\
2
3
`);
    expect(dynamicIndex.stderr.text).toBe('');
    expect(dynamicIndex.result.exitCode).toBe(0);

    const builtinArity = await execute({
      script: `\
jq -c 'length(1)'`,
      stdinText: '[1,2]',
    });
    expect(builtinArity.stderr.text).toContain('jq: error: length/1 is not defined');
    expect(builtinArity.result.exitCode).toBe(3);

    const delArgument = await execute({
      script: `\
jq -c 'del(length)'`,
      stdinText: '{"a":1}',
    });
    expect(delArgument.stderr.text).toContain('jq: error: del argument must be a path');
    expect(delArgument.result.exitCode).toBe(5);

    const fromjsonType = await execute({
      script: `\
jq -c 'fromjson'`,
      stdinText: '1',
    });
    expect(fromjsonType.stderr.text).toContain('jq: error: fromjson input must be a string');
    expect(fromjsonType.result.exitCode).toBe(5);

    const unaryMinusType = await execute({
      script: `\
jq -c -- '-.name'`,
      stdinText: `\
{"name":"alice"}`,
    });
    expect(unaryMinusType.stderr.text).toContain('jq: error: unary - expects a number');
    expect(unaryMinusType.result.exitCode).toBe(5);

    const conditionalElse = await execute({
      script: `\
jq -c 'if .flag then .value end'`,
      stdinText: `\
{"flag":true,"value":1}`,
    });
    expect(conditionalElse.stderr.text).toContain("jq: parse error: expected 'else' or 'elif'");
    expect(conditionalElse.result.exitCode).toBe(3);

    const tryWithoutCatch = await execute({
      script: `\
jq -c 'try .foo'`,
      stdinText: `\
{"foo":1}`,
    });
    expect(tryWithoutCatch.stdout.text).toBe('1\n');
    expect(tryWithoutCatch.stderr.text).toBe('');
    expect(tryWithoutCatch.result.exitCode).toBe(0);

    const anyObject = await execute({
      script: `\
jq -c 'any'`,
      stdinText: '{"flag":true}',
    });
    expect(anyObject.stdout.text).toBe('true\n');
    expect(anyObject.stderr.text).toBe('');
    expect(anyObject.result.exitCode).toBe(0);

    const reverseType = await execute({
      script: `\
jq -c 'reverse'`,
      stdinText: '1',
    });
    expect(reverseType.stderr.text).toContain('jq: error: reverse input must be an array or string');
    expect(reverseType.result.exitCode).toBe(5);

    const startswithType = await execute({
      script: `\
jq -c 'startswith(1)'`,
      stdinText: '"alice"',
    });
    expect(startswithType.stderr.text).toContain('jq: error: startswith expects string input and argument');
    expect(startswithType.result.exitCode).toBe(5);

    const joinType = await execute({
      script: `\
jq -c 'join(1)'`,
      stdinText: '["a","b"]',
    });
    expect(joinType.stderr.text).toContain('jq: error: join separator must be a string');
    expect(joinType.result.exitCode).toBe(5);

    const splitType = await execute({
      script: `\
jq -c 'split(1)'`,
      stdinText: '"a,b"',
    });
    expect(splitType.stderr.text).toContain('jq: error: split expects string input and argument');
    expect(splitType.result.exitCode).toBe(5);

    const explodeType = await execute({
      script: `\
jq -c 'explode'`,
      stdinText: '1',
    });
    expect(explodeType.stderr.text).toContain('jq: error: explode input must be a string');
    expect(explodeType.result.exitCode).toBe(5);

    const implodeInvalidCodePoint = await execute({
      script: `\
jq -c 'implode'`,
      stdinText: '[65,-1]',
    });
    expect(implodeInvalidCodePoint.stdout.text).toBe('"A�"\n');
    expect(implodeInvalidCodePoint.stderr.text).toBe('');
    expect(implodeInvalidCodePoint.result.exitCode).toBe(0);

    const insideArity = await execute({
      script: `\
jq -c 'inside'`,
      stdinText: '{"a":1}',
    });
    expect(insideArity.stderr.text).toContain('jq: error: inside/0 is not defined');
    expect(insideArity.result.exitCode).toBe(3);

    const ltrimstrType = await execute({
      script: `\
jq -c 'ltrimstr(1)'`,
      stdinText: '"prefix-value"',
    });
    expect(ltrimstrType.stdout.text).toBe('"prefix-value"\n');
    expect(ltrimstrType.stderr.text).toBe('');
    expect(ltrimstrType.result.exitCode).toBe(0);

    const rtrimstrType = await execute({
      script: `\
jq -c 'rtrimstr(1)'`,
      stdinText: '"value-suffix"',
    });
    expect(rtrimstrType.stdout.text).toBe('"value-suffix"\n');
    expect(rtrimstrType.stderr.text).toBe('');
    expect(rtrimstrType.result.exitCode).toBe(0);

    const firstArity = await execute({
      script: `\
jq -c 'first(.; .)'`,
      stdinText: '1',
    });
    expect(firstArity.stderr.text).toContain('jq: error: first/2 is not defined');
    expect(firstArity.result.exitCode).toBe(3);

    const lastArity = await execute({
      script: `\
jq -c 'last(.; .)'`,
      stdinText: '1',
    });
    expect(lastArity.stderr.text).toContain('jq: error: last/2 is not defined');
    expect(lastArity.result.exitCode).toBe(3);

    const asciiType = await execute({
      script: `\
jq -c 'ascii_downcase'`,
      stdinText: '1',
    });
    expect(asciiType.stderr.text).toContain('jq: error: ascii_downcase input must be a string');
    expect(asciiType.result.exitCode).toBe(5);

    const rangeType = await execute({
      script: `\
jq -c 'range(1; "x")'`,
      stdinText: 'null',
    });
    expect(rangeType.stderr.text).toContain('jq: error: range arguments must be finite numbers');
    expect(rangeType.result.exitCode).toBe(5);

    const rangeStep = await execute({
      script: `\
jq -c 'range(1; 4; 0)'`,
      stdinText: 'null',
    });
    expect(rangeStep.stdout.text).toBe('');
    expect(rangeStep.stderr.text).toBe('');
    expect(rangeStep.result.exitCode).toBe(0);

    const tonumberType = await execute({
      script: `\
jq -c 'tonumber'`,
      stdinText: 'true',
    });
    expect(tonumberType.stderr.text).toContain('jq: error: tonumber input must be a string or number');
    expect(tonumberType.result.exitCode).toBe(5);

    const tonumberParse = await execute({
      script: `\
jq -c 'tonumber'`,
      stdinText: '"not-a-number"',
    });
    expect(tonumberParse.stderr.text).toContain('jq: error: cannot parse number from string "not-a-number"');
    expect(tonumberParse.result.exitCode).toBe(5);

    const errorBuiltin = await execute({
      script: `\
jq -c 'error("boom")'`,
      stdinText: 'null',
    });
    expect(errorBuiltin.stderr.text).toContain('jq: error: boom');
    expect(errorBuiltin.result.exitCode).toBe(5);

    const undefinedVariable = await execute({
      script: `\
jq -c '$missing'`,
      stdinText: 'null',
    });
    expect(undefinedVariable.stderr.text).toContain('jq: error: $missing is not defined');
    expect(undefinedVariable.result.exitCode).toBe(3);

    const invalidAs = await execute({
      script: `\
jq -c '.foo as .bar'`,
      stdinText: '{"foo":1}',
    });
    expect(invalidAs.stderr.text).toContain("jq: parse error: expected variable name after 'as'");
    expect(invalidAs.result.exitCode).toBe(3);

    const floorType = await execute({
      script: `\
jq -c 'floor'`,
      stdinText: '"1.2"',
    });
    expect(floorType.stderr.text).toContain('jq: error: floor input must be a number');
    expect(floorType.result.exitCode).toBe(5);

    const mapValuesArray = await execute({
      script: `\
jq -c 'map_values(. + 1)'`,
      stdinText: '[1,2]',
    });
    expect(mapValuesArray.stdout.text).toBe('[2,3]\n');
    expect(mapValuesArray.stderr.text).toBe('');
    expect(mapValuesArray.result.exitCode).toBe(0);

    const pickType = await execute({
      script: `\
jq -c 'pick(length)'`,
      stdinText: '{"a":1}',
    });
    expect(pickType.stderr.text).toContain('jq: error: pick argument must contain paths');
    expect(pickType.result.exitCode).toBe(5);

    const walkType = await execute({
      script: `\
jq -c 'walk'`,
      stdinText: '{"a":1}',
    });
    expect(walkType.stderr.text).toContain('jq: error: walk/0 is not defined');
    expect(walkType.result.exitCode).toBe(3);

    const indexType = await execute({
      script: `\
jq -c 'index(1)'`,
      stdinText: '{"a":1}',
    });
    expect(indexType.stderr.text).toContain('jq: error: index input must be an array or string');
    expect(indexType.result.exitCode).toBe(5);

    const recurseArity = await execute({
      script: `\
jq -c 'recurse(.; .; .)'`,
      stdinText: '{"a":1}',
    });
    expect(recurseArity.stderr.text).toContain('jq: error: recurse/3 is not defined');
    expect(recurseArity.result.exitCode).toBe(3);
  });
});
