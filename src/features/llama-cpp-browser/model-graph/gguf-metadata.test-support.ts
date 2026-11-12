export function metadataGguf({ items }: { items: { key: string; type: number; values: readonly (string | number | boolean)[]; count?: number }[] }): Uint8Array {
  const chunks: Uint8Array[] = [];
  const u32 = ({ value }: { value: number }) => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    chunks.push(bytes);
  };
  const u64 = ({ value }: { value: number }) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    chunks.push(bytes);
  };
  const string = ({ value }: { value: string }) => {
    const bytes = new TextEncoder().encode(value);
    u64({ value: bytes.length });
    chunks.push(bytes);
  };
  u32({ value: 0x46554747 });
  u32({ value: 3 });
  u64({ value: 0 });
  u64({ value: items.length + 2 });
  string({ value: 'general.architecture' });
  u32({ value: 8 });
  string({ value: 'array-fixture' });
  string({ value: 'tokenizer.ggml.tokens' });
  u32({ value: 9 });
  u32({ value: 8 });
  u64({ value: 2 });
  string({ value: 'a' });
  string({ value: 'b' });
  for (const item of items) {
    string({ value: item.key });
    u32({ value: 9 });
    u32({ value: item.type });
    u64({ value: item.count ?? item.values.length });
    for (const value of item.values) {
      switch (item.type) {
      case 4:
        if (typeof value !== 'number') {
          throw new Error('fixture integer');
        }
        u32({ value });
        break;
      case 6: {
        if (typeof value !== 'number') {
          throw new Error('fixture float');
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setFloat32(0, value, true);
        chunks.push(bytes);
        break;
      }
      case 7: chunks.push(Uint8Array.of(value === true ? 1 : 0));
        break;
      case 8:
        if (typeof value !== 'string') {
          throw new Error('fixture string');
        }
        string({ value });
        break;
      default: throw new Error('Unsupported fixture type');
      }
    }
  }
  const size = chunks.reduce((total, bytes) => total + bytes.length, 0);
  const result = new Uint8Array(Math.ceil(size / 32) * 32);
  let offset = 0;
  for (const bytes of chunks) {
    result.set(bytes, offset);
    offset += bytes.length;
  }
  return result;
}

export const TEST_ONLY = {
};
