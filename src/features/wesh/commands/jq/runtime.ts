import type { JsonValue, JqBinaryOperator, JqBuiltinName, JqFilter, JqObjectKey, JqPath, JqPathExpression, JqPathSegment, JqStringPart, JqUserDefinition } from './ast';
import {
  getJsonChildNumberOrigin,
  moveJsonArrayNumberOrigins,
  setJsonChildNumberOrigin,
  type JqNumberOrigin,
} from './number-origin';
import { JQ_MAX_MATERIALIZED_VALUE_LENGTH, JQ_MAX_USER_DEFINITION_CALL_DEPTH } from './limits';
import {
  applyJqStreamValue,
  evaluateBuiltin,
  evaluateBuiltinWithEvaluatedArguments,
  iteratePaths,
  jqSliceStart,
  parseJqStreamEvent,
} from './builtins';
import { extractPathExpression } from './parser';
import { instantiateJqUserDefinition } from './user-definition';
import {
  applyPathDeletions,
  applyPathUpdate,
  materializeJqPathExpression,
  normalizeArrayIndex,
  readJqPathValue,
} from './path';
import {
  compareJsonValues,
  createJsonObject,
  defineJsonProperty,
  formatJqArithmeticError,
  formatJqIndexError,
  formatJqObjectKeyError,
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

export interface JqRuntimeError {
  message: string,
  value?: JsonValue,
  breakLabelId?: number,
  metadata?: JqRuntimeInputMetadata,
  halt?: {
    readonly exitCode: number,
    readonly stderr: string,
  },
}

export interface JqRuntimeInputRequest {
  readonly maximumValues: number | undefined,
}

export interface JqRuntimeInputMetadata {
  readonly filename: string | null,
  readonly lineNumber: number,
  readonly numberOrigin?: JqNumberOrigin,
}

function metadataWithNumberOrigin({
  metadata,
  numberOrigin,
}: {
  metadata: JqRuntimeInputMetadata,
  numberOrigin: JqNumberOrigin | undefined,
}): JqRuntimeInputMetadata {
  if (metadata.numberOrigin === numberOrigin) return metadata;
  const { numberOrigin: _previousNumberOrigin, ...sourceMetadata } = metadata;
  return numberOrigin === undefined
    ? sourceMetadata
    : { ...sourceMetadata, numberOrigin };
}

export interface JqRuntimeInputEntry extends JqRuntimeInputMetadata {
  readonly value: JsonValue,
  readonly error?: JqRuntimeError,
}

export interface JqRuntimeInputState {
  readonly entries: readonly JqRuntimeInputEntry[],
  index: number,
  currentMetadata: JqRuntimeInputMetadata,
  readonly sourceExhausted: boolean,
  readonly sourceExhaustionMetadata?: JqRuntimeInputMetadata,
  readonly terminalError: JqRuntimeError | undefined,
}

export type JqRuntimeResult =
  | {
    ok: true,
    outputs: JsonValue[],
    outputMetadata?: JqRuntimeInputMetadata[],
    stderr?: string[],
  }
  | {
    ok: false,
    error: JqRuntimeError,
    outputs?: JsonValue[],
    outputMetadata?: JqRuntimeInputMetadata[],
    inputRequest?: JqRuntimeInputRequest,
    stderr?: string[],
  };

interface JqRuntimeContext {
  variables: Readonly<Record<string, JsonValue>>,
  variableNumberOrigins: Readonly<Record<string, JqNumberOrigin | undefined>>,
  userDefinitions: ReadonlyMap<number, JqUserDefinition>,
  inputState: JqRuntimeInputState,
  depth: number,
  userDefinitionCallDepth: number,
  state: {
    steps: number,
    stderr: string[],
  },
  limits: {
    maxDepth: number,
    maxSteps: number,
    maxOutputs: number,
  },
}

export type JqRuntimeFilterEvaluator = ({ filter, input, inputMetadata }: {
  filter: JqFilter,
  input: JsonValue,
  inputMetadata?: JqRuntimeInputMetadata,
}) => JqRuntimeResult;

function runtimeError({
  message,
  value,
}: {
  message: string,
  value: JsonValue | undefined,
}): Extract<JqRuntimeResult, { ok: false }> {
  return {
    ok: false,
    error: {
      message,
      value: value === undefined ? message : value,
    },
  };
}


export function failureOutputs({
  result,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
}): JsonValue[] {
  return result.outputs ?? [];
}

export function replaceFailureOutputs({
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

function metadataForResultOutput({
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

function metadataForChildValue({
  metadata,
  container,
  key,
  value,
}: {
  metadata: JqRuntimeInputMetadata,
  container: JsonValue[] | { [key: string]: JsonValue },
  key: string | number,
  value: JsonValue,
}): JqRuntimeInputMetadata {
  return metadataWithNumberOrigin({
    metadata,
    numberOrigin: typeof value === 'number'
      ? getJsonChildNumberOrigin({ container, key })
      : undefined,
  });
}

function appendRuntimeMetadata({
  target,
  result,
  outputCount,
  fallback,
}: {
  target: JqRuntimeInputMetadata[],
  result: JqRuntimeResult,
  outputCount: number,
  fallback: JqRuntimeInputMetadata,
}): void {
  for (let index = 0; index < outputCount; index += 1) {
    target.push(metadataForResultOutput({ result, index, fallback }));
  }
}

export function appendFailureOutputs({
  prefix,
  result,
  context,
}: {
  prefix: readonly JsonValue[],
  result: Extract<JqRuntimeResult, { ok: false }>,
  context: JqRuntimeContext,
}): JqRuntimeResult {
  const outputs = [...prefix];
  if (!appendJqValues({
    target: outputs,
    source: failureOutputs({ result }),
    maximum: context.limits.maxOutputs,
  })) {
    return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
  }
  return replaceFailureOutputs({ result, outputs });
}

export function clearFailureOutputs({
  result,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
}): Extract<JqRuntimeResult, { ok: false }> {
  return replaceFailureOutputs({ result, outputs: [] });
}

export function constrainInputRequest({
  result,
  maximumValues,
}: {
  result: Extract<JqRuntimeResult, { ok: false }>,
  maximumValues: number,
}): Extract<JqRuntimeResult, { ok: false }> {
  const requested = result.inputRequest;
  if (requested === undefined) return result;
  return {
    ...result,
    inputRequest: {
      maximumValues: requested.maximumValues === undefined
        ? maximumValues
        : Math.min(requested.maximumValues, maximumValues),
    },
  };
}

function takeRuntimeInputs({
  context,
  maximumValues,
  eofBehavior,
}: {
  context: JqRuntimeContext,
  maximumValues: number | undefined,
  eofBehavior: 'break' | 'empty',
}): JqRuntimeResult {
  const outputs: JsonValue[] = [];
  const outputMetadata: JqRuntimeInputMetadata[] = [];
  while (
    context.inputState.index < context.inputState.entries.length
    && (maximumValues === undefined || outputs.length < maximumValues)
  ) {
    const entry = context.inputState.entries[context.inputState.index];
    if (entry === undefined) break;
    context.inputState.index += 1;
    context.inputState.currentMetadata = {
      filename: entry.filename,
      lineNumber: entry.lineNumber,
      ...(entry.numberOrigin === undefined ? {} : { numberOrigin: entry.numberOrigin }),
    };
    if (entry.error !== undefined) {
      return {
        ok: false,
        error: entry.error,
        outputs,
        outputMetadata,
      };
    }
    outputs.push(entry.value);
    outputMetadata.push(context.inputState.currentMetadata);
  }

  if (maximumValues !== undefined && outputs.length >= maximumValues) {
    return { ok: true, outputs, outputMetadata };
  }

  if (context.inputState.terminalError !== undefined) {
    return {
      ok: false,
      error: context.inputState.terminalError,
      outputs,
      outputMetadata,
    };
  }

  if (context.inputState.sourceExhausted) {
    if (context.inputState.sourceExhaustionMetadata !== undefined) {
      context.inputState.currentMetadata = context.inputState.sourceExhaustionMetadata;
    }
    switch (eofBehavior) {
    case 'empty':
      return { ok: true, outputs, outputMetadata };
    case 'break':
      return outputs.length > 0
        ? { ok: true, outputs, outputMetadata }
        : runtimeError({ message: 'break', value: 'break' });
    default: {
      const _ex: never = eofBehavior;
      throw new Error(`Unhandled jq input EOF behavior: ${_ex}`);
    }
    }
  }

  const remainingMaximum = maximumValues === undefined
    ? undefined
    : maximumValues - outputs.length;
  return {
    ok: false,
    error: { message: 'additional jq input required', value: 'break' },
    outputs,
    outputMetadata,
    inputRequest: { maximumValues: remainingMaximum },
  };
}

function jqValueTypeName({
  value,
}: {
  value: JsonValue,
}): 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
  case 'boolean':
    return 'boolean';
  case 'number':
    return 'number';
  case 'string':
    return 'string';
  case 'object':
    return 'object';
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled jq value type: ${String(_ex)}`);
  }
  }
}

function truthy({
  value,
}: {
  value: JsonValue,
}): boolean {
  return value !== false && value !== null;
}

function isAlternativeOperator({
  operator,
}: {
  operator: JqBinaryOperator,
}): boolean {
  switch (operator) {
  case 'alternative':
    return true;
  case 'pipe':
  case 'comma':
  case 'or':
  case 'and':
  case 'eq':
  case 'ne':
  case 'lt':
  case 'le':
  case 'gt':
  case 'ge':
  case 'add':
  case 'sub':
  case 'mul':
  case 'div':
  case 'mod':
    return false;
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled jq binary operator: ${_ex}`);
  }
  }
}

function booleanShortCircuitOperator({
  operator,
}: {
  operator: JqBinaryOperator,
}): 'and' | 'or' | undefined {
  switch (operator) {
  case 'or':
  case 'and':
    return operator;
  case 'pipe':
  case 'comma':
  case 'alternative':
  case 'eq':
  case 'ne':
  case 'lt':
  case 'le':
  case 'gt':
  case 'ge':
  case 'add':
  case 'sub':
  case 'mul':
  case 'div':
  case 'mod':
    return undefined;
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled jq binary operator: ${_ex}`);
  }
  }
}

function normalizeSliceBound({
  length,
  bound,
  fallback,
}: {
  length: number,
  bound: number | undefined,
  fallback: 0 | 'length',
}): number {
  const raw = bound ?? (fallback === 'length' ? length : 0);
  const normalized = raw < 0 ? length + raw : raw;
  return Math.min(Math.max(normalized, 0), length);
}

function stringifyInterpolationValue({
  value,
  numberOrigin,
}: {
  value: JsonValue,
  numberOrigin: JqNumberOrigin | undefined,
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

type RecursiveMergeFrame = {
  readonly left: { [key: string]: JsonValue },
  readonly right: { [key: string]: JsonValue },
  readonly merged: { [key: string]: JsonValue },
  readonly rightEntries: readonly (readonly [string, JsonValue])[],
  nextEntryIndex: number,
  readonly parent: {
    readonly merged: { [key: string]: JsonValue },
    readonly key: string,
  } | undefined,
};

function createRecursiveMergeFrame({
  left,
  right,
  parent,
}: {
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
  parent: RecursiveMergeFrame['parent'],
}): RecursiveMergeFrame {
  return {
    left,
    right,
    merged: mergeJsonObjects({ left, right }),
    rightEntries: jsonObjectEntries({ object: right }),
    nextEntryIndex: 0,
    parent,
  };
}

function recursiveMerge({
  left,
  right,
}: {
  left: { [key: string]: JsonValue },
  right: { [key: string]: JsonValue },
}): { [key: string]: JsonValue } {
  const stack: RecursiveMergeFrame[] = [createRecursiveMergeFrame({
    left,
    right,
    parent: undefined,
  })];

  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const entry = frame.rightEntries[frame.nextEntryIndex];
    if (entry === undefined) {
      stack.pop();
      if (frame.parent === undefined) return frame.merged;
      defineJsonProperty({
        object: frame.parent.merged,
        key: frame.parent.key,
        value: frame.merged,
      });
      continue;
    }

    frame.nextEntryIndex += 1;
    const [key, rightValue] = entry;
    const leftValue = frame.left[key];
    if (
      leftValue !== undefined
      && isJsonObject(leftValue)
      && isJsonObject(rightValue)
    ) {
      stack.push(createRecursiveMergeFrame({
        left: leftValue,
        right: rightValue,
        parent: {
          merged: frame.merged,
          key,
        },
      }));
    }
  }

  throw new Error('recursive jq object merge completed without a root result');
}

function evaluateBinaryPair({
  operator,
  left,
  right,
  leftOrigin,
  rightOrigin,
}: {
  operator: JqBinaryOperator,
  left: JsonValue,
  right: JsonValue,
  leftOrigin: JqNumberOrigin | undefined,
  rightOrigin: JqNumberOrigin | undefined,
}): { ok: true, value: JsonValue, numberOrigin?: JqNumberOrigin } | { ok: false, error: JqRuntimeError } {
  switch (operator) {
  case 'pipe':
  case 'comma':
    return runtimeError({ message: `unexpected operator ${operator}`, value: undefined });
  case 'alternative':
    return truthy({ value: left })
      ? { ok: true, value: left, ...(leftOrigin === undefined ? {} : { numberOrigin: leftOrigin }) }
      : { ok: true, value: right, ...(rightOrigin === undefined ? {} : { numberOrigin: rightOrigin }) };
  case 'or':
    return { ok: true, value: truthy({ value: left }) || truthy({ value: right }) };
  case 'and':
    return { ok: true, value: truthy({ value: left }) && truthy({ value: right }) };
  case 'eq':
    return { ok: true, value: jsonValuesEqual({ left, right, leftOrigin, rightOrigin }) };
  case 'ne':
    return { ok: true, value: !jsonValuesEqual({ left, right, leftOrigin, rightOrigin }) };
  case 'lt':
    return { ok: true, value: compareJsonValues({ left, right, leftOrigin, rightOrigin }) < 0 };
  case 'le':
    return { ok: true, value: compareJsonValues({ left, right, leftOrigin, rightOrigin }) <= 0 };
  case 'gt':
    return { ok: true, value: compareJsonValues({ left, right, leftOrigin, rightOrigin }) > 0 };
  case 'ge':
    return { ok: true, value: compareJsonValues({ left, right, leftOrigin, rightOrigin }) >= 0 };
  case 'add': {
    if (left === null) return { ok: true, value: right, ...(rightOrigin === undefined ? {} : { numberOrigin: rightOrigin }) };
    if (right === null) return { ok: true, value: left, ...(leftOrigin === undefined ? {} : { numberOrigin: leftOrigin }) };
    if (typeof left === 'number' && typeof right === 'number') {
      return {
        ok: true,
        value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left }) + toJqArithmeticNumber({ value: right }),
        }),
      };
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return { ok: true, value: `${left}${right}` };
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const value = [...left, ...right];
      moveJsonArrayNumberOrigins({ source: left, target: value, sourceStart: 0, sourceEnd: left.length });
      for (let index = 0; index < right.length; index += 1) {
        setJsonChildNumberOrigin({
          container: value,
          key: left.length + index,
          origin: getJsonChildNumberOrigin({ container: right, key: index }),
        });
      }
      return { ok: true, value };
    }
    if (isJsonObject(left) && isJsonObject(right)) {
      return { ok: true, value: mergeJsonObjects({ left, right }) };
    }
    return runtimeError({ message: formatJqArithmeticError({ operator: 'add', left, right, leftOrigin, rightOrigin }), value: undefined });
  }
  case 'sub': {
    if (typeof left === 'number' && typeof right === 'number') {
      return {
        ok: true,
        value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left }) - toJqArithmeticNumber({ value: right }),
        }),
      };
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const value: JsonValue[] = [];
      for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
        const item = left[leftIndex]!;
        const itemOrigin = getJsonChildNumberOrigin({ container: left, key: leftIndex });
        const excluded = right.some((candidate, rightIndex) => jsonValuesEqual({
          left: item,
          right: candidate,
          leftOrigin: itemOrigin,
          rightOrigin: getJsonChildNumberOrigin({ container: right, key: rightIndex }),
        }));
        if (excluded) continue;
        const targetIndex = value.length;
        value.push(item);
        setJsonChildNumberOrigin({ container: value, key: targetIndex, origin: itemOrigin });
      }
      return { ok: true, value };
    }
    return runtimeError({ message: formatJqArithmeticError({ operator: 'sub', left, right, leftOrigin, rightOrigin }), value: undefined });
  }
  case 'mul': {
    if (typeof left === 'number' && typeof right === 'number') {
      return {
        ok: true,
        value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left }) * toJqArithmeticNumber({ value: right }),
        }),
      };
    }
    if (typeof left === 'string' && typeof right === 'number') {
      const count = Math.trunc(right);
      if (count < 0) return { ok: true, value: null };
      if (left.length === 0 || count === 0) return { ok: true, value: '' };
      if (!Number.isFinite(count) || count > Math.floor(JQ_MAX_MATERIALIZED_VALUE_LENGTH / left.length)) {
        return runtimeError({
          message: `string multiplication exceeds materialization limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          value: undefined,
        });
      }
      return { ok: true, value: left.repeat(count) };
    }
    if (typeof right === 'string' && typeof left === 'number') {
      const count = Math.trunc(left);
      if (count < 0) return { ok: true, value: null };
      if (right.length === 0 || count === 0) return { ok: true, value: '' };
      if (!Number.isFinite(count) || count > Math.floor(JQ_MAX_MATERIALIZED_VALUE_LENGTH / right.length)) {
        return runtimeError({
          message: `string multiplication exceeds materialization limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          value: undefined,
        });
      }
      return { ok: true, value: right.repeat(count) };
    }
    if (isJsonObject(left) && isJsonObject(right)) {
      return { ok: true, value: recursiveMerge({ left, right }) };
    }
    return runtimeError({ message: formatJqArithmeticError({ operator: 'mul', left, right, leftOrigin, rightOrigin }), value: undefined });
  }
  case 'div': {
    if (typeof left === 'number' && typeof right === 'number') {
      if (right === 0) return runtimeError({ message: formatJqArithmeticError({ operator: 'div', left, right, leftOrigin, rightOrigin }), value: undefined });
      return {
        ok: true,
        value: normalizeJqArithmeticResult({
          value: toJqArithmeticNumber({ value: left }) / toJqArithmeticNumber({ value: right }),
        }),
      };
    }
    if (typeof left === 'string' && typeof right === 'string') {
      return { ok: true, value: left.length === 0 ? [] : left.split(right) };
    }
    return runtimeError({ message: formatJqArithmeticError({ operator: 'div', left, right, leftOrigin, rightOrigin }), value: undefined });
  }
  case 'mod':
    if (typeof left === 'number' && typeof right === 'number') {
      const integerRight = Math.trunc(right);
      if (integerRight === 0) return runtimeError({ message: formatJqArithmeticError({ operator: 'mod', left, right, leftOrigin, rightOrigin }), value: undefined });
      const remainder = Math.trunc(left) % integerRight;
      return { ok: true, value: Object.is(remainder, -0) ? 0 : remainder };
    }
    return runtimeError({ message: formatJqArithmeticError({ operator: 'mod', left, right, leftOrigin, rightOrigin }), value: undefined });
  default: {
    const _ex: never = operator;
    throw new Error(`Unhandled binary operator: ${_ex}`);
  }
  }
}

function checkLimits({
  context,
}: {
  context: JqRuntimeContext,
}): { ok: true } | { ok: false, error: JqRuntimeError } {
  context.state.steps += 1;
  if (context.depth > context.limits.maxDepth) {
    return runtimeError({ message: 'maximum jq evaluation depth exceeded', value: undefined });
  }
  if (context.state.steps > context.limits.maxSteps) {
    return runtimeError({ message: 'maximum jq evaluation step count exceeded', value: undefined });
  }
  return { ok: true };
}

function checkRequiredLeftSpineDepth({
  filter,
  context,
  kind,
}: {
  filter: JqFilter,
  context: JqRuntimeContext,
  kind: 'binary' | 'pipe' | 'comma',
}): { ok: true } | { ok: false, error: JqRuntimeError } {
  let current = filter;
  let additionalDepth = 0;
  while (true) {
    const left = (() => {
      switch (current.kind) {
      case 'binary':
        switch (kind) {
        case 'binary': return current.left;
        case 'pipe':
        case 'comma': return undefined;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled jq left spine kind: ${_ex}`);
        }
        }
      case 'pipe':
        switch (kind) {
        case 'pipe': return current.left;
        case 'binary':
        case 'comma': return undefined;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled jq left spine kind: ${_ex}`);
        }
        }
      case 'comma':
        switch (kind) {
        case 'comma': return current.left;
        case 'binary':
        case 'pipe': return undefined;
        default: {
          const _ex: never = kind;
          throw new Error(`Unhandled jq left spine kind: ${_ex}`);
        }
        }
      case 'identity':
      case 'variable':
      case 'literal':
      case 'string':
      case 'array':
      case 'object':
      case 'field':
      case 'index':
      case 'dynamic_index':
      case 'slice':
      case 'iterate':
      case 'recursive_descent':
      case 'optional':
      case 'conditional':
      case 'trycatch':
      case 'call':
      case 'user_call':
      case 'unresolved_user_call':
      case 'unary':
      case 'bind':
      case 'label':
      case 'break':
      case 'reduce':
      case 'foreach':
      case 'assign':
      case 'update':
        return undefined;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled jq left spine filter: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    if (left === undefined) return { ok: true };
    additionalDepth += 1;
    if (context.depth + additionalDepth > context.limits.maxDepth) {
      return runtimeError({ message: 'maximum jq evaluation depth exceeded', value: undefined });
    }
    current = left;
  }
}

function checkOutputLimit({
  outputs,
  context,
}: {
  outputs: JsonValue[],
  context: JqRuntimeContext,
}): { ok: true, outputs: JsonValue[] } | { ok: false, error: JqRuntimeError } {
  if (outputs.length > context.limits.maxOutputs) {
    return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
  }
  return { ok: true, outputs };
}

function appendJqValues({
  target,
  source,
  maximum,
}: {
  target: JsonValue[],
  source: readonly JsonValue[],
  maximum: number,
}): boolean {
  if (source.length > maximum - target.length) return false;
  for (const value of source) target.push(value);
  return true;
}

function isEmptyBuiltinFilter({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  return filter.kind === 'call' && filter.name === 'empty' && filter.args.length === 0;
}

function appendRuntimeOutputs({
  target,
  source,
  context,
}: {
  target: JsonValue[],
  source: readonly JsonValue[],
  context: JqRuntimeContext,
}): { ok: true } | { ok: false, error: JqRuntimeError } {
  return appendJqValues({ target, source, maximum: context.limits.maxOutputs })
    ? { ok: true }
    : runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
}

export function evaluateJqFilter({
  filter,
  input,
  variables,
  inputState,
  userDefinitions,
}: {
  filter: JqFilter,
  input: JsonValue,
  variables?: Readonly<Record<string, JsonValue>>,
  inputState?: JqRuntimeInputState,
  userDefinitions?: readonly JqUserDefinition[],
}): JqRuntimeResult {
  const state = { steps: 0, stderr: [] as string[] };
  const result = evaluateJqFilterWithContext({
    filter,
    input,
    context: {
      variables: variables ?? {},
      variableNumberOrigins: {},
      userDefinitions: new Map((userDefinitions ?? []).map((definition) => [definition.id, definition])),
      inputState: inputState ?? {
        entries: [],
        index: 0,
        currentMetadata: { filename: null, lineNumber: 0 },
        sourceExhausted: true,
        terminalError: undefined,
      },
      depth: 0,
      userDefinitionCallDepth: 0,
      state,
      limits: {
        maxDepth: 512,
        maxSteps: 5_000_000,
        maxOutputs: 1_000_000,
      },
    },
  });
  const resultWithStderr: JqRuntimeResult = state.stderr.length === 0
    ? result
    : { ...result, stderr: [...state.stderr] };
  if (inputState !== undefined || resultWithStderr.outputMetadata === undefined) return resultWithStderr;
  const { outputMetadata: _discardedOutputMetadata, ...publicResult } = resultWithStderr;
  return publicResult;
}

type JqRuntimeOutputVisitResult =
  | { ok: true, stopped: boolean }
  | Extract<JqRuntimeResult, { ok: false }>;

type JqRuntimeOutputConsumer = ({
  value,
  metadata,
}: {
  value: JsonValue,
  metadata: JqRuntimeInputMetadata,
}) => JqRuntimeOutputVisitResult;

function jqCountValue({
  value,
  name,
}: {
  value: JsonValue,
  name: 'limit' | 'nth',
}): { ok: true, value: number } | Extract<JqRuntimeResult, { ok: false }> {
  const comparedWithZero = compareJsonValues({ left: value, right: 0 });
  if (comparedWithZero < 0) {
    switch (name) {
    case 'limit':
      return { ok: true, value: Number.POSITIVE_INFINITY };
    case 'nth':
      return runtimeError({ message: "nth doesn't support negative indices", value: undefined });
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unhandled counted consumer: ${_exhaustive}`);
    }
    }
  }
  if (typeof value !== 'number') {
    const operator = (() => {
      switch (name) {
      case 'limit':
        return 'sub' as const;
      case 'nth':
        return 'add' as const;
      default: {
        const _exhaustive: never = name;
        throw new Error(`Unhandled counted consumer: ${_exhaustive}`);
      }
      }
    })();
    return runtimeError({
      message: formatJqArithmeticError({
        operator,
        left: value,
        right: 1,
      }),
      value: undefined,
    });
  }
  if (value === 0) return { ok: true, value: 0 };
  if (!Number.isFinite(value)) return { ok: true, value: Number.POSITIVE_INFINITY };
  return { ok: true, value: Math.ceil(value) };
}

function visitJqCountedGeneratorOutputs({
  name,
  countFilter,
  generator,
  input,
  context,
  consume,
}: {
  name: 'limit' | 'nth',
  countFilter: JqFilter,
  generator: JqFilter,
  input: JsonValue,
  context: JqRuntimeContext,
  consume: JqRuntimeOutputConsumer,
}): JqRuntimeOutputVisitResult {
  const nestedContext: JqRuntimeContext = { ...context, depth: context.depth + 1 };
  return visitJqFilterOutputsWithContext({
    filter: countFilter,
    input,
    context: nestedContext,
    consume: ({ value: rawCount }) => {
      const parsed = jqCountValue({ value: rawCount, name });
      if (!parsed.ok) return parsed;
      const count = parsed.value;
      if (name === 'limit' && count === 0) return { ok: true, stopped: false };

      let generatedIndex = 0;
      let outerStopped = false;
      const generated = visitJqFilterOutputsWithContext({
        filter: generator,
        input,
        context: nestedContext,
        consume: ({ value, metadata }) => {
          if (name === 'nth' && generatedIndex < count) {
            generatedIndex += 1;
            return { ok: true, stopped: false };
          }
          const visited = consume({ value, metadata });
          if (!visited.ok) return visited;
          if (visited.stopped) {
            outerStopped = true;
            return visited;
          }
          generatedIndex += 1;
          return {
            ok: true,
            stopped: name === 'nth' || generatedIndex >= count,
          };
        },
      });
      if (!generated.ok) return generated;
      return { ok: true, stopped: outerStopped };
    },
  });
}

