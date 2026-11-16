import { fromNativePointer } from 'speech-cpp-browser-core/speech-cpp/host/abi';
import type { Core } from 'speech-cpp-browser-core/speech-cpp/host';

/** Public API handles are bigint on both targets; C pointer slots follow the ABI. */
export function readSpeechPointer({ core, address }: { core: Core, address: bigint }): bigint {
  const bytes = core.bytes(address, core.pointerBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (core.pointerBytes) {
  case 4: return BigInt(view.getUint32(0, true));
  case 8: return view.getBigUint64(0, true);
  default: {
    const exhaustive: never = core.pointerBytes;
    throw new Error(String(exhaustive));
  }
  }
}

/** Raw Wasm callbacks bypass the generated public API's scalar conversion. */
export function speechCallbackPointer({ core, value }: { core: Core, value: number | bigint }): bigint {
  return fromNativePointer({ value, pointerBytes: core.pointerBytes });
}

export const TEST_ONLY = {
};
