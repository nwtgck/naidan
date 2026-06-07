import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WikipediaGetPageTool, WikipediaSearchTool } from './tools';

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

describe('WikipediaSearchTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    const tool = new WikipediaSearchTool();
    const result = await tool.execute({
      args: { lang: 'en', query: 'quantum computer' },
    });

    expect(mockSearchWikipedia).toHaveBeenCalledWith({
      lang: 'en',
      query: 'quantum computer',
      contextLanguage: undefined,
      signal: undefined,
      fetchImpl: fetch,
    });
    expect(mockRenderWikipediaSearchMarkdown).toHaveBeenCalledWith({
      groups: [{ lang: 'en', items: [{ title: 'Quantum computing', pageId: 25220 }] }],
    });
    expect(result).toEqual({ status: 'success', content: 'markdown' });
  });
});

describe('WikipediaGetPageTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      lang: 'en',
      pageId: 25220,
      title: 'Quantum computing',
      content: 'Intro',
    });
    mockRenderWikipediaPageMarkdown.mockReturnValue('markdown');

    const tool = new WikipediaGetPageTool();
    const result = await tool.execute({
      args: { lang: 'en', pageId: 25220 },
    });

    expect(mockGetWikipediaPage).toHaveBeenCalledWith({
      lang: 'en',
      pageId: 25220,
      signal: undefined,
      fetchImpl: fetch,
    });
    expect(mockRenderWikipediaPageMarkdown).toHaveBeenCalledWith({
      page: {
        lang: 'en',
        pageId: 25220,
        title: 'Quantum computing',
        content: 'Intro',
      },
    });
    expect(result).toEqual({ status: 'success', content: 'markdown' });
  });
});
