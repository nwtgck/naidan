import { z } from 'zod';

/** Assert that console entries remain fully copyable without expanding objects. */
export function readDiagnostics({ calls }: { calls: readonly (readonly unknown[])[] }): Record<string, unknown>[] {
  const prefix = '[llama-cpp-browser] ';
  return calls.map(args => {
    const line = args[0];
    if (args.length !== 1 || typeof line !== 'string' || !line.startsWith(prefix) || line.includes('\n')) throw new Error('Expected one diagnostic JSON line.');
    return z.record(z.string(), z.unknown()).parse(JSON.parse(line.slice(prefix.length)));
  });
}
export const TEST_ONLY = {
};
