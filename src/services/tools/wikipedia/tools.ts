import type { Tool, ToolExecutionErrorCode, ToolExecutionEvent } from '@/services/tools/types';
import { WikipediaGetPageArgsSchema, WikipediaSearchArgsSchema } from './schemas';
import { getWikipediaPage, searchWikipedia } from './client';
import { renderWikipediaPageMarkdown, renderWikipediaSearchMarkdown } from './render';

export const WIKIPEDIA_SEARCH_TOOL_NAME = 'wikipedia_search';
export const WIKIPEDIA_GET_PAGE_TOOL_NAME = 'wikipedia_get_page';

function toExecutionErrorMessage({ error }: { error: unknown }) {
  return error instanceof Error ? error.message : String(error);
}

export class WikipediaSearchTool implements Tool {
  name = WIKIPEDIA_SEARCH_TOOL_NAME;
  description = `\
Search Wikipedia pages.

Use a concise search query. Do not include private text, logs, URLs, emails, IDs, secrets, or unnecessarily long user text.

If lang is provided, search that Wikipedia language edition only.
If lang is omitted, Naidan selects up to two likely Wikipedia language editions internally.
The result contains only title and pageId. Use wikipedia_get_page to read a page.`;
  parametersSchema = WikipediaSearchArgsSchema;

  async execute({
    args,
    signal,
    onEvent: _onEvent,
  }: {
    args: unknown;
    signal?: AbortSignal;
    onEvent?: (event: ToolExecutionEvent) => void | Promise<void>;
  }): Promise<
    | { status: 'success'; content: string }
    | { status: 'error'; code: ToolExecutionErrorCode; message: string }
  > {
    const validated = WikipediaSearchArgsSchema.safeParse(args);
    if (!validated.success) {
      return {
        status: 'error',
        code: 'invalid_arguments',
        message: `Invalid arguments: ${validated.error.message}`,
      };
    }

    try {
      const result = await searchWikipedia({
        lang: validated.data.lang,
        query: validated.data.query,
        contextLanguage: undefined,
        signal,
        fetchImpl: fetch,
      });
      return {
        status: 'success',
        content: renderWikipediaSearchMarkdown({
          groups: result.groups,
        }),
      };
    } catch (error) {
      return {
        status: 'error',
        code: 'execution_failed',
        message: `Wikipedia search failed: ${toExecutionErrorMessage({ error })}`,
      };
    }
  }
}

export class WikipediaGetPageTool implements Tool {
  name = WIKIPEDIA_GET_PAGE_TOOL_NAME;
  description = `\
Get the introductory text of a Wikipedia page by pageId.

Use pageId and lang from wikipedia_search results.
This tool returns a short introductory excerpt only.`;
  parametersSchema = WikipediaGetPageArgsSchema;

  async execute({
    args,
    signal,
    onEvent: _onEvent,
  }: {
    args: unknown;
    signal?: AbortSignal;
    onEvent?: (event: ToolExecutionEvent) => void | Promise<void>;
  }): Promise<
    | { status: 'success'; content: string }
    | { status: 'error'; code: ToolExecutionErrorCode; message: string }
  > {
    const validated = WikipediaGetPageArgsSchema.safeParse(args);
    if (!validated.success) {
      return {
        status: 'error',
        code: 'invalid_arguments',
        message: `Invalid arguments: ${validated.error.message}`,
      };
    }

    try {
      const page = await getWikipediaPage({
        lang: validated.data.lang,
        pageId: validated.data.pageId,
        signal,
        fetchImpl: fetch,
      });
      return {
        status: 'success',
        content: renderWikipediaPageMarkdown({
          page,
        }),
      };
    } catch (error) {
      return {
        status: 'error',
        code: 'execution_failed',
        message: `Wikipedia page fetch failed: ${toExecutionErrorMessage({ error })}`,
      };
    }
  }
}
