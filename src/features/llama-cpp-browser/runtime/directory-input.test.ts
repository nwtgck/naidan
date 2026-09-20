import { describe, expect, it } from 'vitest';
import { directoryFromFiles, droppedModels } from './directory-input';

describe('model directory input', () => {
  it('uses webkitRelativePath rather than deriving a directory from a GGUF filename', () => {
    const file = new File(['bytes'], 'weights.gguf');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'my-Qwen-VL-GGUF/nested/weights.gguf' });
    expect(directoryFromFiles({ files: [file] })).toEqual({ name: 'my-Qwen-VL-GGUF', files: [{ path: 'nested/weights.gguf', file }] });
  });
  it('drains every drag entry batch and preserves the dropped directory name', async () => {
    const file = new File(['bytes'], 'model.gguf');
    const child = { isFile: true, isDirectory: false, name: 'model.gguf', file: (resolve: (file: File) => void) => resolve(file) };
    let batch = 0;
    const folder = { isDirectory: true, name: 'my-Qwen-VL-GGUF', createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batch++ === 0 ? [child] : []) }) };
    const transfer = { items: [{ kind: 'file', webkitGetAsEntry: () => folder }], files: [] } as unknown as DataTransfer;
    expect(await droppedModels({ transfer })).toEqual({ files: [], directories: [{ name: 'my-Qwen-VL-GGUF', files: [{ path: 'model.gguf', file }] }] });
    expect(batch).toBe(2);
  });
  it('retains direct file imports when entry enumeration is unavailable', async () => {
    const file = new File(['bytes'], 'model.gguf');
    expect(await droppedModels({ transfer: { files: [file], items: [] } as unknown as DataTransfer })).toEqual({ files: [file], directories: [] });
  });
});
