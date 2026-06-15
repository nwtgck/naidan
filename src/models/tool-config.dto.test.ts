import { describe, expect, it } from 'vitest';
import { ChatMetaSchemaDto } from './dto';
import { chatMetaToDomain, chatMetaToDto } from './mappers';

describe('experimental tool config DTO', () => {
  it('persists tool configs under chat meta experimental storage only', () => {
    const dto = ChatMetaSchemaDto.parse({
      id: 'chat-1',
      title: 'Chat 1',
      updatedAt: 2,
      createdAt: 1,
      experimental: {
        toolConfigs: [
          { key: 'builtin.calculator' },
          { key: 'builtin.calculator' },
          {
            key: 'builtin.wesh',
            naidanSysfs: {
              accessScope: 'main_chats',
            },
          },
        ],
      },
    });

    const domain = chatMetaToDomain({ dto });
    expect(domain.toolConfigs).toEqual([
      { key: 'builtin.calculator' },
      { key: 'builtin.calculator' },
      {
        key: 'builtin.wesh',
        naidanSysfs: {
          accessScope: 'main_chats',
        },
      },
    ]);

    expect(chatMetaToDto({ domain }).experimental?.toolConfigs).toEqual(domain.toolConfigs);
  });
});