function jqFilterIsStaticallyEmptyOutput({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  switch (filter.kind) {
  case 'call':
    return filter.name === 'empty' && filter.args.length === 0;
  case 'comma':
    return jqFilterIsStaticallyEmptyOutput({ filter: filter.left })
      && jqFilterIsStaticallyEmptyOutput({ filter: filter.right });
  default:
    return false;
  }
}

function jqFilterYieldsAtMostOneOutput({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  switch (filter.kind) {
  case 'identity':
  case 'literal':
  case 'variable':
    return true;
  case 'unary':
    return jqFilterYieldsAtMostOneOutput({ filter: filter.value });
  case 'binary':
    return jqFilterYieldsAtMostOneOutput({ filter: filter.left })
      && jqFilterYieldsAtMostOneOutput({ filter: filter.right });
  case 'call':
    return jqFilterIsStaticallyEmptyOutput({ filter });
  case 'comma':
    return (jqFilterIsStaticallyEmptyOutput({ filter: filter.left })
      && jqFilterYieldsAtMostOneOutput({ filter: filter.right }))
      || (jqFilterIsStaticallyEmptyOutput({ filter: filter.right })
        && jqFilterYieldsAtMostOneOutput({ filter: filter.left }));
  default:
    return false;
  }
}

const JQ_ITERATIVE_SINGLE_OUTPUT_ZERO_ARGUMENT_BUILTINS = new Set<JqBuiltinName>([
  'abs',
  'arrays',
  'acos',
  'acosh',
  'asin',
  'asinh',
  'atan',
  'atanh',
  'booleans',
  'cbrt',
  'ceil',
  'cos',
  'cosh',
  'exp',
  'exp10',
  'exp2',
  'expm1',
  'fabs',
  'finites',
  'floor',
  'isfinite',
  'iterables',
  'length',
  'log',
  'log10',
  'log1p',
  'log2',
  'numbers',
  'normals',
  'nulls',
  'objects',
  'round',
  'scalars',
  'sin',
  'sinh',
  'sqrt',
  'strings',
  'tan',
  'tanh',
  'tonumber',
  'tostring',
  'trunc',
  'type',
  'values',
]);

function jqIterativeBranchYieldsAtMostOneOutput({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  if (jqFilterYieldsAtMostOneOutput({ filter })) return true;
  switch (filter.kind) {
  case 'array':
    return true;
  case 'string':
    return filter.parts.every(part => part.kind === 'text'
      || jqIterativeBranchYieldsAtMostOneOutput({ filter: part.filter }));
  case 'object':
    return filter.entries.every(entry => (entry.key.kind === 'static'
      || jqIterativeBranchYieldsAtMostOneOutput({ filter: entry.key.filter }))
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: entry.value }));
  case 'field':
  case 'index':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.input });
  case 'dynamic_index':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.input })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.index });
  case 'slice':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.input })
      && (filter.start === undefined
        || jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.start }))
      && (filter.end === undefined
        || jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.end }));
  case 'optional':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.body });
  case 'pipe':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.left })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.right });
  case 'conditional':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.condition })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.thenBranch })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.elseBranch });
  case 'trycatch':
    return jqFilterIsStaticallyEmptyOutput({ filter: filter.catchBranch })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.body });
  case 'bind':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.binding })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.body });
  case 'label':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.body });
  case 'unary':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.value });
  case 'binary':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.left })
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.right });
  case 'call':
    if (filter.name === 'error' && filter.args.length <= 1) return true;
    if (filter.args.length === 0) {
      return JQ_ITERATIVE_SINGLE_OUTPUT_ZERO_ARGUMENT_BUILTINS.has(filter.name);
    }
    if (filter.name === 'first' && filter.args.length === 1) return true;
    if (filter.name === 'split' && filter.args.length === 1 && filter.args[0] !== undefined) {
      return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.args[0] });
    }
    return filter.name === 'select'
      && filter.args.length === 1
      && filter.args[0] !== undefined
      && jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.args[0] });
  case 'identity':
  case 'variable':
  case 'literal':
  case 'iterate':
  case 'recursive_descent':
  case 'comma':
  case 'user_call':
  case 'unresolved_user_call':
  case 'break':
  case 'reduce':
  case 'foreach':
  case 'assign':
  case 'update':
    return false;
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq iterative single-output proof filter: ${JSON.stringify(_ex)}`);
  }
  }
}

function jqAtomicCommaBranches({
  filter,
}: {
  filter: JqFilter,
}): readonly JqFilter[] | undefined {
  const pending: JqFilter[] = [filter];
  const branches: JqFilter[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    switch (current.kind) {
    case 'comma':
      pending.push(current.right, current.left);
      continue;
    default:
      if (!jqIterativeBranchYieldsAtMostOneOutput({ filter: current })) return undefined;
      branches.push(current);
      break;
    }
    if (branches.length > JQ_MAX_MATERIALIZED_VALUE_LENGTH) return undefined;
  }
  return branches;
}

function jqIterativeReplaySafeSingleOutput({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  switch (filter.kind) {
  case 'identity':
  case 'variable':
  case 'literal':
    return true;
  case 'unary':
    return jqIterativeReplaySafeSingleOutput({ filter: filter.value });
  case 'binary': {
    const pairwiseOperator = filter.operator === 'eq'
      || filter.operator === 'ne'
      || filter.operator === 'lt'
      || filter.operator === 'le'
      || filter.operator === 'gt'
      || filter.operator === 'ge'
      || filter.operator === 'add'
      || filter.operator === 'sub'
      || filter.operator === 'mul'
      || filter.operator === 'div'
      || filter.operator === 'mod';
    return pairwiseOperator
      && jqIterativeReplaySafeSingleOutput({ filter: filter.left })
      && jqIterativeReplaySafeSingleOutput({ filter: filter.right });
  }
  default:
    return false;
  }
}

function jqStringInterpolationFilter({
  part,
}: {
  part: JqStringPart,
}): JqFilter | undefined {
  switch (part.kind) {
  case 'text':
    return undefined;
  case 'interpolation':
    return part.filter;
  default: {
    const _ex: never = part;
    throw new Error(`Unhandled jq string part in iterative proof: ${JSON.stringify(_ex)}`);
  }
  }
}

function jqObjectKeyFilter({
  key,
}: {
  key: JqObjectKey,
}): JqFilter | undefined {
  switch (key.kind) {
  case 'static':
    return undefined;
  case 'dynamic':
    return key.filter;
  default: {
    const _ex: never = key;
    throw new Error(`Unhandled jq object key in iterative proof: ${JSON.stringify(_ex)}`);
  }
  }
}

function jqIterativeReplaySafeObjectKey({
  key,
}: {
  key: JqObjectKey,
}): boolean {
  const keyFilter = jqObjectKeyFilter({ key });
  return keyFilter === undefined
    || jqIterativeReplaySafeSingleOutput({ filter: keyFilter });
}

function jqFilterMayBreakLabel({
  filter,
  labelId,
}: {
  filter: JqFilter,
  labelId: number,
}): boolean {
  const pending: JqFilter[] = [filter];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    switch (current.kind) {
    case 'break':
      if (current.id === labelId) return true;
      break;
    case 'identity':
    case 'variable':
    case 'literal':
      break;
    case 'string':
      for (const part of current.parts) {
        const interpolationFilter = jqStringInterpolationFilter({ part });
        if (interpolationFilter !== undefined) pending.push(interpolationFilter);
      }
      break;
    case 'array':
      pending.push(...current.items);
      break;
    case 'object':
      for (const entry of current.entries) {
        const keyFilter = jqObjectKeyFilter({ key: entry.key });
        if (keyFilter !== undefined) pending.push(keyFilter);
        pending.push(entry.value);
      }
      break;
    case 'field':
    case 'index':
    case 'iterate':
    case 'recursive_descent':
      pending.push(current.input);
      break;
    case 'dynamic_index':
      pending.push(current.input, current.index);
      break;
    case 'slice':
      pending.push(current.input);
      if (current.start !== undefined) pending.push(current.start);
      if (current.end !== undefined) pending.push(current.end);
      break;
    case 'optional':
      pending.push(current.body);
      break;
    case 'pipe':
    case 'comma':
    case 'binary':
      pending.push(current.left, current.right);
      break;
    case 'conditional':
      pending.push(current.condition, current.thenBranch, current.elseBranch);
      break;
    case 'trycatch':
      pending.push(current.body, current.catchBranch);
      break;
    case 'call':
      pending.push(...current.args);
      break;
    case 'unary':
      pending.push(current.value);
      break;
    case 'bind':
      pending.push(current.binding, current.body);
      break;
    case 'label':
      pending.push(current.body);
      break;
    case 'reduce':
      pending.push(current.generator, current.initial, current.update);
      break;
    case 'foreach':
      pending.push(current.generator, current.initial, current.update, current.extract);
      break;
    case 'user_call':
    case 'unresolved_user_call':
    case 'assign':
    case 'update':
      return true;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled jq break-label scan filter: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return false;
}

function jqSingleOutputCommaBranches({
  filter,
}: {
  filter: JqFilter,
}): readonly JqFilter[] | undefined {
  const direct = jqAtomicCommaBranches({ filter });
  if (direct !== undefined) return direct;

  switch (filter.kind) {
  case 'comma': {
    const leftBranches = jqSingleOutputCommaBranches({ filter: filter.left });
    if (leftBranches === undefined) return undefined;
    const rightBranches = jqSingleOutputCommaBranches({ filter: filter.right });
    if (rightBranches === undefined
      || leftBranches.length > JQ_MAX_MATERIALIZED_VALUE_LENGTH - rightBranches.length) {
      return undefined;
    }
    return [...leftBranches, ...rightBranches];
  }
  case 'label':
    return jqFilterMayBreakLabel({ filter: filter.body, labelId: filter.id })
      ? undefined
      : jqSingleOutputCommaBranches({ filter: filter.body });
  case 'unary': {
    const valueBranches = jqSingleOutputCommaBranches({ filter: filter.value });
    return valueBranches?.map(value => ({ ...filter, value }));
  }
  case 'binary': {
    if (jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.left })) {
      const rightBranches = jqSingleOutputCommaBranches({ filter: filter.right });
      if (rightBranches !== undefined) return rightBranches.map(right => ({ ...filter, right }));
    }
    const pairwiseOperator = filter.operator === 'eq'
      || filter.operator === 'ne'
      || filter.operator === 'lt'
      || filter.operator === 'le'
      || filter.operator === 'gt'
      || filter.operator === 'ge'
      || filter.operator === 'add'
      || filter.operator === 'sub'
      || filter.operator === 'mul'
      || filter.operator === 'div'
      || filter.operator === 'mod';
    const replaySafeRight = filter.right.kind === 'literal' || filter.right.kind === 'variable';
    if (!pairwiseOperator || !replaySafeRight) return undefined;
    const leftBranches = jqSingleOutputCommaBranches({ filter: filter.left });
    return leftBranches?.map(left => ({ ...filter, left }));
  }
  case 'call': {
    if (filter.name !== 'select' || filter.args.length !== 1 || filter.args[0] === undefined) {
      return undefined;
    }
    const predicateBranches = jqSingleOutputCommaBranches({ filter: filter.args[0] });
    return predicateBranches?.map(predicate => ({ ...filter, args: [predicate] }));
  }
  case 'pipe': {
    if (!jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.right })) return undefined;
    const leftBranches = jqSingleOutputCommaBranches({ filter: filter.left });
    return leftBranches?.map(left => ({ kind: 'pipe', left, right: filter.right }));
  }
  case 'bind': {
    if (jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.body })) {
      const bindingBranches = jqSingleOutputCommaBranches({ filter: filter.binding });
      return bindingBranches?.map(binding => ({
        kind: 'bind',
        binding,
        name: filter.name,
        body: filter.body,
      }));
    }
    if (!jqIterativeReplaySafeSingleOutput({ filter: filter.binding })) return undefined;
    const bodyBranches = jqSingleOutputCommaBranches({ filter: filter.body });
    return bodyBranches?.map(body => ({
      kind: 'bind',
      binding: filter.binding,
      name: filter.name,
      body,
    }));
  }
  case 'conditional': {
    if (!jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.thenBranch })
      || !jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.elseBranch })) {
      return undefined;
    }
    const conditionBranches = jqSingleOutputCommaBranches({ filter: filter.condition });
    return conditionBranches?.map(condition => ({
      kind: 'conditional',
      condition,
      thenBranch: filter.thenBranch,
      elseBranch: filter.elseBranch,
    }));
  }
  case 'object': {
    let streamEntryIndex = -1;
    for (let index = 0; index < filter.entries.length; index += 1) {
      const entry = filter.entries[index]!;
      if (!jqIterativeReplaySafeObjectKey({ key: entry.key })) return undefined;
      if (jqIterativeBranchYieldsAtMostOneOutput({ filter: entry.value })) continue;
      if (streamEntryIndex !== -1) return undefined;
      streamEntryIndex = index;
    }
    if (streamEntryIndex < 0) return undefined;
    for (let index = 0; index < streamEntryIndex; index += 1) {
      if (!jqIterativeReplaySafeSingleOutput({ filter: filter.entries[index]!.value })) return undefined;
    }
    const streamEntry = filter.entries[streamEntryIndex]!;
    const valueBranches = jqSingleOutputCommaBranches({ filter: streamEntry.value });
    return valueBranches?.map(value => ({
      kind: 'object',
      entries: filter.entries.map((entry, index) => index === streamEntryIndex
        ? { key: entry.key, value }
        : entry),
    }));
  }
  case 'string': {
    const interpolationIndexes = filter.parts.flatMap((part, index) =>
      jqStringInterpolationFilter({ part }) === undefined ? [] : [index]);
    const streamInterpolationIndexes = interpolationIndexes.filter(index => {
      const interpolationFilter = jqStringInterpolationFilter({ part: filter.parts[index]! });
      return interpolationFilter !== undefined
        && !jqIterativeBranchYieldsAtMostOneOutput({ filter: interpolationFilter });
    });
    const [streamInterpolationIndex] = streamInterpolationIndexes;
    if (streamInterpolationIndexes.length === 1 && streamInterpolationIndex !== undefined) {
      for (const interpolationIndex of interpolationIndexes) {
        if (interpolationIndex === streamInterpolationIndex) continue;
        const interpolationFilter = jqStringInterpolationFilter({ part: filter.parts[interpolationIndex]! });
        if (interpolationFilter === undefined) return undefined;
        if (interpolationIndex > streamInterpolationIndex) {
          if (!jqIterativeReplaySafeSingleOutput({ filter: interpolationFilter })) return undefined;
        } else if (!jqIterativeBranchYieldsAtMostOneOutput({ filter: interpolationFilter })) {
          return undefined;
        }
      }
      const interpolationFilter = jqStringInterpolationFilter({
        part: filter.parts[streamInterpolationIndex]!,
      });
      if (interpolationFilter === undefined) return undefined;
      const interpolationBranches = jqSingleOutputCommaBranches({ filter: interpolationFilter });
      return interpolationBranches?.map(branch => ({
        kind: 'string',
        parts: filter.parts.map((part, index) => index === streamInterpolationIndex
          ? { kind: 'interpolation', filter: branch }
          : part),
      }));
    }
    if (streamInterpolationIndexes.length < 2) return undefined;
    let variants: JqStringPart[][] = [filter.parts.map(part => ({ ...part }))];
    for (let position = interpolationIndexes.length - 1; position >= 0; position -= 1) {
      const interpolationIndex = interpolationIndexes[position]!;
      const interpolationFilter = jqStringInterpolationFilter({ part: filter.parts[interpolationIndex]! });
      if (interpolationFilter === undefined) return undefined;
      const branches = jqSingleOutputCommaBranches({ filter: interpolationFilter })
        ?? (jqIterativeBranchYieldsAtMostOneOutput({ filter: interpolationFilter })
          ? [interpolationFilter]
          : undefined);
      if (branches === undefined
        || branches.some(branch => !jqIterativeRangeArgumentBranchSafe({ filter: branch }))
        || variants.length > Math.floor(JQ_MAX_MATERIALIZED_VALUE_LENGTH / Math.max(1, branches.length))) {
        return undefined;
      }
      const nextVariants: JqStringPart[][] = [];
      for (const variant of variants) {
        for (const branch of branches) {
          nextVariants.push(variant.map((variantPart, index) => index === interpolationIndex
            ? { kind: 'interpolation', filter: branch }
            : variantPart));
        }
      }
      variants = nextVariants;
    }
    return variants.map(parts => ({ kind: 'string', parts }));
  }
  default:
    return undefined;
  }
}

type JqIterativeRange = Readonly<{
  start: number;
  end: number;
  step: number;
}>;

type JqIterativeCommaBranchPlan = Readonly<{
  branches: readonly JqFilter[];
  suppressFailure: boolean;
  suppressBreakLabelId: number | undefined;
}>;

const JQ_MAX_ITERATIVE_LITERAL_RANGE_OUTPUTS = 64;

function jqIterativeRangeArgumentBranchSafe({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  if (jqIterativeReplaySafeSingleOutput({ filter })) return true;
  switch (filter.kind) {
  case 'call':
    if (filter.name === 'empty' && filter.args.length === 0) return true;
    return filter.name === 'error'
      && (filter.args.length === 0
        || (filter.args.length === 1
          && filter.args[0] !== undefined
          && jqIterativeReplaySafeSingleOutput({ filter: filter.args[0] })));
  case 'array':
  case 'string':
  case 'object':
  case 'field':
  case 'index':
  case 'dynamic_index':
  case 'slice':
  case 'optional':
  case 'pipe':
  case 'conditional':
  case 'trycatch':
  case 'bind':
  case 'label':
  case 'unary':
  case 'binary':
  case 'identity':
  case 'variable':
  case 'literal':
  case 'iterate':
  case 'recursive_descent':
  case 'comma':
  case 'user_call':
  case 'unresolved_user_call':
  case 'break':
  case 'reduce':
  case 'foreach':
  case 'assign':
  case 'update':
    return false;
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq iterative range branch filter: ${JSON.stringify(_ex)}`);
  }
  }
}

function jqIterativeRangeArgumentBranchSingleOutput({
  filter,
}: {
  filter: JqFilter,
}): boolean {
  if (jqIterativeRangeArgumentBranchSafe({ filter })) return true;
  return filter.kind === 'call' && filter.name === 'input' && filter.args.length === 0;
}

function jqIterativeRangeArgumentBranches({
  filter,
}: {
  filter: JqFilter,
}): readonly JqFilter[] | undefined {
  const reusable = jqSingleOutputCommaBranches({ filter });
  if (reusable !== undefined) return reusable;

  const pending: JqFilter[] = [filter];
  const branches: JqFilter[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    switch (current.kind) {
    case 'comma':
      pending.push(current.right, current.left);
      continue;
    case 'array':
    case 'string':
    case 'object':
    case 'field':
    case 'index':
    case 'dynamic_index':
    case 'slice':
    case 'optional':
    case 'pipe':
    case 'conditional':
    case 'trycatch':
    case 'bind':
    case 'label':
    case 'unary':
    case 'binary':
    case 'call':
    case 'identity':
    case 'variable':
    case 'literal':
    case 'iterate':
    case 'recursive_descent':
    case 'user_call':
    case 'unresolved_user_call':
    case 'break':
    case 'reduce':
    case 'foreach':
    case 'assign':
    case 'update':
      if (!jqIterativeRangeArgumentBranchSingleOutput({ filter: current })) return undefined;
      branches.push(current);
      break;
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled jq iterative range argument filter: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return branches;
}

type JqIterativeRangePlan = Readonly<{
  filter: Extract<JqFilter, { kind: 'call' }>;
  argumentBranches: readonly (readonly JqFilter[])[];
}>;

function jqIterativeRangePlan({
  filter,
}: {
  filter: JqFilter | undefined,
}): JqIterativeRangePlan | undefined {
  if (
    filter?.kind !== 'call'
    || filter.name !== 'range'
    || filter.args.length < 1
    || filter.args.length > 3
  ) return undefined;
  if (filter.args.every(argument => jqFilterYieldsAtMostOneOutput({ filter: argument }))) {
    return {
      filter,
      argumentBranches: filter.args.map(argument => [argument]),
    };
  }

  const argumentBranches: JqFilter[][] = [];
  for (const argument of filter.args) {
    const branches = jqIterativeRangeArgumentBranches({ filter: argument });
    if (branches === undefined || branches.length === 0) return undefined;
    argumentBranches.push([...branches]);
  }
  return { filter, argumentBranches };
}

function jqIterativeRangeHasValue({
  value,
  end,
  step,
}: {
  value: number;
  end: number;
  step: number;
}): boolean {
  return step > 0 ? value < end : step < 0 && value > end;
}

function jqIterativeRangeFromNumericArguments({
  numericArgs,
}: {
  numericArgs: readonly number[];
}): JqIterativeRange {
  switch (numericArgs.length) {
  case 1: return { start: 0, end: numericArgs[0]!, step: 1 };
  case 2: return { start: numericArgs[0]!, end: numericArgs[1]!, step: 1 };
  case 3: return { start: numericArgs[0]!, end: numericArgs[1]!, step: numericArgs[2]! };
  default: {
    const _ex: never = numericArgs.length as never;
    throw new Error(`Unhandled jq range arity: ${_ex}`);
  }
  }
}

function jqSmallLiteralRangeOutputCount({
  filter,
}: {
  filter: Extract<JqFilter, { kind: 'call' }>,
}): number | undefined {
  if (filter.name !== 'range' || filter.args.length === 0 || filter.args.length > 3) return undefined;
  const numericArgs: number[] = [];
  for (const argument of filter.args) {
    if (argument.kind !== 'literal' || typeof argument.value !== 'number' || !Number.isFinite(argument.value)) {
      return undefined;
    }
    numericArgs.push(argument.value);
  }
  const [start, end, step] = (() => {
    switch (numericArgs.length) {
    case 1: return [0, numericArgs[0]!, 1] as const;
    case 2: return [numericArgs[0]!, numericArgs[1]!, 1] as const;
    case 3: return [numericArgs[0]!, numericArgs[1]!, numericArgs[2]!] as const;
    default: return [0, 0, 0] as const;
    }
  })();
  if (step === 0 || (step > 0 ? start >= end : start <= end)) return 0;
  const estimated = Math.ceil(Math.abs((end - start) / step));
  return Number.isFinite(estimated) && estimated <= JQ_MAX_ITERATIVE_LITERAL_RANGE_OUTPUTS
    ? estimated
    : undefined;
}

function jqIterativeCommaBranchPlan({
  filter,
}: {
  filter: JqFilter,
}): JqIterativeCommaBranchPlan | undefined {
  const branches = jqSingleOutputCommaBranches({ filter });
  if (branches !== undefined) {
    return { branches, suppressFailure: false, suppressBreakLabelId: undefined };
  }
  switch (filter.kind) {
  case 'iterate':
    return jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.input })
      ? { branches: [filter], suppressFailure: false, suppressBreakLabelId: undefined }
      : undefined;
  case 'call':
    return jqSmallLiteralRangeOutputCount({ filter }) !== undefined
      ? { branches: [filter], suppressFailure: false, suppressBreakLabelId: undefined }
      : undefined;
  case 'label': {
    const bodyPlan = jqIterativeCommaBranchPlan({ filter: filter.body });
    if (bodyPlan === undefined || bodyPlan.suppressBreakLabelId !== undefined) return undefined;
    return {
      branches: bodyPlan.branches,
      suppressFailure: bodyPlan.suppressFailure,
      suppressBreakLabelId: filter.id,
    };
  }
  case 'optional': {
    const optionalPlan = jqIterativeCommaBranchPlan({ filter: filter.body });
    return optionalPlan === undefined
      ? undefined
      : {
        branches: optionalPlan.branches,
        suppressFailure: true,
        suppressBreakLabelId: optionalPlan.suppressBreakLabelId,
      };
  }
  case 'trycatch': {
    if (!jqFilterIsStaticallyEmptyOutput({ filter: filter.catchBranch })) return undefined;
    const bodyPlan = jqIterativeCommaBranchPlan({ filter: filter.body });
    return bodyPlan === undefined
      ? undefined
      : {
        branches: bodyPlan.branches,
        suppressFailure: true,
        suppressBreakLabelId: bodyPlan.suppressBreakLabelId,
      };
  }
  default:
    return undefined;
  }
}

function jqIterativeConditionAtomicBranches({
  filter,
}: {
  filter: JqFilter,
}): readonly JqFilter[] | undefined {
  const pending: JqFilter[] = [filter];
  const branches: JqFilter[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    switch (current.kind) {
    case 'comma':
      pending.push(current.right, current.left);
      continue;
    default: {
      const directInput = current.kind === 'call'
        && current.name === 'input'
        && current.args.length === 0;
      if (!directInput && !jqIterativeBranchYieldsAtMostOneOutput({ filter: current })) return undefined;
      branches.push(current);
      break;
    }
    }
  }
  return branches;
}

function jqIterativeConditionCommaBranchPlan({
  filter,
}: {
  filter: JqFilter,
}): JqIterativeCommaBranchPlan | undefined {
  const direct = jqIterativeConditionAtomicBranches({ filter });
  if (direct !== undefined) {
    return { branches: direct, suppressFailure: false, suppressBreakLabelId: undefined };
  }
  switch (filter.kind) {
  case 'label': {
    const bodyPlan = jqIterativeConditionCommaBranchPlan({ filter: filter.body });
    if (bodyPlan === undefined || bodyPlan.suppressBreakLabelId !== undefined) return undefined;
    return {
      branches: bodyPlan.branches,
      suppressFailure: bodyPlan.suppressFailure,
      suppressBreakLabelId: filter.id,
    };
  }
  case 'optional': {
    const bodyPlan = jqIterativeConditionCommaBranchPlan({ filter: filter.body });
    return bodyPlan === undefined
      ? undefined
      : {
        branches: bodyPlan.branches,
        suppressFailure: true,
        suppressBreakLabelId: bodyPlan.suppressBreakLabelId,
      };
  }
  case 'trycatch': {
    if (!jqFilterIsStaticallyEmptyOutput({ filter: filter.catchBranch })) return undefined;
    const bodyPlan = jqIterativeConditionCommaBranchPlan({ filter: filter.body });
    return bodyPlan === undefined
      ? undefined
      : {
        branches: bodyPlan.branches,
        suppressFailure: true,
        suppressBreakLabelId: bodyPlan.suppressBreakLabelId,
      };
  }
  default:
    return jqIterativeCommaBranchPlan({ filter });
  }
}

type JqIterativeBindBodyPlan = Readonly<{
  binding: JqFilter;
  name: string;
  bodyPlan: JqIterativeCommaBranchPlan;
}>;

function jqIterativeBindBodyPlan({
  filter,
}: {
  filter: JqFilter;
}): JqIterativeBindBodyPlan | undefined {
  switch (filter.kind) {
  case 'bind': {
    const directInput = filter.binding.kind === 'call'
      && filter.binding.name === 'input'
      && filter.binding.args.length === 0;
    if (!directInput && !jqIterativeBranchYieldsAtMostOneOutput({ filter: filter.binding })) return undefined;
    const bodyPlan = jqIterativeCommaBranchPlan({ filter: filter.body });
    return bodyPlan === undefined
      ? undefined
      : { binding: filter.binding, name: filter.name, bodyPlan };
  }
  default:
    return undefined;
  }
}

type JqIterativeConditionBindPlan = JqIterativeBindBodyPlan & Readonly<{
  suppressBindingFailure: boolean;
  suppressBindingBreakLabelId: number | undefined;
}>;

function jqIterativeConditionBindPlan({
  filter,
}: {
  filter: JqFilter;
}): JqIterativeConditionBindPlan | undefined {
  const direct = jqIterativeBindBodyPlan({ filter });
  if (direct !== undefined) {
    return {
      ...direct,
      suppressBindingFailure: false,
      suppressBindingBreakLabelId: undefined,
    };
  }
  switch (filter.kind) {
  case 'optional': {
    const inner = jqIterativeConditionBindPlan({ filter: filter.body });
    return inner === undefined
      ? undefined
      : {
        ...inner,
        bodyPlan: { ...inner.bodyPlan, suppressFailure: true },
        suppressBindingFailure: true,
      };
  }
  case 'trycatch': {
    if (!jqFilterIsStaticallyEmptyOutput({ filter: filter.catchBranch })) return undefined;
    const inner = jqIterativeConditionBindPlan({ filter: filter.body });
    return inner === undefined
      ? undefined
      : {
        ...inner,
        bodyPlan: { ...inner.bodyPlan, suppressFailure: true },
        suppressBindingFailure: true,
      };
  }
  case 'label': {
    const inner = jqIterativeConditionBindPlan({ filter: filter.body });
    if (
      inner === undefined
      || inner.bodyPlan.suppressBreakLabelId !== undefined
      || inner.suppressBindingBreakLabelId !== undefined
    ) return undefined;
    return {
      ...inner,
      bodyPlan: { ...inner.bodyPlan, suppressBreakLabelId: filter.id },
      suppressBindingBreakLabelId: filter.id,
    };
  }
  default:
    return undefined;
  }
}

function jqIterativePlanSuppressesFailure({
  suppressFailure,
  suppressBreakLabelId,
  result,
}: {
  suppressFailure: boolean,
  suppressBreakLabelId: number | undefined,
  result: Extract<JqRuntimeResult, { readonly ok: false }>,
}): boolean {
  if (result.inputRequest !== undefined || result.error.halt !== undefined) return false;
  return suppressFailure
    || (suppressBreakLabelId !== undefined && result.error.breakLabelId === suppressBreakLabelId);
}

