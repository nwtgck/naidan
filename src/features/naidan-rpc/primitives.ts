export const FRAME_BYTES = 65536;
export const ITEM_BYTES = 16384;
export const REFERENCE_LIMIT = 16;
export const CALLBACK_LIMIT = 8;
export const QUEUE_BYTES = 1024 * 1024;
export const QUEUE_FRAMES = 64;
export const codes = ['INVALID_ARGUMENT', 'METHOD_NOT_FOUND', 'METHOD_NOT_ALLOWED', 'RESOURCE_EXHAUSTED', 'HANDLER_FAILED',
  'PROTOCOL_ERROR', 'CANCELLED', 'DEADLINE_EXCEEDED', 'TRANSPORT_ERROR'] as const;
export type NaidanRpcErrorCode = typeof codes[number];
export class NaidanRpcError extends Error {
  readonly code: NaidanRpcErrorCode;
  constructor({ code }: { code: NaidanRpcErrorCode }) {
    super(code); this.name = 'NaidanRpcError'; this.code = code;
  }
}
export function check({ condition, code }: { condition: unknown; code: NaidanRpcErrorCode }): void {
  if (!condition) throw new NaidanRpcError({ code });
}
export function deferred<T>() {
  let resolve!: ReturnType<typeof Promise.withResolvers<T>>['resolve'];
  let reject!: ReturnType<typeof Promise.withResolvers<T>>['reject'];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes; reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
export function ownBytes({ bytes }: { bytes: Uint8Array }): Uint8Array<ArrayBuffer> {
  check({ condition: bytes instanceof Uint8Array && bytes.buffer instanceof ArrayBuffer, code: 'INVALID_ARGUMENT' });
  return new Uint8Array(bytes);
}
export function validName({ name }: { name: string }): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(name) && !['then', '__proto__', 'prototype', 'constructor'].includes(name);
}
export function validKey({ key }: { key: string }): boolean {
  return !['__proto__', 'prototype', 'constructor'].includes(key);
}
export function duration({ milliseconds }: { milliseconds: number }): void {
  check({ condition: Number.isSafeInteger(milliseconds) && milliseconds >= 1 && milliseconds <= 2147483647, code: 'INVALID_ARGUMENT' });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
