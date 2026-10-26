import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const gzipAsync = promisify(gzip);

/** Prepare one verified asset on demand, sharing its in-flight compression. */
export function createGzipAsset({ read }: { read: () => Uint8Array }): () => Promise<Uint8Array> {
  let pending: Promise<Uint8Array> | undefined;
  return () => {
    if (pending !== undefined) {
      return pending;
    }
    const attempt = (async () => gzipAsync(read(), { level: 9 }))();
    pending = attempt;
    void attempt.catch(() => {
      // A corrected input can retry after verification or compression failed.
      if (pending === attempt) {
        pending = undefined;
      }
    });
    return attempt;
  };
}
