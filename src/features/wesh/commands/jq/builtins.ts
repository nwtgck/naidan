import type { JsonValue, JqBuiltinName, JqFilter, JqPath } from './ast';
import { parseJsonValueWithNumberOrigins } from './json';
import { JQ_MAX_MATERIALIZED_VALUE_LENGTH } from './limits';
import {
  createJqNumberOrigin,
  getJsonChildNumberOrigin,
  setJsonChildNumberOrigin,
  type JqNumberOrigin,
} from './number-origin';
import {
  applyPathDeletions,
  applyPathUpdate,
  materializeJqPathExpression,
  readJqPathValue,
} from './path';
import { extractPathExpression } from './parser';
import type {
  JqRuntimeError,
  JqRuntimeFilterEvaluator,
  JqRuntimeInputMetadata,
  JqRuntimeResult,
} from './runtime';
import {
  codePointOffset,
  collectJqRegularExpressionMatches,
  compileJqRegularExpression,
  type CompileJqRegularExpressionResult,
  type JqRegularExpressionMatch,
  JqRegularExpressionRuntimeError,
} from './regexp';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  formatJqIndexError,
  isJsonObject,
  jsonObjectEntries,
  jsonObjectKeys,
  jsonObjectValues,
  jsonValuesEqual,
  mergeJsonObjects,
  normalizeJqArithmeticResult,
  stringifyJson,
  toJqArithmeticNumber,
} from './value';

function evaluateRegularExpressionMatches({
  input,
  compiled,
  global,
}: {
  input: string;
  compiled: Extract<CompileJqRegularExpressionResult, { readonly ok: true }>;
  global: boolean;
}):
  | { readonly ok: true; readonly matches: readonly JqRegularExpressionMatch[] }
  | { readonly ok: false; readonly error: JqRuntimeError } {
  try {
    return {
      ok: true,
      matches: collectJqRegularExpressionMatches({ input, compiled, global }),
    };
  } catch (error: unknown) {
    if (error instanceof JqRegularExpressionRuntimeError) {
      return { ok: false, error: { message: error.message } };
    }
    throw error;
  }
}

function runtimeFailureOutputs({
  result,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
}): JsonValue[] {
  return result.outputs ?? [];
}

function replaceRuntimeFailureOutputs({
  result,
  outputs,
  outputMetadata,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
  outputs: JsonValue[],
  outputMetadata?: JqRuntimeInputMetadata[],
}): Extract<JqRuntimeResult, { ok: false }> {
  const { outputMetadata: _discardedOutputMetadata, ...rest } = result;
  return outputMetadata === undefined
    ? { ...rest, outputs }
    : { ...rest, outputs, outputMetadata };
}

function metadataForRuntimeOutput({
  result,
  index,
  fallback,
}: {
  result: JqRuntimeResult,
  index: number,
  fallback: JqRuntimeInputMetadata,
}): JqRuntimeInputMetadata {
  return result.outputMetadata?.[index] ?? fallback;
}

function clearRuntimeFailureOutputs({
  result,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
}): Extract<JqRuntimeResult, { ok: false }> {
  return replaceRuntimeFailureOutputs({ result, outputs: [] });
}

function constrainRuntimeInputRequest({
  result,
  maximumValues,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
  maximumValues: number,
}): Extract<JqRuntimeResult, { ok: false }> {
  if (result.inputRequest === undefined) return result;
  return {
    ...result,
    inputRequest: {
      maximumValues: result.inputRequest.maximumValues === undefined
        ? maximumValues
        : Math.min(result.inputRequest.maximumValues, maximumValues),
    },
  };
}

function truthy({
  value,
}: {
  value: JsonValue,
}): boolean {
  return value !== false && value !== null;
}

function appendMaterializedValues({
  target,
  source,
}: {
  target: JsonValue[],
  source: readonly JsonValue[],
}): boolean {
  if (source.length > JQ_MAX_MATERIALIZED_VALUE_LENGTH - target.length) return false;
  for (const value of source) target.push(value);
  return true;
}

function stringifyForFormat({
  value,
  numberOrigin,
}: {
  value: JsonValue,
  numberOrigin?: JqNumberOrigin,
}): string {
  return typeof value === 'string'
    ? value
    : stringifyJson({
      value,
      indentation: undefined,
      sortKeys: false,
      asciiOnly: false,
      numberOrigin,
    });
}

function metadataWithoutNumberOrigin({
  metadata,
}: {
  metadata: JqRuntimeInputMetadata,
}): JqRuntimeInputMetadata {
  if (metadata.numberOrigin === undefined) return metadata;
  const { numberOrigin: _numberOrigin, ...source } = metadata;
  return source;
}

function metadataWithNumberOrigin({
  metadata,
  numberOrigin,
}: {
  metadata: JqRuntimeInputMetadata,
  numberOrigin: JqNumberOrigin | undefined,
}): JqRuntimeInputMetadata {
  if (metadata.numberOrigin === numberOrigin) return metadata;
  return numberOrigin === undefined
    ? metadataWithoutNumberOrigin({ metadata })
    : { ...metadataWithoutNumberOrigin({ metadata }), numberOrigin };
}

function singleOutputMetadata({
  inputMetadata,
  numberOrigin,
}: {
  inputMetadata: JqRuntimeInputMetadata,
  numberOrigin: JqNumberOrigin | undefined,
}): JqRuntimeInputMetadata[] {
  return [numberOrigin === undefined
    ? metadataWithoutNumberOrigin({ metadata: inputMetadata })
    : { ...metadataWithoutNumberOrigin({ metadata: inputMetadata }), numberOrigin }];
}

type JqNumberedArrayEntry = {
  readonly value: JsonValue,
  readonly numberOrigin: JqNumberOrigin | undefined,
};

function numberedArrayEntries({ input }: { input: JsonValue[] }): JqNumberedArrayEntry[] {
  return input.map((value, index) => ({
    value,
    numberOrigin: typeof value === 'number'
      ? getJsonChildNumberOrigin({ container: input, key: index })
      : undefined,
  }));
}

function numberedArrayFromEntries({ entries }: { entries: readonly JqNumberedArrayEntry[] }): JsonValue[] {
  const output = entries.map((entry) => entry.value);
  for (let index = 0; index < entries.length; index += 1) {
    setJsonChildNumberOrigin({
      container: output,
      key: index,
      origin: entries[index]!.numberOrigin,
    });
  }
  return output;
}

function formatJqDebugValue({
  value,
  numberOrigin,
}: {
  value: JsonValue,
  numberOrigin?: JqNumberOrigin,
}): string {
  const debugValue: JsonValue[] = ['DEBUG:', value];
  setJsonChildNumberOrigin({ container: debugValue, key: 1, origin: numberOrigin });
  return `${stringifyJson({
    value: debugValue,
    indentation: undefined,
    sortKeys: false,
    asciiOnly: false,
  })}
`;
}

function formatJqHaltErrorInput({
  value,
  numberOrigin,
}: {
  value: JsonValue,
  numberOrigin?: JqNumberOrigin,
}): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  return `${stringifyJson({
    value,
    indentation: undefined,
    sortKeys: false,
    asciiOnly: false,
    numberOrigin,
  })}
`;
}

function jqDiagnosticTypeName({
  value,
}: {
  value: JsonValue,
}): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function formatCsvField({
  value,
}: {
  value: JsonValue,
}): { ok: true, value: string } | { ok: false, message: string } {
  if (value === null) return { ok: true, value: '' };
  if (typeof value === 'string') {
    return { ok: true, value: `"${value.replaceAll('\0', '\\0').replaceAll('"', '""')}"` };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { ok: true, value: stringifyForFormat({ value }) };
  }
  return {
    ok: false,
    message: `${Array.isArray(value) ? 'array' : 'object'} (${stringifyForFormat({ value })}) is not valid in a csv row`,
  };
}

function formatUri({
  value,
}: {
  value: JsonValue,
}): string {
  const bytes = new TextEncoder().encode(stringifyForFormat({ value }));
  let encoded = '';
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9._~-]/.test(character)) {
      encoded += character;
      continue;
    }
    encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}


const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64Text({
  text,
}: {
  text: string,
}): string {
  const bytes = new TextEncoder().encode(text);
  let encoded = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset]!;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(value >>> 18) & 0x3f]!;
    encoded += BASE64_ALPHABET[(value >>> 12) & 0x3f]!;
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(value >>> 6) & 0x3f]!;
    encoded += third === undefined ? '=' : BASE64_ALPHABET[value & 0x3f]!;
  }
  return encoded;
}

function decodeBase64Text({
  text,
}: {
  text: string,
}):
  | { ok: true, value: string }
  | { ok: false, reason: 'invalid_data' | 'trailing_byte' } {
  const bytes: number[] = [];
  let pendingBits = 0;
  let pendingBitCount = 0;

  for (const character of text) {
    if (character === '=') break;
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) return { ok: false, reason: 'invalid_data' };

    pendingBits = (pendingBits << 6) | value;
    pendingBitCount += 6;
    if (pendingBitCount < 8) continue;

    pendingBitCount -= 8;
    bytes.push((pendingBits >>> pendingBitCount) & 0xff);
    pendingBits &= (1 << pendingBitCount) - 1;
  }

  if (pendingBitCount === 6) return { ok: false, reason: 'trailing_byte' };
  return {
    ok: true,
    value: new TextDecoder().decode(Uint8Array.from(bytes)),
  };
}

function formatHtml({
  value,
}: {
  value: JsonValue,
}): string {
  const formatted = stringifyForFormat({ value });
  return (typeof value === 'string' ? formatted.replaceAll('\0', '\\0') : formatted)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatShellScalar({
  value,
}: {
  value: JsonValue,
}): { ok: true, value: string } | { ok: false, message: string } {
  if (Array.isArray(value) || isJsonObject(value)) {
    return {
      ok: false,
      message: `${Array.isArray(value) ? 'array' : 'object'} (${stringifyForFormat({ value })}) can not be escaped for shell`,
    };
  }
  if (typeof value !== 'string') return { ok: true, value: stringifyForFormat({ value }) };
  return {
    ok: true,
    value: `'${value.replaceAll('\0', '\\0').replaceAll("'", "'\\''")}'`,
  };
}

function formatTsvField({
  value,
}: {
  value: JsonValue,
}): { ok: true, value: string } | { ok: false, message: string } {
  if (value === null) return { ok: true, value: '' };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { ok: true, value: stringifyForFormat({ value }) };
  }
  if (typeof value === 'string') {
    return {
      ok: true,
      value: value
        .replaceAll('\\', '\\\\')
        .replaceAll('\t', '\\t')
        .replaceAll('\r', '\\r')
        .replaceAll('\n', '\\n')
        .replaceAll('\0', '\\0'),
    };
  }
  return {
    ok: false,
    message: `${Array.isArray(value) ? 'array' : 'object'} (${stringifyForFormat({ value })}) is not valid in a csv row`,
  };
}

type ContainsJsonFrame =
  | {
      kind: 'value',
      input: JsonValue,
      expected: JsonValue,
    }
  | {
      kind: 'object',
      input: { [key: string]: JsonValue },
      expectedEntries: readonly (readonly [string, JsonValue])[],
      nextEntryIndex: number,
      waitingForChild: boolean,
    }
  | {
      kind: 'array',
      input: readonly JsonValue[],
      expected: readonly JsonValue[],
      expectedIndex: number,
      inputIndex: number,
      waitingForChild: boolean,
    };

function containsJson({
  input,
  expected,
}: {
  input: JsonValue,
  expected: JsonValue,
}): boolean {
  const stack: ContainsJsonFrame[] = [{ kind: 'value', input, expected }];
  let lastResult: boolean | undefined;

  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    switch (frame.kind) {
    case 'value': {
      if (typeof frame.input === 'string' && typeof frame.expected === 'string') {
        stack.pop();
        lastResult = frame.input.includes(frame.expected);
        break;
      }
      if (Array.isArray(frame.input) && Array.isArray(frame.expected)) {
        stack[stack.length - 1] = {
          kind: 'array',
          input: frame.input,
          expected: frame.expected,
          expectedIndex: 0,
          inputIndex: 0,
          waitingForChild: false,
        };
        lastResult = undefined;
        break;
      }
      if (isJsonObject(frame.input) && isJsonObject(frame.expected)) {
        stack[stack.length - 1] = {
          kind: 'object',
          input: frame.input,
          expectedEntries: Object.entries(frame.expected),
          nextEntryIndex: 0,
          waitingForChild: false,
        };
        lastResult = undefined;
        break;
      }
      stack.pop();
      lastResult = compareJsonValues({
        left: frame.input,
        right: frame.expected,
      }) === 0;
      break;
    }
    case 'object': {
      if (frame.waitingForChild) {
        if (lastResult === undefined) {
          throw new Error('jq object containment child completed without a result');
        }
        frame.waitingForChild = false;
        if (!lastResult) {
          stack.pop();
          lastResult = false;
          break;
        }
        frame.nextEntryIndex += 1;
        lastResult = undefined;
      }

      const entry = frame.expectedEntries[frame.nextEntryIndex];
      if (entry === undefined) {
        stack.pop();
        lastResult = true;
        break;
      }
      const [key, expectedValue] = entry;
      if (!Object.hasOwn(frame.input, key)) {
        stack.pop();
        lastResult = false;
        break;
      }
      frame.waitingForChild = true;
      stack.push({
        kind: 'value',
        input: frame.input[key]!,
        expected: expectedValue,
      });
      lastResult = undefined;
      break;
    }
    case 'array': {
      if (frame.waitingForChild) {
        if (lastResult === undefined) {
          throw new Error('jq array containment child completed without a result');
        }
        frame.waitingForChild = false;
        if (lastResult) {
          frame.expectedIndex += 1;
          frame.inputIndex = 0;
        } else {
          frame.inputIndex += 1;
        }
        lastResult = undefined;
      }

      if (frame.expectedIndex >= frame.expected.length) {
        stack.pop();
        lastResult = true;
        break;
      }
      if (frame.inputIndex >= frame.input.length) {
        stack.pop();
        lastResult = false;
        break;
      }
      frame.waitingForChild = true;
      stack.push({
        kind: 'value',
        input: frame.input[frame.inputIndex]!,
        expected: frame.expected[frame.expectedIndex]!,
      });
      lastResult = undefined;
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq containment frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  if (lastResult === undefined) {
    throw new Error('jq containment completed without a result');
  }
  return lastResult;
}

function insideJson({
  input,
  expected,
}: {
  input: JsonValue,
  expected: JsonValue,
}): boolean {
  return containsJson({
    input: expected,
    expected: input,
  });
}

function addValues({
  left,
  right,
}: {
  left: JsonValue,
  right: JsonValue,
}): JsonValue | undefined {
  if (typeof left === 'number' && typeof right === 'number') {
    return left + right;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return `${left}${right}`;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return [...left, ...right];
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    return mergeJsonObjects({ left, right });
  }
  return undefined;
}

function flattenArray({
  input,
  depth,
}: {
  input: JsonValue[],
  depth: number,
}): JsonValue[] {
  const flattened: JsonValue[] = [];
  const pending: {
    readonly value: JsonValue,
    readonly depth: number,
    readonly numberOrigin?: JqNumberOrigin,
  }[] = [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    pending.push({
      value: input[index]!,
      depth,
      numberOrigin: getJsonChildNumberOrigin({ container: input, key: index }),
    });
  }

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (!Array.isArray(current.value) || current.depth <= 0) {
      const outputIndex = flattened.length;
      flattened.push(current.value);
      setJsonChildNumberOrigin({
        container: flattened,
        key: outputIndex,
        origin: current.numberOrigin,
      });
      continue;
    }

    const nestedDepth = current.depth === Number.POSITIVE_INFINITY
      ? current.depth
      : current.depth - 1;
    for (let index = current.value.length - 1; index >= 0; index -= 1) {
      pending.push({
        value: current.value[index]!,
        depth: nestedDepth,
        numberOrigin: getJsonChildNumberOrigin({ container: current.value, key: index }),
      });
    }
  }

  return flattened;
}

function trimStartPrefix({
  value,
  prefix,
}: {
  value: string,
  prefix: string,
}): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function formatJqErrorMessage({
  value,
  numberOrigin,
}: {
  value: JsonValue,
  numberOrigin: JqNumberOrigin | undefined,
}): string {
  return typeof value === 'string'
    ? value
    : `(not a string): ${stringifyJson({
      value,
      indentation: undefined,
      sortKeys: false,
      asciiOnly: false,
      numberOrigin,
    })}`;
}

function trimEndSuffix({
  value,
  suffix,
}: {
  value: string,
  suffix: string,
}): string {
  return value.endsWith(suffix) ? value.slice(0, value.length - suffix.length) : value;
}

function trimJqNumberWhitespace({ value }: { value: string }): string {
  const withoutLeadingBom = value.startsWith('\uFEFF') ? value.slice(1) : value;
  return withoutLeadingBom.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, '');
}

function parseStrictNumber({
  value,
}: {
  value: string,
}): { value: number, numberOrigin: JqNumberOrigin } | undefined {
  const trimmed = trimJqNumberWhitespace({ value });
  if (trimmed.length === 0) return undefined;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const numberOrigin = createJqNumberOrigin({ lexeme: trimmed });
  return numberOrigin === undefined
    ? undefined
    : { value: Number(trimmed), numberOrigin };
}

function roundJqNumber({
  value,
}: {
  value: number,
}): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function evaluateSingleOutput({
  filter,
  input,
  evaluate,
}: {
  filter: import('./ast').JqFilter,
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
}): { ok: true, value: JsonValue, numberOrigin?: JqNumberOrigin } | { ok: false, error: JqRuntimeError } {
  const result = evaluate({ filter, input });
  if (!result.ok) return result;
  if (result.outputs.length !== 1) {
    return { ok: false, error: { message: 'filter must yield exactly one value here' } };
  }
  const numberOrigin = result.outputMetadata?.[0]?.numberOrigin;
  return {
    ok: true,
    value: result.outputs[0] ?? null,
    ...(numberOrigin === undefined ? {} : { numberOrigin }),
  };
}

function evaluateOrderingKey({
  filter,
  input,
  inputMetadata,
  evaluate,
}: {
  filter: JqFilter,
  input: JsonValue,
  inputMetadata?: JqRuntimeInputMetadata,
  evaluate: JqRuntimeFilterEvaluator,
}): { ok: true, value: JsonValue, numberOrigin?: JqNumberOrigin } | { ok: false, error: JqRuntimeError } {
  const result = evaluate({ filter, input, inputMetadata });
  // Ordering keys are internal to the aggregate builtin. jq does not expose
  // a successful key prefix when a later key output fails.
  if (!result.ok) return clearRuntimeFailureOutputs({ result });
  return {
    ok: true,
    value: result.outputs.length === 1 ? result.outputs[0] ?? null : result.outputs,
    ...(result.outputs.length === 1 && result.outputMetadata?.[0]?.numberOrigin !== undefined
      ? { numberOrigin: result.outputMetadata[0].numberOrigin }
      : {}),
  };
}

function evaluateRegularExpression({
  patternFilter,
  flagsFilter,
  input,
  evaluate,
}: {
  patternFilter: JqFilter,
  flagsFilter: JqFilter | undefined,
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
}):
  | {
    ok: true,
    compiled: Extract<ReturnType<typeof compileJqRegularExpression>, { readonly ok: true }>,
  }
  | { ok: false, error: JqRuntimeError } {
  const pattern = evaluateSingleOutput({ filter: patternFilter, input, evaluate });
  if (!pattern.ok) return pattern;
  if (typeof pattern.value !== 'string') {
    return { ok: false, error: { message: 'regular expression pattern must be a string' } };
  }

  let flags = '';
  if (flagsFilter !== undefined) {
    const evaluatedFlags = evaluateSingleOutput({ filter: flagsFilter, input, evaluate });
    if (!evaluatedFlags.ok) return evaluatedFlags;
    if (typeof evaluatedFlags.value !== 'string') {
      return { ok: false, error: { message: 'regular expression flags must be a string' } };
    }
    flags = evaluatedFlags.value;
  }

  const compiled = compileJqRegularExpression({ pattern: pattern.value, flags });
  return compiled.ok
    ? { ok: true, compiled }
    : { ok: false, error: { message: compiled.message } };
}

function createNamedCaptureObject({
  match,
}: {
  match: JqRegularExpressionMatch,
}): JsonValue {
  const captureObject = createJsonObject();
  for (const capture of match.captures) {
    if (capture.name === null) continue;
    defineJsonProperty({
      object: captureObject,
      key: capture.name,
      value: capture.text,
    });
  }
  return captureObject;
}

function createMatchObject({
  input,
  match,
}: {
  input: string,
  match: JqRegularExpressionMatch,
}): JsonValue {
  const result = createJsonObject();
  defineJsonProperty({
    object: result,
    key: 'offset',
    value: codePointOffset({ input, codeUnitOffset: match.start }),
  });
  defineJsonProperty({
    object: result,
    key: 'length',
    value: Array.from(match.text).length,
  });
  defineJsonProperty({ object: result, key: 'string', value: match.text });

  const captures: JsonValue[] = [];
  for (const capture of match.captures) {
    const captureObject = createJsonObject();
    if (capture.start < 0) {
      defineJsonProperty({ object: captureObject, key: 'offset', value: -1 });
      defineJsonProperty({ object: captureObject, key: 'string', value: null });
      defineJsonProperty({ object: captureObject, key: 'length', value: 0 });
    } else {
      defineJsonProperty({
        object: captureObject,
        key: 'offset',
        value: codePointOffset({ input, codeUnitOffset: capture.start }),
      });
      defineJsonProperty({
        object: captureObject,
        key: 'length',
        value: Array.from(capture.text ?? '').length,
      });
      defineJsonProperty({ object: captureObject, key: 'string', value: capture.text });
    }
    defineJsonProperty({ object: captureObject, key: 'name', value: capture.name });
    captures.push(captureObject);
  }
  defineJsonProperty({ object: result, key: 'captures', value: captures });
  return result;
}

