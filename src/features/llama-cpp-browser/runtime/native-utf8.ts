import type { Core } from './core';

/** Copy already encoded, JavaScript-owned text into a native C string. The
 * caller owns the returned pointer. Do not retain a native heap view here:
 * allocating the destination can grow WebAssembly memory. */
export function copyNativeUtf8({ core, data }: {
  core: Pick<Core, 'alloc' | 'bytes' | 'free'>, data: Uint8Array,
}): bigint {
  const pointer = core.alloc({ bytes: data.byteLength + 1 });
  try {
    const span = core.bytes({ pointer, length: data.byteLength + 1 });
    span.set(data);
    span[data.byteLength] = 0;
    return pointer;
  } catch (error) {
    // Ownership transfers only after the complete string and terminator exist.
    core.free({ pointer });
    throw error;
  }
}

export const TEST_ONLY = {
};
