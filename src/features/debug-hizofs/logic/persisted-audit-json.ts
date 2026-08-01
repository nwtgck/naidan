import { exactObject } from "@/utils/exact-object";

/**
 * Serialize authoritative persisted/inspection DTOs for the audit UI without
 * narrowing them into a convenience model. BigInt and byte arrays need an
 * explicit lossless representation because native JSON cannot encode them.
 */
export function stringifyPersistedAuditValue({ value }: { value: unknown }): string {
  if (value === undefined) return "unavailable";
  return JSON.stringify(value, (_key, nested: unknown): unknown => {
    if (typeof nested === "bigint") return nested.toString();
    if (nested instanceof Uint8Array) {
      return exactObject<Readonly<{ byteLength: number; hex: string }>>()({
        byteLength: nested.byteLength,
        hex: Array.from(nested, byte => byte.toString(16).padStart(2, "0")).join(""),
      });
    }
    return nested;
  }, 2);
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
