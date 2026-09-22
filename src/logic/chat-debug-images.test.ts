import { expect, it } from 'vitest';
import { inspectDebugImages } from './chat-debug-images';
import type { AssistantMessageNode } from '@/01-models/types';
import { toMessageId } from '@/01-models/ids';
function message({ parts }: { parts: AssistantMessageNode['parts'] }): AssistantMessageNode {
  return { id: toMessageId({ raw: 'a' }), role: 'assistant', createdAt: 0, modelId: undefined, lmParameters: undefined, interruption: undefined, parts, replies: { items: [] } };
}
const block = `\
\`\`\`naidan_experimental_image
{"binaryObjectId":"binary","displayWidth":20,"displayHeight":20}
\`\`\``;
it('inspects each text independently without reading reasoning or joining parts', () => {
  const value = message({ parts: [
    { type: 'reasoning', text: block, completeness: 'complete' },
    { type: 'text', text: block.slice(0, 20), completeness: 'complete' },
    { type: 'text', text: block.slice(20), completeness: 'partial' },
  ] });
  expect(inspectDebugImages({ message: value })).toEqual({ images: [], errors: [] });
});
it('keeps repeated image occurrences distinct and leaves raw text untouched', () => {
  const value = message({ parts: [{ type: 'text', text: '<think>literal</think>' + block + block, completeness: 'partial' }] });
  const before = structuredClone(value); const result = inspectDebugImages({ message: value });
  expect(result.images.map(i => i.image.binaryObjectId)).toEqual(['binary', 'binary']);
  expect(new Set(result.images.map(i => i.key)).size).toBe(2); expect(value).toEqual(before);
});
it('reports malformed or invalid metadata without treating it as an image', () => {
  const value = message({ parts: [{ type: 'text', text: `\
\`\`\`naidan_experimental_image
not-json
\`\`\`
\`\`\`naidan_experimental_image
{"binaryObjectId":42}
\`\`\``, completeness: 'partial' }] });
  const result = inspectDebugImages({ message: value }); expect(result.images).toEqual([]); expect(result.errors).toHaveLength(2);
});
