import type { NaidanSysfsBinaryObject } from './types';

export function createNaidanSysfsBinaryObject({
  object,
}: {
  object: {
    id: string,
    name?: string | null | undefined,
    mimeType: string,
    size: number,
    createdAt: number,
  },
}): NaidanSysfsBinaryObject {
  return {
    id: object.id,
    name: object.name ?? null,
    mimeType: object.mimeType,
    size: object.size,
    createdAt: object.createdAt,
  };
}

export function renderBinaryObjectMetadataJson({
  object,
}: {
  object: NaidanSysfsBinaryObject,
}): string {
  return `${JSON.stringify(object, null, 2)}\n`;
}

export function renderBinaryObjectMetadataMarkdown({
  object,
}: {
  object: NaidanSysfsBinaryObject,
}): string {
  return `\
# Binary Object

- id: ${object.id}
- name: ${object.name ?? 'null'}
- mimeType: ${object.mimeType}
- size: ${object.size} bytes
- createdAt: ${object.createdAt}
`;
}
