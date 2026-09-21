import { z } from 'zod';
import { readStreamLines } from '@/utils/read-stream-lines';

/** Read complete SSE data events, including a final event without a blank delimiter. */
export async function* readSseData({ response, signal }: { response: Response, signal: AbortSignal }): AsyncGenerator<string, void, void> {
  if (!response.body) throw new Error('No response body');
  let data: string[] = [];
  let length = 0;
  for await (const line of readStreamLines({ stream: response.body, signal, maxLineLength: 8 * 1024 * 1024 })) {
    if (line === '') {
      if (data.length) yield data.join('\n');
      data = []; length = 0;
    } else if (line.startsWith('data:')) {
      const value = line.slice(5).replace(/^ /, '');
      length += value.length;
      if (length > 8 * 1024 * 1024) throw new Error('The response event exceeds the supported size.');
      data.push(value);
    }
  }
  if (data.length) yield data.join('\n');
}

export async function readApiErrorDetails({ response }: { response: Response }): Promise<string> {
  try {
    const raw: unknown = await response.json();
    const parsed = z.object({ error: z.union([z.string(), z.object({ message: z.string() })]).optional() }).safeParse(raw);
    if (parsed.success && parsed.data.error !== undefined) {
      return typeof parsed.data.error === 'string' ? parsed.data.error : parsed.data.error.message;
    }
    return response.statusText;
  } catch {
    return response.statusText;
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
