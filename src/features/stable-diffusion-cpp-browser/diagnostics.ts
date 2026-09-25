import { z } from 'zod';

export const imageDiagnosticSchema = z.object({
  event: z.enum(['request', 'start', 'complete', 'progress', 'native', 'file-summary', 'file-read', 'gpu', 'waiting', 'failed', 'cancelled', 'dropped']),
  stage: z.enum(['worker', 'runtime-fetch', 'runtime-init', 'model-header', 'model-load', 'generation', 'sampling', 'encoding', 'cleanup']),
  elapsedMs: z.number().finite().nonnegative(),
  message: z.string().max(2048).optional(),
  fields: z.record(z.string().max(64), z.union([z.number().finite(), z.boolean(), z.string().max(512), z.array(z.number().finite()).max(8)]))
    .refine(fields => Object.keys(fields).length <= 40),
}).strict();
export type ImageDiagnostic = z.infer<typeof imageDiagnosticSchema>;
export type ImageDiagnosticInput = Omit<ImageDiagnostic, 'elapsedMs'>;
export type ImageDiagnosticListener = ({ diagnostic }: { diagnostic: ImageDiagnostic }) => void;
export const imageDiagnosticEnvelopeSchema = z.object({ type: z.literal('naidan-image-diagnostic-v1'), diagnostic: imageDiagnosticSchema }).strict();

/** Native diagnostic text may contain names/prompts. Never treat it as trusted
 * markup or an exception to the privacy boundary. Bounded exports intentionally
 * omit prompt/token dumps, redact exact input strings and signed URLs. */
export function sanitizeImageLog({ message, secrets }: { message: string, secrets: readonly string[] }): string {
  if (/\bparse\s+['"]|prompt\s*[:=]|negative_prompt|token(?:s|izer)?\s*[:=]|<\|im_start\|>/i.test(message)) return '[prompt/token diagnostic omitted]';
  let result = message.slice(0, 16384);
  for (const secret of secrets) if (secret) {
    result = result.split(secret).join('[redacted]');
    for (const line of secret.split(/[\r\n]+/).filter(line => line.trim().length > 0)) result = result.split(line).join('[redacted]');
  }
  // eslint-disable-next-line no-control-regex -- Strip terminal/control characters from untrusted native messages.
  return result.replace(/https?:\/\/[^\s'"<>]+/g, '[URL omitted]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 2048);
}

/** Synchronous delivery matters: the next Wasm call may occupy the Worker
 * indefinitely. No promise/Comlink acknowledgement is queued for native logs. */
export function createImageTrace({ debug, secrets, listener, now }: {
  debug: 'off' | 'on', secrets: readonly string[], listener: ImageDiagnosticListener | undefined, now: () => number,
}) {
  const began = now(); let stage: ImageDiagnostic['stage'] = 'worker';
  let nativeWindow = began, nativeCount = 0, dropped = 0;
  function emit({ event, stage: next, message, fields }: ImageDiagnosticInput): void {
    // GPU/file observations belong to the last native stage; they must not
    // turn a stalled model load into a misleading 'generation' report.
    if (event !== 'gpu' && event !== 'file-read' && event !== 'native' && event !== 'dropped') stage = next;
    const entry = imageDiagnosticSchema.safeParse({ event, stage, elapsedMs: Math.max(0, now() - began),
      message: message === undefined ? undefined : sanitizeImageLog({ message, secrets }), fields });
    if (!entry.success) return;
    try {
      listener?.({ diagnostic: entry.data });
    } catch { /* Logging cannot unwind inference. */ }
  }
  function native({ message, level }: { message: string, level: number | undefined }): void {
    switch (debug) {
    case 'off': return;
    case 'on': break;
    default: { const exhaustive: never = debug; throw new Error(String(exhaustive)); }
    }
    const time = now();
    if (time - nativeWindow >= 1000) {
      if (dropped) emit({ event: 'dropped', stage, message: undefined, fields: { nativeLines: dropped } });
      nativeWindow = time; nativeCount = 0; dropped = 0;
    }
    if (++nativeCount > 60) {
      dropped++; return;
    }
    emit({ event: 'native', stage, message, fields: level === undefined ? {} : { level } });
  }
  return { emit, native };
}

/** Keep a small initial context plus a bounded tail, even on endless native logs.
 * Export is available during generation and after error/cancellation. */
export function createImageDiagnosticBuffer() {
  const head: { line: string, bytes: number }[] = [], tail: { line: string, bytes: number }[] = [];
  const encoder = new TextEncoder();
  let bytes = 0, omitted = 0;
  return {
    append({ diagnostic }: { diagnostic: ImageDiagnostic }): void {
      const parsed = imageDiagnosticSchema.safeParse(diagnostic); if (!parsed.success) return;
      const line = JSON.stringify(parsed.data), size = encoder.encode(line).length + 1;
      // Bounds include multibyte text and the retained head, not just tail length.
      if (size > 16 * 1024) {
        omitted++; return;
      }
      const entry = { line, bytes: size };
      if (head.length < 16) head.push(entry); else tail.push(entry);
      bytes += size;
      while ((tail.length > 1500 || bytes > 384 * 1024) && tail.length) {
        bytes -= tail.shift()!.bytes; omitted++;
      }
    },
    text(): string {
      return [...head.map(entry => entry.line), ...(omitted ? [JSON.stringify({ event: 'buffer-truncated', omitted })] : []), ...tail.map(entry => entry.line)].join('\n');
    },
    clear(): void {
      head.length = 0; tail.length = 0; bytes = 0; omitted = 0;
    },
  };
}
export const TEST_ONLY = {
};
