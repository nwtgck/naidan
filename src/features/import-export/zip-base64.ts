const ZIP_MIME_TYPE = 'application/zip';

async function collectZipBlob({ stream, signal }: { stream: ReadableStream<Uint8Array>, signal: AbortSignal | undefined }): Promise<Blob> {
  if (signal?.aborted) {
    const reason: unknown = signal.reason;
    void stream.cancel(reason).catch(() => undefined);
    throw reason;
  }

  const reader = stream.getReader();
  const parts: ArrayBuffer[] = [];
  let cancelled = false;
  const cancelReader = ({ reason }: { reason: unknown }): void => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    void reader.cancel(reason).catch(() => undefined);
  };

  let rejectAbort: ReturnType<typeof Promise.withResolvers<never>>['reject'] | undefined;
  const aborted = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // A synchronous source callback may abort before the first race is installed.
  void aborted?.catch(() => undefined);
  const onAbort = (): void => {
    const reason: unknown = signal?.reason;
    cancelReader({ reason });
    rejectAbort?.(reason);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    signal?.throwIfAborted();
    while (true) {
      const pending = reader.read();
      const result = aborted === undefined ? await pending : await Promise.race([pending, aborted]);
      signal?.throwIfAborted();
      if (result.done) {
        break;
      }
      // Snapshot each chunk before a source can reuse its backing buffer.
      parts.push(new Uint8Array(result.value).buffer);
    }
    return new Blob(parts, { type: ZIP_MIME_TYPE });
  } catch (error) {
    cancelReader({ reason: error });
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function zipBlobAsBase64({ blob, signal }: { blob: Blob, signal: AbortSignal | undefined }): Promise<string> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const reader = new FileReader();
    let settled = false;

    const cleanup = (): void => {
      reader.removeEventListener('load', onLoad);
      reader.removeEventListener('error', onError);
      reader.removeEventListener('abort', onReaderAbort);
      signal?.removeEventListener('abort', onSignalAbort);
    };
    const fail = ({ error }: { error: unknown }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = ({ serialized }: { serialized: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(serialized);
    };
    const onLoad = (): void => {
      if (signal?.aborted) {
        fail({ error: signal.reason });
        return;
      }
      const result = reader.result;
      if (typeof result !== 'string') {
        fail({ error: new Error('Failed to encode ZIP as Base64') });
        return;
      }
      const separator = result.indexOf(',');
      if (!result.startsWith('data:') || separator < 0 || !result.slice(0, separator).endsWith(';base64')) {
        fail({ error: new Error('Failed to encode ZIP as Base64') });
        return;
      }
      succeed({ serialized: result.slice(separator + 1) });
    };
    const onError = (): void => {
      fail({ error: reader.error ?? new Error('Failed to read ZIP data') });
    };
    const onReaderAbort = (): void => {
      fail({ error: signal?.aborted ? signal.reason : new DOMException('ZIP encoding cancelled', 'AbortError') });
    };
    const onSignalAbort = (): void => {
      const reason: unknown = signal?.reason;
      try {
        reader.abort();
      } catch {
        // The requested cancellation remains the outcome even if abort fails.
      } finally {
        fail({ error: reason });
      }
    };

    reader.addEventListener('load', onLoad);
    reader.addEventListener('error', onError);
    reader.addEventListener('abort', onReaderAbort);
    signal?.addEventListener('abort', onSignalAbort, { once: true });
    if (signal?.aborted) {
      onSignalAbort();
      return;
    }
    try {
      reader.readAsDataURL(blob);
    } catch (error) {
      fail({ error });
    }
  });
}

/** Encodes ZIP bytes as raw standard Base64; no URL or data-URL prefix is added. */
export async function encodeZipStreamAsBase64({ stream, signal }: { stream: ReadableStream<Uint8Array>, signal: AbortSignal | undefined }): Promise<string> {
  const blob = await collectZipBlob({ stream, signal });
  return zipBlobAsBase64({ blob, signal });
}

/** Decodes bytes only. ZIP analysis, verification, and import remain service responsibilities. */
export function decodeZipBase64({ serialized }: { serialized: string }): Blob {
  const binary = atob(serialized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes.buffer], { type: ZIP_MIME_TYPE });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
