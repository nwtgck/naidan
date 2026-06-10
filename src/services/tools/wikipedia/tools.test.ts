import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WikipediaGetPageTool, WikipediaSearchTool } from './tools';
import type { ToolApprovalContext } from '@/services/approval';
import { clearRememberedWikipediaPageTitles, getRememberedWikipediaPageTitle, rememberWikipediaPageTitle } from './page-title-cache';

const {
  mockSearchWikipedia,
  mockGetWikipediaPage,
  mockRenderWikipediaSearchMarkdown,
  mockRenderWikipediaPageMarkdown,
} = vi.hoisted(() => ({
  mockSearchWikipedia: vi.fn(),
  mockGetWikipediaPage: vi.fn(),
  mockRenderWikipediaSearchMarkdown: vi.fn(),
  mockRenderWikipediaPageMarkdown: vi.fn(),
}));

vi.mock('./client', () => ({
  searchWikipedia: mockSearchWikipedia,
  getWikipediaPage: mockGetWikipediaPage,
}));

vi.mock('./render', () => ({
  renderWikipediaSearchMarkdown: mockRenderWikipediaSearchMarkdown,
  renderWikipediaPageMarkdown: mockRenderWikipediaPageMarkdown,
}));


function createApprovalContext({
  calls,
}: {
  calls: unknown[];
}): ToolApprovalContext {
  return {
    chatId: 'chat-approval-test',
    ensureApproval: vi.fn(async (request) => {
      calls.push(request);
      return { status: 'approved' as const };
    }),
  };
}

describe('WikipediaSearchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRememberedWikipediaPageTitles({});
  });

  it('accepts lang and query in parametersSchema', () => {
    const tool = new WikipediaSearchTool();
    expect(() => tool.parametersSchema.parse({ lang: 'en', query: 'quantum computer' })).not.toThrow();
  });

  it('returns invalid_arguments for invalid args', async () => {
    const tool = new WikipediaSearchTool();

    const result = await tool.execute({
      args: { query: 'quantum computer' },
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('invalid_arguments');
    }
  });

  it('delegates to client and render', async () => {
    mockSearchWikipedia.mockResolvedValue({
      groups: [{ lang: 'en', items: [{ title: 'Quantum computing', pageId: 25220 }] }],
    });
    mockRenderWikipediaSearchMarkdown.mockReturnValue('markdown');

    const approvalCalls: unknown[] = [];
    const tool = new WikipediaSearchTool();
    const result = await tool.execute({
      args: { lang: 'en', query: 'quantum computer' },
      approvalContext: createApprovalContext({ calls: approvalCalls }),
    });

    expect(approvalCalls).toEqual([{
      chatId: 'chat-approval-test',
      action: {
        id: 'tool.wikipedia.search',
        label: 'Search Wikipedia',
      },
      preview: {
        lines: [{
          label: 'Keyword',
          value: 'quantum computer',
        }],
      },
      signal: undefined,
    }]);
    expect(mockSearchWikipedia).toHaveBeenCalledWith({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    expect(mockRenderWikipediaSearchMarkdown).toHaveBeenCalledWith({
      groups: [{ lang: 'en', items: [{ title: 'Quantum computing', pageId: 25220 }] }],
    });
    expect(getRememberedWikipediaPageTitle({
      lang: 'en',
      pageId: 25220,
    })).toBe('Quantum computing');
    expect(result).toEqual({ status: 'success', content: 'markdown' });
  });
});

describe('WikipediaGetPageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearRememberedWikipediaPageTitles({});
  });

  it('accepts lang and pageId in parametersSchema', () => {
    const tool = new WikipediaGetPageTool();
    expect(() => tool.parametersSchema.parse({ lang: 'en', pageId: 25220 })).not.toThrow();
  });

  it('returns invalid_arguments for invalid args', async () => {
    const tool = new WikipediaGetPageTool();

    const result = await tool.execute({
      args: { lang: 'en', pageId: 0 },
    });

    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('invalid_arguments');
    }
  });

  it('delegates to client and render', async () => {
    mockGetWikipediaPage.mockResolvedValue({
      kind: 'inline',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: 'Intro',
    });
    mockRenderWikipediaPageMarkdown.mockReturnValue('markdown');

    const approvalCalls: unknown[] = [];
    const tool = new WikipediaGetPageTool();
    const result = await tool.execute({
      args: { lang: 'en', pageId: 25220 },
      approvalContext: createApprovalContext({ calls: approvalCalls }),
    });

    expect(approvalCalls).toEqual([{
      chatId: 'chat-approval-test',
      action: {
        id: 'tool.wikipedia.get_page',
        label: 'Get Wikipedia page',
      },
      preview: {
        lines: [{
          label: 'Page ID',
          value: '25220',
        }],
      },
      signal: undefined,
    }]);
    expect(mockGetWikipediaPage).toHaveBeenCalledWith({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      requestResponseImpl: undefined,
    });
    expect(mockRenderWikipediaPageMarkdown).toHaveBeenCalledWith({
      page: {
        kind: 'inline',
        lang: 'en',
        pageId: 25220,
        title: 'Quantum computing',
        content: 'Intro',
      },
    });
    expect(result).toEqual({ status: 'success', content: 'markdown' });
  });

  it('uses a remembered search title in get page approval preview', async () => {
    rememberWikipediaPageTitle({
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
    });
    rememberWikipediaPageTitle({
      lang: 'ja',
      pageId: 25220,
      title: '量子コンピュータ',
    });
    mockGetWikipediaPage.mockResolvedValue({
      kind: 'inline',
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: 'Intro',
    });
    mockRenderWikipediaPageMarkdown.mockReturnValue('markdown');

    const approvalCalls: unknown[] = [];
    const tool = new WikipediaGetPageTool();
    const result = await tool.execute({
      args: { lang: 'en', pageId: 25220 },
      approvalContext: createApprovalContext({ calls: approvalCalls }),
    });

    expect(approvalCalls).toEqual([{
      chatId: 'chat-approval-test',
      action: {
        id: 'tool.wikipedia.get_page',
        label: 'Get Wikipedia page',
      },
      preview: {
        lines: [
          {
            label: 'Title',
            value: 'Quantum computing',
          },
          {
            label: 'Page ID',
            value: '25220',
          },
        ],
      },
      signal: undefined,
    }]);
    expect(result).toEqual({ status: 'success', content: 'markdown' });
  });

});
