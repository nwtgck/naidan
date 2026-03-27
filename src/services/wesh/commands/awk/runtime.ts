import type { AwkExpression, AwkPattern, AwkProgram, AwkStatement, AwkValue } from './types';

type AwkStatementControl = 'normal' | 'next' | 'break' | 'continue_loop';

interface AwkRecord {
  text: string;
  fields: string[];
  hadNewline: boolean;
}

interface AwkRuntimeState {
  variables: Map<string, AwkValue>;
  arrays: Map<string, Map<string, AwkValue>>;
  currentRecord: AwkRecord | undefined;
  nr: number;
  fnr: number;
}

function isNumericLike({
  value,
}: {
  value: string;
}): boolean {
  return /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim());
}

function coerceToNumber({
  value,
}: {
  value: AwkValue;
}): number {
  switch (typeof value) {
  case 'number':
    return value;
  case 'string':
    return isNumericLike({ value }) ? Number(value) : 0;
  default:
    return 0;
  }
}

function coerceToString({
  value,
}: {
  value: AwkValue;
}): string {
  if (value instanceof RegExp) {
    return value.source;
  }

  return String(value);
}

function coerceToRegex({
  value,
}: {
  value: AwkValue;
}): RegExp {
  switch (typeof value) {
  case 'number':
    return new RegExp(String(value));
  case 'string':
    return new RegExp(value);
  default:
    return value;
  }
}

function isTruthy({
  value,
}: {
  value: AwkValue;
}): boolean {
  switch (typeof value) {
  case 'number':
    return value !== 0;
  case 'string':
    return value.length > 0 && value !== '0';
  default:
    return true;
  }
}

function splitFields({
  line,
  fieldSeparator,
}: {
  line: string;
  fieldSeparator: string;
}): string[] {
  if (fieldSeparator === ' ') {
    const trimmed = line.trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/);
  }

  if (fieldSeparator.length === 1) {
    return line.split(fieldSeparator);
  }

  return line.split(new RegExp(fieldSeparator));
}

function getVariable({
  state,
  name,
}: {
  state: AwkRuntimeState;
  name: string;
}): AwkValue {
  switch (name) {
  case 'NR':
    return state.nr;
  case 'FNR':
    return state.fnr;
  case 'NF':
    return state.currentRecord?.fields.length ?? 0;
  case 'FS':
  case 'OFS':
  case 'ORS':
    return state.variables.get(name) ?? '';
  default:
    return state.variables.get(name) ?? '';
  }
}

function getArrayValue({
  state,
  name,
  index,
}: {
  state: AwkRuntimeState;
  name: string;
  index: string;
}): AwkValue {
  return state.arrays.get(name)?.get(index) ?? '';
}

function requireArrayEntries({
  state,
  name,
}: {
  state: AwkRuntimeState;
  name: string;
}): Map<string, AwkValue> {
  const entries = state.arrays.get(name);
  if (entries === undefined) {
    throw new Error(`awk: '${name}' is not an array`);
  }
  return entries;
}

function setVariable({
  state,
  name,
  value,
}: {
  state: AwkRuntimeState;
  name: string;
  value: AwkValue;
}): void {
  state.variables.set(name, value);
}

function setCurrentRecordText({
  state,
  text,
}: {
  state: AwkRuntimeState;
  text: string;
}): void {
  if (state.currentRecord === undefined) {
    throw new Error('awk: no current record available');
  }

  const fieldSeparator = coerceToString({ value: getVariable({ state, name: 'FS' }) });
  state.currentRecord = {
    ...state.currentRecord,
    text,
    fields: splitFields({
      line: text,
      fieldSeparator,
    }),
  };
}

function setFieldValue({
  state,
  index,
  value,
}: {
  state: AwkRuntimeState;
  index: number;
  value: string;
}): void {
  if (state.currentRecord === undefined) {
    throw new Error('awk: no current record available');
  }

  const fields = [...state.currentRecord.fields];
  while (fields.length < index) {
    fields.push('');
  }
  fields[index - 1] = value;

  const outputFieldSeparator = coerceToString({ value: getVariable({ state, name: 'OFS' }) });
  state.currentRecord = {
    ...state.currentRecord,
    fields,
    text: fields.join(outputFieldSeparator),
  };
}

