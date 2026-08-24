import type { ModelSupportInvestigationLoadAttemptError } from "@/features/transformers-js/model-support-investigation/types";

const REDACTED_KEY = /token|authorization|cookie|secret|password|api[-_]?key/i;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_LENGTH = 4096;

function redactSensitiveString({ value }: { value: string }): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|token|api[-_]?key|secret|password)=)[^&#\s]*/giu, "$1[REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, "$1: [REDACTED]");
}

function truncated({ value, maxLength }: { value: string, maxLength: number }): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function safeSerializedValue({ value, maxLength }: { value: unknown, maxLength: number }): string | undefined {
  if (value === undefined) return undefined;
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (key, nestedValue: unknown) => {
      if (REDACTED_KEY.test(key)) return "[REDACTED]";
      if (typeof nestedValue === "string") return redactSensitiveString({ value: nestedValue });
      if (typeof nestedValue === "bigint") return `${nestedValue}n`;
      if (typeof nestedValue === "function" || typeof nestedValue === "symbol") return String(nestedValue);
      if (typeof nestedValue === "object" && nestedValue !== null) {
        if (seen.has(nestedValue)) return "[Circular]";
        seen.add(nestedValue);
        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack,
            ...Object.fromEntries(Object.entries(nestedValue)),
          };
        }
      }
      return nestedValue;
    });
    return serialized === undefined
      ? redactSensitiveString({ value: String(value) })
      : truncated({ value: serialized, maxLength });
  } catch {
    return truncated({ value: redactSensitiveString({ value: String(value) }), maxLength });
  }
}

export function serializeInvestigationError({
  error,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxLength = DEFAULT_MAX_LENGTH,
}: {
  error: unknown,
  maxDepth?: number,
  maxLength?: number,
}): ModelSupportInvestigationLoadAttemptError {
  const visit = ({ value, depth }: { value: unknown, depth: number }): ModelSupportInvestigationLoadAttemptError => {
    if (value instanceof Error) {
      const cause = depth < maxDepth && "cause" in value && value.cause !== undefined
        ? visit({ value: value.cause, depth: depth + 1 })
        : undefined;
      return {
        name: value.name,
        message: redactSensitiveString({ value: value.message }),
        stack: value.stack === undefined ? undefined : redactSensitiveString({ value: value.stack }),
        thrownType: value.constructor.name || "Error",
        serializedOriginalThrownValue: safeSerializedValue({ value, maxLength }),
        cause,
      };
    }
    const serialized = safeSerializedValue({ value, maxLength });
    return {
      name: typeof value,
      message: serialized ?? redactSensitiveString({ value: String(value) }),
      stack: undefined,
      thrownType: value === null ? "null" : typeof value,
      serializedOriginalThrownValue: serialized,
      cause: undefined,
    };
  };
  return visit({ value: error, depth: 0 });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
