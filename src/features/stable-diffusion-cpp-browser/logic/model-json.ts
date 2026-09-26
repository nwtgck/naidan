/** Inspect untrusted, bounded model JSON as data. Never evaluate repo code/config. */
export function parseModelJson({ text }: { text: string }): unknown {
  const stack: { kind: 'object' | 'array', keys: Set<string>, key: boolean }[] = [];
  let keyCount = 0;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (character === '"') {
      const start = offset++;
      for (; offset < text.length; offset++) {
        if (text[offset] === '\\') offset++;
        else if (text[offset] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.kind === 'object' && frame.key) {
        const key: unknown = JSON.parse(text.slice(start, offset + 1));
        if (typeof key !== 'string' || frame.keys.has(key) || ++keyCount > 1_000_000) throw new Error('Duplicate or excessive model JSON keys');
        frame.keys.add(key); frame.key = false;
      }
    } else if (character === '{' || character === '[') {
      if (stack.length >= 64) throw new Error('Model JSON nesting exceeds the inspection limit');
      switch (character) {
      case '{': stack.push({ kind: 'object', keys: new Set(), key: true }); break;
      case '[': stack.push({ kind: 'array', keys: new Set(), key: false }); break;
      default: { const exhaustive: never = character; throw new Error(String(exhaustive)); }
      }
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === ',') {
      const frame = stack.at(-1);
      const kind = frame?.kind;
      switch (kind) {
      case 'object': if (frame) frame.key = true; break;
      case 'array': case undefined: break;
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
      }
    }
  }
  // The scan above only checks complexity and duplicate keys. JSON.parse remains
  // the grammar/number/escape validator; consumers use Zod for their own shape.
  return JSON.parse(text);
}
export const TEST_ONLY = {
};