function setArrayValue({
  state,
  name,
  index,
  value,
}: {
  state: AwkRuntimeState;
  name: string;
  index: string;
  value: AwkValue;
}): void {
  let entries = state.arrays.get(name);
  if (entries === undefined) {
    entries = new Map<string, AwkValue>();
    state.arrays.set(name, entries);
  }
  entries.set(index, value);
}

function clearArray({
  state,
  name,
}: {
  state: AwkRuntimeState;
  name: string;
}): Map<string, AwkValue> {
  const entries = new Map<string, AwkValue>();
  state.arrays.set(name, entries);
  return entries;
}

function applyAwkReplacement({
  replacement,
  match,
}: {
  replacement: string;
  match: string;
}): string {
  let output = '';

  for (let index = 0; index < replacement.length; index += 1) {
    const char = replacement[index];
    const nextChar = replacement[index + 1];

    if (char === '\\' && nextChar !== undefined) {
      if (nextChar === '&' || nextChar === '\\') {
        output += nextChar;
        index += 1;
        continue;
      }
    }

    if (char === '&') {
      output += match;
      continue;
    }

    output += char;
  }

  return output;
}

function replaceInText({
  source,
  pattern,
  replacement,
  mode,
}: {
  source: string;
  pattern: RegExp;
  replacement: string;
  mode: 'first' | 'global';
}): { text: string; count: number } {
  const flags = [...new Set(pattern.flags.split(''))].join('');
  const regexFlags = (() => {
    switch (mode) {
    case 'global':
      return [...new Set(`${flags}g`.split(''))].join('');
    case 'first':
      return flags.replace(/g/g, '');
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled substitution mode: ${_ex}`);
    }
    }
  })();
  const regex = new RegExp(pattern.source, regexFlags);

  let count = 0;
  const text = source.replace(regex, (matched) => {
    count += 1;
    if (mode === 'first' && count > 1) {
      return matched;
    }
    return applyAwkReplacement({
      replacement,
      match: matched,
    });
  });

  const normalizedCount = (() => {
    switch (mode) {
    case 'first':
      return Math.min(count, 1);
    case 'global':
      return count;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled substitution mode: ${_ex}`);
    }
    }
  })();

  return {
    text,
    count: normalizedCount,
  };
}

function applySubstitution({
  state,
  expression,
  mode,
}: {
  state: AwkRuntimeState;
  expression: Extract<AwkExpression, { kind: 'call' }>;
  mode: 'first' | 'global';
}): number {
  const pattern = coerceToRegex({
    value: evaluateExpression({
      expression: expression.args[0] ?? { kind: 'string', value: '' },
      state,
    }),
  });
  const replacement = coerceToString({
    value: evaluateExpression({
      expression: expression.args[1] ?? { kind: 'string', value: '' },
      state,
    }),
  });

  const targetExpression = expression.args[2];
  if (targetExpression === undefined) {
    const source = state.currentRecord?.text ?? '';
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setCurrentRecordText({
      state,
      text: result.text,
    });
    return result.count;
  }

  switch (targetExpression.kind) {
  case 'identifier': {
    const source = coerceToString({
      value: getVariable({
        state,
        name: targetExpression.name,
      }),
    });
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setVariable({
      state,
      name: targetExpression.name,
      value: result.text,
    });
    return result.count;
  }
  case 'indexed': {
    const index = coerceToString({
      value: evaluateExpression({
        expression: targetExpression.index,
        state,
      }),
    });
    const source = coerceToString({
      value: getArrayValue({
        state,
        name: targetExpression.name,
        index,
      }),
    });
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setArrayValue({
      state,
      name: targetExpression.name,
      index,
      value: result.text,
    });
    return result.count;
  }
  case 'field': {
    if (targetExpression.index === 0) {
      const source = state.currentRecord?.text ?? '';
      const result = replaceInText({
        source,
        pattern,
        replacement,
        mode,
      });
      setCurrentRecordText({
        state,
        text: result.text,
      });
      return result.count;
    }

    const source = state.currentRecord?.fields[targetExpression.index - 1] ?? '';
    const result = replaceInText({
      source,
      pattern,
      replacement,
      mode,
    });
    setFieldValue({
      state,
      index: targetExpression.index,
      value: result.text,
    });
    return result.count;
  }
  default:
    throw new Error("awk: sub requires a variable, field, or array element as its third argument");
  }
}

