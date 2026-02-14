export type JsonParseResult =
  | { success: true; data: unknown; raw: string }
  | { success: false; error: string; raw: string };

/**
 * Parses a string containing one or more concatenated JSON objects.
 * Example: `{"a":1}{"b":2}` -> `[{success: true, data: {"a":1}, ...}, {success: true, data: {"b":2}, ...}]`
 *
 * This parser handles newlines and tracks brace depth to identify potential JSON objects.
 */
export function parseConcatenatedJson(input: string): JsonParseResult[] {
  const results: JsonParseResult[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '"') {
      inString = !inString;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const jsonStr = input.substring(start, i + 1);
        try {
          const data = JSON.parse(jsonStr);
          results.push({
            success: true,
            data,
            raw: jsonStr
          });
        } catch (e) {
          results.push({
            success: false,
            error: e instanceof Error ? e.message : String(e),
            raw: jsonStr
          });
        }
        start = -1;
      }
    }
  }

  // Handle cases where the input ends with an unclosed object
  if (depth > 0 && start !== -1) {
    results.push({
      success: false,
      error: 'Unclosed JSON object',
      raw: input.substring(start)
    });
  }

  return results;
}
