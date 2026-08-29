const SED_UINT32_MASK = (1n << 32n) - 1n;
const SED_UINT32_MAX = SED_UINT32_MASK;
const SED_UINT64_MASK = (1n << 64n) - 1n;
const SED_UINT64_MAX = SED_UINT64_MASK;

export function parseSedUnsigned64Decimal({ value }: { value: string }): bigint {
  let result = 0n;
  for (const digit of value) {
    result = (result * 10n + BigInt(digit.charCodeAt(0) - 48)) & SED_UINT64_MASK;
  }
  return result;
}

export function addSedUnsigned64({ left, right }: { left: bigint; right: bigint }): bigint {
  return (left + right) & SED_UINT64_MASK;
}

export function parseSedScriptListWidth({ value }: { value: string }): number | undefined {
  const width = parseSedUnsigned64Decimal({ value }) & SED_UINT32_MASK;
  return width === SED_UINT32_MAX ? undefined : Number(width);
}

export function parseSedQuitStatus({ value }: { value: string | undefined }): number {
  if (value === undefined) return 0;

  const uint32Modulus = 0x1_0000_0000;
  let uint32Value = 0;
  for (const digit of value) {
    uint32Value = (uint32Value * 10 + (digit.charCodeAt(0) - 48)) % uint32Modulus;
  }
  if (uint32Value === 0xffff_ffff) return 0;
  return uint32Value & 0xff;
}

export function parseSedLineLengthOption({ value }: { value: string }): number {
  const match = value.match(/^\s*([+-]?)([0-9]+)/);
  if (match?.[2] === undefined || match[1] === "-") return 0;

  let parsed = 0n;
  for (const digit of match[2]) {
    const next = parsed * 10n + BigInt(digit.charCodeAt(0) - 48);
    if (next > SED_UINT64_MAX) return Number(SED_UINT32_MAX);
    parsed = next;
  }
  return Number(parsed & SED_UINT32_MASK);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