function deleteArrayEntry({
  state,
  name,
  index,
}: {
  state: AwkRuntimeState;
  name: string;
  index: string;
}): void {
  state.arrays.get(name)?.delete(index);
}

function updateTarget({
  state,
  target,
  operator,
  position,
}: {
  state: AwkRuntimeState;
  target: Extract<AwkExpression, { kind: 'update' }>['target'];
  operator: Extract<AwkExpression, { kind: 'update' }>['operator'];
  position: Extract<AwkExpression, { kind: 'update' }>['position'];
}): AwkValue {
  const delta = (() => {
    switch (operator) {
    case '++':
      return 1;
    case '--':
      return -1;
    default: {
      const _ex: never = operator;
      throw new Error(`Unhandled awk update operator: ${_ex}`);
    }
    }
  })();

  const selectReturnValue = ({
    currentNumber,
    nextValue,
  }: {
    currentNumber: number;
    nextValue: number;
  }): number => {
    switch (position) {
    case 'prefix':
      return nextValue;
    case 'postfix':
      return currentNumber;
    default: {
      const _ex: never = position;
      throw new Error(`Unhandled awk update position: ${_ex}`);
    }
    }
  };

  switch (target.kind) {
  case 'variable': {
    const current = getVariable({ state, name: target.name });
    const currentNumber = coerceToNumber({ value: current });
    const nextValue = currentNumber + delta;
    setVariable({ state, name: target.name, value: nextValue });
    return selectReturnValue({ currentNumber, nextValue });
  }
  case 'indexed': {
    const index = coerceToString({
      value: evaluateExpression({
        expression: target.index,
        state,
      }),
    });
    const current = getArrayValue({
      state,
      name: target.name,
      index,
    });
    const currentNumber = coerceToNumber({ value: current });
    const nextValue = currentNumber + delta;
    setArrayValue({
      state,
      name: target.name,
      index,
      value: nextValue,
    });
    return selectReturnValue({ currentNumber, nextValue });
  }
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled awk update target: ${JSON.stringify(_ex)}`);
  }
  }
}

function formatPrintfOutput({
  format,
  argumentsList,
}: {
  format: string;
  argumentsList: AwkValue[];
}): string {
  let output = '';
  let argumentIndex = 0;

  for (let index = 0; index < format.length; index += 1) {
    const char = format[index];
    if (char !== '%') {
      output += char;
      continue;
    }

    const nextChar = format[index + 1];
    if (nextChar === undefined) {
      throw new Error("awk: incomplete printf format specifier");
    }

    if (nextChar === '%') {
      output += '%';
      index += 1;
      continue;
    }

    const argument = argumentsList[argumentIndex];
    argumentIndex += 1;
    switch (nextChar) {
    case 's':
      output += coerceToString({ value: argument ?? '' });
      break;
    case 'd':
    case 'i':
      output += String(Math.trunc(coerceToNumber({ value: argument ?? 0 })));
      break;
    case 'f':
      output += coerceToNumber({ value: argument ?? 0 }).toFixed(6);
      break;
    case 'c': {
      const code = Math.trunc(coerceToNumber({ value: argument ?? 0 }));
      output += String.fromCodePoint(code);
      break;
    }
    default:
      throw new Error(`awk: unsupported printf format '%${nextChar}'`);
    }
    index += 1;
  }

  return output;
}

function executeForClausePart({
  part,
  state,
}: {
  part: Extract<AwkStatement, { kind: 'for' }>['initializer'];
  state: AwkRuntimeState;
}): void {
  if (part === undefined) return;

  switch (part.kind) {
  case 'assign': {
    const value = evaluateExpression({ expression: part.expression, state });
    switch (part.target.kind) {
    case 'variable':
      setVariable({ state, name: part.target.name, value });
      return;
    case 'indexed':
      setArrayValue({
        state,
        name: part.target.name,
        index: coerceToString({
          value: evaluateExpression({
            expression: part.target.index,
            state,
          }),
        }),
        value,
      });
      return;
    default: {
      const _ex: never = part.target;
      throw new Error(`Unhandled awk for assignment target: ${JSON.stringify(_ex)}`);
    }
    }
  }
  case 'expression':
    evaluateExpression({ expression: part.expression, state });
    return;
  default: {
    const _ex: never = part;
    throw new Error(`Unhandled awk for clause part: ${JSON.stringify(_ex)}`);
  }
  }
}

function evaluateExpression({
  expression,
  state,
}: {
  expression: AwkExpression;
  state: AwkRuntimeState;
}): AwkValue {
  switch (expression.kind) {
  case 'number':
    return expression.value;
  case 'string':
    return expression.value;
  case 'regex':
    return expression.value;
  case 'identifier':
    return getVariable({ state, name: expression.name });
  case 'indexed':
    return getArrayValue({
      state,
      name: expression.name,
      index: coerceToString({
        value: evaluateExpression({
          expression: expression.index,
          state,
        }),
      }),
    });
  case 'field': {
    if (expression.index === 0) {
      return state.currentRecord?.text ?? '';
    }
    return state.currentRecord?.fields[expression.index - 1] ?? '';
  }
  case 'call': {
    const args = expression.args.map((argument) =>
      evaluateExpression({
        expression: argument,
        state,
      }));

    switch (expression.callee) {
    case 'length': {
      const target = args[0] ?? (state.currentRecord?.text ?? '');
      return coerceToString({ value: target }).length;
    }
    case 'index': {
      const source = coerceToString({ value: args[0] ?? '' });
      const needle = coerceToString({ value: args[1] ?? '' });
      if (needle.length === 0) return 1;
      const position = source.indexOf(needle);
      return position === -1 ? 0 : position + 1;
    }
    case 'substr': {
      const source = coerceToString({ value: args[0] ?? '' });
      const start = Math.max(1, Math.trunc(coerceToNumber({ value: args[1] ?? 1 })));
      const length = args[2] === undefined ? undefined : Math.max(0, Math.trunc(coerceToNumber({ value: args[2] })));
      const startIndex = start - 1;
      return length === undefined ? source.slice(startIndex) : source.slice(startIndex, startIndex + length);
    }
    case 'tolower':
      return coerceToString({ value: args[0] ?? '' }).toLowerCase();
    case 'toupper':
      return coerceToString({ value: args[0] ?? '' }).toUpperCase();
    case 'match': {
      const source = coerceToString({ value: args[0] ?? '' });
      const pattern = coerceToRegex({ value: args[1] ?? '' });
      const matched = source.match(pattern);
      if (matched === null || matched.index === undefined) {
        setVariable({ state, name: 'RSTART', value: 0 });
        setVariable({ state, name: 'RLENGTH', value: -1 });
        return 0;
      }
      setVariable({ state, name: 'RSTART', value: matched.index + 1 });
      setVariable({ state, name: 'RLENGTH', value: matched[0].length });
      return matched.index + 1;
    }
    case 'sub':
      return applySubstitution({ state, expression, mode: 'first' });
    case 'gsub':
      return applySubstitution({ state, expression, mode: 'global' });
    case 'split': {
      const source = coerceToString({ value: args[0] ?? '' });
      const targetExpression = expression.args[1];
      if (targetExpression === undefined || targetExpression.kind !== 'identifier') {
        throw new Error("awk: split requires an array variable as its second argument");
      }
      const separator = expression.args[2] === undefined
        ? coerceToString({ value: getVariable({ state, name: 'FS' }) })
        : coerceToString({
          value: evaluateExpression({
            expression: expression.args[2],
            state,
          }),
        });
      const parts = splitFields({
        line: source,
        fieldSeparator: separator,
      });
      const entries = clearArray({
        state,
        name: targetExpression.name,
      });
      for (const [index, part] of parts.entries()) {
        entries.set(String(index + 1), part);
      }
      return parts.length;
    }
    default:
      throw new Error(`awk: unsupported builtin function '${expression.callee}'`);
    }
  }
  case 'update':
    return updateTarget({
      state,
      target: expression.target,
      operator: expression.operator,
      position: expression.position,
    });
  case 'binary': {
    const left = evaluateExpression({ expression: expression.left, state });
    const right = evaluateExpression({ expression: expression.right, state });

    switch (expression.operator) {
    case 'concat':
      return `${coerceToString({ value: left })}${coerceToString({ value: right })}`;
    case '||':
      return isTruthy({ value: left }) || isTruthy({ value: right }) ? 1 : 0;
    case '&&':
      return isTruthy({ value: left }) && isTruthy({ value: right }) ? 1 : 0;
    case 'in': {
      const index = coerceToString({ value: left });
      switch (expression.right.kind) {
      case 'identifier':
        return requireArrayEntries({
          state,
          name: expression.right.name,
        }).has(index) ? 1 : 0;
      default:
        throw new Error("awk: right operand of 'in' must be an array variable");
      }
    }
    case '+':
      return coerceToNumber({ value: left }) + coerceToNumber({ value: right });
    case '-':
      return coerceToNumber({ value: left }) - coerceToNumber({ value: right });
    case '*':
      return coerceToNumber({ value: left }) * coerceToNumber({ value: right });
    case '==':
      return compareValues({ left, right }) === 0 ? 1 : 0;
    case '!=':
      return compareValues({ left, right }) !== 0 ? 1 : 0;
    case '<':
      return compareValues({ left, right }) < 0 ? 1 : 0;
    case '<=':
      return compareValues({ left, right }) <= 0 ? 1 : 0;
    case '>':
      return compareValues({ left, right }) > 0 ? 1 : 0;
    case '>=':
      return compareValues({ left, right }) >= 0 ? 1 : 0;
    case '~':
      return coerceToRegex({ value: right }).test(coerceToString({ value: left })) ? 1 : 0;
    case '!~':
      return coerceToRegex({ value: right }).test(coerceToString({ value: left })) ? 0 : 1;
    }
    throw new Error('Unreachable awk binary operator');
  }
  case 'unary':
    switch (expression.operator) {
    case '!':
      return isTruthy({
        value: evaluateExpression({
          expression: expression.expression,
          state,
        }),
      }) ? 0 : 1;
    }
    throw new Error('Unreachable awk unary operator');
  default: {
    const _ex: never = expression;
    throw new Error(`Unhandled awk expression: ${JSON.stringify(_ex)}`);
  }
  }
}

function compareValues({
  left,
  right,
}: {
  left: AwkValue;
  right: AwkValue;
}): number {
  const leftString = coerceToString({ value: left });
  const rightString = coerceToString({ value: right });
  if (isNumericLike({ value: leftString }) && isNumericLike({ value: rightString })) {
    const leftNumber = Number(leftString);
    const rightNumber = Number(rightString);
    if (leftNumber === rightNumber) return 0;
    return leftNumber < rightNumber ? -1 : 1;
  }

  if (leftString === rightString) return 0;
  return leftString < rightString ? -1 : 1;
}

function matchesPattern({
  pattern,
  state,
}: {
  pattern: AwkPattern;
  state: AwkRuntimeState;
}): boolean {
  switch (pattern.kind) {
  case 'begin':
    return false;
  case 'end':
    return false;
  case 'always':
    return true;
  case 'expression': {
    switch (pattern.expression.kind) {
    case 'regex':
      return pattern.expression.value.test(state.currentRecord?.text ?? '');
    case 'number':
    case 'string':
    case 'identifier':
    case 'indexed':
    case 'field':
    case 'update':
    case 'binary':
    case 'unary':
    case 'call':
      return isTruthy({
        value: evaluateExpression({
          expression: pattern.expression,
          state,
        }),
      });
    default: {
      const _ex: never = pattern.expression;
      throw new Error(`Unhandled awk pattern expression: ${JSON.stringify(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = pattern;
    throw new Error(`Unhandled awk pattern: ${JSON.stringify(_ex)}`);
  }
  }
}

function executeStatement({
  statement,
  state,
  output,
}: {
  statement: AwkStatement;
  state: AwkRuntimeState;
  output: string[];
}): AwkStatementControl {
  switch (statement.kind) {
  case 'assign': {
    const value = evaluateExpression({ expression: statement.expression, state });
    switch (statement.target.kind) {
    case 'variable':
      setVariable({ state, name: statement.target.name, value });
      break;
    case 'indexed':
      setArrayValue({
        state,
        name: statement.target.name,
        index: coerceToString({
          value: evaluateExpression({
            expression: statement.target.index,
            state,
          }),
        }),
        value,
      });
      break;
    default: {
      const _ex: never = statement.target;
      throw new Error(`Unhandled awk assignment target: ${JSON.stringify(_ex)}`);
    }
    }
    return 'normal';
  }
  case 'expression':
    evaluateExpression({ expression: statement.expression, state });
    return 'normal';
  case 'if': {
    const statements = isTruthy({
      value: evaluateExpression({
        expression: statement.condition,
        state,
      }),
    }) ? statement.thenStatements : statement.elseStatements ?? [];

    for (const nestedStatement of statements) {
      const control = executeStatement({
        statement: nestedStatement,
        state,
        output,
      });
      switch (control) {
      case 'normal':
        break;
      case 'next':
      case 'break':
      case 'continue_loop':
        return control;
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
    }

    return 'normal';
  }
  case 'while': {
    let iterationCount = 0;
    while (isTruthy({
      value: evaluateExpression({
        expression: statement.condition,
        state,
      }),
    })) {
      iterationCount += 1;
      if (iterationCount > 100000) {
        throw new Error('awk: while loop iteration limit exceeded');
      }

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }
      if (shouldContinueLoop) continue;
    }
    return 'normal';
  }
  case 'for': {
    executeForClausePart({
      part: statement.initializer,
      state,
    });

    let iterationCount = 0;
    while (statement.condition === undefined || isTruthy({
      value: evaluateExpression({
        expression: statement.condition,
        state,
      }),
    })) {
      iterationCount += 1;
      if (iterationCount > 100000) {
        throw new Error('awk: for loop iteration limit exceeded');
      }

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }

      executeForClausePart({
        part: statement.increment,
        state,
      });
      if (shouldContinueLoop) continue;
    }
    return 'normal';
  }
  case 'forIn': {
    const keys = [...requireArrayEntries({
      state,
      name: statement.arrayName,
    }).keys()];
    for (const key of keys) {
      setVariable({
        state,
        name: statement.variableName,
        value: key,
      });

      let shouldContinueLoop = false;
      for (const nestedStatement of statement.statements) {
        const control = executeStatement({
          statement: nestedStatement,
          state,
          output,
        });
        switch (control) {
        case 'normal':
          break;
        case 'continue_loop':
          shouldContinueLoop = true;
          break;
        case 'break':
          return 'normal';
        case 'next':
          return 'next';
        default: {
          const _ex: never = control;
          throw new Error(`Unhandled awk control flow: ${_ex}`);
        }
        }
        if (shouldContinueLoop) break;
      }
      if (shouldContinueLoop) continue;
    }
    return 'normal';
  }
  case 'delete':
    switch (statement.target.kind) {
    case 'array':
      clearArray({
        state,
        name: statement.target.name,
      });
      return 'normal';
    case 'indexed':
      deleteArrayEntry({
        state,
        name: statement.target.name,
        index: coerceToString({
          value: evaluateExpression({
            expression: statement.target.index,
            state,
          }),
        }),
      });
      return 'normal';
    default: {
      const _ex: never = statement.target;
      throw new Error(`Unhandled awk delete target: ${JSON.stringify(_ex)}`);
    }
    }
  case 'next':
    return 'next';
  case 'break':
    return 'break';
  case 'continue':
    return 'continue_loop';
  case 'print': {
    const fieldSeparator = coerceToString({ value: getVariable({ state, name: 'OFS' }) });
    const recordSeparator = coerceToString({ value: getVariable({ state, name: 'ORS' }) });
    if (statement.expressions.length === 0) {
      output.push(`${state.currentRecord?.text ?? ''}${recordSeparator}`);
      return 'normal';
    }

    const values = statement.expressions.map((expression) =>
      coerceToString({
        value: evaluateExpression({ expression, state }),
      }));
    output.push(`${values.join(fieldSeparator)}${recordSeparator}`);
    return 'normal';
  }
  case 'printf': {
    const formatted = formatPrintfOutput({
      format: coerceToString({
        value: evaluateExpression({
          expression: statement.format,
          state,
        }),
      }),
      argumentsList: statement.arguments.map((expression) =>
        evaluateExpression({ expression, state })),
    });
    output.push(formatted);
    return 'normal';
  }
  default: {
    const _ex: never = statement;
    throw new Error(`Unhandled awk statement: ${JSON.stringify(_ex)}`);
  }
  }
}

