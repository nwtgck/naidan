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

  it('supports values and tostring', async () => {
    const values = await execute({
      script: `\
jq '.items[] | values'`,
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
jq '.items[] | tostring'`,
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
jq '.payload | tojson'`,
      stdinText: `\
{"payload":{"a":1,"b":[2,3]}}`,
    });

    expect(tojson.stdout.text).toBe(`${JSON.stringify('{"a":1,"b":[2,3]}')}\n`);
    expect(tojson.stderr.text).toBe('');
    expect(tojson.result.exitCode).toBe(0);

    const fromjson = await execute({
      script: `\
jq '.payload | fromjson'`,
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
jq '.items[] | .name?'`,
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
jq '.items[] | .tags[]?'`,
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
jq 'keys_unsorted'`,
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
jq '.missing // "fallback"'`,
      stdinText: `\
{"value":1}`,
    });

    expect(fallback.stdout.text).toBe('"fallback"\n');
    expect(fallback.stderr.text).toBe('');
    expect(fallback.result.exitCode).toBe(0);

    const keepTruthy = await execute({
      script: `\
jq '.items[] // 99'`,
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
jq '.n * 4 - 3 / 3'`,
      stdinText: `\
{"n":2}`,
    });

    expect(arithmetic.stdout.text).toBe('7\n');
    expect(arithmetic.stderr.text).toBe('');
    expect(arithmetic.result.exitCode).toBe(0);

    const unaryMinus = await execute({
      script: `\
jq -- '-.n'`,
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
jq '.["name"], .items[-1]'`,
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
jq '.items[] | (. + 10, empty)'`,
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
jq '.items[1:3], .items[:2], .items[2:]'`,
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
jq '.name[1:4]'`,
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
jq '.[1,2]'`,
      stdinText: '[1,2,3]',
    });
    expect(bracketSyntax.stderr.text).toContain('jq: parse error: unsupported syntax inside []');
    expect(bracketSyntax.result.exitCode).toBe(3);

    const builtinArity = await execute({
      script: `\
jq 'length(1)'`,
      stdinText: '[1,2]',
    });
    expect(builtinArity.stderr.text).toContain('jq: error: length does not take arguments');
    expect(builtinArity.result.exitCode).toBe(4);

    const delArgument = await execute({
      script: `\
jq 'del(length)'`,
      stdinText: '{"a":1}',
    });
    expect(delArgument.stderr.text).toContain('jq: error: del argument must be a path');
    expect(delArgument.result.exitCode).toBe(4);

    const fromjsonType = await execute({
      script: `\
jq 'fromjson'`,
      stdinText: '1',
    });
    expect(fromjsonType.stderr.text).toContain('jq: error: fromjson input must be a string');
    expect(fromjsonType.result.exitCode).toBe(4);

    const unaryMinusType = await execute({
      script: `\
jq -- '-.name'`,
      stdinText: `\
{"name":"alice"}`,
    });
    expect(unaryMinusType.stderr.text).toContain('jq: error: unary - expects a number');
    expect(unaryMinusType.result.exitCode).toBe(4);

    const conditionalElse = await execute({
      script: `\
jq 'if .flag then .value end'`,
      stdinText: `\
{"flag":true,"value":1}`,
    });
    expect(conditionalElse.stderr.text).toContain("jq: parse error: unsupported syntax: 'if' requires 'else' or 'elif'");
    expect(conditionalElse.result.exitCode).toBe(3);

    const tryCatch = await execute({
      script: `\
jq 'try .foo'`,
      stdinText: `\
{"foo":1}`,
    });
    expect(tryCatch.stderr.text).toContain("jq: parse error: unsupported syntax: 'try' requires 'catch'");
    expect(tryCatch.result.exitCode).toBe(3);

    const anyType = await execute({
      script: `\
jq 'any'`,
      stdinText: '{"flag":true}',
    });
    expect(anyType.stderr.text).toContain('jq: error: any input must be an array');
    expect(anyType.result.exitCode).toBe(4);

    const reverseType = await execute({
      script: `\
jq 'reverse'`,
      stdinText: '1',
    });
    expect(reverseType.stderr.text).toContain('jq: error: reverse input must be an array or string');
    expect(reverseType.result.exitCode).toBe(4);

    const startswithType = await execute({
      script: `\
jq 'startswith(1)'`,
      stdinText: '"alice"',
    });
    expect(startswithType.stderr.text).toContain('jq: error: startswith expects string input and argument');
    expect(startswithType.result.exitCode).toBe(4);

    const joinType = await execute({
      script: `\
jq 'join(1)'`,
      stdinText: '["a","b"]',
    });
    expect(joinType.stderr.text).toContain('jq: error: join separator must be a string');
    expect(joinType.result.exitCode).toBe(4);

    const splitType = await execute({
      script: `\
jq 'split(1)'`,
      stdinText: '"a,b"',
    });
    expect(splitType.stderr.text).toContain('jq: error: split expects string input and argument');
    expect(splitType.result.exitCode).toBe(4);

    const explodeType = await execute({
      script: `\
jq 'explode'`,
      stdinText: '1',
    });
    expect(explodeType.stderr.text).toContain('jq: error: explode input must be a string');
    expect(explodeType.result.exitCode).toBe(4);

    const implodeType = await execute({
      script: `\
jq 'implode'`,
      stdinText: '[65,-1]',
    });
    expect(implodeType.stderr.text).toContain('jq: error: implode input elements must be valid Unicode code points');
    expect(implodeType.result.exitCode).toBe(4);

    const insideArity = await execute({
      script: `\
jq 'inside'`,
      stdinText: '{"a":1}',
    });
    expect(insideArity.stderr.text).toContain('jq: error: inside requires one argument');
    expect(insideArity.result.exitCode).toBe(4);

    const ltrimstrType = await execute({
      script: `\
jq 'ltrimstr(1)'`,
      stdinText: '"prefix-value"',
    });
    expect(ltrimstrType.stderr.text).toContain('jq: error: ltrimstr expects string input and argument');
    expect(ltrimstrType.result.exitCode).toBe(4);

    const rtrimstrType = await execute({
      script: `\
jq 'rtrimstr(1)'`,
      stdinText: '"value-suffix"',
    });
    expect(rtrimstrType.stderr.text).toContain('jq: error: rtrimstr expects string input and argument');
    expect(rtrimstrType.result.exitCode).toBe(4);

    const firstArity = await execute({
      script: `\
jq 'first(., .)'`,
      stdinText: '1',
    });
    expect(firstArity.stderr.text).toContain('jq: error: first takes at most one argument');
    expect(firstArity.result.exitCode).toBe(4);

    const lastArity = await execute({
      script: `\
jq 'last(., .)'`,
      stdinText: '1',
    });
    expect(lastArity.stderr.text).toContain('jq: error: last takes at most one argument');
    expect(lastArity.result.exitCode).toBe(4);

    const asciiType = await execute({
      script: `\
jq 'ascii_downcase'`,
      stdinText: '1',
    });
    expect(asciiType.stderr.text).toContain('jq: error: ascii_downcase input must be a string');
    expect(asciiType.result.exitCode).toBe(4);

    const rangeType = await execute({
      script: `\
jq 'range(1, "x")'`,
      stdinText: 'null',
    });
    expect(rangeType.stderr.text).toContain('jq: error: range arguments must be finite numbers');
    expect(rangeType.result.exitCode).toBe(4);

    const rangeStep = await execute({
      script: `\
jq 'range(1, 4, 0)'`,
      stdinText: 'null',
    });
    expect(rangeStep.stderr.text).toContain('jq: error: range step must not be zero');
    expect(rangeStep.result.exitCode).toBe(4);

    const tonumberType = await execute({
      script: `\
jq 'tonumber'`,
      stdinText: 'true',
    });
    expect(tonumberType.stderr.text).toContain('jq: error: tonumber input must be a string or number');
    expect(tonumberType.result.exitCode).toBe(4);

    const tonumberParse = await execute({
      script: `\
jq 'tonumber'`,
      stdinText: '"not-a-number"',
    });
    expect(tonumberParse.stderr.text).toContain('jq: error: cannot parse number from string "not-a-number"');
    expect(tonumberParse.result.exitCode).toBe(4);

    const errorBuiltin = await execute({
      script: `\
jq 'error("boom")'`,
      stdinText: 'null',
    });
    expect(errorBuiltin.stderr.text).toContain('jq: error: boom');
    expect(errorBuiltin.result.exitCode).toBe(4);

    const undefinedVariable = await execute({
      script: `\
jq '$missing'`,
      stdinText: 'null',
    });
    expect(undefinedVariable.stderr.text).toContain('jq: error: $missing is not defined');
    expect(undefinedVariable.result.exitCode).toBe(4);

    const invalidAs = await execute({
      script: `\
jq '.foo as .bar'`,
      stdinText: '{"foo":1}',
    });
    expect(invalidAs.stderr.text).toContain("jq: parse error: expected variable name after 'as'");
    expect(invalidAs.result.exitCode).toBe(3);

    const floorType = await execute({
      script: `\
jq 'floor'`,
      stdinText: '"1.2"',
    });
    expect(floorType.stderr.text).toContain('jq: error: floor input must be a number');
    expect(floorType.result.exitCode).toBe(4);

    const mapValuesType = await execute({
      script: `\
jq 'map_values(. + 1)'`,
      stdinText: '[1,2]',
    });
    expect(mapValuesType.stderr.text).toContain('jq: error: map_values input must be an object');
    expect(mapValuesType.result.exitCode).toBe(4);

    const pickType = await execute({
      script: `\
jq 'pick(length)'`,
      stdinText: '{"a":1}',
    });
    expect(pickType.stderr.text).toContain('jq: error: pick arguments must be paths');
    expect(pickType.result.exitCode).toBe(4);

    const walkType = await execute({
      script: `\
jq 'walk'`,
      stdinText: '{"a":1}',
    });
    expect(walkType.stderr.text).toContain('jq: error: walk requires one argument');
    expect(walkType.result.exitCode).toBe(4);

    const indexType = await execute({
      script: `\
jq 'index(1)'`,
      stdinText: '{"a":1}',
    });
    expect(indexType.stderr.text).toContain('jq: error: index input must be an array or string');
    expect(indexType.result.exitCode).toBe(4);

    const recurseArity = await execute({
      script: `\
jq 'recurse(., .)'`,
      stdinText: '{"a":1}',
    });
    expect(recurseArity.stderr.text).toContain('jq: error: recurse takes at most one argument');
    expect(recurseArity.result.exitCode).toBe(4);
  });
});
