import type { JsonValue } from "./ast";

export interface JqNumberOrigin {
  readonly lexeme: string,
  readonly canonical: string,
  readonly negative: boolean,
  readonly coefficient: string,
  readonly exponent: number,
}

type JsonContainer = JsonValue[] | { [key: string]: JsonValue };
type NumberOriginMap = Map<string, JqNumberOrigin>;

const jqNumberOrigins = new WeakMap<object, NumberOriginMap>();

function parseFiniteDecimalLexeme({ lexeme }: { lexeme: string }): {
  readonly negative: boolean,
  readonly coefficient: string,
  readonly exponent: number,
} | undefined {
  const match = lexeme.match(/^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u);
  if (match === null) return undefined;
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? match[4] ?? "";
  const explicitExponent = Number(match[5] ?? "0");
  if (!Number.isSafeInteger(explicitExponent)) return undefined;
  const rawDigits = `${integer}${fraction}`;
  const nonZeroIndex = rawDigits.search(/[1-9]/u);
  const coefficient = nonZeroIndex === -1 ? "0" : rawDigits.slice(nonZeroIndex);
  return {
    negative: match[1] === '-',
    coefficient,
    exponent: explicitExponent - fraction.length,
  };
}

function formatDecimal({
  negative,
  coefficient,
  exponent,
}: {
  negative: boolean,
  coefficient: string,
  exponent: number,
}): string {
  const sign = negative ? "-" : "";
  const adjustedExponent = coefficient === "0"
    ? exponent
    : exponent + coefficient.length - 1;
  const usePlain = exponent <= 0 && adjustedExponent >= -6;
  if (usePlain) {
    const point = coefficient.length + exponent;
    if (point >= coefficient.length) {
      return `${sign}${coefficient}${"0".repeat(point - coefficient.length)}`;
    }
    if (point > 0) {
      return `${sign}${coefficient.slice(0, point)}.${coefficient.slice(point)}`;
    }
    return `${sign}0.${"0".repeat(-point)}${coefficient}`;
  }
  const mantissa = coefficient.length === 1
    ? coefficient
    : `${coefficient[0]}.${coefficient.slice(1)}`;
  const exponentSign = adjustedExponent >= 0 ? "+" : "";
  return `${sign}${mantissa}E${exponentSign}${adjustedExponent}`;
}

export function createJqNumberOrigin({ lexeme }: { lexeme: string }): JqNumberOrigin | undefined {
  const parsed = parseFiniteDecimalLexeme({ lexeme });
  if (parsed === undefined) return undefined;
  return {
    lexeme,
    canonical: formatDecimal(parsed),
    ...parsed,
  };
}

export function compareJqNumberOrigins({
  left,
  right,
}: {
  left: JqNumberOrigin,
  right: JqNumberOrigin,
}): number {
  const leftZero = left.coefficient === "0";
  const rightZero = right.coefficient === "0";
  if (leftZero && rightZero) return 0;
  if (leftZero) return right.negative ? 1 : -1;
  if (rightZero) return left.negative ? -1 : 1;
  if (left.negative !== right.negative) return left.negative ? -1 : 1;

  const direction = left.negative ? -1 : 1;
  const leftAdjusted = left.exponent + left.coefficient.length - 1;
  const rightAdjusted = right.exponent + right.coefficient.length - 1;
  if (leftAdjusted !== rightAdjusted) {
    return leftAdjusted < rightAdjusted ? -direction : direction;
  }
  const width = Math.max(left.coefficient.length, right.coefficient.length);
  const leftDigits = left.coefficient.padEnd(width, "0");
  const rightDigits = right.coefficient.padEnd(width, "0");
  if (leftDigits === rightDigits) return 0;
  return leftDigits < rightDigits ? -direction : direction;
}

function keyText({ key }: { key: string | number }): string {
  return typeof key === "number" ? `#${key}` : `$${key}`;
}

export function setJsonChildNumberOrigin({
  container,
  key,
  origin,
}: {
  container: JsonContainer,
  key: string | number,
  origin: JqNumberOrigin | undefined,
}): void {
  const object = container as object;
  const map = jqNumberOrigins.get(object);
  const keyValue = keyText({ key });
  if (origin === undefined) {
    map?.delete(keyValue);
    return;
  }
  if (map === undefined) {
    jqNumberOrigins.set(object, new Map([[keyValue, origin]]));
    return;
  }
  map.set(keyValue, origin);
}

export function getJsonChildNumberOrigin({
  container,
  key,
}: {
  container: JsonContainer,
  key: string | number,
}): JqNumberOrigin | undefined {
  return jqNumberOrigins.get(container as object)?.get(keyText({ key }));
}

export function copyJsonChildNumberOrigins({
  source,
  target,
}: {
  source: JsonContainer,
  target: JsonContainer,
}): void {
  const map = jqNumberOrigins.get(source as object);
  if (map === undefined || map.size === 0) return;
  jqNumberOrigins.set(target as object, new Map(map));
}

export function moveJsonArrayNumberOrigins({
  source,
  target,
  sourceStart,
  sourceEnd,
}: {
  source: JsonValue[],
  target: JsonValue[],
  sourceStart: number,
  sourceEnd: number,
}): void {
  let targetIndex = 0;
  for (let sourceIndex = sourceStart; sourceIndex < sourceEnd; sourceIndex += 1) {
    setJsonChildNumberOrigin({
      container: target,
      key: targetIndex,
      origin: getJsonChildNumberOrigin({ container: source, key: sourceIndex }),
    });
    targetIndex += 1;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
