import { z } from 'zod';

const nativeAvailability = z.enum(['available', 'downloadable', 'downloading', 'unavailable']);

export type BrowserAiAvailabilityStatus = 'apiAbsent' | 'unknown' | 'rejected' | z.infer<typeof nativeAvailability>;

const textOptions = {
  expectedInputs: [{ type: 'text' }],
  expectedOutputs: [{ type: 'text' }],
} as const;

export async function checkBrowserAiAvailability({ nativeScope }: { nativeScope: { LanguageModel?: unknown } }): Promise<BrowserAiAvailabilityStatus> {
  try {
    const model: unknown = nativeScope.LanguageModel;
    if ((typeof model !== 'object' && typeof model !== 'function') || model === null) return 'apiAbsent';
    const candidate = model as Record<string, unknown>;
    // Naidan needs both methods, but the Docs checker only calls availability().
    if (typeof candidate.availability !== 'function' || typeof candidate.create !== 'function') return 'apiAbsent';
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Mirrors the browser Prompt API's positional Web IDL method.
    const availability = candidate.availability as (this: unknown, options: typeof textOptions) => Promise<unknown>;
    const result: unknown = await availability.call(model, textOptions);
    const parsed = nativeAvailability.safeParse(result);
    return parsed.success ? parsed.data : 'unknown';
  } catch {
    return 'rejected';
  }
}
