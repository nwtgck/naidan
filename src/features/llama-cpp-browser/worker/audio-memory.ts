import type { Core } from '@/features/llama-cpp-browser/runtime/core';

type AudioScalarKind = 'pointer' | 'size' | 'i32' | 'i64' | 'bool';
function scalarSize({ core, kind }: { core: Core, kind: AudioScalarKind }): number {
  switch (kind) {
  case 'pointer': case 'size': return core.pointerBytes;
  case 'i32': return 4;
  case 'i64': return 8;
  case 'bool': return 1;
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
}

/** Read out-parameters after the awaited native call, never retain a heap view
 * across calls: memory growth can detach it, including during Asyncify/JSPI. */
export function readAudioScalar({ core, pointer, kind }: {
  core: Core, pointer: bigint, kind: AudioScalarKind,
}): bigint {
  const length = scalarSize({ core, kind });
  const bytes = core.bytes({ pointer, length });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (kind) {
  case 'pointer': case 'size': return length === 8 ? view.getBigUint64(0, true) : BigInt(view.getUint32(0, true));
  case 'i32': return BigInt(view.getInt32(0, true));
  case 'i64': return view.getBigInt64(0, true);
  case 'bool': return BigInt(view.getUint8(0));
  default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
  }
}
export function readAudioField({ core, pointer, name, field, kind }: {
  core: Core, pointer: bigint, name: string, field: string, kind: 'pointer' | 'i32',
}): bigint {
  const layout = core.fieldLayout({ name, field });
  if (layout.size !== scalarSize({ core, kind })) throw new Error('Unexpected audio record field width');
  return readAudioScalar({ core, pointer: pointer + layout.offset, kind });
}
export const TEST_ONLY = {
};
