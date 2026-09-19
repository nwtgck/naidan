import type { ModelSupportInvestigationLoadAttemptError } from "@/features/transformers-js/model-support-investigation/types";

const REDACTED_KEY = /token|authorization|cookie|secret|password|api[-_]?key/i;
const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_LENGTH = 4096;
const MAX_COLLECTION_ENTRIES = 32;

function redactSensitiveString({ value }: { value: string }): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:access_token|token|api[-_]?key|secret|password)=)[^&#\s]*/giu, "$1[REDACTED]")
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu, "$1: [REDACTED]");
}

function truncated({ value, maxLength }: { value: string, maxLength: number }): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…[truncated ${value.length - maxLength} chars]`;
}

function safeString({ value }: { value: unknown }): string {
  try {
    return String(value);
  } catch {
    return `[Unstringifiable ${typeof value}]`;
  }
}

function isErrorValue(value: unknown): value is Error {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function errorCause({ value }: { value: unknown }): unknown {
  if (!isErrorValue(value)) return undefined;
  try {
    return 'cause' in value ? value.cause : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSerializableValue({
  value,
  depth,
  maxDepth,
  maxStringLength,
  seen,
}: {
  value: unknown,
  depth: number,
  maxDepth: number,
  maxStringLength: number,
  seen: WeakSet<object>,
}): unknown {
  if (value === undefined || value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return truncated({ value: redactSensitiveString({ value }), maxLength: maxStringLength });
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol") return safeString({ value });
  if (typeof value !== "object") return safeString({ value });
  if (seen.has(value)) return "[Circular]";
  if (depth >= maxDepth) return "[MaxDepth]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_COLLECTION_ENTRIES).map(item => sanitizeSerializableValue({
      value: item,
      depth: depth + 1,
      maxDepth,
      maxStringLength,
      seen,
    }));
    if (value.length > MAX_COLLECTION_ENTRIES) {
      items.push(`[Truncated ${value.length - MAX_COLLECTION_ENTRIES} array items]`);
    }
    return items;
  }

  if (value instanceof ArrayBuffer) {
    return { type: "ArrayBuffer", byteLength: value.byteLength };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      type: value.constructor.name,
      byteLength: value.byteLength,
      byteOffset: value.byteOffset,
    };
  }
  if (value instanceof Map) {
    const entries: unknown[] = [];
    let index = 0;
    for (const [mapKey, mapValue] of value) {
      if (index >= MAX_COLLECTION_ENTRIES) {
        entries.push(`[Truncated ${value.size - MAX_COLLECTION_ENTRIES} map entries]`);
        break;
      }
      entries.push([
        sanitizeSerializableValue({ value: mapKey, depth: depth + 1, maxDepth, maxStringLength, seen }),
        sanitizeSerializableValue({ value: mapValue, depth: depth + 1, maxDepth, maxStringLength, seen }),
      ]);
      index += 1;
    }
    return { type: "Map", size: value.size, entries };
  }
  if (value instanceof Set) {
    const entries: unknown[] = [];
    let index = 0;
    for (const setValue of value) {
      if (index >= MAX_COLLECTION_ENTRIES) {
        entries.push(`[Truncated ${value.size - MAX_COLLECTION_ENTRIES} set entries]`);
        break;
      }
      entries.push(sanitizeSerializableValue({
        value: setValue,
        depth: depth + 1,
        maxDepth,
        maxStringLength,
        seen,
      }));
      index += 1;
    }
    return { type: "Set", size: value.size, entries };
  }

  const result: Record<string, unknown> = {};
  let entryCount = 0;
  if (isErrorValue(value)) {
    result.name = truncated({ value: value.name, maxLength: maxStringLength });
    result.message = truncated({ value: redactSensitiveString({ value: value.message }), maxLength: maxStringLength });
    result.stack = value.stack === undefined
      ? undefined
      : truncated({ value: redactSensitiveString({ value: value.stack }), maxLength: maxStringLength });
    entryCount = 3;
  }
  let truncatedEntries = false;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (entryCount >= MAX_COLLECTION_ENTRIES) {
      truncatedEntries = true;
      break;
    }
    let nestedValue: unknown;
    try {
      nestedValue = Reflect.get(value, key);
    } catch (error) {
      nestedValue = `[Getter threw: ${safeString({ value: error })}]`;
    }
    result[key] = REDACTED_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeSerializableValue({
        value: nestedValue,
        depth: depth + 1,
        maxDepth,
        maxStringLength,
        seen,
      });
    entryCount += 1;
  }
  if (truncatedEntries) result["[Truncated]"] = `more than ${MAX_COLLECTION_ENTRIES} object entries`;
  return result;
}

function safeSerializedValue({
  value,
  maxDepth,
  maxLength,
}: {
  value: unknown,
  maxDepth: number,
  maxLength: number,
}): string | undefined {
  if (value === undefined) return undefined;
  try {
    const sanitized = sanitizeSerializableValue({
      value,
      depth: 0,
      maxDepth,
      maxStringLength: maxLength,
      seen: new WeakSet<object>(),
    });
    const serialized = JSON.stringify(sanitized);
    return serialized === undefined
      ? truncated({ value: redactSensitiveString({ value: safeString({ value }) }), maxLength })
      : truncated({ value: serialized, maxLength });
  } catch {
    return truncated({ value: redactSensitiveString({ value: safeString({ value }) }), maxLength });
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
  const snapshot = ({ value }: { value: unknown }): Omit<ModelSupportInvestigationLoadAttemptError, 'cause' | 'causeChain'> => {
    if (isErrorValue(value)) {
      return {
        name: truncated({ value: value.name, maxLength }),
        message: truncated({ value: redactSensitiveString({ value: value.message }), maxLength }),
        stack: value.stack === undefined
          ? undefined
          : truncated({ value: redactSensitiveString({ value: value.stack }), maxLength }),
        thrownType: value.constructor.name || 'Error',
        serializedOriginalThrownValue: safeSerializedValue({ value, maxDepth, maxLength }),
      };
    }
    const serialized = safeSerializedValue({ value, maxDepth, maxLength });
    return {
      name: typeof value,
      message: serialized ?? redactSensitiveString({ value: safeString({ value }) }),
      stack: undefined,
      thrownType: value === null ? 'null' : typeof value,
      serializedOriginalThrownValue: serialized,
    };
  };

  const root = snapshot({ value: error });
  const causeChain: ModelSupportInvestigationLoadAttemptError['causeChain'] = [];
  let current = errorCause({ value: error });
  for (let depth = 0; current !== undefined && depth < maxDepth; depth += 1) {
    causeChain.push(snapshot({ value: current }));
    current = errorCause({ value: current });
  }
  return {
    ...root,
    cause: causeChain[0],
    causeChain: causeChain.length === 0 ? undefined : causeChain,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
