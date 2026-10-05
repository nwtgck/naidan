/** Validate the declared dimensions before allowing a remote image to reach the browser decoder. */
export function validatePng({ bytes, width, height }: { bytes: Uint8Array; width: number; height: number }): void {
  if (bytes.length < 33 || bytes.length > 32 * 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error('Remote result is not a bounded PNG image');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 || view.getUint32(16) !== width || view.getUint32(20) !== height ||
    width < 128 || height < 128 || width > 2048 || height > 2048) throw new Error('Remote PNG dimensions do not match the request');
}
export const TEST_ONLY = {
};
