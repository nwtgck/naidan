import { beforeEach, describe, expect, it } from 'vitest';
import { Wesh } from '@/features/wesh/index';
import { MockFileSystemDirectoryHandle } from '@/features/wesh/mocks/InMemoryFileSystem';
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from '@/features/wesh/utils/test-stream';

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
false
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

  it('matches jq unary-minus precedence across multiplication', async () => {
    const ungrouped = await execute({
      script: `\
jq -nc -- '-1 * "x"'`,
    });
    expect(ungrouped.stdout.text).toBe('');
    expect(ungrouped.stderr.text).toContain('string ("x") cannot be negated');
    expect(ungrouped.result.exitCode).toBe(5);

    const grouped = await execute({
      script: `\
jq -nc -- '(-1) * "x"'`,
    });
    expect(grouped.stdout.text).toBe('null\n');
    expect(grouped.stderr.text).toBe('');
    expect(grouped.result.exitCode).toBe(0);
  });

  it('limits newly materialized jq strings and ranges', async () => {
    const string = await execute({
      script: `\
jq -nc '"xx" * 500001'`,
    });
    expect(string.stdout.text).toBe('');
    expect(string.stderr.text).toContain('string multiplication exceeds materialization limit 1000000');
    expect(string.result.exitCode).toBe(5);

    const emptyString = await execute({
      script: `\
jq -nc '"" * 999999999999'`,
    });
    expect(emptyString.stdout.text).toBe('""\n');
    expect(emptyString.stderr.text).toBe('');
    expect(emptyString.result.exitCode).toBe(0);

    const range = await execute({
      script: `\
jq -nc 'range(0; 1000001)'`,
    });
    expect(range.stdout.text).toBe('');
    expect(range.stderr.text).toContain('range materialization exceeds limit 1000000');
    expect(range.result.exitCode).toBe(5);

    const combinations = await execute({
      script: `\
jq -nc '[0, 1] | combinations(20)'`,
    });
    expect(combinations.stdout.text).toBe('');
    expect(combinations.stderr.text).toContain('combinations materialization exceeds limit 1000000');
    expect(combinations.result.exitCode).toBe(5);

    const emptyCombinations = await execute({
      script: `\
jq -nc '[] | combinations(999999999)'`,
    });
    expect(emptyCombinations.stdout.text).toBe('');
    expect(emptyCombinations.stderr.text).toBe('');
    expect(emptyCombinations.result.exitCode).toBe(0);

    const transposeInput = [
      Array.from({ length: 1_000 }, () => 0),
      ...Array.from({ length: 1_000 }, () => []),
    ];
    const transpose = await execute({
      script: 'jq -c transpose',
      stdinText: JSON.stringify(transposeInput),
    });
    expect(transpose.stdout.text).toBe('');
    expect(transpose.stderr.text).toContain('transpose materialization exceeds limit 1000000');
    expect(transpose.result.exitCode).toBe(5);

    const join = await execute({
      script: `\
jq -nc '["a", "b"] | join("x" * 1000000)'`,
    });
    expect(join.stdout.text).toBe('');
    expect(join.stderr.text).toContain('join materialization exceeds limit 1000000');
    expect(join.result.exitCode).toBe(5);

    const replacement = await execute({
      script: `\
jq -nc '"aa" | gsub("a"; "x" * 600000)'`,
    });
    expect(replacement.stdout.text).toBe('');
    expect(replacement.stderr.text).toContain('regular expression replacement materialization exceeds limit 1000000');
    expect(replacement.result.exitCode).toBe(5);

    let pathsInput: unknown = Array.from({ length: 8_000 }, () => 0);
    for (let depth = 0; depth < 125; depth += 1) {
      pathsInput = { nested: pathsInput };
    }
    const paths = await execute({
      script: 'jq -c paths',
      stdinText: JSON.stringify(pathsInput),
    });
    // `paths` is a streaming generator. Its safety cap is allowed to retain the
    // already-emitted prefix when the cumulative path-segment budget is reached.
    expect(paths.stdout.text).not.toBe('');
    expect(paths.stderr.text).toContain('paths materialization exceeds limit 1000000');
    expect(paths.result.exitCode).toBe(5);

    const map = await execute({
      script: `\
jq -nc '[0, 1] | map(range(0; 500001))'`,
    });
    expect(map.stdout.text).toBe('');
    expect(map.stderr.text).toContain('map materialization exceeds limit 1000000');
    expect(map.result.exitCode).toBe(5);
  }, 30_000);

  it('allows bounded large jq generator materializations', async () => {
    const largeArray = await execute({
      script: `\
jq -nc '[range(0; 500001) | .] | length'`,
    });
    expect(largeArray.stdout.text).toBe('500001\n');
    expect(largeArray.stderr.text).toBe('');
    expect(largeArray.result.exitCode).toBe(0);

    const comma = await execute({
      script: `\
jq -nc '[(range(0; 250001)), (range(0; 250001))] | length'`,
    });
    expect(comma.stdout.text).toBe('500002\n');
    expect(comma.stderr.text).toBe('');
    expect(comma.result.exitCode).toBe(0);

    const tryCatch = await execute({
      script: `\
jq -nc '[try (range(0; 250001), error("stop")) catch .] | length'`,
    });
    expect(tryCatch.stdout.text).toBe('250002\n');
    expect(tryCatch.stderr.text).toBe('');
    expect(tryCatch.result.exitCode).toBe(0);
  }, 30_000);

  it('limits with_entries and consumes large raw input streams', async () => {
    const withEntries = await execute({
      script: `\
jq -nc '[0, 1] | with_entries(range(0; 500001) | {key: tostring, value: .})'`,
    });
    expect(withEntries.stdout.text).toBe('');
    expect(withEntries.stderr.text).toContain('with_entries materialization exceeds limit 1000000');
    expect(withEntries.result.exitCode).toBe(5);

    const rawInputs = await execute({
      script: `\
jq -Rnc 'inputs | empty'`,
      stdinText: 'x\n'.repeat(200_000),
    });
    expect(rawInputs.stdout.text).toBe('');
    expect(rawInputs.stderr.text).toBe('');
    expect(rawInputs.result.exitCode).toBe(0);
  }, 30_000);

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
    expect(unaryMinusType.stderr.text).toContain('jq: error: string ("alice") cannot be negated');
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
    expect(reverseType.stderr.text).toContain('jq: error: reverse input must be an array');
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

    const validNumberStrings = [
      ' 1 ',
      '\t1\n',
      '\r1\r',
      '\uFEFF1',
      '\uFEFF 1',
    ];
    for (const value of validNumberStrings) {
      const result = await execute({
        script: `\
jq -c 'tonumber'`,
        stdinText: JSON.stringify(value),
      });
      expect(result.stdout.text).toBe('1\n');
      expect(result.stderr.text).toBe('');
      expect(result.result.exitCode).toBe(0);
    }

    const invalidNumberStrings = [
      '\v1',
      '1\v',
      '\f1',
      '1\f',
      '\u00A01',
      '1\u00A0',
      '1\u2003',
      '1\uFEFF',
      '\uFEFF\uFEFF1',
      ' \uFEFF1',
      '\u20281',
      '\u20291',
    ];
    for (const value of invalidNumberStrings) {
      const result = await execute({
        script: `\
jq -c 'tonumber'`,
        stdinText: JSON.stringify(value),
      });
      expect(result.stdout.text).toBe('');
      expect(result.stderr.text).toContain('jq: error: cannot parse number from string');
      expect(result.result.exitCode).toBe(5);
    }

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
