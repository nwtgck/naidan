// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fromEmscriptenPointer, selectAbiSchema, toEmscriptenPointer, toNativePointer } from 'llama-cpp-browser-core/llama-cpp/host/abi';

function fixture({ pointerBytes }: { pointerBytes: 4 | 8 }) {
  const hash = (pointerBytes === 4 ? 'a' : 'b').repeat(64);
  const target = {
    abiVersion: 3,
    runtime: 'llama-cpp',
    pointerRepresentation: 'bigint_native',
    schemaSha256: hash,
    pointerBytes,
    constants: ['SIGNED_CONSTANT'],
    constantValues: { SIGNED_CONSTANT: '-1' },
    functions: [],
    callbackMetadata: { version: 2, getters: [] },
    suspendingExports: [],
    exports: [],
    records: [{ name: 'record', cType: 'struct record', id: 0, size: pointerBytes * 2, alignment: Number(pointerBytes), fields: [{ name: 'pointer', cType: 'void *', id: 0, kind: 'pointer', abiType: { kind: 'pointer', bits: pointerBytes * 8 }, offset: Number(pointerBytes), size: Number(pointerBytes) }] }],
  };
  const catalog = { abiVersion: 3, targets: { [hash]: target } };
  const memory = new Uint8Array(256);
  memory.set(new TextEncoder().encode(hash), 32);
  const module = {
    HEAPU8: memory,
    _bicore_abi_version: () => 3,
    _bicore_pointer_bytes: () => pointerBytes,
    _bicore_schema_hash: (): number | bigint => pointerBytes === 4 ? 32 : 32n,
  };
  return { module, catalog, target, hash };
}

describe('binary-selected ABI metadata', () => {
  it.each([4, 8] as const)('uses the loaded %s-byte target instead of another target layout', pointerBytes => {
    const selected = fixture({ pointerBytes });
    const other = fixture({ pointerBytes: pointerBytes === 4 ? 8 : 4 });
    Object.assign(selected.catalog.targets, other.catalog.targets);
    const schema = selectAbiSchema({ module: selected.module, schema: selected.catalog });
    expect(schema.pointerBytes).toBe(pointerBytes);
    expect(schema.records[0]?.size).toBe(pointerBytes * 2);
    expect(schema.records[0]?.fields[0]?.offset).toBe(pointerBytes);
    expect(schema.constantValues.SIGNED_CONSTANT).toBe('-1');
  });

  it('rejects an older ABI before reading its fingerprint', () => {
    const test = fixture({ pointerBytes: 4 });
    test.module._bicore_abi_version = () => 2;
    test.module._bicore_schema_hash = () => {
      throw new Error('Fingerprint must not be read');
    };
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/ABI/iu);
  });

  it('rejects an unlisted or incorrectly keyed schema fingerprint', () => {
    const test = fixture({ pointerBytes: 4 });
    test.module.HEAPU8.fill(99, 32, 96);
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/ABI|metadata/iu);
    test.module.HEAPU8.set(new TextEncoder().encode(test.hash), 32);
    test.target.schemaSha256 = 'c'.repeat(64);
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/ABI|metadata/iu);
  });

  it('rejects target metadata for another pointer width', () => {
    const test = fixture({ pointerBytes: 4 });
    test.target.pointerBytes = 8;
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/metadata.*match/iu);
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, 250, 2n ** 60n])('rejects a fingerprint outside the current heap: %s', pointer => {
    const test = fixture({ pointerBytes: 8 });
    test.module._bicore_schema_hash = () => pointer;
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/pointer|fingerprint/iu);
  });

  it('rejects duplicate declarations and fields outside the containing record', () => {
    const test = fixture({ pointerBytes: 8 });
    test.target.records.push(test.target.records[0]!);
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/duplicate.*record/iu);
    test.target.records.pop();
    test.target.records[0]!.fields[0]!.offset = 16;
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/Field.*record/iu);
  });

  it('requires each declared constant to have a compiler-evaluated integer value', () => {
    const test = fixture({ pointerBytes: 4 });
    test.target.constants.push('MISSING_CONSTANT');
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow(/constant/iu);
    test.target.constants.pop();
    test.target.constantValues.SIGNED_CONSTANT = '1.5';
    expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow();
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe layout numbers at metadata admission and accepts corrected data: %s', invalid => {
    for (const member of ['record-size', 'alignment', 'offset', 'field-size'] as const) {
      const test = fixture({ pointerBytes: 4 });
      const record = test.target.records[0]!;
      const field = record.fields[0]!;
      switch (member) {
      case 'record-size': record.size = invalid;
        break;
      case 'alignment': record.alignment = invalid;
        break;
      case 'offset': field.offset = invalid;
        break;
      case 'field-size': field.size = invalid;
        break;
      default: {
        const exhaustive: never = member;
        throw new Error(String(exhaustive));
      }
      }
      expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).toThrow();
      record.size = 8;
      record.alignment = 4;
      field.offset = 4;
      field.size = 4;
      expect(() => selectAbiSchema({ module: test.module, schema: test.catalog })).not.toThrow();
    }
  });
});

describe('Emscripten allocation addresses', () => {
  it.each([4, 8] as const)('uses SDK numbers for malloc/free on the %s-byte ABI', pointerBytes => {
    expect(toEmscriptenPointer({ value: 123n, pointerBytes })).toBe(123);
    expect(fromEmscriptenPointer({ value: 123, pointerBytes })).toBe(123n);
  });

  it('normalizes a signed wasm32 allocator result as an unsigned address', () => {
    expect(fromEmscriptenPointer({ value: -1, pointerBytes: 4 })).toBe(0xffffffffn);
  });

  it('keeps native memory64 C pointers distinct from the SDK allocation convention', () => {
    const pointer = 2n ** 40n + 17n;
    expect(toNativePointer({ value: pointer, pointerBytes: 8 })).toBe(pointer);
    expect(toEmscriptenPointer({ value: pointer, pointerBytes: 8 })).toBe(Number(pointer));
    expect(fromEmscriptenPointer({ value: Number(pointer), pointerBytes: 8 })).toBe(pointer);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an inexact SDK memory64 allocation address: %s', value => {
    expect(() => fromEmscriptenPointer({ value, pointerBytes: 8 })).toThrow();
  });

  it('rejects a wasm32 address overflow and an unindexable memory64 address before native free', () => {
    expect(() => toEmscriptenPointer({ value: 1n << 32n, pointerBytes: 4 })).toThrow();
    expect(() => toEmscriptenPointer({ value: BigInt(Number.MAX_SAFE_INTEGER) + 1n, pointerBytes: 8 })).toThrow();
  });
});
