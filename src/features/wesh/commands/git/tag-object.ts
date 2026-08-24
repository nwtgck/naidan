export interface ParsedAnnotatedTag {
  targetObjectId: string,
  targetType: 'blob' | 'tree' | 'commit' | 'tag',
  name: string,
  tagger: string,
  message: string,
}

function parseTargetType({ value }: { value: string }): ParsedAnnotatedTag['targetType'] {
  switch (value) {
  case 'blob':
  case 'tree':
  case 'commit':
  case 'tag':
    return value;
  default:
    throw new Error(`invalid annotated tag target type: ${value}`);
  }
}

export function parseAnnotatedTagObject({ body }: { body: Uint8Array }): ParsedAnnotatedTag {
  const text = new TextDecoder().decode(body);
  const separator = text.indexOf('\n\n');
  if (separator < 0) throw new Error('corrupt annotated tag: header separator is missing');
  const headers = new Map<string, string>();
  for (const line of text.slice(0, separator).split('\n')) {
    const space = line.indexOf(' ');
    if (space <= 0) throw new Error(`corrupt annotated tag header: ${line}`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const targetObjectId = headers.get('object');
  const targetType = headers.get('type');
  const name = headers.get('tag');
  const tagger = headers.get('tagger');
  if (targetObjectId === undefined || !/^[0-9a-f]{40}$/u.test(targetObjectId)) {
    throw new Error('corrupt annotated tag: object header is missing');
  }
  if (targetType === undefined) throw new Error('corrupt annotated tag: type header is missing');
  if (name === undefined) throw new Error('corrupt annotated tag: tag header is missing');
  if (tagger === undefined) throw new Error('corrupt annotated tag: tagger header is missing');
  return {
    targetObjectId,
    targetType: parseTargetType({ value: targetType }),
    name,
    tagger,
    message: text.slice(separator + 2),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
