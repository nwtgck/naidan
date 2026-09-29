import { createAbortableByteStream } from './abortable-byte-stream';

/** Bounded UTF-8 encoding, including text stored in a disk-backed Blob. */
export function createTextExportStream({ produce }: {
  produce: ({ write }: { write: ({ text }: { text: string | Blob }) => Promise<void> }) => Promise<void>;
}): ReadableStream<Uint8Array> {
  const abort = new AbortController();
  const output = new TransformStream<Uint8Array, Uint8Array>(undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }));
  const writer = output.writable.getWriter();
  const encoder = new TextEncoder();
  async function writeString({ text }: { text: string }): Promise<void> {
    for (let offset = 0; offset < text.length;) {
      abort.signal.throwIfAborted();
      let end = Math.min(offset + 16 * 1024, text.length);
      // Do not replace one surrogate pair by two replacement characters.
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      await writer.write(encoder.encode(text.slice(offset, end)));
      offset = end;
    }
  }
  async function write({ text }: { text: string | Blob }): Promise<void> {
    if (typeof text === 'string') {
      await writeString({ text });
      return;
    }
    const source = createAbortableByteStream({ stream: text.stream(), signal: abort.signal, onCancel: undefined });
    const reader = source.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        await writeString({ text: decoder.decode(next.value, { stream: true }) });
      }
      await writeString({ text: decoder.decode() });
    } catch (reason) {
      void reader.cancel(reason).catch(() => undefined);
      throw reason;
    } finally {
      reader.releaseLock();
    }
  }
  // Observe producer errors even when the consumer cancels before its first pull.
  void (async () => {
    try {
      await produce({ write });
      await writer.close();
    } catch (reason) {
      await writer.abort(reason).catch(() => undefined);
    } finally {
      writer.releaseLock();
    }
  })().catch(() => undefined);
  return createAbortableByteStream({ stream: output.readable, signal: abort.signal,
    onCancel: () => abort.abort(new DOMException('Text export cancelled', 'AbortError')) });
}

export const TEST_ONLY = {
};
