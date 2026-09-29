export function classifyFreshMetadataFailure({ error }: { error: unknown }):
  'syntax-error' | 'type-error' | 'range-error' | 'error' | 'unknown' {
  // Copy no upstream string, stack, property, cause, or thrown object. Built-in
  // categories plus the caller-owned preparation stage are safe diagnostic facts.
  // A hostile Proxy can throw during instanceof; even classification must not
  // prevent the owner from returning its existing partial HTTP evidence.
  try {
    if (error instanceof SyntaxError) return 'syntax-error';
    if (error instanceof TypeError) return 'type-error';
    if (error instanceof RangeError) return 'range-error';
    if (error instanceof Error) return 'error';
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

export const TEST_ONLY = {
};
