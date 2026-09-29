/** jsdom Blob omits arrayBuffer; use its actual FileReader rather than faking the
 * WAV bytes created by code under test. */
export function readBlobBytes({ blob }: { blob: Blob }): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error('Expected binary Blob data'));
    };
    reader.onerror = () => reject(new Error('Blob read failed'));
    reader.readAsArrayBuffer(blob);
  });
}
export function referenceFile({ name }: { name: string }): File {
  const file = new File(['encoded audio'], name, { type: 'audio/wav' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
  return file;
}
export const TEST_ONLY = {
};