function buildRegexReplacementOutputs({
  input,
  matches,
  replacementFilter,
  evaluate,
}: {
  input: string,
  matches: readonly JqRegularExpressionMatch[],
  replacementFilter: JqFilter,
  evaluate: JqRuntimeFilterEvaluator,
}): { ok: true, outputs: string[] } | { ok: false, error: JqRuntimeError } {
  if (matches.length === 0) return { ok: true, outputs: [input] };

  const replacementStreams: string[][] = [];
  let replacementValueCount = 0;
  for (const match of matches) {
    const evaluated = evaluate({
      filter: replacementFilter,
      input: createNamedCaptureObject({ match }),
    });
    // A replacement filter is atomic for each match. jq discards any
    // replacement prefix when that filter later fails; those values are not
    // top-level sub/gsub outputs.
    if (!evaluated.ok) return clearRuntimeFailureOutputs({ result: evaluated });
    for (const output of evaluated.outputs) {
      if (typeof output !== 'string') {
        return { ok: false, error: { message: 'replacement expression must produce strings' } };
      }
    }
    // An empty replacement filter cancels the replacement expression rather
    // than deleting the matched text or suppressing the whole jq output.
    if (evaluated.outputs.length === 0) return { ok: true, outputs: [input] };
    replacementValueCount += evaluated.outputs.length;
    if (replacementValueCount > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
      return {
        ok: false,
        error: {
          message: `regular expression replacement materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
        },
      };
    }
    replacementStreams.push(evaluated.outputs as string[]);
  }

  const branchCount = replacementStreams.reduce((maximum, values) => Math.max(maximum, values.length), 1);
  if (branchCount > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
    return {
      ok: false,
      error: {
        message: `regular expression replacement materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
      },
    };
  }

  const outputs: string[] = [];
  let totalOutputLength = 0;
  for (let branch = 0; branch < branchCount; branch += 1) {
    let cursor = 0;
    let outputLength = 0;
    const chunks: string[] = [];
    let complete = true;
    const append = ({ chunk }: { chunk: string }): boolean => {
      outputLength += chunk.length;
      if (
        outputLength > JQ_MAX_MATERIALIZED_VALUE_LENGTH
        || totalOutputLength + outputLength > JQ_MAX_MATERIALIZED_VALUE_LENGTH
      ) {
        return false;
      }
      chunks.push(chunk);
      return true;
    };
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index]!;
      const replacements = replacementStreams[index]!;
      const replacement = replacements.length === 1 ? replacements[0] : replacements[branch];
      if (replacement === undefined) {
        complete = false;
        break;
      }
      if (!append({ chunk: input.slice(cursor, match.start) }) || !append({ chunk: replacement })) {
        return {
          ok: false,
          error: {
            message: `regular expression replacement materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          },
        };
      }
      cursor = match.end;
    }
    if (complete) {
      if (!append({ chunk: input.slice(cursor) })) {
        return {
          ok: false,
          error: {
            message: `regular expression replacement materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          },
        };
      }
      totalOutputLength += outputLength;
      outputs.push(chunks.join(''));
    }
  }
  return { ok: true, outputs };
}

function mapAsciiLetters({
  value,
  direction,
}: {
  value: string,
  direction: 'down' | 'up',
}): string {
  switch (direction) {
  case 'down':
    return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  case 'up':
    return value.replace(/[a-z]/g, (letter) => letter.toUpperCase());
  default: {
    const _ex: never = direction;
    throw new Error(`Unhandled ASCII case direction: ${_ex}`);
  }
  }
}

function walkValue({
  value,
  mapper,
}: {
  value: JsonValue,
  mapper: ({ input }: { input: JsonValue }) => { ok: true, value: JsonValue } | { ok: false, error: JqRuntimeError },
}): { ok: true, value: JsonValue } | { ok: false, error: JqRuntimeError } {
  type WalkFrame =
    | { readonly kind: 'visit', readonly value: JsonValue }
    | { readonly kind: 'array', readonly childCount: number }
    | { readonly kind: 'object', readonly keys: readonly string[] };

  const frames: WalkFrame[] = [{ kind: 'visit', value }];
  const completed: JsonValue[] = [];

  while (frames.length > 0) {
    const frame = frames.pop()!;
    switch (frame.kind) {
    case 'visit': {
      if (Array.isArray(frame.value)) {
        frames.push({ kind: 'array', childCount: frame.value.length });
        for (let index = frame.value.length - 1; index >= 0; index -= 1) {
          frames.push({ kind: 'visit', value: frame.value[index]! });
        }
        break;
      }
      if (frame.value !== null && typeof frame.value === 'object') {
        const entries = jsonObjectEntries({ object: frame.value });
        frames.push({ kind: 'object', keys: entries.map(([key]) => key) });
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          frames.push({ kind: 'visit', value: entries[index]![1] });
        }
        break;
      }
      const mapped = mapper({ input: frame.value });
      if (!mapped.ok) return clearRuntimeFailureOutputs({ result: mapped });
      completed.push(mapped.value);
      break;
    }
    case 'array': {
      const start = completed.length - frame.childCount;
      const mapped = mapper({ input: completed.splice(start, frame.childCount) });
      if (!mapped.ok) return clearRuntimeFailureOutputs({ result: mapped });
      completed.push(mapped.value);
      break;
    }
    case 'object': {
      const start = completed.length - frame.keys.length;
      const values = completed.splice(start, frame.keys.length);
      const mappedObject = createJsonObject();
      for (let index = 0; index < frame.keys.length; index += 1) {
        defineJsonProperty({
          object: mappedObject,
          key: frame.keys[index]!,
          value: values[index]!,
        });
      }
      const mapped = mapper({ input: mappedObject });
      if (!mapped.ok) return mapped;
      completed.push(mapped.value);
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq walk frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const walked = completed[0];
  if (walked === undefined) {
    throw new Error('jq walk produced no result');
  }
  return { ok: true, value: walked };
}

function recurseChildren({
  input,
}: {
  input: JsonValue,
}): JsonValue[] {
  if (Array.isArray(input)) {
    return [...input];
  }
  if (input !== null && typeof input === 'object') {
    return jsonObjectValues({ object: input });
  }
  return [];
}

function recurseValues({
  input,
  evaluateNext,
}: {
  input: JsonValue,
  evaluateNext: ({ input }: { input: JsonValue }) => { ok: true, values: JsonValue[] } | { ok: false, error: JqRuntimeError },
}): { ok: true, values: JsonValue[] } | { ok: false, error: JqRuntimeError, outputs: JsonValue[] } {
  const outputs: JsonValue[] = [];
  const pending: JsonValue[] = [input];

  while (pending.length > 0) {
    const current = pending.pop()!;
    outputs.push(current);
    const next = evaluateNext({ input: current });
    if (!next.ok) return { ok: false, error: next.error, outputs };
    for (let index = next.values.length - 1; index >= 0; index -= 1) {
      pending.push(next.values[index]!);
    }
  }

  return { ok: true, values: outputs };
}

function typeFilter({
  input,
  expected,
}: {
  input: JsonValue,
  expected: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'scalar' | 'string',
}): JsonValue[] {
  switch (expected) {
  case 'array':
    return Array.isArray(input) ? [input] : [];
  case 'boolean':
    return typeof input === 'boolean' ? [input] : [];
  case 'null':
    return input === null ? [input] : [];
  case 'number':
    return typeof input === 'number' ? [input] : [];
  case 'object':
    return input !== null && typeof input === 'object' && !Array.isArray(input) ? [input] : [];
  case 'scalar':
    return input === null || typeof input === 'boolean' || typeof input === 'number' || typeof input === 'string'
      ? [input]
      : [];
  case 'string':
    return typeof input === 'string' ? [input] : [];
  default: {
    const _ex: never = expected;
    throw new Error(`Unhandled jq type filter: ${_ex}`);
  }
  }
}

function findIndices({
  input,
  search,
  searchOrigin,
}: {
  input: JsonValue,
  search: JsonValue,
  searchOrigin?: JqNumberOrigin,
}): number[] | undefined {
  if (typeof input === 'string' && typeof search === 'string') {
    if (search.length === 0) {
      return [];
    }
    const indices: number[] = [];
    let start = 0;
    while (start <= input.length - search.length) {
      const index = input.indexOf(search, start);
      if (index === -1) break;
      indices.push(index);
      start = index + 1;
    }
    return indices;
  }

  if (Array.isArray(input)) {
    const searchItems = Array.isArray(search) ? search : [search];
    if (searchItems.length === 0) {
      return [];
    }
    const indices: number[] = [];
    const lastStart = input.length - searchItems.length;
    for (let index = 0; index <= lastStart; index += 1) {
      const matches = searchItems.every((searchItem, offset) => (
        compareJsonValues({
          left: input[index + offset]!,
          right: searchItem,
          leftOrigin: getJsonChildNumberOrigin({ container: input, key: index + offset }),
          rightOrigin: Array.isArray(search)
            ? getJsonChildNumberOrigin({ container: search, key: offset })
            : searchOrigin,
        }) === 0
      ));
      if (matches) {
        indices.push(index);
      }
    }
    return indices;
  }

  return undefined;
}

export interface CollectedPath {
  readonly path: (string | number)[],
  readonly value: JsonValue,
}

function* iterateChildPaths({
  value,
  current,
}: {
  value: JsonValue,
  current: readonly (string | number)[],
}): Iterable<CollectedPath> {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      yield {
        path: [...current, index],
        value: value[index]!,
      };
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of jsonObjectEntries({ object: value })) {
    yield {
      path: [...current, key],
      value: nested,
    };
  }
}

export function* iteratePaths({
  value,
  current,
}: {
  value: JsonValue,
  current: readonly (string | number)[],
}): Iterable<CollectedPath> {
  // Keep one child iterator per active depth instead of preloading every
  // sibling path. This preserves jq's depth-first order while allowing an
  // outer consumer to stop a wide container before its unvisited siblings are
  // materialized.
  const pending: Iterator<CollectedPath>[] = [
    iterateChildPaths({ value, current })[Symbol.iterator](),
  ];
  while (pending.length > 0) {
    const iterator = pending.at(-1)!;
    const next = iterator.next();
    if (next.done) {
      pending.pop();
      continue;
    }
    const entry = next.value;
    yield entry;
    pending.push(iterateChildPaths({
      value: entry.value,
      current: entry.path,
    })[Symbol.iterator]());
  }
}

function readPathValue({
  input,
  path,
}: {
  input: JsonValue,
  path: (string | number)[],
}): JsonValue | undefined {
  let current: JsonValue | undefined = input;
  for (const segment of path) {
    if (typeof segment === 'string') {
      if (current === null || Array.isArray(current) || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }

    if (!Array.isArray(current)) {
      return undefined;
    }
    const normalizedIndex = segment >= 0 ? segment : current.length + segment;
    if (normalizedIndex < 0 || normalizedIndex >= current.length) {
      return undefined;
    }
    current = current[normalizedIndex];
  }
  return current;
}

function parsePathArray({
  value,
}: {
  value: JsonValue,
}): { ok: true, path: (string | number)[] } | { ok: false, message: string } {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'path must be an array' };
  }
  const path: (string | number)[] = [];
  for (const segment of value) {
    if (typeof segment === 'string') {
      path.push(segment);
      continue;
    }
    if (typeof segment === 'number' && Number.isInteger(segment)) {
      path.push(segment);
      continue;
    }
    return { ok: false, message: 'path components must be strings or integers' };
  }
  return { ok: true, path };
}

function toJqPath({
  path,
}: {
  path: readonly (string | number)[],
}): import('./ast').JqPath {
  return {
    segments: path.map((segment) => typeof segment === 'string'
      ? { kind: 'field' as const, key: segment, optional: false }
      : { kind: 'index' as const, index: segment, optional: false }),
  };
}

function jqPathOutput({
  path,
}: {
  path: JqPath,
}): JsonValue[] {
  return path.segments.map((segment) => {
    switch (segment.kind) {
    case 'field':
      return segment.key;
    case 'index':
      return segment.index;
    case 'slice': {
      const slice = createJsonObject();
      defineJsonProperty({ object: slice, key: 'start', value: segment.start ?? null });
      defineJsonProperty({ object: slice, key: 'end', value: segment.end ?? null });
      return slice;
    }
    default: {
      const _ex: never = segment;
      throw new Error(`Unhandled jq path segment: ${JSON.stringify(_ex)}`);
    }
    }
  });
}

function createEntryObject({
  key,
  value,
  valueOrigin,
}: {
  key: JsonValue,
  value: JsonValue,
  valueOrigin?: JqNumberOrigin,
}): JsonValue {
  const entry = createJsonObject();
  defineJsonProperty({ object: entry, key: 'key', value: key });
  defineJsonProperty({ object: entry, key: 'value', value });
  setJsonChildNumberOrigin({ container: entry, key: 'value', origin: valueOrigin });
  return entry;
}

function toEntriesValue({
  input,
}: {
  input: JsonValue,
}): JsonValue[] | undefined {
  if (Array.isArray(input)) {
    return input.map((value, key) => createEntryObject({
      key,
      value,
      valueOrigin: getJsonChildNumberOrigin({ container: input, key }),
    }));
  }
  if (isJsonObject(input)) {
    return jsonObjectEntries({ object: input }).map(([key, value]) => createEntryObject({
      key,
      value,
      valueOrigin: getJsonChildNumberOrigin({ container: input, key }),
    }));
  }
  return undefined;
}

function readEntryField({
  entry,
  names,
}: {
  entry: { [key: string]: JsonValue },
  names: readonly string[],
}): { readonly key: string, readonly value: JsonValue } | undefined {
  for (const name of names) {
    if (Object.hasOwn(entry, name)) return { key: name, value: entry[name]! };
  }
  return undefined;
}

function fromEntriesValue({
  input,
}: {
  input: JsonValue,
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  if (!Array.isArray(input)) {
    return { ok: false, message: 'from_entries input must be an array' };
  }
  const object = createJsonObject();
  for (const entry of input) {
    if (!isJsonObject(entry)) {
      return { ok: false, message: 'from_entries array elements must be objects' };
    }
    const keyField = readEntryField({ entry, names: ['key', 'Key', 'name', 'Name'] });
    const valueField = readEntryField({ entry, names: ['value', 'Value'] });
    if (typeof keyField?.value !== 'string') {
      return { ok: false, message: 'from_entries entry key must be a string' };
    }
    const value = valueField?.value ?? null;
    defineJsonProperty({ object, key: keyField.value, value });
    setJsonChildNumberOrigin({
      container: object,
      key: keyField.value,
      origin: valueField === undefined
        ? undefined
        : getJsonChildNumberOrigin({ container: entry, key: valueField.key }),
    });
  }
  return { ok: true, value: object };
}


function evaluateCount({
  filter,
  input,
  evaluate,
  name,
}: {
  filter: import('./ast').JqFilter,
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
  name: string,
}): { ok: true, value: number } | { ok: false, error: JqRuntimeError } {
  const evaluated = evaluateSingleOutput({ filter, input, evaluate });
  if (!evaluated.ok) return evaluated;
  if (typeof evaluated.value !== 'number' || !Number.isInteger(evaluated.value) || evaluated.value < 0) {
    return { ok: false, error: { message: `${name} count must be a non-negative integer` } };
  }
  return { ok: true, value: evaluated.value };
}

type JqCombinationResult =
  | { ok: true, outputs: JsonValue[][] }
  | { ok: false, error: JqRuntimeError };

function combinationsMaterializationError(): JqCombinationResult {
  return {
    ok: false,
    error: {
      message: `combinations materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
    },
  };
}

function combinationsOf({
  arrays,
}: {
  arrays: readonly (readonly JsonValue[])[],
}): JqCombinationResult {
  if (arrays.some((values) => values.length === 0)) {
    return { ok: true, outputs: [] };
  }

  const materializationLimit = BigInt(JQ_MAX_MATERIALIZED_VALUE_LENGTH);
  const tupleWidth = BigInt(arrays.length);
  let outputCount = 1n;
  for (const values of arrays) {
    outputCount *= BigInt(values.length);
    if (
      outputCount > materializationLimit
      || outputCount * tupleWidth > materializationLimit
    ) {
      return combinationsMaterializationError();
    }
  }

  if (outputCount === 1n) {
    return {
      ok: true,
      outputs: [arrays.map((values) => values[0]!)],
    };
  }

  let combinations: JsonValue[][] = [[]];
  for (const values of arrays) {
    const next: JsonValue[][] = [];
    for (const prefix of combinations) {
      for (const value of values) {
        next.push([...prefix, value]);
      }
    }
    combinations = next;
  }
  return { ok: true, outputs: combinations };
}

function evaluateRepeatedCombinationCount({
  filter,
  input,
  evaluate,
}: {
  filter: JqFilter,
  input: JsonValue[],
  evaluate: JqRuntimeFilterEvaluator,
}): { ok: true, value: number } | Extract<JqRuntimeResult, { ok: false }> {
  const evaluated = evaluate({ filter, input });
  if (!evaluated.ok) return clearRuntimeFailureOutputs({ result: evaluated });

  // jq defines combinations(n) as `[range(n) | $dot] | combinations`.
  // A filter stream therefore contributes the concatenated lengths of all
  // range(0; n) streams, rather than invoking combinations once per value.
  // Saturating is sufficient: empty input only distinguishes zero from a
  // positive width, while non-empty input is bounded by the materialization
  // limit in repeatedCombinationsOf.
  const saturationLimit = input.length === 0
    ? 1
    : JQ_MAX_MATERIALIZED_VALUE_LENGTH + 1;
  let count = 0;
  for (const value of evaluated.outputs) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: { message: 'Range bounds must be numeric' } };
    }
    const contribution = value <= 0 ? 0 : Math.ceil(value);
    if (contribution <= 0 || count >= saturationLimit) continue;
    count = contribution >= saturationLimit - count
      ? saturationLimit
      : count + contribution;
  }
  return { ok: true, value: count };
}

function repeatedCombinationsOf({
  values,
  count,
}: {
  values: readonly JsonValue[],
  count: number,
}): JqCombinationResult {
  if (count === 0) {
    return { ok: true, outputs: [[]] };
  }
  if (values.length === 0) {
    return { ok: true, outputs: [] };
  }
  if (count > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
    return combinationsMaterializationError();
  }
  if (values.length === 1) {
    return {
      ok: true,
      outputs: [Array.from({ length: count }, () => values[0]!)],
    };
  }

  const materializationLimit = BigInt(JQ_MAX_MATERIALIZED_VALUE_LENGTH);
  const tupleWidth = BigInt(count);
  const base = BigInt(values.length);
  let exponent = count;
  let factor = base;
  let outputCount = 1n;
  while (exponent > 0) {
    if (exponent % 2 === 1) {
      outputCount *= factor;
      if (
        outputCount > materializationLimit
        || outputCount * tupleWidth > materializationLimit
      ) {
        return combinationsMaterializationError();
      }
    }
    exponent = Math.floor(exponent / 2);
    if (exponent > 0) {
      factor *= factor;
      if (factor > materializationLimit) {
        factor = materializationLimit + 1n;
      }
    }
  }

  return combinationsOf({
    arrays: Array.from({ length: count }, () => values),
  });
}

function transposeArray({
  input,
}: {
  input: JsonValue[],
}): { ok: true, value: JsonValue[][] } | { ok: false, message: string } {
  const rows: JsonValue[][] = [];
  for (const row of input) {
    if (!Array.isArray(row)) {
      return { ok: false, message: 'transpose input must be an array of arrays' };
    }
    rows.push(row);
  }
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const materializedCellCount = BigInt(width) * BigInt(rows.length);
  if (materializedCellCount > BigInt(JQ_MAX_MATERIALIZED_VALUE_LENGTH)) {
    return {
      ok: false,
      message: `transpose materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
    };
  }
  const value = Array.from({ length: width }, (_unused, column) => {
    const outputRow = rows.map((row) => row[column] ?? null);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      setJsonChildNumberOrigin({
        container: outputRow,
        key: rowIndex,
        origin: getJsonChildNumberOrigin({ container: rows[rowIndex]!, key: column }),
      });
    }
    return outputRow;
  });
  return { ok: true, value };
}

function nextRepresentableNumber({
  from,
  toward,
}: {
  from: number,
  toward: number,
}): number {
  if (Number.isNaN(from) || Number.isNaN(toward)) return Number.NaN;
  if (Object.is(from, toward) || from === toward) return toward;
  if (from === Number.POSITIVE_INFINITY) return Number.MAX_VALUE;
  if (from === Number.NEGATIVE_INFINITY) return -Number.MAX_VALUE;
  if (from === 0) return toward > 0 ? Number.MIN_VALUE : -Number.MIN_VALUE;

  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, from, false);
  let bits = view.getBigUint64(0, false);
  const increasing = toward > from;
  if (from > 0) {
    bits = increasing ? bits + 1n : bits - 1n;
  } else {
    bits = increasing ? bits - 1n : bits + 1n;
  }
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function splitFloatingPoint({
  value,
}: {
  value: number,
}): readonly [number, number] {
  if (Number.isNaN(value)) return [Number.NaN, 0];
  if (Math.abs(value) >= Number.MAX_VALUE) return [value, 0];
  if (value === 0) return [value, 0];
  const exponent = Math.floor(Math.log2(Math.abs(value))) + 1;
  return [value / Math.pow(2, exponent), exponent];
}

