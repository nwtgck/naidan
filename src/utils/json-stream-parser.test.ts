import { describe, it, expect } from 'vitest';
import { parseConcatenatedJson } from './json-stream-parser';

describe('parseConcatenatedJson', () => {
  it('should parse a single JSON object', () => {
    const input = '{"name": "test"}';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(1);
    const r0 = results[0]!;
    expect(r0.success).toBe(true);
    if (r0.success) {
      expect(r0.data).toEqual({ name: 'test' });
    }
  });

  it('should parse multiple concatenated JSON objects', () => {
    const input = '{"a": 1}{"b": 2}';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    const r0 = results[0]!;
    const r1 = results[1]!;
    if (r0.success) {
      expect(r0.data).toEqual({ a: 1 });
    }
    if (r1.success) {
      expect(r1.data).toEqual({ b: 2 });
    }
  });

  it('should handle newlines between and within objects', () => {
    const input = `{
  "a": 1
}
{
  "b": 2
}`;
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    const r0 = results[0]!;
    const r1 = results[1]!;
    if (r0.success) {
      expect(r0.data).toEqual({ a: 1 });
    }
    if (r1.success) {
      expect(r1.data).toEqual({ b: 2 });
    }
  });

  it('should handle nested objects', () => {
    const input = '{"outer": {"inner": 1}}{"simple": true}';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    const r0 = results[0]!;
    const r1 = results[1]!;
    if (r0.success) {
      expect(r0.data).toEqual({ outer: { inner: 1 } });
    }
    if (r1.success) {
      expect(r1.data).toEqual({ simple: true });
    }
  });

  it('should handle strings containing braces', () => {
    const input = '{"text": "contains { braces }"}';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(1);
    const r0 = results[0]!;
    if (r0.success) {
      expect(r0.data).toEqual({ text: 'contains { braces }' });
    }
  });

  it('should handle escaped quotes in strings', () => {
    const input = '{"text": "quoted \\"word\\""}';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(1);
    const r0 = results[0]!;
    expect(r0.success).toBe(true);
    if (r0.success) {
      expect(r0.data).toEqual({ text: 'quoted "word"' });
    }
  });

  it('should report errors for invalid JSON segments', () => {
    const input = '{"valid": true}{"invalid": }';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    const r0 = results[0]!;
    const r1 = results[1]!;
    expect(r0.success).toBe(true);
    expect(r1.success).toBe(false);
    if (!r1.success) {
      expect(r1.error).toBeDefined();
    }
  });

  it('should handle unclosed objects at the end', () => {
    const input = '{"valid": true}{"unclosed": ';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    const r0 = results[0]!;
    const r1 = results[1]!;
    expect(r0.success).toBe(true);
    expect(r1.success).toBe(false);
    if (!r1.success) {
      expect(r1.error).toBe('Unclosed JSON object');
    }
  });

  it('should handle complex nested objects and arrays', () => {
    const input = '{"a": [1, 2, {"b": 3}]}{"c": {"d": [4]}}';
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    if (results[0]?.success) {
      expect(results[0].data).toEqual({ a: [1, 2, { b: 3 }] });
    }
    if (results[1]?.success) {
      expect(results[1].data).toEqual({ c: { d: [4] } });
    }
  });

  it('should handle whitespace and random text between objects if they are not braces', () => {
    // Note: The current parser is brace-depth based.
    // If there's text between objects that contains braces, it might fail.
    // But basic whitespace should be fine.
    const input = `\
  {"a": 1}  

  {"b": 2}  `;
    const results = parseConcatenatedJson({ input });
    expect(results).toHaveLength(2);
    if (results[0]?.success) {
      expect(results[0].data).toEqual({ a: 1 });
    }
    if (results[1]?.success) {
      expect(results[1].data).toEqual({ b: 2 });
    }
  });
});

describe('strict object stream boundary', () => {
  it.each([
    'garbage {"a":1}', '{"a":1} trailing', '[{"a":1}]', 'null', 'true',
    '{"a":1}, {"b":2}', '} {"a":1}', '{"a":1}//comment',
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}',
    '{"a":[{"x":1,"x":2}]}', '{"a":01}', '{"a":1,}', '{"a":[1,]}',
    '{"a":"bad\\q"}', '{"a":\\"b"}',
  ])('reports an invalid suffix or duplicate key: %s', input => {
    expect(parseConcatenatedJson({ input }).some(result => !result.success)).toBe(true);
  });

  it('accepts a single leading byte order mark and object-local duplicate names', () => {
    expect(parseConcatenatedJson({ input: '\uFEFF {"a":1}{"a":2}' }).every(result => result.success)).toBe(true);
  });

  it('keeps exact source without separators', () => {
    const input = `\
 { "a": { "b": 2 } }
 {"c":3}
`;
    expect(parseConcatenatedJson({ input }).map(result => result.raw)).toEqual(['{ "a": { "b": 2 } }', '{"c":3}']);
  });

  it('bounds depth and input size before parsing', () => {
    expect(parseConcatenatedJson({ input: '{"a":' + '['.repeat(80) + '0' + ']'.repeat(80) + '}' }).some(result => !result.success)).toBe(true);
    expect(parseConcatenatedJson({ input: ' '.repeat(4 * 1024 * 1024 + 1) })[0]?.success).toBe(false);
  });

  it('bounds stream count and rejects a noninitial byte order mark', () => {
    expect(parseConcatenatedJson({ input: '{}'.repeat(129) }).some(result => !result.success)).toBe(true);
    expect(parseConcatenatedJson({ input: '{}\uFEFF{}' }).some(result => !result.success)).toBe(true);
  });
});
