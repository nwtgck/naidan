import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MessageNodeSchemaDto,
  MessageNodeSchemaDtoV1,
  MessageNodeSchemaDtoV2,
  type MessageNodeDtoV2,
  type MessageNodeDtoV1,
} from './dto';

// The storage schema is deliberately tolerant of extra keys, not of unknown part kinds.
describe('message DTO versions', () => {
  it('reads all legacy roles without migrating them during parsing', () => {
    for (const role of ['user', 'assistant', 'system', 'tool']) {
      const parsed = MessageNodeSchemaDto.parse({
        id: role,
        role,
        timestamp: 0,
        ...(role === 'tool' ? { results: [] } : { content: '  Original\n' }),
        replies: { items: [] },
      });
      expect(parsed).toMatchObject({ id: role, role, timestamp: 0 });
      expect(Object.hasOwn(parsed, 'parts')).toBe(false);
    }
  });

  it('infers explicit undefined-only keys in the new schema', () => {
    type User = Extract<MessageNodeDtoV2, { role: 'user' }>;
    expectTypeOf<User['modelId']>().toEqualTypeOf<undefined>();
    expectTypeOf<User['parts'][number]>().not.toBeAny();
    const parsed = MessageNodeSchemaDtoV2.parse({ id: 'user', role: 'user', createdAt: 0, parts: [], replies: { items: [] } });
    expect(Object.hasOwn(parsed, 'modelId')).toBe(true);
    expect(Object.hasOwn(parsed, 'lmParameters')).toBe(true);
    expect(parsed.modelId).toBeUndefined();
  });

  it('keeps empty parts, literal thinking tags, partial content, and interruption separate', () => {
    const parsed = MessageNodeSchemaDtoV2.parse({
      id: 'assistant', role: 'assistant', createdAt: 0,
      parts: [
        { type: 'reasoning', text: '' },
        { type: 'text', text: '<think>literal</think>', completeness: 'partial' },
      ],
      interruption: { type: 'error', message: '接続が切れました: offline' },
      replies: { items: [] },
    });
    expect(parsed).toMatchObject({
      parts: [
        { type: 'reasoning', text: '', completeness: undefined },
        { type: 'text', text: '<think>literal</think>', completeness: 'partial' },
      ],
      interruption: { type: 'error', message: '接続が切れました: offline' },
    });
    expect(MessageNodeSchemaDto.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('preserves each version through nonempty recursive children', () => {
    const legacy = { id: 'u', role: 'user', content: '', timestamp: 1, replies: { items: [{ id: 'a', role: 'assistant', content: '', timestamp: 2, replies: { items: [] } }] } };
    const modern = { id: 'u', role: 'user', parts: [], createdAt: 1, replies: { items: [{ id: 'a', role: 'assistant', parts: [], createdAt: 2, replies: { items: [] } }] } };
    expect(MessageNodeSchemaDtoV1.parse(legacy).replies.items).toHaveLength(1);
    expect(MessageNodeSchemaDtoV2.parse(modern).replies.items).toHaveLength(1);
    expect(MessageNodeSchemaDto.safeParse({ ...legacy, replies: modern.replies }).success).toBe(false);
    expect(MessageNodeSchemaDto.safeParse({ ...modern, replies: legacy.replies }).success).toBe(false);
  });

  it('infers concrete recursive legacy and current nodes instead of any', () => {
    type LegacyChild = MessageNodeDtoV1['replies']['items'][number];
    type CurrentChild = MessageNodeDtoV2['replies']['items'][number];
    expectTypeOf<MessageNodeDtoV1>().not.toBeAny();
    expectTypeOf<LegacyChild>().not.toBeAny();
    expectTypeOf<CurrentChild>().not.toBeAny();
    expectTypeOf<LegacyChild['role']>().toEqualTypeOf<'user' | 'assistant' | 'system' | 'tool'>();
    expectTypeOf<Extract<LegacyChild, { role: 'assistant' }>['content']>().toEqualTypeOf<string>();
    expectTypeOf<CurrentChild['parts'][number]>().not.toBeAny();
  });

  it('does not fall back to a legacy message when the parts key is invalid', () => {
    for (const parts of [undefined, null, [], [{ id: 'p', type: 'unknown' }]]) {
      expect(MessageNodeSchemaDto.safeParse({ id: 'a', role: 'assistant', content: '', timestamp: 1, parts, replies: { items: [] } }).success).toBe(false);
    }
  });

  it('ignores extra object fields without accepting unknown parts or draft calls', () => {
    const modern = { id: 'a', role: 'assistant', createdAt: 1, parts: [], replies: { items: [] }, added_metadata: 'ignored' };
    const parsed = MessageNodeSchemaDto.parse(modern);
    expect(Object.hasOwn(parsed, 'added_metadata')).toBe(false);
    for (const type of ['unknown', 'tool_call_draft']) {
      expect(MessageNodeSchemaDto.safeParse({ ...modern, parts: [{ id: 'p', type }] }).success).toBe(false);
    }
  });
});
