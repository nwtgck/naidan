import type { Core } from './core';

type Stream = { flags: number, position: number };
type Node = { id: number, mode: number, name: string, contents?: Record<string, Node>, node_ops: object, stream_ops: object };
/** Adapt an OPFS reader to the generated Emscripten filesystem without copying the file. */
export function mountReadOnlyFile({ core, path, source, maxChunkBytes }: {
  core: Core, path: string, source: { size: number, read: ({ destination, offset }: { destination: Uint8Array, offset: number }) => number }, maxChunkBytes: number,
}) {
  const { FS } = core.module;
  if (!path.startsWith('/') || path.endsWith('/') || path.split('/').some(part => part === '..' || part === '.')) throw new TypeError('Invalid absolute file path');
  if (!Number.isSafeInteger(source.size) || source.size < 0 || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1) throw new RangeError('Invalid source size');
  const fail = ({ code }: { code: string }): never => {
    throw new FS.ErrnoError(core.constant({ name: code }));
  };
  const split = path.lastIndexOf('/'); const parentPath = path.slice(0, split) || '/';
  FS.mkdirTree(parentPath, 0o777);
  if (FS.analyzePath(path, false).exists) throw new Error('File is already mounted');
  // The generated FS declarations leave node/stream operation tables untyped.
  const parent = FS.lookupPath(parentPath).node as Node;
  const node = FS.createNode(parent, path.slice(split + 1), 0o100444, 0) as Node;
  const timestamp = Date.now(); const size = source.size; let opens = 0; let removed = false;
  node.node_ops = {
    getattr() {
      return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size,
        atime: new Date(timestamp), mtime: new Date(timestamp), ctime: new Date(timestamp), blksize: 4096, blocks: Math.ceil(size / 4096) };
    },
    setattr() {
      fail({ code: 'EROFS' });
    },
  };
  node.stream_ops = {
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten FS callback ABI.
    open(stream: Stream) {
      if (removed) fail({ code: 'ENOENT' });
      if ((stream.flags & 3) !== 0 || (stream.flags & 512) !== 0) fail({ code: 'EROFS' });
      opens++;
    },
    close() {
      opens--;
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten FS callback ABI.
    llseek(stream: Stream, offset: number, whence: number) {
      const position = offset + (whence === 0 ? 0 : whence === 1 ? stream.position : whence === 2 ? size : NaN);
      if (!Number.isSafeInteger(position) || position < 0) fail({ code: 'EINVAL' });
      return position;
    },
    // eslint-disable-next-line local-rules-named-args/require-named-args -- Emscripten FS callback ABI.
    read(_stream: Stream, buffer: Uint8Array, offset: number, length: number, position: number) {
      if (![offset, length, position].every(Number.isSafeInteger) || Math.min(offset, length, position) < 0 || offset > buffer.length || length > buffer.length - offset) fail({ code: 'EINVAL' });
      let done = 0; const wanted = Math.min(length, Math.max(0, size - position));
      while (done < wanted) {
        const amount = Math.min(maxChunkBytes, wanted - done);
        let count: number;
        try {
          count = source.read({ destination: buffer.subarray(offset + done, offset + done + amount), offset: position + done });
        } catch {
          return fail({ code: 'EIO' });
        }
        if (!Number.isSafeInteger(count) || count < 0 || count > amount) fail({ code: 'EIO' });
        if (count === 0) break;
        done += count;
      }
      return done;
    },
    write() {
      fail({ code: 'EROFS' });
    }, mmap() {
      fail({ code: 'EINVAL' });
    },
  };
  if (!parent.contents) {
    FS.destroyNode(node); throw new Error('Expected MEMFS directory');
  }
  parent.contents[node.name] = node;
  return { path, remove() {
    if (opens !== 0) throw new Error('Close native file handles before unmounting');
    if (!removed) {
      FS.unlink(path); removed = true;
    }
  } };
}
export const TEST_ONLY = {
};