function jqRoundTiesToEven({
  value,
}: {
  value: number,
}): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const rounded = roundTiesToEven({ value });
  return rounded === 0 && value < 0 ? -0 : rounded;
}

function roundTiesToEven({
  value,
}: {
  value: number,
}): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return Math.abs(lower % 2) === 0 ? lower : lower + 1;
}

function createJqUtcDate({
  year,
  month,
  day,
  hour,
  minute,
  second,
}: {
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
}): Date | undefined {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function jqGmtime({ value }: { value: number }): JsonValue[] | undefined {
  if (!Number.isFinite(value)) return undefined;
  const wholeSeconds = Math.trunc(value);
  const fractionalSecond = value - Math.floor(value);
  const date = new Date(wholeSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return undefined;
  const year = date.getUTCFullYear();
  const startOfYear = createJqUtcDate({
    year,
    month: 0,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  if (startOfYear === undefined) return undefined;
  const startOfDay = createJqUtcDate({
    year,
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  });
  if (startOfDay === undefined) return undefined;
  return [
    year,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds() + fractionalSecond,
    date.getUTCDay(),
    Math.floor((startOfDay.getTime() - startOfYear.getTime()) / 86_400_000),
  ];
}

function jqLocaltime({ value }: { value: number }): JsonValue[] | undefined {
  if (!Number.isFinite(value)) return undefined;
  const wholeSeconds = Math.trunc(value);
  const fractionalSecond = value - Math.floor(value);
  const date = new Date(wholeSeconds * 1_000);
  if (Number.isNaN(date.getTime())) return undefined;
  const year = date.getFullYear();
  const startOfYear = createJqUtcDate({
    year,
    month: 0,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const startOfDay = createJqUtcDate({
    year,
    month: date.getMonth(),
    day: date.getDate(),
    hour: 0,
    minute: 0,
    second: 0,
  });
  if (startOfYear === undefined || startOfDay === undefined) return undefined;
  return [
    year,
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds() + fractionalSecond,
    date.getDay(),
    Math.floor((startOfDay.getTime() - startOfYear.getTime()) / 86_400_000),
  ];
}

function createJqLocalDate({
  year,
  month,
  day,
  hour,
  minute,
  second,
}: {
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
}): Date | undefined {
  const date = new Date(0);
  date.setHours(0, 0, 0, 0);
  date.setFullYear(year, month, day);
  date.setHours(hour, minute, second, 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function jqLocalMktime({ input }: { input: JsonValue }): number | undefined {
  if (!Array.isArray(input) || input.length < 8) return undefined;
  const components = input.slice(0, 8);
  if (components.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = components as number[];
  const date = createJqLocalDate({
    year: Math.trunc(year!),
    month: Math.trunc(month!),
    day: Math.trunc(day!),
    hour: Math.trunc(hour!),
    minute: Math.trunc(minute!),
    second: Math.trunc(second!),
  });
  return date === undefined ? undefined : date.getTime() / 1_000;
}

function jqMktime({ input }: { input: JsonValue }): number | undefined {
  if (!Array.isArray(input) || input.length < 8) return undefined;
  const components = input.slice(0, 8);
  if (components.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = components as number[];
  const date = createJqUtcDate({
    year: Math.trunc(year!),
    month: Math.trunc(month!),
    day: Math.trunc(day!),
    hour: Math.trunc(hour!),
    minute: Math.trunc(minute!),
    second: Math.trunc(second!),
  });
  return date === undefined ? undefined : date.getTime() / 1_000;
}

const JQ_WEEKDAY_ABBREVIATIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const JQ_WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const JQ_MONTH_ABBREVIATIONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const JQ_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

type JqParsedDateTime = readonly [
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  weekday: number,
  yearDay: number,
];

function jqParsedDateTime({
  input,
  timezone,
}: {
  input: JsonValue,
  timezone: 'local' | 'utc',
}): JqParsedDateTime | undefined {
  if (typeof input === 'number') {
    const converted = (() => {
      switch (timezone) {
      case 'utc':
        return jqGmtime({ value: input });
      case 'local':
        return jqLocaltime({ value: input });
      default: {
        const _ex: never = timezone;
        throw new Error(`Unhandled jq timezone: ${_ex}`);
      }
      }
    })();
    return converted === undefined ? undefined : converted as unknown as JqParsedDateTime;
  }
  if (!Array.isArray(input) || input.length < 8) return undefined;
  const components = input.slice(0, 8);
  if (components.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return undefined;
  }
  return components.map((value) => Math.trunc(value as number)) as unknown as JqParsedDateTime;
}

function padJqDateNumber({
  value,
  width,
  fill = '0',
}: {
  value: number,
  width: number,
  fill?: '0' | ' ',
}): string {
  const integer = Math.trunc(value);
  if (integer < 0) return `-${String(Math.abs(integer)).padStart(Math.max(width - 1, 0), fill)}`;
  return String(integer).padStart(width, fill);
}

function isJqLeapYear({ year }: { year: number }): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function jqIsoWeek({
  year,
  weekday,
  yearDay,
}: {
  year: number,
  weekday: number,
  yearDay: number,
}): { isoYear: number, isoWeek: number } {
  const isoWeekday = weekday === 0 ? 7 : weekday;
  let isoYear = year;
  let thursdayYearDay = yearDay + 4 - isoWeekday;
  if (thursdayYearDay < 0) {
    isoYear -= 1;
    thursdayYearDay += isJqLeapYear({ year: isoYear }) ? 366 : 365;
  } else {
    const daysInYear = isJqLeapYear({ year }) ? 366 : 365;
    if (thursdayYearDay >= daysInYear) {
      isoYear += 1;
      thursdayYearDay -= daysInYear;
    }
  }
  return {
    isoYear,
    isoWeek: Math.floor(thursdayYearDay / 7) + 1,
  };
}

function jqLocalTimezoneName(): string {
  const currentYear = new Date().getFullYear();
  const january = new Date(currentYear, 0, 1, 12, 0, 0, 0);
  const july = new Date(currentYear, 6, 1, 12, 0, 0, 0);
  const standardDate = january.getTimezoneOffset() >= july.getTimezoneOffset() ? january : july;
  const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(standardDate);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC';
}

function formatJqStrftimeToken({
  token,
  fields,
  timezone,
}: {
  token: string,
  fields: JqParsedDateTime,
  timezone: 'local' | 'utc',
}): string {
  const [year, month, day, hour, minute, second, weekday, yearDay] = fields;
  const recurse = ({ nestedToken }: { nestedToken: string }): string => formatJqStrftimeToken({
    token: nestedToken,
    fields,
    timezone,
  });
  switch (token) {
  case '%%': return '%';
  case '%a': return JQ_WEEKDAY_ABBREVIATIONS[weekday] ?? '?';
  case '%A': return JQ_WEEKDAY_NAMES[weekday] ?? '?';
  case '%b':
  case '%h': return JQ_MONTH_ABBREVIATIONS[month] ?? '?';
  case '%B': return JQ_MONTH_NAMES[month] ?? '?';
  case '%C': return String(Math.floor(year / 100));
  case '%Y': return String(year);
  case '%y': return String(((year % 100) + 100) % 100).padStart(2, '0');
  case '%m': return padJqDateNumber({ value: month + 1, width: 2 });
  case '%d': return padJqDateNumber({ value: day, width: 2 });
  case '%e': return padJqDateNumber({ value: day, width: 2, fill: ' ' });
  case '%H': return padJqDateNumber({ value: hour, width: 2 });
  case '%I': return padJqDateNumber({ value: hour === 0 ? 12 : hour > 12 ? hour - 12 : hour, width: 2 });
  case '%k': return padJqDateNumber({ value: hour, width: 2, fill: ' ' });
  case '%l': return padJqDateNumber({ value: hour % 12 || 12, width: 2, fill: ' ' });
  case '%M': return padJqDateNumber({ value: minute, width: 2 });
  case '%S': return padJqDateNumber({ value: second, width: 2 });
  case '%p': return hour < 12 ? 'AM' : 'PM';
  case '%P': return hour < 12 ? 'am' : 'pm';
  case '%j': return padJqDateNumber({ value: yearDay + 1, width: 3 });
  case '%w': return String(weekday);
  case '%u': return String(weekday === 0 ? 7 : weekday);
  case '%U': return padJqDateNumber({ value: Math.floor((yearDay + 7 - weekday) / 7), width: 2 });
  case '%W': {
    const mondayWeekday = (weekday + 6) % 7;
    return padJqDateNumber({ value: Math.floor((yearDay + 7 - mondayWeekday) / 7), width: 2 });
  }
  case '%V': {
    const iso = jqIsoWeek({ year, weekday, yearDay });
    return padJqDateNumber({ value: iso.isoWeek, width: 2 });
  }
  case '%G': return String(jqIsoWeek({ year, weekday, yearDay }).isoYear);
  case '%g': {
    const isoYear = jqIsoWeek({ year, weekday, yearDay }).isoYear;
    return String(((isoYear % 100) + 100) % 100).padStart(2, '0');
  }
  case '%F': return `${recurse({ nestedToken: '%Y' })}-${recurse({ nestedToken: '%m' })}-${recurse({ nestedToken: '%d' })}`;
  case '%T': return `${recurse({ nestedToken: '%H' })}:${recurse({ nestedToken: '%M' })}:${recurse({ nestedToken: '%S' })}`;
  case '%R': return `${recurse({ nestedToken: '%H' })}:${recurse({ nestedToken: '%M' })}`;
  case '%D': return `${recurse({ nestedToken: '%m' })}/${recurse({ nestedToken: '%d' })}/${recurse({ nestedToken: '%y' })}`;
  case '%r': return `${recurse({ nestedToken: '%I' })}:${recurse({ nestedToken: '%M' })}:${recurse({ nestedToken: '%S' })} ${recurse({ nestedToken: '%p' })}`;
  case '%c': return `${recurse({ nestedToken: '%a' })} ${recurse({ nestedToken: '%b' })} ${recurse({ nestedToken: '%e' })} ${recurse({ nestedToken: '%T' })} ${recurse({ nestedToken: '%Y' })}`;
  case '%x': return recurse({ nestedToken: '%D' });
  case '%X': return recurse({ nestedToken: '%T' });
  case '%s': {
    const epochSeconds = (() => {
      switch (timezone) {
      case 'utc':
        return jqMktime({ input: [...fields] });
      case 'local':
        return jqLocalMktime({ input: [...fields] });
      default: {
        const _ex: never = timezone;
        throw new Error(`Unhandled jq timezone: ${_ex}`);
      }
      }
    })();
    return String(epochSeconds ?? 0);
  }
  case '%z': return '+0000';
  case '%Z': {
    switch (timezone) {
    case 'utc':
      return 'UTC';
    case 'local':
      return jqLocalTimezoneName();
    default: {
      const _ex: never = timezone;
      throw new Error(`Unhandled jq timezone: ${_ex}`);
    }
    }
  }
  case '%n': return '\n';
  case '%t': return '\t';
  default: return token;
  }
}

type JqStrptimeState = {
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  weekday: number,
  yearDay: number,
  dateComponentSeen: boolean,
  weekdayExplicit: boolean,
  yearDayExplicit: boolean,
  hour12: number | undefined,
  meridiem: 'AM' | 'PM' | undefined,
  century: number | undefined,
  yearWithinCentury: number | undefined,
  epochSeconds: number | undefined,
};

type JqStrptimeAction = ({ state, value }: {
  state: JqStrptimeState,
  value: string,
}) => void;

function escapeJqStrptimeLiteral({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function expandJqStrptimeFormat({ format }: { format: string }): string {
  return format.replace(/%[cDFhRrTxX]/gu, (token) => {
    switch (token) {
    case '%c': return '%a %b %e %T %Y';
    case '%D': return '%m/%d/%y';
    case '%F': return '%Y-%m-%d';
    case '%h': return '%b';
    case '%R': return '%H:%M';
    case '%r': return '%I:%M:%S %p';
    case '%T': return '%H:%M:%S';
    case '%x': return '%D';
    case '%X': return '%T';
    default: {
      const exhaustive: never = token as never;
      throw new Error(`Unhandled jq strptime composite token: ${exhaustive}`);
    }
    }
  });
}

function jqStrptimeToken({
  token,
}: {
  token: string,
}): { pattern: string, action?: JqStrptimeAction } {
  const numeric = ({
    pattern,
    apply,
  }: {
    pattern: string,
    apply: ({ state, value }: { state: JqStrptimeState, value: number }) => void,
  }): { pattern: string, action: JqStrptimeAction } => ({
    pattern,
    action: ({ state, value }) => apply({ state, value: Number(value.trim()) }),
  });
  switch (token) {
  case '%%': return { pattern: '%' };
  case '%Y': return numeric({
    pattern: '[+-]?\\d+',
    apply: ({ state, value }) => {
      state.year = value;
      state.dateComponentSeen = true;
    },
  });
  case '%C': return numeric({
    pattern: '[+-]?\\d+',
    apply: ({ state, value }) => {
      state.century = value;
      state.dateComponentSeen = true;
    },
  });
  case '%y': return numeric({
    pattern: '\\d{1,2}',
    apply: ({ state, value }) => {
      state.yearWithinCentury = value;
      state.dateComponentSeen = true;
    },
  });
  case '%m': return numeric({
    pattern: '(?:0?[1-9]|1[0-2])',
    apply: ({ state, value }) => {
      state.month = value - 1;
      state.dateComponentSeen = true;
    },
  });
  case '%d': return numeric({
    pattern: '(?:0?[1-9]|[12]\\d|3[01])',
    apply: ({ state, value }) => {
      state.day = value;
      state.dateComponentSeen = true;
    },
  });
  case '%e': return numeric({
    pattern: '(?: ?[1-9]|[12]\\d|3[01])',
    apply: ({ state, value }) => {
      state.day = value;
      state.dateComponentSeen = true;
    },
  });
  case '%H': return numeric({
    pattern: '(?:[01]?\\d|2[0-3])',
    apply: ({ state, value }) => {
      state.hour = value;
    },
  });
  case '%I': return numeric({
    pattern: '(?:0?[1-9]|1[0-2])',
    apply: ({ state, value }) => {
      state.hour12 = value;
    },
  });
  case '%M': return numeric({
    pattern: '[0-5]?\\d',
    apply: ({ state, value }) => {
      state.minute = value;
    },
  });
  case '%S': return numeric({
    pattern: '(?:[0-5]?\\d|60)',
    apply: ({ state, value }) => {
      state.second = value;
    },
  });
  case '%j': return numeric({
    pattern: '(?:00[1-9]|0[1-9]\\d|[12]\\d{2}|3[0-5]\\d|36[0-6])',
    apply: ({ state, value }) => {
      state.yearDay = value - 1;
      state.yearDayExplicit = true;
    },
  });
  case '%w': return numeric({
    pattern: '[0-6]',
    apply: ({ state, value }) => {
      state.weekday = value;
      state.weekdayExplicit = true;
    },
  });
  case '%u': return numeric({
    pattern: '[1-7]',
    apply: ({ state, value }) => {
      state.weekday = value === 7 ? 0 : value;
      state.weekdayExplicit = true;
    },
  });
  case '%p': return {
    pattern: '(?:AM|PM)',
    action: ({ state, value }) => {
      state.meridiem = value.toUpperCase() as 'AM' | 'PM';
    },
  };
  case '%a': return {
    pattern: '(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat)',
    action: ({ state, value }) => {
      state.weekday = JQ_WEEKDAY_ABBREVIATIONS.findIndex((name) => name.toLowerCase() === value.toLowerCase());
      state.weekdayExplicit = true;
    },
  };
  case '%A': return {
    pattern: '(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)',
    action: ({ state, value }) => {
      state.weekday = JQ_WEEKDAY_NAMES.findIndex((name) => name.toLowerCase() === value.toLowerCase());
      state.weekdayExplicit = true;
    },
  };
  case '%b': return {
    pattern: '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)',
    action: ({ state, value }) => {
      state.month = JQ_MONTH_ABBREVIATIONS.findIndex((name) => name.toLowerCase() === value.toLowerCase());
      state.dateComponentSeen = true;
    },
  };
  case '%B': return {
    pattern: '(?:January|February|March|April|May|June|July|August|September|October|November|December)',
    action: ({ state, value }) => {
      state.month = JQ_MONTH_NAMES.findIndex((name) => name.toLowerCase() === value.toLowerCase());
      state.dateComponentSeen = true;
    },
  };
  case '%s': return numeric({
    pattern: '\\d+',
    apply: ({ state, value }) => {
      state.epochSeconds = value;
    },
  });
  case '%z': return { pattern: '(?:Z|[+-]\\d{4})' };
  case '%Z': return { pattern: '[A-Za-z_+/:-]+' };
  case '%n':
  case '%t': return { pattern: '\\s+' };
  default: return { pattern: escapeJqStrptimeLiteral({ value: token }) };
  }
}

function parseJqStrptime({
  value,
  format,
}: {
  value: string,
  format: string,
}): JqParsedDateTime | undefined {
  const expanded = expandJqStrptimeFormat({ format: expandJqStrptimeFormat({ format }) });
  const actions: JqStrptimeAction[] = [];
  let pattern = '^';
  for (let index = 0; index < expanded.length;) {
    const character = expanded[index]!;
    if (/\\s/u.test(character)) {
      while (index < expanded.length && /\\s/u.test(expanded[index]!)) index += 1;
      pattern += '\\s+';
      continue;
    }
    if (character !== '%') {
      pattern += escapeJqStrptimeLiteral({ value: character });
      index += 1;
      continue;
    }
    const token = expanded.slice(index, index + 2);
    if (token.length < 2) return undefined;
    const compiled = jqStrptimeToken({ token });
    if (compiled.action === undefined) {
      pattern += compiled.pattern;
    } else {
      pattern += `(${compiled.pattern})`;
      actions.push(compiled.action);
    }
    index += 2;
  }
  pattern += '$';
  const match = new RegExp(pattern, 'iu').exec(value);
  if (match === null) return undefined;

  const state: JqStrptimeState = {
    year: 1900,
    month: 0,
    day: 0,
    hour: 0,
    minute: 0,
    second: 0,
    weekday: 8,
    yearDay: 367,
    dateComponentSeen: false,
    weekdayExplicit: false,
    yearDayExplicit: false,
    hour12: undefined,
    meridiem: undefined,
    century: undefined,
    yearWithinCentury: undefined,
    epochSeconds: undefined,
  };
  for (let index = 0; index < actions.length; index += 1) {
    actions[index]!({ state, value: match[index + 1]! });
  }

  if (state.epochSeconds !== undefined) {
    const converted = jqGmtime({ value: state.epochSeconds });
    return converted === undefined ? undefined : converted as unknown as JqParsedDateTime;
  }
  if (state.century !== undefined || state.yearWithinCentury !== undefined) {
    const yearWithinCentury = state.yearWithinCentury ?? 0;
    state.year = state.century === undefined
      ? yearWithinCentury >= 69 ? 1900 + yearWithinCentury : 2000 + yearWithinCentury
      : state.century * 100 + yearWithinCentury;
  }
  if (state.hour12 !== undefined) {
    const hour = state.hour12 % 12;
    const meridiem = state.meridiem;
    switch (meridiem) {
    case 'PM':
      state.hour = hour + 12;
      break;
    case 'AM':
    case undefined:
      state.hour = hour;
      break;
    default: {
      const exhaustive: never = meridiem;
      throw new Error(`Unhandled meridiem: ${exhaustive}`);
    }
    }
  }

  if (state.dateComponentSeen) {
    const date = createJqUtcDate({
      year: state.year,
      month: state.month,
      day: state.day,
      hour: state.hour,
      minute: state.minute,
      second: state.second,
    });
    const startOfYear = createJqUtcDate({
      year: state.year,
      month: 0,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
    if (date === undefined || startOfYear === undefined) return undefined;
    if (!state.weekdayExplicit) state.weekday = date.getUTCDay();
    if (!state.yearDayExplicit) {
      const startOfDay = createJqUtcDate({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth(),
        day: date.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
      });
      if (startOfDay === undefined) return undefined;
      state.yearDay = Math.floor((startOfDay.getTime() - startOfYear.getTime()) / 86_400_000);
    }
  }
  return [
    state.year,
    state.month,
    state.day,
    state.hour,
    state.minute,
    state.second,
    state.weekday,
    state.yearDay,
  ];
}

function formatJqStrftime({
  format,
  fields,
  timezone,
}: {
  format: string,
  fields: JqParsedDateTime,
  timezone: 'local' | 'utc',
}): string {
  return format.replace(/%(?:::{0,2})?[%A-Za-z]/gu, (token) => formatJqStrftimeToken({
    token,
    fields,
    timezone,
  }));
}

function formatJqIsoDate({ value }: { value: number }): string | undefined {
  const milliseconds = Math.trunc(value) * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return undefined;
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

function parseJqIsoDate({ value }: { value: string }): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value);
  if (match === null) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
    return undefined;
  }
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const milliseconds = date.getTime();
  return Number.isNaN(milliseconds) ? undefined : milliseconds / 1000;
}

export type JqStreamPathSegment = string | number;

type JqStreamEvent = {
  readonly path: readonly JqStreamPathSegment[],
  readonly value: JsonValue | undefined,
  readonly hasValue: boolean,
};

function appendJqStreamEvent({
  outputs,
  path,
  value,
  hasValue,
}: {
  outputs: JsonValue[],
  path: readonly JqStreamPathSegment[],
  value: JsonValue | undefined,
  hasValue: boolean,
}): boolean {
  if (outputs.length >= JQ_MAX_MATERIALIZED_VALUE_LENGTH) return false;
  const pathValue: JsonValue[] = [...path];
  outputs.push(hasValue ? [pathValue, value ?? null] : [pathValue]);
  return true;
}

function createJqStreamEvents({
  input,
}: {
  input: JsonValue,
}): { ok: true, outputs: JsonValue[] } | { ok: false, message: string } {
  type Frame =
    | { kind: 'visit', path: readonly JqStreamPathSegment[], value: JsonValue }
    | { kind: 'close', path: readonly JqStreamPathSegment[] };

  const pending: Frame[] = [{ kind: 'visit', path: [], value: input }];
  const outputs: JsonValue[] = [];

  while (pending.length > 0) {
    const frame = pending.pop()!;
    switch (frame.kind) {
    case 'close':
      if (!appendJqStreamEvent({
        outputs,
        path: frame.path,
        value: undefined,
        hasValue: false,
      })) {
        return {
          ok: false,
          message: `stream materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
        };
      }
      break;
    case 'visit': {
      if (Array.isArray(frame.value)) {
        if (frame.value.length === 0) {
          if (!appendJqStreamEvent({
            outputs,
            path: frame.path,
            value: frame.value,
            hasValue: true,
          })) {
            return {
              ok: false,
              message: `stream materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
            };
          }
          break;
        }
        const lastIndex = frame.value.length - 1;
        pending.push({ kind: 'close', path: [...frame.path, lastIndex] });
        for (let index = lastIndex; index >= 0; index -= 1) {
          pending.push({
            kind: 'visit',
            path: [...frame.path, index],
            value: frame.value[index]!,
          });
        }
        break;
      }
      if (isJsonObject(frame.value)) {
        const entries = jsonObjectEntries({ object: frame.value });
        if (entries.length === 0) {
          if (!appendJqStreamEvent({
            outputs,
            path: frame.path,
            value: frame.value,
            hasValue: true,
          })) {
            return {
              ok: false,
              message: `stream materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
            };
          }
          break;
        }
        const lastKey = entries.at(-1)![0];
        pending.push({ kind: 'close', path: [...frame.path, lastKey] });
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, value] = entries[index]!;
          pending.push({ kind: 'visit', path: [...frame.path, key], value });
        }
        break;
      }
      if (!appendJqStreamEvent({
        outputs,
        path: frame.path,
        value: frame.value,
        hasValue: true,
      })) {
        return {
          ok: false,
          message: `stream materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
        };
      }
      break;
    }
    default: {
      const _ex: never = frame;
      throw new Error(`Unhandled jq stream frame: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return { ok: true, outputs };
}

export function parseJqStreamEvent({
  event,
}: {
  event: JsonValue,
}): { ok: true, event: JqStreamEvent } | { ok: false, message: string } {
  if (!Array.isArray(event)) {
    return { ok: false, message: formatJqIndexError({ container: event, index: 0 }) };
  }
  const rawPath = event[0];
  if (rawPath === undefined) {
    return { ok: false, message: 'stream event must contain a path' };
  }
  const parsed = parsePathArray({ value: rawPath });
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    event: {
      path: parsed.path,
      value: event[1],
      hasValue: event.length >= 2,
    },
  };
}

export function applyJqStreamValue({
  root,
  path,
  value,
}: {
  root: JsonValue,
  path: readonly JqStreamPathSegment[],
  value: JsonValue,
}): { ok: true, value: JsonValue } | { ok: false, message: string } {
  return applyPathUpdate({
    root,
    path: toJqPath({ path }),
    update: () => ({ ok: true, value }),
  });
}

export function jqSliceStart({
  length,
  value,
}: {
  length: number,
  value: JsonValue,
}): { ok: true, start: number } | { ok: false, message: string } {
  if (value === null) return { ok: true, start: 0 };
  if (typeof value !== 'number') {
    return { ok: false, message: 'Array/string slice indices must be integers' };
  }
  const integer = Math.trunc(value);
  const adjusted = integer < 0 ? length + integer : integer;
  return { ok: true, start: Math.min(Math.max(adjusted, 0), length) };
}

function evaluateBinaryNumericBuiltin({
  name,
  args,
  input,
  evaluate,
  operation,
  normalizeInputs = true,
}: {
  name: JqBuiltinName,
  args: readonly JqFilter[],
  input: JsonValue,
  evaluate: JqRuntimeFilterEvaluator,
  operation: ({ left, right }: { left: number, right: number }) => number,
  normalizeInputs?: boolean,
}): JqRuntimeResult {
  const leftFilter = args[0];
  const rightFilter = args[1];
  if (args.length !== 2 || leftFilter === undefined || rightFilter === undefined) {
    return { ok: false, error: { message: `${name} takes exactly two arguments` } };
  }

  const rightResult = evaluate({ filter: rightFilter, input });
  const rightValues = rightResult.ok
    ? rightResult.outputs
    : runtimeFailureOutputs({ result: rightResult });
  const outputs: JsonValue[] = [];
  for (const right of rightValues) {
    if (typeof right !== 'number') {
      return { ok: false, error: { message: `${name} arguments must be numbers` }, outputs };
    }
    const leftResult = evaluate({ filter: leftFilter, input });
    const leftValues = leftResult.ok
      ? leftResult.outputs
      : runtimeFailureOutputs({ result: leftResult });
    for (const left of leftValues) {
      if (typeof left !== 'number') {
        return { ok: false, error: { message: `${name} arguments must be numbers` }, outputs };
      }
      outputs.push(normalizeJqArithmeticResult({
        value: operation({
          left: normalizeInputs ? toJqArithmeticNumber({ value: left }) : left,
          right: normalizeInputs ? toJqArithmeticNumber({ value: right }) : right,
        }),
      }));
    }
    if (!leftResult.ok) {
      return replaceRuntimeFailureOutputs({ result: leftResult, outputs });
    }
  }
  return rightResult.ok
    ? { ok: true, outputs }
    : replaceRuntimeFailureOutputs({ result: rightResult, outputs });
}

interface EvaluateBuiltinParameters {
  readonly name: JqBuiltinName,
  readonly args: readonly JqFilter[],
  readonly input: JsonValue,
  readonly evaluate: JqRuntimeFilterEvaluator,
  readonly takeInputs: ({ maximumValues, eofBehavior }: {
    maximumValues: number | undefined,
    eofBehavior: 'break' | 'empty',
  }) => JqRuntimeResult,
  readonly inputMetadata: JqRuntimeInputMetadata,
  readonly evaluateFirstOutput: JqRuntimeFilterEvaluator,
  readonly emitStderr: ({ text }: { text: string }) => void,
}

const JQ_SINGLE_ARGUMENT_STREAM_BUILTINS = new Set<JqBuiltinName>([
  'bsearch',
  'capture',
  'contains',
  'delpaths',
  'endswith',
  'flatten',
  'getpath',
  'has',
  'in',
  'index',
  'indices',
  'inside',
  'join',
  'ltrimstr',
  'match',
  'rindex',
  'rtrimstr',
  'scan',
  'split',
  'splits',
  'startswith',
  'test',
]);

const JQ_FLAGS_OUTER_PATTERN_STREAM_BUILTINS = new Set<JqBuiltinName>([
  'capture',
  'match',
  'test',
]);

const JQ_PATTERN_OUTER_FLAGS_STREAM_BUILTINS = new Set<JqBuiltinName>([
  'scan',
]);

const JQ_VALUE_OUTER_PATH_STREAM_BUILTINS = new Set<JqBuiltinName>([
  'setpath',
]);


export function evaluateBuiltin({
  name,
  args,
  input,
  evaluate,
  takeInputs,
  inputMetadata,
  evaluateFirstOutput,
  emitStderr,
}: EvaluateBuiltinParameters): JqRuntimeResult {
  const parameters: EvaluateBuiltinParameters = {
    name,
    args,
    input,
    evaluate,
    takeInputs,
    inputMetadata,
    evaluateFirstOutput,
    emitStderr,
  };
  if (
    (name === 'split' || name === 'splits')
    && args.length === 2
    && args[0] !== undefined
    && args[1] !== undefined
  ) {
    return evaluateBuiltinRegexSplitStreams({
      parameters,
      patternFilter: args[0],
      flagsFilter: args[1],
      outputKind: name,
    });
  }

  if ((name === 'sub' || name === 'gsub') && args[0] !== undefined && args[1] !== undefined) {
    if (args.length === 2) {
      return evaluateBuiltinArgumentStreams({
        parameters,
        argumentFiltersInEvaluationOrder: [args[0]],
      });
    }
    if (args.length === 3 && args[2] !== undefined) {
      return evaluateBuiltinArgumentStreams({
        parameters,
        argumentFiltersInEvaluationOrder: [args[0], args[2]],
      });
    }
  }

  if (args.length === 2 && args[0] !== undefined && args[1] !== undefined) {
    if (JQ_VALUE_OUTER_PATH_STREAM_BUILTINS.has(name)) {
      // jq evaluates replacement values outside path values.
      return evaluateBuiltinArgumentStreams({
        parameters,
        argumentFiltersInEvaluationOrder: [args[1], args[0]],
      });
    }
    if (JQ_FLAGS_OUTER_PATTERN_STREAM_BUILTINS.has(name)) {
      return evaluateBuiltinArgumentStreams({
        parameters,
        argumentFiltersInEvaluationOrder: [args[1], args[0]],
      });
    }
    if (JQ_PATTERN_OUTER_FLAGS_STREAM_BUILTINS.has(name)) {
      return evaluateBuiltinArgumentStreams({
        parameters,
        argumentFiltersInEvaluationOrder: [args[0], args[1]],
      });
    }
  }

  const argumentFilter = args.length === 1 && JQ_SINGLE_ARGUMENT_STREAM_BUILTINS.has(name)
    ? args[0]
    : undefined;
  return argumentFilter === undefined
    ? evaluateBuiltinSinglePass(parameters)
    : evaluateBuiltinArgumentStreams({
      parameters,
      argumentFiltersInEvaluationOrder: [argumentFilter],
    });
}


function evaluateBuiltinRegexSplitStreams({
  parameters,
  patternFilter,
  flagsFilter,
  outputKind,
}: {
  parameters: EvaluateBuiltinParameters,
  patternFilter: JqFilter,
  flagsFilter: JqFilter,
  outputKind: 'split' | 'splits',
}): JqRuntimeResult {
  const { input, evaluate, inputMetadata } = parameters;
  if (typeof input !== 'string') {
    return { ok: false, error: { message: `${outputKind} input must be a string` } };
  }
  const patternsResult = evaluate({ filter: patternFilter, input });
  const patternValues = patternsResult.ok
    ? patternsResult.outputs
    : runtimeFailureOutputs({ result: patternsResult });
  const outputs: JsonValue[] = [];
  const outputMetadata: JqRuntimeInputMetadata[] = [];

  for (let patternIndex = 0; patternIndex < patternValues.length; patternIndex += 1) {
    const pattern = patternValues[patternIndex];
    if (typeof pattern !== 'string') {
      return {
        ok: false,
        error: { message: 'regular expression pattern must be a string' },
        outputs,
        outputMetadata,
      };
    }
    const flagsResult = evaluate({ filter: flagsFilter, input });
    if (!flagsResult.ok) {
      return replaceRuntimeFailureOutputs({
        result: clearRuntimeFailureOutputs({ result: flagsResult }),
        outputs,
        outputMetadata,
      });
    }
    const piecesByFlags: string[][] = [];
    if (flagsResult.outputs.length === 0) piecesByFlags.push([input]);
    for (const flags of flagsResult.outputs) {
      if (typeof flags !== 'string') {
        return {
          ok: false,
          error: { message: 'regular expression flags must be a string' },
          outputs,
          outputMetadata,
        };
      }
      const compiled = compileJqRegularExpression({ pattern, flags });
      if (!compiled.ok) {
        return { ok: false, error: { message: compiled.message }, outputs, outputMetadata };
      }
      const matchResult = evaluateRegularExpressionMatches({ input, compiled, global: true });
      if (!matchResult.ok) {
        return { ...matchResult, outputs, outputMetadata };
      }
      const flagPieces: string[] = [];
      let cursor = 0;
      for (const match of matchResult.matches) {
        flagPieces.push(input.slice(cursor, match.start));
        cursor = match.end;
      }
      flagPieces.push(input.slice(cursor));
      piecesByFlags.push(flagPieces);
    }

    // jq's split(re; flagsStream) resets the split cursor for every flags
    // value. It concatenates those segment streams while omitting the final
    // tail segment of every flags result except the last one.
    const pieces: string[] = [];
    for (let flagsIndex = 0; flagsIndex < piecesByFlags.length; flagsIndex += 1) {
      const flagPieces = piecesByFlags[flagsIndex]!;
      const end = flagsIndex + 1 === piecesByFlags.length
        ? flagPieces.length
        : Math.max(0, flagPieces.length - 1);
      if (!appendMaterializedValues({ target: pieces, source: flagPieces.slice(0, end) })) {
        return {
          ok: false,
          error: { message: `regular expression split materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
          outputs,
          outputMetadata,
        };
      }
    }
    const patternOutputs: JsonValue[] = (() => {
      switch (outputKind) {
      case 'split':
        return [pieces];
      case 'splits':
        return pieces;
      default: {
        const _ex: never = outputKind;
        throw new Error(`Unhandled jq regex split output kind: ${_ex}`);
      }
      }
    })();
    if (!appendMaterializedValues({ target: outputs, source: patternOutputs })) {
      return {
        ok: false,
        error: { message: `builtin output materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
        outputs,
        outputMetadata,
      };
    }
    const patternMetadata = metadataForRuntimeOutput({
      result: patternsResult,
      index: patternIndex,
      fallback: inputMetadata,
    });
    for (let index = 0; index < patternOutputs.length; index += 1) {
      outputMetadata.push(metadataWithoutNumberOrigin({ metadata: patternMetadata }));
    }
  }

  return patternsResult.ok
    ? { ok: true, outputs, outputMetadata }
    : replaceRuntimeFailureOutputs({ result: patternsResult, outputs, outputMetadata });
}

function evaluateBuiltinArgumentStreams({
  parameters,
  argumentFiltersInEvaluationOrder,
}: {
  parameters: EvaluateBuiltinParameters,
  argumentFiltersInEvaluationOrder: readonly JqFilter[],
}): JqRuntimeResult {
  const { input, evaluate, evaluateFirstOutput, inputMetadata } = parameters;
  const substitutedArguments = new Map<
    JqFilter,
    { readonly value: JsonValue; readonly metadata: JqRuntimeInputMetadata }
  >();
  const outputs: JsonValue[] = [];
  const outputMetadata: JqRuntimeInputMetadata[] = [];

  const substitute = ({
    filter,
    input: nestedInput,
    inputMetadata: nestedInputMetadata,
  }: {
    filter: JqFilter,
    input: JsonValue,
    inputMetadata?: JqRuntimeInputMetadata,
  }): JqRuntimeResult => {
    const argument = substitutedArguments.get(filter);
    return argument === undefined
      ? evaluate({ filter, input: nestedInput, inputMetadata: nestedInputMetadata })
      : { ok: true, outputs: [argument.value], outputMetadata: [argument.metadata] };
  };
  const substituteFirst = ({
    filter,
    input: nestedInput,
    inputMetadata: nestedInputMetadata,
  }: {
    filter: JqFilter,
    input: JsonValue,
    inputMetadata?: JqRuntimeInputMetadata,
  }): JqRuntimeResult => {
    const argument = substitutedArguments.get(filter);
    return argument === undefined
      ? evaluateFirstOutput({ filter, input: nestedInput, inputMetadata: nestedInputMetadata })
      : { ok: true, outputs: [argument.value], outputMetadata: [argument.metadata] };
  };

  const evaluateAt = ({ index }: { index: number }): Extract<JqRuntimeResult, { ok: false }> | undefined => {
    const argumentFilter = argumentFiltersInEvaluationOrder[index];
    if (argumentFilter === undefined) {
      const single = evaluateBuiltinSinglePass({
        ...parameters,
        evaluate: substitute,
        evaluateFirstOutput: substituteFirst,
      });
      const singleOutputs = single.ok ? single.outputs : runtimeFailureOutputs({ result: single });
      if (!appendMaterializedValues({ target: outputs, source: singleOutputs })) {
        return {
          ok: false,
          error: { message: `builtin output materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
          outputs,
          outputMetadata,
        };
      }
      for (let outputIndex = 0; outputIndex < singleOutputs.length; outputIndex += 1) {
        outputMetadata.push(metadataForRuntimeOutput({
          result: single,
          index: outputIndex,
          fallback: inputMetadata,
        }));
      }
      return single.ok
        ? undefined
        : replaceRuntimeFailureOutputs({ result: single, outputs, outputMetadata });
    }

    const argumentResult = evaluate({ filter: argumentFilter, input });
    const argumentValues = argumentResult.ok
      ? argumentResult.outputs
      : runtimeFailureOutputs({ result: argumentResult });
    for (let argumentIndex = 0; argumentIndex < argumentValues.length; argumentIndex += 1) {
      const previous = substitutedArguments.get(argumentFilter);
      substitutedArguments.set(argumentFilter, {
        value: argumentValues[argumentIndex]!,
        metadata: metadataForRuntimeOutput({
          result: argumentResult,
          index: argumentIndex,
          fallback: inputMetadata,
        }),
      });
      const failure = evaluateAt({ index: index + 1 });
      if (previous === undefined) substitutedArguments.delete(argumentFilter);
      else substitutedArguments.set(argumentFilter, previous);
      if (failure !== undefined) return failure;
    }
    return argumentResult.ok
      ? undefined
      : replaceRuntimeFailureOutputs({ result: argumentResult, outputs, outputMetadata });
  };

  const failure = evaluateAt({ index: 0 });
  return failure ?? { ok: true, outputs, outputMetadata };
}

export function evaluateBuiltinWithEvaluatedArguments({
  name,
  args,
  input,
  evaluate,
  takeInputs,
  inputMetadata,
  evaluateFirstOutput,
  emitStderr,
}: EvaluateBuiltinParameters): JqRuntimeResult {
  return evaluateBuiltinSinglePass({
    name,
    args,
    input,
    evaluate,
    takeInputs,
    inputMetadata,
    evaluateFirstOutput,
    emitStderr,
  });
}

function evaluateBuiltinSinglePass({
  name,
  args,
  input,
  evaluate,
  takeInputs,
  inputMetadata,
  evaluateFirstOutput,
  emitStderr,
}: EvaluateBuiltinParameters): JqRuntimeResult {
  switch (name) {
  case 'IN': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'IN takes one or two arguments' } };
    }
    const sourceFilter = args[0];
    const targetResult = args[1] === undefined
      ? { ok: true, outputs: [input] } as const
      : evaluate({ filter: args[1], input });
    const targets = targetResult.ok
      ? targetResult.outputs
      : runtimeFailureOutputs({ result: targetResult });
    if (!targetResult.ok && targets.length === 0) return targetResult;

    const sourceResult = evaluate({ filter: sourceFilter, input });
    const sourceValues = sourceResult.ok
      ? sourceResult.outputs
      : runtimeFailureOutputs({ result: sourceResult });
    for (const target of targets) {
      if (sourceValues.some((source) => jsonValuesEqual({ left: source, right: target }))) {
        return { ok: true, outputs: [true] };
      }
    }
    if (!targetResult.ok) return clearRuntimeFailureOutputs({ result: targetResult });
    if (!sourceResult.ok) return clearRuntimeFailureOutputs({ result: sourceResult });
    return { ok: true, outputs: [false] };
  }
  case 'INDEX': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'INDEX takes one or two arguments' } };
    }
    const sourceResult = (() => {
      if (args.length === 2) return evaluate({ filter: args[0]!, input });
      if (Array.isArray(input)) return { ok: true, outputs: [...input] } as const;
      if (isJsonObject(input)) return { ok: true, outputs: jsonObjectValues({ object: input }) } as const;
      return {
        ok: false,
        error: {
          message: `Cannot iterate over ${input === null ? 'null' : typeof input} (${stringifyForFormat({ value: input })})`,
        },
      } as const;
    })();
    if (!sourceResult.ok) return clearRuntimeFailureOutputs({ result: sourceResult });

    const keyFilter = args.length === 2 ? args[1] : args[0];
    if (keyFilter === undefined) {
      throw new Error('jq INDEX key filter is missing');
    }
    const indexed = createJsonObject();
    let indexedEntryCount = 0;
    for (const sourceValue of sourceResult.outputs) {
      const keys = evaluate({ filter: keyFilter, input: sourceValue });
      const keyValues = keys.ok ? keys.outputs : runtimeFailureOutputs({ result: keys });
      for (const keyValue of keyValues) {
        indexedEntryCount += 1;
        if (indexedEntryCount > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
          return {
            ok: false,
            error: { message: `INDEX materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
          };
        }
        defineJsonProperty({
          object: indexed,
          key: stringifyForFormat({ value: keyValue }),
          value: sourceValue,
        });
      }
      if (!keys.ok) return clearRuntimeFailureOutputs({ result: keys });
    }
    return { ok: true, outputs: [indexed] };
  }
  case 'JOIN': {
    if (args.length < 2 || args.length > 4 || args[0] === undefined || args[1] === undefined) {
      return { ok: false, error: { message: 'JOIN takes two to four arguments' } };
    }
    const indexResult = evaluate({ filter: args[0], input });
    const indexes = indexResult.ok ? indexResult.outputs : runtimeFailureOutputs({ result: indexResult });
    if (!indexResult.ok && indexes.length === 0) return indexResult;
    const outputs: JsonValue[] = [];

    for (const indexValue of indexes) {
      const sourceFilter: JqFilter = args.length === 2
        ? { kind: 'iterate', input: { kind: 'identity' }, optional: false }
        : args[1];
      const keyFilter = args.length === 2 ? args[1] : args[2];
      if (keyFilter === undefined) throw new Error('jq JOIN key filter is missing');
      const sourceResult = evaluate({ filter: sourceFilter, input });
      const sourceValues = sourceResult.ok
        ? sourceResult.outputs
        : runtimeFailureOutputs({ result: sourceResult });
      const collectedPairs: JsonValue[] = [];

      for (const sourceValue of sourceValues) {
        const lookupResult = evaluate({
          filter: {
            kind: 'dynamic_index',
            input: { kind: 'literal', value: indexValue },
            index: keyFilter,
            optional: false,
          },
          input: sourceValue,
        });
        if (!lookupResult.ok) return replaceRuntimeFailureOutputs({ result: lookupResult, outputs });
        const pair: JsonValue[] = [sourceValue];
        if (!appendMaterializedValues({ target: pair, source: lookupResult.outputs })) {
          return {
            ok: false,
            error: { message: `JOIN materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
            outputs,
          };
        }

        if (args.length === 2) {
          if (!appendMaterializedValues({ target: collectedPairs, source: [pair] })) {
            return {
              ok: false,
              error: { message: `JOIN materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
              outputs,
            };
          }
          continue;
        }
        if (args.length === 3) {
          outputs.push(pair);
          continue;
        }
        const joinFilter = args[3];
        if (joinFilter === undefined) throw new Error('jq JOIN expression is missing');
        const joined = evaluate({ filter: joinFilter, input: pair });
        const joinedOutputs = joined.ok ? joined.outputs : runtimeFailureOutputs({ result: joined });
        if (!appendMaterializedValues({ target: outputs, source: joinedOutputs })) {
          return {
            ok: false,
            error: { message: `JOIN materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
          };
        }
        if (!joined.ok) return replaceRuntimeFailureOutputs({ result: joined, outputs });
      }
      if (!sourceResult.ok) return replaceRuntimeFailureOutputs({ result: sourceResult, outputs });
      if (args.length === 2) outputs.push(collectedPairs);
    }
    return indexResult.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: indexResult, outputs });
  }
  case '@base64':
    if (args.length !== 0) {
      return { ok: false, error: { message: '@base64 does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [encodeBase64Text({ text: stringifyForFormat({ value: input, numberOrigin: inputMetadata.numberOrigin }) })],
    };
  case '@base64d': {
    if (args.length !== 0) {
      return { ok: false, error: { message: '@base64d does not take arguments' } };
    }
    const encoded = stringifyForFormat({ value: input });
    const decoded = decodeBase64Text({ text: encoded });
    if (!decoded.ok) {
      const reason = (() => {
        switch (decoded.reason) {
        case 'trailing_byte':
          return 'trailing base64 byte found';
        case 'invalid_data':
          return 'is not valid base64 data';
        default: {
          const _ex: never = decoded.reason;
          throw new Error(`Unhandled Base64 decode failure: ${_ex}`);
        }
        }
      })();
      return {
        ok: false,
        error: {
          message: `string (${stringifyJson({
            value: encoded,
            indentation: undefined,
            sortKeys: false,
            asciiOnly: false,
          })}) ${reason}`,
        },
      };
    }
    return { ok: true, outputs: [decoded.value] };
  }
  case '@csv': {
    if (args.length !== 0) {
      return { ok: false, error: { message: '@csv does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return {
        ok: false,
        error: {
          message: `${input === null ? 'null' : typeof input} (${stringifyForFormat({ value: input })}) cannot be csv-formatted, only array`,
        },
      };
    }
    const fields: string[] = [];
    for (const value of input) {
      const field = formatCsvField({ value });
      if (!field.ok) return { ok: false, error: { message: field.message } };
      fields.push(field.value);
    }
    return { ok: true, outputs: [fields.join(',')] };
  }
  case '@html':
    if (args.length !== 0) {
      return { ok: false, error: { message: '@html does not take arguments' } };
    }
    return { ok: true, outputs: [formatHtml({ value: input })] };
  case '@json':
    if (args.length !== 0) {
      return { ok: false, error: { message: '@json does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [stringifyJson({
        value: input,
        indentation: undefined,
        sortKeys: false,
        asciiOnly: false,
        numberOrigin: inputMetadata.numberOrigin,
      })],
    };
  case '@sh': {
    if (args.length !== 0) {
      return { ok: false, error: { message: '@sh does not take arguments' } };
    }
    const values = Array.isArray(input) ? input : [input];
    const fields: string[] = [];
    for (const value of values) {
      const field = formatShellScalar({ value });
      if (!field.ok) return { ok: false, error: { message: field.message } };
      fields.push(field.value);
    }
    return { ok: true, outputs: [fields.join(' ')] };
  }
  case '@text':
    if (args.length !== 0) {
      return { ok: false, error: { message: '@text does not take arguments' } };
    }
    return { ok: true, outputs: [stringifyForFormat({ value: input, numberOrigin: inputMetadata.numberOrigin })] };
  case '@tsv': {
    if (args.length !== 0) {
      return { ok: false, error: { message: '@tsv does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      const type = input === null ? 'null' : typeof input === 'boolean' ? 'boolean' : typeof input;
      return {
        ok: false,
        error: {
          message: `${type} (${stringifyForFormat({ value: input })}) cannot be tsv-formatted, only array`,
        },
      };
    }
    const fields: string[] = [];
    for (const value of input) {
      const field = formatTsvField({ value });
      if (!field.ok) return { ok: false, error: { message: field.message } };
      fields.push(field.value);
    }
    return { ok: true, outputs: [fields.join('	')] };
  }
  case '@uri':
    if (args.length !== 0) {
      return { ok: false, error: { message: '@uri does not take arguments' } };
    }
    return { ok: true, outputs: [formatUri({ value: input })] };
  case 'isfinite':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'isfinite does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [typeof input === 'number' && !(Math.abs(input) >= Number.MAX_VALUE)],
    };
  case 'not':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'not does not take arguments' } };
    }
    return { ok: true, outputs: [!truthy({ value: input })] };
  case 'finites':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'finites does not take arguments' } };
    }
    return typeof input === 'number' && !(Math.abs(input) >= Number.MAX_VALUE)
      ? { ok: true, outputs: [input] }
      : { ok: true, outputs: [] };
  case 'infinite':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'infinite does not take arguments' } };
    }
    return { ok: true, outputs: [Number.MAX_VALUE] };
  case 'isinfinite':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'isinfinite does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [typeof input === 'number' && !Number.isNaN(input) && Math.abs(input) >= Number.MAX_VALUE],
    };
  case 'isnan':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'isnan does not take arguments' } };
    }
    return { ok: true, outputs: [typeof input === 'number' && Number.isNaN(input)] };
  case 'isnormal':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'isnormal does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [typeof input === 'number'
        && Number.isFinite(input)
        && Math.abs(input) >= 2.2250738585072014e-308
        && Math.abs(input) < Number.MAX_VALUE],
    };
  case 'nan':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'nan does not take arguments' } };
    }
    return { ok: true, outputs: [Number.NaN] };
  case 'normals':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'normals does not take arguments' } };
    }
    return typeof input === 'number'
      && Number.isFinite(input)
      && Math.abs(input) >= 2.2250738585072014e-308
      && Math.abs(input) < Number.MAX_VALUE
      ? { ok: true, outputs: [input] }
      : { ok: true, outputs: [] };
  case 'format': {
    const formatFilter = args[0];
    if (formatFilter === undefined || args.length !== 1) {
      return { ok: false, error: { message: 'format takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: formatFilter, input });
    const formats = evaluated.ok
      ? evaluated.outputs
      : runtimeFailureOutputs({ result: evaluated });
    const outputs: JsonValue[] = [];
    for (const format of formats) {
      if (typeof format !== 'string') {
        const type = format === null
          ? 'null'
          : Array.isArray(format)
            ? 'array'
            : typeof format === 'object'
              ? 'object'
              : typeof format;
        return {
          ok: false,
          error: {
            message: `${type} (${stringifyJson({
              value: format,
              indentation: undefined,
              sortKeys: false,
              asciiOnly: false,
            })}) is not a valid format`,
          },
          outputs,
        };
      }
      const builtinName = (() => {
        switch (format) {
        case 'base64': return '@base64';
        case 'base64d': return '@base64d';
        case 'csv': return '@csv';
        case 'html': return '@html';
        case 'json': return '@json';
        case 'sh': return '@sh';
        case 'text': return '@text';
        case 'tsv': return '@tsv';
        case 'uri': return '@uri';
        default: return undefined;
        }
      })() satisfies JqBuiltinName | undefined;
      if (builtinName === undefined) {
        return {
          ok: false,
          error: { message: `${format} is not a valid format` },
          outputs,
        };
      }
      const formatted = evaluateBuiltin({
        name: builtinName,
        args: [],
        input,
        evaluate,
        takeInputs,
        inputMetadata,
        evaluateFirstOutput,
        emitStderr,
      });
      if (!formatted.ok) {
        return replaceRuntimeFailureOutputs({
          result: formatted,
          outputs: [...outputs, ...runtimeFailureOutputs({ result: formatted })],
        });
      }
      outputs.push(...formatted.outputs);
    }
    return evaluated.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: evaluated, outputs });
  }
  case 'gmtime': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'gmtime does not take arguments' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'gmtime() requires numeric inputs' } };
    }
    const parsed = jqGmtime({ value: input });
    return parsed === undefined
      ? { ok: false, error: { message: 'error converting number of seconds since epoch to datetime' } }
      : { ok: true, outputs: [parsed] };
  }
  case 'mktime': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'mktime does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'mktime requires array inputs' } };
    }
    const epochSeconds = jqMktime({ input });
    return epochSeconds === undefined
      ? { ok: false, error: { message: 'mktime requires parsed datetime inputs' } }
      : { ok: true, outputs: [epochSeconds] };
  }
  case 'localtime': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'localtime does not take arguments' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'localtime() requires numeric inputs' } };
    }
    const parsed = jqLocaltime({ value: input });
    return parsed === undefined
      ? { ok: false, error: { message: 'error converting number of seconds since epoch to datetime' } }
      : { ok: true, outputs: [parsed] };
  }
  case 'fromdate':
  case 'fromdateiso8601': {
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'strptime/1 requires string inputs and arguments' } };
    }
    const epochSeconds = parseJqIsoDate({ value: input });
    if (epochSeconds === undefined) {
      return {
        ok: false,
        error: {
          message: `date ${stringifyJson({
            value: input,
            indentation: undefined,
            sortKeys: false,
            asciiOnly: false,
          })} does not match format "%Y-%m-%dT%H:%M:%SZ"`,
        },
      };
    }
    return { ok: true, outputs: [epochSeconds] };
  }
  case 'strptime': {
    const formatFilter = args[0];
    if (formatFilter === undefined || args.length !== 1) {
      return { ok: false, error: { message: 'strptime takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: formatFilter, input });
    const formats = evaluated.ok ? evaluated.outputs : runtimeFailureOutputs({ result: evaluated });
    const outputs: JsonValue[] = [];
    for (const format of formats) {
      if (typeof input !== 'string' || typeof format !== 'string') {
        return {
          ok: false,
          error: { message: 'strptime/1 requires string inputs and arguments' },
          outputs,
        };
      }
      const parsed = parseJqStrptime({ value: input, format });
      if (parsed === undefined) {
        return {
          ok: false,
          error: {
            message: `date ${stringifyJson({
              value: input,
              indentation: undefined,
              sortKeys: false,
              asciiOnly: false,
            })} does not match format ${stringifyJson({
              value: format,
              indentation: undefined,
              sortKeys: false,
              asciiOnly: false,
            })}`,
          },
          outputs,
        };
      }
      outputs.push([...parsed]);
    }
    return evaluated.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: evaluated, outputs });
  }
  case 'strftime': {
    const formatFilter = args[0];
    if (formatFilter === undefined || args.length !== 1) {
      return { ok: false, error: { message: 'strftime takes exactly one argument' } };
    }
    const fields = jqParsedDateTime({ input, timezone: 'utc' });
    if (fields === undefined) {
      return { ok: false, error: { message: 'strftime/1 requires parsed datetime inputs' } };
    }
    const evaluated = evaluate({ filter: formatFilter, input });
    const formats = evaluated.ok ? evaluated.outputs : runtimeFailureOutputs({ result: evaluated });
    const outputs: JsonValue[] = [];
    for (const format of formats) {
      if (typeof format !== 'string') {
        return {
          ok: false,
          error: { message: 'strftime/1 requires a string format' },
          outputs,
        };
      }
      outputs.push(formatJqStrftime({ format, fields, timezone: 'utc' }));
    }
    return evaluated.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: evaluated, outputs });
  }
  case 'stderr':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'stderr does not take arguments' } };
    }
    emitStderr({ text: stringifyForFormat({ value: input, numberOrigin: inputMetadata.numberOrigin }) });
    return { ok: true, outputs: [input] };
  case 'strflocaltime': {
    const formatFilter = args[0];
    if (formatFilter === undefined || args.length !== 1) {
      return { ok: false, error: { message: 'strflocaltime takes exactly one argument' } };
    }
    const fields = jqParsedDateTime({ input, timezone: 'local' });
    if (fields === undefined) {
      return { ok: false, error: { message: 'strflocaltime/1 requires parsed datetime inputs' } };
    }
    const evaluated = evaluate({ filter: formatFilter, input });
    const formats = evaluated.ok ? evaluated.outputs : runtimeFailureOutputs({ result: evaluated });
    const outputs: JsonValue[] = [];
    for (const format of formats) {
      if (typeof format !== 'string') {
        return {
          ok: false,
          error: { message: 'strflocaltime/1 requires a string format' },
          outputs,
        };
      }
      outputs.push(formatJqStrftime({ format, fields, timezone: 'local' }));
    }
    return evaluated.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: evaluated, outputs });
  }
  case 'todate':
  case 'todateiso8601': {
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'strftime/1 requires parsed datetime inputs' } };
    }
    const formatted = formatJqIsoDate({ value: input });
    if (formatted === undefined) {
      return { ok: false, error: { message: `${name} input is outside the supported date range` } };
    }
    return { ok: true, outputs: [formatted] };
  }
  case 'abs':
  case 'acos':
  case 'acosh':
  case 'asin':
  case 'asinh':
  case 'atan':
  case 'atanh':
  case 'cbrt':
  case 'cos':
  case 'cosh':
  case 'exp':
  case 'exp2':
  case 'exp10':
  case 'expm1':
  case 'fabs':
  case 'log':
  case 'log1p':
  case 'log2':
  case 'log10':
  case 'sin':
  case 'sinh':
  case 'sqrt':
  case 'tan':
  case 'tanh':
  case 'trunc': {
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: `${name} input must be a number` } };
    }
    const value = (() => {
      switch (name) {
      case 'abs':
      case 'fabs':
        return Math.abs(toJqArithmeticNumber({ value: input }));
      case 'acos':
        return Math.acos(toJqArithmeticNumber({ value: input }));
      case 'acosh':
        return Math.acosh(toJqArithmeticNumber({ value: input }));
      case 'asin':
        return Math.asin(toJqArithmeticNumber({ value: input }));
      case 'asinh':
        return Math.asinh(toJqArithmeticNumber({ value: input }));
      case 'atan':
        return Math.atan(toJqArithmeticNumber({ value: input }));
      case 'atanh':
        return Math.atanh(toJqArithmeticNumber({ value: input }));
      case 'cbrt':
        return Math.cbrt(toJqArithmeticNumber({ value: input }));
      case 'cos':
        return Math.cos(toJqArithmeticNumber({ value: input }));
      case 'cosh':
        return Math.cosh(toJqArithmeticNumber({ value: input }));
      case 'exp':
        return Math.exp(toJqArithmeticNumber({ value: input }));
      case 'exp2':
        return Math.pow(2, toJqArithmeticNumber({ value: input }));
      case 'exp10':
        return Math.pow(10, toJqArithmeticNumber({ value: input }));
      case 'expm1':
        return Math.expm1(toJqArithmeticNumber({ value: input }));
      case 'log':
        return Math.log(toJqArithmeticNumber({ value: input }));
      case 'log1p':
        return Math.log1p(toJqArithmeticNumber({ value: input }));
      case 'log2':
        return Math.log2(toJqArithmeticNumber({ value: input }));
      case 'log10':
        return Math.log10(toJqArithmeticNumber({ value: input }));
      case 'sin':
        return Math.sin(toJqArithmeticNumber({ value: input }));
      case 'sinh':
        return Math.sinh(toJqArithmeticNumber({ value: input }));
      case 'sqrt':
        return Math.sqrt(toJqArithmeticNumber({ value: input }));
      case 'tan':
        return Math.tan(toJqArithmeticNumber({ value: input }));
      case 'tanh':
        return Math.tanh(toJqArithmeticNumber({ value: input }));
      case 'trunc':
        return Math.trunc(toJqArithmeticNumber({ value: input }));
      default: {
        const _ex: never = name;
        throw new Error(`Unhandled math builtin: ${_ex}`);
      }
      }
    })();
    const normalized = normalizeJqArithmeticResult({ value });
    const preserveNumberOrigin = name === 'abs' && (input >= 0 || Object.is(input, -0));
    return {
      ok: true,
      outputs: [normalized],
      outputMetadata: singleOutputMetadata({
        inputMetadata,
        numberOrigin: preserveNumberOrigin ? inputMetadata.numberOrigin : undefined,
      }),
    };
  }
  case 'add': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'add does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'add input must be an array' } };
    }
    const nonNullItems = input.filter((item) => item !== null);
    if (nonNullItems.length === 0) {
      return { ok: true, outputs: [null] };
    }
    let accumulator: JsonValue = nonNullItems[0]!;
    for (const item of nonNullItems.slice(1)) {
      const combined = addValues({
        left: accumulator,
        right: item,
      });
      if (combined === undefined) {
        return { ok: false, error: { message: 'add input elements must have compatible types' } };
      }
      accumulator = combined;
    }
    return { ok: true, outputs: [accumulator] };
  }
  case 'ascii_downcase':
  case 'ascii_upcase':
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: `${name} input must be a string` } };
    }
    return {
      ok: true,
      outputs: [(() => {
        switch (name) {
        case 'ascii_downcase':
          return mapAsciiLetters({ value: input, direction: 'down' });
        case 'ascii_upcase':
          return mapAsciiLetters({ value: input, direction: 'up' });
        default: {
          const _ex: never = name;
          throw new Error(`Unhandled ascii builtin: ${_ex}`);
        }
        }
      })()],
    };
  case 'arrays':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'arrays does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'array' }) };
  case 'all':
  case 'any': {
    if (args.length > 2) {
      return { ok: false, error: { message: `${name} takes at most two arguments` } };
    }

    const decisiveTruthiness = (() => {
      switch (name) {
      case 'any':
        return true;
      case 'all':
        return false;
      default: {
        const _ex: never = name;
        throw new Error(`Unhandled boolean aggregate: ${_ex}`);
      }
      }
    })();
    const decisiveResult = decisiveTruthiness;
    const exhaustedResult = !decisiveTruthiness;

    const inspectPredicate = ({
      evaluated,
    }: {
      evaluated: JqRuntimeResult,
    }): JqRuntimeResult | undefined => {
      const outputs = evaluated.ok ? evaluated.outputs : runtimeFailureOutputs({ result: evaluated });
      for (const output of outputs) {
        if (truthy({ value: output }) === decisiveTruthiness) {
          return { ok: true, outputs: [decisiveResult] };
        }
      }
      if (!evaluated.ok) {
        return constrainRuntimeInputRequest({
          result: clearRuntimeFailureOutputs({ result: evaluated }),
          maximumValues: 1,
        });
      }
      return undefined;
    };

    if (args.length === 2 && args[0] !== undefined && args[1] !== undefined) {
      const generated = evaluate({ filter: args[0], input });
      const generatedOutputs = generated.ok
        ? generated.outputs
        : runtimeFailureOutputs({ result: generated });
      for (const item of generatedOutputs) {
        const inspected = inspectPredicate({
          evaluated: evaluate({ filter: args[1], input: item }),
        });
        if (inspected !== undefined) return inspected;
      }
      if (!generated.ok) {
        return constrainRuntimeInputRequest({
          result: clearRuntimeFailureOutputs({ result: generated }),
          maximumValues: 1,
        });
      }
      return { ok: true, outputs: [exhaustedResult] };
    }

    const items = Array.isArray(input)
      ? input
      : isJsonObject(input)
        ? jsonObjectValues({ object: input })
        : undefined;
    if (items === undefined) {
      return { ok: false, error: { message: `${name} input must be an array or object` } };
    }

    const predicate = args[0];
    for (const item of items) {
      if (predicate === undefined) {
        if (truthy({ value: item }) === decisiveTruthiness) {
          return { ok: true, outputs: [decisiveResult] };
        }
        continue;
      }
      const inspected = inspectPredicate({
        evaluated: evaluate({ filter: predicate, input: item }),
      });
      if (inspected !== undefined) return inspected;
    }
    return { ok: true, outputs: [exhaustedResult] };
  }
  case 'bsearch': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'bsearch takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'bsearch input must be an array' } };
    }
    const needle = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!needle.ok) return needle;
    let low = 0;
    let high = input.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const compared = compareJsonValues({
        left: input[middle]!,
        right: needle.value,
        leftOrigin: getJsonChildNumberOrigin({ container: input, key: middle }),
        rightOrigin: needle.numberOrigin,
      });
      if (compared === 0) {
        return { ok: true, outputs: [middle] };
      }
      if (compared < 0) low = middle + 1;
      else high = middle - 1;
    }
    return { ok: true, outputs: [-low - 1] };
  }
  case 'booleans':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'booleans does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'boolean' }) };
  case 'ceil':
  case 'floor':
  case 'round':
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: `${name} input must be a number` } };
    }
    return {
      ok: true,
      outputs: [(() => {
        switch (name) {
        case 'ceil':
          return Math.ceil(input);
        case 'floor':
          return Math.floor(input);
        case 'round':
          return roundJqNumber({ value: input });
        default: {
          const _ex: never = name;
          throw new Error(`Unhandled numeric builtin: ${_ex}`);
        }
        }
      })()],
    };
  case 'combinations': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'combinations takes at most one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'combinations input must be an array' } };
    }
    if (args[0] === undefined) {
      const arrays: JsonValue[][] = [];
      for (const value of input) {
        if (!Array.isArray(value)) {
          return { ok: false, error: { message: 'combinations input elements must be arrays' } };
        }
        arrays.push(value);
      }
      return combinationsOf({ arrays });
    }
    const count = evaluateRepeatedCombinationCount({
      filter: args[0],
      input,
      evaluate,
    });
    if (!count.ok) return count;
    return repeatedCombinationsOf({
      values: input,
      count: count.value,
    });
  }
  case 'contains': {
    const expected = args[0];
    if (expected === undefined) {
      return { ok: false, error: { message: 'contains requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'contains takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: expected, input });
    if (!evaluated.ok) return evaluated;
    return {
      ok: true,
      outputs: [containsJson({ input, expected: evaluated.outputs[0] ?? null })],
    };
  }
  case 'del': {
    const pathFilter = args[0];
    if (pathFilter === undefined) {
      return { ok: false, error: { message: 'del requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'del takes exactly one argument' } };
    }

    const pathExpression = extractPathExpression({ filter: pathFilter });
    if (pathExpression === undefined) {
      return { ok: false, error: { message: 'del argument must be a path' } };
    }
    let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
    const materialized = materializeJqPathExpression({
      root: input,
      expression: pathExpression,
      evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
        const evaluated = evaluate({ filter: indexFilter, input: indexInput });
        if (evaluated.ok) return evaluated;
        dynamicPathFailure = evaluated;
        return { ok: false, message: evaluated.error.message };
      },
    });
    if (!materialized.ok) {
      return dynamicPathFailure === undefined
        ? { ok: false, error: { message: materialized.message } }
        : clearRuntimeFailureOutputs({ result: dynamicPathFailure });
    }
    const deleted = applyPathDeletions({ root: input, paths: materialized.paths });
    return deleted.ok
      ? { ok: true, outputs: [deleted.value] }
      : { ok: false, error: { message: deleted.message } };
  }
  case 'debug': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'debug takes at most one argument' } };
    }
    const argument = args[0];
    if (argument === undefined) {
      emitStderr({ text: formatJqDebugValue({ value: input }) });
      return { ok: true, outputs: [input] };
    }
    const evaluated = evaluate({ filter: argument, input });
    const values = evaluated.ok ? evaluated.outputs : runtimeFailureOutputs({ result: evaluated });
    for (const value of values) emitStderr({ text: formatJqDebugValue({ value }) });
    return evaluated.ok
      ? { ok: true, outputs: [input] }
      : clearRuntimeFailureOutputs({ result: evaluated });
  }
  case 'delpaths': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'delpaths takes exactly one argument' } };
    }
    const evaluated = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!evaluated.ok) return evaluated;
    if (!Array.isArray(evaluated.value)) {
      return { ok: false, error: { message: 'delpaths argument must be an array of paths' } };
    }
    const paths: JqPath[] = [];
    for (const rawPath of evaluated.value) {
      const parsed = parsePathArray({ value: rawPath });
      if (!parsed.ok) return { ok: false, error: { message: parsed.message } };
      paths.push(toJqPath({ path: parsed.path }));
    }
    const deleted = applyPathDeletions({ root: input, paths });
    return deleted.ok
      ? { ok: true, outputs: [deleted.value] }
      : { ok: false, error: { message: deleted.message } };
  }
  case 'empty':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'empty does not take arguments' } };
    }
    return { ok: true, outputs: [] };
  case 'error': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'error takes at most one argument' } };
    }
    if (args[0] === undefined) {
      return {
        ok: false,
        error: {
          message: formatJqErrorMessage({
            value: input,
            numberOrigin: inputMetadata.numberOrigin,
          }),
          value: input,
        },
      };
    }
    const message = evaluateFirstOutput({ filter: args[0], input });
    if (!message.ok) return message;
    const value = message.outputs[0];
    if (value === undefined) return { ok: true, outputs: [] };
    const metadata = metadataForRuntimeOutput({
      result: message,
      index: 0,
      fallback: inputMetadata,
    });
    return {
      ok: false,
      error: {
        message: formatJqErrorMessage({ value, numberOrigin: metadata.numberOrigin }),
        value,
        ...(message.outputMetadata === undefined ? {} : { metadata }),
      },
    };
  }
  case 'explode':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'explode does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'explode input must be a string' } };
    }
    return { ok: true, outputs: [[...input].map((character) => character.codePointAt(0) ?? 0)] };
  case 'first': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'first takes at most one argument' } };
    }
    if (args[0] === undefined) {
      if (input === null) {
        return { ok: true, outputs: [null] };
      }
      if (!Array.isArray(input)) {
        return { ok: false, error: { message: 'first input must be an array or null' } };
      }
      return { ok: true, outputs: [input[0] ?? null] };
    }
    const outputs = evaluate({
      filter: args[0],
      input,
    });
    if (!outputs.ok) {
      const first = runtimeFailureOutputs({ result: outputs })[0];
      return first === undefined
        ? constrainRuntimeInputRequest({
          result: clearRuntimeFailureOutputs({ result: outputs }),
          maximumValues: 1,
        })
        : { ok: true, outputs: [first] };
    }
    return { ok: true, outputs: outputs.outputs[0] === undefined ? [] : [outputs.outputs[0]] };
  }
  case 'flatten': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'flatten takes at most one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'flatten input must be an array' } };
    }
    let depth = Number.POSITIVE_INFINITY;
    if (args[0] !== undefined) {
      const evaluated = evaluateSingleOutput({ filter: args[0], input, evaluate });
      if (!evaluated.ok) return evaluated;
      if (typeof evaluated.value !== 'number' || !Number.isInteger(evaluated.value) || evaluated.value < 0) {
        return { ok: false, error: { message: 'flatten depth must be a non-negative integer' } };
      }
      depth = evaluated.value;
    }
    return { ok: true, outputs: [flattenArray({ input, depth })] };
  }
  case 'from_entries': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'from_entries does not take arguments' } };
    }
    const converted = fromEntriesValue({ input });
    return converted.ok
      ? { ok: true, outputs: [converted.value] }
      : { ok: false, error: { message: converted.message } };
  }
  case 'fromstream': {
    const streamFilter = args[0];
    if (args.length !== 1 || streamFilter === undefined) {
      return { ok: false, error: { message: 'fromstream takes exactly one argument' } };
    }
    const streamResult = evaluate({ filter: streamFilter, input });
    const streamValues = streamResult.ok
      ? streamResult.outputs
      : runtimeFailureOutputs({ result: streamResult });
    const outputs: JsonValue[] = [];
    let root: JsonValue = null;

    for (const streamValue of streamValues) {
      const parsed = parseJqStreamEvent({ event: streamValue });
      if (!parsed.ok) {
        return { ok: false, error: { message: parsed.message }, outputs };
      }
      const { path, value, hasValue } = parsed.event;
      if (hasValue) {
        const streamEventValue = value ?? null;
        if (path.length === 0) {
          if (!appendMaterializedValues({ target: outputs, source: [streamEventValue] })) {
            return {
              ok: false,
              error: {
                message: `output materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
              },
              outputs,
            };
          }
          root = null;
          continue;
        }
        const updated = applyJqStreamValue({ root, path, value: streamEventValue });
        if (!updated.ok) {
          return { ok: false, error: { message: updated.message }, outputs };
        }
        root = updated.value;
        continue;
      }
      if (path.length === 1) {
        if (!appendMaterializedValues({ target: outputs, source: [root] })) {
          return {
            ok: false,
            error: {
              message: `output materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
            },
            outputs,
          };
        }
        root = null;
      }
    }

    return streamResult.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: streamResult, outputs });
  }
  case 'fromjson': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'fromjson does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'fromjson input must be a string' } };
    }
    const parsed = parseJsonValueWithNumberOrigins({ text: input });
    return parsed.ok
      ? {
        ok: true,
        outputs: [parsed.value],
        outputMetadata: singleOutputMetadata({
          inputMetadata,
          numberOrigin: parsed.numberOrigin,
        }),
      }
      : { ok: false, error: { message: `fromjson parse error: ${parsed.message}` } };
  }
  case 'getpath': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'getpath takes exactly one argument' } };
    }
    const evaluated = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!evaluated.ok) return evaluated;
    const parsed = parsePathArray({ value: evaluated.value });
    if (!parsed.ok) return { ok: false, error: { message: parsed.message } };
    return { ok: true, outputs: [readPathValue({ input, path: parsed.path }) ?? null] };
  }
  case 'group_by': {
    const keyFilter = args[0];
    if (keyFilter === undefined) {
      return { ok: false, error: { message: 'group_by requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'group_by takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'group_by input must be an array' } };
    }

    const keyed = [];
    for (const entry of numberedArrayEntries({ input })) {
      const key = evaluateOrderingKey({
        filter: keyFilter,
        input: entry.value,
        inputMetadata: metadataWithNumberOrigin({ metadata: inputMetadata, numberOrigin: entry.numberOrigin }),
        evaluate,
      });
      if (!key.ok) return key;
      keyed.push({ key: key.value, keyOrigin: key.numberOrigin, item: entry });
    }

    keyed.sort((left, right) => compareJsonValues({
      left: left.key,
      right: right.key,
      leftOrigin: left.keyOrigin,
      rightOrigin: right.keyOrigin,
    }));
    const groups: { key: JsonValue, keyOrigin?: JqNumberOrigin, items: JqNumberedArrayEntry[] }[] = [];
    for (const entry of keyed) {
      const lastGroup = groups.at(-1);
      if (lastGroup !== undefined && compareJsonValues({
        left: entry.key,
        right: lastGroup.key,
        leftOrigin: entry.keyOrigin,
        rightOrigin: lastGroup.keyOrigin,
      }) === 0) {
        lastGroup.items.push(entry.item);
        continue;
      }
      groups.push({ key: entry.key, keyOrigin: entry.keyOrigin, items: [entry.item] });
    }
    return { ok: true, outputs: [groups.map((group) => numberedArrayFromEntries({ entries: group.items }))] };
  }
  case 'halt':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'halt does not take arguments' } };
    }
    return {
      ok: false,
      error: {
        message: 'halt',
        value: 'halt',
        halt: { exitCode: 0, stderr: '' },
      },
    };
  case 'halt_error': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'halt_error takes at most one argument' } };
    }
    let exitCode = 5;
    const codeFilter = args[0];
    if (codeFilter !== undefined) {
      const evaluated = evaluateFirstOutput({ filter: codeFilter, input });
      if (!evaluated.ok) return evaluated;
      const codeValue = evaluated.outputs[0];
      if (codeValue === undefined) return { ok: true, outputs: [] };
      if (typeof codeValue !== 'number') {
        return {
          ok: false,
          error: {
            message: `${jqDiagnosticTypeName({ value: input })} (${stringifyJson({
              value: input,
              indentation: undefined,
              sortKeys: false,
              asciiOnly: false,
            })}) halt_error/1: number required`,
          },
        };
      }
      const integerCode = Math.trunc(codeValue);
      exitCode = integerCode < 0 ? 0 : integerCode & 0xff;
    }
    return {
      ok: false,
      error: {
        message: 'halt_error',
        value: input,
        halt: {
          exitCode,
          stderr: formatJqHaltErrorInput({ value: input, numberOrigin: inputMetadata.numberOrigin }),
        },
      },
    };
  }
  case 'implode':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'implode does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'implode input must be an array' } };
    }
    {
      let output = '';
      for (const item of input) {
        if (typeof item !== 'number') {
          return { ok: false, error: { message: 'implode input elements must be numbers' } };
        }
        const codePoint = Math.trunc(item);
        const valid = codePoint >= 0
          && codePoint <= 0x10FFFF
          && (codePoint < 0xD800 || codePoint > 0xDFFF);
        output += String.fromCodePoint(valid ? codePoint : 0xFFFD);
      }
      return { ok: true, outputs: [output] };
    }
  case 'index':
  case 'indices': {
    const searchFilter = args[0];
    if (searchFilter === undefined) {
      return { ok: false, error: { message: `${name} requires one argument` } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: `${name} takes exactly one argument` } };
    }
    const searched = evaluateSingleOutput({
      filter: searchFilter,
      input,
      evaluate,
    });
    if (!searched.ok) return searched;
    const indices = findIndices({
      input,
      search: searched.value,
      searchOrigin: searched.numberOrigin,
    });
    if (indices === undefined) {
      return { ok: false, error: { message: `${name} input must be an array or string` } };
    }
    return (() => {
      switch (name) {
      case 'indices':
        return { ok: true, outputs: [indices] } as const;
      case 'index':
        return { ok: true, outputs: [indices[0] ?? null] } as const;
      default: {
        const _ex: never = name;
        throw new Error(`Unhandled index builtin: ${_ex}`);
      }
      }
    })();
  }
  case 'input':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'input does not take arguments' } };
    }
    return takeInputs({ maximumValues: 1, eofBehavior: 'break' });
  case 'input_filename':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'input_filename does not take arguments' } };
    }
    return { ok: true, outputs: [inputMetadata.filename] };
  case 'input_line_number':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'input_line_number does not take arguments' } };
    }
    return { ok: true, outputs: [inputMetadata.lineNumber] };
  case 'now':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'now does not take arguments' } };
    }
    return { ok: true, outputs: [Date.now() / 1000] };
  case 'inputs':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'inputs does not take arguments' } };
    }
    return takeInputs({ maximumValues: undefined, eofBehavior: 'empty' });
  case 'in': {
    const containerFilter = args[0];
    if (containerFilter === undefined) {
      return { ok: false, error: { message: 'in requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'in takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: containerFilter, input });
    const containers = evaluated.ok
      ? evaluated.outputs
      : runtimeFailureOutputs({ result: evaluated });
    const outputs: JsonValue[] = [];
    for (const container of containers) {
      if (Array.isArray(container)) {
        if (typeof input !== 'number' || !Number.isInteger(input)) {
          return {
            ok: false,
            error: { message: `Cannot check whether array has a ${input === null ? 'null' : typeof input} key` },
            outputs,
          };
        }
        outputs.push(input >= 0 && input < container.length);
        continue;
      }
      if (isJsonObject(container)) {
        if (typeof input !== 'string') {
          return {
            ok: false,
            error: { message: `Cannot check whether object has a ${input === null ? 'null' : typeof input} key` },
            outputs,
          };
        }
        outputs.push(Object.hasOwn(container, input));
        continue;
      }
      return {
        ok: false,
        error: {
          message: `Cannot check whether ${container === null ? 'null' : typeof container} has a ${input === null ? 'null' : typeof input} key`,
        },
        outputs,
      };
    }
    return evaluated.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: evaluated, outputs });
  }
  case 'inside': {
    const expected = args[0];
    if (expected === undefined) {
      return { ok: false, error: { message: 'inside requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'inside takes exactly one argument' } };
    }
    const evaluated = evaluateSingleOutput({
      filter: expected,
      input,
      evaluate,
    });
    if (!evaluated.ok) return evaluated;
    return {
      ok: true,
      outputs: [insideJson({ input, expected: evaluated.value })],
    };
  }
  case 'select': {
    const condition = args[0];
    if (condition === undefined) {
      return { ok: false, error: { message: 'select requires one argument' } };
    }
    const evaluated = evaluate({ filter: condition, input });
    const predicateOutputs = evaluated.ok
      ? evaluated.outputs
      : runtimeFailureOutputs({ result: evaluated });
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let index = 0; index < predicateOutputs.length; index += 1) {
      if (!truthy({ value: predicateOutputs[index]! })) continue;
      outputs.push(input);
      outputMetadata.push(metadataWithNumberOrigin({
        metadata: metadataForRuntimeOutput({
          result: evaluated,
          index,
          fallback: inputMetadata,
        }),
        numberOrigin: inputMetadata.numberOrigin,
      }));
    }
    return evaluated.ok
      ? evaluated.outputMetadata === undefined
        ? { ok: true, outputs }
        : { ok: true, outputs, outputMetadata }
      : replaceRuntimeFailureOutputs({
        result: evaluated,
        outputs,
        outputMetadata: evaluated.outputMetadata === undefined ? undefined : outputMetadata,
      });
  }
  case 'map': {
    const mapper = args[0];
    if (mapper === undefined) {
      return { ok: false, error: { message: 'map requires one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'map input must be an array' } };
    }

    const result: JsonValue[] = [];
    for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
      const item = input[inputIndex]!;
      const itemMetadata = singleOutputMetadata({
        inputMetadata,
        numberOrigin: typeof item === 'number'
          ? getJsonChildNumberOrigin({ container: input, key: inputIndex })
          : undefined,
      })[0]!;
      const mapped = evaluate({ filter: mapper, input: item, inputMetadata: itemMetadata });
      if (!mapped.ok) return clearRuntimeFailureOutputs({ result: mapped });
      if (result.length + mapped.outputs.length > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
        return {
          ok: false,
          error: { message: `map materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
        };
      }
      for (let outputIndex = 0; outputIndex < mapped.outputs.length; outputIndex += 1) {
        const targetIndex = result.length;
        const output = mapped.outputs[outputIndex]!;
        result.push(output);
        setJsonChildNumberOrigin({
          container: result,
          key: targetIndex,
          origin: typeof output === 'number'
            ? metadataForRuntimeOutput({
              result: mapped,
              index: outputIndex,
              fallback: metadataWithoutNumberOrigin({ metadata: itemMetadata }),
            }).numberOrigin
            : undefined,
        });
      }
    }
    return { ok: true, outputs: [result] };
  }
  case 'map_values': {
    const mapper = args[0];
    if (mapper === undefined) {
      return { ok: false, error: { message: 'map_values requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'map_values takes exactly one argument' } };
    }
    if (Array.isArray(input)) {
      const result: JsonValue[] = [];
      for (let inputIndex = 0; inputIndex < input.length; inputIndex += 1) {
        const value = input[inputIndex]!;
        const valueMetadata = singleOutputMetadata({
          inputMetadata,
          numberOrigin: typeof value === 'number'
            ? getJsonChildNumberOrigin({ container: input, key: inputIndex })
            : undefined,
        })[0]!;
        const mapped = evaluateFirstOutput({
          filter: mapper,
          input: value,
          inputMetadata: valueMetadata,
        });
        if (!mapped.ok) return clearRuntimeFailureOutputs({ result: mapped });
        const first = mapped.outputs[0];
        if (first !== undefined) {
          const targetIndex = result.length;
          result.push(first);
          setJsonChildNumberOrigin({
            container: result,
            key: targetIndex,
            origin: typeof first === 'number'
              ? metadataForRuntimeOutput({
                result: mapped,
                index: 0,
                fallback: metadataWithoutNumberOrigin({ metadata: valueMetadata }),
              }).numberOrigin
              : undefined,
          });
        }
      }
      return { ok: true, outputs: [result] };
    }
    if (!isJsonObject(input)) {
      return { ok: false, error: { message: 'map_values input must be an array or object' } };
    }

    const result = createJsonObject();
    for (const [key, value] of Object.entries(input)) {
      const valueMetadata = singleOutputMetadata({
        inputMetadata,
        numberOrigin: typeof value === 'number'
          ? getJsonChildNumberOrigin({ container: input, key })
          : undefined,
      })[0]!;
      const mapped = evaluateFirstOutput({
        filter: mapper,
        input: value,
        inputMetadata: valueMetadata,
      });
      if (!mapped.ok) return mapped;
      const first = mapped.outputs[0];
      if (first !== undefined) {
        defineJsonProperty({ object: result, key, value: first });
        setJsonChildNumberOrigin({
          container: result,
          key,
          origin: typeof first === 'number'
            ? metadataForRuntimeOutput({
              result: mapped,
              index: 0,
              fallback: metadataWithoutNumberOrigin({ metadata: valueMetadata }),
            }).numberOrigin
            : undefined,
        });
      }
    }
    return { ok: true, outputs: [result] };
  }
  case 'frexp': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'frexp does not take arguments' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'frexp input must be a number' } };
    }
    const [fraction, exponent] = splitFloatingPoint({ value: input });
    return { ok: true, outputs: [[fraction, exponent]] };
  }
  case 'logb': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'logb does not take arguments' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'logb input must be a number' } };
    }
    const value = Number.isNaN(input)
      ? Number.NaN
      : input === 0
        ? -Number.MAX_VALUE
        : Math.abs(input) >= Number.MAX_VALUE
          ? Number.MAX_VALUE
          : Math.floor(Math.log2(Math.abs(input)));
    return { ok: true, outputs: [value] };
  }
  case 'modf': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'modf does not take arguments' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'modf input must be a number' } };
    }
    if (Number.isNaN(input)) return { ok: true, outputs: [[Number.NaN, Number.NaN]] };
    if (Math.abs(input) >= Number.MAX_VALUE) {
      return { ok: true, outputs: [[input < 0 ? -0 : 0, input]] };
    }
    const integral = Math.trunc(input);
    const fractional = input - integral;
    return { ok: true, outputs: [[fractional === 0 && input < 0 ? -0 : fractional, integral]] };
  }
  case 'nearbyint':
  case 'rint': {
    if (args.length !== 0) {
      return { ok: false, error: { message: `${name} does not take arguments` } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: `${name} input must be a number` } };
    }
    return { ok: true, outputs: [jqRoundTiesToEven({ value: input })] };
  }
  case 'significand': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'significand does not take arguments' } };
    }
    if (typeof input !== 'number') {
      return { ok: false, error: { message: 'significand input must be a number' } };
    }
    if (Number.isNaN(input) || input === 0 || Math.abs(input) >= Number.MAX_VALUE) {
      return { ok: true, outputs: [input] };
    }
    const exponent = Math.floor(Math.log2(Math.abs(input)));
    return { ok: true, outputs: [input / Math.pow(2, exponent)] };
  }
  case 'nulls':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'nulls does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'null' }) };
  case 'numbers':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'numbers does not take arguments' } };
    }
    return typeFilter({ input, expected: 'number' }).length === 0
      ? { ok: true, outputs: [] }
      : { ok: true, outputs: [input], outputMetadata: [inputMetadata] };
  case 'objects':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'objects does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'object' }) };
  case 'path': {
    const argument = args[0];
    if (args.length !== 1 || argument === undefined) {
      return { ok: false, error: { message: 'path takes exactly one argument' } };
    }
    const pathExpression = extractPathExpression({ filter: argument });
    if (pathExpression === undefined) {
      return { ok: false, error: { message: 'path argument must be a path expression' } };
    }
    let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
    const materialized = materializeJqPathExpression({
      root: input,
      expression: pathExpression,
      evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
        const evaluated = evaluate({ filter: indexFilter, input: indexInput });
        if (evaluated.ok) return evaluated;
        dynamicPathFailure = evaluated;
        return { ok: false, message: evaluated.error.message };
      },
    });
    if (!materialized.ok) {
      return dynamicPathFailure === undefined
        ? { ok: false, error: { message: materialized.message } }
        : dynamicPathFailure;
    }
    return {
      ok: true,
      outputs: materialized.paths.map(path => jqPathOutput({ path })),
    };
  }
  case 'paths': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'paths takes at most one argument' } };
    }
    const predicate = args[0];
    const outputs: JsonValue[] = [];
    let materializedSegmentCount = 0;
    if (predicate !== undefined) {
      // jq evaluates the root for effects even though paths never emits the root path `[]`.
      const rootPredicate = evaluate({ filter: predicate, input });
      if (!rootPredicate.ok) {
        return replaceRuntimeFailureOutputs({ result: rootPredicate, outputs: [] });
      }
    }
    for (const entry of iteratePaths({ value: input, current: [] })) {
      let outputCount = 1;
      if (predicate !== undefined) {
        const evaluated = evaluate({ filter: predicate, input: entry.value });
        const predicateOutputs = evaluated.ok
          ? evaluated.outputs
          : runtimeFailureOutputs({ result: evaluated });
        outputCount = 0;
        for (const value of predicateOutputs) {
          if (truthy({ value })) outputCount += 1;
        }
        for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
          materializedSegmentCount += entry.path.length;
          if (materializedSegmentCount > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
            return {
              ok: false,
              error: { message: `paths materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
              outputs,
            };
          }
          outputs.push(entry.path);
        }
        if (!evaluated.ok) {
          return replaceRuntimeFailureOutputs({ result: evaluated, outputs });
        }
        continue;
      }
      for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
        materializedSegmentCount += entry.path.length;
        if (materializedSegmentCount > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
          return {
            ok: false,
            error: { message: `paths materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
            outputs,
          };
        }
        outputs.push(entry.path);
      }
    }
    return { ok: true, outputs };
  }
  case 'pick': {
    const argument = args[0];
    if (argument === undefined || args.length !== 1) {
      return { ok: false, error: { message: 'pick takes exactly one argument' } };
    }
    const pathExpression = extractPathExpression({ filter: argument });
    if (pathExpression === undefined) {
      return { ok: false, error: { message: 'pick argument must contain paths' } };
    }
    let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
    const materialized = materializeJqPathExpression({
      root: input,
      expression: pathExpression,
      evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
        const evaluated = evaluate({ filter: indexFilter, input: indexInput });
        if (evaluated.ok) return evaluated;
        dynamicPathFailure = evaluated;
        return { ok: false, message: evaluated.error.message };
      },
    });
    if (!materialized.ok) {
      return dynamicPathFailure === undefined
        ? { ok: false, error: { message: materialized.message } }
        : clearRuntimeFailureOutputs({ result: dynamicPathFailure });
    }

    let root: JsonValue = null;
    for (const jqPath of materialized.paths) {
      const selected = readJqPathValue({ root: input, path: jqPath });
      if (!selected.ok) return { ok: false, error: { message: selected.message } };
      if (selected.skipped) continue;
      const updated = applyPathUpdate({
        root,
        path: jqPath,
        update: () => ({
          ok: true,
          value: selected.value ?? null,
          ...(selected.numberOrigin === undefined ? {} : { numberOrigin: selected.numberOrigin }),
        }),
      });
      if (!updated.ok) return { ok: false, error: { message: updated.message } };
      root = updated.value;
    }
    return { ok: true, outputs: [root] };
  }
  case 'atan2':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => Math.atan2(left, right),
    });
  case 'copysign':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => (
        right < 0 || Object.is(right, -0) ? -Math.abs(left) : Math.abs(left)
      ),
    });
  case 'fdim':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      normalizeInputs: false,
      operation: ({ left, right }) => (
        Number.isNaN(left) || Number.isNaN(right) ? Number.NaN : left > right ? left - right : 0
      ),
    });
  case 'fmax':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      normalizeInputs: false,
      operation: ({ left, right }) => (
        Number.isNaN(left) ? right : Number.isNaN(right) ? left : left >= right ? left : right
      ),
    });
  case 'fmin':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      normalizeInputs: false,
      operation: ({ left, right }) => (
        Number.isNaN(left) ? right : Number.isNaN(right) ? left : left <= right ? left : right
      ),
    });
  case 'fmod':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => left % right,
    });
  case 'hypot':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => Math.hypot(left, right),
    });
  case 'ldexp':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => left * Math.pow(2, Math.trunc(right)),
    });
  case 'remainder':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => {
        if (!Number.isFinite(left) || right === 0 || Number.isNaN(right)) return Number.NaN;
        if (!Number.isFinite(right)) return left;
        return left - roundTiesToEven({ value: left / right }) * right;
      },
    });
  case 'drem':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => {
        if (!Number.isFinite(left) || right === 0 || Number.isNaN(right)) return Number.NaN;
        if (!Number.isFinite(right)) return left;
        return left - roundTiesToEven({ value: left / right }) * right;
      },
    });
  case 'nextafter':
  case 'nexttoward':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => nextRepresentableNumber({ from: left, toward: right }),
    });
  case 'scalb':
  case 'scalbln':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => left * Math.pow(2, Math.trunc(right)),
    });
  case 'pow':
    return evaluateBinaryNumericBuiltin({
      name,
      args,
      input,
      evaluate,
      operation: ({ left, right }) => Math.pow(left, right),
    });
  case 'range': {
    if (args.length === 0 || args.length > 3) {
      return { ok: false, error: { message: 'range takes one to three arguments' } };
    }

    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    let hasOutputMetadata = false;

    const appendRange = ({
      values,
      metadata,
      metadataIsExplicit,
      startNumberOrigin,
    }: {
      values: readonly JsonValue[],
      metadata: JqRuntimeInputMetadata,
      metadataIsExplicit: boolean,
      startNumberOrigin: JqNumberOrigin | undefined,
    }): JqRuntimeResult => {
      const numericArgs: number[] = [];
      for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return {
            ok: false,
            error: { message: 'range arguments must be finite numbers' },
            outputs,
            outputMetadata,
          };
        }
        numericArgs.push(value);
      }
      const [start, end, step] = (() => {
        switch (numericArgs.length) {
        case 1:
          return [0, numericArgs[0]!, 1] as const;
        case 2:
          return [numericArgs[0]!, numericArgs[1]!, 1] as const;
        case 3:
          return [numericArgs[0]!, numericArgs[1]!, numericArgs[2]!] as const;
        default: {
          const _ex: never = numericArgs.length as never;
          throw new Error(`Unhandled range arity: ${_ex}`);
        }
        }
      })();
      if (step === 0) return { ok: true, outputs: [] };
      const directionMatches = step > 0 ? start < end : start > end;
      if (!directionMatches) return { ok: true, outputs: [] };
      const estimatedLength = Math.ceil(Math.abs((end - start) / step));
      if (
        !Number.isFinite(estimatedLength)
        || estimatedLength > JQ_MAX_MATERIALIZED_VALUE_LENGTH - outputs.length
      ) {
        return {
          ok: false,
          error: { message: `range materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
          outputs,
          outputMetadata,
        };
      }
      const generatedMetadata = metadataWithoutNumberOrigin({ metadata });
      let rangeGeneratedCount = 0;
      const appendGeneratedValue = ({ value }: { value: number }): JqRuntimeResult | undefined => {
        if (outputs.length >= JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
          return {
            ok: false,
            error: { message: `range materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
            outputs,
            outputMetadata,
          };
        }
        outputs.push(value);
        outputMetadata.push(metadataWithNumberOrigin({
          metadata: generatedMetadata,
          numberOrigin: rangeGeneratedCount === 0 ? startNumberOrigin : undefined,
        }));
        rangeGeneratedCount += 1;
        hasOutputMetadata ||= metadataIsExplicit || startNumberOrigin !== undefined;
        return undefined;
      };
      if (step > 0) {
        for (let value = start; value < end; value += step) {
          const appended = appendGeneratedValue({ value });
          if (appended !== undefined) return appended;
        }
      } else {
        for (let value = start; value > end; value += step) {
          const appended = appendGeneratedValue({ value });
          if (appended !== undefined) return appended;
        }
      }
      return { ok: true, outputs: [] };
    };

    const evaluateArgument = ({
      index,
      values,
      metadata,
      metadataIsExplicit,
      startNumberOrigin,
    }: {
      index: number,
      values: readonly JsonValue[],
      metadata: JqRuntimeInputMetadata,
      metadataIsExplicit: boolean,
      startNumberOrigin: JqNumberOrigin | undefined,
    }): JqRuntimeResult => {
      if (index >= args.length) {
        return appendRange({ values, metadata, metadataIsExplicit, startNumberOrigin });
      }
      const argument = args[index];
      if (argument === undefined) {
        throw new Error(`Missing jq range argument ${index}`);
      }
      const evaluated = evaluate({ filter: argument, input, inputMetadata: metadata });
      const argumentOutputs = evaluated.ok
        ? evaluated.outputs
        : runtimeFailureOutputs({ result: evaluated });
      for (let outputIndex = 0; outputIndex < argumentOutputs.length; outputIndex += 1) {
        const argumentMetadata = metadataForRuntimeOutput({
          result: evaluated,
          index: outputIndex,
          fallback: metadata,
        });
        const nested = evaluateArgument({
          index: index + 1,
          values: [...values, argumentOutputs[outputIndex]!],
          metadata: argumentMetadata,
          metadataIsExplicit: metadataIsExplicit || evaluated.outputMetadata !== undefined,
          startNumberOrigin: index === 0 && args.length >= 2
            ? argumentMetadata.numberOrigin
            : startNumberOrigin,
        });
        if (!nested.ok) return nested;
      }
      return evaluated.ok
        ? { ok: true, outputs: [] }
        : replaceRuntimeFailureOutputs({ result: evaluated, outputs, outputMetadata });
    };

    const evaluated = evaluateArgument({
      index: 0,
      values: [],
      metadata: inputMetadata,
      metadataIsExplicit: false,
      startNumberOrigin: undefined,
    });
    return evaluated.ok
      ? hasOutputMetadata
        ? { ok: true, outputs, outputMetadata }
        : { ok: true, outputs }
      : evaluated;
  }
  case 'recurse': {
    if (args.length > 2) {
      return { ok: false, error: { message: 'recurse takes at most two arguments' } };
    }
    const nextFilter = args[0];
    const conditionFilter = args[1];
    const recursed = recurseValues({
      input,
      evaluateNext: ({ input: nestedInput }) => {
        const candidateValues = (() => {
          if (nextFilter === undefined) {
            return { ok: true as const, outputs: recurseChildren({ input: nestedInput }) };
          }
          return evaluate({ filter: nextFilter, input: nestedInput });
        })();
        if (!candidateValues.ok) return candidateValues;
        if (conditionFilter === undefined) {
          return { ok: true, values: candidateValues.outputs };
        }
        const values: JsonValue[] = [];
        for (const candidate of candidateValues.outputs) {
          const condition = evaluate({ filter: conditionFilter, input: candidate });
          if (!condition.ok) return condition;
          if (condition.outputs.some((value) => truthy({ value }))) {
            values.push(candidate);
          }
        }
        return { ok: true, values };
      },
    });
    if (!recursed.ok) return recursed;
    return { ok: true, outputs: recursed.values };
  }
  case 'length':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'length does not take arguments' } };
    }
    switch (typeof input) {
    case 'string':
      return { ok: true, outputs: [input.length] };
    case 'number':
      return { ok: true, outputs: [Math.abs(input)] };
    case 'boolean':
      return { ok: false, error: { message: 'length is not defined for booleans' } };
    case 'object':
      if (input === null) return { ok: true, outputs: [0] };
      if (Array.isArray(input)) return { ok: true, outputs: [input.length] };
      return { ok: true, outputs: [jsonObjectKeys({ object: input }).length] };
    default: {
      const _ex: never = input;
      throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
    }
    }
  case 'keys':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'keys does not take arguments' } };
    }
    if (Array.isArray(input)) {
      return { ok: true, outputs: [input.map((_value, index) => index)] };
    }
    if (typeof input === 'object' && input !== null) {
      return { ok: true, outputs: [jsonObjectKeys({ object: input }).sort()] };
    }
    return { ok: false, error: { message: 'keys input must be an array or object' } };
  case 'keys_unsorted':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'keys_unsorted does not take arguments' } };
    }
    if (Array.isArray(input)) {
      return { ok: true, outputs: [input.map((_value, index) => index)] };
    }
    if (typeof input === 'object' && input !== null) {
      return { ok: true, outputs: [jsonObjectKeys({ object: input })] };
    }
    return { ok: false, error: { message: 'keys_unsorted input must be an array or object' } };
  case 'isempty': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'isempty takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: args[0], input });
    if (!evaluated.ok) {
      return runtimeFailureOutputs({ result: evaluated }).length > 0
        ? { ok: true, outputs: [false] }
        : constrainRuntimeInputRequest({
          result: clearRuntimeFailureOutputs({ result: evaluated }),
          maximumValues: 1,
        });
    }
    return { ok: true, outputs: [evaluated.outputs.length === 0] };
  }
  case 'iterables':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'iterables does not take arguments' } };
    }
    return Array.isArray(input) || isJsonObject(input)
      ? { ok: true, outputs: [input] }
      : { ok: true, outputs: [] };
  case 'join': {
    const separatorFilter = args[0];
    if (separatorFilter === undefined) {
      return { ok: false, error: { message: 'join requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'join takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'join input must be an array' } };
    }
    const evaluated = evaluate({ filter: separatorFilter, input });
    if (!evaluated.ok) return evaluated;
    const separator = evaluated.outputs[0];
    if (typeof separator !== 'string') {
      return { ok: false, error: { message: 'join separator must be a string' } };
    }
    const parts: string[] = [];
    let outputLength = Math.max(input.length - 1, 0) * separator.length;
    for (const item of input) {
      let part: string;
      switch (typeof item) {
      case 'string':
      case 'number':
      case 'boolean':
        part = String(item);
        break;
      case 'object':
        if (item === null) {
          part = '';
          break;
        }
        return { ok: false, error: { message: 'join input elements must be scalars' } };
      default: {
        const _ex: never = item;
        throw new Error(`Unhandled jq join value: ${JSON.stringify(_ex)}`);
      }
      }
      outputLength += part.length;
      if (outputLength > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
        return {
          ok: false,
          error: { message: `join materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}` },
        };
      }
      parts.push(part);
    }
    return { ok: true, outputs: [parts.join(separator)] };
  }
  case 'limit':
  case 'nth': {
    if (name === 'nth' && args.length === 1 && args[0] !== undefined) {
      const indexValue = evaluateSingleOutput({ filter: args[0], input, evaluate });
      if (!indexValue.ok) return indexValue;
      if (typeof indexValue.value !== 'number' || !Number.isInteger(indexValue.value)) {
        return { ok: false, error: { message: 'nth index must be an integer' } };
      }
      if (input === null) {
        return { ok: true, outputs: [null] };
      }
      if (!Array.isArray(input)) {
        return { ok: false, error: { message: 'nth input must be an array or null' } };
      }
      const normalizedIndex = indexValue.value >= 0
        ? indexValue.value
        : input.length + indexValue.value;
      return { ok: true, outputs: [input[normalizedIndex] ?? null] };
    }
    if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
      return { ok: false, error: { message: `${name} takes exactly two arguments` } };
    }
    const count = evaluateCount({ filter: args[0], input, evaluate, name });
    if (!count.ok) return count;
    const generated = evaluate({ filter: args[1], input });
    const generatedOutputs = generated.ok
      ? generated.outputs
      : runtimeFailureOutputs({ result: generated });
    switch (name) {
    case 'limit': {
      const outputs = generatedOutputs.slice(0, count.value);
      if (generated.ok || outputs.length >= count.value) return { ok: true, outputs };
      return constrainRuntimeInputRequest({
        result: replaceRuntimeFailureOutputs({ result: generated, outputs }),
        maximumValues: Math.max(count.value - outputs.length, 1),
      });
    }
    case 'nth': {
      const selected = generatedOutputs[count.value];
      if (selected !== undefined) return { ok: true, outputs: [selected] };
      if (generated.ok) return { ok: true, outputs: [] };
      return constrainRuntimeInputRequest({
        result: clearRuntimeFailureOutputs({ result: generated }),
        maximumValues: Math.max(count.value + 1 - generatedOutputs.length, 1),
      });
    }
    default: {
      const _ex: never = name;
      throw new Error(`Unhandled stream count builtin: ${_ex}`);
    }
    }
  }
  case 'last': {
    if (args.length > 1) {
      return { ok: false, error: { message: 'last takes at most one argument' } };
    }
    if (args[0] === undefined) {
      if (input === null) {
        return { ok: true, outputs: [null] };
      }
      if (!Array.isArray(input)) {
        return { ok: false, error: { message: 'last input must be an array or null' } };
      }
      return { ok: true, outputs: [input.at(-1) ?? null] };
    }
    const outputs = evaluate({
      filter: args[0],
      input,
    });
    if (!outputs.ok) return clearRuntimeFailureOutputs({ result: outputs });
    const value = outputs.outputs.at(-1);
    return { ok: true, outputs: value === undefined ? [] : [value] };
  }
  case 'ltrimstr': {
    const prefixFilter = args[0];
    if (prefixFilter === undefined) {
      return { ok: false, error: { message: 'ltrimstr requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'ltrimstr takes exactly one argument' } };
    }
    const prefix = evaluateSingleOutput({
      filter: prefixFilter,
      input,
      evaluate,
    });
    if (!prefix.ok) return prefix;
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'ltrimstr input must be a string' } };
    }
    return {
      ok: true,
      outputs: [typeof prefix.value === 'string'
        ? trimStartPrefix({ value: input, prefix: prefix.value })
        : input],
    };
  }
  case 'endswith': {
    const suffix = args[0];
    if (suffix === undefined) {
      return { ok: false, error: { message: 'endswith requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'endswith takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: suffix, input });
    if (!evaluated.ok) return evaluated;
    const value = evaluated.outputs[0];
    if (typeof input !== 'string' || typeof value !== 'string') {
      return { ok: false, error: { message: 'endswith expects string input and argument' } };
    }
    return { ok: true, outputs: [input.endsWith(value)] };
  }
  case 'test': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'test takes one or two arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'test input must be a string' } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: args[0],
      flagsFilter: args[1],
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: false,
    });
    if (!matchResult.ok) return matchResult;
    const matches = matchResult.matches;
    return { ok: true, outputs: [matches.length !== 0] };
  }
  case 'match': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'match takes one or two arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'match input must be a string' } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: args[0],
      flagsFilter: args[1],
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: regularExpression.compiled.requestedGlobal,
    });
    if (!matchResult.ok) return matchResult;
    const matches = matchResult.matches;
    return {
      ok: true,
      outputs: matches.map((match) => createMatchObject({ input, match })),
    };
  }
  case 'capture': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'capture takes one or two arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'capture input must be a string' } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: args[0],
      flagsFilter: args[1],
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: regularExpression.compiled.requestedGlobal,
    });
    if (!matchResult.ok) return matchResult;
    return {
      ok: true,
      outputs: matchResult.matches.map((match) => createNamedCaptureObject({ match })),
    };
  }
  case 'scan': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'scan takes one or two arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'scan input must be a string' } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: args[0],
      flagsFilter: args[1],
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: true,
    });
    if (!matchResult.ok) return matchResult;
    const matches = matchResult.matches;
    return {
      ok: true,
      outputs: matches.map((match) => {
        if (match.captures.length === 0) return match.text;
        return match.captures.map((capture) => capture.text);
      }),
    };
  }
  case 'splits': {
    if (args.length < 1 || args.length > 2 || args[0] === undefined) {
      return { ok: false, error: { message: 'splits takes one or two arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'splits input must be a string' } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: args[0],
      flagsFilter: args[1],
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: true,
    });
    if (!matchResult.ok) return matchResult;
    const matches = matchResult.matches;
    const outputs: JsonValue[] = [];
    let cursor = 0;
    for (const match of matches) {
      outputs.push(input.slice(cursor, match.start));
      cursor = match.end;
    }
    outputs.push(input.slice(cursor));
    return { ok: true, outputs };
  }
  case 'sub':
  case 'gsub': {
    if (args.length < 2 || args.length > 3 || args[0] === undefined || args[1] === undefined) {
      return { ok: false, error: { message: `${name} takes two or three arguments` } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: `${name} input must be a string` } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: args[0],
      flagsFilter: args[2],
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: name === 'gsub' || regularExpression.compiled.requestedGlobal,
    });
    if (!matchResult.ok) return matchResult;
    const matches = matchResult.matches;
    return buildRegexReplacementOutputs({
      input,
      matches,
      replacementFilter: args[1],
      evaluate,
    });
  }
  case 'reverse':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'reverse does not take arguments' } };
    }
    if (Array.isArray(input)) {
      return { ok: true, outputs: [numberedArrayFromEntries({ entries: numberedArrayEntries({ input }).reverse() })] };
    }
    return { ok: false, error: { message: 'reverse input must be an array' } };
  case 'rindex': {
    const searchFilter = args[0];
    if (searchFilter === undefined) {
      return { ok: false, error: { message: 'rindex requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'rindex takes exactly one argument' } };
    }
    const searched = evaluateSingleOutput({
      filter: searchFilter,
      input,
      evaluate,
    });
    if (!searched.ok) return searched;
    const indices = findIndices({
      input,
      search: searched.value,
      searchOrigin: searched.numberOrigin,
    });
    if (indices === undefined) {
      return { ok: false, error: { message: 'rindex input must be an array or string' } };
    }
    return { ok: true, outputs: [indices.at(-1) ?? null] };
  }
  case 'rtrimstr': {
    const suffixFilter = args[0];
    if (suffixFilter === undefined) {
      return { ok: false, error: { message: 'rtrimstr requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'rtrimstr takes exactly one argument' } };
    }
    const suffix = evaluateSingleOutput({
      filter: suffixFilter,
      input,
      evaluate,
    });
    if (!suffix.ok) return suffix;
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'rtrimstr input must be a string' } };
    }
    return {
      ok: true,
      outputs: [typeof suffix.value === 'string'
        ? trimEndSuffix({ value: input, suffix: suffix.value })
        : input],
    };
  }
  case 'scalars':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'scalars does not take arguments' } };
    }
    return typeFilter({ input, expected: 'scalar' }).length === 0
      ? { ok: true, outputs: [] }
      : { ok: true, outputs: [input], outputMetadata: [inputMetadata] };
  case 'setpath': {
    if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
      return { ok: false, error: { message: 'setpath takes exactly two arguments' } };
    }
    const newValues = evaluate({ filter: args[1], input });
    const materializedValues = newValues.ok
      ? newValues.outputs
      : runtimeFailureOutputs({ result: newValues });
    if (!newValues.ok && materializedValues.length === 0) return newValues;
    const pathValue = evaluateSingleOutput({ filter: args[0], input, evaluate });
    if (!pathValue.ok) return pathValue;
    const parsed = parsePathArray({ value: pathValue.value });
    if (!parsed.ok) {
      return {
        ok: false,
        error: {
          message: parsed.message === 'path must be an array'
            ? 'Path must be specified as an array'
            : parsed.message,
        },
      };
    }
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let index = 0; index < materializedValues.length; index += 1) {
      const value = materializedValues[index]!;
      const valueMetadata = metadataForRuntimeOutput({
        result: newValues,
        index,
        fallback: inputMetadata,
      });
      const updated = applyPathUpdate({
        root: input,
        path: toJqPath({ path: parsed.path }),
        update: () => ({
          ok: true,
          value,
          numberOrigin: typeof value === 'number' ? valueMetadata.numberOrigin : undefined,
        }),
      });
      if (!updated.ok) return { ok: false, error: { message: updated.message }, outputs, outputMetadata };
      outputs.push(updated.value);
      outputMetadata.push(singleOutputMetadata({
        inputMetadata: valueMetadata,
        numberOrigin: typeof updated.value === 'number' ? updated.numberOrigin : undefined,
      })[0]!);
    }
    return newValues.ok
      ? newValues.outputMetadata === undefined
        ? { ok: true, outputs }
        : { ok: true, outputs, outputMetadata }
      : replaceRuntimeFailureOutputs({
        result: newValues,
        outputs,
        outputMetadata: newValues.outputMetadata === undefined ? undefined : outputMetadata,
      });
  }
  case 'sort': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'sort does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'sort input must be an array' } };
    }
    const entries = numberedArrayEntries({ input });
    entries.sort((left, right) => compareJsonValues({
      left: left.value,
      right: right.value,
      leftOrigin: left.numberOrigin,
      rightOrigin: right.numberOrigin,
    }));
    return { ok: true, outputs: [numberedArrayFromEntries({ entries })] };
  }
  case 'sort_by': {
    const keyFilter = args[0];
    if (keyFilter === undefined) {
      return { ok: false, error: { message: 'sort_by requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'sort_by takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'sort_by input must be an array' } };
    }

    const keyed = [];
    for (const item of numberedArrayEntries({ input })) {
      const key = evaluateOrderingKey({
        filter: keyFilter,
        input: item.value,
        inputMetadata: metadataWithNumberOrigin({ metadata: inputMetadata, numberOrigin: item.numberOrigin }),
        evaluate,
      });
      if (!key.ok) return key;
      keyed.push({ key: key.value, keyOrigin: key.numberOrigin, item });
    }

    keyed.sort((left, right) => compareJsonValues({
      left: left.key,
      right: right.key,
      leftOrigin: left.keyOrigin,
      rightOrigin: right.keyOrigin,
    }));
    return { ok: true, outputs: [numberedArrayFromEntries({ entries: keyed.map((entry) => entry.item) })] };
  }
  case 'split': {
    const separatorFilter = args[0];
    if (separatorFilter === undefined) {
      return { ok: false, error: { message: 'split requires one argument' } };
    }
    if (args.length > 2) {
      return { ok: false, error: { message: 'split takes one or two arguments' } };
    }
    const flagsFilter = args[1];
    if (flagsFilter === undefined) {
      const separator = evaluateSingleOutput({
        filter: separatorFilter,
        input,
        evaluate,
      });
      if (!separator.ok) return separator;
      if (typeof input !== 'string' || typeof separator.value !== 'string') {
        return { ok: false, error: { message: 'split expects string input and argument' } };
      }
      return { ok: true, outputs: [input.split(separator.value)] };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'split input must be a string' } };
    }
    const regularExpression = evaluateRegularExpression({
      patternFilter: separatorFilter,
      flagsFilter,
      input,
      evaluate,
    });
    if (!regularExpression.ok) return regularExpression;
    const matchResult = evaluateRegularExpressionMatches({
      input,
      compiled: regularExpression.compiled,
      global: true,
    });
    if (!matchResult.ok) return matchResult;
    const matches = matchResult.matches;
    const outputs: string[] = [];
    let cursor = 0;
    for (const match of matches) {
      outputs.push(input.slice(cursor, match.start));
      cursor = match.end;
    }
    outputs.push(input.slice(cursor));
    return { ok: true, outputs: [outputs] };
  }
  case 'max_by':
  case 'min_by': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: `${name} takes exactly one argument` } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: `${name} input must be an array` } };
    }
    if (input.length === 0) return { ok: true, outputs: [null] };
    const entries = numberedArrayEntries({ input });
    let selected = entries[0]!;
    let selectedKey = evaluateOrderingKey({
      filter: args[0],
      input: selected.value,
      inputMetadata: metadataWithNumberOrigin({ metadata: inputMetadata, numberOrigin: selected.numberOrigin }),
      evaluate,
    });
    if (!selectedKey.ok) return selectedKey;
    for (const item of entries.slice(1)) {
      const itemKey = evaluateOrderingKey({
        filter: args[0],
        input: item.value,
        inputMetadata: metadataWithNumberOrigin({ metadata: inputMetadata, numberOrigin: item.numberOrigin }),
        evaluate,
      });
      if (!itemKey.ok) return itemKey;
      const comparison = compareJsonValues({
        left: itemKey.value,
        right: selectedKey.value,
        leftOrigin: itemKey.numberOrigin,
        rightOrigin: selectedKey.numberOrigin,
      });
      const replace = (() => {
        switch (name) {
        case 'min_by':
          return comparison < 0;
        case 'max_by':
          return comparison >= 0;
        default: {
          const _ex: never = name;
          throw new Error(`Unhandled keyed extremum: ${_ex}`);
        }
        }
      })();
      if (replace) {
        selected = item;
        selectedKey = itemKey;
      }
    }
    return {
      ok: true,
      outputs: [selected.value],
      outputMetadata: singleOutputMetadata({ inputMetadata, numberOrigin: selected.numberOrigin }),
    };
  }
  case 'max': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'max does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'max input must be an array' } };
    }
    if (input.length === 0) {
      return { ok: true, outputs: [null] };
    }
    const entries = numberedArrayEntries({ input });
    entries.sort((left, right) => compareJsonValues({
      left: left.value,
      right: right.value,
      leftOrigin: left.numberOrigin,
      rightOrigin: right.numberOrigin,
    }));
    const selected = entries.at(-1)!;
    return {
      ok: true,
      outputs: [selected.value],
      outputMetadata: singleOutputMetadata({ inputMetadata, numberOrigin: selected.numberOrigin }),
    };
  }
  case 'min': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'min does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'min input must be an array' } };
    }
    if (input.length === 0) {
      return { ok: true, outputs: [null] };
    }
    const entries = numberedArrayEntries({ input });
    entries.sort((left, right) => compareJsonValues({
      left: left.value,
      right: right.value,
      leftOrigin: left.numberOrigin,
      rightOrigin: right.numberOrigin,
    }));
    const selected = entries[0]!;
    return {
      ok: true,
      outputs: [selected.value],
      outputMetadata: singleOutputMetadata({ inputMetadata, numberOrigin: selected.numberOrigin }),
    };
  }
  case 'startswith': {
    const prefix = args[0];
    if (prefix === undefined) {
      return { ok: false, error: { message: 'startswith requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'startswith takes exactly one argument' } };
    }
    const evaluated = evaluate({ filter: prefix, input });
    if (!evaluated.ok) return evaluated;
    const value = evaluated.outputs[0];
    if (typeof input !== 'string' || typeof value !== 'string') {
      return { ok: false, error: { message: 'startswith expects string input and argument' } };
    }
    return { ok: true, outputs: [input.startsWith(value)] };
  }
  case 'strings':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'strings does not take arguments' } };
    }
    return { ok: true, outputs: typeFilter({ input, expected: 'string' }) };
  case 'unique': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'unique does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'unique input must be an array' } };
    }
    const entries = numberedArrayEntries({ input });
    entries.sort((left, right) => compareJsonValues({
      left: left.value,
      right: right.value,
      leftOrigin: left.numberOrigin,
      rightOrigin: right.numberOrigin,
    }));
    const uniqueEntries = entries.filter((entry, index, items) => index === 0 || compareJsonValues({
      left: entry.value,
      right: items[index - 1]!.value,
      leftOrigin: entry.numberOrigin,
      rightOrigin: items[index - 1]!.numberOrigin,
    }) !== 0);
    return { ok: true, outputs: [numberedArrayFromEntries({ entries: uniqueEntries })] };
  }
  case 'unique_by': {
    const keyFilter = args[0];
    if (keyFilter === undefined) {
      return { ok: false, error: { message: 'unique_by requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'unique_by takes exactly one argument' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'unique_by input must be an array' } };
    }

    const keyed = [];
    for (const item of numberedArrayEntries({ input })) {
      const key = evaluateOrderingKey({
        filter: keyFilter,
        input: item.value,
        inputMetadata: metadataWithNumberOrigin({ metadata: inputMetadata, numberOrigin: item.numberOrigin }),
        evaluate,
      });
      if (!key.ok) return key;
      keyed.push({ key: key.value, keyOrigin: key.numberOrigin, item });
    }

    keyed.sort((left, right) => compareJsonValues({
      left: left.key,
      right: right.key,
      leftOrigin: left.keyOrigin,
      rightOrigin: right.keyOrigin,
    }));
    const uniqueItems: JqNumberedArrayEntry[] = [];
    let previousKey: JsonValue | undefined;
    let previousKeyOrigin: JqNumberOrigin | undefined;
    for (const entry of keyed) {
      if (previousKey !== undefined && compareJsonValues({
        left: entry.key,
        right: previousKey,
        leftOrigin: entry.keyOrigin,
        rightOrigin: previousKeyOrigin,
      }) === 0) continue;
      uniqueItems.push(entry.item);
      previousKey = entry.key;
      previousKeyOrigin = entry.keyOrigin;
    }
    return { ok: true, outputs: [numberedArrayFromEntries({ entries: uniqueItems })] };
  }
  case 'truncate_stream': {
    const streamFilter = args[0];
    if (args.length !== 1 || streamFilter === undefined) {
      return { ok: false, error: { message: 'truncate_stream takes exactly one argument' } };
    }
    const streamResult = evaluate({ filter: streamFilter, input });
    const streamValues = streamResult.ok
      ? streamResult.outputs
      : runtimeFailureOutputs({ result: streamResult });
    const outputs: JsonValue[] = [];

    for (const streamValue of streamValues) {
      const parsed = parseJqStreamEvent({ event: streamValue });
      if (!parsed.ok) {
        return { ok: false, error: { message: parsed.message }, outputs };
      }
      const { path, value, hasValue } = parsed.event;
      if (compareJsonValues({ left: path.length, right: input }) <= 0) continue;
      const sliced = jqSliceStart({ length: path.length, value: input });
      if (!sliced.ok) {
        return { ok: false, error: { message: sliced.message }, outputs };
      }
      if (!appendJqStreamEvent({
        outputs,
        path: path.slice(sliced.start),
        value,
        hasValue,
      })) {
        return {
          ok: false,
          error: {
            message: `output materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          },
          outputs,
        };
      }
    }

    return streamResult.ok
      ? { ok: true, outputs }
      : replaceRuntimeFailureOutputs({ result: streamResult, outputs });
  }
  case 'transpose': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'transpose does not take arguments' } };
    }
    if (!Array.isArray(input)) {
      return { ok: false, error: { message: 'transpose input must be an array' } };
    }
    const transposed = transposeArray({ input });
    return transposed.ok
      ? { ok: true, outputs: [transposed.value] }
      : { ok: false, error: { message: transposed.message } };
  }
  case 'type':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'type does not take arguments' } };
    }
    if (input === null) return { ok: true, outputs: ['null'] };
    if (Array.isArray(input)) return { ok: true, outputs: ['array'] };
    switch (typeof input) {
    case 'boolean':
      return { ok: true, outputs: ['boolean'] };
    case 'number':
      return { ok: true, outputs: ['number'] };
    case 'string':
      return { ok: true, outputs: ['string'] };
    case 'object':
      return { ok: true, outputs: ['object'] };
    default: {
      const _ex: never = input;
      throw new Error(`Unhandled jq value: ${JSON.stringify(_ex)}`);
    }
    }
  case 'with_entries': {
    if (args.length !== 1 || args[0] === undefined) {
      return { ok: false, error: { message: 'with_entries takes exactly one argument' } };
    }
    const entries = toEntriesValue({ input });
    if (entries === undefined) {
      return { ok: false, error: { message: 'with_entries input must be an array or object' } };
    }
    const mappedEntries: JsonValue[] = [];
    for (const entry of entries) {
      const mapped = evaluate({ filter: args[0], input: entry });
      if (!mapped.ok) return clearRuntimeFailureOutputs({ result: mapped });
      if (!appendMaterializedValues({ target: mappedEntries, source: mapped.outputs })) {
        return {
          ok: false,
          error: {
            message: `with_entries materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          },
        };
      }
    }
    const converted = fromEntriesValue({ input: mappedEntries });
    return converted.ok
      ? { ok: true, outputs: [converted.value] }
      : { ok: false, error: { message: converted.message } };
  }
  case 'walk': {
    const mapper = args[0];
    if (mapper === undefined) {
      return { ok: false, error: { message: 'walk requires one argument' } };
    }
    if (args.length !== 1) {
      return { ok: false, error: { message: 'walk takes exactly one argument' } };
    }
    const walked = walkValue({
      value: input,
      mapper: ({ input: nestedInput }) => evaluateSingleOutput({
        filter: mapper,
        input: nestedInput,
        evaluate,
      }),
    });
    if (!walked.ok) return walked;
    return { ok: true, outputs: [walked.value] };
  }
  case 'has': {
    const arg = args[0];
    if (arg === undefined) {
      return { ok: false, error: { message: 'has requires one argument' } };
    }
    const evaluated = evaluate({ filter: arg, input });
    if (!evaluated.ok) return evaluated;
    const key = evaluated.outputs[0];
    if (key === undefined) {
      return { ok: true, outputs: [false] };
    }

    if (Array.isArray(input)) {
      return {
        ok: true,
        outputs: [typeof key === 'number' && Number.isInteger(key) && key >= 0 && key < input.length],
      };
    }
    if (typeof input === 'object' && input !== null) {
      return { ok: true, outputs: [typeof key === 'string' && Object.hasOwn(input, key)] };
    }
    return { ok: false, error: { message: 'has input must be an array or object' } };
  }
  case 'to_entries': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'to_entries does not take arguments' } };
    }
    const entries = toEntriesValue({ input });
    return entries === undefined
      ? { ok: false, error: { message: 'to_entries input must be an array or object' } }
      : { ok: true, outputs: [entries] };
  }
  case 'tostream': {
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tostream does not take arguments' } };
    }
    const result = createJqStreamEvents({ input });
    return result.ok
      ? result
      : { ok: false, error: { message: result.message } };
  }
  case 'tojson':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tojson does not take arguments' } };
    }
    return {
      ok: true,
      outputs: [stringifyJson({
        value: input,
        indentation: undefined,
        sortKeys: false,
        asciiOnly: false,
        numberOrigin: inputMetadata.numberOrigin,
      })],
    };
  case 'tonumber':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tonumber does not take arguments' } };
    }
    switch (typeof input) {
    case 'number':
      return { ok: true, outputs: [input], outputMetadata: [inputMetadata] };
    case 'string': {
      const parsed = parseStrictNumber({ value: input });
      if (parsed === undefined) {
        return { ok: false, error: { message: `cannot parse number from string ${JSON.stringify(input)}` } };
      }
      return {
        ok: true,
        outputs: [parsed.value],
        outputMetadata: singleOutputMetadata({
          inputMetadata,
          numberOrigin: parsed.numberOrigin,
        }),
      };
    }
    default:
      return { ok: false, error: { message: 'tonumber input must be a string or number' } };
    }
  case 'utf8bytelength':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'utf8bytelength does not take arguments' } };
    }
    if (typeof input !== 'string') {
      return { ok: false, error: { message: 'utf8bytelength input must be a string' } };
    }
    return { ok: true, outputs: [new TextEncoder().encode(input).byteLength] };
  case 'values':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'values does not take arguments' } };
    }
    return input !== null
      ? { ok: true, outputs: [input], outputMetadata: [inputMetadata] }
      : { ok: true, outputs: [] };
  case 'repeat':
  case 'until':
  case 'while':
    return { ok: false, error: { message: `unsupported syntax: identifier '${name}'` } };
  case 'tostring':
    if (args.length !== 0) {
      return { ok: false, error: { message: 'tostring does not take arguments' } };
    }
    return typeof input === 'string'
      ? { ok: true, outputs: [input] }
      : {
        ok: true,
        outputs: [stringifyJson({
          value: input,
          indentation: undefined,
          sortKeys: false,
          asciiOnly: false,
          numberOrigin: inputMetadata.numberOrigin,
        })],
      };
  default: {
    const _ex: never = name;
    throw new Error(`Unhandled jq builtin: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