function visitJqFilterOutputsWithContext({
  filter,
  input,
  context,
  consume,
}: {
  filter: JqFilter,
  input: JsonValue,
  context: JqRuntimeContext,
  consume: JqRuntimeOutputConsumer,
}): JqRuntimeOutputVisitResult {
  const evaluateWithMetadata = ({
    filter: nestedFilter,
    input: nestedInput,
    metadata,
    nestedContext,
  }: {
    filter: JqFilter,
    input: JsonValue,
    metadata: JqRuntimeInputMetadata,
    nestedContext: JqRuntimeContext,
  }): JqRuntimeResult => {
    const previousIndex = nestedContext.inputState.index;
    const previousMetadata = nestedContext.inputState.currentMetadata;
    nestedContext.inputState.currentMetadata = metadata;
    const evaluated = evaluateJqFilterWithContext({
      filter: nestedFilter,
      input: nestedInput,
      context: nestedContext,
    });
    if (nestedContext.inputState.index === previousIndex) {
      nestedContext.inputState.currentMetadata = previousMetadata;
    }
    return evaluated;
  };

  const contextWithBoundValue = ({
    nestedContext,
    name,
    value,
    metadata,
  }: {
    nestedContext: JqRuntimeContext;
    name: string;
    value: JsonValue;
    metadata: JqRuntimeInputMetadata;
  }): JqRuntimeContext => ({
    ...nestedContext,
    variables: { ...nestedContext.variables, [name]: value },
    variableNumberOrigins: {
      ...nestedContext.variableNumberOrigins,
      [name]: typeof value === 'number' ? metadata.numberOrigin : undefined,
    },
  });

  const evaluateSingleOutputRangeArgument = ({
    argument,
    input: rangeInput,
    metadata,
    nestedContext,
  }: {
    argument: JqFilter,
    input: JsonValue,
    metadata: JqRuntimeInputMetadata,
    nestedContext: JqRuntimeContext,
  }):
    | { ok: true, output: undefined }
    | {
      ok: true,
      output: {
        value: number,
        metadata: JqRuntimeInputMetadata,
      },
    }
    | { ok: false, result: Extract<JqRuntimeResult, { ok: false }> } => {
    const evaluated = evaluateWithMetadata({
      filter: argument,
      input: rangeInput,
      metadata,
      nestedContext,
    });
    if (!evaluated.ok) return { ok: false, result: clearFailureOutputs({ result: evaluated }) };
    if (evaluated.outputs.length === 0) return { ok: true, output: undefined };
    if (evaluated.outputs.length !== 1) {
      return {
        ok: false,
        result: runtimeError({ message: 'jq range single-output proof was violated', value: undefined }),
      };
    }
    const value = evaluated.outputs[0]!;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ok: false,
        result: runtimeError({ message: 'range arguments must be finite numbers', value: undefined }),
      };
    }
    return {
      ok: true,
      output: {
        value,
        metadata: metadataForResultOutput({
          result: evaluated,
          index: 0,
          fallback: metadata,
        }),
      },
    };
  };

  const visitWithMetadata = ({
    filter: nestedFilter,
    input: nestedInput,
    metadata,
    nestedContext,
    nestedConsume = consume,
  }: {
    filter: JqFilter,
    input: JsonValue,
    metadata: JqRuntimeInputMetadata,
    nestedContext: JqRuntimeContext,
    nestedConsume?: JqRuntimeOutputConsumer,
  }): JqRuntimeOutputVisitResult => {
    const previousIndex = nestedContext.inputState.index;
    const previousMetadata = nestedContext.inputState.currentMetadata;
    nestedContext.inputState.currentMetadata = metadata;
    const visited = visitJqFilterOutputsWithContext({
      filter: nestedFilter,
      input: nestedInput,
      context: nestedContext,
      consume: nestedConsume,
    });
    if (nestedContext.inputState.index === previousIndex) {
      nestedContext.inputState.currentMetadata = previousMetadata;
    }
    return visited;
  };

  const visitEvaluated = (): JqRuntimeOutputVisitResult => {
    const evaluated = evaluateJqFilterWithContext({ filter, input, context });
    const outputs = evaluated.ok ? evaluated.outputs : failureOutputs({ result: evaluated });
    const fallbackMetadata = context.inputState.currentMetadata;
    for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
      const visited = consume({
        value: outputs[outputIndex]!,
        metadata: metadataForResultOutput({
          result: evaluated,
          index: outputIndex,
          fallback: fallbackMetadata,
        }),
      });
      if (!visited.ok || visited.stopped) return visited;
    }
    return evaluated.ok
      ? { ok: true, stopped: false }
      : clearFailureOutputs({ result: evaluated });
  };

  const structuralLimit = checkLimits({ context });
  if (!structuralLimit.ok) return structuralLimit;
  const nestedContext: JqRuntimeContext = {
    ...context,
    depth: context.depth + 1,
  };

  switch (filter.kind) {
  case 'object': {
    type ObjectFrame = {
      readonly value: { [key: string]: JsonValue },
      readonly metadata: JqRuntimeInputMetadata,
    };
    const visitEntry = ({
      entryIndex,
      frame,
    }: {
      entryIndex: number,
      frame: ObjectFrame,
    }): JqRuntimeOutputVisitResult => {
      const entry = filter.entries[entryIndex];
      if (entry === undefined) {
        return consume({
          value: frame.value,
          metadata: metadataWithNumberOrigin({ metadata: frame.metadata, numberOrigin: undefined }),
        });
      }
      const visitValue = ({
        keyValue,
        keyMetadata,
      }: {
        keyValue: JsonValue,
        keyMetadata: JqRuntimeInputMetadata,
      }): JqRuntimeOutputVisitResult => visitWithMetadata({
        filter: entry.value,
        input,
        metadata: keyMetadata,
        nestedContext,
        nestedConsume: ({ value, metadata }) => {
          if (typeof keyValue !== 'string') {
            return runtimeError({
              message: formatJqObjectKeyError({
                key: keyValue,
                numberOrigin: keyMetadata.numberOrigin,
              }),
              value: undefined,
            });
          }
          const object = mergeJsonObjects({ left: frame.value, right: createJsonObject() });
          defineJsonProperty({ object, key: keyValue, value });
          setJsonChildNumberOrigin({
            container: object,
            key: keyValue,
            origin: metadata.numberOrigin,
          });
          return visitEntry({
            entryIndex: entryIndex + 1,
            frame: {
              value: object,
              metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
            },
          });
        },
      });
      switch (entry.key.kind) {
      case 'static':
        return visitValue({ keyValue: entry.key.value, keyMetadata: frame.metadata });
      case 'dynamic':
        return visitWithMetadata({
          filter: entry.key.filter,
          input,
          metadata: frame.metadata,
          nestedContext,
          nestedConsume: ({ value, metadata }) => visitValue({
            keyValue: value,
            keyMetadata: metadata,
          }),
        });
      default: {
        const _ex: never = entry.key;
        throw new Error(`Unhandled jq object key: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    };
    return visitEntry({
      entryIndex: 0,
      frame: {
        value: createJsonObject(),
        metadata: context.inputState.currentMetadata,
      },
    });
  }
  case 'string': {
    const visitParts = ({
      partIndex,
      suffix,
      metadata,
    }: {
      partIndex: number,
      suffix: string,
      metadata: JqRuntimeInputMetadata,
    }): JqRuntimeOutputVisitResult => {
      if (partIndex < 0) {
        return consume({
          value: suffix,
          metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
        });
      }
      const part = filter.parts[partIndex];
      if (part === undefined) throw new Error('jq string part index mismatch');
      switch (part.kind) {
      case 'text':
        return visitParts({
          partIndex: partIndex - 1,
          suffix: `${part.value}${suffix}`,
          metadata,
        });
      case 'interpolation':
        return visitWithMetadata({
          filter: part.filter,
          input,
          metadata,
          nestedContext,
          nestedConsume: ({ value, metadata: interpolationMetadata }) => visitParts({
            partIndex: partIndex - 1,
            suffix: `${stringifyInterpolationValue({
              value,
              numberOrigin: interpolationMetadata.numberOrigin,
            })}${suffix}`,
            metadata: interpolationMetadata,
          }),
        });
      default: {
        const _ex: never = part;
        throw new Error(`Unhandled string part: ${JSON.stringify(_ex)}`);
      }
      }
    };
    return visitParts({
      partIndex: filter.parts.length - 1,
      suffix: '',
      metadata: context.inputState.currentMetadata,
    });
  }
  case 'field':
    return visitJqFilterOutputsWithContext({
      filter: filter.input,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => {
        if (value === null) {
          return consume({
            value: null,
            metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
          });
        }
        if (isJsonObject(value)) {
          const child = Object.hasOwn(value, filter.key) ? value[filter.key]! : null;
          return consume({
            value: child,
            metadata: metadataForChildValue({
              metadata,
              container: value,
              key: filter.key,
              value: child,
            }),
          });
        }
        return filter.optional
          ? { ok: true, stopped: false }
          : runtimeError({
            message: formatJqIndexError({ container: value, index: filter.key }),
            value: undefined,
          });
      },
    });
  case 'index':
    return visitJqFilterOutputsWithContext({
      filter: filter.input,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => {
        if (value === null) {
          return consume({
            value: null,
            metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
          });
        }
        if (Array.isArray(value)) {
          const normalizedIndex = normalizeArrayIndex({ array: value, index: filter.index });
          const child = normalizedIndex === undefined ? null : value[normalizedIndex]!;
          return consume({
            value: child,
            metadata: normalizedIndex === undefined
              ? metadataWithNumberOrigin({ metadata, numberOrigin: undefined })
              : metadataForChildValue({
                metadata,
                container: value,
                key: normalizedIndex,
                value: child,
              }),
          });
        }
        return filter.optional
          ? { ok: true, stopped: false }
          : runtimeError({
            message: formatJqIndexError({ container: value, index: filter.index }),
            value: undefined,
          });
      },
    });
  case 'dynamic_index':
    return visitJqFilterOutputsWithContext({
      filter: filter.index,
      input,
      context: nestedContext,
      consume: ({ value: index, metadata: indexMetadata }) => visitWithMetadata({
        filter: filter.input,
        input,
        metadata: indexMetadata,
        nestedContext,
        nestedConsume: ({ value: parent, metadata: parentMetadata }) => {
          if (parent === null) {
            return consume({
              value: null,
              metadata: metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }),
            });
          }
          if (Array.isArray(parent) && typeof index === 'number' && Number.isFinite(index)) {
            const normalized = normalizeArrayIndex({ array: parent, index });
            const child = normalized === undefined ? null : parent[normalized]!;
            return consume({
              value: child,
              metadata: normalized === undefined
                ? metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined })
                : metadataForChildValue({
                  metadata: parentMetadata,
                  container: parent,
                  key: normalized,
                  value: child,
                }),
            });
          }
          if (isJsonObject(parent) && typeof index === 'string') {
            const child = Object.hasOwn(parent, index) ? parent[index]! : null;
            return consume({
              value: child,
              metadata: metadataForChildValue({
                metadata: parentMetadata,
                container: parent,
                key: index,
                value: child,
              }),
            });
          }
          return filter.optional
            ? { ok: true, stopped: false }
            : runtimeError({
              message: formatJqIndexError({ container: parent, index }),
              value: undefined,
            });
        },
      }),
    });
  case 'slice':
    return visitJqFilterOutputsWithContext({
      filter: filter.input,
      input,
      context: nestedContext,
      consume: ({ value: parent, metadata: parentMetadata }) => {
        const visitBound = ({
          boundFilter,
          boundConsume,
        }: {
          boundFilter: JqFilter | undefined,
          boundConsume: ({ value }: { value: JsonValue }) => JqRuntimeOutputVisitResult,
        }): JqRuntimeOutputVisitResult => boundFilter === undefined
          ? boundConsume({ value: null })
          : visitWithMetadata({
            filter: boundFilter,
            input,
            metadata: parentMetadata,
            nestedContext,
            nestedConsume: boundConsume,
          });
        return visitBound({
          boundFilter: filter.start,
          boundConsume: ({ value: startValue }) => visitBound({
            boundFilter: filter.end,
            boundConsume: ({ value: endValue }) => {
              const start = startValue === null ? undefined : startValue;
              const end = endValue === null ? undefined : endValue;
              if ((start !== undefined && typeof start !== 'number')
                || (end !== undefined && typeof end !== 'number')) {
                return filter.optional
                  ? { ok: true, stopped: false }
                  : runtimeError({ message: 'slice bounds must be numbers or null', value: undefined });
              }
              if (Array.isArray(parent)) {
                const normalizedStart = normalizeSliceBound({ length: parent.length, bound: start, fallback: 0 });
                const normalizedEnd = normalizeSliceBound({ length: parent.length, bound: end, fallback: 'length' });
                const child = parent.slice(normalizedStart, normalizedEnd);
                moveJsonArrayNumberOrigins({
                  source: parent,
                  target: child,
                  sourceStart: normalizedStart,
                  sourceEnd: normalizedEnd,
                });
                return consume({ value: child, metadata: parentMetadata });
              }
              if (typeof parent === 'string') {
                const codePoints = Array.from(parent);
                const normalizedStart = normalizeSliceBound({ length: codePoints.length, bound: start, fallback: 0 });
                const normalizedEnd = normalizeSliceBound({ length: codePoints.length, bound: end, fallback: 'length' });
                return consume({
                  value: codePoints.slice(normalizedStart, normalizedEnd).join(''),
                  metadata: metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }),
                });
              }
              if (parent === null) {
                return consume({
                  value: null,
                  metadata: metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }),
                });
              }
              return filter.optional
                ? { ok: true, stopped: false }
                : runtimeError({ message: 'cannot slice non-array/string', value: undefined });
            },
          }),
        });
      },
    });
  case 'iterate':
    return visitJqFilterOutputsWithContext({
      filter: filter.input,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => {
        if (Array.isArray(value)) {
          for (let index = 0; index < value.length; index += 1) {
            const child = value[index]!;
            const visited = consume({
              value: child,
              metadata: metadataForChildValue({
                metadata,
                container: value,
                key: index,
                value: child,
              }),
            });
            if (!visited.ok || visited.stopped) return visited;
          }
          return { ok: true, stopped: false };
        }
        if (isJsonObject(value)) {
          for (const [key, child] of jsonObjectEntries({ object: value })) {
            const visited = consume({
              value: child,
              metadata: metadataForChildValue({
                metadata,
                container: value,
                key,
                value: child,
              }),
            });
            if (!visited.ok || visited.stopped) return visited;
          }
          return { ok: true, stopped: false };
        }
        return filter.optional
          ? { ok: true, stopped: false }
          : runtimeError({ message: 'cannot iterate over non-array/object', value: undefined });
      },
    });
  case 'recursive_descent':
    return visitJqFilterOutputsWithContext({
      filter: filter.input,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => {
        const stack: { value: JsonValue, metadata: JqRuntimeInputMetadata }[] = [{ value, metadata }];
        while (stack.length > 0) {
          const current = stack.pop()!;
          const visited = consume(current);
          if (!visited.ok || visited.stopped) return visited;
          if (Array.isArray(current.value)) {
            for (let index = current.value.length - 1; index >= 0; index -= 1) {
              const child = current.value[index]!;
              stack.push({
                value: child,
                metadata: metadataForChildValue({
                  metadata: current.metadata,
                  container: current.value,
                  key: index,
                  value: child,
                }),
              });
            }
          } else if (isJsonObject(current.value)) {
            const entries = jsonObjectEntries({ object: current.value });
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              const [key, child] = entries[index]!;
              stack.push({
                value: child,
                metadata: metadataForChildValue({
                  metadata: current.metadata,
                  container: current.value,
                  key,
                  value: child,
                }),
              });
            }
          }
        }
        return { ok: true, stopped: false };
      },
    });
  case 'comma': {
    const left = visitJqFilterOutputsWithContext({
      filter: filter.left,
      input,
      context: nestedContext,
      consume,
    });
    if (!left.ok || left.stopped) return left;
    return visitJqFilterOutputsWithContext({
      filter: filter.right,
      input,
      context: nestedContext,
      consume,
    });
  }
  case 'pipe':
    return visitJqFilterOutputsWithContext({
      filter: filter.left,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => visitWithMetadata({
        filter: filter.right,
        input: value,
        metadata,
        nestedContext,
      }),
    });
  case 'optional': {
    const attempted = visitJqFilterOutputsWithContext({
      filter: filter.body,
      input,
      context: nestedContext,
      consume,
    });
    if (attempted.ok) return attempted;
    if (attempted.inputRequest !== undefined || attempted.error.halt !== undefined) {
      return attempted;
    }
    return { ok: true, stopped: false };
  }
  case 'trycatch': {
    const attempted = visitJqFilterOutputsWithContext({
      filter: filter.body,
      input,
      context: nestedContext,
      consume,
    });
    if (attempted.ok) return attempted;
    if (attempted.inputRequest !== undefined || attempted.error.halt !== undefined) {
      return attempted;
    }
    const errorMetadata = attempted.error.metadata ?? context.inputState.currentMetadata;
    return visitWithMetadata({
      filter: filter.catchBranch,
      input: attempted.error.value === undefined
        ? attempted.error.message
        : attempted.error.value,
      metadata: errorMetadata,
      nestedContext,
    });
  }
  case 'label': {
    const attempted = visitJqFilterOutputsWithContext({
      filter: filter.body,
      input,
      context: nestedContext,
      consume,
    });
    if (!attempted.ok && attempted.error.breakLabelId === filter.id) {
      return { ok: true, stopped: false };
    }
    return attempted;
  }
  case 'conditional':
    return visitJqFilterOutputsWithContext({
      filter: filter.condition,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => visitWithMetadata({
        filter: truthy({ value }) ? filter.thenBranch : filter.elseBranch,
        input,
        metadata,
        nestedContext,
      }),
    });
  case 'bind':
    return visitJqFilterOutputsWithContext({
      filter: filter.binding,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => visitWithMetadata({
        filter: filter.body,
        input,
        metadata,
        nestedContext: {
          ...nestedContext,
          variables: { ...nestedContext.variables, [filter.name]: value },
          variableNumberOrigins: {
            ...nestedContext.variableNumberOrigins,
            [filter.name]: typeof value === 'number' ? metadata.numberOrigin : undefined,
          },
        },
      }),
    });
  case 'binary': {
    const shortCircuitOperator = booleanShortCircuitOperator({ operator: filter.operator });
    if (shortCircuitOperator !== undefined) {
      return visitJqFilterOutputsWithContext({
        filter: filter.left,
        input,
        context: nestedContext,
        consume: ({ value: leftValue, metadata: leftMetadata }) => {
          const leftIsTruthy = truthy({ value: leftValue });
          const shortCircuitValue = (() => {
            switch (shortCircuitOperator) {
            case 'and': return leftIsTruthy ? undefined : false;
            case 'or': return leftIsTruthy ? true : undefined;
            default: {
              const _ex: never = shortCircuitOperator;
              throw new Error(`Unhandled jq boolean operator: ${_ex}`);
            }
            }
          })();
          if (shortCircuitValue !== undefined) {
            return consume({
              value: shortCircuitValue,
              metadata: metadataWithNumberOrigin({ metadata: leftMetadata, numberOrigin: undefined }),
            });
          }
          return visitWithMetadata({
            filter: filter.right,
            input,
            metadata: leftMetadata,
            nestedContext,
            nestedConsume: ({ value, metadata }) => consume({
              value: truthy({ value }),
              metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
            }),
          });
        },
      });
    }
    if (isAlternativeOperator({ operator: filter.operator })) {
      let foundTruthy = false;
      const left = visitJqFilterOutputsWithContext({
        filter: filter.left,
        input,
        context: nestedContext,
        consume: ({ value, metadata }) => {
          if (!truthy({ value })) return { ok: true, stopped: false };
          foundTruthy = true;
          return consume({ value, metadata });
        },
      });
      if (!left.ok || left.stopped || foundTruthy) return left;
      return visitJqFilterOutputsWithContext({
        filter: filter.right,
        input,
        context: nestedContext,
        consume,
      });
    }
    const rightYieldsAtMostOne = jqFilterYieldsAtMostOneOutput({ filter: filter.right });
    const binaryInputMetadata = context.inputState.currentMetadata;
    let rightOutputCount = 0;
    return visitJqFilterOutputsWithContext({
      filter: filter.right,
      input,
      context: nestedContext,
      consume: ({ value: rightValue, metadata: rightMetadata }) => {
        rightOutputCount += 1;
        const emitPair = ({
          leftValue,
          leftMetadata,
          sourceMetadata,
        }: {
          leftValue: JsonValue,
          leftMetadata: JqRuntimeInputMetadata,
          sourceMetadata: JqRuntimeInputMetadata,
        }): JqRuntimeOutputVisitResult => {
          const pair = evaluateBinaryPair({
            operator: filter.operator,
            left: leftValue,
            right: rightValue,
            leftOrigin: leftMetadata.numberOrigin,
            rightOrigin: rightMetadata.numberOrigin,
          });
          if (!pair.ok) return pair;
          return consume({
            value: pair.value,
            metadata: metadataWithNumberOrigin({
              metadata: sourceMetadata,
              numberOrigin: pair.numberOrigin,
            }),
          });
        };

        const visitLeft = ({
          leftConsumer,
        }: {
          leftConsumer: JqRuntimeOutputConsumer,
        }): JqRuntimeOutputVisitResult => {
          const previousIndex = nestedContext.inputState.index;
          const previousMetadata = nestedContext.inputState.currentMetadata;
          nestedContext.inputState.currentMetadata = binaryInputMetadata;
          const visited = visitJqFilterOutputsWithContext({
            filter: filter.left,
            input,
            context: nestedContext,
            consume: leftConsumer,
          });
          if (nestedContext.inputState.index === previousIndex) {
            nestedContext.inputState.currentMetadata = previousMetadata;
          }
          return visited;
        };

        return visitLeft({
          leftConsumer: ({ value: leftValue, metadata: leftMetadata }) => emitPair({
            leftValue,
            leftMetadata,
            sourceMetadata: rightYieldsAtMostOne && rightOutputCount === 1
              ? leftMetadata
              : rightMetadata,
          }),
        });
      },
    });
  }
  case 'unary': {
    const unaryOperator = filter.operator;
    return visitJqFilterOutputsWithContext({
      filter: filter.value,
      input,
      context: nestedContext,
      consume: ({ value, metadata }) => {
        switch (unaryOperator) {
        case 'not':
          return consume({
            value: !truthy({ value }),
            metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
          });
        case 'neg':
          if (typeof value !== 'number') {
            return runtimeError({ message: `cannot negate ${jqValueTypeName({ value })}`, value: undefined });
          }
          return consume({
            value: normalizeJqArithmeticResult({ value: -toJqArithmeticNumber({ value }) }),
            metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
          });
        default: {
          const _ex: never = unaryOperator;
          throw new Error(`Unhandled jq unary operator: ${_ex}`);
        }
        }
      },
    });
  }
  case 'assign': {
    type AssignmentFrame = { readonly paths: readonly JqPath[] };
    const frames: AssignmentFrame[] = [];
    let assignmentFilter: JqFilter = filter;
    let assignmentContext = context;
    while (assignmentFilter.kind === 'assign') {
      const assignmentNestedContext: JqRuntimeContext = {
        ...assignmentContext,
        depth: assignmentContext.depth + 1,
      };
      let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
      const materialized = materializeJqPathExpression({
        root: input,
        expression: assignmentFilter.pathExpression,
        evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
          const evaluated = evaluateJqFilterWithContext({
            filter: indexFilter,
            input: indexInput,
            context: assignmentNestedContext,
          });
          if (evaluated.ok) return evaluated;
          dynamicPathFailure = evaluated;
          return { ok: false, message: evaluated.error.message };
        },
      });
      if (!materialized.ok) {
        return dynamicPathFailure === undefined
          ? runtimeError({ message: materialized.message, value: undefined })
          : clearFailureOutputs({ result: dynamicPathFailure });
      }
      frames.push({ paths: materialized.paths });
      assignmentFilter = assignmentFilter.value;
      assignmentContext = assignmentNestedContext;
    }
    return visitJqFilterOutputsWithContext({
      filter: assignmentFilter,
      input,
      context: assignmentContext,
      consume: ({ value, metadata }) => {
        let assignedValue = value;
        let assignedMetadata = metadata;
        for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
          const frame = frames[frameIndex]!;
          let assignedRoot = input;
          let assignedRootOrigin = context.inputState.currentMetadata.numberOrigin;
          for (const path of frame.paths) {
            const assigned = applyPathUpdate({
              root: assignedRoot,
              path,
              update: () => ({
                ok: true,
                value: assignedValue,
                numberOrigin: typeof assignedValue === 'number'
                  ? assignedMetadata.numberOrigin
                  : undefined,
              }),
            });
            if (!assigned.ok) return runtimeError({ message: assigned.message, value: undefined });
            assignedRoot = assigned.value;
            assignedRootOrigin = assigned.numberOrigin;
          }
          assignedValue = assignedRoot;
          assignedMetadata = metadataWithNumberOrigin({
            metadata: assignedMetadata,
            numberOrigin: typeof assignedRoot === 'number' ? assignedRootOrigin : undefined,
          });
        }
        return consume({ value: assignedValue, metadata: assignedMetadata });
      },
    });
  }
  case 'update': {
    const compoundOperator = (() => {
      switch (filter.mode.kind) {
      case 'first': return undefined;
      case 'compound': return filter.mode.operator;
      default: {
        const _ex: never = filter.mode;
        throw new Error(`Unhandled jq update mode: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    if (compoundOperator === undefined) return visitEvaluated();
    let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
    const materialized = materializeJqPathExpression({
      root: input,
      expression: filter.pathExpression,
      evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
        const evaluated = evaluateJqFilterWithContext({
          filter: indexFilter,
          input: indexInput,
          context: nestedContext,
        });
        if (evaluated.ok) return evaluated;
        dynamicPathFailure = evaluated;
        return { ok: false, message: evaluated.error.message };
      },
    });
    if (!materialized.ok) {
      return dynamicPathFailure === undefined
        ? runtimeError({ message: materialized.message, value: undefined })
        : clearFailureOutputs({ result: dynamicPathFailure });
    }
    return visitJqFilterOutputsWithContext({
      filter: filter.value,
      input,
      context: nestedContext,
      consume: ({ value: rightValue, metadata: rightMetadata }) => {
        let updatedRoot = input;
        let updatedRootOrigin = context.inputState.currentMetadata.numberOrigin;
        for (const path of materialized.paths) {
          const current = readJqPathValue({ root: updatedRoot, path });
          if (!current.ok) return runtimeError({ message: current.message, value: undefined });
          if (current.skipped) continue;
          const pair = evaluateBinaryPair({
            operator: compoundOperator,
            left: current.value ?? null,
            right: rightValue,
            leftOrigin: current.numberOrigin,
            rightOrigin: rightMetadata.numberOrigin,
          });
          if (!pair.ok) return pair;
          const updated = applyPathUpdate({
            root: updatedRoot,
            path,
            update: () => ({
              ok: true,
              value: pair.value,
              numberOrigin: pair.numberOrigin,
            }),
          });
          if (!updated.ok) return runtimeError({ message: updated.message, value: undefined });
          updatedRoot = updated.value;
          updatedRootOrigin = updated.numberOrigin;
        }
        return consume({
          value: updatedRoot,
          metadata: metadataWithNumberOrigin({
            metadata: rightMetadata,
            numberOrigin: typeof updatedRoot === 'number' ? updatedRootOrigin : undefined,
          }),
        });
      },
    });
  }
  case 'reduce':
    return visitJqFilterOutputsWithContext({
      filter: filter.initial,
      input,
      context: nestedContext,
      consume: ({ value: initialState, metadata: initialMetadata }) => {
        let state: JsonValue = initialState;
        let stateMetadata = initialMetadata;
        const generated = visitWithMetadata({
          filter: filter.generator,
          input,
          metadata: initialMetadata,
          nestedContext,
          nestedConsume: ({ value: generatedValue, metadata: generatedMetadata }) => {
            const scopedContext: JqRuntimeContext = {
              ...nestedContext,
              variables: {
                ...nestedContext.variables,
                [filter.name]: generatedValue,
              },
              variableNumberOrigins: {
                ...nestedContext.variableNumberOrigins,
                [filter.name]: typeof generatedValue === 'number'
                  ? generatedMetadata.numberOrigin
                  : undefined,
              },
            };
            const previousIndex = scopedContext.inputState.index;
            const previousMetadata = scopedContext.inputState.currentMetadata;
            const updateInputMetadata = metadataWithNumberOrigin({
              metadata: generatedMetadata,
              numberOrigin: typeof state === 'number' ? stateMetadata.numberOrigin : undefined,
            });
            scopedContext.inputState.currentMetadata = updateInputMetadata;
            const updated = evaluateJqFilterWithContext({
              filter: filter.update,
              input: state,
              context: scopedContext,
            });
            const updatedFallbackMetadata = scopedContext.inputState.index === previousIndex
              ? updateInputMetadata
              : scopedContext.inputState.currentMetadata;
            if (scopedContext.inputState.index === previousIndex) {
              scopedContext.inputState.currentMetadata = previousMetadata;
            }
            if (!updated.ok) return clearFailureOutputs({ result: updated });
            const lastUpdated = updated.outputs.at(-1) ?? null;
            const lastUpdatedMetadata = updated.outputs.length === 0
              ? metadataWithNumberOrigin({
                metadata: updatedFallbackMetadata,
                numberOrigin: undefined,
              })
              : metadataForResultOutput({
                result: updated,
                index: updated.outputs.length - 1,
                fallback: updatedFallbackMetadata,
              });
            state = lastUpdated;
            stateMetadata = lastUpdatedMetadata;
            return { ok: true, stopped: false };
          },
        });
        if (!generated.ok) return clearFailureOutputs({ result: generated });
        return consume({ value: state, metadata: stateMetadata });
      },
    });
  case 'foreach':
    return visitJqFilterOutputsWithContext({
      filter: filter.initial,
      input,
      context: nestedContext,
      consume: ({ value: initialState, metadata: initialMetadata }) => {
        let state: JsonValue | undefined = initialState;
        let stateMetadata = initialMetadata;
        const generated = visitWithMetadata({
          filter: filter.generator,
          input,
          metadata: initialMetadata,
          nestedContext,
          nestedConsume: ({ value: generatedValue, metadata: generatedMetadata }) => {
            if (state === undefined) return { ok: true, stopped: false };
            const scopedContext: JqRuntimeContext = {
              ...nestedContext,
              variables: {
                ...nestedContext.variables,
                [filter.name]: generatedValue,
              },
              variableNumberOrigins: {
                ...nestedContext.variableNumberOrigins,
                [filter.name]: typeof generatedValue === 'number'
                  ? generatedMetadata.numberOrigin
                  : undefined,
              },
            };
            const previousIndex = scopedContext.inputState.index;
            const previousMetadata = scopedContext.inputState.currentMetadata;
            const updateInputMetadata = metadataWithNumberOrigin({
              metadata: generatedMetadata,
              numberOrigin: typeof state === 'number' ? stateMetadata.numberOrigin : undefined,
            });
            scopedContext.inputState.currentMetadata = updateInputMetadata;
            const updated = evaluateJqFilterWithContext({
              filter: filter.update,
              input: state,
              context: scopedContext,
            });
            const updatedFallbackMetadata = scopedContext.inputState.index === previousIndex
              ? updateInputMetadata
              : scopedContext.inputState.currentMetadata;
            if (scopedContext.inputState.index === previousIndex) {
              scopedContext.inputState.currentMetadata = previousMetadata;
            }
            if (!updated.ok) return clearFailureOutputs({ result: updated });
            let lastUpdatedMetadata: JqRuntimeInputMetadata | undefined;
            for (let updatedIndex = 0; updatedIndex < updated.outputs.length; updatedIndex += 1) {
              const updatedState = updated.outputs[updatedIndex]!;
              const updatedMetadata = metadataForResultOutput({
                result: updated,
                index: updatedIndex,
                fallback: updatedFallbackMetadata,
              });
              lastUpdatedMetadata = updatedMetadata;
              const extracted = visitWithMetadata({
                filter: filter.extract,
                input: updatedState,
                metadata: updatedMetadata,
                nestedContext: scopedContext,
              });
              if (!extracted.ok || extracted.stopped) return extracted;
            }
            state = updated.outputs.at(-1);
            if (state !== undefined && lastUpdatedMetadata !== undefined) {
              stateMetadata = lastUpdatedMetadata;
            }
            return { ok: true, stopped: false };
          },
        });
        return generated;
      },
    });
  case 'user_call': {
    if (context.userDefinitionCallDepth >= JQ_MAX_USER_DEFINITION_CALL_DEPTH) {
      return runtimeError({ message: 'maximum jq evaluation depth exceeded', value: undefined });
    }
    const definition = context.userDefinitions.get(filter.definitionId);
    if (definition === undefined) {
      return runtimeError({
        message: `user-defined filter id ${filter.definitionId} is not registered`,
        value: undefined,
      });
    }
    return visitJqFilterOutputsWithContext({
      filter: instantiateJqUserDefinition({ definition, args: filter.args }),
      input,
      context: {
        ...nestedContext,
        userDefinitionCallDepth: context.userDefinitionCallDepth + 1,
      },
      consume,
    });
  }
  case 'call': {
    const visitBuiltinArgumentStreams = ({
      argumentFilters,
      materializeRemainingArgumentStreams,
    }: {
      // jq evaluates the first item as the outer stream. Callers provide the
      // builtin-specific order because regular-expression flags are outer to
      // the pattern, while ordinary one-argument builtins have one item.
      argumentFilters: readonly JqFilter[],
      materializeRemainingArgumentStreams: boolean,
    }): JqRuntimeOutputVisitResult => {
      const builtinInputMetadata = nestedContext.inputState.currentMetadata;
      const evaluatedArguments = new Map<
        JqFilter,
        { readonly value: JsonValue; readonly metadata: JqRuntimeInputMetadata }
      >();

      const visitArgument = ({ index }: { index: number }): JqRuntimeOutputVisitResult => {
        const argumentFilter = argumentFilters[index];
        if (argumentFilter !== undefined) {
          return visitJqFilterOutputsWithContext({
            filter: argumentFilter,
            input,
            context: nestedContext,
            consume: ({ value, metadata }) => {
              const previous = evaluatedArguments.get(argumentFilter);
              evaluatedArguments.set(argumentFilter, { value, metadata });
              const visited = visitArgument({ index: index + 1 });
              if (previous === undefined) evaluatedArguments.delete(argumentFilter);
              else evaluatedArguments.set(argumentFilter, previous);
              return visited;
            },
          });
        }

        const evaluateArgument: JqRuntimeFilterEvaluator = ({
          filter: evaluatedFilter,
          input: evaluatedInput,
          inputMetadata,
        }) => {
          const substituted = evaluatedArguments.get(evaluatedFilter);
          if (substituted !== undefined) {
            return {
              ok: true,
              outputs: [substituted.value],
              outputMetadata: [substituted.metadata],
            };
          }
          const evaluationContext = inputMetadata === undefined
            ? nestedContext
            : {
              ...nestedContext,
              inputState: {
                ...nestedContext.inputState,
                currentMetadata: inputMetadata,
              },
            };
          return evaluateJqFilterWithContext({
            filter: evaluatedFilter,
            input: evaluatedInput,
            context: evaluationContext,
          });
        };
        // The visitor has already expanded every listed argument stream to one
        // value. Bypass evaluateBuiltin's materializing wrappers so none of the
        // streams is evaluated a second time.
        const evaluateSelectedBuiltin = materializeRemainingArgumentStreams
          ? evaluateBuiltin
          : evaluateBuiltinWithEvaluatedArguments;
        const evaluated = evaluateSelectedBuiltin({
          name: filter.name,
          args: filter.args,
          input,
          evaluate: evaluateArgument,
          takeInputs: ({ maximumValues, eofBehavior }) => takeRuntimeInputs({
            context: nestedContext,
            maximumValues,
            eofBehavior,
          }),
          inputMetadata: builtinInputMetadata,
          evaluateFirstOutput: evaluateArgument,
          emitStderr: ({ text }) => {
            context.state.stderr.push(text);
          },
        });
        const outputs = evaluated.ok ? evaluated.outputs : failureOutputs({ result: evaluated });
        for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
          const visited = consume({
            value: outputs[outputIndex]!,
            metadata: metadataForResultOutput({
              result: evaluated,
              index: outputIndex,
              fallback: builtinInputMetadata,
            }),
          });
          if (!visited.ok || visited.stopped) return visited;
        }
        return evaluated.ok
          ? { ok: true, stopped: false }
          : clearFailureOutputs({ result: evaluated });
      };

      return visitArgument({ index: 0 });
    };

    switch (filter.name) {
    case 'limit':
    case 'nth': {
      if (filter.args.length !== 2 || filter.args[0] === undefined || filter.args[1] === undefined) {
        return visitEvaluated();
      }
      return visitJqCountedGeneratorOutputs({
        name: filter.name,
        countFilter: filter.args[0],
        generator: filter.args[1],
        input,
        context,
        consume,
      });
    }
    case 'path': {
      const argument = filter.args[0];
      if (filter.args.length !== 1 || argument === undefined) return visitEvaluated();
      const pathExpression = extractPathExpression({ filter: argument });
      if (pathExpression === undefined) return visitEvaluated();

      const requiresStreamingPathVisitor = (() => {
        const pending: JqPathExpression[] = [pathExpression];
        while (pending.length > 0) {
          const expression = pending.pop()!;
          switch (expression.kind) {
          case 'path':
            break;
          case 'sequence':
            for (const item of expression.items) pending.push(item);
            break;
          case 'append':
            pending.push(expression.parent);
            break;
          case 'dynamic_index':
          case 'dynamic_slice':
          case 'iterate':
            return true;
          default: {
            const _ex: never = expression;
            throw new Error(`Unhandled jq path expression: ${JSON.stringify(_ex)}`);
          }
          }
        }
        return false;
      })();

      if (!requiresStreamingPathVisitor) {
        const materialized = materializeJqPathExpression({
          root: input,
          expression: pathExpression,
          evaluateDynamicIndex: () => ({
            ok: false,
            message: 'static jq path unexpectedly requested a dynamic index',
          }),
        });
        if (!materialized.ok) return runtimeError({ message: materialized.message, value: undefined });
        for (const path of materialized.paths) {
          const visited = consume({
            value: path.segments.map(segment => {
              switch (segment.kind) {
              case 'field': return segment.key;
              case 'index': return segment.index;
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
            }),
            metadata: nestedContext.inputState.currentMetadata,
          });
          if (!visited.ok || visited.stopped) return visited;
        }
        return { ok: true, stopped: false };
      }

      type VisitedPath = {
        readonly path: JqPath,
        readonly metadata: JqRuntimeInputMetadata,
      };
      type JqPathConsumer = ({ path, metadata }: VisitedPath) => JqRuntimeOutputVisitResult;

      const appendSegment = ({
        path,
        segment,
      }: {
        path: JqPath,
        segment: JqPathSegment,
      }): JqPath => ({ segments: [...path.segments, segment] });

      const pathOutput = ({ path }: { path: JqPath }): JsonValue[] => path.segments.map(segment => {
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

      const visitPathExpression = ({
        expression,
        pathConsume,
      }: {
        expression: JqPathExpression,
        pathConsume: JqPathConsumer,
      }): JqRuntimeOutputVisitResult => {
        switch (expression.kind) {
        case 'path':
          return pathConsume({
            path: expression.path,
            metadata: nestedContext.inputState.currentMetadata,
          });
        case 'sequence': {
          const visitItem = ({ index }: { index: number }): JqRuntimeOutputVisitResult => {
            const item = expression.items[index];
            if (item === undefined) return { ok: true, stopped: false };
            const visited = visitPathExpression({ expression: item, pathConsume });
            return !visited.ok || visited.stopped
              ? visited
              : visitItem({ index: index + 1 });
          };
          return visitItem({ index: 0 });
        }
        case 'append':
          return visitPathExpression({
            expression: expression.parent,
            pathConsume: ({ path, metadata }) => pathConsume({
              path: appendSegment({ path, segment: expression.segment }),
              metadata,
            }),
          });
        case 'iterate':
          return visitPathExpression({
            expression: expression.parent,
            pathConsume: ({ path, metadata }) => {
              const parent = readJqPathValue({ root: input, path });
              if (!parent.ok) return runtimeError({ message: parent.message, value: undefined });
              if (parent.skipped) return { ok: true, stopped: false };
              if (Array.isArray(parent.value)) {
                for (let index = 0; index < parent.value.length; index += 1) {
                  const visited = pathConsume({
                    path: appendSegment({ path, segment: { kind: 'index', index, optional: false } }),
                    metadata,
                  });
                  if (!visited.ok || visited.stopped) return visited;
                }
                return { ok: true, stopped: false };
              }
              if (parent.value !== undefined && isJsonObject(parent.value)) {
                for (const key of jsonObjectKeys({ object: parent.value })) {
                  const visited = pathConsume({
                    path: appendSegment({ path, segment: { kind: 'field', key, optional: false } }),
                    metadata,
                  });
                  if (!visited.ok || visited.stopped) return visited;
                }
                return { ok: true, stopped: false };
              }
              return expression.optional
                ? { ok: true, stopped: false }
                : runtimeError({ message: 'cannot iterate over non-array/object', value: undefined });
            },
          });
        case 'dynamic_index': {
          const parents: VisitedPath[] = [];
          const parentVisit = visitPathExpression({
            expression: expression.parent,
            pathConsume: ({ path, metadata }) => {
              if (parents.length >= JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
                return runtimeError({
                  message: `path materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
                  value: undefined,
                });
              }
              parents.push({ path, metadata });
              return { ok: true, stopped: false };
            },
          });
          if (!parentVisit.ok || parentVisit.stopped) return parentVisit;
          return visitWithMetadata({
            filter: expression.index,
            input,
            metadata: nestedContext.inputState.currentMetadata,
            nestedContext,
            nestedConsume: ({ value: indexValue, metadata }) => {
              for (const parentEntry of parents) {
                const parent = readJqPathValue({ root: input, path: parentEntry.path });
                if (!parent.ok) return runtimeError({ message: parent.message, value: undefined });
                if (parent.skipped) continue;
                let segment: JqPathSegment | undefined;
                if (
                  (parent.value === undefined || parent.value === null)
                  && typeof indexValue === 'number'
                  && Number.isFinite(indexValue)
                ) {
                  segment = { kind: 'index', index: Math.trunc(indexValue), optional: expression.optional };
                } else if (
                  (parent.value === undefined || parent.value === null)
                  && typeof indexValue === 'string'
                ) {
                  segment = { kind: 'field', key: indexValue, optional: expression.optional };
                } else if (
                  Array.isArray(parent.value)
                  && typeof indexValue === 'number'
                  && Number.isFinite(indexValue)
                ) {
                  segment = { kind: 'index', index: Math.trunc(indexValue), optional: expression.optional };
                } else if (
                  parent.value !== undefined
                  && isJsonObject(parent.value)
                  && typeof indexValue === 'string'
                ) {
                  segment = { kind: 'field', key: indexValue, optional: expression.optional };
                } else if (!expression.optional) {
                  return runtimeError({
                    message: formatJqIndexError({ container: parent.value ?? null, index: indexValue }),
                    value: undefined,
                  });
                }
                if (segment === undefined) continue;
                const visited = pathConsume({
                  path: appendSegment({ path: parentEntry.path, segment }),
                  metadata,
                });
                if (!visited.ok || visited.stopped) return visited;
              }
              return { ok: true, stopped: false };
            },
          });
        }
        case 'dynamic_slice': {
          const parents: VisitedPath[] = [];
          const parentVisit = visitPathExpression({
            expression: expression.parent,
            pathConsume: ({ path, metadata }) => {
              if (parents.length >= JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
                return runtimeError({
                  message: `path materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
                  value: undefined,
                });
              }
              parents.push({ path, metadata });
              return { ok: true, stopped: false };
            },
          });
          if (!parentVisit.ok || parentVisit.stopped) return parentVisit;

          const visitBound = ({
            boundFilter,
            boundConsume,
          }: {
            boundFilter: JqFilter | undefined,
            boundConsume: ({ value, metadata }: {
              value: number | undefined,
              metadata: JqRuntimeInputMetadata,
            }) => JqRuntimeOutputVisitResult,
          }): JqRuntimeOutputVisitResult => {
            if (boundFilter === undefined) {
              return boundConsume({
                value: undefined,
                metadata: nestedContext.inputState.currentMetadata,
              });
            }
            return visitWithMetadata({
              filter: boundFilter,
              input,
              metadata: nestedContext.inputState.currentMetadata,
              nestedContext,
              nestedConsume: ({ value, metadata }) => {
                if (value === null) return boundConsume({ value: undefined, metadata });
                if (typeof value !== 'number') {
                  return runtimeError({
                    message: 'Array/string slice indices must be integers',
                    value: undefined,
                  });
                }
                return boundConsume({ value, metadata });
              },
            });
          };

          return visitBound({
            boundFilter: expression.start,
            boundConsume: ({ value: start, metadata: startMetadata }) => visitBound({
              boundFilter: expression.end,
              boundConsume: ({ value: end, metadata: endMetadata }) => {
                for (const parentEntry of parents) {
                  const parent = readJqPathValue({ root: input, path: parentEntry.path });
                  if (!parent.ok) return runtimeError({ message: parent.message, value: undefined });
                  if (parent.skipped) continue;
                  if (
                    parent.value !== undefined
                    && parent.value !== null
                    && !Array.isArray(parent.value)
                    && typeof parent.value !== 'string'
                  ) {
                    if (expression.optional) continue;
                    return runtimeError({ message: 'cannot slice non-array/string', value: undefined });
                  }
                  const visited = pathConsume({
                    path: appendSegment({
                      path: parentEntry.path,
                      segment: { kind: 'slice', start, end, optional: expression.optional },
                    }),
                    metadata: endMetadata.lineNumber !== startMetadata.lineNumber
                      || endMetadata.filename !== startMetadata.filename
                      || endMetadata.numberOrigin !== startMetadata.numberOrigin
                      ? endMetadata
                      : startMetadata,
                  });
                  if (!visited.ok || visited.stopped) return visited;
                }
                return { ok: true, stopped: false };
              },
            }),
          });
        }
        default: {
          const _ex: never = expression;
          throw new Error(`Unhandled jq path expression: ${JSON.stringify(_ex)}`);
        }
        }
      };

      return visitPathExpression({
        expression: pathExpression,
        pathConsume: ({ path, metadata }) => consume({ value: pathOutput({ path }), metadata }),
      });
    }
    case 'capture':
    case 'match':
    case 'test': {
      if (filter.args.length === 1 && filter.args[0] !== undefined) {
        return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[0]], materializeRemainingArgumentStreams: false });
      }
      if (filter.args.length === 2 && filter.args[0] !== undefined && filter.args[1] !== undefined) {
        // These primitives evaluate flags as the outer stream and patterns inside it.
        return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[1], filter.args[0]], materializeRemainingArgumentStreams: false });
      }
      return visitEvaluated();
    }
    case 'scan': {
      if (filter.args.length === 1 && filter.args[0] !== undefined) {
        return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[0]], materializeRemainingArgumentStreams: false });
      }
      if (filter.args.length === 2 && filter.args[0] !== undefined && filter.args[1] !== undefined) {
        // scan is a jq-level stream primitive: pattern is outer and flags are inner.
        return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[0], filter.args[1]], materializeRemainingArgumentStreams: false });
      }
      return visitEvaluated();
    }
    case 'splits': {
      if (filter.args.length === 1 && filter.args[0] !== undefined) {
        return visitBuiltinArgumentStreams({
          argumentFilters: [filter.args[0]],
          materializeRemainingArgumentStreams: false,
        });
      }
      if (filter.args.length === 2 && filter.args[0] !== undefined && filter.args[1] !== undefined) {
        // Pattern is cancellable between patterns, but flags are atomic for one
        // pattern because all of their matches feed one split cursor.
        return visitBuiltinArgumentStreams({
          argumentFilters: [filter.args[0]],
          materializeRemainingArgumentStreams: true,
        });
      }
      return visitEvaluated();
    }
    case 'split': {
      if (filter.args.length === 1 && filter.args[0] !== undefined) {
        return visitBuiltinArgumentStreams({
          argumentFilters: [filter.args[0]],
          materializeRemainingArgumentStreams: false,
        });
      }
      if (filter.args.length === 2 && filter.args[0] !== undefined && filter.args[1] !== undefined) {
        return visitBuiltinArgumentStreams({
          argumentFilters: [filter.args[0]],
          materializeRemainingArgumentStreams: true,
        });
      }
      return visitEvaluated();
    }
    case 'bsearch':
    case 'contains':
    case 'delpaths':
    case 'flatten':
    case 'endswith':
    case 'format':
    case 'getpath':
    case 'has':
    case 'in':
    case 'index':
    case 'indices':
    case 'inside':
    case 'join':
    case 'ltrimstr':
    case 'rindex':
    case 'rtrimstr':
    case 'strftime':
    case 'strflocaltime':
    case 'strptime':
    case 'startswith': {
      if (filter.args.length !== 1 || filter.args[0] === undefined) return visitEvaluated();
      return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[0]], materializeRemainingArgumentStreams: false });
    }
    case 'atan2':
    case 'copysign':
    case 'fdim':
    case 'fmax':
    case 'fmin':
    case 'fmod':
    case 'hypot':
    case 'ldexp':
    case 'remainder':
    case 'drem':
    case 'nextafter':
    case 'nexttoward':
    case 'scalb':
    case 'scalbln':
    case 'pow': {
      if (filter.args.length !== 2 || filter.args[0] === undefined || filter.args[1] === undefined) {
        return visitEvaluated();
      }
      // jq's binary numeric builtins evaluate the right argument as the outer
      // stream and the left argument inside it. Visiting those argument
      // streams directly lets an outer consumer cancel an unbounded tail
      // without changing the finite right-outer/left-inner cross-product.
      return visitBuiltinArgumentStreams({
        argumentFilters: [filter.args[1], filter.args[0]],
        materializeRemainingArgumentStreams: false,
      });
    }
    case 'paths': {
      if (filter.args.length > 1) return visitEvaluated();
      const predicate = filter.args[0];
      if (predicate !== undefined) {
        // jq evaluates the root predicate for effects even though `paths` never
        // emits the root path. Predicate output is atomic for one node: a late
        // predicate error suppresses that node even if an earlier predicate
        // output was truthy.
        const rootPredicate = evaluateJqFilterWithContext({
          filter: predicate,
          input,
          context: nestedContext,
        });
        if (!rootPredicate.ok) return clearFailureOutputs({ result: rootPredicate });
      }

      let materializedSegmentCount = 0;
      const outputMetadata = metadataWithNumberOrigin({
        metadata: nestedContext.inputState.currentMetadata,
        numberOrigin: undefined,
      });
      for (const entry of iteratePaths({ value: input, current: [] })) {
        const emitPath = (): JqRuntimeOutputVisitResult => {
          materializedSegmentCount += entry.path.length;
          if (materializedSegmentCount > JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
            return runtimeError({
              message: `paths materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
              value: undefined,
            });
          }
          return consume({ value: entry.path, metadata: outputMetadata });
        };
        if (predicate === undefined) {
          const visited = emitPath();
          if (!visited.ok || visited.stopped) return visited;
          continue;
        }
        // Child predicates are themselves streams. A consumer can stop after a
        // truthy predicate output without evaluating a later predicate output;
        // if evaluation continues and later fails, paths emitted by the same
        // node before that failure remain visible.
        const evaluated = visitJqFilterOutputsWithContext({
          filter: predicate,
          input: entry.value,
          context: nestedContext,
          consume: ({ value }) => truthy({ value })
            ? emitPath()
            : { ok: true, stopped: false },
        });
        if (!evaluated.ok || evaluated.stopped) return evaluated;
      }
      return { ok: true, stopped: false };
    }
    case 'JOIN': {
      const indexFilter = filter.args[0];
      if (indexFilter === undefined) return visitEvaluated();
      if (filter.args.length === 2 && filter.args[1] !== undefined) {
        // Each index value produces one collected result for the implicit .[]
        // source, so an outer consumer may stop before a later index value.
        return visitBuiltinArgumentStreams({
          argumentFilters: [indexFilter],
          materializeRemainingArgumentStreams: true,
        });
      }
      const sourceFilter = filter.args[1];
      const keyFilter = filter.args[2];
      if (sourceFilter === undefined || keyFilter === undefined) return visitEvaluated();
      if (filter.args.length === 3) {
        // Index is outer and source is inner. The key filter remains atomic for
        // each source item because all key outputs are part of one JOIN pair.
        return visitBuiltinArgumentStreams({
          argumentFilters: [indexFilter, sourceFilter],
          materializeRemainingArgumentStreams: true,
        });
      }
      const projectionFilter = filter.args[3];
      if (filter.args.length !== 4 || projectionFilter === undefined) return visitEvaluated();

      return visitJqFilterOutputsWithContext({
        filter: indexFilter,
        input,
        context: nestedContext,
        consume: ({ value: indexValue, metadata: indexMetadata }) =>
          visitJqFilterOutputsWithContext({
            filter: sourceFilter,
            input,
            context: nestedContext,
            consume: ({ value: sourceValue, metadata: sourceMetadata }) => {
              const evaluateJoinArgument: JqRuntimeFilterEvaluator = ({
                filter: evaluatedFilter,
                input: evaluatedInput,
                inputMetadata,
              }) => {
                if (evaluatedFilter === indexFilter) {
                  return { ok: true, outputs: [indexValue], outputMetadata: [indexMetadata] };
                }
                if (evaluatedFilter === sourceFilter) {
                  return { ok: true, outputs: [sourceValue], outputMetadata: [sourceMetadata] };
                }
                const evaluationContext = inputMetadata === undefined
                  ? nestedContext
                  : {
                    ...nestedContext,
                    inputState: {
                      ...nestedContext.inputState,
                      currentMetadata: inputMetadata,
                    },
                  };
                return evaluateJqFilterWithContext({
                  filter: evaluatedFilter,
                  input: evaluatedInput,
                  context: evaluationContext,
                });
              };
              const joined = evaluateBuiltinWithEvaluatedArguments({
                name: 'JOIN',
                args: [indexFilter, sourceFilter, keyFilter],
                input,
                evaluate: evaluateJoinArgument,
                takeInputs: ({ maximumValues, eofBehavior }) => takeRuntimeInputs({
                  context: nestedContext,
                  maximumValues,
                  eofBehavior,
                }),
                inputMetadata: sourceMetadata,
                evaluateFirstOutput: evaluateJoinArgument,
                emitStderr: ({ text }) => {
                  context.state.stderr.push(text);
                },
              });
              const pairOutputs = joined.ok ? joined.outputs : failureOutputs({ result: joined });
              for (let pairIndex = 0; pairIndex < pairOutputs.length; pairIndex += 1) {
                const pairMetadata = metadataForResultOutput({
                  result: joined,
                  index: pairIndex,
                  fallback: sourceMetadata,
                });
                const projected = visitJqFilterOutputsWithContext({
                  filter: projectionFilter,
                  input: pairOutputs[pairIndex]!,
                  context: {
                    ...nestedContext,
                    inputState: {
                      ...nestedContext.inputState,
                      currentMetadata: pairMetadata,
                    },
                  },
                  consume,
                });
                if (!projected.ok || projected.stopped) return projected;
              }
              return joined.ok
                ? { ok: true, stopped: false }
                : clearFailureOutputs({ result: joined });
            },
          }),
      });
    }
    case 'setpath': {
      if (filter.args.length !== 2 || filter.args[0] === undefined || filter.args[1] === undefined) {
        return visitEvaluated();
      }
      // jq evaluates replacement values outside path values.
      return visitBuiltinArgumentStreams({
        argumentFilters: [filter.args[1], filter.args[0]],
        materializeRemainingArgumentStreams: false,
      });
    }
    case 'sub':
    case 'gsub': {
      if (filter.args.length === 2 && filter.args[0] !== undefined && filter.args[1] !== undefined) {
        // Pattern is outer; replacement remains a filter evaluated against each capture object.
        return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[0]], materializeRemainingArgumentStreams: false });
      }
      if (
        filter.args.length === 3
        && filter.args[0] !== undefined
        && filter.args[1] !== undefined
        && filter.args[2] !== undefined
      ) {
        // Pattern is outer, flags are next, and replacement remains match-local.
        return visitBuiltinArgumentStreams({ argumentFilters: [filter.args[0], filter.args[2]], materializeRemainingArgumentStreams: false });
      }
      return visitEvaluated();
    }
    case 'fromstream': {
      if (filter.args.length !== 1 || filter.args[0] === undefined) return visitEvaluated();
      let root: JsonValue = null;
      return visitJqFilterOutputsWithContext({
        filter: filter.args[0],
        input,
        context: nestedContext,
        consume: ({ value: streamValue, metadata }) => {
          const parsed = parseJqStreamEvent({ event: streamValue });
          if (!parsed.ok) return runtimeError({ message: parsed.message, value: undefined });
          const { path, value, hasValue } = parsed.event;
          if (hasValue) {
            const streamEventValue = value ?? null;
            if (path.length === 0) {
              root = null;
              return consume({
                value: streamEventValue,
                metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
              });
            }
            const updated = applyJqStreamValue({ root, path, value: streamEventValue });
            if (!updated.ok) return runtimeError({ message: updated.message, value: undefined });
            root = updated.value;
            return { ok: true, stopped: false };
          }
          if (path.length !== 1) return { ok: true, stopped: false };
          const completed = root;
          root = null;
          return consume({
            value: completed,
            metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
          });
        },
      });
    }
    case 'truncate_stream': {
      if (filter.args.length !== 1 || filter.args[0] === undefined) return visitEvaluated();
      return visitJqFilterOutputsWithContext({
        filter: filter.args[0],
        input,
        context: nestedContext,
        consume: ({ value: streamValue, metadata }) => {
          const parsed = parseJqStreamEvent({ event: streamValue });
          if (!parsed.ok) return runtimeError({ message: parsed.message, value: undefined });
          const { path, value, hasValue } = parsed.event;
          if (compareJsonValues({ left: path.length, right: input }) <= 0) {
            return { ok: true, stopped: false };
          }
          const sliced = jqSliceStart({ length: path.length, value: input });
          if (!sliced.ok) return runtimeError({ message: sliced.message, value: undefined });
          const outputPath: JsonValue[] = path.slice(sliced.start);
          return consume({
            value: hasValue ? [outputPath, value ?? null] : [outputPath],
            metadata: metadataWithNumberOrigin({ metadata, numberOrigin: undefined }),
          });
        },
      });
    }
    case 'walk': {
      if (filter.args.length !== 1 || filter.args[0] === undefined) return visitEvaluated();
      const mapper = filter.args[0];

      const visitWalkOutputs = ({
        value,
        metadata,
        nestedConsume,
      }: {
        value: JsonValue,
        metadata: JqRuntimeInputMetadata,
        nestedConsume: JqRuntimeOutputConsumer,
      }): JqRuntimeOutputVisitResult => {
        const visitMapper = ({
          mappedInput,
          mappedMetadata,
        }: {
          mappedInput: JsonValue,
          mappedMetadata: JqRuntimeInputMetadata,
        }): JqRuntimeOutputVisitResult => visitWithMetadata({
          filter: mapper,
          input: mappedInput,
          metadata: mappedMetadata,
          nestedContext,
          nestedConsume,
        });

        if (Array.isArray(value)) {
          const mappedChildren: JsonValue[] = [];
          const visitChild = ({ index }: { index: number }): JqRuntimeOutputVisitResult => {
            const child = value[index];
            if (child === undefined) {
              return visitMapper({ mappedInput: mappedChildren, mappedMetadata: metadata });
            }
            const childMetadata = metadataWithNumberOrigin({
              metadata,
              numberOrigin: typeof child === 'number'
                ? getJsonChildNumberOrigin({ container: value, key: index })
                : undefined,
            });
            const visited = visitWalkOutputs({
              value: child,
              metadata: childMetadata,
              nestedConsume: ({ value: childOutput, metadata: childOutputMetadata }) => {
                if (mappedChildren.length >= JQ_MAX_MATERIALIZED_VALUE_LENGTH) {
                  return runtimeError({
                    message: `walk array materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
                    value: undefined,
                  });
                }
                const targetIndex = mappedChildren.length;
                mappedChildren.push(childOutput);
                if (typeof childOutput === 'number') {
                  setJsonChildNumberOrigin({
                    container: mappedChildren,
                    key: targetIndex,
                    origin: childOutputMetadata.numberOrigin,
                  });
                }
                return { ok: true, stopped: false };
              },
            });
            return !visited.ok || visited.stopped
              ? visited
              : visitChild({ index: index + 1 });
          };
          return visitChild({ index: 0 });
        }

        if (isJsonObject(value)) {
          const entries = jsonObjectEntries({ object: value });
          const mappedObject = createJsonObject();
          const visitEntry = ({ index }: { index: number }): JqRuntimeOutputVisitResult => {
            const entry = entries[index];
            if (entry === undefined) {
              return visitMapper({ mappedInput: mappedObject, mappedMetadata: metadata });
            }
            const [key, child] = entry;
            const childMetadata = metadataWithNumberOrigin({
              metadata,
              numberOrigin: typeof child === 'number'
                ? getJsonChildNumberOrigin({ container: value, key })
                : undefined,
            });
            let firstOutput: { value: JsonValue; metadata: JqRuntimeInputMetadata } | undefined;
            const visited = visitWalkOutputs({
              value: child,
              metadata: childMetadata,
              nestedConsume: ({ value: childOutput, metadata: childOutputMetadata }) => {
                firstOutput = { value: childOutput, metadata: childOutputMetadata };
                return { ok: true, stopped: true };
              },
            });
            if (!visited.ok) return visited;
            if (firstOutput !== undefined) {
              defineJsonProperty({ object: mappedObject, key, value: firstOutput.value });
              if (typeof firstOutput.value === 'number') {
                setJsonChildNumberOrigin({
                  container: mappedObject,
                  key,
                  origin: firstOutput.metadata.numberOrigin,
                });
              }
            }
            return visitEntry({ index: index + 1 });
          };
          return visitEntry({ index: 0 });
        }

        return visitMapper({ mappedInput: value, mappedMetadata: metadata });
      };

      return visitWalkOutputs({
        value: input,
        metadata: nestedContext.inputState.currentMetadata,
        nestedConsume: consume,
      });
    }
    case 'inputs': {
      if (filter.args.length !== 0) return visitEvaluated();
      while (true) {
        const taken = takeRuntimeInputs({
          context: nestedContext,
          maximumValues: 1,
          eofBehavior: 'empty',
        });
        const outputs = taken.ok ? taken.outputs : failureOutputs({ result: taken });
        const fallbackMetadata = nestedContext.inputState.currentMetadata;
        for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
          const visited = consume({
            value: outputs[outputIndex]!,
            metadata: metadataForResultOutput({
              result: taken,
              index: outputIndex,
              fallback: fallbackMetadata,
            }),
          });
          if (!visited.ok || visited.stopped) return visited;
        }
        if (!taken.ok) return clearFailureOutputs({ result: taken });
        if (outputs.length === 0) return { ok: true, stopped: false };
      }
    }
    case 'select': {
      if (filter.args.length !== 1 || filter.args[0] === undefined) return visitEvaluated();
      return visitJqFilterOutputsWithContext({
        filter: filter.args[0],
        input,
        context: nestedContext,
        consume: ({ value, metadata }) => truthy({ value })
          ? consume({
            value: input,
            metadata: metadataWithNumberOrigin({
              metadata,
              numberOrigin: context.inputState.currentMetadata.numberOrigin,
            }),
          })
          : { ok: true, stopped: false },
      });
    }
    case 'range': {
      if (filter.args.length === 0 || filter.args.length > 3) return visitEvaluated();
      const visitArgument = ({
        argumentIndex,
        values,
        metadata,
        startNumberOrigin,
      }: {
        argumentIndex: number,
        values: readonly JsonValue[],
        metadata: JqRuntimeInputMetadata,
        startNumberOrigin: JqNumberOrigin | undefined,
      }): JqRuntimeOutputVisitResult => {
        if (argumentIndex >= filter.args.length) {
          const numericArgs: number[] = [];
          for (const value of values) {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              return runtimeError({ message: 'range arguments must be finite numbers', value: undefined });
            }
            numericArgs.push(value);
          }
          const [start, end, step] = (() => {
            switch (numericArgs.length) {
            case 1: return [0, numericArgs[0]!, 1] as const;
            case 2: return [numericArgs[0]!, numericArgs[1]!, 1] as const;
            case 3: return [numericArgs[0]!, numericArgs[1]!, numericArgs[2]!] as const;
            default: {
              const _ex: never = numericArgs.length as never;
              throw new Error(`Unhandled range arity: ${_ex}`);
            }
            }
          })();
          if (step === 0) return { ok: true, stopped: false };
          const outputMetadata = metadataWithNumberOrigin({ metadata, numberOrigin: undefined });
          let generatedCount = 0;
          const emitRangeValue = ({ value }: { value: number }): JqRuntimeOutputVisitResult => {
            generatedCount += 1;
            if (generatedCount > context.limits.maxOutputs) {
              return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
            }
            return consume({
              value,
              metadata: metadataWithNumberOrigin({
                metadata: outputMetadata,
                numberOrigin: generatedCount === 1 ? startNumberOrigin : undefined,
              }),
            });
          };
          if (step > 0) {
            for (let value = start; value < end; value += step) {
              const visited = emitRangeValue({ value });
              if (!visited.ok || visited.stopped) return visited;
            }
          } else {
            for (let value = start; value > end; value += step) {
              const visited = emitRangeValue({ value });
              if (!visited.ok || visited.stopped) return visited;
            }
          }
          return { ok: true, stopped: false };
        }
        const argument = filter.args[argumentIndex];
        if (argument === undefined) throw new Error(`Missing jq range argument ${argumentIndex}`);
        return visitWithMetadata({
          filter: argument,
          input,
          metadata,
          nestedContext,
          nestedConsume: ({ value, metadata: argumentMetadata }) => visitArgument({
            argumentIndex: argumentIndex + 1,
            values: [...values, value],
            metadata: argumentMetadata,
            startNumberOrigin: argumentIndex === 0 && filter.args.length >= 2
              ? argumentMetadata.numberOrigin
              : startNumberOrigin,
          }),
        });
      };
      return visitArgument({
        argumentIndex: 0,
        values: [],
        metadata: context.inputState.currentMetadata,
        startNumberOrigin: undefined,
      });
    }
    case 'repeat': {
      if (filter.args.length !== 1 || filter.args[0] === undefined) {
        return runtimeError({ message: 'repeat takes exactly one argument', value: undefined });
      }
      while (true) {
        const repeated = visitJqFilterOutputsWithContext({
          filter: filter.args[0],
          input,
          context: nestedContext,
          consume,
        });
        if (!repeated.ok || repeated.stopped) return repeated;
        const iterationLimit = checkLimits({ context: nestedContext });
        if (!iterationLimit.ok) return iterationLimit;
      }
    }
    case 'while':
    case 'until': {
      if (filter.args.length !== 2 || filter.args[0] === undefined || filter.args[1] === undefined) {
        return runtimeError({ message: `${filter.name} takes exactly two arguments`, value: undefined });
      }
      const conditionFilter = filter.args[0];
      const updateFilter = filter.args[1];
      const isWhile = (() => {
        switch (filter.name) {
        case 'while': return true;
        case 'until': return false;
        default: {
          const _ex: never = filter.name;
          throw new Error(`Unhandled jq iterative builtin: ${_ex}`);
        }
        }
      })();
      if (jqFilterYieldsAtMostOneOutput({ filter: conditionFilter })
        && jqFilterYieldsAtMostOneOutput({ filter: updateFilter })) {
        let stateInput = input;
        let stateMetadata = context.inputState.currentMetadata;
        while (true) {
          const iterationLimit = checkLimits({ context: nestedContext });
          if (!iterationLimit.ok) return iterationLimit;
          const condition = evaluateWithMetadata({
            filter: conditionFilter,
            input: stateInput,
            metadata: stateMetadata,
            nestedContext,
          });
          if (!condition.ok) return condition;
          const conditionValue = condition.outputs[0];
          if (conditionValue === undefined) return { ok: true, stopped: false };
          const conditionMetadata = metadataForResultOutput({
            result: condition,
            index: 0,
            fallback: stateMetadata,
          });
          const conditionIsTruthy = truthy({ value: conditionValue });
          const shouldAdvance = isWhile ? conditionIsTruthy : !conditionIsTruthy;
          if (shouldAdvance && isWhile) {
            const emitted = consume({ value: stateInput, metadata: stateMetadata });
            if (!emitted.ok || emitted.stopped) return emitted;
          }
          if (!shouldAdvance) {
            if (!isWhile) {
              const emitted = consume({ value: stateInput, metadata: stateMetadata });
              if (!emitted.ok || emitted.stopped) return emitted;
            }
            return { ok: true, stopped: false };
          }
          const updated = evaluateWithMetadata({
            filter: updateFilter,
            input: stateInput,
            metadata: conditionMetadata,
            nestedContext,
          });
          if (!updated.ok) return updated;
          const nextInput = updated.outputs[0];
          if (nextInput === undefined) return { ok: true, stopped: false };
          stateInput = nextInput;
          stateMetadata = metadataForResultOutput({
            result: updated,
            index: 0,
            fallback: conditionMetadata,
          });
        }
      }
      const conditionPlan = jqIterativeConditionCommaBranchPlan({ filter: conditionFilter });
      const conditionBindPlan = jqIterativeConditionBindPlan({ filter: conditionFilter });
      const updatePlan = jqIterativeCommaBranchPlan({ filter: updateFilter });
      const iterativeRangeUpdatePlan = jqIterativeRangePlan({ filter: updateFilter });
      const updateBindPlan = jqIterativeBindBodyPlan({ filter: updateFilter });
      if (
        (conditionPlan !== undefined || conditionBindPlan !== undefined)
        && (
          updatePlan !== undefined
          || iterativeRangeUpdatePlan !== undefined
          || updateBindPlan !== undefined
        )
      ) {
        const conditionBranches = conditionPlan?.branches ?? [];
        const updateBranches = updatePlan?.branches ?? [];
        type IterativeTask =
          | {
            readonly kind: 'state',
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'condition_branch',
            readonly branch: JqFilter,
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'condition_bind',
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
          }
          | {
            readonly kind: 'condition_bound_branch',
            readonly branch: JqFilter,
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
            readonly boundValue: JsonValue,
            readonly boundMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'condition_output',
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
            readonly conditionValue: JsonValue,
            readonly conditionMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'update_branch',
            readonly branch: JqFilter,
            readonly stateInput: JsonValue,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly updateGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'update_bind',
            readonly stateInput: JsonValue,
            readonly metadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly updateGroup: number,
          }
          | {
            readonly kind: 'update_bound_branch',
            readonly branch: JqFilter,
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
            readonly boundValue: JsonValue,
            readonly boundMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly updateGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'update_range_argument',
            readonly argumentIndex: number,
            readonly branchIndex: number,
            readonly numericArgs: readonly number[],
            readonly stateInput: JsonValue,
            readonly metadata: JqRuntimeInputMetadata,
            readonly startNumberOrigin: JqNumberOrigin | undefined,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'update_range',
            readonly value: number,
            readonly end: number,
            readonly step: number,
            readonly generatedCount: number,
            readonly outputMetadata: JqRuntimeInputMetadata,
            readonly startNumberOrigin: JqNumberOrigin | undefined,
          }
          | {
            readonly kind: 'finish_condition',
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
          }
          | {
            readonly kind: 'finish_update',
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly updateGroup: number,
          }
          | {
            readonly kind: 'failure',
            readonly result: Extract<JqRuntimeResult, { readonly ok: false }>,
            readonly restoreIndex?: number,
            readonly restoreMetadata?: JqRuntimeInputMetadata,
          };
        let nextConditionGroup = 0;
        let nextUpdateGroup = 0;
        const tasks: IterativeTask[] = [{
          kind: 'state',
          stateInput: input,
          stateMetadata: context.inputState.currentMetadata,
        }];
        while (tasks.length > 0) {
          const task = tasks.pop();
          if (task === undefined) break;
          switch (task.kind) {
          case 'state': {
            const iterationLimit = checkLimits({ context: nestedContext });
            if (!iterationLimit.ok) return iterationLimit;
            const restoreIndex = nestedContext.inputState.index;
            const restoreMetadata = nestedContext.inputState.currentMetadata;
            const conditionGroup = nextConditionGroup;
            nextConditionGroup += 1;
            nestedContext.inputState.currentMetadata = task.stateMetadata;
            tasks.push({ kind: 'finish_condition', restoreIndex, restoreMetadata, conditionGroup });
            if (conditionBindPlan !== undefined) {
              tasks.push({
                kind: 'condition_bind',
                stateInput: task.stateInput,
                stateMetadata: task.stateMetadata,
                restoreIndex,
                restoreMetadata,
                conditionGroup,
              });
              break;
            }
            if (conditionPlan === undefined) throw new Error('Missing jq while/until condition plan');
            for (let branchIndex = conditionBranches.length - 1; branchIndex >= 0; branchIndex -= 1) {
              tasks.push({
                kind: 'condition_branch',
                branch: conditionBranches[branchIndex]!,
                stateInput: task.stateInput,
                stateMetadata: task.stateMetadata,
                restoreIndex,
                restoreMetadata,
                conditionGroup,
                suppressFailure: conditionPlan.suppressFailure,
                suppressBreakLabelId: conditionPlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'condition_bind': {
            if (conditionBindPlan === undefined) throw new Error('Missing jq iterative bind condition plan');
            const binding = evaluateWithMetadata({
              filter: conditionBindPlan.binding,
              input: task.stateInput,
              metadata: task.stateMetadata,
              nestedContext,
            });
            const outputs = binding.ok ? binding.outputs : failureOutputs({ result: binding });
            if (outputs.length > 1) {
              return runtimeError({ message: 'jq bind single-output proof was violated', value: undefined });
            }
            if (!binding.ok && !jqIterativePlanSuppressesFailure({
              suppressFailure: conditionBindPlan.suppressBindingFailure,
              suppressBreakLabelId: conditionBindPlan.suppressBindingBreakLabelId,
              result: binding,
            })) {
              tasks.push({
                kind: 'failure',
                result: clearFailureOutputs({ result: binding }),
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
            }
            const boundValue = outputs[0];
            if (boundValue === undefined) break;
            const boundMetadata = metadataForResultOutput({
              result: binding,
              index: 0,
              fallback: task.stateMetadata,
            });
            for (let index = conditionBindPlan.bodyPlan.branches.length - 1; index >= 0; index -= 1) {
              tasks.push({
                kind: 'condition_bound_branch',
                branch: conditionBindPlan.bodyPlan.branches[index]!,
                stateInput: task.stateInput,
                stateMetadata: task.stateMetadata,
                boundValue,
                boundMetadata,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
                conditionGroup: task.conditionGroup,
                suppressFailure: conditionBindPlan.bodyPlan.suppressFailure,
                suppressBreakLabelId: conditionBindPlan.bodyPlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'condition_bound_branch': {
            if (conditionBindPlan === undefined) throw new Error('Missing jq iterative bind condition plan');
            const condition = evaluateWithMetadata({
              filter: task.branch,
              input: task.stateInput,
              metadata: task.stateMetadata,
              nestedContext: contextWithBoundValue({
                nestedContext,
                name: conditionBindPlan.name,
                value: task.boundValue,
                metadata: task.boundMetadata,
              }),
            });
            const outputs = condition.ok ? condition.outputs : failureOutputs({ result: condition });
            if (!condition.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: condition,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'condition_bound_branch'
                    || sibling.conditionGroup !== task.conditionGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: condition }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              tasks.push({
                kind: 'condition_output',
                stateInput: task.stateInput,
                stateMetadata: task.stateMetadata,
                conditionValue: outputs[outputIndex]!,
                conditionMetadata: metadataForResultOutput({
                  result: condition,
                  index: outputIndex,
                  fallback: task.stateMetadata,
                }),
              });
            }
            break;
          }
          case 'condition_branch': {
            const fallbackMetadata = nestedContext.inputState.currentMetadata;
            const condition = evaluateJqFilterWithContext({
              filter: task.branch,
              input: task.stateInput,
              context: nestedContext,
            });
            const outputs = condition.ok ? condition.outputs : failureOutputs({ result: condition });
            if (!condition.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: condition,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'condition_branch'
                    || sibling.conditionGroup !== task.conditionGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: condition }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              tasks.push({
                kind: 'condition_output',
                stateInput: task.stateInput,
                stateMetadata: task.stateMetadata,
                conditionValue: outputs[outputIndex]!,
                conditionMetadata: metadataForResultOutput({
                  result: condition,
                  index: outputIndex,
                  fallback: fallbackMetadata,
                }),
              });
            }
            break;
          }
          case 'condition_output': {
            const conditionIsTruthy = truthy({ value: task.conditionValue });
            const shouldAdvance = isWhile ? conditionIsTruthy : !conditionIsTruthy;
            if (shouldAdvance && isWhile) {
              const emitted = consume({ value: task.stateInput, metadata: task.stateMetadata });
              if (!emitted.ok || emitted.stopped) return emitted;
            }
            if (!shouldAdvance) {
              if (!isWhile) {
                const emitted = consume({ value: task.stateInput, metadata: task.stateMetadata });
                if (!emitted.ok || emitted.stopped) return emitted;
              }
              break;
            }
            const restoreIndex = nestedContext.inputState.index;
            const restoreMetadata = nestedContext.inputState.currentMetadata;
            const updateGroup = nextUpdateGroup;
            nextUpdateGroup += 1;
            nestedContext.inputState.currentMetadata = task.conditionMetadata;
            tasks.push({ kind: 'finish_update', restoreIndex, restoreMetadata, updateGroup });
            if (iterativeRangeUpdatePlan !== undefined) {
              tasks.push({
                kind: 'update_range_argument',
                argumentIndex: 0,
                branchIndex: 0,
                numericArgs: [],
                stateInput: task.stateInput,
                metadata: task.conditionMetadata,
                startNumberOrigin: undefined,
                restoreIndex,
                restoreMetadata,
              });
              break;
            }
            if (updateBindPlan !== undefined) {
              tasks.push({
                kind: 'update_bind',
                stateInput: task.stateInput,
                metadata: task.conditionMetadata,
                restoreIndex,
                restoreMetadata,
                updateGroup,
              });
              break;
            }
            if (updatePlan === undefined) throw new Error('Missing jq while/until update plan');
            for (let index = updateBranches.length - 1; index >= 0; index -= 1) {
              tasks.push({
                kind: 'update_branch',
                branch: updateBranches[index]!,
                stateInput: task.stateInput,
                restoreIndex,
                restoreMetadata,
                updateGroup,
                suppressFailure: updatePlan.suppressFailure,
                suppressBreakLabelId: updatePlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'update_bind': {
            if (updateBindPlan === undefined) throw new Error('Missing jq iterative bind update plan');
            const binding = evaluateWithMetadata({
              filter: updateBindPlan.binding,
              input: task.stateInput,
              metadata: task.metadata,
              nestedContext,
            });
            const outputs = binding.ok ? binding.outputs : failureOutputs({ result: binding });
            if (outputs.length > 1) {
              return runtimeError({ message: 'jq bind single-output proof was violated', value: undefined });
            }
            if (!binding.ok) {
              tasks.push({
                kind: 'failure',
                result: clearFailureOutputs({ result: binding }),
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
            }
            const boundValue = outputs[0];
            if (boundValue === undefined) break;
            const boundMetadata = metadataForResultOutput({
              result: binding,
              index: 0,
              fallback: task.metadata,
            });
            for (let index = updateBindPlan.bodyPlan.branches.length - 1; index >= 0; index -= 1) {
              tasks.push({
                kind: 'update_bound_branch',
                branch: updateBindPlan.bodyPlan.branches[index]!,
                stateInput: task.stateInput,
                stateMetadata: task.metadata,
                boundValue,
                boundMetadata,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
                updateGroup: task.updateGroup,
                suppressFailure: updateBindPlan.bodyPlan.suppressFailure,
                suppressBreakLabelId: updateBindPlan.bodyPlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'update_bound_branch': {
            if (updateBindPlan === undefined) throw new Error('Missing jq iterative bind update plan');
            const updated = evaluateWithMetadata({
              filter: task.branch,
              input: task.stateInput,
              metadata: task.stateMetadata,
              nestedContext: contextWithBoundValue({
                nestedContext,
                name: updateBindPlan.name,
                value: task.boundValue,
                metadata: task.boundMetadata,
              }),
            });
            const outputs = updated.ok ? updated.outputs : failureOutputs({ result: updated });
            if (!updated.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: updated,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'update_bound_branch'
                    || sibling.updateGroup !== task.updateGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: updated }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              tasks.push({
                kind: 'state',
                stateInput: outputs[outputIndex]!,
                stateMetadata: metadataForResultOutput({
                  result: updated,
                  index: outputIndex,
                  fallback: task.boundMetadata,
                }),
              });
            }
            break;
          }
          case 'update_range_argument': {
            if (iterativeRangeUpdatePlan === undefined) throw new Error('Missing jq iterative range update plan');
            const branches = iterativeRangeUpdatePlan.argumentBranches[task.argumentIndex];
            const branch = branches?.[task.branchIndex];
            if (branches === undefined || branch === undefined) {
              throw new Error(`Missing jq iterative range update argument ${task.argumentIndex}:${task.branchIndex}`);
            }
            const evaluated = evaluateSingleOutputRangeArgument({
              argument: branch,
              input: task.stateInput,
              metadata: task.metadata,
              nestedContext,
            });
            if (!evaluated.ok) {
              tasks.push({
                kind: 'failure',
                result: evaluated.result,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
              break;
            }
            if (task.branchIndex + 1 < branches.length) {
              tasks.push({ ...task, branchIndex: task.branchIndex + 1 });
            }
            if (evaluated.output === undefined) break;
            const numericArgs = [...task.numericArgs, evaluated.output.value];
            const startNumberOrigin = task.argumentIndex === 0
              && iterativeRangeUpdatePlan.filter.args.length >= 2
              ? evaluated.output.metadata.numberOrigin
              : task.startNumberOrigin;
            const nextArgumentIndex = task.argumentIndex + 1;
            if (nextArgumentIndex < iterativeRangeUpdatePlan.argumentBranches.length) {
              tasks.push({
                ...task,
                argumentIndex: nextArgumentIndex,
                branchIndex: 0,
                numericArgs,
                metadata: evaluated.output.metadata,
                startNumberOrigin,
              });
              break;
            }
            const range = jqIterativeRangeFromNumericArguments({ numericArgs });
            if (jqIterativeRangeHasValue({ value: range.start, end: range.end, step: range.step })) {
              tasks.push({
                kind: 'update_range',
                value: range.start,
                end: range.end,
                step: range.step,
                generatedCount: 0,
                outputMetadata: metadataWithNumberOrigin({
                  metadata: evaluated.output.metadata,
                  numberOrigin: undefined,
                }),
                startNumberOrigin,
              });
            }
            break;
          }
          case 'update_range': {
            if (task.generatedCount >= nestedContext.limits.maxOutputs) {
              return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
            }
            const nextValue = task.value + task.step;
            if (jqIterativeRangeHasValue({ value: nextValue, end: task.end, step: task.step })) {
              tasks.push({ ...task, value: nextValue, generatedCount: task.generatedCount + 1 });
            }
            tasks.push({
              kind: 'state',
              stateInput: task.value,
              stateMetadata: metadataWithNumberOrigin({
                metadata: task.outputMetadata,
                numberOrigin: task.generatedCount === 0 ? task.startNumberOrigin : undefined,
              }),
            });
            break;
          }
          case 'update_branch': {
            const fallbackMetadata = nestedContext.inputState.currentMetadata;
            const updated = evaluateJqFilterWithContext({
              filter: task.branch,
              input: task.stateInput,
              context: nestedContext,
            });
            const outputs = updated.ok ? updated.outputs : failureOutputs({ result: updated });
            if (!updated.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: updated,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'update_branch'
                    || sibling.updateGroup !== task.updateGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: updated }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              tasks.push({
                kind: 'state',
                stateInput: outputs[outputIndex]!,
                stateMetadata: metadataForResultOutput({
                  result: updated,
                  index: outputIndex,
                  fallback: fallbackMetadata,
                }),
              });
            }
            break;
          }
          case 'finish_condition':
            if (nestedContext.inputState.index === task.restoreIndex) {
              nestedContext.inputState.currentMetadata = task.restoreMetadata;
            }
            break;
          case 'finish_update':
            if (nestedContext.inputState.index === task.restoreIndex) {
              nestedContext.inputState.currentMetadata = task.restoreMetadata;
            }
            break;
          case 'failure':
            if (
              task.restoreIndex !== undefined
              && task.restoreMetadata !== undefined
              && nestedContext.inputState.index === task.restoreIndex
            ) {
              nestedContext.inputState.currentMetadata = task.restoreMetadata;
            }
            return task.result;
          default: {
            const _ex: never = task;
            throw new Error(`Unhandled jq while/until task: ${String(_ex)}`);
          }
          }
        }
        return { ok: true, stopped: false };
      }

      const visitState = ({
        stateInput,
        stateMetadata,
        stateContext,
      }: {
        stateInput: JsonValue,
        stateMetadata: JqRuntimeInputMetadata,
        stateContext: JqRuntimeContext,
      }): JqRuntimeOutputVisitResult => {
        const condition = evaluateWithMetadata({
          filter: conditionFilter,
          input: stateInput,
          metadata: stateMetadata,
          nestedContext: stateContext,
        });
        const conditionOutputs = condition.ok
          ? condition.outputs
          : failureOutputs({ result: condition });
        for (let outputIndex = 0; outputIndex < conditionOutputs.length; outputIndex += 1) {
          const conditionMetadata = metadataForResultOutput({
            result: condition,
            index: outputIndex,
            fallback: stateMetadata,
          });
          const conditionIsTruthy = truthy({ value: conditionOutputs[outputIndex]! });
          const shouldAdvance = isWhile ? conditionIsTruthy : !conditionIsTruthy;
          if (shouldAdvance && isWhile) {
            const emitted = consume({ value: stateInput, metadata: stateMetadata });
            if (!emitted.ok || emitted.stopped) return emitted;
          }
          if (shouldAdvance) {
            const advanced = visitWithMetadata({
              filter: updateFilter,
              input: stateInput,
              metadata: conditionMetadata,
              nestedContext: stateContext,
              nestedConsume: ({ value, metadata }) => visitState({
                stateInput: value,
                stateMetadata: metadata,
                stateContext,
              }),
            });
            if (!advanced.ok || advanced.stopped) return advanced;
          } else if (!isWhile) {
            const emitted = consume({ value: stateInput, metadata: stateMetadata });
            if (!emitted.ok || emitted.stopped) return emitted;
          }
        }
        return condition.ok
          ? { ok: true, stopped: false }
          : clearFailureOutputs({ result: condition });
      };
      return visitState({
        stateInput: input,
        stateMetadata: context.inputState.currentMetadata,
        stateContext: nestedContext,
      });
    }
    case 'recurse': {
      if (filter.args.length > 2) {
        return runtimeError({ message: 'recurse takes at most two arguments', value: undefined });
      }
      const nextFilter = filter.args[0];
      const conditionFilter = filter.args[1];
      if (nextFilter === undefined) {
        const stack: { readonly value: JsonValue, readonly metadata: JqRuntimeInputMetadata }[] = [{
          value: input,
          metadata: context.inputState.currentMetadata,
        }];
        while (stack.length > 0) {
          const current = stack.pop()!;
          const emitted = consume({ value: current.value, metadata: current.metadata });
          if (!emitted.ok || emitted.stopped) return emitted;
          const children = Array.isArray(current.value)
            ? current.value
            : isJsonObject(current.value)
              ? jsonObjectValues({ object: current.value })
              : [];
          for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
            stack.push({ value: children[childIndex]!, metadata: current.metadata });
          }
        }
        return { ok: true, stopped: false };
      }
      if (jqIterativeBranchYieldsAtMostOneOutput({ filter: nextFilter })
        && (conditionFilter === undefined
          || jqIterativeBranchYieldsAtMostOneOutput({ filter: conditionFilter }))) {
        let stateInput = input;
        let stateMetadata = context.inputState.currentMetadata;
        while (true) {
          const iterationLimit = checkLimits({ context: nestedContext });
          if (!iterationLimit.ok) return iterationLimit;
          const emitted = consume({ value: stateInput, metadata: stateMetadata });
          if (!emitted.ok || emitted.stopped) return emitted;
          const advanced = evaluateWithMetadata({
            filter: nextFilter,
            input: stateInput,
            metadata: stateMetadata,
            nestedContext,
          });
          if (!advanced.ok) return advanced;
          const nextInput = advanced.outputs[0];
          if (nextInput === undefined) return { ok: true, stopped: false };
          const nextMetadata = metadataForResultOutput({
            result: advanced,
            index: 0,
            fallback: stateMetadata,
          });
          if (conditionFilter !== undefined) {
            const condition = evaluateWithMetadata({
              filter: conditionFilter,
              input: nextInput,
              metadata: nextMetadata,
              nestedContext,
            });
            if (!condition.ok) return condition;
            if (!condition.outputs.some((candidate) => truthy({ value: candidate }))) {
              return { ok: true, stopped: false };
            }
          }
          stateInput = nextInput;
          stateMetadata = nextMetadata;
        }
      }
      const nextPlan = jqIterativeCommaBranchPlan({ filter: nextFilter });
      const iterativeRangeNextPlan = conditionFilter === undefined
        ? jqIterativeRangePlan({ filter: nextFilter })
        : undefined;
      const nextBindPlan = jqIterativeBindBodyPlan({ filter: nextFilter });
      const conditionPlan = conditionFilter === undefined
        ? undefined
        : jqIterativeConditionCommaBranchPlan({ filter: conditionFilter });
      const conditionBindPlan = conditionFilter === undefined
        ? undefined
        : jqIterativeConditionBindPlan({ filter: conditionFilter });
      const iterativeRangeConditionPlan = conditionFilter === undefined
        ? undefined
        : jqIterativeRangePlan({ filter: conditionFilter });
      if (
        (
          nextPlan !== undefined
          || iterativeRangeNextPlan !== undefined
          || nextBindPlan !== undefined
        )
        && (
          conditionFilter === undefined
          || conditionPlan !== undefined
          || conditionBindPlan !== undefined
          || iterativeRangeConditionPlan !== undefined
        )
      ) {
        type RecurseTask =
          | {
            readonly kind: 'state',
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'next_branch',
            readonly branch: JqFilter,
            readonly stateInput: JsonValue,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly nextGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'next_bind',
            readonly stateInput: JsonValue,
            readonly metadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly nextGroup: number,
          }
          | {
            readonly kind: 'next_bound_branch',
            readonly branch: JqFilter,
            readonly stateInput: JsonValue,
            readonly stateMetadata: JqRuntimeInputMetadata,
            readonly boundValue: JsonValue,
            readonly boundMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly nextGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'next_range_argument',
            readonly argumentIndex: number,
            readonly branchIndex: number,
            readonly numericArgs: readonly number[],
            readonly stateInput: JsonValue,
            readonly metadata: JqRuntimeInputMetadata,
            readonly startNumberOrigin: JqNumberOrigin | undefined,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'next_range',
            readonly value: number,
            readonly end: number,
            readonly step: number,
            readonly generatedCount: number,
            readonly outputMetadata: JqRuntimeInputMetadata,
            readonly startNumberOrigin: JqNumberOrigin | undefined,
          }
          | {
            readonly kind: 'condition_bind',
            readonly nextInput: JsonValue,
            readonly nextMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
          }
          | {
            readonly kind: 'condition_bound_branch',
            readonly branch: JqFilter,
            readonly nextInput: JsonValue,
            readonly nextMetadata: JqRuntimeInputMetadata,
            readonly boundValue: JsonValue,
            readonly boundMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'condition_branch',
            readonly branch: JqFilter,
            readonly nextInput: JsonValue,
            readonly nextMetadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
            readonly suppressFailure: boolean,
            readonly suppressBreakLabelId: number | undefined,
          }
          | {
            readonly kind: 'condition_range_argument',
            readonly argumentIndex: number,
            readonly branchIndex: number,
            readonly numericArgs: readonly number[],
            readonly nextInput: JsonValue,
            readonly nextMetadata: JqRuntimeInputMetadata,
            readonly metadata: JqRuntimeInputMetadata,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'condition_range',
            readonly nextInput: JsonValue,
            readonly nextMetadata: JqRuntimeInputMetadata,
            readonly value: number,
            readonly end: number,
            readonly step: number,
            readonly generatedCount: number,
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
          }
          | {
            readonly kind: 'finish_condition',
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly conditionGroup: number,
          }
          | {
            readonly kind: 'finish_next',
            readonly restoreIndex: number,
            readonly restoreMetadata: JqRuntimeInputMetadata,
            readonly nextGroup: number,
          }
          | {
            readonly kind: 'failure',
            readonly result: Extract<JqRuntimeResult, { readonly ok: false }>,
            readonly restoreIndex?: number,
            readonly restoreMetadata?: JqRuntimeInputMetadata,
          };
        let nextGroupId = 0;
        let conditionGroupId = 0;
        const tasks: RecurseTask[] = [{
          kind: 'state',
          stateInput: input,
          stateMetadata: context.inputState.currentMetadata,
        }];
        while (tasks.length > 0) {
          const task = tasks.pop();
          if (task === undefined) break;
          switch (task.kind) {
          case 'state': {
            const iterationLimit = checkLimits({ context: nestedContext });
            if (!iterationLimit.ok) return iterationLimit;
            const emitted = consume({ value: task.stateInput, metadata: task.stateMetadata });
            if (!emitted.ok || emitted.stopped) return emitted;
            const restoreIndex = nestedContext.inputState.index;
            const restoreMetadata = nestedContext.inputState.currentMetadata;
            const nextGroup = nextGroupId;
            nextGroupId += 1;
            nestedContext.inputState.currentMetadata = task.stateMetadata;
            tasks.push({ kind: 'finish_next', restoreIndex, restoreMetadata, nextGroup });
            if (iterativeRangeNextPlan !== undefined) {
              tasks.push({
                kind: 'next_range_argument',
                argumentIndex: 0,
                branchIndex: 0,
                numericArgs: [],
                stateInput: task.stateInput,
                metadata: task.stateMetadata,
                startNumberOrigin: undefined,
                restoreIndex,
                restoreMetadata,
              });
              break;
            }
            if (nextBindPlan !== undefined) {
              tasks.push({
                kind: 'next_bind',
                stateInput: task.stateInput,
                metadata: task.stateMetadata,
                restoreIndex,
                restoreMetadata,
                nextGroup,
              });
              break;
            }
            if (nextPlan === undefined) throw new Error('Missing jq recurse next plan');
            for (let branchIndex = nextPlan.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
              tasks.push({
                kind: 'next_branch',
                branch: nextPlan.branches[branchIndex]!,
                stateInput: task.stateInput,
                restoreIndex,
                restoreMetadata,
                nextGroup,
                suppressFailure: nextPlan.suppressFailure,
                suppressBreakLabelId: nextPlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'next_bind': {
            if (nextBindPlan === undefined) throw new Error('Missing jq iterative bind next plan');
            const binding = evaluateWithMetadata({
              filter: nextBindPlan.binding,
              input: task.stateInput,
              metadata: task.metadata,
              nestedContext,
            });
            const outputs = binding.ok ? binding.outputs : failureOutputs({ result: binding });
            if (outputs.length > 1) {
              return runtimeError({ message: 'jq bind single-output proof was violated', value: undefined });
            }
            if (!binding.ok) {
              tasks.push({
                kind: 'failure',
                result: clearFailureOutputs({ result: binding }),
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
            }
            const boundValue = outputs[0];
            if (boundValue === undefined) break;
            const boundMetadata = metadataForResultOutput({
              result: binding,
              index: 0,
              fallback: task.metadata,
            });
            for (let index = nextBindPlan.bodyPlan.branches.length - 1; index >= 0; index -= 1) {
              tasks.push({
                kind: 'next_bound_branch',
                branch: nextBindPlan.bodyPlan.branches[index]!,
                stateInput: task.stateInput,
                stateMetadata: task.metadata,
                boundValue,
                boundMetadata,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
                nextGroup: task.nextGroup,
                suppressFailure: nextBindPlan.bodyPlan.suppressFailure,
                suppressBreakLabelId: nextBindPlan.bodyPlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'next_bound_branch': {
            if (nextBindPlan === undefined) throw new Error('Missing jq iterative bind next plan');
            const advanced = evaluateWithMetadata({
              filter: task.branch,
              input: task.stateInput,
              metadata: task.stateMetadata,
              nestedContext: contextWithBoundValue({
                nestedContext,
                name: nextBindPlan.name,
                value: task.boundValue,
                metadata: task.boundMetadata,
              }),
            });
            const outputs = advanced.ok ? advanced.outputs : failureOutputs({ result: advanced });
            if (!advanced.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: advanced,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'next_bound_branch'
                    || sibling.nextGroup !== task.nextGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: advanced }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              const value = outputs[outputIndex]!;
              const metadata = metadataForResultOutput({
                result: advanced,
                index: outputIndex,
                fallback: task.stateMetadata,
              });
              if (conditionFilter === undefined) {
                tasks.push({ kind: 'state', stateInput: value, stateMetadata: metadata });
                continue;
              }
              const restoreIndex = nestedContext.inputState.index;
              const restoreMetadata = nestedContext.inputState.currentMetadata;
              const conditionGroup = conditionGroupId;
              conditionGroupId += 1;
              nestedContext.inputState.currentMetadata = metadata;
              tasks.push({ kind: 'finish_condition', restoreIndex, restoreMetadata, conditionGroup });
              if (iterativeRangeConditionPlan !== undefined) {
                tasks.push({
                  kind: 'condition_range_argument',
                  argumentIndex: 0,
                  branchIndex: 0,
                  numericArgs: [],
                  nextInput: value,
                  nextMetadata: metadata,
                  metadata,
                  restoreIndex,
                  restoreMetadata,
                });
                continue;
              }
              if (conditionBindPlan !== undefined) {
                tasks.push({
                  kind: 'condition_bind',
                  nextInput: value,
                  nextMetadata: metadata,
                  restoreIndex,
                  restoreMetadata,
                  conditionGroup,
                });
                continue;
              }
              if (conditionBindPlan !== undefined) {
                tasks.push({
                  kind: 'condition_bind',
                  nextInput: value,
                  nextMetadata: metadata,
                  restoreIndex,
                  restoreMetadata,
                  conditionGroup,
                });
                continue;
              }
              if (conditionPlan === undefined) {
                throw new Error('Missing jq recurse condition plan');
              }
              for (let branchIndex = conditionPlan.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
                tasks.push({
                  kind: 'condition_branch',
                  branch: conditionPlan.branches[branchIndex]!,
                  nextInput: value,
                  nextMetadata: metadata,
                  restoreIndex,
                  restoreMetadata,
                  conditionGroup,
                  suppressFailure: conditionPlan.suppressFailure,
                  suppressBreakLabelId: conditionPlan.suppressBreakLabelId,
                });
              }
            }
            break;
          }
          case 'next_range_argument': {
            if (iterativeRangeNextPlan === undefined) throw new Error('Missing jq iterative range next plan');
            const branches = iterativeRangeNextPlan.argumentBranches[task.argumentIndex];
            const branch = branches?.[task.branchIndex];
            if (branches === undefined || branch === undefined) {
              throw new Error(`Missing jq iterative range next argument ${task.argumentIndex}:${task.branchIndex}`);
            }
            const evaluated = evaluateSingleOutputRangeArgument({
              argument: branch,
              input: task.stateInput,
              metadata: task.metadata,
              nestedContext,
            });
            if (!evaluated.ok) {
              tasks.push({
                kind: 'failure',
                result: evaluated.result,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
              break;
            }
            if (task.branchIndex + 1 < branches.length) {
              tasks.push({ ...task, branchIndex: task.branchIndex + 1 });
            }
            if (evaluated.output === undefined) break;
            const numericArgs = [...task.numericArgs, evaluated.output.value];
            const startNumberOrigin = task.argumentIndex === 0
              && iterativeRangeNextPlan.filter.args.length >= 2
              ? evaluated.output.metadata.numberOrigin
              : task.startNumberOrigin;
            const nextArgumentIndex = task.argumentIndex + 1;
            if (nextArgumentIndex < iterativeRangeNextPlan.argumentBranches.length) {
              tasks.push({
                ...task,
                argumentIndex: nextArgumentIndex,
                branchIndex: 0,
                numericArgs,
                metadata: evaluated.output.metadata,
                startNumberOrigin,
              });
              break;
            }
            const range = jqIterativeRangeFromNumericArguments({ numericArgs });
            if (jqIterativeRangeHasValue({ value: range.start, end: range.end, step: range.step })) {
              tasks.push({
                kind: 'next_range',
                value: range.start,
                end: range.end,
                step: range.step,
                generatedCount: 0,
                outputMetadata: metadataWithNumberOrigin({
                  metadata: evaluated.output.metadata,
                  numberOrigin: undefined,
                }),
                startNumberOrigin,
              });
            }
            break;
          }
          case 'next_range': {
            if (task.generatedCount >= nestedContext.limits.maxOutputs) {
              return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
            }
            const nextValue = task.value + task.step;
            if (jqIterativeRangeHasValue({ value: nextValue, end: task.end, step: task.step })) {
              tasks.push({ ...task, value: nextValue, generatedCount: task.generatedCount + 1 });
            }
            tasks.push({
              kind: 'state',
              stateInput: task.value,
              stateMetadata: metadataWithNumberOrigin({
                metadata: task.outputMetadata,
                numberOrigin: task.generatedCount === 0 ? task.startNumberOrigin : undefined,
              }),
            });
            break;
          }
          case 'next_branch': {
            const fallbackMetadata = nestedContext.inputState.currentMetadata;
            const advanced = evaluateJqFilterWithContext({
              filter: task.branch,
              input: task.stateInput,
              context: nestedContext,
            });
            const outputs = advanced.ok ? advanced.outputs : failureOutputs({ result: advanced });
            if (!advanced.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: advanced,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'next_branch'
                    || sibling.nextGroup !== task.nextGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: advanced }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              const value = outputs[outputIndex]!;
              const metadata = metadataForResultOutput({
                result: advanced,
                index: outputIndex,
                fallback: fallbackMetadata,
              });
              if (conditionFilter === undefined) {
                tasks.push({ kind: 'state', stateInput: value, stateMetadata: metadata });
                continue;
              }
              const restoreIndex = nestedContext.inputState.index;
              const restoreMetadata = nestedContext.inputState.currentMetadata;
              const conditionGroup = conditionGroupId;
              conditionGroupId += 1;
              nestedContext.inputState.currentMetadata = metadata;
              tasks.push({ kind: 'finish_condition', restoreIndex, restoreMetadata, conditionGroup });
              if (iterativeRangeConditionPlan !== undefined) {
                tasks.push({
                  kind: 'condition_range_argument',
                  argumentIndex: 0,
                  branchIndex: 0,
                  numericArgs: [],
                  nextInput: value,
                  nextMetadata: metadata,
                  metadata,
                  restoreIndex,
                  restoreMetadata,
                });
                continue;
              }
              if (conditionBindPlan !== undefined) {
                tasks.push({
                  kind: 'condition_bind',
                  nextInput: value,
                  nextMetadata: metadata,
                  restoreIndex,
                  restoreMetadata,
                  conditionGroup,
                });
                continue;
              }
              if (conditionPlan === undefined) {
                throw new Error('Missing jq recurse condition plan');
              }
              for (let branchIndex = conditionPlan.branches.length - 1; branchIndex >= 0; branchIndex -= 1) {
                tasks.push({
                  kind: 'condition_branch',
                  branch: conditionPlan.branches[branchIndex]!,
                  nextInput: value,
                  nextMetadata: metadata,
                  restoreIndex,
                  restoreMetadata,
                  conditionGroup,
                  suppressFailure: conditionPlan.suppressFailure,
                  suppressBreakLabelId: conditionPlan.suppressBreakLabelId,
                });
              }
            }
            break;
          }
          case 'condition_bind': {
            if (conditionBindPlan === undefined) throw new Error('Missing jq iterative bind condition plan');
            const binding = evaluateWithMetadata({
              filter: conditionBindPlan.binding,
              input: task.nextInput,
              metadata: task.nextMetadata,
              nestedContext,
            });
            const outputs = binding.ok ? binding.outputs : failureOutputs({ result: binding });
            if (outputs.length > 1) {
              return runtimeError({ message: 'jq bind single-output proof was violated', value: undefined });
            }
            if (!binding.ok && !jqIterativePlanSuppressesFailure({
              suppressFailure: conditionBindPlan.suppressBindingFailure,
              suppressBreakLabelId: conditionBindPlan.suppressBindingBreakLabelId,
              result: binding,
            })) {
              tasks.push({
                kind: 'failure',
                result: clearFailureOutputs({ result: binding }),
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
            }
            const boundValue = outputs[0];
            if (boundValue === undefined) break;
            const boundMetadata = metadataForResultOutput({
              result: binding,
              index: 0,
              fallback: task.nextMetadata,
            });
            for (let index = conditionBindPlan.bodyPlan.branches.length - 1; index >= 0; index -= 1) {
              tasks.push({
                kind: 'condition_bound_branch',
                branch: conditionBindPlan.bodyPlan.branches[index]!,
                nextInput: task.nextInput,
                nextMetadata: task.nextMetadata,
                boundValue,
                boundMetadata,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
                conditionGroup: task.conditionGroup,
                suppressFailure: conditionBindPlan.bodyPlan.suppressFailure,
                suppressBreakLabelId: conditionBindPlan.bodyPlan.suppressBreakLabelId,
              });
            }
            break;
          }
          case 'condition_bound_branch': {
            if (conditionBindPlan === undefined) throw new Error('Missing jq iterative bind condition plan');
            const condition = evaluateWithMetadata({
              filter: task.branch,
              input: task.nextInput,
              metadata: task.nextMetadata,
              nestedContext: contextWithBoundValue({
                nestedContext,
                name: conditionBindPlan.name,
                value: task.boundValue,
                metadata: task.boundMetadata,
              }),
            });
            const outputs = condition.ok ? condition.outputs : failureOutputs({ result: condition });
            if (!condition.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: condition,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'condition_bound_branch'
                    || sibling.conditionGroup !== task.conditionGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: condition }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              if (!truthy({ value: outputs[outputIndex]! })) continue;
              tasks.push({
                kind: 'state',
                stateInput: task.nextInput,
                stateMetadata: metadataWithNumberOrigin({
                  metadata: metadataForResultOutput({
                    result: condition,
                    index: outputIndex,
                    fallback: task.nextMetadata,
                  }),
                  numberOrigin: task.nextMetadata.numberOrigin,
                }),
              });
            }
            break;
          }
          case 'condition_range_argument': {
            if (iterativeRangeConditionPlan === undefined) throw new Error('Missing jq iterative range condition plan');
            const branches = iterativeRangeConditionPlan.argumentBranches[task.argumentIndex];
            const branch = branches?.[task.branchIndex];
            if (branches === undefined || branch === undefined) {
              throw new Error(`Missing jq iterative range condition argument ${task.argumentIndex}:${task.branchIndex}`);
            }
            const evaluated = evaluateSingleOutputRangeArgument({
              argument: branch,
              input: task.nextInput,
              metadata: task.metadata,
              nestedContext,
            });
            if (!evaluated.ok) {
              tasks.push({
                kind: 'failure',
                result: evaluated.result,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
              break;
            }
            if (task.branchIndex + 1 < branches.length) {
              tasks.push({ ...task, branchIndex: task.branchIndex + 1 });
            }
            if (evaluated.output === undefined) break;
            const numericArgs = [...task.numericArgs, evaluated.output.value];
            const nextArgumentIndex = task.argumentIndex + 1;
            if (nextArgumentIndex < iterativeRangeConditionPlan.argumentBranches.length) {
              tasks.push({
                ...task,
                argumentIndex: nextArgumentIndex,
                branchIndex: 0,
                numericArgs,
                metadata: evaluated.output.metadata,
              });
              break;
            }
            const range = jqIterativeRangeFromNumericArguments({ numericArgs });
            if (jqIterativeRangeHasValue({ value: range.start, end: range.end, step: range.step })) {
              tasks.push({
                kind: 'condition_range',
                nextInput: task.nextInput,
                nextMetadata: task.nextMetadata,
                value: range.start,
                end: range.end,
                step: range.step,
                generatedCount: 0,
                restoreIndex: task.restoreIndex,
                restoreMetadata: task.restoreMetadata,
              });
            }
            break;
          }
          case 'condition_range': {
            if (task.generatedCount >= nestedContext.limits.maxOutputs) {
              return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
            }
            const nextValue = task.value + task.step;
            if (jqIterativeRangeHasValue({ value: nextValue, end: task.end, step: task.step })) {
              tasks.push({
                ...task,
                value: nextValue,
                generatedCount: task.generatedCount + 1,
              });
            }
            if (truthy({ value: task.value })) {
              tasks.push({
                kind: 'state',
                stateInput: task.nextInput,
                stateMetadata: task.nextMetadata,
              });
            }
            break;
          }
          case 'condition_branch': {
            const fallbackMetadata = nestedContext.inputState.currentMetadata;
            const condition = evaluateJqFilterWithContext({
              filter: task.branch,
              input: task.nextInput,
              context: nestedContext,
            });
            const outputs = condition.ok ? condition.outputs : failureOutputs({ result: condition });
            if (!condition.ok) {
              if (jqIterativePlanSuppressesFailure({
                suppressFailure: task.suppressFailure,
                suppressBreakLabelId: task.suppressBreakLabelId,
                result: condition,
              })) {
                while (true) {
                  const sibling = tasks.at(-1);
                  if (
                    sibling?.kind !== 'condition_branch'
                    || sibling.conditionGroup !== task.conditionGroup
                  ) break;
                  tasks.pop();
                }
              } else {
                tasks.push({
                  kind: 'failure',
                  result: clearFailureOutputs({ result: condition }),
                  restoreIndex: task.restoreIndex,
                  restoreMetadata: task.restoreMetadata,
                });
              }
            }
            for (let outputIndex = outputs.length - 1; outputIndex >= 0; outputIndex -= 1) {
              const conditionValue = outputs[outputIndex]!;
              if (!truthy({ value: conditionValue })) continue;
              tasks.push({
                kind: 'state',
                stateInput: task.nextInput,
                stateMetadata: metadataWithNumberOrigin({
                  metadata: metadataForResultOutput({
                    result: condition,
                    index: outputIndex,
                    fallback: fallbackMetadata,
                  }),
                  numberOrigin: task.nextMetadata.numberOrigin,
                }),
              });
            }
            break;
          }
          case 'finish_condition':
            if (nestedContext.inputState.index === task.restoreIndex) {
              nestedContext.inputState.currentMetadata = task.restoreMetadata;
            }
            break;
          case 'finish_next':
            if (nestedContext.inputState.index === task.restoreIndex) {
              nestedContext.inputState.currentMetadata = task.restoreMetadata;
            }
            break;
          case 'failure':
            if (
              task.restoreIndex !== undefined
              && task.restoreMetadata !== undefined
              && nestedContext.inputState.index === task.restoreIndex
            ) {
              nestedContext.inputState.currentMetadata = task.restoreMetadata;
            }
            return task.result;
          default: {
            const _ex: never = task;
            throw new Error(`Unhandled jq recurse task: ${String(_ex)}`);
          }
          }
        }
        return { ok: true, stopped: false };
      }

      const visitState = ({
        stateInput,
        stateMetadata,
        stateContext,
      }: {
        stateInput: JsonValue,
        stateMetadata: JqRuntimeInputMetadata,
        stateContext: JqRuntimeContext,
      }): JqRuntimeOutputVisitResult => {
        const emitted = consume({ value: stateInput, metadata: stateMetadata });
        if (!emitted.ok || emitted.stopped) return emitted;
        if (nextFilter === undefined) {
          for (const child of (Array.isArray(stateInput)
            ? stateInput
            : isJsonObject(stateInput)
              ? jsonObjectValues({ object: stateInput })
              : [])) {
            const childVisited = visitState({
              stateInput: child,
              stateMetadata,
              stateContext,
            });
            if (!childVisited.ok || childVisited.stopped) return childVisited;
          }
          return { ok: true, stopped: false };
        }
        return visitWithMetadata({
          filter: nextFilter,
          input: stateInput,
          metadata: stateMetadata,
          nestedContext: stateContext,
          nestedConsume: ({ value, metadata }) => {
            if (conditionFilter === undefined) {
              return visitState({
                stateInput: value,
                stateMetadata: metadata,
                stateContext,
              });
            }
            return visitWithMetadata({
              filter: conditionFilter,
              input: value,
              metadata,
              nestedContext: stateContext,
              nestedConsume: ({ value: conditionValue, metadata: conditionMetadata }) => truthy({
                value: conditionValue,
              })
                ? visitState({
                  stateInput: value,
                  stateMetadata: metadataWithNumberOrigin({
                    metadata: conditionMetadata,
                    numberOrigin: metadata.numberOrigin,
                  }),
                  stateContext,
                })
                : { ok: true, stopped: false },
            });
          },
        });
      };
      return visitState({
        stateInput: input,
        stateMetadata: context.inputState.currentMetadata,
        stateContext: nestedContext,
      });
    }
    default:
      return visitEvaluated();
    }
  }
  default:
    return visitEvaluated();
  }
}

function evaluateLazyStreamConsumerCall({
  filter,
  input,
  context,
}: {
  filter: Extract<JqFilter, { kind: 'call' }>,
  input: JsonValue,
  context: JqRuntimeContext,
}): JqRuntimeResult | undefined {
  const collect = ({
    generator,
    maximumOutputs,
    selectedIndex,
  }: {
    generator: JqFilter,
    maximumOutputs: number,
    selectedIndex: number | undefined,
  }): JqRuntimeResult => {
    if (maximumOutputs === 0) return { ok: true, outputs: [] };
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqFilterOutputsWithContext({
      filter: generator,
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: outputs.length >= maximumOutputs };
      },
    });
    const selectedOutputs = selectedIndex === undefined
      ? outputs
      : outputs[selectedIndex] === undefined ? [] : [outputs[selectedIndex]!];
    const selectedMetadata = selectedIndex === undefined
      ? outputMetadata
      : outputMetadata[selectedIndex] === undefined ? [] : [outputMetadata[selectedIndex]!];
    if (visited.ok) {
      return selectedMetadata.length === 0
        ? { ok: true, outputs: selectedOutputs }
        : { ok: true, outputs: selectedOutputs, outputMetadata: selectedMetadata };
    }
    return replaceFailureOutputs({
      result: visited,
      outputs: selectedOutputs,
      outputMetadata: selectedMetadata,
    });
  };

  switch (filter.name) {
  case 'IN': {
    if (filter.args.length < 1 || filter.args.length > 2 || filter.args[0] === undefined) {
      return undefined;
    }
    const sourceFilter = filter.args[0];
    let matched = false;
    const visitSource = ({
      target,
      targetMetadata,
    }: {
      target: JsonValue,
      targetMetadata: JqRuntimeInputMetadata,
    }): JqRuntimeOutputVisitResult => visitJqFilterOutputsWithContext({
      filter: sourceFilter,
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value: source, metadata: sourceMetadata }) => {
        if (!jsonValuesEqual({
          left: source,
          right: target,
          leftOrigin: sourceMetadata.numberOrigin,
          rightOrigin: targetMetadata.numberOrigin,
        })) {
          return { ok: true, stopped: false };
        }
        matched = true;
        return { ok: true, stopped: true };
      },
    });

    const targetFilter = filter.args[1];
    const visited = targetFilter === undefined
      ? visitSource({
        target: input,
        targetMetadata: context.inputState.currentMetadata,
      })
      : visitJqFilterOutputsWithContext({
        filter: targetFilter,
        input,
        context: { ...context, depth: context.depth + 1 },
        consume: ({ value: target, metadata: targetMetadata }) => visitSource({
          target,
          targetMetadata,
        }),
      });
    if (matched) return { ok: true, outputs: [true] };
    if (!visited.ok) return clearFailureOutputs({ result: visited });
    return { ok: true, outputs: [false] };
  }
  case 'limit':
  case 'nth': {
    if (filter.args.length !== 2 || filter.args[0] === undefined || filter.args[1] === undefined) {
      return undefined;
    }
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqCountedGeneratorOutputs({
      name: filter.name,
      countFilter: filter.args[0],
      generator: filter.args[1],
      input,
      context,
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: false };
      },
    });
    if (visited.ok) return { ok: true, outputs, outputMetadata };
    return replaceFailureOutputs({ result: visited, outputs, outputMetadata });
  }
  case 'path': {
    const argument = filter.args[0];
    if (filter.args.length !== 1 || argument === undefined) return undefined;
    const expression = extractPathExpression({ filter: argument });
    if (expression === undefined) return undefined;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqFilterOutputsWithContext({
      filter,
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: false };
      },
    });
    return visited.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: visited, outputs, outputMetadata });
  }
  case 'first':
    if (filter.args.length !== 1 || filter.args[0] === undefined) return undefined;
    return collect({ generator: filter.args[0], maximumOutputs: 1, selectedIndex: 0 });
  case 'last': {
    if (filter.args.length !== 1 || filter.args[0] === undefined) return undefined;
    let lastValue: JsonValue | undefined;
    let lastMetadata: JqRuntimeInputMetadata | undefined;
    const visited = visitJqFilterOutputsWithContext({
      filter: filter.args[0],
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value, metadata }) => {
        lastValue = value;
        lastMetadata = metadata;
        return { ok: true, stopped: false };
      },
    });
    if (!visited.ok) return clearFailureOutputs({ result: visited });
    if (lastValue === undefined) {
      return {
        ok: true,
        outputs: [null],
        outputMetadata: [metadataWithNumberOrigin({
          metadata: context.inputState.currentMetadata,
          numberOrigin: undefined,
        })],
      };
    }
    return {
      ok: true,
      outputs: [lastValue],
      ...(lastMetadata === undefined ? {} : { outputMetadata: [lastMetadata] }),
    };
  }
  case 'isempty': {
    if (filter.args.length !== 1 || filter.args[0] === undefined) return undefined;
    let found = false;
    const visited = visitJqFilterOutputsWithContext({
      filter: filter.args[0],
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: () => {
        found = true;
        return { ok: true, stopped: true };
      },
    });
    if (visited.ok) {
      return { ok: true, outputs: [!found] };
    }
    return visited;
  }
  case 'all':
  case 'any': {
    if (filter.args.length !== 2 || filter.args[0] === undefined || filter.args[1] === undefined) {
      return undefined;
    }
    const decisiveTruthiness = (() => {
      switch (filter.name) {
      case 'any': return true;
      case 'all': return false;
      default: {
        const _ex: never = filter.name;
        throw new Error(`Unhandled jq lazy boolean aggregate: ${_ex}`);
      }
      }
    })();
    let decided = false;
    const generated = visitJqFilterOutputsWithContext({
      filter: filter.args[0],
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value, metadata }) => {
        const previousIndex = context.inputState.index;
        const previousMetadata = context.inputState.currentMetadata;
        context.inputState.currentMetadata = metadata;
        const predicate = visitJqFilterOutputsWithContext({
          filter: filter.args[1]!,
          input: value,
          context: { ...context, depth: context.depth + 1 },
          consume: ({ value: predicateValue }) => {
            if (truthy({ value: predicateValue }) !== decisiveTruthiness) {
              return { ok: true, stopped: false };
            }
            decided = true;
            return { ok: true, stopped: true };
          },
        });
        if (context.inputState.index === previousIndex) {
          context.inputState.currentMetadata = previousMetadata;
        }
        if (!predicate.ok || decided) return predicate;
        return { ok: true, stopped: false };
      },
    });
    if (decided) return { ok: true, outputs: [decisiveTruthiness] };
    if (!generated.ok) return generated;
    return { ok: true, outputs: [!decisiveTruthiness] };
  }
  case 'recurse': {
    if (filter.args.length > 2) return undefined;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqFilterOutputsWithContext({
      filter,
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: false };
      },
    });
    if (visited.ok) return { ok: true, outputs, outputMetadata };
    return replaceFailureOutputs({ result: visited, outputs, outputMetadata });
  }
  case 'walk':
    if (filter.args.length !== 1 || filter.args[0] === undefined) return undefined;
    // `walk(f)` can expose a mapper stream at the completed node while child
    // containers remain atomic. Reuse the command-layer output visitor even
    // at top level so late mapper failures retain exactly the prefixes jq has
    // already published.
    {
      const outputs: JsonValue[] = [];
      const outputMetadata: JqRuntimeInputMetadata[] = [];
      const visited = visitJqFilterOutputsWithContext({
        filter,
        input,
        context: { ...context, depth: context.depth + 1 },
        consume: ({ value, metadata }) => {
          if (outputs.length >= context.limits.maxOutputs) {
            return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
          }
          outputs.push(value);
          outputMetadata.push(metadata);
          return { ok: true, stopped: false };
        },
      });
      if (visited.ok) return { ok: true, outputs, outputMetadata };
      return replaceFailureOutputs({ result: visited, outputs, outputMetadata });
    }
  case 'while':
  case 'until': {
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqFilterOutputsWithContext({
      filter,
      input,
      context: { ...context, depth: context.depth + 1 },
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: false };
      },
    });
    if (visited.ok) return { ok: true, outputs, outputMetadata };
    return replaceFailureOutputs({ result: visited, outputs, outputMetadata });
  }
  default:
    return undefined;
  }
}

function evaluateJqFilterWithContext({
  filter,
  input,
  context,
}: {
  filter: JqFilter,
  input: JsonValue,
  context: JqRuntimeContext,
}): JqRuntimeResult {
  const limit = checkLimits({ context });
  if (!limit.ok) return limit;

  const nestedContext: JqRuntimeContext = {
    ...context,
    depth: context.depth + 1,
  };
  const evaluate: JqRuntimeFilterEvaluator = ({
    filter: nestedFilter,
    input: nestedInput,
    inputMetadata,
  }) => {
    if (inputMetadata === undefined) {
      return evaluateJqFilterWithContext({ filter: nestedFilter, input: nestedInput, context: nestedContext });
    }
    const previousIndex = nestedContext.inputState.index;
    const previousMetadata = nestedContext.inputState.currentMetadata;
    nestedContext.inputState.currentMetadata = inputMetadata;
    const evaluated = evaluateJqFilterWithContext({
      filter: nestedFilter,
      input: nestedInput,
      context: nestedContext,
    });
    if (nestedContext.inputState.index === previousIndex) {
      nestedContext.inputState.currentMetadata = previousMetadata;
    }
    return evaluated;
  };

  type FirstOutputVisitResult =
    | { ok: true, found: false }
    | { ok: true, found: true, value: JsonValue, metadata: JqRuntimeInputMetadata | undefined }
    | Extract<JqRuntimeResult, { ok: false }>;

  const visitUpdateOutputs = ({
    filter: updateFilter,
    input: updateInput,
    consume,
    depth,
  }: {
    filter: JqFilter,
    input: JsonValue,
    consume: ({ value, metadata }: { value: JsonValue, metadata: JqRuntimeInputMetadata | undefined }) => FirstOutputVisitResult,
    depth: number,
  }): FirstOutputVisitResult => {
    switch (updateFilter.kind) {
    case 'comma': {
      const structuralLimit = checkLimits({
        context: { ...nestedContext, depth: nestedContext.depth + depth },
      });
      if (!structuralLimit.ok) return structuralLimit;
      const left = visitUpdateOutputs({
        filter: updateFilter.left,
        input: updateInput,
        consume,
        depth: depth + 1,
      });
      return !left.ok || left.found
        ? left
        : visitUpdateOutputs({
          filter: updateFilter.right,
          input: updateInput,
          consume,
          depth: depth + 1,
        });
    }
    case 'pipe': {
      const structuralLimit = checkLimits({
        context: { ...nestedContext, depth: nestedContext.depth + depth },
      });
      if (!structuralLimit.ok) return structuralLimit;
      return visitUpdateOutputs({
        filter: updateFilter.left,
        input: updateInput,
        depth: depth + 1,
        consume: ({ value, metadata }) => {
          if (metadata !== undefined) context.inputState.currentMetadata = metadata;
          return visitUpdateOutputs({
            filter: updateFilter.right,
            input: value,
            consume,
            depth: depth + 1,
          });
        },
      });
    }
    default: {
      const evaluated = evaluate({ filter: updateFilter, input: updateInput });
      const outputs = evaluated.ok ? evaluated.outputs : failureOutputs({ result: evaluated });
      const fallbackMetadata = context.inputState.currentMetadata;
      for (let outputIndex = 0; outputIndex < outputs.length; outputIndex += 1) {
        const value = outputs[outputIndex]!;
        const consumed = consume({
          value,
          metadata: evaluated.outputMetadata === undefined
            ? undefined
            : metadataForResultOutput({
              result: evaluated,
              index: outputIndex,
              fallback: fallbackMetadata,
            }),
        });
        if (!consumed.ok || consumed.found) return consumed;
      }
      return evaluated.ok ? { ok: true, found: false } : evaluated;
    }
    }
  };

  const evaluateFirstUpdateOutput: JqRuntimeFilterEvaluator = ({
    filter: updateFilter,
    input: updateInput,
  }) => {
    const visited = visitUpdateOutputs({
      filter: updateFilter,
      input: updateInput,
      consume: ({ value, metadata }) => ({ ok: true, found: true, value, metadata }),
      depth: 0,
    });
    if (!visited.ok) return visited;
    return {
      ok: true,
      outputs: visited.found ? [visited.value] : [],
      ...(visited.found && visited.metadata !== undefined
        ? { outputMetadata: [visited.metadata] }
        : {}),
    };
  };

  const evaluateFirstVisitedOutput: JqRuntimeFilterEvaluator = ({
    filter: visitedFilter,
    input: visitedInput,
    inputMetadata,
  }) => {
    let firstValue: JsonValue | undefined;
    let firstMetadata: JqRuntimeInputMetadata | undefined;
    const previousIndex = nestedContext.inputState.index;
    const previousMetadata = nestedContext.inputState.currentMetadata;
    if (inputMetadata !== undefined) {
      nestedContext.inputState.currentMetadata = inputMetadata;
    }
    const visited = visitJqFilterOutputsWithContext({
      filter: visitedFilter,
      input: visitedInput,
      context: nestedContext,
      consume: ({ value, metadata }) => {
        firstValue = value;
        firstMetadata = metadata;
        return { ok: true, stopped: true };
      },
    });
    if (nestedContext.inputState.index === previousIndex) {
      nestedContext.inputState.currentMetadata = previousMetadata;
    }
    if (!visited.ok) return visited;
    return {
      ok: true,
      outputs: firstValue === undefined ? [] : [firstValue],
      ...(firstValue !== undefined && firstMetadata !== undefined
        ? { outputMetadata: [firstMetadata] }
        : {}),
    };
  };

  type TryBodyResult =
    | { ok: true, outputs: JsonValue[], outputMetadata?: JqRuntimeInputMetadata[] }
    | {
      ok: false,
      outputs: JsonValue[],
      outputMetadata?: JqRuntimeInputMetadata[],
      error: JqRuntimeError,
      inputRequest?: JqRuntimeInputRequest,
    };

  type TryBodyTask =
    | { readonly kind: 'evaluate', readonly filter: JqFilter, readonly input: JsonValue }
    | { readonly kind: 'comma_after_left', readonly right: JqFilter, readonly input: JsonValue }
    | { readonly kind: 'comma_after_right', readonly leftOutputs: JsonValue[] }
    | { readonly kind: 'pipe_after_left', readonly right: JqFilter }
    | {
      readonly kind: 'pipe_after_right',
      readonly right: JqFilter,
      readonly left: TryBodyResult,
      readonly nextInputIndex: number,
      readonly outputs: JsonValue[],
    };

  const evaluateTryBody = ({
    filter: tryFilter,
    input: tryInput,
  }: {
    filter: JqFilter,
    input: JsonValue,
  }): TryBodyResult => {
    const tasks: TryBodyTask[] = [{ kind: 'evaluate', filter: tryFilter, input: tryInput }];
    const results: TryBodyResult[] = [];

    while (tasks.length > 0) {
      const task = tasks.pop();
      if (task === undefined) throw new Error('jq try evaluation task stack is empty');
      switch (task.kind) {
      case 'evaluate':
        switch (task.filter.kind) {
        case 'comma':
          tasks.push({ kind: 'comma_after_left', right: task.filter.right, input: task.input });
          tasks.push({ kind: 'evaluate', filter: task.filter.left, input: task.input });
          break;
        case 'pipe':
          tasks.push({ kind: 'pipe_after_left', right: task.filter.right });
          tasks.push({ kind: 'evaluate', filter: task.filter.left, input: task.input });
          break;
        default: {
          const evaluated = evaluate({ filter: task.filter, input: task.input });
          results.push(evaluated.ok
            ? evaluated
            : {
              ...evaluated,
              outputs: failureOutputs({ result: evaluated }),
            });
          break;
        }
        }
        break;
      case 'comma_after_left': {
        const left = results.pop();
        if (left === undefined) throw new Error('jq try comma left result is missing');
        if (!left.ok) {
          results.push(left);
          break;
        }
        tasks.push({ kind: 'comma_after_right', leftOutputs: left.outputs });
        tasks.push({ kind: 'evaluate', filter: task.right, input: task.input });
        break;
      }
      case 'comma_after_right': {
        const right = results.pop();
        if (right === undefined) throw new Error('jq try comma right result is missing');
        const outputs = [...task.leftOutputs];
        const appended = appendRuntimeOutputs({ target: outputs, source: right.outputs, context });
        if (!appended.ok) {
          results.push({ ok: false, outputs, error: appended.error });
          break;
        }
        results.push(right.ok
          ? { ok: true, outputs }
          : { ...right, outputs });
        break;
      }
      case 'pipe_after_left': {
        const left = results.pop();
        if (left === undefined) throw new Error('jq try pipe left result is missing');
        const firstInput = left.outputs[0];
        if (firstInput === undefined) {
          results.push(left.ok
            ? { ok: true, outputs: [] }
            : { ...left, outputs: [] });
          break;
        }
        tasks.push({
          kind: 'pipe_after_right',
          right: task.right,
          left,
          nextInputIndex: 1,
          outputs: [],
        });
        tasks.push({ kind: 'evaluate', filter: task.right, input: firstInput });
        break;
      }
      case 'pipe_after_right': {
        const right = results.pop();
        if (right === undefined) throw new Error('jq try pipe right result is missing');
        const appended = appendRuntimeOutputs({ target: task.outputs, source: right.outputs, context });
        if (!appended.ok) {
          results.push({ ok: false, outputs: task.outputs, error: appended.error });
          break;
        }
        if (!right.ok) {
          results.push({ ...right, outputs: task.outputs });
          break;
        }
        const nextInput = task.left.outputs[task.nextInputIndex];
        if (nextInput !== undefined) {
          tasks.push({
            ...task,
            nextInputIndex: task.nextInputIndex + 1,
          });
          tasks.push({ kind: 'evaluate', filter: task.right, input: nextInput });
          break;
        }
        results.push(task.left.ok
          ? { ok: true, outputs: task.outputs }
          : { ...task.left, outputs: task.outputs });
        break;
      }
      default: {
        const _ex: never = task;
        throw new Error(`Unhandled jq try evaluation task: ${JSON.stringify(_ex)}`);
      }
      }
    }

    if (results.length !== 1) {
      throw new Error(`jq try evaluation produced ${results.length} results`);
    }
    return results[0]!;
  };

  let result: JqRuntimeResult;

  switch (filter.kind) {
  case 'identity':
    result = { ok: true, outputs: [input], outputMetadata: [context.inputState.currentMetadata] };
    break;
  case 'variable': {
    if (!Object.hasOwn(context.variables, filter.name)) {
      result = runtimeError({ message: `$${filter.name} is not defined`, value: undefined });
      break;
    }
    const value = context.variables[filter.name]!;
    result = {
      ok: true,
      outputs: [value],
      outputMetadata: [metadataWithNumberOrigin({
        metadata: context.inputState.currentMetadata,
        numberOrigin: typeof value === 'number' && Object.hasOwn(context.variableNumberOrigins, filter.name)
          ? context.variableNumberOrigins[filter.name]
          : undefined,
      })],
    };
    break;
  }
  case 'literal': {
    const metadata = filter.numberOrigin === undefined
      ? { ...context.inputState.currentMetadata, numberOrigin: undefined }
      : { ...context.inputState.currentMetadata, numberOrigin: filter.numberOrigin };
    result = { ok: true, outputs: [filter.value], outputMetadata: [metadata] };
    break;
  }
  case 'string': {
    type StringTask =
      | { readonly kind: 'evaluate', readonly partIndex: number, readonly suffix: string }
      | {
        readonly kind: 'continue_interpolation',
        readonly partIndex: number,
        readonly suffix: string,
        readonly interpolationResult: JqRuntimeResult,
        readonly fallbackMetadata: JqRuntimeInputMetadata,
        readonly nextOutputIndex: number,
      };

    const outputs: string[] = [];
    const tasks: StringTask[] = [{
      kind: 'evaluate',
      partIndex: filter.parts.length - 1,
      suffix: '',
    }];
    while (tasks.length > 0) {
      const task = tasks.pop();
      if (task === undefined) throw new Error('jq string task stack underflow');
      switch (task.kind) {
      case 'evaluate': {
        if (task.partIndex < 0) {
          if (outputs.length >= context.limits.maxOutputs) {
            return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
          }
          outputs.push(task.suffix);
          break;
        }
        const part = filter.parts[task.partIndex];
        if (part === undefined) throw new Error('jq string part index mismatch');
        switch (part.kind) {
        case 'text':
          tasks.push({
            kind: 'evaluate',
            partIndex: task.partIndex - 1,
            suffix: `${part.value}${task.suffix}`,
          });
          break;
        case 'interpolation': {
          const fallbackMetadata = context.inputState.currentMetadata;
          const interpolated = evaluate({ filter: part.filter, input });
          tasks.push({
            kind: 'continue_interpolation',
            partIndex: task.partIndex,
            suffix: task.suffix,
            interpolationResult: interpolated,
            fallbackMetadata,
            nextOutputIndex: 0,
          });
          break;
        }
        default: {
          const _ex: never = part;
          throw new Error(`Unhandled string part: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'continue_interpolation': {
        const interpolationOutputs = task.interpolationResult.ok
          ? task.interpolationResult.outputs
          : failureOutputs({ result: task.interpolationResult });
        const value = interpolationOutputs[task.nextOutputIndex];
        if (value === undefined) {
          if (!task.interpolationResult.ok) {
            return replaceFailureOutputs({
              result: clearFailureOutputs({ result: task.interpolationResult }),
              outputs,
            });
          }
          break;
        }
        const interpolationMetadata = metadataForResultOutput({
          result: task.interpolationResult,
          index: task.nextOutputIndex,
          fallback: task.fallbackMetadata,
        });
        tasks.push({
          ...task,
          nextOutputIndex: task.nextOutputIndex + 1,
        });
        tasks.push({
          kind: 'evaluate',
          partIndex: task.partIndex - 1,
          suffix: `${stringifyInterpolationValue({
            value,
            numberOrigin: interpolationMetadata.numberOrigin,
          })}${task.suffix}`,
        });
        break;
      }
      default: {
        const _ex: never = task;
        throw new Error(`Unhandled jq string task: ${JSON.stringify(_ex)}`);
      }
      }
    }
    result = { ok: true, outputs };
    break;
  }
  case 'field': {
    const parent = evaluate({ filter: filter.input, input });
    const parentOutputs = parent.ok ? parent.outputs : failureOutputs({ result: parent });
    const parentFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let parentIndex = 0; parentIndex < parentOutputs.length; parentIndex += 1) {
      const value = parentOutputs[parentIndex]!;
      const parentMetadata = metadataForResultOutput({
        result: parent,
        index: parentIndex,
        fallback: parentFallbackMetadata,
      });
      if (value === null) {
        outputs.push(null);
        outputMetadata.push(metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }));
      } else if (isJsonObject(value)) {
        const child = Object.hasOwn(value, filter.key) ? value[filter.key]! : null;
        outputs.push(child);
        outputMetadata.push(metadataForChildValue({
          metadata: parentMetadata,
          container: value,
          key: filter.key,
          value: child,
        }));
      } else if (!filter.optional) {
        return replaceFailureOutputs({
          result: runtimeError({ message: formatJqIndexError({ container: value, index: filter.key }), value: undefined }),
          outputs,
          outputMetadata,
        });
      }
    }
    result = parent.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: parent, outputs, outputMetadata });
    break;
  }
  case 'index': {
    const parent = evaluate({ filter: filter.input, input });
    const parentOutputs = parent.ok ? parent.outputs : failureOutputs({ result: parent });
    const parentFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let parentIndex = 0; parentIndex < parentOutputs.length; parentIndex += 1) {
      const value = parentOutputs[parentIndex]!;
      const parentMetadata = metadataForResultOutput({
        result: parent,
        index: parentIndex,
        fallback: parentFallbackMetadata,
      });
      if (value === null) {
        outputs.push(null);
        outputMetadata.push(metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }));
      } else if (Array.isArray(value)) {
        const normalizedIndex = normalizeArrayIndex({ array: value, index: filter.index });
        const child = normalizedIndex === undefined ? null : value[normalizedIndex]!;
        outputs.push(child);
        outputMetadata.push(normalizedIndex === undefined
          ? metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined })
          : metadataForChildValue({
            metadata: parentMetadata,
            container: value,
            key: normalizedIndex,
            value: child,
          }));
      } else if (!filter.optional) {
        return replaceFailureOutputs({
          result: runtimeError({ message: formatJqIndexError({ container: value, index: filter.index }), value: undefined }),
          outputs,
          outputMetadata,
        });
      }
    }
    result = parent.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: parent, outputs, outputMetadata });
    break;
  }
  case 'dynamic_index': {
    const parents = evaluate({ filter: filter.input, input });
    const parentOutputs = parents.ok ? parents.outputs : failureOutputs({ result: parents });
    const parentFallbackMetadata = context.inputState.currentMetadata;
    const indexes = evaluate({ filter: filter.index, input });
    const indexOutputs = indexes.ok ? indexes.outputs : failureOutputs({ result: indexes });
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];

    for (let parentIndex = 0; parentIndex < parentOutputs.length; parentIndex += 1) {
      const parent = parentOutputs[parentIndex]!;
      const parentMetadata = metadataForResultOutput({
        result: parents,
        index: parentIndex,
        fallback: parentFallbackMetadata,
      });
      for (const index of indexOutputs) {
        if (parent === null) {
          outputs.push(null);
          outputMetadata.push(metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }));
        } else if (Array.isArray(parent) && typeof index === 'number' && Number.isFinite(index)) {
          const normalized = normalizeArrayIndex({ array: parent, index });
          const child = normalized === undefined ? null : parent[normalized]!;
          outputs.push(child);
          outputMetadata.push(normalized === undefined
            ? metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined })
            : metadataForChildValue({ metadata: parentMetadata, container: parent, key: normalized, value: child }));
        } else if (isJsonObject(parent) && typeof index === 'string') {
          const child = Object.hasOwn(parent, index) ? parent[index]! : null;
          outputs.push(child);
          outputMetadata.push(metadataForChildValue({
            metadata: parentMetadata,
            container: parent,
            key: index,
            value: child,
          }));
        } else if (!filter.optional) {
          return replaceFailureOutputs({
            result: runtimeError({ message: formatJqIndexError({ container: parent, index }), value: undefined }),
            outputs,
            outputMetadata,
          });
        }
      }
    }
    result = !parents.ok
      ? replaceFailureOutputs({ result: parents, outputs, outputMetadata })
      : !indexes.ok
        ? replaceFailureOutputs({ result: indexes, outputs, outputMetadata })
        : { ok: true, outputs, outputMetadata };
    break;
  }
  case 'slice': {
    const parents = evaluate({ filter: filter.input, input });
    const parentOutputs = parents.ok ? parents.outputs : failureOutputs({ result: parents });
    const parentFallbackMetadata = context.inputState.currentMetadata;
    const starts = filter.start === undefined
      ? { ok: true as const, outputs: [null] as JsonValue[] }
      : evaluate({ filter: filter.start, input });
    const startOutputs = starts.ok ? starts.outputs : failureOutputs({ result: starts });
    const ends = filter.end === undefined
      ? { ok: true as const, outputs: [null] as JsonValue[] }
      : evaluate({ filter: filter.end, input });
    const endOutputs = ends.ok ? ends.outputs : failureOutputs({ result: ends });
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];

    for (let parentIndex = 0; parentIndex < parentOutputs.length; parentIndex += 1) {
      const parent = parentOutputs[parentIndex]!;
      const parentMetadata = metadataForResultOutput({
        result: parents,
        index: parentIndex,
        fallback: parentFallbackMetadata,
      });
      for (const startValue of startOutputs) {
        for (const endValue of endOutputs) {
          const start = startValue === null ? undefined : startValue;
          const end = endValue === null ? undefined : endValue;
          if ((start !== undefined && typeof start !== 'number') || (end !== undefined && typeof end !== 'number')) {
            if (filter.optional) continue;
            return replaceFailureOutputs({
              result: runtimeError({ message: 'slice bounds must be numbers or null', value: undefined }),
              outputs,
              outputMetadata,
            });
          }
          if (Array.isArray(parent)) {
            const normalizedStart = normalizeSliceBound({ length: parent.length, bound: start, fallback: 0 });
            const normalizedEnd = normalizeSliceBound({ length: parent.length, bound: end, fallback: 'length' });
            const child = parent.slice(normalizedStart, normalizedEnd);
            moveJsonArrayNumberOrigins({
              source: parent,
              target: child,
              sourceStart: normalizedStart,
              sourceEnd: normalizedEnd,
            });
            outputs.push(child);
            outputMetadata.push(metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }));
          } else if (typeof parent === 'string') {
            outputs.push(parent.slice(
              normalizeSliceBound({ length: parent.length, bound: start, fallback: 0 }),
              normalizeSliceBound({ length: parent.length, bound: end, fallback: 'length' }),
            ));
            outputMetadata.push(metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }));
          } else if (parent === null) {
            outputs.push(null);
            outputMetadata.push(metadataWithNumberOrigin({ metadata: parentMetadata, numberOrigin: undefined }));
          } else if (!filter.optional) {
            return replaceFailureOutputs({
              result: runtimeError({ message: 'cannot slice non-array/string', value: undefined }),
              outputs,
              outputMetadata,
            });
          }
        }
      }
    }
    result = !parents.ok
      ? replaceFailureOutputs({ result: parents, outputs, outputMetadata })
      : !starts.ok
        ? replaceFailureOutputs({ result: starts, outputs, outputMetadata })
        : !ends.ok
          ? replaceFailureOutputs({ result: ends, outputs, outputMetadata })
          : { ok: true, outputs, outputMetadata };
    break;
  }
  case 'iterate': {
    const parent = evaluate({ filter: filter.input, input });
    const parentOutputs = parent.ok ? parent.outputs : failureOutputs({ result: parent });
    const parentFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let parentIndex = 0; parentIndex < parentOutputs.length; parentIndex += 1) {
      const value = parentOutputs[parentIndex]!;
      const parentMetadata = metadataForResultOutput({ result: parent, index: parentIndex, fallback: parentFallbackMetadata });
      if (Array.isArray(value)) {
        for (let childIndex = 0; childIndex < value.length; childIndex += 1) {
          const child = value[childIndex]!;
          outputs.push(child);
          outputMetadata.push(metadataForChildValue({
            metadata: parentMetadata,
            container: value,
            key: childIndex,
            value: child,
          }));
        }
      } else if (isJsonObject(value)) {
        for (const [key, child] of jsonObjectEntries({ object: value })) {
          outputs.push(child);
          outputMetadata.push(metadataForChildValue({ metadata: parentMetadata, container: value, key, value: child }));
        }
      } else if (!filter.optional) {
        return replaceFailureOutputs({
          result: runtimeError({ message: 'cannot iterate over non-array/object', value: undefined }),
          outputs,
          outputMetadata,
        });
      }
      if (outputs.length > context.limits.maxOutputs) {
        return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
      }
    }
    result = parent.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: parent, outputs, outputMetadata });
    break;
  }
  case 'recursive_descent': {
    const roots = evaluate({ filter: filter.input, input });
    const rootOutputs = roots.ok ? roots.outputs : failureOutputs({ result: roots });
    const rootFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const stack = rootOutputs.map((value, index) => ({
      value,
      metadata: metadataForResultOutput({ result: roots, index, fallback: rootFallbackMetadata }),
    })).reverse();
    while (stack.length > 0) {
      const current = stack.pop()!;
      outputs.push(current.value);
      outputMetadata.push(current.metadata);
      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          const child = current.value[index]!;
          stack.push({
            value: child,
            metadata: metadataForChildValue({
              metadata: current.metadata,
              container: current.value,
              key: index,
              value: child,
            }),
          });
        }
      } else if (isJsonObject(current.value)) {
        const children = jsonObjectEntries({ object: current.value });
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const [key, child] = children[index]!;
          stack.push({
            value: child,
            metadata: metadataForChildValue({
              metadata: current.metadata,
              container: current.value,
              key,
              value: child,
            }),
          });
        }
      }
      if (outputs.length > context.limits.maxOutputs) {
        return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
      }
    }
    result = roots.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: roots, outputs, outputMetadata });
    break;
  }
  case 'optional': {
    const attempted = evaluateTryBody({ filter: filter.body, input });
    if (!attempted.ok && (attempted.inputRequest !== undefined || attempted.error.halt !== undefined)) {
      return attempted;
    }
    result = attempted.outputMetadata === undefined
      ? { ok: true, outputs: attempted.outputs }
      : { ok: true, outputs: attempted.outputs, outputMetadata: attempted.outputMetadata };
    break;
  }
  case 'pipe': {
    const structuralLimit = checkRequiredLeftSpineDepth({ filter, context, kind: 'pipe' });
    if (!structuralLimit.ok) return structuralLimit;
    const left = evaluate({ filter: filter.left, input });
    const leftOutputs = left.ok ? left.outputs : failureOutputs({ result: left });
    const leftFallbackMetadata = context.inputState.currentMetadata;
    if (isEmptyBuiltinFilter({ filter: filter.right })) {
      const finalOutputIndex = leftOutputs.length - 1;
      if (
        finalOutputIndex >= 0
        && context.inputState.currentMetadata !== context.inputState.sourceExhaustionMetadata
      ) {
        // A slurped `inputs` traversal can consume its final output and then
        // explicitly observe EOF. In that case the input state has already
        // restored primary metadata; do not resurrect the final source
        // metadata merely because `empty` discards that output.
        context.inputState.currentMetadata = metadataForResultOutput({
          result: left,
          index: finalOutputIndex,
          fallback: leftFallbackMetadata,
        });
      }
      const outputMetadata: JqRuntimeInputMetadata[] = [];
      result = left.ok
        ? { ok: true, outputs: [], outputMetadata }
        : replaceFailureOutputs({ result: left, outputs: [], outputMetadata });
      break;
    }
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let index = 0; index < leftOutputs.length; index += 1) {
      const value = leftOutputs[index]!;
      context.inputState.currentMetadata = metadataForResultOutput({
        result: left,
        index,
        fallback: leftFallbackMetadata,
      });
      const right = evaluate({ filter: filter.right, input: value });
      const rightOutputs = right.ok ? right.outputs : failureOutputs({ result: right });
      const rightFallbackMetadata = context.inputState.currentMetadata;
      const appended = appendRuntimeOutputs({ target: outputs, source: rightOutputs, context });
      if (!appended.ok) return appended;
      appendRuntimeMetadata({
        target: outputMetadata,
        result: right,
        outputCount: rightOutputs.length,
        fallback: rightFallbackMetadata,
      });
      if (!right.ok) {
        return replaceFailureOutputs({ result: right, outputs, outputMetadata });
      }
    }
    result = left.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: left, outputs, outputMetadata });
    break;
  }
  case 'comma': {
    const structuralLimit = checkRequiredLeftSpineDepth({ filter, context, kind: 'comma' });
    if (!structuralLimit.ok) return structuralLimit;
    const left = evaluate({ filter: filter.left, input });
    if (!left.ok) return left;
    const leftFallbackMetadata = context.inputState.currentMetadata;
    const right = evaluate({ filter: filter.right, input });
    const outputs = [...left.outputs];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    appendRuntimeMetadata({
      target: outputMetadata,
      result: left,
      outputCount: left.outputs.length,
      fallback: leftFallbackMetadata,
    });
    const rightOutputs = right.ok ? right.outputs : failureOutputs({ result: right });
    const rightFallbackMetadata = context.inputState.currentMetadata;
    const appended = appendRuntimeOutputs({ target: outputs, source: rightOutputs, context });
    if (!appended.ok) return appended;
    appendRuntimeMetadata({
      target: outputMetadata,
      result: right,
      outputCount: rightOutputs.length,
      fallback: rightFallbackMetadata,
    });
    result = right.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: right, outputs, outputMetadata });
    break;
  }
  case 'conditional': {
    let currentConditional = filter;
    let conditionalDepth = 0;
    while (true) {
      if (conditionalDepth > 0) {
        const structuralLimit = checkLimits({
          context: { ...context, depth: context.depth + conditionalDepth },
        });
        if (!structuralLimit.ok) return structuralLimit;
      }
      const branchContext: JqRuntimeContext = {
        ...context,
        depth: context.depth + conditionalDepth + 1,
      };
      const conditions = evaluateJqFilterWithContext({
        filter: currentConditional.condition,
        input,
        context: branchContext,
      });
      const conditionOutputs = conditions.ok ? conditions.outputs : failureOutputs({ result: conditions });
      const conditionFallbackMetadata = context.inputState.currentMetadata;

      if (
        conditions.ok
        && conditionOutputs.length === 1
        && conditionOutputs[0] !== undefined
        && !truthy({ value: conditionOutputs[0] })
        && currentConditional.elseBranch.kind === 'conditional'
      ) {
        context.inputState.currentMetadata = metadataForResultOutput({
          result: conditions,
          index: 0,
          fallback: conditionFallbackMetadata,
        });
        currentConditional = currentConditional.elseBranch;
        conditionalDepth += 1;
        continue;
      }

      const outputs: JsonValue[] = [];
      const outputMetadata: JqRuntimeInputMetadata[] = [];
      for (let index = 0; index < conditionOutputs.length; index += 1) {
        const condition = conditionOutputs[index]!;
        context.inputState.currentMetadata = metadataForResultOutput({
          result: conditions,
          index,
          fallback: conditionFallbackMetadata,
        });
        const branch = evaluateJqFilterWithContext({
          filter: truthy({ value: condition })
            ? currentConditional.thenBranch
            : currentConditional.elseBranch,
          input,
          context: branchContext,
        });
        const branchOutputs = branch.ok ? branch.outputs : failureOutputs({ result: branch });
        const branchFallbackMetadata = context.inputState.currentMetadata;
        const appended = appendRuntimeOutputs({ target: outputs, source: branchOutputs, context });
        if (!appended.ok) return appended;
        appendRuntimeMetadata({
          target: outputMetadata,
          result: branch,
          outputCount: branchOutputs.length,
          fallback: branchFallbackMetadata,
        });
        if (!branch.ok) {
          return replaceFailureOutputs({ result: branch, outputs, outputMetadata });
        }
      }
      result = conditions.ok
        ? { ok: true, outputs, outputMetadata }
        : replaceFailureOutputs({ result: conditions, outputs, outputMetadata });
      break;
    }
    break;
  }
  case 'trycatch': {
    const attempted = evaluateTryBody({ filter: filter.body, input });
    if (attempted.ok) {
      result = attempted;
      break;
    }
    if (attempted.inputRequest !== undefined || attempted.error.halt !== undefined) return attempted;
    if (attempted.error.metadata !== undefined) {
      context.inputState.currentMetadata = attempted.error.metadata;
    }
    const caught = evaluate({
      filter: filter.catchBranch,
      input: attempted.error.value === undefined
        ? attempted.error.message
        : attempted.error.value,
    });
    if (!caught.ok) {
      result = appendFailureOutputs({ prefix: attempted.outputs, result: caught, context });
      break;
    }
    const outputs = [...attempted.outputs];
    const appended = appendRuntimeOutputs({ target: outputs, source: caught.outputs, context });
    if (!appended.ok) return appended;
    result = { ok: true, outputs };
    break;
  }
  case 'array': {
    const array: JsonValue[] = [];
    for (const item of filter.items) {
      const itemResult = evaluate({ filter: item, input });
      if (!itemResult.ok) return clearFailureOutputs({ result: itemResult });
      const startIndex = array.length;
      if (!appendJqValues({
        target: array,
        source: itemResult.outputs,
        maximum: JQ_MAX_MATERIALIZED_VALUE_LENGTH,
      })) {
        return runtimeError({
          message: `array materialization exceeds limit ${JQ_MAX_MATERIALIZED_VALUE_LENGTH}`,
          value: undefined,
        });
      }
      for (let index = 0; index < itemResult.outputs.length; index += 1) {
        setJsonChildNumberOrigin({
          container: array,
          key: startIndex + index,
          origin: itemResult.outputMetadata?.[index]?.numberOrigin,
        });
      }
    }
    result = {
      ok: true,
      outputs: [array],
      outputMetadata: [metadataWithNumberOrigin({
        metadata: context.inputState.currentMetadata,
        numberOrigin: undefined,
      })],
    };
    break;
  }
  case 'object': {
    type ObjectFrame = {
      readonly value: { [key: string]: JsonValue },
      readonly metadata: JqRuntimeInputMetadata,
    };
    let objects: ObjectFrame[] = [{
      value: createJsonObject(),
      metadata: context.inputState.currentMetadata,
    }];
    let pendingFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;

    for (const entry of filter.entries) {
      if (objects.length === 0) break;
      const next: ObjectFrame[] = [];
      let entryFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;

      objectLoop:
      for (const object of objects) {
        context.inputState.currentMetadata = object.metadata;
        const keys = (() => {
          switch (entry.key.kind) {
          case 'static':
            return { ok: true as const, outputs: [entry.key.value] as JsonValue[] };
          case 'dynamic':
            return evaluate({ filter: entry.key.filter, input });
          default: {
            const _ex: never = entry.key;
            throw new Error(`Unhandled jq object key: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
          }
          }
        })();
        const keyOutputs = keys.ok ? keys.outputs : failureOutputs({ result: keys });
        const keyFallbackMetadata = context.inputState.currentMetadata;

        for (let keyIndex = 0; keyIndex < keyOutputs.length; keyIndex += 1) {
          const keyValue = keyOutputs[keyIndex]!;
          const keyMetadata = metadataForResultOutput({
            result: keys,
            index: keyIndex,
            fallback: keyFallbackMetadata,
          });
          context.inputState.currentMetadata = keyMetadata;
          const values = evaluate({ filter: entry.value, input });
          const valueOutputs = values.ok ? values.outputs : failureOutputs({ result: values });
          const valueFallbackMetadata = context.inputState.currentMetadata;
          if (typeof keyValue !== 'string') {
            if (valueOutputs.length > 0) {
              entryFailure = runtimeError({
                message: formatJqObjectKeyError({
                  key: keyValue,
                  numberOrigin: keyMetadata.numberOrigin,
                }),
                value: undefined,
              });
              break objectLoop;
            }
            if (!values.ok) {
              entryFailure = clearFailureOutputs({ result: values });
              break objectLoop;
            }
            continue;
          }
          const key = keyValue;
          if (keys.ok && keyOutputs.length === 1 && values.ok && valueOutputs.length === 1) {
            // A single-output frame has no sibling that could observe this object,
            // so it can be extended in place. Branching and failure paths below clone.
            if (next.length >= context.limits.maxOutputs) {
              return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
            }
            const valueMetadata = metadataForResultOutput({
              result: values,
              index: 0,
              fallback: valueFallbackMetadata,
            });
            defineJsonProperty({ object: object.value, key, value: valueOutputs[0]! });
            setJsonChildNumberOrigin({
              container: object.value,
              key,
              origin: valueMetadata.numberOrigin,
            });
            next.push({
              value: object.value,
              metadata: metadataWithNumberOrigin({
                metadata: valueMetadata,
                numberOrigin: undefined,
              }),
            });
            continue;
          }
          for (let valueIndex = 0; valueIndex < valueOutputs.length; valueIndex += 1) {
            if (next.length >= context.limits.maxOutputs) {
              return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
            }
            const clone = mergeJsonObjects({ left: object.value, right: createJsonObject() });
            defineJsonProperty({ object: clone, key, value: valueOutputs[valueIndex]! });
            const valueMetadata = metadataForResultOutput({
              result: values,
              index: valueIndex,
              fallback: valueFallbackMetadata,
            });
            setJsonChildNumberOrigin({
              container: clone,
              key,
              origin: valueMetadata.numberOrigin,
            });
            next.push({
              value: clone,
              metadata: metadataWithNumberOrigin({
                metadata: valueMetadata,
                numberOrigin: undefined,
              }),
            });

          }
          if (!values.ok) {
            entryFailure = clearFailureOutputs({ result: values });
            break objectLoop;
          }
        }
        if (!keys.ok) {
          entryFailure = clearFailureOutputs({ result: keys });
          break objectLoop;
        }
      }

      objects = next;
      if (entryFailure !== undefined) pendingFailure = entryFailure;
    }

    const outputs = objects.map(({ value }) => value);
    const outputMetadata = objects.map(({ metadata }) => metadata);
    result = pendingFailure === undefined
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: pendingFailure, outputs, outputMetadata });
    break;
  }
  case 'call': {
    const lazyStreamResult = evaluateLazyStreamConsumerCall({
      filter,
      input,
      context,
    });
    if (lazyStreamResult !== undefined) {
      result = lazyStreamResult;
      break;
    }
    const builtinResult = evaluateBuiltin({
      name: filter.name,
      args: filter.args,
      input,
      evaluate,
      takeInputs: ({ maximumValues, eofBehavior }) => takeRuntimeInputs({
        context,
        maximumValues,
        eofBehavior,
      }),
      inputMetadata: context.inputState.currentMetadata,
      evaluateFirstOutput: evaluateFirstVisitedOutput,
      emitStderr: ({ text }) => {
        context.state.stderr.push(text);
      },
    });
    if (builtinResult.outputMetadata !== undefined) {
      result = builtinResult;
      break;
    }
    const outputCount = builtinResult.ok
      ? builtinResult.outputs.length
      : builtinResult.outputs?.length ?? 0;
    const outputMetadata = Array.from(
      { length: outputCount },
      () => metadataWithNumberOrigin({
        metadata: context.inputState.currentMetadata,
        numberOrigin: undefined,
      }),
    );
    result = builtinResult.ok
      ? { ...builtinResult, outputMetadata }
      : outputMetadata.length === 0
        ? builtinResult
        : { ...builtinResult, outputMetadata };
    break;
  }
  case 'unresolved_user_call':
    result = runtimeError({
      message: `${filter.name}/${filter.args.length} is not defined`,
      value: undefined,
    });
    break;
  case 'user_call': {
    if (context.userDefinitionCallDepth >= JQ_MAX_USER_DEFINITION_CALL_DEPTH) {
      result = runtimeError({ message: 'maximum jq evaluation depth exceeded', value: undefined });
      break;
    }
    const definition = context.userDefinitions.get(filter.definitionId);
    if (definition === undefined) {
      result = runtimeError({
        message: `user-defined filter id ${filter.definitionId} is not registered`,
        value: undefined,
      });
      break;
    }
    result = evaluateJqFilterWithContext({
      filter: instantiateJqUserDefinition({ definition, args: filter.args }),
      input,
      context: {
        ...nestedContext,
        userDefinitionCallDepth: context.userDefinitionCallDepth + 1,
      },
    });
    break;
  }
  case 'binary': {
    const structuralLimit = checkRequiredLeftSpineDepth({ filter, context, kind: 'binary' });
    if (!structuralLimit.ok) return structuralLimit;
    const left = evaluate({ filter: filter.left, input });
    const leftOutputs = left.ok ? left.outputs : failureOutputs({ result: left });
    const leftFallbackMetadata = context.inputState.currentMetadata;
    const shortCircuitOperator = booleanShortCircuitOperator({ operator: filter.operator });
    if (shortCircuitOperator !== undefined) {
      const outputs: JsonValue[] = [];
      const outputMetadata: JqRuntimeInputMetadata[] = [];
      for (let leftIndex = 0; leftIndex < leftOutputs.length; leftIndex += 1) {
        const leftValue = leftOutputs[leftIndex]!;
        const leftMetadata = metadataForResultOutput({
          result: left,
          index: leftIndex,
          fallback: leftFallbackMetadata,
        });
        const leftIsTruthy = truthy({ value: leftValue });
        const shortCircuitOutput = (() => {
          switch (shortCircuitOperator) {
          case 'and':
            return leftIsTruthy ? undefined : false;
          case 'or':
            return leftIsTruthy ? true : undefined;
          default: {
            const _ex: never = shortCircuitOperator;
            throw new Error(`Unhandled jq boolean operator: ${_ex}`);
          }
          }
        })();
        if (shortCircuitOutput !== undefined) {
          outputs.push(shortCircuitOutput);
          outputMetadata.push(metadataWithNumberOrigin({
            metadata: leftMetadata,
            numberOrigin: undefined,
          }));
          continue;
        }

        context.inputState.currentMetadata = leftMetadata;
        const right = evaluate({ filter: filter.right, input });
        const rightOutputs = right.ok ? right.outputs : failureOutputs({ result: right });
        const rightFallbackMetadata = context.inputState.currentMetadata;
        for (let rightIndex = 0; rightIndex < rightOutputs.length; rightIndex += 1) {
          outputs.push(truthy({ value: rightOutputs[rightIndex]! }));
          outputMetadata.push(metadataWithNumberOrigin({
            metadata: metadataForResultOutput({
              result: right,
              index: rightIndex,
              fallback: rightFallbackMetadata,
            }),
            numberOrigin: undefined,
          }));
          if (outputs.length > context.limits.maxOutputs) {
            return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
          }
        }
        if (!right.ok) {
          return replaceFailureOutputs({ result: right, outputs, outputMetadata });
        }
      }
      result = left.ok
        ? { ok: true, outputs, outputMetadata }
        : replaceFailureOutputs({ result: left, outputs, outputMetadata });
      break;
    }
    if (isAlternativeOperator({ operator: filter.operator })) {
      const truthyOutputs: JsonValue[] = [];
      const outputMetadata: JqRuntimeInputMetadata[] = [];
      for (let index = 0; index < leftOutputs.length; index += 1) {
        const value = leftOutputs[index]!;
        if (!truthy({ value })) continue;
        truthyOutputs.push(value);
        outputMetadata.push(metadataForResultOutput({
          result: left,
          index,
          fallback: leftFallbackMetadata,
        }));
      }
      if (!left.ok) {
        result = replaceFailureOutputs({ result: left, outputs: truthyOutputs, outputMetadata });
      } else {
        result = truthyOutputs.length > 0
          ? { ok: true, outputs: truthyOutputs, outputMetadata }
          : evaluate({ filter: filter.right, input });
      }
      break;
    }
    const right = evaluate({ filter: filter.right, input });
    const rightOutputs = right.ok ? right.outputs : failureOutputs({ result: right });
    const rightFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let rightIndex = 0; rightIndex < rightOutputs.length; rightIndex += 1) {
      const rightValue = rightOutputs[rightIndex]!;
      for (let leftIndex = 0; leftIndex < leftOutputs.length; leftIndex += 1) {
        const leftValue = leftOutputs[leftIndex]!;
        const leftMetadata = metadataForResultOutput({
          result: left,
          index: leftIndex,
          fallback: leftFallbackMetadata,
        });
        const rightMetadata = metadataForResultOutput({
          result: right,
          index: rightIndex,
          fallback: rightFallbackMetadata,
        });
        const pair = evaluateBinaryPair({
          operator: filter.operator,
          left: leftValue,
          right: rightValue,
          leftOrigin: leftMetadata.numberOrigin,
          rightOrigin: rightMetadata.numberOrigin,
        });
        if (!pair.ok) {
          return replaceFailureOutputs({ result: pair, outputs, outputMetadata });
        }
        outputs.push(pair.value);
        const sourceMetadata = rightOutputs.length > 1 || leftOutputs.length <= 1
          ? rightMetadata
          : leftMetadata;
        outputMetadata.push(metadataWithNumberOrigin({
          metadata: sourceMetadata,
          numberOrigin: pair.numberOrigin,
        }));
      }
    }
    result = !left.ok
      ? replaceFailureOutputs({ result: left, outputs, outputMetadata })
      : !right.ok
        ? replaceFailureOutputs({ result: right, outputs, outputMetadata })
        : { ok: true, outputs, outputMetadata };
    break;
  }
  case 'unary': {
    const values = evaluate({ filter: filter.value, input });
    const valueOutputs = values.ok ? values.outputs : failureOutputs({ result: values });
    const valuesFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let index = 0; index < valueOutputs.length; index += 1) {
      const value = valueOutputs[index]!;
      switch (filter.operator) {
      case 'not':
        outputs.push(!truthy({ value }));
        break;
      case 'neg':
        if (typeof value !== 'number') {
          const compactValue = stringifyJson({
            value,
            indentation: undefined,
            sortKeys: false,
            asciiOnly: false,
          });
          return replaceFailureOutputs({
            result: runtimeError({
              message: `${jqValueTypeName({ value })} (${compactValue}) cannot be negated`,
              value: undefined,
            }),
            outputs,
            outputMetadata,
          });
        }
        outputs.push(-value);
        break;
      default:
        throw new Error('Unhandled unary operator');
      }
      outputMetadata.push(metadataWithNumberOrigin({
        metadata: metadataForResultOutput({
          result: values,
          index,
          fallback: valuesFallbackMetadata,
        }),
        numberOrigin: undefined,
      }));
    }
    result = values.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: values, outputs, outputMetadata });
    break;
  }
  case 'bind': {
    type BindFilter = Extract<JqFilter, { kind: 'bind' }>;
    type BindContinuation = {
      readonly filter: BindFilter,
      readonly nestedContext: JqRuntimeContext,
      readonly binding: JqRuntimeResult,
      readonly bindingOutputs: readonly JsonValue[],
      readonly bindingFallbackMetadata: JqRuntimeInputMetadata,
      readonly nextIndex: number,
      readonly outputs: JsonValue[],
      readonly outputMetadata: JqRuntimeInputMetadata[],
      readonly outputContext: JqRuntimeContext,
    };
    type BindTask =
      | {
        readonly kind: 'evaluate',
        readonly filter: JqFilter,
        readonly context: JqRuntimeContext,
        readonly limitChecked: boolean,
      }
      | { readonly kind: 'continue', readonly continuation: BindContinuation }
      | { readonly kind: 'after_body', readonly continuation: BindContinuation };

    const tasks: BindTask[] = [{
      kind: 'evaluate',
      filter,
      context,
      limitChecked: true,
    }];
    const results: JqRuntimeResult[] = [];
    while (tasks.length > 0) {
      const task = tasks.pop()!;
      switch (task.kind) {
      case 'evaluate': {
        switch (task.filter.kind) {
        case 'bind': {
          if (!task.limitChecked) {
            const structuralLimit = checkLimits({ context: task.context });
            if (!structuralLimit.ok) return structuralLimit;
          }
          const bindNestedContext: JqRuntimeContext = {
            ...task.context,
            depth: task.context.depth + 1,
          };
          const bindingFallbackMetadata = bindNestedContext.inputState.currentMetadata;
          const binding = evaluateJqFilterWithContext({
            filter: task.filter.binding,
            input,
            context: bindNestedContext,
          });
          tasks.push({
            kind: 'continue',
            continuation: {
              filter: task.filter,
              nestedContext: bindNestedContext,
              binding,
              bindingOutputs: binding.ok ? binding.outputs : failureOutputs({ result: binding }),
              bindingFallbackMetadata,
              nextIndex: 0,
              outputs: [],
              outputMetadata: [],
              outputContext: task.context,
            },
          });
          break;
        }
        case 'identity':
        case 'variable':
        case 'literal':
        case 'string':
        case 'array':
        case 'object':
        case 'field':
        case 'index':
        case 'dynamic_index':
        case 'slice':
        case 'iterate':
        case 'recursive_descent':
        case 'optional':
        case 'pipe':
        case 'comma':
        case 'conditional':
        case 'trycatch':
        case 'call':
        case 'user_call':
        case 'unresolved_user_call':
        case 'binary':
        case 'unary':
        case 'label':
        case 'break':
        case 'reduce':
        case 'foreach':
        case 'assign':
        case 'update':
          results.push(evaluateJqFilterWithContext({
            filter: task.filter,
            input,
            context: task.context,
          }));
          break;
        default: {
          const _ex: never = task.filter;
          throw new Error(`Unhandled jq binding filter: ${JSON.stringify(_ex)}`);
        }
        }
        break;
      }
      case 'continue': {
        const current = task.continuation;
        if (current.nextIndex >= current.bindingOutputs.length) {
          results.push(current.binding.ok
            ? { ok: true, outputs: current.outputs, outputMetadata: current.outputMetadata }
            : replaceFailureOutputs({
              result: current.binding,
              outputs: current.outputs,
              outputMetadata: current.outputMetadata,
            }));
          break;
        }
        const boundValue = current.bindingOutputs[current.nextIndex]!;
        current.nestedContext.inputState.currentMetadata = metadataForResultOutput({
          result: current.binding,
          index: current.nextIndex,
          fallback: current.bindingFallbackMetadata,
        });
        const nextContinuation: BindContinuation = {
          ...current,
          nextIndex: current.nextIndex + 1,
        };
        tasks.push({ kind: 'after_body', continuation: nextContinuation });
        tasks.push({
          kind: 'evaluate',
          filter: current.filter.body,
          context: {
            ...current.nestedContext,
            variables: {
              ...current.nestedContext.variables,
              [current.filter.name]: boundValue,
            },
            variableNumberOrigins: {
              ...current.nestedContext.variableNumberOrigins,
              [current.filter.name]: typeof boundValue === 'number'
                ? current.nestedContext.inputState.currentMetadata.numberOrigin
                : undefined,
            },
          },
          limitChecked: false,
        });
        break;
      }
      case 'after_body': {
        const scoped = results.pop();
        if (scoped === undefined) throw new Error('jq binding result stack is empty');
        const scopedOutputs = scoped.ok ? scoped.outputs : failureOutputs({ result: scoped });
        const scopedFallbackMetadata = task.continuation.nestedContext.inputState.currentMetadata;
        const appended = appendRuntimeOutputs({
          target: task.continuation.outputs,
          source: scopedOutputs,
          context: task.continuation.outputContext,
        });
        if (!appended.ok) return appended;
        appendRuntimeMetadata({
          target: task.continuation.outputMetadata,
          result: scoped,
          outputCount: scopedOutputs.length,
          fallback: scopedFallbackMetadata,
        });
        if (!scoped.ok) {
          results.push(replaceFailureOutputs({
            result: scoped,
            outputs: task.continuation.outputs,
            outputMetadata: task.continuation.outputMetadata,
          }));
          break;
        }
        tasks.push({ kind: 'continue', continuation: task.continuation });
        break;
      }
      default: {
        const _ex: never = task;
        throw new Error(`Unhandled jq binding task: ${JSON.stringify(_ex)}`);
      }
      }
    }
    if (results.length !== 1) {
      throw new Error(`jq binding evaluation produced ${results.length} results`);
    }
    result = results[0]!;
    break;
  }
  case 'break': {
    const breakValue = createJsonObject();
    defineJsonProperty({ object: breakValue, key: '__jq', value: filter.id });
    result = {
      ok: false,
      error: {
        message: `break $${filter.name}`,
        value: breakValue,
        breakLabelId: filter.id,
      },
      outputs: [],
    };
    break;
  }
  case 'label': {
    const attempted = evaluate({ filter: filter.body, input });
    result = !attempted.ok && attempted.error.breakLabelId === filter.id
      ? { ok: true, outputs: failureOutputs({ result: attempted }) }
      : attempted;
    break;
  }
  case 'reduce': {
    // `reduce` has an atomic result for each initial-state branch, but the
    // initial filter itself is a jq stream. Reuse the visitor so each initial
    // output starts its own generator evaluation in demand order, sharing the
    // input cursor and metadata exactly like lazy consumers do.
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqFilterOutputsWithContext({
      filter,
      input,
      context,
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: false };
      },
    });
    result = visited.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: visited, outputs, outputMetadata });
    break;
  }
  case 'foreach': {
    // `foreach` evaluates its initial state before starting the generator. The
    // output visitor already preserves that order together with generator
    // cancellation, shared input demand, metadata, and published failure
    // prefixes. Reuse it at top level instead of materializing the generator
    // first in the eager path.
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    const visited = visitJqFilterOutputsWithContext({
      filter,
      input,
      context,
      consume: ({ value, metadata }) => {
        if (outputs.length >= context.limits.maxOutputs) {
          return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
        }
        outputs.push(value);
        outputMetadata.push(metadata);
        return { ok: true, stopped: false };
      },
    });
    result = visited.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: visited, outputs, outputMetadata });
    break;
  }
  case 'assign': {
    type AssignmentFrame = { readonly paths: readonly JqPath[] };
    const frames: AssignmentFrame[] = [];
    let assignmentFilter: JqFilter = filter;
    let assignmentContext = context;
    let limitChecked = true;

    while (assignmentFilter.kind === 'assign') {
      if (!limitChecked) {
        const structuralLimit = checkLimits({ context: assignmentContext });
        if (!structuralLimit.ok) return structuralLimit;
      }
      const assignmentNestedContext: JqRuntimeContext = {
        ...assignmentContext,
        depth: assignmentContext.depth + 1,
      };
      let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
      const materialized = materializeJqPathExpression({
        root: input,
        expression: assignmentFilter.pathExpression,
        evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
          const evaluated = evaluateJqFilterWithContext({
            filter: indexFilter,
            input: indexInput,
            context: assignmentNestedContext,
          });
          if (evaluated.ok) return evaluated;
          dynamicPathFailure = evaluated;
          return { ok: false, message: evaluated.error.message };
        },
      });
      if (!materialized.ok) {
        return dynamicPathFailure === undefined
          ? runtimeError({ message: materialized.message, value: undefined })
          : clearFailureOutputs({ result: dynamicPathFailure });
      }
      frames.push({ paths: materialized.paths });
      assignmentFilter = assignmentFilter.value;
      assignmentContext = assignmentNestedContext;
      limitChecked = false;
    }

    let values = evaluateJqFilterWithContext({
      filter: assignmentFilter,
      input,
      context: assignmentContext,
    });
    for (let frameIndex = frames.length - 1; frameIndex >= 0; frameIndex -= 1) {
      const frame = frames[frameIndex]!;
      const valueOutputs = values.ok ? values.outputs : failureOutputs({ result: values });
      const valueFallbackMetadata = context.inputState.currentMetadata;
      const outputs: JsonValue[] = [];
      const outputMetadata: JqRuntimeInputMetadata[] = [];
      for (let valueIndex = 0; valueIndex < valueOutputs.length; valueIndex += 1) {
        const value = valueOutputs[valueIndex]!;
        const valueMetadata = metadataForResultOutput({
          result: values,
          index: valueIndex,
          fallback: valueFallbackMetadata,
        });
        let assignedRoot = input;
        let assignedRootOrigin = context.inputState.currentMetadata.numberOrigin;
        for (const path of frame.paths) {
          const assigned = applyPathUpdate({
            root: assignedRoot,
            path,
            update: () => ({
              ok: true,
              value,
              numberOrigin: typeof value === 'number' ? valueMetadata.numberOrigin : undefined,
            }),
          });
          if (!assigned.ok) return runtimeError({ message: assigned.message, value: undefined });
          assignedRoot = assigned.value;
          assignedRootOrigin = assigned.numberOrigin;
        }
        outputs.push(assignedRoot);
        outputMetadata.push(metadataWithNumberOrigin({
          metadata: valueMetadata,
          numberOrigin: typeof assignedRoot === 'number' ? assignedRootOrigin : undefined,
        }));
      }
      values = values.ok
        ? values.outputMetadata === undefined
          ? { ok: true, outputs }
          : { ok: true, outputs, outputMetadata }
        : replaceFailureOutputs({
          result: values,
          outputs,
          outputMetadata: values.outputMetadata === undefined ? undefined : outputMetadata,
        });
    }
    result = values;
    break;
  }
  case 'update': {
    let dynamicPathFailure: Extract<JqRuntimeResult, { ok: false }> | undefined;
    const materialized = materializeJqPathExpression({
      root: input,
      expression: filter.pathExpression,
      evaluateDynamicIndex: ({ filter: indexFilter, input: indexInput }) => {
        const evaluated = evaluate({ filter: indexFilter, input: indexInput });
        if (evaluated.ok) return evaluated;
        dynamicPathFailure = evaluated;
        return { ok: false, message: evaluated.error.message };
      },
    });
    if (!materialized.ok) {
      return dynamicPathFailure === undefined
        ? runtimeError({ message: materialized.message, value: undefined })
        : clearFailureOutputs({ result: dynamicPathFailure });
    }

    const compoundOperator = (() => {
      switch (filter.mode.kind) {
      case 'first':
        return undefined;
      case 'compound':
        return filter.mode.operator;
      default: {
        const _ex: never = filter.mode;
        throw new Error(`Unhandled jq update mode: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    })();
    if (compoundOperator === undefined) {
      let updatedRoot = input;
      let updatedMetadata: JqRuntimeInputMetadata | undefined;
      const deletionPaths = [];
      for (const path of materialized.paths) {
        const current = readJqPathValue({ root: updatedRoot, path });
        if (!current.ok) return runtimeError({ message: current.message, value: undefined });
        if (current.skipped) continue;
        context.inputState.currentMetadata = metadataWithNumberOrigin({
          metadata: context.inputState.currentMetadata,
          numberOrigin: current.numberOrigin,
        });
        const evaluated = evaluateFirstUpdateOutput({
          filter: filter.value,
          input: current.value ?? null,
        });
        if (!evaluated.ok) return evaluated;
        const first = evaluated.outputs[0];
        if (evaluated.outputMetadata?.[0] !== undefined) {
          updatedMetadata = evaluated.outputMetadata[0];
        }
        if (first === undefined) {
          deletionPaths.push(path);
          continue;
        }
        const firstMetadata = evaluated.outputMetadata?.[0] ?? context.inputState.currentMetadata;
        const updated = applyPathUpdate({
          root: updatedRoot,
          path,
          update: () => ({
            ok: true,
            value: first,
            numberOrigin: typeof first === 'number' ? firstMetadata.numberOrigin : undefined,
          }),
        });
        if (!updated.ok) return runtimeError({ message: updated.message, value: undefined });
        updatedRoot = updated.value;
      }
      const deleted = applyPathDeletions({ root: updatedRoot, paths: deletionPaths });
      result = deleted.ok
        ? updatedMetadata === undefined
          ? { ok: true, outputs: [deleted.value] }
          : { ok: true, outputs: [deleted.value], outputMetadata: [updatedMetadata] }
        : runtimeError({ message: deleted.message, value: undefined });
      break;
    }

    const right = evaluate({ filter: filter.value, input });
    const rightOutputs = right.ok ? right.outputs : failureOutputs({ result: right });
    const rightFallbackMetadata = context.inputState.currentMetadata;
    const outputs: JsonValue[] = [];
    const outputMetadata: JqRuntimeInputMetadata[] = [];
    for (let rightIndex = 0; rightIndex < rightOutputs.length; rightIndex += 1) {
      const rightValue = rightOutputs[rightIndex]!;
      const rightMetadata = metadataForResultOutput({
        result: right,
        index: rightIndex,
        fallback: rightFallbackMetadata,
      });
      let updatedRoot = input;
      let updatedRootOrigin = context.inputState.currentMetadata.numberOrigin;
      for (const path of materialized.paths) {
        const current = readJqPathValue({ root: updatedRoot, path });
        if (!current.ok) {
          return replaceFailureOutputs({
            result: runtimeError({ message: current.message, value: undefined }),
            outputs,
            outputMetadata,
          });
        }
        if (current.skipped) continue;
        const pair = evaluateBinaryPair({
          operator: compoundOperator,
          left: current.value ?? null,
          right: rightValue,
          leftOrigin: current.numberOrigin,
          rightOrigin: rightMetadata.numberOrigin,
        });
        if (!pair.ok) return replaceFailureOutputs({ result: pair, outputs, outputMetadata });
        const updated = applyPathUpdate({
          root: updatedRoot,
          path,
          update: () => ({
            ok: true,
            value: pair.value,
            numberOrigin: pair.numberOrigin,
          }),
        });
        if (!updated.ok) {
          return replaceFailureOutputs({
            result: runtimeError({ message: updated.message, value: undefined }),
            outputs,
            outputMetadata,
          });
        }
        updatedRoot = updated.value;
        updatedRootOrigin = updated.numberOrigin;
      }
      outputs.push(updatedRoot);
      outputMetadata.push(metadataWithNumberOrigin({
        metadata: rightMetadata,
        numberOrigin: typeof updatedRoot === 'number' ? updatedRootOrigin : undefined,
      }));
      if (outputs.length > context.limits.maxOutputs) {
        return runtimeError({ message: 'maximum jq output count exceeded', value: undefined });
      }
    }
    result = right.ok
      ? { ok: true, outputs, outputMetadata }
      : replaceFailureOutputs({ result: right, outputs, outputMetadata });
    break;
  }
  default: {
    const _ex: never = filter;
    throw new Error(`Unhandled jq filter: ${JSON.stringify(_ex)}`);
  }
  }

  if (!result.ok) return result;
  const outputLimit = checkOutputLimit({ outputs: result.outputs, context });
  return outputLimit.ok ? result : outputLimit;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  iterativeBranchYieldsAtMostOneOutput: jqIterativeBranchYieldsAtMostOneOutput,
};
