import { beforeEach, describe, expect, it } from "vitest";
import { Wesh } from "@/features/wesh/index";
import { createTextShellSource } from '@/features/wesh/shell/source';
import type { JsonValue } from "@/features/wesh/commands/jq/ast";
import { MockFileSystemDirectoryHandle } from "@/features/wesh/mocks/InMemoryFileSystem";
import {
  createTestReadHandleFromText,
  createTestWriteCaptureHandle,
} from "@/features/wesh/utils/test-stream";

describe("wesh jq Linux compatibility regressions", () => {
  let wesh: Wesh;

  beforeEach(async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: "root" });
    wesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
    });
    await wesh.init();
  });

  async function execute({
    filter,
    stdinText,
    options = "-c",
  }: {
    filter: string;
    stdinText?: string;
    options?: string;
  }) {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: `jq ${options} '${filter}'` }),
      stdin: createTestReadHandleFromText({ text: stdinText ?? "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    return { result, stdout, stderr };
  }

  it("distinguishes jq external m/s flags from Oniguruma inline m/s modifiers", async () => {
    const external = await execute({
      filter: String.raw`[test("a.b";"m"), test("a.b";"s"), test("^b";"m"), test("^b";"s")]`,
      stdinText: String.raw`"a\nb"` + "\n",
    });
    const inline = await execute({
      filter: String.raw`[test("(?m)a.b"), test("(?s)a.b"), test("(?m)^b"), test("(?s)^b")]`,
      stdinText: String.raw`"a\nb"` + "\n",
    });

    expect(external.stdout.text).toBe("[true,false,false,false]\n");
    expect(inline.stdout.text).toBe("[false,true,true,false]\n");
    for (const outcome of [external, inline]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("short-circuits boolean streams without evaluating unnecessary right branches", async () => {
    const falseAndError = await execute({
      filter: String.raw`false and error("unused")`,
      options: "-nc",
    });
    const trueOrError = await execute({
      filter: String.raw`true or error("unused")`,
      options: "-nc",
    });
    const emptyAndError = await execute({
      filter: String.raw`empty and error("unused")`,
      options: "-nc",
    });
    const streamedAnd = await execute({
      filter: String.raw`(false,true) and (false,true)`,
      options: "-nc",
    });
    const streamedOr = await execute({
      filter: String.raw`(false,true) or (false,true)`,
      options: "-nc",
    });
    const partialLeftFailure = await execute({
      filter: String.raw`(false,error("left")) and error("right")`,
      options: "-nc",
    });
    const demandDriven = await execute({
      filter: String.raw`((false,true) and input), inputs`,
      stdinText: `\
1
2
3
`,
      options: "-nc",
    });

    expect(falseAndError.stdout.text).toBe("false\n");
    expect(trueOrError.stdout.text).toBe("true\n");
    expect(emptyAndError.stdout.text).toBe("");
    expect(streamedAnd.stdout.text).toBe(`\
false
false
true
`);
    expect(streamedOr.stdout.text).toBe(`\
false
true
true
`);
    for (const outcome of [
      falseAndError,
      trueOrError,
      emptyAndError,
      streamedAnd,
      streamedOr,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(partialLeftFailure.stdout.text).toBe("false\n");
    expect(partialLeftFailure.stderr.text).toContain("left");
    expect(partialLeftFailure.stderr.text).not.toContain("right");
    expect(partialLeftFailure.result.exitCode).toBe(5);
    expect(demandDriven.stdout.text).toBe(`\
false
true
2
3
`);
    expect(demandDriven.stderr.text).toBe("");
    expect(demandDriven.result.exitCode).toBe(0);
  });

  it("cancels recursive and repeating generators through stream consumers", async () => {
    const repeatLimited = await execute({
      filter: String.raw`limit(5; repeat(1))`,
      options: "-nc",
    });
    const repeatPiped = await execute({
      filter: String.raw`limit(5; (repeat(. + 1) | . * 2))`,
      options: "-nc",
    });
    const recurseLimited = await execute({
      filter: String.raw`limit(5; recurse(. + 1))`,
      stdinText: "0\n",
    });
    const deepSingleOutputLoops = await execute({
      filter: String.raw`([limit(512; recurse(. + 1))] | length), ([limit(512; while(true; . + 1))] | length), ([limit(512; recurse((. + 1), empty))] | length), ([limit(512; while(true; ((. + 1), empty)))] | length)`,
      stdinText: "0\n",
    });
    const structurallySingleOutputLoops = await execute({
      filter: String.raw`0 | [([limit(512; while(. < 10000; (. + 1 | .)))] | length), ([limit(512; while(. < 10000; if true then . + 1 else . + 2 end))] | length), ([limit(512; while(. < 10000; (. as $x | $x + 1)))] | length), ([limit(512; while(. < 10000; try (. + 1)))] | length), ([limit(512; while(. < 10000; ([. + 1] | .[0])))] | length), ([limit(512; while(. < 10000; first((. + 1), error("unreached"))))] | length), ([limit(512; while(. < 10000; (select(true) | . + 1)))] | length)]`,
      options: "-nc",
    });
    const structurallySingleOutputRecursion = await execute({
      filter: String.raw`0 | [([limit(512; recurse(. + 1 | .))] | length), ([limit(512; recurse(. as $x | $x + 1))] | length), ([limit(512; recurse(({x:(. + 1)} | .x)))] | length), ([limit(512; recurse((floor) as $ignored | . + 1))] | length), ([limit(512; recurse(. + 1; isfinite and . < 10000))] | length)]`,
      options: "-nc",
    });
    const userDefined = await execute({
      filter: String.raw`def again(f): repeat(f); limit(4; again(. + 1))`,
      options: "-nc",
    });
    const finiteLoops = await execute({
      filter: String.raw`while(. < 3; . + 1), until(. >= 3; . + 1)`,
      stdinText: "0\n",
    });
    const consumers = await execute({
      filter: String.raw`first(repeat(7)), nth(3; repeat(. + 1)), isempty(repeat(1))`,
      options: "-nc",
    });
    const booleanConsumers = await execute({
      filter: String.raw`any(repeat(false,true); .), all(repeat(true,false); .)`,
      options: "-nc",
    });
    const cancelledFailure = await execute({
      filter: String.raw`limit(1; (1, error("late")))`,
      options: "-nc",
    });
    const recurseFailure = await execute({
      filter: String.raw`recurse(if . < 2 then . + 1 else error("late") end)`,
      stdinText: "0\n",
    });
    const recurseInputCursor = await execute({
      filter: String.raw`limit(2; recurse(input?)), inputs`,
      stdinText: `\
0
10
20
30
`,
    });
    const recurseInputMetadata = await execute({
      filter: String.raw`(limit(2; recurse(input?)) | [.,input_line_number]), inputs`,
      stdinText: `\
0
10
20
30
`,
    });

    const binaryAndUnary = await execute({
      filter: String.raw`limit(5; repeat(1) + 1), limit(4; -repeat(1,2))`,
      options: "-nc",
    });
    const binaryDemand = await execute({
      filter: String.raw`(limit(2; repeat(input) + 1) | [., input_line_number]), inputs`,
      stdinText: `\
10
20
30
`,
      options: "-nc",
    });

    expect(repeatLimited.stdout.text).toBe(`\
1
1
1
1
1
`);
    expect(repeatPiped.stdout.text).toBe(`\
2
2
2
2
2
`);
    expect(recurseLimited.stdout.text).toBe(`\
0
1
2
3
4
`);
    expect(deepSingleOutputLoops.stdout.text).toBe(`\
512
512
512
512
`);
    expect(structurallySingleOutputLoops.stdout.text).toBe("[512,512,512,512,512,512,512]\n");
    expect(structurallySingleOutputRecursion.stdout.text).toBe("[512,512,512,512,512]\n");
    expect(userDefined.stdout.text).toBe(`\
1
1
1
1
`);
    expect(finiteLoops.stdout.text).toBe(`\
0
1
2
3
`);
    expect(consumers.stdout.text).toBe(`\
7
1
false
`);
    expect(booleanConsumers.stdout.text).toBe(`\
true
false
`);
    expect(cancelledFailure.stdout.text).toBe("1\n");
    expect(recurseFailure.stdout.text).toBe(`\
0
1
2
`);
    expect(recurseFailure.stderr.text).toContain("late");
    expect(recurseFailure.result.exitCode).toBe(5);
    expect(recurseInputCursor.stdout.text).toBe(`\
0
10
20
30
`);
    expect(recurseInputMetadata.stdout.text).toBe(`\
[0,1]
[10,2]
20
30
`);
    expect(binaryAndUnary.stdout.text).toBe(`\
2
2
2
2
2
-1
-2
-1
-2
`);
    expect(binaryDemand.stdout.text).toBe(`\
[11,1]
[21,2]
30
`);
    for (const outcome of [
      repeatLimited,
      repeatPiped,
      recurseLimited,
      deepSingleOutputLoops,
      structurallySingleOutputLoops,
      structurallySingleOutputRecursion,
      userDefined,
      finiteLoops,
      consumers,
      booleanConsumers,
      cancelledFailure,
      recurseInputCursor,
      recurseInputMetadata,
      binaryAndUnary,
      binaryDemand,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves top-level foreach order, prefixes, and shared input cursor", async () => {
    const finite = await execute({
      filter: String.raw`foreach (1,2) as $x (0; .+$x; .)`,
      options: "-nc",
    });
    const lateFailure = await execute({
      filter: String.raw`foreach (1,2,error("late")) as $x (0; .+$x; .)`,
      options: "-nc",
    });
    const cancelledFailure = await execute({
      filter: String.raw`limit(1; foreach (1,error("late")) as $x (0; .+$x; .))`,
      options: "-nc",
    });
    const inputCursor = await execute({
      filter: String.raw`foreach input as $x ([input,input_line_number]; [.[0],$x,input_line_number]; .), inputs`,
      stdinText: `\
10
20
30
40
`,
      options: "-nc",
    });

    expect(finite.stdout.text).toBe(`\
1
3
`);
    expect(lateFailure.stdout.text).toBe(`\
1
3
`);
    expect(lateFailure.stderr.text).toContain("late");
    expect(lateFailure.result.exitCode).toBe(5);
    expect(cancelledFailure.stdout.text).toBe("1\n");
    expect(cancelledFailure.stderr.text).toBe("");
    expect(cancelledFailure.result.exitCode).toBe(0);
    expect(inputCursor.stdout.text).toBe(`\
[10,20,2]
30
40
`);
    for (const execution of [finite, inputCursor]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("preserves reduce initial-stream order, cursor sharing, and empty updates", async () => {
    const cancelledInitialFailure = await execute({
      filter: String.raw`limit(1; reduce (1) as $x ((0,error("late")); .+$x))`,
      options: "-nc",
    });
    const emptyUpdate = await execute({
      filter: String.raw`reduce (1,2) as $x (0; empty)`,
      options: "-nc",
    });
    const inputCursor = await execute({
      filter: String.raw`reduce input as $x (input; [.,$x]), inputs`,
      stdinText: `\
10
20
30
40
`,
      options: "-nc",
    });
    const multiInitialCursor = await execute({
      filter: String.raw`reduce input as $x ((input,input); [.,$x]), inputs`,
      stdinText: `\
10
20
30
40
50
`,
      options: "-nc",
    });

    expect(cancelledInitialFailure.stdout.text).toBe("1\n");
    expect(emptyUpdate.stdout.text).toBe("null\n");
    expect(inputCursor.stdout.text).toBe(`\
[10,20]
30
40
`);
    expect(multiInitialCursor.stdout.text).toBe(`\
[10,20]
[30,40]
50
`);
    for (const execution of [cancelledInitialFailure, emptyUpdate, inputCursor, multiInitialCursor]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("preserves last generator emptiness and demanded input number lexemes", async () => {
    const lastEmpty = await execute({
      filter: String.raw`last(empty)`,
      options: "-nc",
    });
    const demandedOrigins = await execute({
      filter: String.raw`inputs`,
      stdinText: `\
1.00
2e0
3.000
4e0
`,
      options: "-nc",
    });
    const lastTail = await execute({
      filter: String.raw`last(input,input),inputs`,
      stdinText: `\
1.00
2e0
3.000
4e0
`,
      options: "-nc",
    });

    expect(lastEmpty.stdout.text).toBe("null\n");
    expect(demandedOrigins.stdout.text).toBe(`\
1.00
2
3.000
4
`);
    expect(lastTail.stdout.text).toBe(`\
2
3.000
4
`);
    for (const execution of [lastEmpty, demandedOrigins, lastTail]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("keeps aggregate filter failures atomic before a value is complete", async () => {
    const indexFailure = await execute({
      filter: String.raw`limit(1; INDEX(({"id":"a"},error("late")); .id))`,
      options: "-nc",
    });
    const mapFailure = await execute({
      filter: String.raw`[1] | limit(1; map((.,error("late"))))`,
      options: "-nc",
    });
    const withEntriesFailure = await execute({
      filter: String.raw`{"a":1} | limit(1; with_entries((.,error("late"))))`,
      options: "-nc",
    });

    for (const execution of [indexFailure, mapFailure, withEntriesFailure]) {
      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toContain("late");
      expect(execution.result.exitCode).toBe(5);
    }
  });

  it("streams limit and nth count filters with jq count coercion", async () => {
    const streamed = await execute({
      filter: String.raw`limit((1,2); range(5)), nth((0,2); range(5)), limit(1; limit((1,repeat(2)); range(5)))`,
      options: "-nc",
    });
    const cursor = await execute({
      filter: String.raw`limit((input,input); range(4)), input`,
      stdinText: `\
1
2
42
`,
      options: "-nc",
    });
    const values = await execute({
      filter: String.raw`[limit((0.1,-1,null,true); range(4))], [nth((1.1,infinite); range(5))]`,
      options: "-nc",
    });
    const stringLimit = await execute({
      filter: String.raw`limit("1"; range(3))`,
      options: "-nc",
    });
    const nullNth = await execute({
      filter: String.raw`nth(null; range(3))`,
      options: "-nc",
    });

    expect(streamed.stdout.text).toBe(`\
0
0
1
0
2
0
`);
    expect(cursor.stdout.text).toBe(`\
0
0
1
42
`);
    expect(values.stdout.text).toBe(`\
[0,0,1,2,3,0,1,2,3,0,1,2,3]
[2]
`);
    for (const execution of [streamed, cursor, values]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(stringLimit.stdout.text).toBe("");
    expect(stringLimit.stderr.text).toContain('string ("1") and number (1) cannot be subtracted');
    expect(stringLimit.result.exitCode).toBe(5);
    expect(nullNth.stdout.text).toBe("");
    expect(nullNth.stderr.text).toContain("nth doesn't support negative indices");
    expect(nullNth.result.exitCode).toBe(5);
  });

  it("preserves top-level walk mapper streams and structural failure prefixes", async () => {
    const scalar = await execute({
      filter: String.raw`walk((., . + 10))`,
      stdinText: "1\n",
    });
    const array = await execute({
      filter: String.raw`walk((., if type == "number" then . + 10 else empty end))`,
      stdinText: "[1]\n",
    });
    const object = await execute({
      filter: String.raw`walk((., if type == "number" then . + 10 else empty end))`,
      stdinText: '{"a":1}\n',
    });
    const scalarFailure = await execute({
      filter: String.raw`walk((., error("late")))`,
      stdinText: "1\n",
    });
    const arrayFailure = await execute({
      filter: String.raw`walk((., error("late")))`,
      stdinText: "[1]\n",
    });
    const objectFailure = await execute({
      filter: String.raw`walk((., error("late")))`,
      stdinText: '{"a":1}\n',
    });
    const inputCursor = await execute({
      filter: String.raw`walk(input), inputs`,
      stdinText: `\
1
10
20
`,
    });

    expect(scalar.stdout.text).toBe(`\
1
11
`);
    expect(array.stdout.text).toBe("[1,11]\n");
    expect(object.stdout.text).toBe('{"a":1}\n');
    expect(inputCursor.stdout.text).toBe(`\
10
20
`);
    for (const execution of [scalar, array, object, inputCursor]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(scalarFailure.stdout.text).toBe("1\n");
    expect(arrayFailure.stdout.text).toBe("");
    expect(objectFailure.stdout.text).toBe('{"a":1}\n');
    for (const execution of [scalarFailure, arrayFailure, objectFailure]) {
      expect(execution.stderr.text).toContain("late");
      expect(execution.result.exitCode).toBe(5);
    }
  });

  it("cancels builtin-specific filter streams after the demanded prefix", async () => {
    const builtins = await execute({
      filter: String.raw`[
        ([1,2] | map_values(repeat(.))),
        ({"a":1} | map_values((.,error("late")))),
        ({"a":{"b":1}} | limit(1; walk(repeat(.)))),
        ([1] | limit(1; walk((., if type == "number" then .+1 else error("root-late") end)))),
        (null | [limit(2; truncate_stream(repeat([[0],1])))]),
        (null | [limit(2; fromstream(repeat([[],1])))])
      ]`,
      options: "-nc",
    });
    const cursor = await execute({
      filter: String.raw`limit(1; fromstream(inputs)), inputs`,
      stdinText: `\
[[],1]
[[],2]
[[],3]
`,
      options: "-nc",
    });
    const errorArgument = await execute({
      filter: String.raw`error(repeat("x"))`,
      options: "-nc",
    });
    const numericErrorArgument = await execute({
      filter: String.raw`error(repeat(7))`,
      options: "-nc",
    });

    expect(builtins.stdout.text).toBe(
      '[[1,2],{"a":1},{"a":{"b":1}},[1,2],[[[0],1],[[0],1]],[1,1]]\n',
    );
    expect(builtins.stderr.text).toBe("");
    expect(builtins.result.exitCode).toBe(0);
    expect(cursor.stdout.text).toBe(`\
1
[[],2]
[[],3]
`);
    expect(cursor.stderr.text).toBe("");
    expect(cursor.result.exitCode).toBe(0);
    expect(errorArgument.stdout.text).toBe("");
    expect(errorArgument.stderr.text).toContain("x");
    expect(errorArgument.result.exitCode).toBe(5);
    expect(numericErrorArgument.stdout.text).toBe("");
    expect(numericErrorArgument.stderr.text).toContain("(not a string): 7");
    expect(numericErrorArgument.result.exitCode).toBe(5);
  });

  it("evaluates compound-assignment right streams against the root input", async () => {
    const rootRelative = await execute({
      filter: String.raw`.a += .b`,
      stdinText: '{"a":10,"b":20}\n',
    });
    const streamedPaths = await execute({
      filter: String.raw`(.a,.b) += (1,2)`,
      stdinText: '{"a":10,"b":20}\n',
    });
    const falseyStream = await execute({
      filter: String.raw`.x //= (1,2)`,
      stdinText: '{"x":false}\n',
    });
    const truthyEmpty = await execute({
      filter: String.raw`.x //= empty`,
      stdinText: '{"x":true}\n',
    });
    const truthyError = await execute({
      filter: String.raw`.x //= error("right")`,
      stdinText: '{"x":true}\n',
    });
    const prefixError = await execute({
      filter: String.raw`.x //= (1,error("right"))`,
      stdinText: '{"x":true}\n',
    });
    const demandDriven = await execute({
      filter: String.raw`(.x //= input), inputs`,
      stdinText: `\
{"x":true}
1
2
`,
    });

    expect(rootRelative.stdout.text).toBe('{"a":30,"b":20}\n');
    expect(streamedPaths.stdout.text).toBe(`\
{"a":11,"b":21}
{"a":12,"b":22}
`);
    expect(falseyStream.stdout.text).toBe(`\
{"x":1}
{"x":2}
`);
    expect(truthyEmpty.stdout.text).toBe("");
    expect(demandDriven.stdout.text).toBe(`\
{"x":true}
2
`);
    for (const outcome of [rootRelative, streamedPaths, falseyStream, truthyEmpty, demandDriven]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(truthyError.stdout.text).toBe("");
    expect(truthyError.stderr.text).toContain("right");
    expect(truthyError.result.exitCode).toBe(5);
    expect(prefixError.stdout.text).toBe('{"x":true}\n');
    expect(prefixError.stderr.text).toContain("right");
    expect(prefixError.result.exitCode).toBe(5);
  });

  it("continues with later top-level inputs after ordinary runtime errors", async () => {
    const recovered = await execute({
      filter: String.raw`if type == "number" then error("E") else .a end`,
      stdinText: `\
1
{"a":2}
3
{"a":4}
`,
    });
    const allFailed = await execute({
      filter: String.raw`error("E")`,
      stdinText: `\
1
2
3
`,
    });
    const demandFailure = await execute({
      filter: String.raw`input,error("E")`,
      stdinText: `\
1
2
3
`,
    });

    expect(recovered.stdout.text).toBe(`\
2
4
`);
    expect(recovered.stderr.text.match(/jq: error: E/gu)).toHaveLength(2);
    expect(recovered.result.exitCode).toBe(0);
    expect(allFailed.stdout.text).toBe("");
    expect(allFailed.stderr.text.match(/jq: error: E/gu)).toHaveLength(3);
    expect(allFailed.result.exitCode).toBe(5);
    expect(demandFailure.stdout.text).toBe("2\n");
    expect(demandFailure.stderr.text).toContain("jq: error: E");
    expect(demandFailure.stderr.text).toContain("jq: error: break");
    expect(demandFailure.result.exitCode).toBe(5);
  });

  it("matches jq arithmetic diagnostics and bounded UTF-8 value previews", async () => {
    const incompatible = await execute({
      filter: String.raw`false + [1]`,
      options: "-nc",
    });
    const zeroDivisor = await execute({
      filter: String.raw`2 / 0`,
      options: "-nc",
    });
    const truncated = await execute({
      filter: String.raw`false + "xxxxxxxxxxxxx"`,
      options: "-nc",
    });
    const utf8Boundary = await execute({
      filter: String.raw`false + "xxxxxxxxéé"`,
      options: "-nc",
    });

    expect(incompatible.stderr.text).toContain(
      "boolean (false) and array ([1]) cannot be added",
    );
    expect(zeroDivisor.stderr.text).toContain(
      "number (2) and number (0) cannot be divided because the divisor is zero",
    );
    expect(truncated.stderr.text).toContain(
      'boolean (false) and string ("xxxxxxxxxx...) cannot be added',
    );
    expect(utf8Boundary.stderr.text).toContain(
      'boolean (false) and string ("xxxxxxxxéé") cannot be added',
    );
    for (const outcome of [incompatible, zeroDivisor, truncated, utf8Boundary]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.result.exitCode).toBe(5);
    }
  });

  it("bounds jq object-key diagnostic previews without serializing entire values", async () => {
    const arrayKey = await execute({
      filter: String.raw`{([range(0;100)]):1}`,
      options: "-nc",
    });
    const objectKey = await execute({
      filter: String.raw`{({abcdefghijklmno:1}):1}`,
      options: "-nc",
    });

    expect(arrayKey.stderr.text).toContain(
      "Cannot use array ([0,1,2,3,4,...) as object key",
    );
    expect(objectKey.stderr.text).toContain(
      'Cannot use object ({"abcdefghi...) as object key',
    );
    expect(arrayKey.stdout.text).toBe("");
    expect(arrayKey.result.exitCode).toBe(5);
    expect(objectKey.stdout.text).toBe("");
    expect(objectKey.result.exitCode).toBe(3);
  });

  it("rejects non-string object keys at compile time and runtime", async () => {
    const literalNumber = await execute({
      filter: "{(1):2}",
      options: "-nc",
    });
    const literalBoolean = await execute({
      filter: "{(true):2}",
      options: "-nc",
    });
    const foldedConstants = await Promise.all([
      "{([]):empty}",
      "{({}):empty}",
      "{(1+0):empty}",
      "{(1==1):empty}",
      "{(1 | .):empty}",
      "{(. | 1):empty}",
      "{(([([] == \"a\")] | (. | .))):empty}",
      "{([([{}],(false < 1))]):empty}",
      "{(([([],[])])):empty}",
    ].map(async (filter) => execute({ filter, options: "-nc" })));
    const runtimeBooleanOperator = await execute({
      filter: "{(true and false):2}",
      options: "-nc",
    });
    const unusedRuntimeBooleanOperator = await execute({
      filter: "{(true and false):empty}",
      options: "-nc",
    });
    const runtimeUnaryNumber = await execute({
      filter: "{(-1):2}",
      options: "-nc",
    });
    const unusedRuntimeUnaryNumber = await execute({
      filter: "{(-1):empty}",
      options: "-nc",
    });
    const dynamicNumber = await execute({
      filter: "{(.):2}",
      stdinText: "1\n",
    });
    const dynamicArray = await execute({
      filter: "{(.):2}",
      stdinText: "[1]\n",
    });
    const dynamicString = await execute({
      filter: "{(.):2}",
      stdinText: '"key"\n',
    });
    const unusedDynamicNumber = await execute({
      filter: "{(.):empty}",
      stdinText: "1\n",
    });

    for (const outcome of [literalNumber, literalBoolean, ...foldedConstants]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain("as object key");
      expect(outcome.result.exitCode).toBe(3);
    }
    expect(runtimeBooleanOperator.stdout.text).toBe("");
    expect(runtimeBooleanOperator.stderr.text).toContain("as object key");
    expect(runtimeBooleanOperator.result.exitCode).toBe(5);
    expect(unusedRuntimeBooleanOperator.stdout.text).toBe("");
    expect(unusedRuntimeBooleanOperator.stderr.text).toBe("");
    expect(unusedRuntimeBooleanOperator.result.exitCode).toBe(0);
    expect(runtimeUnaryNumber.stdout.text).toBe("");
    expect(runtimeUnaryNumber.stderr.text).toContain("as object key");
    expect(runtimeUnaryNumber.result.exitCode).toBe(5);
    expect(unusedRuntimeUnaryNumber.stdout.text).toBe("");
    expect(unusedRuntimeUnaryNumber.stderr.text).toBe("");
    expect(unusedRuntimeUnaryNumber.result.exitCode).toBe(0);
    for (const outcome of [dynamicNumber, dynamicArray]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain("as object key");
      expect(outcome.result.exitCode).toBe(5);
    }
    expect(dynamicString.stdout.text).toBe('{"key":2}\n');
    expect(dynamicString.stderr.text).toBe("");
    expect(dynamicString.result.exitCode).toBe(0);
    expect(unusedDynamicNumber.stdout.text).toBe("");
    expect(unusedDynamicNumber.stderr.text).toBe("");
    expect(unusedDynamicNumber.result.exitCode).toBe(0);
  });

  it("supports whole-pattern scoped Oniguruma modifiers", async () => {
    const execution = await execute({
      filter: String.raw`[
        test("(?i:abc)"),
        test("(?m:^b)"),
        test("(?s:a.b)"),
        test("(?x:a b)"),
        test("(?-i:abc)";"i")
      ]`,
      stdinText: String.raw`"a\nb"` + "\n",
    });
    const ignoreCase = await execute({
      filter: String.raw`capture("(?i:(?<word>[a-z]+))")`,
      stdinText: '"ABC"\n',
    });

    expect(execution.stdout.text).toBe("[false,true,true,false,false]\n");
    expect(ignoreCase.stdout.text).toBe('{"word":"ABC"}\n');
    for (const outcome of [execution, ignoreCase]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps outputs emitted before a caught runtime error", async () => {
    const execution = await execute({
      filter: 'try (1, error("boom"), 2) catch ["caught", .]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
1
["caught","boom"]
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("gives try/catch tighter precedence than pipe and comma", async () => {
    const success = await execute({
      filter: 'try (. + 1) catch . | [., "after"]',
      stdinText: "1\n",
    });
    const caught = await execute({
      filter: 'try error("x") catch . | [., "after"]',
      options: "-nc",
    });
    const comma = await execute({
      filter: 'try 1 catch ., "tail"',
      options: "-nc",
    });
    const groupedCatch = await execute({
      filter: 'try error("x") catch (. | [., "catch"])',
      options: "-nc",
    });
    const alternative = await execute({
      filter: 'try error(null) catch . // "fallback"',
      options: "-nc",
    });

    expect(success.stdout.text).toBe('[2,"after"]\n');
    expect(caught.stdout.text).toBe('["x","after"]\n');
    expect(comma.stdout.text).toBe(`\
1
"tail"
`);
    expect(groupedCatch.stdout.text).toBe('["x","catch"]\n');
    expect(alternative.stdout.text).toBe('"fallback"\n');
    for (const outcome of [success, caught, comma, groupedCatch, alternative]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("streams successful pipe outputs before a caught runtime error", async () => {
    const execution = await execute({
      filter: 'try ((1, error("boom")) | . + 1) catch ["caught", .]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
2
["caught","boom"]
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("pipes one input into every comma-separated filter on the right", async () => {
    const execution = await execute({
      filter: "[. | type, length, tostring]",
      stdinText: "[1]\n",
    });

    expect(execution.stdout.text).toBe('["array",1,"[1]"]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("treats not as a zero-argument filter", async () => {
    const execution = await execute({
      filter: "[(null | not), (false | not), (true | not), (0 | not)]",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("[true,true,false,false]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("matches jq string arithmetic and integer remainder semantics", async () => {
    const execution = await execute({
      filter: '["a" * 2.5, "a" * -1, "" / "x", 5.5 % 2, (-3.5) % (-3.5)]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe('["aa",null,[],1,0]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("treats --indent 0 as compact JSON output", async () => {
    const execution = await execute({
      filter: ".",
      stdinText: '{"a":[1,2]}\n',
      options: "--indent 0",
    });

    expect(execution.stdout.text).toBe('{"a":[1,2]}\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("sorts by every output produced by the sort_by key filter", async () => {
    const execution = await execute({
      filter: "sort_by(.group, .score)",
      stdinText: `\
{"group":"b","score":1}
{"group":"a","score":2}
{"group":"a","score":1}
`,
      options: "-sc",
    });

    expect(execution.stdout.text).toBe(
      '[{"group":"a","score":1},{"group":"a","score":2},{"group":"b","score":1}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("filters paths with the supplied node filter", async () => {
    const execution = await execute({
      filter: "[paths(scalars)]",
      stdinText: '{"a":[1,{"b":2}],"c":null}\n',
    });

    expect(execution.stdout.text).toBe('[["a",0],["a",1,"b"]]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves paths predicate multiplicity, root effects, and atomic failures", async () => {
    const duplicated = await execute({
      filter: String.raw`paths(false,true,true)`,
      stdinText: '{"a":1}\n',
    });
    const rootInputDemand = await execute({
      filter: String.raw`(limit(1; paths(input))), inputs`,
      stdinText: `\
{"a":1,"b":2}
true
false
3
`,
    });
    const laterPathFailure = await execute({
      filter: String.raw`limit(1; paths(if . == 1 then true else error("late") end))`,
      stdinText: '{"a":1,"b":2}\n',
    });
    const predicateFailure = await execute({
      filter: String.raw`paths(false,error("needed"))`,
      stdinText: '{"a":1}\n',
    });
    const laterNodeCancelled = await execute({
      filter: String.raw`[1,"x"] | limit(1; paths(if type=="string" then error("late") else true end))`,
      options: "-nc",
    });
    const laterNodeFailure = await execute({
      filter: String.raw`[1,"x"] | paths(if type=="string" then error("late") else true end)`,
      options: "-nc",
    });

    expect(duplicated.stdout.text).toBe(`["a"]\n["a"]\n`);
    expect(duplicated.stderr.text).toBe("");
    expect(duplicated.result.exitCode).toBe(0);
    expect(rootInputDemand.stdout.text).toBe('["b"]\n');
    expect(rootInputDemand.stderr.text).toBe("");
    expect(rootInputDemand.result.exitCode).toBe(0);
    expect(laterNodeCancelled.stdout.text).toBe('[0]\n');
    expect(laterNodeCancelled.stderr.text).toBe("");
    expect(laterNodeCancelled.result.exitCode).toBe(0);
    expect(laterNodeFailure.stdout.text).toBe('[0]\n');
    expect(laterNodeFailure.stderr.text).toContain("late");
    expect(laterNodeFailure.result.exitCode).toBe(5);
    for (const outcome of [laterPathFailure, predicateFailure]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toContain(outcome === laterPathFailure ? "late" : "needed");
      expect(outcome.result.exitCode).toBe(5);
    }
  });

  it("supports generator and predicate arguments for any and all", async () => {
    const execution = await execute({
      filter: "[any(.[]; . > 2), all(.[]; . > 0)]",
      stdinText: "[1,2,3]\n",
    });

    expect(execution.stdout.text).toBe("[true,true]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("shares input cursor and metadata through any and all predicates", async () => {
    const anyCursor = await execute({
      filter: String.raw`any((1,2); . == input), inputs`,
      stdinText: `\
1
9
`,
      options: "-nc",
    });
    const allCursor = await execute({
      filter: String.raw`all((1,2); . == input), inputs`,
      stdinText: `\
1
2
9
`,
      options: "-nc",
    });
    const lineMetadata = await execute({
      filter: String.raw`[all((1,2); (input|input_line_number) == .), input_line_number], inputs`,
      stdinText: `\
0
0
9
`,
      options: "-nc",
    });

    expect(anyCursor.stdout.text).toBe(`\
true
9
`);
    expect(allCursor.stdout.text).toBe(`\
true
9
`);
    expect(lineMetadata.stdout.text).toBe(`\
[true,2]
9
`);
    for (const outcome of [anyCursor, allCursor, lineMetadata]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("shares input cursor and metadata through while and until", async () => {
    const whileCursor = await execute({
      filter: String.raw`while(input < 3; input), inputs`,
      stdinText: `\
1
2
3
4
`,
      options: "-nc",
    });
    const untilCursor = await execute({
      filter: String.raw`until(input >= 3; input), inputs`,
      stdinText: `\
1
2
3
4
`,
      options: "-nc",
    });
    const lineMetadata = await execute({
      filter: String.raw`while(input_line_number < 3; input), [input_line_number, inputs]`,
      stdinText: `\
1
2
3
4
`,
      options: "-nc",
    });

    expect(whileCursor.stdout.text).toBe(`\
null
4
`);
    expect(untilCursor.stdout.text).toBe(`\
2
4
`);
    expect(lineMetadata.stdout.text).toBe(`\
null
1
2
[3,4]
`);
    for (const outcome of [whileCursor, untilCursor, lineMetadata]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("streams loop and recurse conditions without consuming cancelled input", async () => {
    const directCondition = await execute({
      filter: String.raw`[0 | limit(1; while((true,input); . + 1))], inputs`,
      stdinText: `\
false
99
`,
      options: "-nc",
    });
    const boundWhileCondition = await execute({
      filter: String.raw`def p($n): . < $n, false; [0 | limit(2; while(p(input); . + 1))], inputs`,
      stdinText: `\
100
200
99
`,
      options: "-nc",
    });
    const boundRecurseCondition = await execute({
      filter: String.raw`def p($n): . < $n, false; [0 | limit(3; recurse(. + 1; p(input)))], inputs`,
      stdinText: `\
100
200
300
99
`,
      options: "-nc",
    });

    expect(directCondition.stdout.text).toBe(`\
[0]
false
99
`);
    expect(boundWhileCondition.stdout.text).toBe(`\
[0,1]
99
`);
    expect(boundRecurseCondition.stdout.text).toBe(`\
[0,1,2]
300
99
`);
    for (const outcome of [directCondition, boundWhileCondition, boundRecurseCondition]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves unconsumed demand lookahead and defers late parse errors", async () => {
    const cancelledComma = await execute({
      filter: String.raw`limit(1; (input,input)), inputs`,
      stdinText: `\
1
2
3
`,
      options: "-nc",
    });
    const ignoredLateParseError = await execute({
      filter: String.raw`limit(1; input)`,
      stdinText: `\
1
not-json
`,
      options: "-nc",
    });
    const demandedLateParseError = await execute({
      filter: String.raw`limit(1; input), inputs`,
      stdinText: `\
1
not-json
`,
      options: "-nc",
    });

    expect(cancelledComma.stdout.text).toBe(`\
1
2
3
`);
    expect(cancelledComma.stderr.text).toBe("");
    expect(cancelledComma.result.exitCode).toBe(0);

    expect(ignoredLateParseError.stdout.text).toBe("1\n");
    expect(ignoredLateParseError.stderr.text).toBe("");
    expect(ignoredLateParseError.result.exitCode).toBe(0);

    expect(demandedLateParseError.stdout.text).toBe("1\n");
    expect(demandedLateParseError.stderr.text).toContain("parse error");
    expect(demandedLateParseError.result.exitCode).toBe(5);
  });

  it("replays caught input parse errors once and continues with later JSON values", async () => {
    const optionalLeading = await execute({
      filter: String.raw`input?, inputs`,
      stdinText: `\
not-json
1
2
`,
      options: "-nc",
    });
    const optionalMidstream = await execute({
      filter: String.raw`input, input?, inputs`,
      stdinText: `\
1
{bad}
2
3
`,
      options: "-nc",
    });
    const uncaughtLeading = await execute({
      filter: String.raw`input, inputs`,
      stdinText: `\
not-json
1
2
`,
      options: "-nc",
    });

    expect(optionalLeading.stdout.text).toBe(`\
1
2
`);
    expect(optionalLeading.stderr.text).toBe("");
    expect(optionalLeading.result.exitCode).toBe(0);
    expect(optionalMidstream.stdout.text).toBe(`\
1
2
3
`);
    expect(optionalMidstream.stderr.text).toBe("");
    expect(optionalMidstream.result.exitCode).toBe(0);
    expect(uncaughtLeading.stdout.text).toBe("");
    expect(uncaughtLeading.stderr.text).toContain("parse error");
    expect(uncaughtLeading.result.exitCode).toBe(5);
  });

  it("accepts jq finite-number input syntax beyond strict JSON while preserving source formatting", async () => {
    const topLevel = await execute({
      filter: ".",
      stdinText: `[01,1.,.5,+1,1.e2,{"x":-00.50}]
`,
      options: "-c",
    });
    const fromJson = await execute({
      filter: String.raw`"[01,1.,.5,+1,1.e2,{\"x\":-00.50}]" | fromjson`,
      options: "-nc",
    });

    expect(topLevel.stdout.text).toBe('[1,1,0.5,1,1E+2,{"x":-0.50}]\n');
    expect(fromJson.stdout.text).toBe('[1,1,0.5,1,1E+2,{"x":-0.50}]\n');
    for (const outcome of [topLevel, fromJson]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("accepts jq nan and infinity input tokens in top-level, nested, and fromjson values", async () => {
    const nested = await execute({
      filter: '[(.[0]|isnan),(.[1]|isinfinite),(.[2]|isinfinite),.[3]]',
      stdinText: "[nan,INF,-Infinity,{\"x\":NaN}]\n",
      options: "-c",
    });
    const fromJson = await execute({
      filter: String.raw`"[+nan,inf,-infinity]" | fromjson | [(.[0]|isnan),(.[1]|isinfinite),(.[2]|isinfinite)]`,
      options: "-nc",
    });
    const demanded = await execute({
      filter: "input?, inputs",
      stdinText: `\
1
nan
[NaN]
`,
      options: "-nc",
    });

    expect(nested.stdout.text).toBe('[true,true,true,{"x":null}]\n');
    expect(fromJson.stdout.text).toBe("[true,true,true]\n");
    expect(demanded.stdout.text).toBe(`\
1
null
[null]
`);
    for (const outcome of [nested, fromJson, demanded]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("treats malformed primitive delimiters as one catchable input and resumes at later values", async () => {
    const cases = [
      { stdinText: `\
01
2
3
`, stdout: `\
1
2
3
` },
      { stdinText: `\
1.
2
3
`, stdout: `\
1
2
3
` },
      { stdinText: `\
]
1
2
`, stdout: `\
1
2
` },
      { stdinText: `\
}
1
2
`, stdout: `\
1
2
` },
      { stdinText: `\
1,2
3
4
`, stdout: `\
3
4
` },
      { stdinText: `\
1,"a"
`, stdout: "" },
    ] as const;

    for (const testCase of cases) {
      const outcome = await execute({
        filter: String.raw`input?, inputs`,
        stdinText: testCase.stdinText,
        options: "-nc",
      });
      expect(outcome.stdout.text).toBe(testCase.stdout);
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps optional comma loop branches iterative and error-atomic", async () => {
    const scaled = await execute({
      filter: String.raw`[0 | limit(64; while(. < 1000; ((. + 1, . + 100)?)))] | length`,
      options: "-nc",
    });
    const lateError = await execute({
      filter: String.raw`[0 | limit(8; while(. < 3; ((. + 1, error("x"), . + 10)?)))]`,
      options: "-nc",
    });
    const conditionError = await execute({
      filter: String.raw`[0 | limit(1; until(((. >= 3, error("x"))?); . + 1))]`,
      options: "-nc",
    });
    const nestedOptional = await execute({
      filter: String.raw`[0 | limit(64; while(. < 1000; ((((. + 1, . + 100)?))?)))] | length`,
      options: "-nc",
    });
    const tryEmpty = await execute({
      filter: String.raw`[0 | limit(64; while(. < 1000; try (. + 1, . + 100) catch empty))] | length`,
      options: "-nc",
    });

    expect(scaled.stdout.text).toBe("64\n");
    expect(lateError.stdout.text).toBe("[0,1,2]\n");
    expect(conditionError.stdout.text).toBe("[3]\n");
    expect(nestedOptional.stdout.text).toBe("64\n");
    expect(tryEmpty.stdout.text).toBe("64\n");
    for (const outcome of [scaled, lateError, conditionError, nestedOptional, tryEmpty]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps materialized iterate branches stack-safe and cursor-atomic", async () => {
    const loop = await execute({
      filter: String.raw`[0 | limit(64; while(. < 100000; [. + 1, . + 10000][]))] | length`,
      options: "-nc",
    });
    const recurse = await execute({
      filter: String.raw`[0 | limit(64; recurse(. + 1; {a:true,b:false}[]))] | length`,
      options: "-nc",
    });
    const sharedInput = await execute({
      filter: String.raw`limit(2; while(. < 100; [input,input][])), inputs`,
      stdinText: `\
0
10.00
20.000
30.0000
`,
    });

    expect(loop.stdout.text).toBe("64\n");
    expect(recurse.stdout.text).toBe("64\n");
    expect(sharedInput.stdout.text).toBe(`\
0
10.00
30.0000
`);
    for (const outcome of [loop, recurse, sharedInput]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps bounded label object string and literal-range branches iterative", async () => {
    const label = await execute({
      filter: String.raw`[0 | limit(128; while(. < 100000; label $x | (. + 1, . + 10000)))] | length`,
      options: "-nc",
    });
    const object = await execute({
      filter: String.raw`[0 | limit(128; while(. < 100000; ({x:(. + 1, . + 10000)} | .x)))] | length`,
      options: "-nc",
    });
    const string = await execute({
      filter: String.raw`[0 | limit(128; while(. < 100000; ("\((. + 1, . + 10000))" | tonumber)))] | length`,
      options: "-nc",
    });
    const literalRange = await execute({
      filter: String.raw`[0 | limit(128; recurse(. + 1; range(0;64)))] | length`,
      options: "-nc",
    });
    const wideLiteralRange = await execute({
      filter: String.raw`[0 | limit(128; recurse(. + 1; range(0;4096)))] | length`,
      options: "-nc",
    });
    const rangeUpdate = await execute({
      filter: String.raw`[0 | limit(128; while(. < 1000000; range(1;66)))] | length`,
      options: "-nc",
    });
    const rangeNext = await execute({
      filter: String.raw`[0 | limit(128; recurse(range(1;4097)))] | length`,
      options: "-nc",
    });
    const nestedLabel = await execute({
      filter: String.raw`[0 | limit(128; while(. < 100000; label $x | (label $y | (. + 1, . + 10000), . + 20000)))] | length`,
      options: "-nc",
    });
    const multiEntryObject = await execute({
      filter: String.raw`[0 | limit(128; while(. < 100000; ({x:(. + 1, . + 10000), y:0} | .x)))] | length`,
      options: "-nc",
    });
    const multiInterpolation = await execute({
      filter: String.raw`[0 | limit(128; while(. < 100000; ("\((. + 1, . + 10000))-\(0)" | split("-")[0] | tonumber)))] | length`,
      options: "-nc",
    });
    const interpolationOrigin = await execute({
      filter: String.raw`limit(2; while(. < 100; ("\((input,input))" | tonumber))), inputs`,
      stdinText: `\
0
10.00
20.000
30.0000
`,
    });

    expect(label.stdout.text).toBe("128\n");
    expect(object.stdout.text).toBe("128\n");
    expect(string.stdout.text).toBe("128\n");
    expect(literalRange.stdout.text).toBe("128\n");
    expect(wideLiteralRange.stdout.text).toBe("128\n");
    expect(rangeUpdate.stdout.text).toBe("128\n");
    expect(rangeNext.stdout.text).toBe("128\n");
    expect(nestedLabel.stdout.text).toBe("128\n");
    expect(multiEntryObject.stdout.text).toBe("128\n");
    expect(multiInterpolation.stdout.text).toBe("128\n");
    expect(interpolationOrigin.stdout.text).toBe(`\
0
10.00
20.000
30.0000
`);
    for (const outcome of [
      label,
      object,
      string,
      literalRange,
      wideLiteralRange,
      rangeUpdate,
      rangeNext,
      nestedLabel,
      multiEntryObject,
      multiInterpolation,
      interpolationOrigin,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps variable and precision-stalled range streams cancellable", async () => {
    const variableUpdate = await execute({
      filter: String.raw`66 as $end | [0 | limit(128; while(. < 1000000; range(1;$end)))] | length`,
      options: "-nc",
    });
    const variableNext = await execute({
      filter: String.raw`66 as $end | [0 | limit(128; recurse(range(1;$end)))] | length`,
      options: "-nc",
    });
    const variableCondition = await execute({
      filter: String.raw`66 as $end | [0 | limit(128; recurse(. + 1; range(0;$end)))] | length`,
      options: "-nc",
    });
    const fractionalStep = await execute({
      filter: String.raw`0.5 as $step | [0 | limit(128; recurse(range(0;2;$step)))] | length`,
      options: "-nc",
    });
    const pureArithmetic = await execute({
      filter: String.raw`65 as $end | [0 | limit(128; recurse(range(0;$end + 1)))] | length`,
      options: "-nc",
    });
    const multiOutputArguments = await execute({
      filter: String.raw`[0 | limit(128; recurse(range((0,10);(2,12))))] | length`,
      options: "-nc",
    });
    const lateRangeArgumentError = await execute({
      filter: String.raw`while(. < 3; range((. + 1,error("late")); . + 2))`,
      options: "-nc",
    });
    const emptyRangeArgumentBranch = await execute({
      filter: String.raw`[limit(20; recurse(range((. + 1,empty,. + 10); . + 2); . < 3))]`,
      options: "-nc",
    });
    const sharedInput = await execute({
      filter: String.raw`input as $end | [0 | limit(2; while(. < 1000; range(1;$end)))], inputs`,
      options: "-nc",
      stdinText: `\
66
99
`,
    });
    const stalledPrecision = await execute({
      filter: String.raw`limit(3; range(9007199254740992;9007199254741002))`,
      options: "-nc",
    });

    const sideEffectingUpdatePrefix = await execute({
      filter: String.raw`[0 | while(. == 0; range((1,input);(2,4)))], inputs`,
      options: "-nc",
      stdinText: `\
1
9
99
`,
    });
    const sideEffectingNextPrefix = await execute({
      filter: String.raw`[0 | recurse(range((100,input);(2,4)))], inputs`,
      options: "-nc",
      stdinText: `\
1
100
100
100
100
99
`,
    });
    const sideEffectingConditionPrefix = await execute({
      filter: String.raw`[0 | recurse(. + 1; range((100,input);(1,2)))], inputs`,
      options: "-nc",
      stdinText: `\
1
100
99
`,
    });

    expect(variableUpdate.stdout.text).toBe("128\n");
    expect(variableNext.stdout.text).toBe("128\n");
    expect(variableCondition.stdout.text).toBe("128\n");
    expect(fractionalStep.stdout.text).toBe("128\n");
    expect(pureArithmetic.stdout.text).toBe("128\n");
    expect(multiOutputArguments.stdout.text).toBe("128\n");
    expect(lateRangeArgumentError.stdout.text).toBe(`\
null
1
2
`);
    expect(lateRangeArgumentError.stderr.text).toContain("late");
    expect(lateRangeArgumentError.result.exitCode).toBe(5);
    expect(emptyRangeArgumentBranch.stdout.text).toBe("[null,1,2]\n");
    expect(sharedInput.stdout.text).toBe(`\
[0,1]
99
`);
    expect(stalledPrecision.stdout.text).toBe(`\
9007199254740992
9007199254740992
9007199254740992
`);
    expect(sideEffectingUpdatePrefix.stdout.text).toBe(`\
[0]
9
99
`);
    expect(sideEffectingNextPrefix.stdout.text).toBe(`\
[0,1,1,2,3]
99
`);
    expect(sideEffectingConditionPrefix.stdout.text).toBe(`\
[0,1]
99
`);
    for (const outcome of [
      variableUpdate,
      variableNext,
      variableCondition,
      fractionalStep,
      pureArithmetic,
      sharedInput,
      stalledPrecision,
      sideEffectingUpdatePrefix,
      sideEffectingNextPrefix,
      sideEffectingConditionPrefix,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps distributable recurse branches iterative and condition-stream ordered", async () => {
    const nextBranches = await execute({
      filter: String.raw`[0 | limit(64; recurse((. + 1, . + 10000)))] | length`,
      options: "-nc",
    });
    const conditionBranches = await execute({
      filter: String.raw`[0 | limit(16; recurse(. + 1; (true,false)))] | length`,
      options: "-nc",
    });
    const lateConditionError = await execute({
      filter: String.raw`[0 | limit(4; recurse((. + 1, . + 10); (true,error("c"))))]`,
      options: "-nc",
    });

    expect(nextBranches.stdout.text).toBe("64\n");
    expect(conditionBranches.stdout.text).toBe("16\n");
    expect(lateConditionError.stdout.text).toBe("[0,1,2,3]\n");
    for (const outcome of [nextBranches, conditionBranches, lateConditionError]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps select result number origins separate from predicate metadata", async () => {
    const literalPredicate = await execute({
      filter: String.raw`select(9.000)`,
      stdinText: "3.00\n",
    });
    const inputPredicate = await execute({
      filter: String.raw`select(input) | [.,input_line_number]`,
      stdinText: `\
3.00
9.000
`,
    });

    expect(literalPredicate.stdout.text).toBe("3.00\n");
    expect(inputPredicate.stdout.text).toBe("[3.00,2]\n");
    for (const outcome of [literalPredicate, inputPredicate]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("shares input cursor through binding bodies under cancellation", async () => {
    const execution = await execute({
      filter: String.raw`limit(1; ((1,2) as $x | [$x,input])), inputs`,
      stdinText: `\
10
20
30
`,
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
[1,10]
20
30
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("keeps false in the values type filter", async () => {
    const execution = await execute({
      filter: "[.[] | values]",
      stdinText: '[1,"a",null,false,[],{}]\n',
    });

    expect(execution.stdout.text).toBe('[1,"a",false,[],{}]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("changes only ASCII letters in ascii_downcase and ascii_upcase", async () => {
    const execution = await execute({
      filter: "[ascii_downcase, ascii_upcase]",
      stdinText: '"AbÉz"\n',
    });

    expect(execution.stdout.text).toBe('["abÉz","ABÉZ"]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports a maximum flatten depth", async () => {
    const execution = await execute({
      filter: "[flatten, flatten(1), flatten(0)]",
      stdinText: "[1,[2,[3]],4]\n",
    });

    expect(execution.stdout.text).toBe(
      "[[1,2,3,4],[1,2,[3],4],[1,[2,[3]],4]]\n",
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports the recurse condition argument", async () => {
    const execution = await execute({
      filter: "[recurse(.children[]?; . != null) | .name]",
      stdinText:
        '{"name":"root","children":[{"name":"a","children":[]},{"name":"b"}]}\n',
    });

    expect(execution.stdout.text).toBe('["root","a","b"]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports regex test flags and extended mode", async () => {
    const execution = await execute({
      filter: '[test("^[a-z]+$"; "i"), test("a \\\\s+ b"; "x")]',
      stdinText: '"Alpha"\n',
    });

    expect(execution.stdout.text).toBe("[true,false]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("returns jq match objects with named captures and Unicode offsets", async () => {
    const execution = await execute({
      filter: '[match("a(?<n>[0-9]+)"; "g"), ("😀12" | match("(?<n>[0-9]+)"))]',
      stdinText: '"a12 a34"\n',
    });

    expect(execution.stdout.text).toBe(
      '[{"offset":0,"length":3,"string":"a12","captures":[{"offset":1,"length":2,"string":"12","name":"n"}]},{"offset":4,"length":3,"string":"a34","captures":[{"offset":5,"length":2,"string":"34","name":"n"}]},{"offset":1,"length":2,"string":"12","captures":[{"offset":1,"length":2,"string":"12","name":"n"}]}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("captures named groups and preserves unmatched groups as null", async () => {
    const execution = await execute({
      filter:
        '[capture("(?<key>[a-z]+)=(?<value>[0-9]+)"), ("b" | capture("(?<a>a)?b"))]',
      stdinText: '"x=12"\n',
    });

    expect(execution.stdout.text).toBe(
      '[{"key":"x","value":"12"},{"a":null}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("emits every named capture object when capture uses the global flag", async () => {
    const execution = await execute({
      filter: '[capture("(?<letter>[a-z])"; "g")]',
      stdinText: '"ab"\n',
    });

    expect(execution.stdout.text).toBe('[{"letter":"a"},{"letter":"b"}]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports sub and gsub replacement interpolation", async () => {
    const execution = await execute({
      filter:
        '[sub("(?<n>[0-9]+)"; "<\\(.n)>"), gsub("a(?<n>[0-9]+)"; "<\\(.n)>")]',
      stdinText: '"a12 a34"\n',
    });

    expect(execution.stdout.text).toBe('["a<12> a34","<12> <34>"]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports scan captures and regex splitting", async () => {
    const execution = await execute({
      filter: '[[scan("([a-z])([0-9]+)")], [splits("[0-9]+")]]',
      stdinText: '"a12b34"\n',
    });

    expect(execution.stdout.text).toBe(
      '[[["a","12"],["b","34"]],["a","b",""]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports regular-expression split with jq flags", async () => {
    const execution = await execute({
      filter:
        '[split("[0-9]+"; ""), ("aXbxc" | split("x"; "i")), ("ab" | split(""; "n"))]',
      stdinText: '"a1b22c"\n',
    });

    expect(execution.stdout.text).toBe(
      '[["a","b","c"],["a","b","c"],["ab"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("matches jq byte-oriented regex splitting edge cases", async () => {
    const execution = await execute({
      filter:
        '[("a1b22c333d44" | split("[0-9]+"; "l")), ("aa1日日" | split("\\\\p{L}+"; "l")), ("é日" | split(""; "")), ("abc\\n" | split("$"; ""))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["a1b22c","d",""],["aa1",""],["","é","","日","","",""],["abc","\\n",""]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("keeps jq end-anchor matches outside astral characters", async () => {
    const execution = await execute({
      filter:
        '[("🙂" | [match("$"; "g")]), ("🙂" | [scan("$")]), ("🙂" | [splits("$")]), ("🙂" | sub("$"; "Z"; "l")), ("🙂" | gsub("$"; "Z"; "l"))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[{"offset":1,"length":0,"string":"","captures":[]}],[""],["🙂",""],"🙂Z","🙂Z"]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq Unicode word operators and byte-oriented boundaries", async () => {
    const execution = await execute({
      filter:
        '[("日" | test("\\\\w")), ("🙂" | test("\\\\W")), ("日" | [match("\\\\b"; "g")]), ("🙂" | [match("\\\\B"; "g")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[true,true,[{"offset":0,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]}],[{"offset":0,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]}]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq Unicode word sets inside character classes", async () => {
    const execution = await execute({
      filter:
        '[("é日_0" | [scan("[\\\\w]+")]), ("é日🙂" | [scan("[^\\\\W]+")]), ("é日🙂" | [scan("[\\\\W]+")]), ("é日🙂" | [scan("[^\\\\w]+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["é日_0"],["é日"],["🙂"],["🙂"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq Unicode decimal digit operators", async () => {
    const execution = await execute({
      filter:
        '[("١१１0" | [scan("\\\\d+")]), ("١a" | [scan("[\\\\d]+")]), ("١a" | [scan("[^\\\\D]+")]), ("١a" | [scan("\\\\D+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["١१１0"],["١"],["١"],["a"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq literal h and v escape operators", async () => {
    const execution = await execute({
      filter:
        '[("hHVv\\u000b" | [scan("\\\\h")]), ("hHVv\\u000b" | [scan("\\\\H")]), ("hHVv\\u000b" | [scan("\\\\v")]), ("hHVv\\u000b" | [scan("\\\\V")]), ("hHVv" | [scan("[\\\\h\\\\H\\\\v\\\\V]+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["h"],["H"],["v"],["V"],["hHVv"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq control-character escape operators", async () => {
    const execution = await execute({
      filter:
        '[("\\u0007\\u001b ae" | [scan("\\\\a")]), ("\\u0007\\u001b ae" | [scan("\\\\e")]), ("\\u0007\\u001b ae" | [scan("[\\\\a\\\\e]+")]), ("\\u0007\\u001bX" | [scan("[^\\\\a]+")]), ("\\u0007\\u001bX" | [scan("[^\\\\e]+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["\\u0007"],["\\u001b"],["\\u0007\\u001b"],["\\u001bX"],["\\u0007","X"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq any-character operators", async () => {
    const execution = await execute({
      filter:
        '[("a\\n\\r\\u2028🙂" | [scan("\\\\N")]), ("a\\n\\r\\u2028🙂" | [scan("\\\\O")]), ("NOn\\n🙂" | [scan("[\\\\N]")]), ("NOn\\n🙂" | [scan("[\\\\O]")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["a","\\r","\u2028","🙂"],["a","\\n","\\r","\u2028","🙂"],["N"],["O"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq Unicode whitespace and newline operators", async () => {
    const execution = await execute({
      filter:
        '[("\\u0085\\ufeff " | [scan("\\\\s")]), ("\\u0085\\ufeff " | [scan("\\\\S")]), ("\\r\\n\\u0085\\u2028\\u2029x" | [scan("\\\\R")]), ("\\u0085x" | [scan("[\\\\s]+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["\u0085"," "],["\ufeff"],["\\r\\n","\u0085","\u2028","\u2029"],["\u0085"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("decodes jq non-braced hexadecimal escapes as raw UTF-8 bytes", async () => {
    const execution = await execute({
      filter:
        '[("é日🙂AB\\ufeff" | [scan("\\\\xc3\\\\xa9"), scan("\\\\xe6\\\\x97\\\\xa5"), scan("\\\\xf0\\\\x9f\\\\x99\\\\x82"), scan("[\\\\x41\\\\x42]+"), scan("\\\\xef\\\\xbb\\\\xbf")]), ("AéB" | test("^A\\\\xc3\\\\xa9B$")), ("é" | test("^[\\\\xc3\\\\xa9]$")), ("/" | test("^\\\\xc0\\\\xaf$")), ("x" | test("^\\\\xed\\\\xa0\\\\x80$")), ("x" | test("^\\\\xf4\\\\x90\\\\x80\\\\x80$")), ("x" | test("^\\\\xf5$")), ("x" | test("^[^\\\\xc0\\\\xaf]$"))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["é","日","🙂","AB","﻿"],true,true,false,false,false,false,true]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("rejects malformed jq raw hexadecimal byte sequences", async () => {
    for (const pattern of [
      String.raw`^\xc3$`,
      String.raw`^\xa9$`,
      String.raw`^\xc2\x41$`,
      String.raw`^[\x41-\xc0\xaf]$`,
      String.raw`^[\xfe-\x41]$`,
    ]) {
      const execution = await execute({
        filter: `test(${JSON.stringify(pattern)})`,
        stdinText: '"value"\n',
      });

      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toContain("jq: error:");
      expect(execution.result.exitCode).toBe(5);
    }
  });

  it("supports jq literal, position, and grapheme regex operators", async () => {
    const execution = await execute({
      filter:
        '[("CPgpqu" | [scan("\\\\C|\\\\P|\\\\g|\\\\p|\\\\q|\\\\u")]), ("x\\u0000\\u0004A" | [scan("\\\\x"), scan("(?:\\\\x)"), scan("\\\\x4"), scan("\\\\x41"), scan("\\\\x{41}"), scan("\\\\o{101}")]), (".^$*+?()[]{}|/" | test("\\\\Q.^$*+?()[]{}|/\\\\E")), ("a b#c" | test("\\\\Qa b#c\\\\E"; "x")), ("ab" | [match("\\\\G"; "g")]), ("abca" | [match("\\\\Ga"; "g")]), ("á👩‍💻क्ष" | [scan("\\\\X")]), ("á👩‍💻क्ष" | [scan("\\\\X+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["C","P","g","p","q","u"],["x","\\u0000","\\u0004","A","A","A"],true,true,[{"offset":0,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":2,"length":0,"string":"","captures":[]}],[{"offset":0,"length":1,"string":"a","captures":[]}],["á","👩‍💻","क्","ष"],["á👩‍💻क्ष"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses jq full Unicode case folding in local modifier scopes", async () => {
    const execution = await execute({
      filter:
        '[("ss" | test("(?i:ß)")), ("ß" | test("(?i:ss)")), ("ssss" | [scan("(?i:[ß]+)")]), ("ﬁ" | test("(?i:fi)")), ("fi" | test("(?i:ﬁ)")), ("ssß" | test("(?i:ß)(?-i:ß)")), ("ss" | test("(?-i:ß)"; "i")), ("ß" | test("(?ix:s # ignored\\n s)")), ("ı" | test("(?i:i)")), ("ssss" | test("(?i:(ß))\\\\g<1>")), ("ßß" | test("(ß)(?i:\\\\g<1>)")), ("ssss" | test("(?i:(ß))(?-i:\\\\g<1>)")), ("fifi" | test("(?i:(ﬁ))\\\\g<1>")), ("aA" | test("(?i:(a)\\\\1)")), ("ßss" | test("(?i:(ß)\\\\1)")), ("ssss" | test("(?i:(ss)\\\\1)")), ("ßss" | test("(?i:(?<x>ß)\\\\k<x>)"))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[true,true,["ssss"],true,true,true,false,true,false,true,true,true,true,true,false,true,false]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports nested local case-insensitive backreferences", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xaAy" | test("x(?i:(a)\\1)y")),
        ("xAAy" | match("x(?i:(a)\\1)y") | [.string, .captures[0].string]),
        ("aA" | test("(?<x>a)(?i:\\k<x>)")),
        ("aA" | test("(?i:(?<x>a))\\k<x>")),
        ("xaAy" | test("(?-i:x(?i:(a)\\1)y)")),
        ("xaAy" | test("(?i:x(a)(?-i:\\1)y)")),
        ("xaay" | test("(?i:x(a)(?-i:\\1)y)")),
        ("xßßy" | test("x(?i:(ß)\\1)y")),
        ("xßssy" | test("x(?i:(ß)\\1)y")),
        ("xssssy" | test("x(?i:(ß)\\1)y")),
        ("kK" | test("(?i:(k)\\1)")),
        ("kK" | test("(?i:(k)\\1)")),
        ("ßẞ" | test("(?i:(ß)\\1)")),
        ("βϐ" | test("(?i:(β)\\1)")),
        ("ΩΩ" | test("(?i:(Ω)\\1)")),
        ("ᲄᲅ" | test("(?i:(ᲄ)\\1)")),
        ("Тᲄ" | test("(?i:(Т)\\1)")),
        ("aA" | test("(?ix:(a) # ignored\n \\1)"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[true,["xAAy","A"],true,false,true,false,true,true,false,true,true,false,false,true,false,true,false,true]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("resolves longest recursive local case-folded backreferences without state explosion", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xXXb" |
          test("(?<p>x)(?<a>(?i:\\k<p>)\\g<a>|b)"; "l")),
        ("xyXYXYb" |
          match("(?<p>x)(?<q>y)(?<a>(?i:\\k<p>)(?i:\\k<q>)\\g<a>|b)"; "l") |
          .string),
        ("xXXb" |
          capture("(?<p>x)(?<a>(?i:\\k<p>)\\g<a>|b)"; "l"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[true,"xyXYXYb",{"p":"x","a":"XXb"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves fixed and variable case-folded backreference lengths", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("abAB" | test("(?<p>ab)(?i:\\k<p>)"; "l")),
        ("abab" | test("(?<p>(?:ab|cd))(?i:\\k<p>)"; "l")),
        ("cdCD" | test("(?<p>(?:ab|cd))(?i:\\k<p>)"; "l")),
        ("aaaAAA" | test("(?<p>a{3})(?i:\\k<p>)"; "l")),
        ("abABAB" | test("(?<p>ab)(?i:\\k<p>{2})"; "l")),
        ("aaAA" | test("(?<p>a+)(?i:\\k<p>)"; "l")),
        ("fifi" | test("(?i:(?<p>ﬁ)\\k<p>)"; "l")),
        ("abAB" | test("(?<p>[ab]{2})(?i:\\k<p>)"; "l")),
        ("abAX" | test("(?<p>ab)(?i:\\k<p>)"; "l"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      "[true,true,true,true,true,true,true,true,false]\n",
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("backtracks broad variable captures for case-folded backreferences", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("abAB" | test("(?<p>.+)(?i:\\k<p>)$"; "l")),
        ("abAB" | match("(?<p>\\N+)(?i:\\k<p>)$"; "l") |
          [.string, .captures[0].string]),
        ("abAB" | capture("(?<p>[^\\n]+)(?i:\\k<p>)$"; "l")),
        ("abAB" | test("(?<p>\\p{L}+)(?i:\\k<p>)$"; "l")),
        (" \t \t" | test("(?<p>\\s+)(?i:\\k<p>)$"; "l")),
        ("\u0085\u0085\u0085\u0085" |
          test("(?<p>\\R+)(?i:\\k<p>)$"; "l"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[true,["abAB","ab"],{"p":"ab"},true,true,true]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("does not treat open capture backreferences as empty matches", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xx" | test("((x)\\1)")),
        ("xx" | test("((x)\\2)")),
        ("xx" | test("(?<p>(x)\\k<p>)")),
        ("xx" | test("(?<p>(x)\\k<-2>)")),
        ("xx" | test("(?<p>(x)\\k<-1>)"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe("[false,true,false,false,true]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("matches case-folded backreferences at input and quantifier boundaries", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ẞß" | test("(?i:(.)\\1)")),
        ("ẞßy" | test("(?i:(.)\\1)")),
        ("ẞßß" | match("(?i:(.)\\1)") | .string),
        ("ẞßßy" | match("(?i:(.)\\1+)") | .string),
        ("aAAb" | [scan("(?i:(a)\\1?)")]),
        ("aa" | match("(?i:(a)\\1{0})") |
          [.offset, .length, .string, .captures[0].string]),
        ("aAAAb" | match("(?i:(a)\\1{1,3})") | .string),
        ("aAAAb" | match("(?i:(a)\\1{1,3}?)") | .string),
        ("a" | match("(?i:((?:a)?)\\1)") |
          [.offset, .length, .captures[0].string]),
        ("baA" | match("(?i:(a)?\\1)"; "l") |
          [.offset, .length, .string]),
        ("aAA" | [match("(?i:(a)\\1?)"; "gl")] |
          map([.offset, .length, .string])),
        ("aAAb" | [match("(?i:((?:a)?)\\1)"; "gl")] |
          map([.offset, .length, .string, .captures[0].string]))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[false,true,"ẞß","ẞßß",[["a"],["A"]],[0,1,"a","a"],"aAAA","aA",[0,0,""],[1,2,"aA"],[[0,2,"aA"],[2,1,"A"]],[[0,2,"aA","a"],[2,0,"",""],[3,0,"",""],[4,0,"",""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports nonrecursive jq regular expression subexpression calls", async () => {
    const execution = await execute({
      filter:
        '[("aa" | match("(a)\\\\g<1>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("ba" | match("(?<x>a|b)\\\\g<x>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("abab" | match("(a(b))\\\\g<1>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("abb" | match("(a(b))\\\\g<2>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("ba" | match("(a|b)\\\\g<-1>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("aa" | match("\\\\g<1>(a)") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("ababa" | match("(a|b)\\\\g<1>+") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("aa" | match("(?=(a)\\\\g<1>)aa") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("aababb" | match("(a)(\\\\g<1>b)\\\\g<2>") | [.string, [.captures[] | [.string,.offset,.length,.name]]])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aa",[["a",1,1,null]]],["ba",[["a",1,1,"x"]]],["abab",[["ab",2,2,null],["b",3,1,null]]],["abb",[["ab",0,2,null],["b",2,1,null]]],["ba",[["a",1,1,null]]],["aa",[["a",1,1,null]]],["ababa",[["a",4,1,null]]],["aa",[["a",1,1,null]]],["aabab",[["a",3,1,null],["ab",3,2,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("rejects zero-consumption recursive jq regular expression calls", async () => {
    const patterns = [
      String.raw`(?<a>\g<a>?a)`,
      String.raw`(?<a>(?:\g<a>)?a)`,
      String.raw`(?<a>\g<a>*a)`,
      String.raw`(?<a>\g<a>)`,
      String.raw`(?<a>a|\g<a>)`,
      String.raw`(?<a>\g<b>|a)(?<b>\g<a>|b)`,
      String.raw`(?<prefix>x?)(?<a>\k<prefix>\g<a>|b)`,
      String.raw`(x?)(?<a>\1\g<a>|b)`,
      String.raw`(x)(?<a>\k<-1>\g<a>|b)`,
    ];
    for (const pattern of patterns) {
      for (const flags of ["", "l"]) {
        const execution = await execute({
          filter: `match(${JSON.stringify(pattern)}; ${JSON.stringify(flags)})`,
          stdinText: '"a"\n',
        });

        expect(execution.stdout.text).toBe("");
        expect(execution.stderr.text).toBe(
          "jq: error (at <stdin>:1): Regex failure: never ending recursion\n",
        );
        expect(execution.result.exitCode).toBe(5);
      }
    }
  });

  it("preserves productive recursive jq regular expression calls", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aaab" | match("(?<a>a\\g<a>|b)") | .string),
        ("aaab" | match("(?<a>a\\g<a>?|b)") | .string),
        ("aaab" | match("(?<a>a\\g<a>*|b)") | .string),
        ("aaab" | match("(?<a>a\\g<a>{1}|b)") | .string),
        ("a" | match("(?<a>\\g<a>{0}a)") | .string),
        ("aab" | match("(?<a>\\g<b>|a)(?<b>a\\g<a>|b)") | .string),
        ("a" | match("(?<a>(?=a\\g<a>)a|a)") | .string),
        ("xxxb" | match("(?<prefix>x)(?<a>\\k<prefix>\\g<a>|b)") | .string),
        ("xxxb" | match("(x)(?<a>\\1\\g<a>|b)") | .string)
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe('["aaab","aaab","aaab","aaab","a","aab","a","xxxb","xxxb"]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("bounds expanded jq subexpression call backtracking", async () => {
    const makeAcyclicChain = (length: number): string =>
      Array.from({ length }, (_, index) =>
        index === length - 1
          ? `(?<g${index}>a)`
          : `(?<g${index}>\\g<g${index + 1}>|a)`,
      ).join("");
    const makeProductiveCycle = (length: number): string =>
      Array.from({ length }, (_, index) => {
        const next = (index + 1) % length;
        return `(?<g${index}>${index === length - 1 ? "a" : ""}\\g<g${next}>|a)`;
      }).join("");

    const safeLongest = await execute({
      filter: `test(${JSON.stringify(makeAcyclicChain(10))}; "l")`,
      stdinText: `${JSON.stringify("a".repeat(10))}\n`,
    });
    const retryLimitedLongest = await execute({
      filter: `test(${JSON.stringify(makeAcyclicChain(11))}; "l")`,
      stdinText: `${JSON.stringify("a".repeat(11))}\n`,
    });
    const safeExpanded = await execute({
      filter: `test(${JSON.stringify(makeAcyclicChain(12))})`,
      stdinText: `${JSON.stringify("a".repeat(12))}\n`,
    });
    const safetyLimitedExpanded = await execute({
      filter: `test(${JSON.stringify(makeAcyclicChain(13))})`,
      stdinText: `${JSON.stringify("a".repeat(13))}\n`,
    });
    const safeRecursiveLongest = await execute({
      filter: `test(${JSON.stringify(makeProductiveCycle(7))}; "l")`,
      stdinText: `${JSON.stringify("a".repeat(7))}\n`,
    });
    const retryLimitedRecursiveLongest = await execute({
      filter: `test(${JSON.stringify(makeProductiveCycle(8))}; "l")`,
      stdinText: `${JSON.stringify("a".repeat(8))}\n`,
    });

    for (const execution of [safeLongest, safeExpanded, safeRecursiveLongest]) {
      expect(execution.stdout.text).toBe("true\n");
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    for (const execution of [
      retryLimitedLongest,
      retryLimitedRecursiveLongest,
    ]) {
      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toBe(
        "jq: error (at <stdin>:1): Regex failure: retry-limit-in-match over\n",
      );
      expect(execution.result.exitCode).toBe(5);
    }
    expect(safetyLimitedExpanded.stdout.text).toBe("");
    expect(safetyLimitedExpanded.stderr.text).toContain(
      "regular expression subexpression expansion exceeds the safe " +
        "backtracking limit",
    );
    expect(safetyLimitedExpanded.result.exitCode).toBe(5);
  });

  it("rejects forward named backreferences without rejecting forward calls", async () => {
    for (const pattern of [
      String.raw`\k<x>(?<x>x)`,
      String.raw`(?<a>\k<prefix>\g<a>|b)(?<prefix>x)`,
    ]) {
      const execution = await execute({
        filter: `test(${JSON.stringify(pattern)})`,
        stdinText: '"x"\n',
      });

      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toBe(
        "jq: error (at <stdin>:1): Regex failure: undefined name <" +
          (pattern.includes("prefix") ? "prefix" : "x") + "> reference\n",
      );
      expect(execution.result.exitCode).toBe(5);
    }

    const controls = await execute({
      filter: String.raw`[("x" | test("\\1(x)")), ("x" | test("\\g<x>(?<x>x)"))]`,
      stdinText: "null\n",
    });
    expect(controls.stdout.text).toBe("[false,false]\n");
    expect(controls.stderr.text).toBe("");
    expect(controls.result.exitCode).toBe(0);
  });

  it("reports multiplex named subexpression calls as jq runtime errors", async () => {
    const execution = await execute({
      filter: 'match("(?<x>a)(?<x>b)\\\\g<x>")',
      stdinText: '"abb"\n',
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain(
      "multiplex definition name <x> call",
    );
    expect(execution.result.exitCode).toBe(5);
  });

  it("preserves jq backreference state across subexpression calls", async () => {
    const execution = await execute({
      filter:
        '[("aaa" | match("(a)\\\\1\\\\g<1>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("aaa" | match("(a)\\\\g<1>\\\\1") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("a" | [match("(a)?\\\\1\\\\g<1>")]), ("aaba" | match("(a)(?:\\\\g<1>b|\\\\g<1>c)\\\\1") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("aaca" | match("(a)(?:\\\\g<1>b|\\\\g<1>c)\\\\1") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("ababa" | match("(a)(b\\\\1)\\\\g<2>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("abcdefghijjj" | match("(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\\\10\\\\g<10>") | [.string, [.captures[] | [.string,.offset,.length,.name]]]), ("a\\ba" | match("(a)\\\\10\\\\g<1>") | [.string, [.captures[] | [.string,.offset,.length,.name]]])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aaa",[["a",2,1,null]]],["aaa",[["a",1,1,null]]],[],["aaba",[["a",1,1,null]]],["aaca",[["a",1,1,null]]],["ababa",[["a",0,1,null],["ba",3,2,null]]],["abcdefghijjj",[["a",0,1,null],["b",1,1,null],["c",2,1,null],["d",3,1,null],["e",4,1,null],["f",5,1,null],["g",6,1,null],["h",7,1,null],["i",8,1,null],["j",11,1,null]]],["a\\ba",[["a",2,1,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("keeps overlapping empty backreference matches in global longest mode", async () => {
    const execution = await execute({
      filter:
        '[("aaa" | [match("(a?)\\\\1\\\\g<1>\\\\1"; "gl")] | map([.offset,.length,.captures[0].offset,.captures[0].length])), ("aaaa" | [match("((a?)\\\\2)\\\\g<1>\\\\2"; "gl")] | map([.offset,.length,.captures[0].offset,.captures[1].offset])), ("aa" | [match("(?i:((?:a)?)\\\\1)"; "gl")] | map([.offset,.length,.captures[0].offset,.captures[0].length])), ("aa" | [scan("(?i:((?:a)?)\\\\1)"; "l")]), ("aa" | gsub("(?i:((?:a)?)\\\\1)"; "X"; "l"))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,2,2,0],[2,0,2,0],[3,0,3,0]],[[0,3,0,0],[3,0,3,3],[4,0,4,4]],[[0,2,0,1],[2,0,2,0]],[["a"],[""]],"XX"]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("projects absent captures as empty only for empty whole matches", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("" | match("(?:|(a))") | [.string, [.captures[] | [.string,.offset,.length]]]),
        ("x" | match("(?:x|(a))?") | [.string, [.captures[] | [.string,.offset,.length]]]),
        ("" | match("(?:(a)|(b)|)") | [.string, [.captures[] | [.string,.offset,.length]]]),
        ("b" | match("(?:(a)|(b)|)") | [.string, [.captures[] | [.string,.offset,.length]]]),
        ("ab" | [match("(?:|(a)(b))"; "g")] | map([.offset,.length,[.captures[] | [.string,.offset,.length]]])),
        ("ab" | [match("(?:|(a)(b))"; "gn")]),
        ("a" | [match("(?:|((?:|a)))"; "n")] | map([.string,.captures[0].string]))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["",[["",0,0]]],["x",[[null,-1,0]]],["",[["",0,0],["",0,0]]],["b",[[null,-1,0],["b",0,1]]],[[0,0,[["",0,0],["",0,0]]],[1,0,[["",1,0],["",1,0]]],[2,0,[["",2,0],["",2,0]]]],[{"offset":0,"length":2,"string":"ab","captures":[{"offset":0,"length":1,"string":"a","name":null},{"offset":1,"length":1,"string":"b","name":null}]}],[["a","a"]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves repeated capture history across bounded and common unbounded repetitions", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aab" | match("(?:(a)\\1|b){1,3}") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("aabb" | match("(?:(a)\\1|b)*") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("baab" | match("(?:(a)\\1|b)+") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("abaabb" | match("(a)(b)(?:\\g<1>\\1|\\g<2>\\2){1,3}") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("abcd" | match("(?:(a(?:b(c))?)|d){1,3}") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("bbbbaab" | match("(?:(?<x>a)\\k<x>|b)*") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("bbbbbbbbbbbbbbbab" | match("(?:(?<x>a)|b)*") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("baaccb" | match("(?:(?<x>a)\\k<x>(?<y>c)\\k<y>|b)*") | [.string,[.captures[]|[.string,.offset,.length]]]),
        ("aaccddb" | match("(?:(?<x>a)\\k<x>(?<y>c)\\k<y>(?<z>d)\\k<z>|b)*") | [.string,[.captures[]|[.string,.offset,.length]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aab",[["a",0,1]]],["aabb",[["a",0,1]]],["baab",[["a",1,1]]],["abaabb",[["a",2,1],["b",4,1]]],["abcd",[["abc",0,3],["c",2,1]]],["bbbbaab",[["a",4,1]]],["bbbbbbbbbbbbbbbab",[["a",15,1]]],["baaccb",[["a",1,1],["c",3,1]]],["aaccddb",[["a",0,1],["c",2,1],["d",4,1]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves required simple capture history through short nullable repetitions", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aaa" | match("(?:(a)?\\1|b)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aaa" | [scan("(?:(a)?\\1|b)*")]),
        ("xaa" | match("(?:(?:x(a)?)?\\1|b)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aaa" | match("(?:(?<x>a)?\\1|b)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aaa" | match("(?:(?<x>a)?\\k<x>|b)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aaa" | [scan("(?:(?<x>a)?\\k<x>|b)*")]),
        ("AaxK" | match("(?:(?<x>a)?\\k<x>|b)*"; "i") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xaa" | match("(?:(?:x(?<x>a)?)?\\k<x>|b)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xAax" | match("(?:(?:x(?<x>a)?)?\\k<x>|b)*"; "i") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aac" | match("(?:(a|b)?\\1|c)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aac" | capture("(?:(?<x>a|b)?\\k<x>|c)*")),
        ("xaac" | match("(?:(?:x(a|b)?)?\\1|c)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xaac" | capture("(?:(?:x(?<x>a|b)?)?\\k<x>|c)*")),
        ("xAa" | match("(?:(a|A)?\\1|b)*"; "i") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xAa" | match("(?:(a|A)?\\1|b)*"; "il") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xAa" | [match("(?:(a|A)?\\1|b)*"; "ig")] |
          map([.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]])),
        ("xAa" | match("(?:(?<x>a|A)?\\k<x>|b)*"; "i") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xAax" | [scan("(?:(a|A)?\\1|b)*"; "ig")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,3,"aaa",[["a",0,1,null]]],[["a"],[""]],[0,3,"xaa",[["a",1,1,null]]],[0,3,"aaa",[["a",0,1,"x"]]],[0,3,"aaa",[["a",0,1,"x"]]],[["a"],[""]],[0,2,"Aa",[["A",0,1,"x"]]],[0,3,"xaa",[["a",1,1,"x"]]],[0,3,"xAa",[["A",1,1,"x"]]],[0,3,"aac",[["a",0,1,null]]],{"x":"a"},[0,4,"xaac",[["a",1,1,null]]],{"x":"a"},[0,0,"",[["",0,0,null]]],[1,2,"Aa",[["A",1,1,null]]],[[0,0,"",[["",0,0,null]]],[1,2,"Aa",[["A",1,1,null]]],[3,0,"",[["",3,0,null]]]],[0,0,"",[["",0,0,"x"]]],[[""],["A"],[""],[""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves two-code-point prefixes in bounded capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xyaa" | match("(?:(?:xy(a)?)?\\1|c)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyaa" | capture("(?:(?:xy(?<v>a)?)?\\k<v>|c)*")),
        ("xybb" | match("(?:(?:xy(a|b)?)?\\1|c)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyAa" | capture("(?:(?:xy(?<v>a|b)?)?\\k<v>|c)*"; "i"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,4,"xyaa",[["a",2,1,null]]],{"v":"a"},[0,4,"xybb",[["b",2,1,null]]],{"v":"A"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves short multi-code-point capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ababx" | match("(?:(ab|c)?\\1|x)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("ababx" | capture("(?:(?<v>ab|c)?\\k<v>|x)*")),
        ("xAbAB" | match("(?:(?:x(ab|c)?)?\\1|y)*"; "i") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xAbAB" | capture("(?:(?:x(?<v>ab|c)?)?\\k<v>|y)*"; "i"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,5,"ababx",[["ab",0,2,null]]],{"v":"ab"},[0,5,"xAbAB",[["Ab",1,2,null]]],{"v":"Ab"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves three-way single-code-point capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aabbcc" | match("(?:(a|b|c)?\\1|d)*") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aabbcc" | capture("(?:(?<v>a|b|c)?\\k<v>|d)*")),
        ("xAad" | match("(?:(?:x(a|b|c)?)?\\1|d)*"; "i") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xAad" | capture("(?:(?:x(?<v>a|b|c)?)?\\k<v>|d)*"; "i"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,6,"aabbcc",[["c",4,1,null]]],{"v":"c"},[0,4,"xAad",[["A",1,1,null]]],{"v":"A"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("resolves bounded non-longest history rejections without state explosion", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xyaab" | [match("(?:(\\||a)?\\1|b)*"; "ig")] |
          map([.offset,.length,.string,.captures[0].string])),
        ("xyaab" | [match("(?:(?:x(\\||a)?)?\\1|b)*"; "ig")] |
          map([.offset,.length,.string,.captures[0].string])),
        ("😀" | [match("(?:(?<v>[a|b]|c)?\\k<v>|x)*"; "ig")] |
          map([.offset,.length,.string,.captures[0].string])),
        ("😀" | [match("(?:(?:[xy](?<v>[a|b]|c)?)?\\k<v>|x)*"; "ig")] |
          map([.offset,.length,.string,.captures[0].string]))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,0,"",""],[1,0,"",""],[2,3,"aab","a"],[5,0,"",""]],[[0,0,"",""],[1,0,"",""],[2,0,"",""],[3,0,"",""],[4,1,"b",null],[5,0,"",""]],[[0,0,"",""],[1,0,"",""],[1,0,"",""],[1,0,"",""],[1,0,"",""]],[[0,0,"",""],[1,0,"",""],[1,0,"",""],[1,0,"",""],[1,0,"",""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("resolves the earliest invalid case-folded history branch before later repetitions", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("KKaXB" | [match("(?:(k|K)?\\1|x)*"; "ig")] |
          map([.offset,.length,.string,.captures[0].string])),
        ("KKaXB" | [scan("(?:(?<v>k|K)?\\k<v>|x)*"; "ig")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,2,"KK","K"],[2,0,"",""],[3,1,"X",null],[4,0,"",""],[5,0,"",""]],[["K"],[""],[null],[""],[""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves longest global history and UTF-8 empty continuation", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xAaß" | [match("(?:(a|A)?\\1|b)*"; "igl")] |
          map([.offset,.length,.string,.captures[0].string])),
        ("😀" | [match("(?:(a|A)?\\1|b)*"; "ig")] |
          map([.offset,.length])),
        ("xAa😀" | [scan("(?:(a|A)?\\1|b)*"; "igl")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[1,2,"Aa","A"],[3,0,"",""],[4,0,"",""],[4,0,"",""]],[[0,0],[1,0],[1,0],[1,0],[1,0]],[["A"],[""],[""],[""],[""],[""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves three-code-point captures and prefixes in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("abcabc" | match("(?:(abc|d)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("AbCaBC" | match("(?:(abc|d)?\\1|x)*"; "i") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("abcabc" | capture("(?:(?<v>abc|d)?\\k<v>|x)*")),
        ("ydd" | match("(?:(?:y(abc|d)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyzaac" | match("(?:(?:xyz(a|b)?)?\\1|c)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyzAAc" | match("(?:(?:xyz(?<v>a|b)?)?\\k<v>|c)*"; "i") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyzdd" | match("(?:(?:xyz(abc|d)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyzDD" | capture(
          "(?:(?:xyz(?<v>abc|d)?)?\\k<v>|x)*";
          "i"
        ))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["abcabc",[["abc",0,3,null]]],["AbCaBC",[["AbC",0,3,null]]],{"v":"abc"},["ydd",[["d",1,1,null]]],["xyzaac",[["a",3,1,null]]],["xyzAAc",[["A",3,1,"v"]]],["xyzdd",[["d",3,1,null]]],{"v":"D"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves four-code-point capture and prefix eligibility in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ee" | match("(?:(abcd|e)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("EE" | match("(?:(abcd|e)?\\1|x)*"; "i") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("ee" | capture("(?:(?<v>abcd|e)?\\k<v>|x)*")),
        ("wxyzaa" | match("(?:(?:wxyz(a|b)?)?\\1|c)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("wxyzAA" | capture(
          "(?:(?:wxyz(?<v>a|b)?)?\\k<v>|c)*";
          "i"
        )),
        ("wxyzbb" | match("(?:(?:wxyz(abcd|b)?)?\\1|c)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["ee",[["e",0,1,null]]],["EE",[["E",0,1,null]]],{"v":"e"},["wxyzaa",[["a",4,1,null]]],{"v":"A"},["wxyzbb",[["b",4,1,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves five-code-point capture and prefix eligibility in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ff" | match("(?:(abcde|f)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("FF" | match("(?:(abcde|f)?\\1|x)*"; "i") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("ff" | capture("(?:(?<v>abcde|f)?\\k<v>|x)*")),
        ("vwxyzff" | match("(?:(?:vwxyz(a|f)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("vwxyzFF" | capture(
          "(?:(?:vwxyz(?<v>a|f)?)?\\k<v>|x)*";
          "i"
        )),
        ("vwxyzff" | match("(?:(?:vwxyz(abcde|f)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["ff",[["f",0,1,null]]],["FF",[["F",0,1,null]]],{"v":"f"},["vwxyzff",[["f",5,1,null]]],{"v":"F"},["vwxyzff",[["f",5,1,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves six-code-point capture and prefix eligibility in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("gg" | match("(?:(abcdef|g)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("GG" | match("(?:(abcdef|g)?\\1|x)*"; "i") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("gg" | capture("(?:(?<v>abcdef|g)?\\k<v>|x)*")),
        ("uvwxyzgg" | match("(?:(?:uvwxyz(a|g)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("uvwxyzGG" | capture(
          "(?:(?:uvwxyz(?<v>a|g)?)?\\k<v>|x)*";
          "i"
        )),
        ("uvwxyzgg" | match("(?:(?:uvwxyz(abcdef|g)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["gg",[["g",0,1,null]]],["GG",[["G",0,1,null]]],{"v":"g"},["uvwxyzgg",[["g",6,1,null]]],{"v":"G"},["uvwxyzgg",[["g",6,1,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves four-alternative capture eligibility in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("dd" | match("(?:(a|b|c|d)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("DD" | capture("(?:(?<v>a|b|c|d)?\\k<v>|x)*"; "i")),
        ("xydd" | match("(?:(?:xy(a|b|c|d)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyDD" | capture(
          "(?:(?:xy(?<v>a|b|c|d)?)?\\k<v>|x)*";
          "i"
        )),
        ("ee" | match("(?:(ab|c|d|e)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("EE" | capture("(?:(?<v>ab|c|d|e)?\\k<v>|x)*"; "i"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["dd",[["d",0,1,null]]],{"v":"D"},["xydd",[["d",2,1,null]]],{"v":"D"},["ee",[["e",0,1,null]]],{"v":"E"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves five-alternative capture eligibility in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ee" | match("(?:(a|b|c|d|e)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("EE" | capture("(?:(?<v>a|b|c|d|e)?\\k<v>|x)*"; "i")),
        ("xyee" | match("(?:(?:xy(a|b|c|d|e)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyEE" | capture(
          "(?:(?:xy(?<v>a|b|c|d|e)?)?\\k<v>|x)*";
          "i"
        )),
        ("ff" | match("(?:(ab|c|d|e|f)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("FF" | capture("(?:(?<v>ab|c|d|e|f)?\\k<v>|x)*"; "i"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["ee",[["e",0,1,null]]],{"v":"E"},["xyee",[["e",2,1,null]]],{"v":"E"},["ff",[["f",0,1,null]]],{"v":"F"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves six-alternative capture eligibility in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ff" | match("(?:(a|b|c|d|e|f)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("FF" | capture("(?:(?<v>a|b|c|d|e|f)?\\k<v>|x)*"; "i")),
        ("xyff" | match("(?:(?:xy(a|b|c|d|e|f)?)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xyFF" | capture(
          "(?:(?:xy(?<v>a|b|c|d|e|f)?)?\\k<v>|x)*";
          "i"
        )),
        ("gg" | match("(?:(ab|c|d|e|f|g)?\\1|x)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("GG" | capture("(?:(?<v>ab|c|d|e|f|g)?\\k<v>|x)*"; "i"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["ff",[["f",0,1,null]]],{"v":"F"},["xyff",[["f",2,1,null]]],{"v":"F"},["gg",[["g",0,1,null]]],{"v":"G"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves token-budgeted capture alternatives in bounded history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("gg" | match("(?:(a|b|c|d|e|f|g)?\\1|~)*") |
          [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("GG" | capture(
          "(?:(?<v>a|b|c|d|e|f|g)?\\k<v>|~)*";
          "i"
        )),
        ("nnnn" | match(
          "(?:(aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn)?\\1|~)*"
        ) | [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("nnnn" | capture(
          "(?:(?<v>aa|bb|cc|dd|ee|ff|gg|hh|ii|jj|kk|ll|mm|nn)?" +
          "\\k<v>|~)*"
        )),
        ("xuu" | match(
          "(?:(?:x(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u)?)?" +
          "\\1|~)*"
        ) | [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xUU" | capture(
          "(?:(?:x(?<v>a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u)?)?" +
          "\\k<v>|~)*";
          "i"
        )),
        ("jjjjjj" | match(
          "(?:(aaa|bbb|ccc|ddd|eee|fff|ggg|hhh|iii|jjj)?\\1|~)*"
        ) | [.string,[.captures[]|[.string,.offset,.length,.name]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["gg",[["g",0,1,null]]],{"v":"G"},["nnnn",[["nn",0,2,null]]],{"v":"nn"},["xuu",[["u",1,1,null]]],{"v":"U"},["jjjjjj",[["jjj",0,3,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves variable-width Unicode full-fold capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ﬀ" | [scan("(?:(aa|ff)?\\1|~)*"; "i")] | length),
        ("ß" | [capture("(?:(?<v>aa|ss)?\\k<v>|~)*"; "ig")] | length),
        ("ﬁ" | [scan("(?:(aa|fi)?\\1|~)*"; "i")] | length),
        ("ﬃ" | [scan("(?:(aaa|ffi)?\\1|~)*"; "i")] | length),
        ("ﬀaaAA" | [match("(?:(aa|ff)?\\1|~)*"; "ig") |
          [.offset,.length,.string,.captures[0].string]]),
        ("ﬀaaaa" | match("(?:(?:ff(aa|bb)?)?\\1|~)*"; "i") |
          [.string,.captures[0].string,.captures[0].offset,.captures[0].length])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[4,3,4,4,[[0,0,"",""],[1,0,"",""],[1,0,"",""],[1,4,"aaAA","aa"],[5,0,"",""]],["ﬀaaaa","aa",1,2]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves nonuniform seven-code-point singleton required capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aaaaaab" | match("(?:(a)?\\1|b)*") |
          [.string,.captures[0].string,.captures[0].offset,.captures[0].length]),
        ("aaaaaab" | match("(?:(a)?\\1|b)*"; "l") |
          [.string,.captures[0].string,.captures[0].offset,.captures[0].length]),
        ("||||||x" | match("(?:(\\|)?\\1|x)*") |
          [.string,.captures[0].string,.captures[0].offset,.captures[0].length]),
        ("😀😀😀😀😀😀x" | match("(?:(😀)?\\1|x)*"; "l") |
          [.string,.captures[0].string,.captures[0].offset,.captures[0].length])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aaaaaab","a",4,1],["aaaaaab","a",4,1],["||||||x","|",4,1],["😀😀😀😀😀😀x","😀",4,1]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves uniform seven-code-point capture history in guarded runtime modes", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aaaaaaa" | match("(?:(a|b)?\\1|~)*") |
          [.string,.captures[0].string]),
        ("aaaaaaa" | match("(?:(a|b)?\\1|~)*"; "i") |
          [.string,.captures[0].string]),
        ("bbbbbbb" | [match("(?:(a|b)?\\1|~)*"; "g") |
          [.string,.captures[0].string]]),
        ("😀😀😀😀😀😀😀" | match("(?:(😀|🙂)?\\1|~)*") |
          [.string,.captures[0].string])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aaaaaaa","a"],["aaaaaaa","a"],[["bbbbbbb","b"],["",""]],["😀😀😀😀😀😀😀","😀"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves older case-folded capture history across a newer nullable repetition", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("KaAa1K" | [
          match("(?:(\\||a|b)?\\1|c)*"; "ig") |
          select(.length > 0) |
          [.string,.captures[0].string]
        ]),
        ("KaAa1K" | [
          match("(?:(?<v>[a|b]|c|x)?\\k<v>|y)*"; "ig") |
          select(.length > 0) |
          [.string,.captures[0].string]
        ]),
        ("KaAa1K" | [scan("(?:(\\||a|b)?\\1|c)*"; "i")] |
          map(select(any(.[]; length > 0)))),
        ("KaAa1K" | [capture(
          "(?:(?<v>[a|b]|c|x)?\\k<v>|y)*";
          "ig"
        ) | select(.v != "")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[["aAa","a"]],[["aAa","a"]],[["a"]],[{"v":"a"}]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves measured positive variable quantified capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aAa" | match("(?:(a)?\\1+?|b)*"; "i") |
          [.offset,.length,.string,.captures[0].string]),
        ("KaAa1K" | [
          match("(?:(a)?\\1+|b)*"; "ig") |
          [.offset,.length,.string,.captures[0].string]
        ]),
        ("KaAa1K" | [
          capture("(?:(?<v>a)?\\k<v>{1,2}|b)*"; "ig")
        ]),
        ("aAa" | [scan("(?:(a)?\\1+?|b)*"; "i")]),
        ("zAaA" | match("(?:(?:z(a)?)?\\1+|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,3,"aAa","a"],[[0,0,"",""],[1,0,"",""],[1,0,"",""],[1,3,"aAa","a"],[4,0,"",""],[5,0,"",""],[6,0,"",""],[6,0,"",""],[6,0,"",""]],[{"v":""},{"v":""},{"v":""},{"v":"a"},{"v":""},{"v":""},{"v":""},{"v":""},{"v":""}],[[' +
        '"a"],[""]],[0,4,"zAaA","A"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves measured positive variable full-fold capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("bßssb" | match("(?:(ß)?\\1+|b)*"; "i") |
          [.offset,.length,.string,.captures[0].string]),
        ("ﬀffﬀ" | capture("(?:(?<v>ﬀ)?\\k<v>{1,2}|b)*"; "il")),
        ("İi̇İ" | match("(?:(İ)?\\1{1,3}|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string]),
        ("ΣσςΣ" | [
          match("(?:(Σ)?\\1+|b)*"; "igl") |
          [.offset,.length,.string,.captures[0].string]
        ])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,1,"b",null],{"v":""},[0,0,"",""],[[0,4,"ΣσςΣ","Σ"],[4,0,"",""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves measured minimum-two variable quantified capture history", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aaaaa" | match("(?:(a)?\\1{2,3}+|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string]),
        ("aaaaab" | match("(?:([abcdef])?\\1{2,3}+|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string]),
        ("aaaaab" | [
          match("(?:(a)?\\1{2,3}+|b)*"; "igl") |
          [.offset,.length,.string,.captures[0].string]
        ]),
        ("aaaaab" | match("(?:(a)?\\1{2,3}|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string]),
        ("aaaaab" | match("(?:(a)?\\1{2,3}?|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string]),
        ("aaaaab" | capture("(?:(?<v>a)?\\k<v>{2,}|b)*"; "il")),
        ("aaaaab" | [scan("(?:(a)?\\1{2,3}+|b)*"; "il")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,4,"aaaa","a"],[1,5,"aaaab","a"],[[1,5,"aaaab","a"],[6,0,"",""]],[0,6,"aaaaab","a"],[0,6,"aaaaab","a"],{"v":"a"},[["a"],[""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves measured zero-minimum quantified capture history in longest mode", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("ab" | match("(?:(a)?\\1?|b)*"; "l") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("ab" | [
          match("(?:(a)?\\1?|b)*"; "gl") |
          [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]
        ]),
        ("ab" | match("(?:(a)?\\1?|b)*"; "il") |
          [.offset,.length,.string,.captures[0].string]),
        ("aab" | [
          match("(?:(a)?\\1*?|b)*"; "igl") |
          [.offset,.length,.string,.captures[0].string]
        ]),
        ("ßssß" | [
          match("(?:(ß)?\\1{0,2}?|b)*"; "igl") |
          [.offset,.length,.string,.captures[0].string]
        ]),
        ("😀b" | capture("(?:(?<v>😀)?\\k<v>*|b)*"; "il")),
        ("aab" | [scan("(?:(a)?\\1?|b)*"; "il")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,2,"ab",[["a",0,1,null]]],[[0,2,"ab",[["a",0,1,null]]],[2,0,"",[["",2,0,null]]]],[0,2,"ab","a"],[[0,3,"aab","a"],[3,0,"",""]],[[0,4,"ßssß","ß"],[4,0,"",""]],{"v":"😀"},[["a"],[""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves ordinary optional capture history behind a whole-match guard", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aabx" | match("(?:(a)?\\1?|b)*x") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]),
        ("aabx" | [
          match("(?:(a)?\\1?|b)*x"; "g") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]
        ])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,4,"aabx",[[null,"a",0,1]]],[[0,4,"aabx",[[null,"a",0,1]]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("stops terminal optional capture-history repetition before sibling alternatives", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("b" | match("(?:(a)?\\1?|(b))*") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]),
        ("ab" | match("(?:(a)?\\1?|(b))*") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]),
        ("xb" | match("x(?:(?<v>a)?\\k<v>?|b)*") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]),
        ("xb" | match("(?:y|x(?:(a)?\\1?|b)*)") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,0,"",[[null,"",0,0],[null,"",0,0]]],[0,1,"a",[[null,"a",0,1],[null,null,-1,0]]],[0,1,"x",[["v",null,-1,0]]],[0,1,"x",[[null,null,-1,0]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves bounded terminal capture history across external backreferences", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("xcxaxx" | [
          match("(?<v>x)?(?:(a)?\\1?|(?<v>b))*"; "g") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]
        ]),
        ("xaxx" | match("(x)?(?:(a)?\\1?|b)*") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]),
        ("xcxaxx" | [
          match("(x)?(y)?(?:(a)?\\1?|b)*"; "g") |
          [.offset,.length,.string,[.captures[]|[.name,.string,.offset,.length]]]
        ])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,1,"x",[["v","x",0,1],[null,null,-1,0],["v",null,-1,0]]],[1,0,"",[["v","",1,0],[null,"",1,0],["v","",1,0]]],[2,4,"xaxx",[["v","x",2,1],[null,"a",3,1],["v",null,-1,0]]],[6,0,"",[["v","",6,0],[null,"",6,0],["v","",6,0]]]],[0,4,"xaxx",[[null,"x",0,1],[null,"a",1,1]]],[[0,1,"x",[[null,"x",0,1],[null,null,-1,0],[null,null,-1,0]]],[1,0,"",[[null,"",1,0],[null,"",1,0],[null,"",1,0]]],[2,4,"xaxx",[[null,"x",2,1],[null,null,-1,0],[null,"a",3,1]]],[6,0,"",[[null,"",6,0],[null,"",6,0],[null,"",6,0]]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("keeps longest capture-history replay scoped at the bounded input boundary", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("1xAaya😀" | capture("(?:(\\||a)?\\1|b)*"; "igl")),
        ("1xAaya😀" | capture("(?:(?<v>[a|b]|c)?\\k<v>|x)*"; "il")),
        ("1xAaya😀" | capture("(?:(?:[xy](?<v>[a|b]|c)?)?\\k<v>|x)*"; "il"))
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[{},{},{},{},{},{},{},{},{"v":"A"},{"v":"A"}]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves marker-free capture history beyond the static prefix on bounded inputs", async () => {
    const input = `${"a".repeat(256)}b`;
    const execution = await execute({
      filter: `[
        (${JSON.stringify(input)} | match("(?:(a)|b)*") | [.offset,.length,[.captures[]|[.offset,.length,.string,.name]]]),
        (${JSON.stringify(input)} | match("(?:(a)|b)*"; "l") | [.offset,.length,[.captures[]|[.offset,.length,.string,.name]]]),
        (${JSON.stringify(input)} | capture("(?:(?<v>a)|b)*")),
        (${JSON.stringify(input)} | [scan("(?:(a)|b)*")])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,257,[[255,1,"a",null]]],[0,257,[[255,1,"a",null]]],{"v":"a"},[["a"],[""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves capture history for repeated non-empty subexpression calls", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("aaaab" | match("(?<unit>(a)\\2)(?:\\g<unit>|b)*") | [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("aaccaaccb" | match("(?<unit>(a)\\2(c)\\3)(?:\\g<unit>|b)*"; "l") | [.string,[.captures[]|[.string,.offset,.length,.name]]]),
        ("xxyxyz" | match("(?<a>x)(?<b>\\g<a>y)(?:\\g<b>|z)*") | [.string,[.captures[]|[.string,.offset,.length,.name]]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aaaab",[["aa",2,2,"unit"],["a",2,1,null]]],["aaccaaccb",[["aacc",4,4,"unit"],["a",4,1,null],["c",6,1,null]]],["xxyxyz",[["x",3,1,"a"],["xy",3,2,"b"]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves expanded capture history within the bounded linear window", async () => {
    const oneMarkerPattern = String.raw`(?<unit>(a)\2)(?:\g<unit>|b)*`;
    const twoMarkerPattern = String.raw`(?<unit>(a)\2(c)\3)(?:\g<unit>|b)*`;
    const ordinaryOneMarkerInput = `${"aa".repeat(33)}b`;
    const longestOneMarkerInput = `${"aa".repeat(13)}b`;
    const ordinaryTwoMarkerInput = `${"aacc".repeat(17)}b`;
    const captureProjection =
      `[.string,[.captures[]|[.string,.offset,.length,.name]]]`;
    const execution = await execute({
      filter: `[
        (${JSON.stringify(ordinaryOneMarkerInput)} | match(${JSON.stringify(oneMarkerPattern)}) | ${captureProjection}),
        (${JSON.stringify(longestOneMarkerInput)} | match(${JSON.stringify(oneMarkerPattern)}; "l") | ${captureProjection}),
        (${JSON.stringify(ordinaryTwoMarkerInput)} | match(${JSON.stringify(twoMarkerPattern)}) | ${captureProjection})
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",[["aa",64,2,"unit"],["a",64,1,null]]],["aaaaaaaaaaaaaaaaaaaaaaaaaab",[["aa",24,2,"unit"],["a",24,1,null]]],["aaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccb",[["aacc",64,4,"unit"],["a",64,1,null],["c",66,1,null]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves capture history across the expanded linear runtime-marker budget", async () => {
    const oneMarkerPattern = String.raw`(?<unit>(a)\2)(?:\g<unit>|b)*`;
    const twoMarkerPattern = String.raw`(?<unit>(a)\2(c)\3)(?:\g<unit>|b)*`;
    const ordinaryOneMarkerInput = `${"aa".repeat(65)}b`;
    const longestOneMarkerInput = `${"aa".repeat(25)}b`;
    const ordinaryTwoMarkerInput = `${"aacc".repeat(33)}b`;
    const longestTwoMarkerInput = `${"aacc".repeat(13)}b`;
    const execution = await execute({
      filter: `[
        (${JSON.stringify(ordinaryOneMarkerInput)} | match(${JSON.stringify(oneMarkerPattern)}) | [.captures[].offset]),
        (${JSON.stringify(longestOneMarkerInput)} | match(${JSON.stringify(oneMarkerPattern)}; "l") | [.captures[].offset]),
        (${JSON.stringify(ordinaryTwoMarkerInput)} | match(${JSON.stringify(twoMarkerPattern)}) | [.captures[].offset]),
        (${JSON.stringify(longestTwoMarkerInput)} | match(${JSON.stringify(twoMarkerPattern)}; "l") | [.captures[].offset])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      "[[128,128],[48,48],[128,128,130],[48,48,50]]\n",
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves capture history beyond the static linear runtime-marker window", async () => {
    const oneMarkerPattern = String.raw`(?<unit>(a)\2)(?:\g<unit>|b)*`;
    const twoMarkerPattern = String.raw`(?<unit>(a)\2(c)\3)(?:\g<unit>|b)*`;
    const oneMarkerInput = `${"aa".repeat(256)}b`;
    const twoMarkerInput = `${"aacc".repeat(256)}b`;
    const overRepetitionInput = `aa${"b".repeat(700)}`;
    const overPartialWindowInput = `aa${`baa`.repeat(256)}b`;
    const fullDynamicWindowInput = `aa${`baa`.repeat(600)}b`;
    const execution = await execute({
      filter: `[
        (${JSON.stringify(oneMarkerInput)} | match(${JSON.stringify(oneMarkerPattern)}) | [.length,[.captures[].offset]]),
        (${JSON.stringify(oneMarkerInput)} | match(${JSON.stringify(oneMarkerPattern)}; "l") | [.length,[.captures[].offset]]),
        (${JSON.stringify(twoMarkerInput)} | match(${JSON.stringify(twoMarkerPattern)}) | [.length,[.captures[].offset]]),
        (${JSON.stringify(twoMarkerInput)} | match(${JSON.stringify(twoMarkerPattern)}; "l") | [.length,[.captures[].offset]]),
        (${JSON.stringify(overRepetitionInput)} | match(${JSON.stringify(oneMarkerPattern)}) | [.length,[.captures[].offset]]),
        (${JSON.stringify(overPartialWindowInput)} | match(${JSON.stringify(oneMarkerPattern)}) | [.length,[.captures[].offset]]),
        (${JSON.stringify(overPartialWindowInput)} | match(${JSON.stringify(oneMarkerPattern)}; "l") | [.length,[.captures[].offset]]),
        (${JSON.stringify(fullDynamicWindowInput)} | match(${JSON.stringify(oneMarkerPattern)}) | [.length,[.captures[].offset]]),
        (${JSON.stringify(fullDynamicWindowInput)} | match(${JSON.stringify(oneMarkerPattern)}; "l") | [.length,[.captures[].offset]])
      ]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      "[[513,[510,510]],[513,[510,510]],[1025,[1020,1020,1022]],[1025,[1020,1020,1022]],[702,[0,0]],[771,[768,768]],[771,[768,768]],[1803,[1800,1800]],[1803,[1800,1800]]]\n",
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves literal digits after compact replay backreferences", async () => {
    const pattern = String.raw`(?<unit>(?<x>a)\k<x>1)(?:\g<unit>|b)*`;
    const input = `${"aa1".repeat(100)}b`;
    const execution = await execute({
      filter: `${JSON.stringify(input)} | match(${JSON.stringify(pattern)}) | [.length,[.captures[].offset]]`,
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe("[301,[297,297]]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves whole-match operations across repeated capture history", async () => {
    const execution = await execute({
      filter:
        '[test("(?:(a)\\\\1|b){1,3}"), [splits("(?:(a)\\\\1|b){1,3}")], sub("(?:(a)\\\\1|b){1,3}"; "X"), gsub("(?:(a)\\\\1|b){1,3}"; "X"), split("(?:(a)\\\\1|b){1,3}"; "")]',
      stdinText: '"aab"\n',
    });

    expect(execution.stdout.text).toBe(
      '[true,["",""],"X","X",["",""]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("matches jq optional and duplicate named backreferences", async () => {
    const execution = await execute({
      filter:
        '[("a" | [match("(a)?\\\\1")]), ("a" | match("(a?)\\\\1") | [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]), ("aba" | match("(?<x>a)(?<x>b)\\\\k<x>") | [.string,[.captures[]|[.string,.offset,.length,.name]]]), ("bb" | match("(?:(?<x>a)|(?<x>b))\\\\k<x>") | [.string,[.captures[]|[.string,.offset,.length,.name]]]), ("abba" | match("(a)(b)\\\\k<-1>\\\\k<-2>") | [.string,[.captures[]|[.string,.offset,.length,.name]]]), ("a" | [match("\\\\1(a)")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[],[0,0,"",[["",0,0,null]]],["aba",[["a",0,1,"x"],["b",1,1,"x"]]],["bb",[[null,-1,0,"x"],["b",0,1,"x"]]],["abba",[["a",0,1,null],["b",1,1,null]]],[]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves subexpression definition modifiers and longest overlap ranking", async () => {
    const execution = await execute({
      filter:
        '[("aA" | match("(?i:(a))\\\\g<1>") | [.offset,.length,.captures[0].string]), ("aA" | [match("(a)(?i:\\\\g<1>)")]), ("babab" | match("((a)?b)\\\\g<1>"; "l") | [.offset,.length,.string])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,2,"A"],[],[1,4,"abab"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports recursive jq regular expression subexpression calls", async () => {
    const execution = await execute({
      filter:
        '[("aaabbb" | match("(?<p>a(?:\\\\g<p>)?b)") | [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]), ("((x))" | match("(?<node>\\\\((?:x|\\\\g<node>)*\\\\))") | [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]), ("aaabbb" | match("(?<node>a(?<inner>\\\\g<node>)?b)") | [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]), (("a"*21 + "b"*21) | match("(?<p>a(?:\\\\g<p>)?b)") | [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]]), ("aaxxbb" | match("(?<node>a(?:(?<letter>x)\\\\k<letter>|\\\\g<node>)*b)") | [.offset,.length,.string,[.captures[]|[.string,.offset,.length,.name]]])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[0,6,"aaabbb",[["aaabbb",0,6,"p"]]],[0,5,"((x))",[["((x))",0,5,"node"]]],[0,6,"aaabbb",[["aaabbb",0,6,"node"],["aabb",1,4,"inner"]]],[1,40,"aaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb",[["aaaaaaaaaaaaaaaaaaaabbbbbbbbbbbbbbbbbbbb",1,40,"p"]]],[0,6,"aaxxbb",[["aaxxbb",0,6,"node"],["x",2,1,"letter"]]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports jq text-segment boundary operators", async () => {
    const execution = await execute({
      filter:
        '[("👩‍💻!" | [match("\\\\y"; "g")]), ("áb" | [match("\\\\Y"; "g")]), ("" | [match("\\\\y"; "g")]), ("áb" | [match("\\\\y"; "gn")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[{"offset":0,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":1,"length":0,"string":"","captures":[]},{"offset":3,"length":0,"string":"","captures":[]},{"offset":4,"length":0,"string":"","captures":[]}],[{"offset":1,"length":0,"string":"","captures":[]}],[{"offset":0,"length":0,"string":"","captures":[]}],[]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports embedded jq text-segment boundary assertions", async () => {
    const execution = await execute({
      filter:
        '[("aba" | [match("\\\\ya";"g")] | map([.offset,.length,.string])), ("aba" | [match("a\\\\y";"g")] | map([.offset,.length,.string])), ("á" | [match("\\\\Ya";"g")] | map([.offset,.length,.string])), ("á" | [match("a\\\\Y";"g")] | map([.offset,.length,.string])), ("cba" | [match("\\\\ya|b";"g")] | map([.offset,.length,.string]))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,1,"a"],[2,1,"a"]],[[0,1,"a"],[2,1,"a"]],[],[[0,1,"a"]],[[1,1,"b"],[2,1,"a"]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports embedded jq search-start assertions", async () => {
    const execution = await execute({
      filter:
        '[("a" | [match("a\\\\G";"g")]), ("cba" | [match("\\\\Ga|b";"g")] | map([.offset,.length,.string])), ("cba" | [match("b|\\\\Ga";"g")] | map([.offset,.length,.string])), ("aba" | [match("\\\\Ga\\\\K";"g")] | map([.offset,.length,.string]))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[],[[1,1,"b"],[2,1,"a"]],[[1,1,"b"],[2,1,"a"]],[[1,0,""],[3,0,""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports longest and reset-empty embedded jq search-start matches", async () => {
    const execution = await execute({
      filter:
        '[("baa" | [match("b|\\\\Gaa";"gl")] | map([.offset,.length,.string])), ("cbbba" | [match("(\\\\G)a|bb";"gl")] | map([.offset,.length,.string])), ("ax" | [match("\\\\Ga\\\\Kx|bbb";"gln")] | map([.offset,.length,.string])), ("a" | [match("\\\\Ga\\\\K";"gn")] | map([.offset,.length,.string])), ("aba" | [match("\\\\Ga\\\\K";"gn")] | map([.offset,.length,.string]))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,1,"b"],[1,2,"aa"]],[[1,2,"bb"]],[[1,1,"x"]],[[1,0,""]],[[1,0,""],[3,0,""]]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports embedded jq search-start assertions after nullable quantifiers", async () => {
    const execution = await execute({
      filter:
        '[("" | [match("a?\\\\G";"g")] | map([.offset,.length,.string])), ("a" | [match("a?\\\\G";"g")] | map([.offset,.length,.string])), ("aa" | [match("a*\\\\G";"g")] | map([.offset,.length,.string])), ("🙂" | match("🙂?\\\\G") | [.offset,.length,.string])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[[0,0,""]],[[0,0,""],[1,0,""]],[[0,0,""],[1,0,""],[2,0,""]],[0,0,""]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("ignores empty regex alternatives when the n flag is present", async () => {
    const execution = await execute({
      filter:
        '[("aba" | [match("(?:|a)"; "gn")]), ("ab bb" | [match("(?:a*|b*)"; "gn")]), ("aba" | gsub("(?:|a)"; "Z"; "n"))]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[{"offset":0,"length":1,"string":"a","captures":[]},{"offset":2,"length":1,"string":"a","captures":[]}],[{"offset":0,"length":1,"string":"a","captures":[]},{"offset":1,"length":1,"string":"b","captures":[]},{"offset":3,"length":2,"string":"bb","captures":[]}],"ZbZ"]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("reports invalid regular expressions as jq runtime errors", async () => {
    const execution = await execute({
      filter: 'test("[")',
      stdinText: '"value"\n',
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain("jq: error:");
    expect(execution.result.exitCode).toBe(5);
  });

  it("uses longest matching when the l regex flag is present", async () => {
    const execution = await execute({
      filter: 'match("a|aa"; "l")',
      stdinText: '"aa"\n',
    });

    expect(execution.stdout.text).toBe(
      '{"offset":0,"length":2,"string":"aa","captures":[]}\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("rejects user capture names reserved for internal JavaScript groups", async () => {
    const execution = await execute({
      filter: 'capture("(?<$a>a)")',
      stdinText: '"a"\n',
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain(
      "Regex failure: invalid char in group name <$a>",
    );
    expect(execution.result.exitCode).toBe(5);
  });

  it("rejects Python-style named capture syntax", async () => {
    const execution = await execute({
      filter: 'capture("(?P<name>[a-z]+)")',
      stdinText: '"abc"\n',
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain("jq: error:");
    expect(execution.result.exitCode).toBe(5);
  });

  it("keeps jq absolute anchors byte-stable and supports final-newline Z", async () => {
    const execution = await execute({
      filter:
        '[("🙂" | [match("\\\\A"; "g")]), ("🙂" | [match("\\\\z"; "g")]), ("a\\n" | [match("\\\\Z"; "g")]), ("A Zz" | [scan("[\\\\A\\\\Z\\\\z]+")])]',
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe(
      '[[{"offset":0,"length":0,"string":"","captures":[]}],[{"offset":1,"length":0,"string":"","captures":[]}],[{"offset":1,"length":0,"string":"","captures":[]},{"offset":2,"length":0,"string":"","captures":[]}],["A","Zz"]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports absolute regex anchors", async () => {
    const execution = await execute({
      filter: 'test("\\\\Aabc\\\\z")',
      stdinText: '"abc"\n',
    });

    expect(execution.stdout.text).toBe("true\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports leading inline ignore-case modifiers", async () => {
    const execution = await execute({
      filter: 'test("(?i)abc")',
      stdinText: '"ABC"\n',
    });

    expect(execution.stdout.text).toBe("true\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports leading inline extended-mode modifiers", async () => {
    const execution = await execute({
      filter: 'test("(?x)a \\\\s+ b")',
      stdinText: '"a   b"\n',
    });

    expect(execution.stdout.text).toBe("true\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports resetting the reported match start with backslash K", async () => {
    const execution = await execute({
      filter: 'match("ab\\\\K[0-9]+")',
      stdinText: '"ab12"\n',
    });

    expect(execution.stdout.text).toBe(
      '{"offset":2,"length":2,"string":"12","captures":[]}\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("returns an array for scan expressions with one capture", async () => {
    const execution = await execute({
      filter: '[scan("([0-9]+)")]',
      stdinText: '"a12b34"\n',
    });

    expect(execution.stdout.text).toBe('[["12"],["34"]]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("expands zero-argument user-defined filters", async () => {
    const execution = await execute({
      filter: "def twice: . * 2; map(twice)",
      stdinText: "[1,2,3]\n",
    });

    expect(execution.stdout.text).toBe("[2,4,6]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("binds variable parameters in user-defined filters", async () => {
    const repeated = await execute({
      filter: "def twice($x): [$x,$x]; twice(1,2)",
      options: "-nc",
    });
    expect(repeated.stdout.text).toBe(`\
[1,1]
[2,2]
`);
    expect(repeated.stderr.text).toBe("");
    expect(repeated.result.exitCode).toBe(0);

    const paired = await execute({
      filter: "def pair($x;$y): [$x,$y]; pair(1,2;3,4)",
      options: "-nc",
    });
    expect(paired.stdout.text).toBe(`\
[1,3]
[1,4]
[2,3]
[2,4]
`);
    expect(paired.stderr.text).toBe("");
    expect(paired.result.exitCode).toBe(0);

    const overloaded = await execute({
      filter: "def f: 0; def f($x): $x; [f, f(1)]",
      options: "-nc",
    });
    expect(overloaded.stdout.text).toBe("[0,1]\n");
    expect(overloaded.stderr.text).toBe("");
    expect(overloaded.result.exitCode).toBe(0);

    const shadowedParameter = await execute({
      filter: "def f($x;$x): $x; f(1;2)",
      options: "-nc",
    });
    expect(shadowedParameter.stdout.text).toBe("2\n");
    expect(shadowedParameter.stderr.text).toBe("");
    expect(shadowedParameter.result.exitCode).toBe(0);
  });

  it("reduces generator outputs into an accumulator", async () => {
    const execution = await execute({
      filter: "reduce .[] as $x (0; . + $x)",
      stdinText: "[1,2,3,4]\n",
    });

    expect(execution.stdout.text).toBe("10\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("consumes all remaining JSON inputs with inputs", async () => {
    const nullInputExecution = await execute({
      filter: "[inputs]",
      stdinText: `\
1
2
3
`,
      options: "-nc",
    });
    const primaryInputExecution = await execute({
      filter: "[., inputs]",
      stdinText: `\
1
2
3
`,
    });

    expect(nullInputExecution.stdout.text).toBe("[1,2,3]\n");
    expect(nullInputExecution.stderr.text).toBe("");
    expect(nullInputExecution.result.exitCode).toBe(0);
    expect(primaryInputExecution.stdout.text).toBe("[1,2,3]\n");
    expect(primaryInputExecution.stderr.text).toBe("");
    expect(primaryInputExecution.result.exitCode).toBe(0);
  });

  it("preserves demand, atomicity, and transformed prefixes across input streams", async () => {
    const any = await execute({
      filter: "any(inputs; . > 1)",
      stdinText: `\
2
not-json
`,
      options: "-nc",
    });
    const all = await execute({
      filter: "all(inputs; . < 1)",
      stdinText: `\
1
not-json
`,
      options: "-nc",
    });
    const requiredAll = await execute({
      filter: "all(inputs; . > 0)",
      stdinText: `\
1
2
not-json
`,
      options: "-nc",
    });
    const reduced = await execute({
      filter: "reduce inputs as $x (0; . + $x)",
      stdinText: `\
1
2
not-json
`,
      options: "-nc",
    });
    const iterated = await execute({
      filter: "foreach inputs as $x (0; . + $x; .)",
      stdinText: `\
1
2
not-json
`,
      options: "-nc",
    });

    expect(any.stdout.text).toBe("true\n");
    expect(any.stderr.text).toBe("");
    expect(any.result.exitCode).toBe(0);
    expect(all.stdout.text).toBe("false\n");
    expect(all.stderr.text).toBe("");
    expect(all.result.exitCode).toBe(0);
    for (const execution of [requiredAll, reduced]) {
      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toContain("jq: parse error:");
      expect(execution.result.exitCode).toBe(5);
    }
    expect(iterated.stdout.text).toBe(`\
1
3
`);
    expect(iterated.stderr.text).toContain("jq: parse error:");
    expect(iterated.result.exitCode).toBe(5);
  });

  it("transforms partial assignment values and short-circuits first-output updates", async () => {
    const assigned = await execute({
      filter: "{a:0} | .a = inputs",
      stdinText: `\
1
2
not-json
`,
      options: "-nc",
    });
    const updated = await execute({
      filter: "{a:0} | .a |= inputs",
      stdinText: `\
1
not-json
`,
      options: "-nc",
    });
    const dynamicPath = await execute({
      filter: '{"a":0} | .[input] = 1',
      stdinText: `\
"a"
not-json
`,
      options: "-nc",
    });

    expect(assigned.stdout.text).toBe(`\
{"a":1}
{"a":2}
`);
    expect(assigned.stderr.text).toContain("jq: parse error:");
    expect(assigned.result.exitCode).toBe(5);
    expect(updated.stdout.text).toBe('{"a":1}\n');
    expect(updated.stderr.text).toBe("");
    expect(updated.result.exitCode).toBe(0);
    expect(dynamicPath.stdout.text).toBe('{"a":1}\n');
    expect(dynamicPath.stderr.text).toBe("");
    expect(dynamicPath.result.exitCode).toBe(0);
  });

  it("transforms direct structural access before propagating demanded input failure", async () => {
    const field = await execute({
      filter: "inputs.x",
      stdinText: `\
{"x":1}
{"x":2}
not-json
`,
      options: "-nc",
    });
    const index = await execute({
      filter: "inputs[0]",
      stdinText: `\
[1,2]
[3,4]
not-json
`,
      options: "-nc",
    });
    const iteration = await execute({
      filter: "inputs[]",
      stdinText: `\
[1,2]
[3]
not-json
`,
      options: "-nc",
    });
    const slice = await execute({
      filter: "inputs[0:1]",
      stdinText: `\
[1,2]
[3,4]
not-json
`,
      options: "-nc",
    });

    expect(field.stdout.text).toBe(`\
1
2
`);
    expect(index.stdout.text).toBe(`\
1
3
`);
    expect(iteration.stdout.text).toBe(`\
1
2
3
`);
    expect(slice.stdout.text).toBe(`\
[1]
[3]
`);
    for (const execution of [field, index, iteration, slice]) {
      expect(execution.stderr.text).toContain("jq: parse error:");
      expect(execution.result.exitCode).toBe(5);
    }
  });

  it("evaluates the setpath value filter before its path filter", async () => {
    const successful = await execute({
      filter: "{} | setpath(input; input)",
      stdinText: `\
1
["a"]
not-json
`,
      options: "-nc",
    });
    const invalidPath = await execute({
      filter: "{} | setpath(input; input)",
      stdinText: `\
["a"]
1
not-json
`,
      options: "-nc",
    });

    expect(successful.stdout.text).toBe('{"a":1}\n');
    expect(successful.stderr.text).toBe("");
    expect(successful.result.exitCode).toBe(0);
    expect(invalidPath.stdout.text).toBe("");
    expect(invalidPath.stderr.text).toContain("Path must be specified as an array");
    expect(invalidPath.result.exitCode).toBe(5);
  });

  it("keeps ordering-key failures atomic", async () => {
    for (const filter of [
      '[2,1] | sort_by((., error("boom")))',
      '[2,1] | group_by((., error("boom")))',
      '[2,1] | unique_by((., error("boom")))',
      '[2,1] | min_by((., error("boom")))',
      '[2,1] | max_by((., error("boom")))',
    ]) {
      const execution = await execute({ filter, options: "-nc" });
      expect(execution.stdout.text).toBe("");
      expect(execution.stderr.text).toContain("boom");
      expect(execution.result.exitCode).toBe(5);
    }
  });

  it("expands path-update and flatten filter argument streams", async () => {
    const delpaths = await execute({
      filter: '{a:1,b:2} | delpaths(([ ["a"] ], [ ["b"] ]))',
      options: "-nc",
    });
    const setpath = await execute({
      filter: '{} | setpath((["a"],["b"]); (1,2))',
      options: "-nc",
    });
    const flatten = await execute({
      filter: '[[1],[2]] | flatten((1,2))',
      options: "-nc",
    });
    const bounded = await execute({
      filter: 'limit(1; {a:1,b:2} | delpaths(([ ["a"] ], repeat([ ["b"] ]))))',
      options: "-nc",
    });
    const invalidArrayPath = await execute({
      filter: '[10,20] | delpaths([["a"]])',
      options: "-nc",
    });

    expect(delpaths.stdout.text).toBe(`\
{"b":2}
{"a":1}
`);
    expect(setpath.stdout.text).toBe(`\
{"a":1}
{"b":1}
{"a":2}
{"b":2}
`);
    expect(flatten.stdout.text).toBe(`\
[1,2]
[1,2]
`);
    expect(bounded.stdout.text).toBe('{"b":2}\n');
    expect(invalidArrayPath.stdout.text).toBe("");
    expect(invalidArrayPath.stderr.text).toContain("Cannot delete string element of array");
    expect(invalidArrayPath.result.exitCode).toBe(5);
    for (const execution of [delpaths, setpath, flatten, bounded]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("defaults the foreach extract expression to identity", async () => {
    const execution = await execute({
      filter: "foreach inputs as $x (0; . + $x)",
      stdinText: `\
1
2
`,
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
1
3
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("formats arrays with the jq CSV encoder", async () => {
    const execution = await execute({
      filter: "@csv",
      stdinText: '["a","b,c",1,true,false,null]\n',
      options: "-r",
    });

    expect(execution.stdout.text).toBe('"a","b,c",1,true,false,\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("rejects nested arrays in CSV rows", async () => {
    const execution = await execute({
      filter: "@csv",
      stdinText: "[[1]]\n",
      options: "-r",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain(
      "array ([1]) is not valid in a csv row",
    );
    expect(execution.result.exitCode).toBe(5);
  });

  it("URI-encodes jq string and JSON representations", async () => {
    const stringExecution = await execute({
      filter: "@uri",
      stdinText: '"a b/β!"\n',
      options: "-r",
    });
    const arrayExecution = await execute({
      filter: "@uri",
      stdinText: "[1,2]\n",
      options: "-r",
    });

    expect(stringExecution.stdout.text).toBe("a%20b%2F%CE%B2%21\n");
    expect(stringExecution.stderr.text).toBe("");
    expect(stringExecution.result.exitCode).toBe(0);
    expect(arrayExecution.stdout.text).toBe("%5B1%2C2%5D\n");
    expect(arrayExecution.stderr.text).toBe("");
    expect(arrayExecution.result.exitCode).toBe(0);
  });

  it("supports jq text, JSON, and HTML format encoders", async () => {
    const textExecution = await execute({
      filter: "@text",
      stdinText: String.raw`"a\nb"` + "\n",
      options: "-r",
    });
    const jsonExecution = await execute({
      filter: "@json",
      stdinText: String.raw`{"a":1,"text":"x\ny"}` + "\n",
      options: "-r",
    });
    const htmlExecution = await execute({
      filter: "@html",
      stdinText: String.raw`"<&\"'>"` + "\n",
      options: "-r",
    });

    expect(textExecution.stdout.text).toBe(`\
a
b
`);
    expect(jsonExecution.stdout.text).toBe('{"a":1,"text":"x\\ny"}\n');
    expect(htmlExecution.stdout.text).toBe("&lt;&amp;&quot;&apos;&gt;\n");
    for (const execution of [textExecution, jsonExecution, htmlExecution]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("supports jq shell and TSV format encoders", async () => {
    const shellExecution = await execute({
      filter: "@sh",
      stdinText: `["a b","a'b",1,true,null]\n`,
      options: "-r",
    });
    const tsvExecution = await execute({
      filter: "@tsv",
      stdinText: String.raw`["a\tb","x\ny","z\\q",null,true,1]` + "\n",
      options: "-r",
    });

    expect(shellExecution.stdout.text).toBe("'a b' 'a'\\''b' 1 true null\n");
    expect(tsvExecution.stdout.text).toBe("a\\tb\tx\\ny\tz\\\\q\t\ttrue\t1\n");
    for (const execution of [shellExecution, tsvExecution]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("matches jq control-character format rules", async () => {
    const jsonExecution = await execute({
      filter: "@json",
      stdinText: String.raw`"\u007f"` + "\n",
      options: "-r",
    });
    const htmlExecution = await execute({
      filter: "@html",
      stdinText: String.raw`"\u0000"` + "\n",
      options: "-r",
    });
    const tsvExecution = await execute({
      filter: "@tsv",
      stdinText: String.raw`["\u0000","\u007f"]` + "\n",
      options: "-r",
    });
    const csvExecution = await execute({
      filter: "@csv",
      stdinText: String.raw`["\u0000","\u007f"]` + "\n",
      options: "-r",
    });

    expect(jsonExecution.stdout.text).toBe('"\\u007f"\n');
    expect(htmlExecution.stdout.text).toBe("\\0\n");
    expect(tsvExecution.stdout.text).toBe("\\0\t\u007f\n");
    expect(csvExecution.stdout.text).toBe('"\\0","\u007f"\n');
    for (const execution of [jsonExecution, htmlExecution, tsvExecution, csvExecution]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("supports jq Base64 format encoding and decoding", async () => {
    const encoded = await execute({
      filter: "@base64",
      stdinText: String.raw`"β\n"` + "\n",
      options: "-r",
    });
    const decoded = await execute({
      filter: "@base64d",
      stdinText: '"zrIK"\n',
      options: "-r",
    });
    const unpadded = await execute({
      filter: "@base64d",
      stdinText: '"YQ"\n',
      options: "-r",
    });

    expect(encoded.stdout.text).toBe("zrIK\n");
    expect(decoded.stdout.text).toBe("β\n\n");
    expect(unpadded.stdout.text).toBe("a\n");
    for (const execution of [encoded, decoded, unpadded]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("supports jq IN membership over finite generators", async () => {
    const execution = await execute({
      filter: '[(1 | IN(1,2)), (3 | IN(1,2)), (null | IN((1,error("boom")); 1)), (null | IN((1,2); (2,error("boom"))))]',
      options: "-nc",
    });
    const failed = await execute({
      filter: 'null | IN((1,error("boom")); 2)',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("[true,false,true,true]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    expect(failed.stdout.text).toBe("");
    expect(failed.stderr.text).toContain("boom");
    expect(failed.result.exitCode).toBe(5);
  });

  it("stops jq IN source and target streams after the first match", async () => {
    const source = await execute({
      filter: 'null | IN((0,repeat(1)); 1)',
      options: "-nc",
    });
    const target = await execute({
      filter: 'null | IN(1; (0,1,repeat(2)))',
      options: "-nc",
    });
    const orderedFailure = await execute({
      filter: 'null | IN((1,2,error("source-needed-before-next-target")); (3,2))',
      options: "-nc",
    });

    for (const execution of [source, target]) {
      expect(execution.stdout.text).toBe("true\n");
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(orderedFailure.stdout.text).toBe("");
    expect(orderedFailure.stderr.text).toContain("source-needed-before-next-target");
    expect(orderedFailure.result.exitCode).toBe(5);
  });

  it("preserves unconsumed jq inputs after IN finds a match", async () => {
    const oneArgument = await execute({
      filter: '(2 | IN(inputs)), inputs',
      stdinText: `\
1
2
3
4
`,
      options: "-nc",
    });
    const twoArguments = await execute({
      filter: '(null | IN(inputs; input)), inputs',
      stdinText: `\
2
1
2
3
`,
      options: "-nc",
    });

    expect(oneArgument.stdout.text).toBe(`\
true
3
4
`);
    expect(twoArguments.stdout.text).toBe(`\
true
3
`);
    for (const execution of [oneArgument, twoArguments]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("supports jq INDEX stream materialization", async () => {
    const shorthand = await execute({
      filter: "INDEX(.id)",
      stdinText: '[{"id":"a","v":1},{"id":"b","v":2},{"id":"a","v":3}]\n',
    });
    const explicit = await execute({
      filter: "INDEX(.[]; (.id,.v))",
      stdinText: '[{"id":"a","v":1}]\n',
    });
    const structuredKey = await execute({
      filter: "INDEX(.[]; [1])",
      stdinText: "[1,2]\n",
    });
    const failed = await execute({
      filter: 'INDEX(.[]; error("boom"))',
      stdinText: "[1,2]\n",
    });

    expect(shorthand.stdout.text).toBe(
      '{"a":{"id":"a","v":3},"b":{"id":"b","v":2}}\n',
    );
    expect(explicit.stdout.text).toBe('{"a":{"id":"a","v":1},"1":{"id":"a","v":1}}\n');
    expect(structuredKey.stdout.text).toBe('{"[1]":2}\n');
    for (const execution of [shorthand, explicit, structuredKey]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(failed.stdout.text).toBe("");
    expect(failed.stderr.text).toContain("boom");
    expect(failed.result.exitCode).toBe(5);
  });

  it("supports jq JOIN lookup streams and projections", async () => {
    const collected = await execute({
      filter: 'JOIN({"a":{"name":"A"}}; .id)',
      stdinText: '[{"id":"a"},{"id":"c"}]\n',
    });
    const streamed = await execute({
      filter: 'JOIN({"a":{"name":"A"}}; .[]; .id)',
      stdinText: '[{"id":"a"},{"id":"c"}]\n',
    });
    const projected = await execute({
      filter: 'JOIN({"a":{"name":"A"}}; .[]; .id; {left:.[0],right:.[1]})',
      stdinText: '[{"id":"a"},{"id":"c"}]\n',
    });
    const multipleKeys = await execute({
      filter: 'JOIN({"a":1}; .[]; (.id,.other))',
      stdinText: '[{"id":"a","other":"x"}]\n',
    });
    const partialFailure = await execute({
      filter: 'JOIN({"a":1}; (.[],error("source")); .id)',
      stdinText: '[{"id":"a"}]\n',
    });

    expect(collected.stdout.text).toBe(
      '[[{"id":"a"},{"name":"A"}],[{"id":"c"},null]]\n',
    );
    expect(streamed.stdout.text).toBe(`\
[{"id":"a"},{"name":"A"}]
[{"id":"c"},null]
`);
    expect(projected.stdout.text).toBe(
      `\
{"left":{"id":"a"},"right":{"name":"A"}}
{"left":{"id":"c"},"right":null}
`,
    );
    expect(multipleKeys.stdout.text).toBe('[{"id":"a","other":"x"},1,null]\n');
    for (const execution of [collected, streamed, projected, multipleKeys]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(partialFailure.stdout.text).toBe('[{"id":"a"},1]\n');
    expect(partialFailure.stderr.text).toContain("source");
    expect(partialFailure.result.exitCode).toBe(5);
  });

  it("supports jq non-finite number classification", async () => {
    const values = await execute({
      filter: '[nan, infinite, -infinite, (nan|type), (nan|isnan), (infinite|isinfinite), (1|isnormal), (0|isnormal), (1e-320|isnormal)]',
      options: "-nc",
    });
    const selectors = await execute({
      filter: '[0,1,-1,nan,infinite,-infinite,"x",null] as $v | [[$v[] | finites], [$v[] | normals]]',
      options: "-nc",
    });
    const equality = await execute({
      filter: '[(nan == nan), ([nan] == [nan]), (infinite == infinite)]',
      options: "-nc",
    });
    const arithmetic = await execute({
      filter: '[infinite + (-infinite), infinite - infinite, infinite * 0, infinite / infinite, 1e308 * 10, pow(10; 1000), pow(-10; 1001)]',
      options: "-nc",
    });
    const generatorOrder = await execute({
      filter: '[pow((2,3);(4,5))]',
      options: "-nc",
    });

    expect(values.stdout.text).toBe(
      '[null,1.7976931348623157e+308,-1.7976931348623157e+308,"number",true,true,true,false,false]\n',
    );
    expect(selectors.stdout.text).toBe('[[0,1,-1,null],[1,-1]]\n');
    expect(equality.stdout.text).toBe("[false,false,true]\n");
    expect(arithmetic.stdout.text).toBe(
      '[null,null,null,null,1.7976931348623157e+308,1.7976931348623157e+308,-1.7976931348623157e+308]\n',
    );
    expect(generatorOrder.stdout.text).toBe('[16,81,32,243]\n');
    for (const execution of [values, selectors, equality, arithmetic, generatorOrder]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("cancels JOIN index, source, and projection generator streams", async () => {
    const indexStream = await execute({
      filter: String.raw`limit(1; JOIN(repeat({"a":1}); .id))`,
      stdinText: '[{"id":"a"}]\n',
      options: "-c",
    });
    const sourceStream = await execute({
      filter: String.raw`limit(1; JOIN({"a":1}; repeat({"id":"a"}); .id))`,
      options: "-nc",
    });
    const projectionStream = await execute({
      filter: String.raw`limit(1; JOIN({"a":1}; {"id":"a"}; .id; repeat(.)))`,
      options: "-nc",
    });

    expect(indexStream.stdout.text).toBe('[[{"id":"a"},1]]\n');
    expect(sourceStream.stdout.text).toBe('[{"id":"a"},1]\n');
    expect(projectionStream.stdout.text).toBe('[{"id":"a"},1]\n');
    for (const outcome of [indexStream, sourceStream, projectionStream]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });


  it("supports jq common unary math builtins", async () => {
    const execution = await execute({
      filter: '[(null|not),(false|not),(0|not),(nan|isfinite),(infinite|isfinite),(1|isfinite),(0.5|asin),(0.5|acos),(1|atan),(1|asinh),(2|acosh),(0.5|atanh),(1|sin),(1|cos),(1|tan),(1|sinh),(1|cosh),(1|tanh),(1|exp),(3|exp2),(3|exp10),(1|expm1),(1|log1p),(8|cbrt),(-1.9|trunc),(-1.9|fabs),(infinite|exp),(infinite|sin)]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(
      '[true,true,false,true,false,true,0.5235987755982989,1.0471975511965979,0.7853981633974483,0.881373587019543,1.3169578969248166,0.5493061443340548,0.8414709848078965,0.5403023058681398,1.5574077246549023,1.1752011936438014,1.5430806348152437,0.7615941559557649,2.718281828459045,8,1000,1.718281828459045,0.6931471805599453,2,-1,1.9,1.7976931348623157e+308,null]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports jq common binary math builtins", async () => {
    const execution = await execute({
      filter: '[atan2(1;2),hypot(3;4),ldexp(1.5;3),ldexp(1;2.9),copysign(2;-1),copysign(2;-0),fmin(nan;2),fmin(2;nan),fmax(nan;2),fdim(5;2),fdim(2;5),fmod(5.5;2),fmod(-5.5;2),fmod(infinite;2),remainder(5;2),remainder(3;2),remainder(-3;2),hypot(infinite;1),atan2(infinite;infinite),[atan2((1,2);(3,4))]]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(
      '[0.4636476090008061,5,12,4,-2,-2,2,2,2,3,0,1.5,-1.5,null,1,-1,1,1.7976931348623157e+308,0.7853981633974483,[0.3217505543966422,0.5880026035475675,0.24497866312686414,0.4636476090008061]]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("cancels binary numeric builtin argument streams in jq order", async () => {
    const finite = await execute({
      filter: String.raw`[pow((2,3);(4,5))]`,
      options: "-nc",
    });
    const rightInfinite = await execute({
      filter: String.raw`limit(1; pow(2; repeat(3)))`,
      options: "-nc",
    });
    const leftInfinite = await execute({
      filter: String.raw`limit(1; atan2(repeat(2); 3))`,
      options: "-nc",
    });
    const inputCursor = await execute({
      filter: String.raw`limit(1; fmod(input; repeat(3))), input`,
      stdinText: `\
7
11
`,
      options: "-nc",
    });

    expect(finite.stdout.text).toBe("[16,81,32,243]\n");
    expect(rightInfinite.stdout.text).toBe("8\n");
    expect(leftInfinite.stdout.text).toBe(`${Math.atan2(2, 3)}\n`);
    expect(inputCursor.stdout.text).toBe(`\
1
11
`);
    for (const outcome of [finite, rightInfinite, leftInfinite, inputCursor]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });


  it("supports jq IEEE floating-point helper builtins", async () => {
    const execution = await execute({
      filter: '[(1.5|modf),(-1.5|modf),(8|frexp),(0.75|frexp),(0|frexp),(12|significand),(12|logb),(0|logb),(infinite|logb),(nan|logb),(2.5|rint),(3.5|rint),(-0.5|rint),(2.5|nearbyint),scalb(1.5;3),scalbln(1.5;3),drem(3;2),nextafter(1;2),nextafter(1;0),nextafter(0;1),nextafter(0;-1),nexttoward(1;2),nextafter(infinite;0),nextafter(nan;1)]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(
      '[[0.5,1],[-0.5,-1],[0.5,4],[0.75,0],[0,0],1.5,3,-1.7976931348623157e+308,1.7976931348623157e+308,null,2,4,-0,2,12,12,-1,1.0000000000000002,0.9999999999999999,5e-324,-5e-324,1.0000000000000002,1.7976931348623157e+308,null]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports jq dynamic format selection", async () => {
    const generated = await execute({
      filter: '"x" | format(("text", "json"))',
      options: "-nr",
    });
    const partialFailure = await execute({
      filter: '"x" | format(("text", error("boom")))',
      options: "-nr",
    });
    const invalid = await execute({
      filter: '"x" | format("bogus")',
      options: "-nr",
    });
    const wrongType = await execute({
      filter: '"x" | format(1)',
      options: "-nr",
    });

    expect(generated.stdout.text).toBe(`\
x
"x"
`);
    expect(generated.stderr.text).toBe("");
    expect(generated.result.exitCode).toBe(0);
    expect(partialFailure.stdout.text).toBe("x\n");
    expect(partialFailure.stderr.text).toContain("boom");
    expect(partialFailure.result.exitCode).toBe(5);
    expect(invalid.stdout.text).toBe("");
    expect(invalid.stderr.text).toContain("bogus is not a valid format");
    expect(invalid.result.exitCode).toBe(5);
    expect(wrongType.stdout.text).toBe("");
    expect(wrongType.stderr.text).toContain("number (1) is not a valid format");
    expect(wrongType.result.exitCode).toBe(5);
  });

  it("preserves cancellable format argument streams and shared input cursors", async () => {
    const format = await execute({
      filter: '{a:1} | limit(1; format((input,input))), inputs',
      stdinText: `\
"json"
"text"
"sh"
`,
      options: "-nc",
    });
    const strftime = await execute({
      filter: '0 | gmtime | limit(1; strftime((input,input))), inputs',
      stdinText: `\
"%Y"
"%m"
"%d"
`,
      options: "-nc",
    });

    expect(format.stdout.text).toBe(`\
"{\\"a\\":1}"
"text"
"sh"
`);
    expect(format.stderr.text).toBe("");
    expect(format.result.exitCode).toBe(0);
    expect(strftime.stdout.text).toBe(`\
"1970"
"%m"
"%d"
`);
    expect(strftime.stderr.text).toBe("");
    expect(strftime.result.exitCode).toBe(0);
  });

  it("reports jq format input errors", async () => {
    const invalidBase64 = await execute({
      filter: "@base64d",
      stdinText: '"YWJj$"\n',
      options: "-r",
    });
    const trailingBase64 = await execute({
      filter: "@base64d",
      stdinText: '"A"\n',
      options: "-r",
    });
    const newlineBase64 = await execute({
      filter: "@base64d",
      stdinText: String.raw`"YQ\n"` + "\n",
      options: "-r",
    });
    const nestedTsv = await execute({
      filter: "@tsv",
      stdinText: "[[1]]\n",
      options: "-r",
    });
    const objectShell = await execute({
      filter: "@sh",
      stdinText: '{"a":1}\n',
      options: "-r",
    });

    expect(invalidBase64.stderr.text).toContain("is not valid base64 data");
    expect(trailingBase64.stderr.text).toContain("trailing base64 byte found");
    expect(newlineBase64.stderr.text).toContain("is not valid base64 data");
    expect(nestedTsv.stderr.text).toContain("array ([1]) is not valid in a csv row");
    expect(objectShell.stderr.text).toContain("object ({\"a\":1}) can not be escaped for shell");
    for (const execution of [
      invalidBase64,
      trailingBase64,
      newlineBase64,
      nestedTsv,
      objectShell,
    ]) {
      expect(execution.stdout.text).toBe("");
      expect(execution.result.exitCode).toBe(5);
    }
  });

  it("uses array elements for zero-argument first and last", async () => {
    const execution = await execute({
      filter: "[first, last]",
      stdinText: "[1,2,3]\n",
    });
    const empty = await execute({
      filter: "[first, last]",
      stdinText: "[]\n",
    });

    expect(execution.stdout.text).toBe("[1,3]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    expect(empty.stdout.text).toBe("[null,null]\n");
    expect(empty.stderr.text).toBe("");
    expect(empty.result.exitCode).toBe(0);
  });

  it("supports one-argument nth with negative indexes", async () => {
    const execution = await execute({
      filter: "[nth(1), nth(-1), nth(-4)]",
      stdinText: "[10,20,30]\n",
    });

    expect(execution.stdout.text).toBe("[20,30,null]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("emits one selected input for every truthy condition output", async () => {
    const mixed = await execute({
      filter: "1 | select(false, true)",
      options: "-nc",
    });
    const repeated = await execute({
      filter: "1 | select(true, true)",
      options: "-nc",
    });

    expect(mixed.stdout.text).toBe("1\n");
    expect(mixed.stderr.text).toBe("");
    expect(mixed.result.exitCode).toBe(0);
    expect(repeated.stdout.text).toBe(`\
1
1
`);
    expect(repeated.stderr.text).toBe("");
    expect(repeated.result.exitCode).toBe(0);
  });

  it("rounds negative halves away from zero", async () => {
    const execution = await execute({
      filter: "[-3.5,-2.5,-1.5,-0.5,0.5,1.5] | map(round)",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("[-4,-3,-2,-1,1,2]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("finds overlapping array subsequences and rejects empty needles", async () => {
    const arrayExecution = await execute({
      filter: "[index([1,2]), rindex([1,2]), indices([1,1])]",
      stdinText: "[1,1,1,2,1,2]\n",
    });
    const emptyExecution = await execute({
      filter: '[index(""), rindex(""), indices("")]',
      stdinText: '"abc"\n',
    });

    expect(arrayExecution.stdout.text).toBe("[2,4,[0,1]]\n");
    expect(arrayExecution.stderr.text).toBe("");
    expect(arrayExecution.result.exitCode).toBe(0);
    expect(emptyExecution.stdout.text).toBe("[null,null,[]]\n");
    expect(emptyExecution.stderr.text).toBe("");
    expect(emptyExecution.result.exitCode).toBe(0);
  });

  it("uses an empty string for null join elements", async () => {
    const execution = await execute({
      filter: 'join("|")',
      stdinText: '["a",1,true,false,null]\n',
    });

    expect(execution.stdout.text).toBe('"a|1|true|false|"\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("rejects numeric from_entries keys", async () => {
    const execution = await execute({
      filter: "from_entries",
      stdinText: '[{"key":2,"value":"x"}]\n',
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain("jq: error:");
    expect(execution.result.exitCode).toBe(5);
  });

  it("parses jq-compatible decimal number strings", async () => {
    const execution = await execute({
      filter: "map(tonumber)",
      stdinText: '["+1","01",".5","1.","1e3"]\n',
    });

    expect(execution.stdout.text).toBe("[1,1,0.5,1,1E+3]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("treats null as the identity element for add", async () => {
    const execution = await execute({
      filter: "[add, ([null,null] | add)]",
      stdinText: "[null,1,null,2]\n",
    });

    expect(execution.stdout.text).toBe("[3,null]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("rejects reverse on strings", async () => {
    const execution = await execute({
      filter: "reverse",
      stdinText: '"aβ😀"\n',
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain("jq: error:");
    expect(execution.result.exitCode).toBe(5);
  });

  it("deletes every path produced by a comma expression", async () => {
    const execution = await execute({
      filter: "del(.a, .nested.x)",
      stdinText: '{"a":1,"nested":{"x":2,"y":3}}\n',
    });

    expect(execution.stdout.text).toBe('{"nested":{"y":3}}\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("creates arrays while applying setpath", async () => {
    const execution = await execute({
      filter: 'setpath(["a",2];9)',
      stdinText: "{}\n",
    });

    expect(execution.stdout.text).toBe('{"a":[null,null,9]}\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("limits only newly expanded arrays in setpath", async () => {
    const execution = await execute({
      filter: 'setpath([1000000]; 1)',
      stdinText: "[]\n",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain("array materialization exceeds limit 1000000");
    expect(execution.result.exitCode).toBe(5);
  });

  it("normalizes negative indexes in getpath", async () => {
    const execution = await execute({
      filter: "getpath([-1])",
      stdinText: "[1,2,3]\n",
    });

    expect(execution.stdout.text).toBe("3\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("emits every static path in a comma expression", async () => {
    const execution = await execute({
      filter: "[path(.a, .b)]",
      stdinText: '{"a":1,"b":2}\n',
    });

    expect(execution.stdout.text).toBe('[["a"],["b"]]\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("streams dynamic path expressions and materializes pick slices", async () => {
    const dynamicOrder = await execute({
      filter: String.raw`[[10,11],[20,21]] | path(.[(0,1)][(0,1)])`,
      options: "-nc",
    });
    const cancelledError = await execute({
      filter: String.raw`[10,20] | limit(1; path(.[(0,error("late"))]))`,
      options: "-nc",
    });
    const sharedInput = await execute({
      filter: String.raw`[10,20,30] | limit(1; path(.[(input,input)])), inputs`,
      stdinText: `\
0
1
99
`,
      options: "-nc",
    });
    const sliced = await execute({
      filter: String.raw`[1,2,3,4] | pick(.[0:1],.[2:3])`,
      options: "-nc",
    });
    const nonLeafSlice = await execute({
      filter: String.raw`[[1,2],[3,4],[5,6]] | pick(.[0:2][0],.[1:3][1])`,
      options: "-nc",
    });
    const reversedNonLeafSlice = await execute({
      filter: String.raw`[[1,2],[3,4],[5,6]] | pick(.[1:3][1],.[0:2][0])`,
      options: "-nc",
    });

    expect(dynamicOrder.stdout.text).toBe(`\
[0,0]
[1,0]
[0,1]
[1,1]
`);
    expect(cancelledError.stdout.text).toBe("[0]\n");
    expect(sharedInput.stdout.text).toBe(`\
[0]
1
99
`);
    expect(sliced.stdout.text).toBe("[1,3]\n");
    expect(nonLeafSlice.stdout.text).toBe("[[1,2],null,[5,6]]\n");
    expect(reversedNonLeafSlice.stdout.text).toBe("[[1,2],[5,6]]\n");
    for (const execution of [
      dynamicOrder,
      cancelledError,
      sharedInput,
      sliced,
      nonLeafSlice,
      reversedNonLeafSlice,
    ]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("uses only the last reducer update output", async () => {
    const execution = await execute({
      filter: "reduce (1,2) as $x (0; .+$x, .-$x)",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("-3\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("limits an ungrouped optional suffix to the final path step", async () => {
    const execution = await execute({
      filter: "[1,{} | .a[]?]",
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toContain("jq: error:");
    expect(execution.result.exitCode).toBe(5);
  });

  it("suppresses the complete grouped filter with optional", async () => {
    const execution = await execute({
      filter: "1 | (.a[])?",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("preserves negative zero in jq JSON output", async () => {
    const execution = await execute({
      filter: "[-0.49,-0.5,-0.51] | map(round)",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("[-0,-1,-1]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("deletes multiple array paths relative to the original input", async () => {
    const delExecution = await execute({
      filter: "del(.a[0], .a[1])",
      stdinText: '{"a":[0,1,2,3]}\n',
    });
    const delpathsExecution = await execute({
      filter: 'delpaths([["a",-1],["a",-2]])',
      stdinText: '{"a":[0,1,2,3]}\n',
    });

    expect(delExecution.stdout.text).toBe('{"a":[2,3]}\n');
    expect(delpathsExecution.stdout.text).toBe('{"a":[0,1]}\n');
    for (const outcome of [delExecution, delpathsExecution]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("supports foreach with multiple extract outputs", async () => {
    const execution = await execute({
      filter: "foreach (1,2) as $x (0; . + $x; ., -.)",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
1
-1
3
-3
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("uses only the final update output as the next foreach state", async () => {
    const execution = await execute({
      filter: "foreach (1,2) as $x (0; . + $x, . - $x; .)",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
1
-1
1
-3
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("processes each foreach initial value through the full generator", async () => {
    const execution = await execute({
      filter: "foreach (1,2) as $x ((0,10); . + $x; .)",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
1
3
11
13
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("accepts optional field syntax on update-assignment paths", async () => {
    const execution = await execute({
      filter: ".missing? |= 7",
      stdinText: '{"a":1}\n',
    });

    expect(execution.stdout.text).toBe('{"a":1,"missing":7}\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("skips optional update paths that are incompatible with the input type", async () => {
    const execution = await execute({
      filter: ".missing? |= 7",
      stdinText: "[1,2,3]\n",
    });

    expect(execution.stdout.text).toBe("[1,2,3]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("keeps null unchanged when an update filter deletes a nested path", async () => {
    const execution = await execute({
      filter: ".a.b? |= empty",
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe("null\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("updates every path produced by a grouped path expression", async () => {
    const execution = await execute({
      filter: "(.a,.b) |= . + 1",
      stdinText: '{"a":1,"b":2}\n',
    });

    expect(execution.stdout.text).toBe('{"a":2,"b":3}\n');
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("deletes every array or object value selected by iteration update", async () => {
    const arrayExecution = await execute({
      filter: ".[] |= empty",
      stdinText: "[1,2,3]\n",
    });
    const objectExecution = await execute({
      filter: ".[] |= empty",
      stdinText: '{"a":1,"b":2}\n',
    });

    expect(arrayExecution.stdout.text).toBe("[]\n");
    expect(arrayExecution.stderr.text).toBe("");
    expect(arrayExecution.result.exitCode).toBe(0);
    expect(objectExecution.stdout.text).toBe("{}\n");
    expect(objectExecution.stderr.text).toBe("");
    expect(objectExecution.result.exitCode).toBe(0);
  });

  it("keeps every compound-assignment output", async () => {
    const execution = await execute({
      filter: ".a += (1,2)",
      stdinText: '{"a":10}\n',
    });

    expect(execution.stdout.text).toBe(`\
{"a":11}
{"a":12}
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("exposes the jq process environment through env and $ENV", async () => {
    const rootHandle = new MockFileSystemDirectoryHandle({ name: "root" });
    const environmentWesh = new Wesh({
      rootHandle: rootHandle as unknown as FileSystemDirectoryHandle,
      initialEnv: { FOO: "bar", EMPTY: "" },
    });
    await environmentWesh.init();
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await environmentWesh.execute({
      source: createTextShellSource({ text: `jq -nc '[env.FOO, $ENV.FOO, env.EMPTY, $ENV.EMPTY]'` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });
    const shadowed = await execute({
      filter: "def env: 1; env",
      options: "-nc",
    });

    expect(stdout.text).toBe('["bar","bar","",""]\n');
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
    expect(shadowed.stdout.text).toBe("1\n");
    expect(shadowed.stderr.text).toBe("");
    expect(shadowed.result.exitCode).toBe(0);
  });

  it("supports dynamic slice bounds on update paths", async () => {
    const assigned = await execute({
      filter: ".[$start:$end] = [8,9]",
      options: "--argjson start 1 --argjson end 3 -c",
      stdinText: "[0,1,2,3,4]\n",
    });
    const deleted = await execute({
      filter: "del(.[$start:$end])",
      options: "--argjson start 1 --argjson end 3 -c",
      stdinText: "[0,1,2,3,4]\n",
    });

    expect(assigned.stdout.text).toBe("[0,8,9,3,4]\n");
    expect(deleted.stdout.text).toBe("[0,3,4]\n");
    for (const outcome of [assigned, deleted]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("uses every output from dynamic slice bounds", async () => {
    const execution = await execute({
      filter: ".[(1,2):(3,4)] = [9]",
      options: "-c",
      stdinText: "[0,1,2,3,4]\n",
    });

    expect(execution.stdout.text).toBe("[0,9,9]\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("keeps optional outputs emitted before a runtime error", async () => {
    const execution = await execute({
      filter: '(1, error("boom"), 2)?',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe("1\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("reports Linux-compatible dynamic index type errors to catch", async () => {
    const execution = await execute({
      filter: 'try ([1,2] | .[(0,"x")] |= . + 1) catch ["error", .]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(
      '["error","Cannot index array with string \\"x\\""]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("truncates fractional array indexes for reads and updates", async () => {
    const read = await execute({
      filter: "[.[1.5], .[-1.5]]",
      stdinText: "[7]\n",
    });
    const update = await execute({
      filter: ".[1.5] |= 9",
      stdinText: "[7]\n",
    });

    expect(read.stdout.text).toBe("[null,7]\n");
    expect(update.stdout.text).toBe("[7,9]\n");
    for (const outcome of [read, update]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("reports Linux-compatible static index type errors to catch", async () => {
    const execution = await execute({
      filter:
        '[try ([1] | .["x"]) catch ., try ({a:1} | .[0]) catch ., try (true | .["x"]) catch .]',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(
      '["Cannot index array with string \\"x\\"","Cannot index object with number","Cannot index boolean with string \\"x\\""]\n',
    );
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
  });

  it("supports filter parameters in user-defined filters", async () => {
    const basic = await execute({
      filter: "def apply(f): f; apply(. + 1)",
      stdinText: "2\n",
    });
    const repeated = await execute({
      filter: "def twice(f): f | f; twice(. + 1)",
      stdinText: "1\n",
    });
    const mixed = await execute({
      filter: "def pair($x;f): [$x,f]; pair(.a;.b)",
      stdinText: '{"a":1,"b":2}\n',
    });

    expect(basic.stdout.text).toBe("3\n");
    expect(repeated.stdout.text).toBe("3\n");
    expect(mixed.stdout.text).toBe("[1,2]\n");
    for (const outcome of [basic, repeated, mixed]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("expands filter parameters without capturing caller variables", async () => {
    const execution = await execute({
      filter: "def apply(f): . as $x | f; 10 as $x | apply($x)",
      stdinText: "2\n",
    });
    const mixed = await execute({
      filter: "def pair($x;f): [$x,f]; 10 as $x | pair(1;$x)",
      stdinText: "null\n",
    });

    expect(execution.stdout.text).toBe("10\n");
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    expect(mixed.stdout.text).toBe("[1,10]\n");
    expect(mixed.stderr.text).toBe("");
    expect(mixed.result.exitCode).toBe(0);
  });

  it("supports jq label and break control flow", async () => {
    const partial = await execute({ filter: "label $out | (1,2,3) | if . == 2 then break $out else . end", options: "-nc" });
    const nested = await execute({ filter: "label $outer | label $inner | 1, break $outer, 2", options: "-nc" });
    const caught = await execute({ filter: 'label $out | try (1, break $out, 2) catch "caught"', options: "-nc" });
    const materialized = await execute({ filter: "[label $out | 1, break $out, 2]", options: "-nc" });
    const sameNameVariable = await execute({ filter: "1 as $x | label $x | $x", options: "-nc" });
    const keywordFields = await execute({
      filter: "{label, break: .break} | [.label, .break]",
      stdinText: `\
{"label":1,"break":2}
`,
      options: "-c",
    });
    const missing = await execute({ filter: "break $missing", options: "-nc" });

    expect(partial.stdout.text).toBe("1\n");
    expect(nested.stdout.text).toBe("1\n");
    expect(caught.stdout.text).toBe(`\
1
"caught"
`);
    expect(materialized.stdout.text).toBe("[1]\n");
    expect(sameNameVariable.stdout.text).toBe("1\n");
    expect(keywordFields.stdout.text).toBe("[1,2]\n");
    for (const outcome of [partial, nested, caught, materialized, sameNameVariable, keywordFields]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(missing.stderr.text).toContain("$*label-missing is not defined");
    expect(missing.result.exitCode).toBe(3);
  });

  it("supports lexically scoped local filter definitions", async () => {
    const scoped = await execute({
      filter: "[(def f: 1; f), (def f: 2; f)]",
      options: "-nc",
    });
    const shadowed = await execute({
      filter: "def f: 1; (def f: 2; f), f",
      options: "-nc",
    });
    const parameters = await execute({
      filter: "def value($x): $x + 1; def apply(f): f | f; [value(2), apply(.+1)]",
      options: "-nc",
    });
    const escaped = await execute({
      filter: "label $out | def f: 1, break $out, 2; f",
      options: "-nc",
    });
    const leaked = await execute({
      filter: "(def f: 1; f) | f",
      options: "-nc",
    });

    expect(scoped.stdout.text).toBe("[1,2]\n");
    expect(shadowed.stdout.text).toBe(`\
2
1
`);
    expect(parameters.stdout.text).toBe("[3,2]\n");
    expect(escaped.stdout.text).toBe("1\n");
    for (const execution of [scoped, shadowed, parameters, escaped]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(leaked.stdout.text).toBe("");
    expect(leaked.stderr.text).toContain("identifier 'f'");
    expect(leaked.result.exitCode).toBe(3);
  });

  it("supports self-recursive user definitions", async () => {
    const countdown = await execute({
      filter: "def f: if . > 0 then . - 1 | f else . end; 4 | f",
      options: "-nc",
    });
    const parameters = await execute({
      filter: "def f($n; g): if $n > 0 then g | f($n - 1; g) else . end; 3 | f(3; . - 1)",
      options: "-nc",
    });
    const generated = await execute({
      filter: "def f: ., (if . > 0 then . - 1 | f else empty end); 3 | f",
      options: "-nc",
    });
    const escaped = await execute({
      filter: "label $out | def f: if . > 0 then . - 1 | f else break $out end; 3 | f",
      options: "-nc",
    });
    const redefined = await execute({
      filter: "def f($n): $n; def f($n): if $n > 0 then f($n - 1) else 0 end; f(3)",
      options: "-nc",
    });
    const captured = await execute({
      filter: "def f: 1; def g: f; def f: 2; g, f",
      options: "-nc",
    });
    const demanded = await execute({
      filter: "def f: input as $x | $x, (if $x < 3 then f else empty end); f, input",
      options: "-nc",
      stdinText: `\
1
2
3
4
5
`,
    });

    expect(countdown.stdout.text).toBe("0\n");
    expect(parameters.stdout.text).toBe("0\n");
    expect(generated.stdout.text).toBe(`\
3
2
1
0
`);
    expect(escaped.stdout.text).toBe("");
    expect(redefined.stdout.text).toBe("0\n");
    expect(captured.stdout.text).toBe(`\
1
2
`);
    expect(demanded.stdout.text).toBe(`\
1
2
3
4
`);
    for (const execution of [countdown, parameters, generated, escaped, redefined, captured, demanded]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("captures user-definition variables from the declaration scope", async () => {
    const shadowed = await execute({
      filter: "1 as $x | def f: $x; 2 as $x | f",
      options: "-nc",
    });
    const restored = await execute({
      filter: "1 as $x | def f: $x; (2 as $x | f), f",
      options: "-nc",
    });
    const recursive = await execute({
      filter: "1 as $x | def f: if . > 0 then . - 1 | f else $x end; 2 as $x | 2 | f",
      options: "-nc",
    });
    const interpolated = await execute({
      filter: String.raw`1 as $x | def f: "v\($x)"; 2 as $x | f`,
      options: "-nr",
    });
    const dynamicCapture = await execute({
      filter: "def f: $x; 1 as $x | f",
      options: "-nc",
    });

    expect(shadowed.stdout.text).toBe("1\n");
    expect(restored.stdout.text).toBe(`\
1
1
`);
    expect(recursive.stdout.text).toBe("1\n");
    expect(interpolated.stdout.text).toBe("v1\n");
    for (const execution of [shadowed, restored, recursive, interpolated]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(dynamicCapture.stdout.text).toBe("");
    expect(dynamicCapture.stderr.text).toContain("$x is not defined");
    expect(dynamicCapture.result.exitCode).toBe(3);
  });

  it("defers unresolved calls in unused definitions", async () => {
    const unused = await execute({
      filter: "def f: missing; 1",
      options: "-nc",
    });
    const used = await execute({
      filter: "def f: missing; f",
      options: "-nc",
    });
    const unusedForwardReference = await execute({
      filter: "def f: g; def g: 1; 1",
      options: "-nc",
    });
    const usedForwardReference = await execute({
      filter: "def f: g; def g: 1; f",
      options: "-nc",
    });
    const unusedRecursiveBody = await execute({
      filter: "def f: if . then missing else f end; 1",
      options: "-nc",
    });
    const usedRecursiveBody = await execute({
      filter: "def f: if . then missing else f end; true | f",
      options: "-nc",
    });

    for (const execution of [unused, unusedForwardReference, unusedRecursiveBody]) {
      expect(execution.stdout.text).toBe("1\n");
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
    expect(used.stdout.text).toBe("");
    expect(used.stderr.text).toContain("missing/0 is not defined");
    expect(used.result.exitCode).toBe(3);
    expect(usedForwardReference.stdout.text).toBe("");
    expect(usedForwardReference.stderr.text).toContain("g/0 is not defined");
    expect(usedForwardReference.result.exitCode).toBe(3);
    expect(usedRecursiveBody.stdout.text).toBe("");
    expect(usedRecursiveBody.stderr.text).toContain("missing/0 is not defined");
    expect(usedRecursiveBody.result.exitCode).toBe(3);
  });

  it("inherits definition and control scope in string interpolation", async () => {
    const definitions = await execute({
      filter: String.raw`def f($x): $x + 1; "x\(f(2))y"`,
      options: "-nr",
    });
    const crossProduct = await execute({
      filter: String.raw`"\((1,2))\((3,4))"`,
      options: "-nr",
    });
    const demanded = await execute({
      filter: String.raw`"\((1,2))\(input)"`,
      options: "-nr",
      stdinText: `\
3
4
`,
    });
    const orderedDemand = await execute({
      filter: String.raw`"p0\(input)p1\(input)p2\((1,2))z"`,
      options: "-nr",
      stdinText: `\
3
4
5
6
`,
    });
    const broken = await execute({
      filter: String.raw`label $out | "a\((1,break $out,2))b"`,
      options: "-nr",
    });
    const nestedBreak = await execute({
      filter: String.raw`label $out | "p0\((1,break $out,2))p1\((1,2))z"`,
      options: "-nr",
    });
    const caught = await execute({
      filter: String.raw`try "\((1,error("first")))\((2,error("second")))" catch .`,
      options: "-nr",
    });

    expect(definitions.stdout.text).toBe("x3y\n");
    expect(crossProduct.stdout.text).toBe(`\
13
23
14
24
`);
    expect(demanded.stdout.text).toBe(`\
13
23
`);
    expect(orderedDemand.stdout.text).toBe(`\
p04p13p21z
p06p15p22z
`);
    expect(broken.stdout.text).toBe("a1b\n");
    expect(nestedBreak.stdout.text).toBe("p01p11z\n");
    expect(caught.stdout.text).toBe(`\
12
first
`);
    for (const execution of [
      definitions,
      crossProduct,
      demanded,
      orderedDemand,
      broken,
      nestedBreak,
      caught,
    ]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("preserves completed object branches before break or runtime failure", async () => {
    const broken = await execute({
      filter: "label $out | {a:(1, break $out, 2), b:2}",
      options: "-nc",
    });
    const caught = await execute({
      filter: 'label $out | try {a:(1,error("boom")),b:2} catch .',
      options: "-nc",
    });
    const demanded = await execute({
      filter: '{("a","b"): input}',
      options: "-nc",
      stdinText: `\
1
2
3
`,
    });

    expect(broken.stdout.text).toBe('{"a":1,"b":2}\n');
    expect(broken.stderr.text).toBe("");
    expect(broken.result.exitCode).toBe(0);
    expect(caught.stdout.text).toBe(`\
{"a":1,"b":2}
"boom"
`);
    expect(caught.stderr.text).toBe("");
    expect(caught.result.exitCode).toBe(0);
    expect(demanded.stdout.text).toBe(`\
{"a":1}
{"b":2}
`);
    expect(demanded.stderr.text).toBe("");
    expect(demanded.result.exitCode).toBe(0);
  });

  it("supports local and nested Oniguruma modifier groups", async () => {
    const execution = await execute({
      filter: String.raw`[
        test("a(?i:bc)d"),
        test("a(?-i:bc)d";"i"),
        test("(?i:a(?-i:b)c)"),
        test("a\\n(?m:^b$)"),
        test("x(?s:a.b)y"),
        test("a(?x:b c)d")
      ]`,
      stdinText: String.raw`"a\nb"` + "\n",
    });
    const caseExecution = await execute({
      filter: String.raw`[test("a(?i:bc)d"), test("(?i:a(?-i:b)c)")]`,
      stdinText: '"aBCd"\n',
    });

    expect(execution.stdout.text).toBe(
      "[false,false,false,true,false,false]\n",
    );
    expect(caseExecution.stdout.text).toBe("[true,false]\n");
    for (const outcome of [execution, caseExecution]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });
  it("advances ignore-empty matching and rejects unsafe backtracking", async () => {
    const ignoreEmpty = await execute({
      filter: String.raw`[test("a*";"n"), match("a*";"n").string]`,
      stdinText: '"baab"\n',
    });
    const unsafe = await execute({
      filter: String.raw`test("(a+)+$")`,
      stdinText: `${JSON.stringify(`${"a".repeat(100)}X`)}\n`,
    });
    const safe = await execute({
      filter: String.raw`test("(a+)$")`,
      stdinText: `${JSON.stringify("a".repeat(100))}\n`,
    });

    expect(ignoreEmpty.stdout.text).toBe('[true,"aa"]\n');
    expect(ignoreEmpty.result.exitCode).toBe(0);
    expect(unsafe.result.exitCode).toBe(5);
    expect(unsafe.stderr.text).toContain("safe backtracking limit");
    expect(safe.stdout.text).toBe("true\n");
    expect(safe.result.exitCode).toBe(0);
  });

  it("supports deterministic UTC ISO date conversion builtins", async () => {
    const formatted = await execute({
      filter: "[0, 1.9, -1, -62167219200, 253402300800] | map(todateiso8601)",
      options: "-nc",
    });
    const parsed = await execute({
      filter: String.raw`["0000-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "2023-02-30T00:00:00Z", "2023-01-01T00:00:60Z"] | map(fromdateiso8601)`,
      options: "-nc",
    });
    const aliases = await execute({
      filter: '"2000-02-29T12:34:56Z" | [fromdate, (fromdate | todate)]',
      options: "-nc",
    });
    const invalid = await execute({
      filter: '"2023-13-01T00:00:00Z" | fromdateiso8601',
      options: "-nc",
    });

    expect(formatted.stdout.text).toBe('["1970-01-01T00:00:00Z","1970-01-01T00:00:01Z","1969-12-31T23:59:59Z","0-01-01T00:00:00Z","10000-01-01T00:00:00Z"]\n');
    expect(parsed.stdout.text).toBe("[-62167219200,0,1677715200,1672531260]\n");
    expect(aliases.stdout.text).toBe('[951827696,"2000-02-29T12:34:56Z"]\n');
    for (const outcome of [formatted, parsed, aliases]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(invalid.stdout.text).toBe("");
    expect(invalid.stderr.text).toContain('date "2023-13-01T00:00:00Z" does not match format "%Y-%m-%dT%H:%M:%SZ"');
    expect(invalid.result.exitCode).toBe(5);
  });

  it("emits and reconstructs jq streaming events", async () => {
    const streamed = await execute({
      filter: "tostream",
      stdinText: '{"a":1,"b":[2],"c":[]}\n',
    });
    const roundTrip = await execute({
      filter: "fromstream(tostream)",
      stdinText: '{"a":1,"b":[2],"c":[]}\n',
    });
    const repeated = await execute({
      filter: "fromstream((tostream, tostream))",
      stdinText: "[1,2]\n",
    });

    expect(streamed.stdout.text).toBe(`\
[["a"],1]
[["b",0],2]
[["b",0]]
[["c"],[]]
[["c"]]
`);
    expect(roundTrip.stdout.text).toBe('{"a":1,"b":[2],"c":[]}\n');
    expect(repeated.stdout.text).toBe(`\
[1,2]
[1,2]
`);
    for (const execution of [streamed, roundTrip, repeated]) {
      expect(execution.stderr.text).toBe("");
      expect(execution.result.exitCode).toBe(0);
    }
  });

  it("truncates stream paths with jq slice and selection semantics", async () => {
    const execution = await execute({
      filter: String.raw`1 | truncate_stream(([["a","b"],1], [["a","c"],2], [["a","c"]], [["a"]]))`,
      options: "-nc",
    });
    const negative = await execute({
      filter: String.raw`-1 | truncate_stream(([["a"],1], [["a"]]))`,
      options: "-nc",
    });
    const nonNumeric = await execute({
      filter: String.raw`"1" | truncate_stream([["a"],1])`,
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
[["b"],1]
[["c"],2]
[["c"]]
`);
    expect(negative.stdout.text).toBe(`\
[["a"],1]
[["a"]]
`);
    expect(nonNumeric.stdout.text).toBe("");
    for (const outcome of [execution, negative, nonNumeric]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("preserves completed stream outputs before runtime failure", async () => {
    const reconstructed = await execute({
      filter: String.raw`fromstream(([[],1], error("boom")))`,
      options: "-nc",
    });
    const truncated = await execute({
      filter: String.raw`1 | truncate_stream(([ ["a","b"],1], error("boom")))`,
      options: "-nc",
    });

    expect(reconstructed.stdout.text).toBe("1\n");
    expect(reconstructed.stderr.text).toContain("boom");
    expect(reconstructed.result.exitCode).toBe(5);
    expect(truncated.stdout.text).toBe('[["b"],1]\n');
    expect(truncated.stderr.text).toContain("boom");
    expect(truncated.result.exitCode).toBe(5);
  });

  it("tracks input filename and line number across stdin values", async () => {
    const execution = await execute({
      filter: "[., input_filename, input_line_number]",
      stdinText: `\
1

2
`,
    });
    const raw = await execute({
      filter: "[., input_filename, input_line_number]",
      stdinText: `\
a

b
`,
      options: "-Rc",
    });

    expect(execution.stdout.text).toBe(`\
[1,"<stdin>",1]
[2,"<stdin>",3]
`);
    expect(raw.stdout.text).toBe(`\
["a","<stdin>",1]
["","<stdin>",2]
["b","<stdin>",3]
`);
    for (const outcome of [execution, raw]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("counts only completed raw input lines for an unterminated final record", async () => {
    const lines = await execute({
      filter: "[., input_filename, input_line_number]",
      stdinText: `\
a
b`,
      options: "-Rc",
    });
    const single = await execute({
      filter: "[., input_filename, input_line_number]",
      stdinText: "x",
      options: "-Rc",
    });
    const slurped = await execute({
      filter: "[., input_filename, input_line_number]",
      stdinText: `\
a
b`,
      options: "-Rsc",
    });

    expect(lines.stdout.text).toBe(`\
["a","<stdin>",1]
["b","<stdin>",1]
`);
    expect(single.stdout.text).toBe(`\
["x","<stdin>",0]
`);
    expect(slurped.stdout.text).toBe(String.raw`["a\nb","<stdin>",1]` + "\n");
    for (const outcome of [lines, single, slurped]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("updates input metadata when input consumes demanded values", async () => {
    const execution = await execute({
      filter: "[input, input_filename, input_line_number, input, input_filename, input_line_number]",
      stdinText: `\
1
2
`,
      options: "-nc",
    });
    const initial = await execute({
      filter: "[input_filename, input_line_number]",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe('[1,"<stdin>",1,2,"<stdin>",2]\n');
    expect(initial.stdout.text).toBe("[null,0]\n");
    for (const outcome of [execution, initial]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("restores primary metadata after slurped demand reaches end of input", async () => {
    const exhaustedInputs = await execute({
      filter: "[inputs, input_filename, input_line_number]",
      stdinText: `\
1
2
`,
      options: "-nsc",
    });
    const optionalPastEnd = await execute({
      filter: "[input, input?, input_filename, input_line_number]",
      stdinText: `\
a
b
`,
      options: "-Rnsc",
    });
    const stoppedBeforeEnd = await execute({
      filter: "[limit(1; inputs), input_filename, input_line_number]",
      stdinText: `\
1
2
`,
      options: "-nsc",
    });

    const discardedInputs = await execute({
      filter: "(inputs | empty), [input_filename, input_line_number]",
      stdinText: `\
1
2
`,
      options: "-nsc",
    });
    const discardedRawInputs = await execute({
      filter: "(inputs | empty), [input_filename, input_line_number]",
      stdinText: `\
a
b
`,
      options: "-Rnsc",
    });

    expect(exhaustedInputs.stdout.text).toBe("[[1,2],null,0]\n");
    expect(optionalPastEnd.stdout.text).toBe(String.raw`["a\nb\n",null,0]` + "\n");
    expect(stoppedBeforeEnd.stdout.text).toBe('[[1,2],"<stdin>",2]\n');
    expect(discardedInputs.stdout.text).toBe("[null,0]\n");
    expect(discardedRawInputs.stdout.text).toBe("[null,0]\n");
    for (const outcome of [
      exhaustedInputs,
      optionalPastEnd,
      stoppedBeforeEnd,
      discardedInputs,
      discardedRawInputs,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("retains final input metadata for slurped values", async () => {
    const json = await execute({
      filter: "[input_filename, input_line_number]",
      stdinText: `\
1

2
`,
      options: "-sc",
    });
    const raw = await execute({
      filter: "[input_filename, input_line_number]",
      stdinText: `\
a

b
`,
      options: "-Rsc",
    });

    expect(json.stdout.text).toBe('["<stdin>",3]\n');
    expect(raw.stdout.text).toBe('["<stdin>",3]\n');
    for (const outcome of [json, raw]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("keeps per-value metadata when inputs spans multiple files", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: String.raw`printf '1\n\n2\n' > first.json
printf '{\n  "value": 3\n}\n4\n' > second.json
jq -nc 'inputs | [., input_filename, input_line_number]' first.json second.json` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
[1,"first.json",1]
[2,"first.json",3]
[{"value":3},"second.json",3]
[4,"second.json",4]
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("treats positional files as one lexical JSON and raw stream", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '1' > number-first.json
printf '2\n' > number-second.json
jq -c '[., input_filename, input_line_number]' number-first.json number-second.json
printf '{}' > structured-first.json
printf '[]\n' > structured-second.json
jq -c '[., input_filename, input_line_number]' structured-first.json structured-second.json
printf 'a' > raw-first.txt
printf 'b\n' > raw-second.txt
jq -Rc '[., input_filename, input_line_number]' raw-first.txt raw-second.txt
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
[12,"number-second.json",1]
[{},"structured-first.json",0]
[[],"structured-second.json",1]
["ab","raw-second.txt",1]
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("opens later positional files only when a lexical boundary requires them", async () => {
    const structuredStdout = createTestWriteCaptureHandle();
    const structuredStderr = createTestWriteCaptureHandle();
    const structured = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '{}' > first.json
jq -nc 'first(inputs)' first.json missing.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: structuredStdout.handle,
      stderr: structuredStderr.handle,
    });
    const primitiveStdout = createTestWriteCaptureHandle();
    const primitiveStderr = createTestWriteCaptureHandle();
    const primitive = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '1' > first.json
jq -nc 'first(inputs)' first.json missing.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: primitiveStdout.handle,
      stderr: primitiveStderr.handle,
    });
    const continuedStdout = createTestWriteCaptureHandle();
    const continuedStderr = createTestWriteCaptureHandle();
    const continued = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '1' > first.json
printf '2\n' > second.json
jq -nc 'first(inputs)' first.json second.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: continuedStdout.handle,
      stderr: continuedStderr.handle,
    });
    const rawStdout = createTestWriteCaptureHandle();
    const rawStderr = createTestWriteCaptureHandle();
    const raw = await wesh.execute({
      source: createTextShellSource({ text: `\
printf 'a' > first.txt
jq -Rnc 'first(inputs)' first.txt missing.txt
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: rawStdout.handle,
      stderr: rawStderr.handle,
    });

    expect(structuredStdout.text).toBe("{}\n");
    expect(structuredStderr.text).toBe("");
    expect(structured.exitCode).toBe(0);
    expect(primitiveStdout.text).toBe("1\n");
    expect(primitiveStderr.text).toBe(
      "jq: error: Could not open file missing.json: No such file or directory\n",
    );
    expect(primitive.exitCode).toBe(2);
    expect(continuedStdout.text).toBe("12\n");
    expect(continuedStderr.text).toBe("");
    expect(continued.exitCode).toBe(0);
    expect(rawStdout.text).toBe('"a"\n');
    expect(rawStderr.text).toBe(
      "jq: error: Could not open file missing.txt: No such file or directory\n",
    );
    expect(raw.exitCode).toBe(2);
  });

  it("recovers from parse events across positional file boundaries", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '1,' > first.json
printf '2\n3\n' > second.json
jq -nc 'try input catch "caught", inputs' first.json second.json
printf '1' > first.json
printf ',2\n3\n' > second.json
jq -nc 'try input catch "caught", inputs' first.json second.json
printf 'tr' > first.json
printf 'ue\n2\n' > second.json
jq -nc 'try input catch "caught", inputs' first.json second.json
printf '{' > first.json
printf ']\n2\n' > second.json
jq -nc 'try input catch "caught", inputs' first.json second.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"caught"
2
3
"caught"
3
true
2
"caught"
2
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("stops malformed structured events at the current file recovery boundary", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '[1,,' > first.json
jq -nc 'try input catch "caught"' first.json missing.json
printf '[1,,' > first.json
printf '2]\n0\n1\n' > second.json
jq -nc 'try input catch "caught", try input catch "caught2", inputs' first.json second.json
printf '[1,,2] 0\n1\n' > same-line.json
jq -nc 'try input catch "caught", inputs' same-line.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"caught"
"caught"
"caught2"
0
1
"caught"
1
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("preserves jq parser-buffer recovery across positional file boundaries", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '[[1,2],[3,4[' > first.json
printf ']] 6\n1' > second.json
printf '139\n' > third.json
jq -nc 'try input catch "caught1", try input catch "caught2", inputs' first.json second.json third.json
printf '{{"nested":{"' > first.json
printf 'left":false,"right":[null,5]}} 0\n1070\n' > second.json
jq -nc 'try input catch "caught", inputs' first.json second.json
printf '%s' '{"bad\\q"' > first.json
printf ':1} 9\n10\n' > second.json
jq -nc 'try input catch "caught1", try input catch "caught2", inputs' first.json second.json
printf '[1{ ' > first.json
printf '2\n1254\n' > second.json
jq -nc 'try input catch "caught", inputs' first.json second.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"caught1"
"caught2"
1139
"caught"
1070
"caught1"
"caught2"
10
"caught"
2
1254
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("preserves split UTF-8 parser-buffer recovery diagnostics", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const malformedPrefix = "[1,,2]";
    const splitOffset = 4094;
    const input = `${malformedPrefix}${" ".repeat(splitOffset - malformedPrefix.length)}é\n1\n`;
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
jq -nc 'try input catch empty, inputs'
` }),
      stdin: createTestReadHandleFromText({ text: input }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe("");
    expect(stderr.text).toBe(
      "jq: error (at <stdin>:1): Invalid numeric literal at line 2, column 0\n",
    );
    expect(result.exitCode).toBe(5);
  });

  it("resumes after a caught split UTF-8 recovery error at newline", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const malformedPrefix = "[1,,2]";
    const splitOffset = 4094;
    const input = `${malformedPrefix}${" ".repeat(splitOffset - malformedPrefix.length)}é\n1\n`;
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
jq -nc 'try input catch "first", try input catch ., inputs'
` }),
      stdin: createTestReadHandleFromText({ text: input }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"first"
"Invalid numeric literal at line 2, column 0"
1
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("discards the current parser buffer after split UTF-8 recovery at space", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const malformedPrefix = "[1,,2]";
    const splitOffset = 4094;
    const tokenTail = "x".repeat(4095);
    const input = `${malformedPrefix}${" ".repeat(splitOffset - malformedPrefix.length)}é${tokenTail} 1\n2\n`;
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
jq -nc 'try input catch "first", try input catch ., inputs'
` }),
      stdin: createTestReadHandleFromText({ text: input }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"first"
"Invalid numeric literal at line 1, column 4101"
2
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("recovers through recursively split UTF-8 parser buffers", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const malformedPrefix = "[1,,2]";
    const firstPadding = " ".repeat(4094 - malformedPrefix.length);
    const beforeSecond = `${malformedPrefix}${firstPadding}éx `;
    const secondPadding = " ".repeat(
      8189 - new TextEncoder().encode(beforeSecond).byteLength,
    );
    const input = `${beforeSecond}${secondPadding}é\n1\n`;
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
jq -nc 'try input catch "first", try input catch ("second:" + .), try input catch ("third:" + .), inputs'
` }),
      stdin: createTestReadHandleFromText({ text: input }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"first"
"second:Invalid numeric literal at line 1, column 7"
"third:Invalid numeric literal at line 2, column 0"
1
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("discards the rest of a physical line after a caught parse error", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: `\
printf '%s\n' '"bad\\q" 0' '1' > invalid-string.json
jq -nc 'try input catch "caught", inputs' invalid-string.json
printf '%s\n' 'bad 0' '1' > bare-word.json
jq -nc 'try input catch "caught", inputs' bare-word.json
` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
"caught"
1
"caught"
1
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("keeps per-value input metadata through value bindings", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: String.raw`printf '1\n' > first.json
printf '2\n' > second.json
jq -nc 'inputs as $x | [$x, input_filename, input_line_number]' first.json second.json
jq -nc 'inputs | . as $x | [$x, input_filename, input_line_number]' first.json second.json` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
[1,"first.json",1]
[2,"second.json",1]
[1,"first.json",1]
[2,"second.json",1]
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("propagates nested input metadata through evaluator combinators", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: String.raw`printf '\n1\n' > first.json
printf '\n\n2\n' > second.json
jq -nc '(inputs + 1) | [., input_filename, input_line_number]' first.json second.json
jq -nc 'if inputs then [., input_filename, input_line_number] else empty end' first.json second.json
jq -nc 'foreach inputs as $x (0; . + $x; [., input_filename, input_line_number])' first.json second.json
jq -nc '{value: inputs, source: input_filename, line: input_line_number}' first.json second.json` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
[2,"first.json",2]
[3,"second.json",3]
[null,"first.json",2]
[null,"second.json",3]
[1,"first.json",2]
[3,"second.json",3]
{"value":1,"source":"first.json","line":2}
{"value":2,"source":"second.json","line":3}
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });


  it("propagates input metadata through selector, range, path, and error generators", async () => {
    const stdout = createTestWriteCaptureHandle();
    const stderr = createTestWriteCaptureHandle();
    const result = await wesh.execute({
      source: createTextShellSource({ text: String.raw`printf '\n2\n' > first.json
printf '\n\n3\n' > second.json
jq -nc 'select(inputs) | [., input_filename, input_line_number]' first.json second.json
jq -nc 'range(0; inputs) | [., input_filename, input_line_number]' first.json second.json
jq -nc 'setpath(["x"]; inputs) | [., input_filename, input_line_number]' first.json second.json
jq -nc '.x = inputs | [., input_filename, input_line_number]' first.json second.json
jq -nc '.x |= inputs | [., input_filename, input_line_number]' first.json second.json
jq -nc 'try error(inputs) catch [., input_filename, input_line_number]' first.json second.json` }),
      stdin: createTestReadHandleFromText({ text: "" }),
      stdout: stdout.handle,
      stderr: stderr.handle,
    });

    expect(stdout.text).toBe(`\
[null,"first.json",2]
[null,"second.json",3]
[0,"first.json",2]
[1,"first.json",2]
[0,"second.json",3]
[1,"second.json",3]
[2,"second.json",3]
[{"x":2},"first.json",2]
[{"x":3},"second.json",3]
[{"x":2},"first.json",2]
[{"x":3},"second.json",3]
[{"x":2},"first.json",2]
[2,"first.json",2]
`);
    expect(stderr.text).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("converts between epoch seconds and parsed UTC datetime arrays", async () => {
    const parsed = await execute({
      filter: "[0, 1.9, -0.1, -1.9, 951827696, -62167219200, 253402300800] | map(gmtime)",
      options: "-nc",
    });
    const epochs = await execute({
      filter: String.raw`[
        [1970,0,1,0,0,0,4,0],
        [2000,1,29,12,34,56,2,59],
        [2023,1,30,0,0,0,0,0],
        [2023,12,1,0,0,0,0,0],
        [2023,-1,1,0,0,0,0,0],
        [2023,0,1,0,0,60,0,0]
      ] | map(mktime)`,
      options: "-nc",
    });
    const invalid = await execute({
      filter: "[1970,0,1,0,0,0] | mktime",
      options: "-nc",
    });

    expect(parsed.stdout.text).toBe(`\
[[1970,0,1,0,0,0,4,0],[1970,0,1,0,0,1.9,4,0],[1970,0,1,0,0,0.9,4,0],[1969,11,31,23,59,59.1,3,364],[2000,1,29,12,34,56,2,59],[0,0,1,0,0,0,6,0],[10000,0,1,0,0,0,6,0]]
`);
    expect(epochs.stdout.text).toBe(
      "[0,951827696,1677715200,1704067200,1669852800,1672531260]\n",
    );
    for (const outcome of [parsed, epochs]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(invalid.stdout.text).toBe("");
    expect(invalid.stderr.text).toContain("mktime requires parsed datetime inputs");
    expect(invalid.result.exitCode).toBe(5);
  });

  it("formats parsed UTC datetime values with common strftime conversions", async () => {
    const execution = await execute({
      filter: String.raw`[2000,1,29,12,34,56,2,59] | [
        strftime("%Y-%m-%dT%H:%M:%SZ"),
        strftime("%F %T"),
        strftime("%a %A %b %B %c %x %X"),
        strftime("%j %w %u %U %W %V %G %g"),
        strftime("%I:%M:%S %p %z %Z %s"),
        strftime("%D %R %h %e %% %n %t")
      ]`,
      options: "-nc",
    });
    const epoch = await execute({
      filter: "[0, 0.9, -0.1] | map(strftime(\"%Y-%m-%d %H:%M:%S %s\"))",
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
["2000-02-29T12:34:56Z","2000-02-29 12:34:56","Tue Tuesday Feb February Tue Feb 29 12:34:56 2000 02/29/00 12:34:56","060 2 2 09 09 09 2000 00","12:34:56 PM +0000 UTC 951827696","02/29/00 12:34 Feb 29 % \\n \\t"]
`);
    expect(epoch.stdout.text).toBe(`\
["1970-01-01 00:00:00 0","1970-01-01 00:00:00 0","1970-01-01 00:00:00 0"]
`);
    for (const outcome of [execution, epoch]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });

  it("parses common C-locale datetime formats into jq datetime arrays", async () => {
    const execution = await execute({
      filter: String.raw`[
        ("2000-02-29T12:34:56Z" | strptime("%Y-%m-%dT%H:%M:%SZ")),
        ("2000-02-29 12:34:56" | strptime("%F %T")),
        ("Tue Feb 29 12:34:56 2000" | strptime("%a %b %d %T %Y")),
        ("02/29/00 12:34:56 PM" | strptime("%m/%d/%y %I:%M:%S %p")),
        ("951827696" | strptime("%s")),
        ("2000" | strptime("%Y")),
        ("Tue" | strptime("%a"))
      ]`,
      options: "-nc",
    });
    const invalid = await execute({
      filter: '"2000x" | strptime("%Y")',
      options: "-nc",
    });

    expect(execution.stdout.text).toBe(`\
[[2000,1,29,12,34,56,2,59],[2000,1,29,12,34,56,2,59],[2000,1,29,12,34,56,2,59],[2000,1,29,12,34,56,2,59],[2000,1,29,12,34,56,2,59],[2000,0,0,0,0,0,5,-1],[1900,0,0,0,0,0,2,367]]
`);
    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    expect(invalid.stdout.text).toBe("");
    expect(invalid.stderr.text).toContain('date "2000x" does not match format "%Y"');
    expect(invalid.result.exitCode).toBe(5);
  });


  it("converts and formats local timezone datetime values", async () => {
    const converted = await execute({
      filter: "[0, -0.1, 1720000000] | map(localtime)",
      options: "-nc",
    });
    const formatted = await execute({
      filter: String.raw`0 | [
        strflocaltime("%Y-%m-%d %H:%M:%S"),
        strflocaltime(("%Y", "%m"))
      ]`,
      options: "-nc",
    });
    const invalid = await execute({
      filter: '"x" | localtime',
      options: "-nc",
    });

    const expectedLocaltime = ({ value }: { value: number }): JsonValue[] => {
      const wholeSeconds = Math.trunc(value);
      const fraction = value - Math.floor(value);
      const date = new Date(wholeSeconds * 1_000);
      const year = date.getFullYear();
      const start = Date.UTC(year, 0, 1);
      const current = Date.UTC(year, date.getMonth(), date.getDate());
      return [
        year,
        date.getMonth(),
        date.getDate(),
        date.getHours(),
        date.getMinutes(),
        date.getSeconds() + fraction,
        date.getDay(),
        Math.floor((current - start) / 86_400_000),
      ];
    };
    const epoch = new Date(0);
    const dateText = [
      String(epoch.getFullYear()).padStart(4, "0"),
      String(epoch.getMonth() + 1).padStart(2, "0"),
      String(epoch.getDate()).padStart(2, "0"),
    ].join("-");
    const timeText = [
      String(epoch.getHours()).padStart(2, "0"),
      String(epoch.getMinutes()).padStart(2, "0"),
      String(epoch.getSeconds()).padStart(2, "0"),
    ].join(":");

    expect(converted.stdout.text).toBe(`${JSON.stringify([
      expectedLocaltime({ value: 0 }),
      expectedLocaltime({ value: -0.1 }),
      expectedLocaltime({ value: 1720000000 }),
    ])}\n`);
    expect(formatted.stdout.text).toBe(`${JSON.stringify([
      `${dateText} ${timeText}`,
      String(epoch.getFullYear()),
      String(epoch.getMonth() + 1).padStart(2, "0"),
    ])}\n`);
    for (const outcome of [converted, formatted]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(invalid.stdout.text).toBe("");
    expect(invalid.stderr.text).toContain("localtime() requires numeric inputs");
    expect(invalid.result.exitCode).toBe(5);
  });

  it("emits jq debug and raw stderr side effects without changing values", async () => {
    const debugged = await execute({
      filter: '1 | debug((2,3)) | . + 1',
      options: "-nc",
    });
    const raw = await execute({
      filter: '("x", [1,2]) | stderr',
      options: "-nc",
    });
    const failed = await execute({
      filter: '1 | debug((2,error("boom")))',
      options: "-nc",
    });

    expect(debugged.stdout.text).toBe("2\n");
    expect(debugged.stderr.text).toBe(`\
["DEBUG:",2]
["DEBUG:",3]
`);
    expect(debugged.result.exitCode).toBe(0);
    expect(raw.stdout.text).toBe(`\
"x"
[1,2]
`);
    expect(raw.stderr.text).toBe("x[1,2]");
    expect(raw.result.exitCode).toBe(0);
    expect(failed.stdout.text).toBe("");
    expect(failed.stderr.text).toBe(`\
["DEBUG:",2]
jq: error: boom
`);
    expect(failed.result.exitCode).toBe(5);
  });

  it("does not duplicate debug events during demand-driven input replay", async () => {
    const execution = await execute({
      filter: "debug(inputs)",
      options: "-nc",
      stdinText: `\
1
2
`,
    });

    expect(execution.stdout.text).toBe("null\n");
    expect(execution.stderr.text).toBe(`\
["DEBUG:",1]
["DEBUG:",2]
`);
    expect(execution.result.exitCode).toBe(0);
  });

  it("honors non-catchable jq halt and halt_error control signals", async () => {
    const haltedSequence = await execute({
      filter: "1,halt,2",
      options: "-nc",
    });
    const haltedCollection = await execute({
      filter: "[1,halt,2]",
      options: "-nc",
    });
    const attemptedCatch = await execute({
      filter: "try halt catch 9",
      options: "-nc",
    });
    const failed = await execute({
      filter: '1,("boom" | halt_error(7)),2',
      options: "-nc",
    });
    const attemptedErrorCatch = await execute({
      filter: 'try ("boom" | halt_error(8)) catch 9',
      options: "-nc",
    });

    expect(haltedSequence.stdout.text).toBe("1\n");
    expect(haltedSequence.stderr.text).toBe("");
    expect(haltedSequence.result.exitCode).toBe(0);
    for (const outcome of [haltedCollection, attemptedCatch]) {
      expect(outcome.stdout.text).toBe("");
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(failed.stdout.text).toBe("1\n");
    expect(failed.stderr.text).toBe("boom");
    expect(failed.result.exitCode).toBe(7);
    expect(attemptedErrorCatch.stdout.text).toBe("");
    expect(attemptedErrorCatch.stderr.text).toBe("boom");
    expect(attemptedErrorCatch.result.exitCode).toBe(8);
  });

  it("matches jq halt_error exit-code and argument generator rules", async () => {
    const wrapped = await execute({
      filter: "1 | halt_error(257)",
      options: "-nc",
    });
    const negative = await execute({
      filter: "null | halt_error(-2.9)",
      options: "-nc",
    });
    const fractional = await execute({
      filter: "[1,2] | halt_error(5.9)",
      options: "-nc",
    });
    const firstArgument = await execute({
      filter: '"x" | halt_error((7,8))',
      options: "-nc",
    });
    const emptyArgument = await execute({
      filter: "1 | halt_error(empty)",
      options: "-nc",
    });

    expect(wrapped.stdout.text).toBe("");
    expect(wrapped.stderr.text).toBe("1\n");
    expect(wrapped.result.exitCode).toBe(1);
    expect(negative.stdout.text).toBe("");
    expect(negative.stderr.text).toBe("");
    expect(negative.result.exitCode).toBe(0);
    expect(fractional.stdout.text).toBe("");
    expect(fractional.stderr.text).toBe("[1,2]\n");
    expect(fractional.result.exitCode).toBe(5);
    expect(firstArgument.stdout.text).toBe("");
    expect(firstArgument.stderr.text).toBe("x");
    expect(firstArgument.result.exitCode).toBe(7);
    expect(emptyArgument.stdout.text).toBe("");
    expect(emptyArgument.stderr.text).toBe("");
    expect(emptyArgument.result.exitCode).toBe(0);
  });

  it("does not duplicate jq side effects before demand-driven halt", async () => {
    const execution = await execute({
      filter: "debug(input), halt",
      options: "-nc",
      stdinText: `\
1
2
`,
    });

    expect(execution.stdout.text).toBe("null\n");
    expect(execution.stderr.text).toBe(`\
["DEBUG:",1]
`);
    expect(execution.result.exitCode).toBe(0);
  });

  it("returns a finite current epoch timestamp from now", async () => {
    const before = Date.now() / 1000;
    const execution = await execute({
      filter: "[now, (1 | now), (now | type), (now | isfinite), (now | gmtime | length)]",
      options: "-nc",
    });
    const after = Date.now() / 1000;

    expect(execution.stderr.text).toBe("");
    expect(execution.result.exitCode).toBe(0);
    const output = JSON.parse(execution.stdout.text) as [number, number, string, boolean, number];
    for (const timestamp of output.slice(0, 2)) {
      expect(Number.isFinite(timestamp)).toBe(true);
      expect(timestamp).toBeGreaterThanOrEqual(before - 0.1);
      expect(timestamp).toBeLessThanOrEqual(after + 0.1);
    }
    expect(output.slice(2)).toEqual(["number", true, 8]);
  });


  it("preserves jq decimal source representations until arithmetic computes a value", async () => {
    const topLevelInput = await execute({
      filter: ".",
      stdinText: "1e-7\n",
    });
    const nestedInput = await execute({
      filter: ".[0], .[1], .[2]",
      stdinText: "[1e-7,9007199254740993,1e-400]\n",
    });
    const mapped = await execute({
      filter: "map(.)",
      stdinText: "[1e-7,1.00]\n",
    });
    const setPath = await execute({
      filter: "setpath([0]; 2e-7)",
      stdinText: "[1e-7]\n",
    });
    const updated = await execute({
      filter: ".[0] |= .",
      stdinText: "[1e-7]\n",
    });
    const computed = await execute({
      filter: "1e-7 + 0",
      options: "-nc",
    });
    const exact = await execute({
      filter: "[9007199254740993 > 9007199254740992, 1e-400 > 0, ([9007199254740993,9007199254740992] | sort)]",
      options: "-nc",
    });
    const fromJson = await execute({
      filter: '"[123456789012345678901234567890,0e999]" | fromjson',
      options: "-nc",
    });
    const toNumber = await execute({
      filter: '["1e400","-1e-400","9007199254740993","1.2300e+20"] | map(tonumber)',
      options: "-nc",
    });
    const grouped = await execute({
      filter: "[9007199254740992,9007199254740993,9007199254740992] | group_by(.)",
      options: "-nc",
    });
    const collections = await execute({
      filter: "[[9007199254740992],[1e-7,[1.00]]] | flatten",
      options: "-nc",
    });

    expect(topLevelInput.stdout.text).toBe("1E-7\n");
    expect(nestedInput.stdout.text).toBe(`\
1E-7
9007199254740993
1E-400
`);
    expect(mapped.stdout.text).toBe("[1E-7,1.00]\n");
    expect(setPath.stdout.text).toBe("[2E-7]\n");
    expect(updated.stdout.text).toBe("[1E-7]\n");
    expect(computed.stdout.text).toBe("1e-07\n");
    expect(exact.stdout.text).toBe("[true,true,[9007199254740992,9007199254740993]]\n");
    expect(fromJson.stdout.text).toBe("[123456789012345678901234567890,0E+999]\n");
    expect(toNumber.stdout.text).toBe("[1E+400,-1E-400,9007199254740993,1.2300E+20]\n");
    expect(grouped.stdout.text).toBe("[[9007199254740992,9007199254740992],[9007199254740993]]\n");
    expect(collections.stdout.text).toBe("[9007199254740992,1E-7,1.00]\n");
    for (const outcome of [
      topLevelInput,
      nestedInput,
      mapped,
      setPath,
      updated,
      computed,
      exact,
      fromJson,
      toNumber,
      grouped,
      collections,
    ]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });


  it("evaluates single-argument builtin streams once per argument output", async () => {
    const finite = await execute({
      filter: String.raw`([1,3,5] | bsearch((3e0,4e0))), ("abc" | startswith(("a","z"))), ("a,b-c" | split((",","-")))`,
      options: "-nc",
    });
    const boundedInfinite = await execute({
      filter: String.raw`limit(1; [1,3,5] | bsearch((3,repeat(4))))`,
      options: "-nc",
    });

    expect(finite.stdout.text).toBe(`1
-3
true
false
["a","b-c"]
["a,b","c"]
`);
    expect(boundedInfinite.stdout.text).toBe("1\n");
    for (const outcome of [finite, boundedInfinite]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
  });


  it("reuses combinations count filters through range semantics", async () => {
    const finite = await execute({
      filter: String.raw`[0,1] | combinations((1,2))`,
      options: "-nc",
    });
    const empty = await execute({
      filter: String.raw`[0,1] | combinations(empty)`,
      options: "-nc",
    });
    const fractionalAndNegative = await execute({
      filter: String.raw`[0,1] | combinations((-2,1.5,0.5))`,
      options: "-nc",
    });
    const inputConsumption = await execute({
      filter: String.raw`([0,1] | combinations((input,input))), input`,
      stdinText: `\
1
2
3
`,
      options: "-nc",
    });
    const lateFailure = await execute({
      filter: String.raw`[0,1] | combinations((1,error("combination-late")))`,
      options: "-nc",
    });

    const widthThree = `[0,0,0]
[0,0,1]
[0,1,0]
[0,1,1]
[1,0,0]
[1,0,1]
[1,1,0]
[1,1,1]
`;
    expect(finite.stdout.text).toBe(widthThree);
    expect(empty.stdout.text).toBe("[]\n");
    expect(fractionalAndNegative.stdout.text).toBe(widthThree);
    expect(inputConsumption.stdout.text).toBe(`${widthThree}3\n`);
    for (const outcome of [finite, empty, fractionalAndNegative, inputConsumption]) {
      expect(outcome.stderr.text).toBe("");
      expect(outcome.result.exitCode).toBe(0);
    }
    expect(lateFailure.stdout.text).toBe("");
    expect(lateFailure.stderr.text).toContain("combination-late");
    expect(lateFailure.result.exitCode).toBe(5);
  });


  it("preserves regex pattern, flags, and replacement stream ordering", async () => {
    const outcome = await execute({
      filter: String.raw`[
        ["aA" | test(("a","A"); ("","i"))],
        ["aA" | scan(("a","A"); ("","i"))],
        ["abA" | splits(("a","A"); ("","i"))],
        ["aba" | sub(("a","b"); ("x","y"))]
      ]`,
      options: "-nc",
    });

    expect(outcome.stdout.text).toBe(
      `[[true,true,true,true],["a","a","A","A","a","A"],["","","b","","ab","","b",""],["xba","yba","axa","aya"]]\n`,
    );
    expect(outcome.stderr.text).toBe("");
    expect(outcome.result.exitCode).toBe(0);
  });

  it("cancels regex argument streams and keeps replacement failures atomic", async () => {
    const demandDriven = await execute({
      filter: String.raw`(limit(1; "aA" | test(inputs; ""))), inputs`,
      stdinText: `"a"\n"z"\n`,
      options: "-nc",
    });
    const replacementFailure = await execute({
      filter: String.raw`"aba" | sub("a"; ("x",error("replacement-late")))`,
      options: "-nc",
    });

    expect(demandDriven.stdout.text).toBe("true\n\"z\"\n");
    expect(demandDriven.stderr.text).toBe("");
    expect(demandDriven.result.exitCode).toBe(0);
    expect(replacementFailure.stdout.text).toBe("");
    expect(replacementFailure.stderr.text).toContain("replacement-late");
    expect(replacementFailure.result.exitCode).toBe(5);
  });

});
