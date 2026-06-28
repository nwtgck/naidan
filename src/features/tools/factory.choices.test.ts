import { describe, expect, it, vi } from 'vitest';
import { toChatId } from '@/01-models/ids';
import { getEnabledTools } from './factory';

const settings = {
  storageType: 'local',
  mounts: [],
} as never;

describe('getEnabledTools choices', () => {
  it('creates the choices tool with chat-scoped interaction dependencies', async () => {
    const requestChoice = vi.fn().mockResolvedValue({ index: 0 });
    const tools = await getEnabledTools({
      enabledNames: ['choices'],
      settings,
      chatGroupMounts: undefined,
      chatMounts: undefined,
      chatId: toChatId({ raw: 'chat-a' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'none',
      tmpHandle: undefined,
      requestChoice,
    });

    expect(tools.map(({ name }) => name)).toEqual(['choices']);
    await expect(tools[0]!.execute({
      args: {
        prompt: 'Choose',
        choices: ['A', 'B'],
      },
      signal: undefined,
      approvalContext: undefined,
      onEvent: undefined,
    })).resolves.toMatchObject({ status: 'success' });
    expect(requestChoice).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-a' }),
      prompt: 'Choose',
      choices: ['A', 'B'],
      signal: undefined,
    });
  });

  it('does not expose choices without a chat or interaction handler', async () => {
    const withoutChat = await getEnabledTools({
      enabledNames: ['choices'],
      settings,
      chatGroupMounts: undefined,
      chatMounts: undefined,
      chatId: undefined,
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'none',
      tmpHandle: undefined,
      requestChoice: vi.fn(),
    });
    const withoutHandler = await getEnabledTools({
      enabledNames: ['choices'],
      settings,
      chatGroupMounts: undefined,
      chatMounts: undefined,
      chatId: toChatId({ raw: 'chat-a' }),
      chatGroupId: undefined,
      naidanSysfsAccessScope: 'none',
      tmpHandle: undefined,
      requestChoice: undefined,
    });

    expect(withoutChat).toEqual([]);
    expect(withoutHandler).toEqual([]);
  });
});
