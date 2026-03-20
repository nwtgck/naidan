import type { AwkExpression, AwkPattern, AwkProgram, AwkStatement, AwkValue } from './types';

type AwkStatementControl = 'continue' | 'next';

interface AwkRecord {
  text: string;
  fields: string[];
  hadNewline: boolean;
}

interface AwkRuntimeState {
  variables: Map<string, AwkValue>;
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
  case 'field': {
    if (expression.index === 0) {
      return state.currentRecord?.text ?? '';
    }
    return state.currentRecord?.fields[expression.index - 1] ?? '';
  }
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
    case 'field':
    case 'binary':
    case 'unary':
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
    setVariable({ state, name: statement.name, value });
    return 'continue';
  }
  case 'expression':
    evaluateExpression({ expression: statement.expression, state });
    return 'continue';
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
      case 'continue':
        break;
      case 'next':
        return 'next';
      default: {
        const _ex: never = control;
        throw new Error(`Unhandled awk control flow: ${_ex}`);
      }
      }
    }

    return 'continue';
  }
  case 'next':
    return 'next';
  case 'print': {
    const fieldSeparator = coerceToString({ value: getVariable({ state, name: 'OFS' }) });
    const recordSeparator = coerceToString({ value: getVariable({ state, name: 'ORS' }) });
    if (statement.expressions.length === 0) {
      output.push(`${state.currentRecord?.text ?? ''}${recordSeparator}`);
      return 'continue';
    }

    const values = statement.expressions.map((expression) =>
      coerceToString({
        value: evaluateExpression({ expression, state }),
      }));
    output.push(`${values.join(fieldSeparator)}${recordSeparator}`);
    return 'continue';
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
    currentRecord: undefined,
    nr: 0,
    fnr: 0,
  };

  if (!state.variables.has('FS')) state.variables.set('FS', ' ');
  if (!state.variables.has('OFS')) state.variables.set('OFS', ' ');
  if (!state.variables.has('ORS')) state.variables.set('ORS', '\n');
  return state;
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

  for (const rule of program.rules) {
    switch (rule.pattern.kind) {
    case 'begin':
      for (const statement of rule.statements) {
        executeStatement({ statement, state: runtime, output });
      }
      break;
    case 'end':
    case 'always':
    case 'expression':
      break;
    default: {
      const _ex: never = rule.pattern;
      throw new Error(`Unhandled awk rule pattern: ${JSON.stringify(_ex)}`);
    }
    }
  }

  for (const input of inputs) {
    runtime.fnr = 0;
    const records = splitRecords({ text: input });
    for (const record of records) {
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
          case 'continue':
            break;
          case 'next':
            nextRecord = true;
            break;
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
  }

  runtime.currentRecord = undefined;
  for (const rule of program.rules) {
    switch (rule.pattern.kind) {
    case 'end':
      for (const statement of rule.statements) {
        executeStatement({ statement, state: runtime, output });
      }
      break;
    case 'begin':
    case 'always':
    case 'expression':
      break;
    default: {
      const _ex: never = rule.pattern;
      throw new Error(`Unhandled awk rule pattern: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return output.join('');
}
