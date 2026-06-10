import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetVolatileToolOutput } = vi.hoisted(() => ({
  mockGetVolatileToolOutput: vi.fn(),
}));

vi.mock('@/composables/useChat', () => ({
  useChat: () => ({
    getVolatileToolOutput: mockGetVolatileToolOutput,
  }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  chatVolatileState: {
    getVolatileToolOutput: mockGetVolatileToolOutput,
  },
}));

import { useToolCallOutput } from './useToolCallOutput';

describe('useToolCallOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVolatileToolOutput.mockReturnValue('streaming output');
  });

  it('reads live output for executing tool calls', () => {
    const toolCallOutput = useToolCallOutput();

    expect(toolCallOutput.getOutput({
      toolCallId: 'tool-call-1',
      status: 'executing',
    }).value).toBe('streaming output');

    expect(mockGetVolatileToolOutput).toHaveBeenCalledWith({
      toolCallId: 'tool-call-1',
    });
  });

  it('returns undefined for completed tool calls', () => {
    const toolCallOutput = useToolCallOutput();

    expect(toolCallOutput.getOutput({
      toolCallId: 'tool-call-1',
      status: 'success',
    }).value).toBeUndefined();

    expect(toolCallOutput.getOutput({
      toolCallId: 'tool-call-1',
      status: 'error',
    }).value).toBeUndefined();

    expect(mockGetVolatileToolOutput).not.toHaveBeenCalled();
  });
});