function splitRecords({
  text,
}: {
  text: string;
}): AwkRecord[] {
  const lines = text.split(/\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.map((line) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    return {
      text: normalized,
      fields: [],
      hadNewline: true,
    };
  });
}

export function createAwkRuntime({
  variables,
}: {
  variables: Map<string, AwkValue>;
}): AwkRuntimeState {
  const state: AwkRuntimeState = {
    variables: new Map(variables),
    arrays: new Map<string, Map<string, AwkValue>>(),
    currentRecord: undefined,
    nr: 0,
    fnr: 0,
  };

  if (!state.variables.has('FS')) state.variables.set('FS', ' ');
  if (!state.variables.has('OFS')) state.variables.set('OFS', ' ');
  if (!state.variables.has('ORS')) state.variables.set('ORS', '\n');
  return state;
}

function executeAwkStatements({
  program,
  runtime,
  patternKind,
  output,
}: {
  program: AwkProgram;
  runtime: AwkRuntimeState;
  patternKind: 'begin' | 'end';
  output: string[];
}): void {
  for (const rule of program.rules) {
    if (rule.pattern.kind !== patternKind) {
      continue;
    }

    for (const statement of rule.statements) {
      const control = executeStatement({ statement, state: runtime, output });
      switch (control) {
      case 'normal':
        break;
      case 'next':
        throw new Error(`awk: 'next' is not allowed in ${patternKind.toUpperCase()}`);
      case 'break':
        throw new Error("awk: 'break' is not allowed outside loops");
      case 'continue_loop':
        throw new Error("awk: 'continue' is not allowed outside loops");
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
    }
  }
}

export function executeAwkBegin({
  program,
  runtime,
  output,
}: {
  program: AwkProgram;
  runtime: AwkRuntimeState;
  output: string[];
}): void {
  executeAwkStatements({
    program,
    runtime,
    patternKind: 'begin',
    output,
  });
}

export function executeAwkRecord({
  program,
  runtime,
  record,
  output,
}: {
  program: AwkProgram;
  runtime: AwkRuntimeState;
  record: AwkRecord;
  output: string[];
}): void {
  runtime.nr += 1;
  runtime.fnr += 1;
  const fieldSeparator = coerceToString({ value: getVariable({ state: runtime, name: 'FS' }) });
  runtime.currentRecord = {
    ...record,
    fields: splitFields({
      line: record.text,
      fieldSeparator,
    }),
  };

  for (const rule of program.rules) {
    if (!matchesPattern({ pattern: rule.pattern, state: runtime })) continue;
    let nextRecord = false;
    for (const statement of rule.statements) {
      const control = executeStatement({ statement, state: runtime, output });
      switch (control) {
      case 'normal':
        break;
      case 'next':
        nextRecord = true;
        break;
      case 'break':
        throw new Error("awk: 'break' is not allowed outside loops");
      case 'continue_loop':
        throw new Error("awk: 'continue' is not allowed outside loops");
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
      if (nextRecord) break;
    }
    if (nextRecord) break;
  }
}

export function executeAwkEnd({
  program,
  runtime,
  output,
}: {
  program: AwkProgram;
  runtime: AwkRuntimeState;
  output: string[];
}): void {
  runtime.currentRecord = undefined;
  executeAwkStatements({
    program,
    runtime,
    patternKind: 'end',
    output,
  });
}

export function executeAwkProgram({
  program,
  runtime,
  inputs,
}: {
  program: AwkProgram;
  runtime: AwkRuntimeState;
  inputs: string[];
}): string {
  const output: string[] = [];
  executeAwkBegin({
    program,
    runtime,
    output,
  });

  for (const input of inputs) {
    runtime.fnr = 0;
    const records = splitRecords({ text: input });
    for (const record of records) {
      executeAwkRecord({
        program,
        runtime,
        record,
        output,
      });
    }
  }

  executeAwkEnd({
    program,
    runtime,
    output,
  });
  return output.join('');
}
