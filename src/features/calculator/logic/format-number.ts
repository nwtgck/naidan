function getFloatingPointSimplificationTolerance({ value }: { value: number }): number {
  return Math.max(
    Number.MIN_VALUE,
    Math.abs(value) * Number.EPSILON * 4,
  );
}

function simplifyFloatingPointNoise({ value }: { value: number }): number {
  const tolerance = getFloatingPointSimplificationTolerance({ value });
  for (let precision = 1; precision <= 12; precision += 1) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.abs(candidate - value) <= tolerance) return candidate;
  }
  return Number(value.toPrecision(16));
}

export function formatCalculatorNumber({ value }: { value: number }): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot format non-finite calculator value: ${value}`);
  }
  if (Object.is(value, -0)) return '0';
  if (Number.isSafeInteger(value)) return String(value);
  const rounded = simplifyFloatingPointNoise({ value });
  return String(Object.is(rounded, -0) ? 0 : rounded).replace('e+', 'e');
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  getFloatingPointSimplificationTolerance,
  simplifyFloatingPointNoise,
};
