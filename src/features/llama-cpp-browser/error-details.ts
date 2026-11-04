/** Error text from this operation only; never serialize arbitrary object fields. */
export const maximumErrorDetailsLength = 32768;

function readErrorField({ error, key }: { error: object, key: 'name' | 'message' | 'stack' | 'cause' }): unknown {
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

export function errorDetails({ error }: { error: unknown }): string | undefined {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
    seen.add(current);
    try {
      if (typeof current === 'object' && current !== null) {
        const message = readErrorField({ error: current, key: 'message' });
        if (typeof message !== 'string') {
          break;
        }
        const rawName = readErrorField({ error: current, key: 'name' });
        const name = typeof rawName === 'string' ? rawName : 'Error';
        // The text survives Comlink's standard Error message/name/stack transfer.
        // Rewrapping must not duplicate the complete native transcript each time.
        if (name === 'LlamaCppBrowserError' && message.startsWith('llama.cpp browser: ')) {
          const newline = message.indexOf('\n');
          if (newline >= 0) {
            parts.push(message.slice(newline + 1, newline + 1 + maximumErrorDetailsLength));
            break;
          }
          current = readErrorField({ error: current, key: 'cause' });
          continue;
        }
        const heading = `${name}: ${message}`;
        const stack = readErrorField({ error: current, key: 'stack' });
        // Safari stacks often contain frames only, without the error message.
        parts.push((typeof stack === 'string' && stack.startsWith(heading) ? stack : `${heading}${typeof stack === 'string' ? `\n${stack}` : ''}`).slice(0, 8192));
        current = readErrorField({ error: current, key: 'cause' });
      } else if (typeof current === 'string' || typeof current === 'number' || typeof current === 'bigint' || typeof current === 'boolean') {
        parts.push(String(current));
        break;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return parts.length > 0 ? parts.join('\nCaused by:\n').slice(0, maximumErrorDetailsLength) : undefined;
}

const nativeCaptures = new Set<string[]>();

/** Called by existing native print callbacks, with no work outside an operation. */
export function recordNativeErrorContext({ message }: { message: unknown }): void {
  if (nativeCaptures.size === 0 || typeof message !== 'string') {
    return;
  }
  for (const messages of nativeCaptures) {
    if (messages.length === 32) {
      messages.shift();
    }
    messages.push(message.slice(0, 1024));
  }
}

/** A bounded transcript belongs to this operation, never the resident runtime. */
export function captureNativeErrorContext(): { describe({ error }: { error: unknown }): string | undefined, stop(): void } {
  const messages: string[] = [];
  nativeCaptures.add(messages);
  return {
    describe({ error }) {
      const exception = errorDetails({ error })?.slice(0, 8192);
      const allowance = maximumErrorDetailsLength - (exception?.length ?? 0) - 32;
      const native = messages.length > 0 ? `Native runtime output:\n${messages.join('\n').slice(-allowance)}` : undefined;
      return [exception, native].filter(part => part !== undefined).join('\n\n') || undefined;
    },
    stop() {
      nativeCaptures.delete(messages);
      messages.length = 0;
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
