import { describe, expect, it } from 'vitest';
import type { Core } from './core';
import { mountReadOnlyFile } from './read-only-file';

function fixture() {
  const node = { id: 1, mode: 0o100444, name: 'table.gguf', node_ops: {}, stream_ops: {} };
  const parent = { contents: {} };
  const fs = {
    ErrnoError: Error,
    mkdirTree() {},
    analyzePath: () => ({ exists: false }),
    lookupPath: () => ({ node: parent }),
    createNode: () => node,
    unlink() {},
    destroyNode() {},
  };
  const core = { module: { FS: fs }, constant: ({ name }: { name: string }) => name } as unknown as Core;
  const mounted = mountReadOnlyFile({
    core,
    path: '/models/table.gguf',
    source: {
      size: 2 ** 36,
      read: ({ destination, offset }) => {
        destination.fill(offset % 251); return destination.length;
      },
    },
    maxChunkBytes: 8,
  });
  // External FS callback signatures, not Naidan-owned APIs.
  const ops = node.stream_ops as {
    open: (stream: { flags: number, position: number }) => void,
    dup: () => void,
    close: () => void,
    read: (stream: object, bytes: Uint8Array, offset: number, length: number, position: number) => number,
  };
  return { mounted, ops };
}

describe('retained native descriptors on read-only model mounts', () => {
  it('retains the mount until both the original and duplicate close', () => {
    const { mounted, ops } = fixture();
    ops.open({ flags: 0, position: 0 });
    ops.dup(); // Emscripten dupStream deliberately does not call open again.
    expect(() => mounted.remove()).toThrow('Close native file handles');
    // Both descriptors share the table, so either close order has the same count.
    ops.close();
    expect(() => mounted.remove()).toThrow('Close native file handles');
    const bytes = new Uint8Array(4);
    expect(ops.read({}, bytes, 0, 4, 2 ** 32 + 11)).toBe(4);
    expect(bytes[0]).toBe((2 ** 32 + 11) % 251);
    ops.close();
    mounted.remove(); mounted.remove();
    expect(() => ops.dup()).toThrow('ENOENT');
    expect(() => ops.open({ flags: 0, position: 0 })).toThrow('ENOENT');
  });

  it('counts each duplicate, not just the first duplicate', () => {
    const { mounted, ops } = fixture();
    ops.open({ flags: 0, position: 0 });
    for (let i = 0; i < 3; i++) ops.dup();
    for (let i = 0; i < 3; i++) {
      ops.close(); expect(() => mounted.remove()).toThrow('Close native file handles');
    }
    ops.close(); mounted.remove();
  });
});
