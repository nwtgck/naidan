import type { Tool, ToolExecutionErrorCode, ToolExecutionEvent } from '@/services/tools/types';
import type { ToolApprovalContext } from '@/services/approval';
import { APPROVAL_ACTIONS } from '@/services/approval';
import { createApprovalDeniedToolError, createMissingApprovalContextToolError } from '@/services/tools/approval-errors';
import { WikipediaGetPageArgsSchema, WikipediaSearchArgsSchema } from './schemas';
import { getWikipediaPage, searchWikipedia } from './client';
import { renderWikipediaPageMarkdown, renderWikipediaSearchMarkdown } from './render';
import { getRememberedWikipediaPageTitle, rememberWikipediaPageTitle } from './page-title-cache';

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

Specify lang explicitly and search that Wikipedia language edition only.
The result contains only title and pageId. Use wikipedia_get_page to read a page.`;
  parametersSchema = WikipediaSearchArgsSchema;

  async execute({
    args,
    signal,
    onEvent: _onEvent,
    approvalContext,
  }: {
    args: unknown;
    signal?: AbortSignal;
    onEvent?: (event: ToolExecutionEvent) => void | Promise<void>;
    approvalContext?: ToolApprovalContext;
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

    if (approvalContext === undefined) {
      return createMissingApprovalContextToolError({
        action: APPROVAL_ACTIONS.toolWikipediaSearch,
      });
    }

    const approval = await approvalContext.ensureApproval({
      chatId: approvalContext.chatId,
      action: APPROVAL_ACTIONS.toolWikipediaSearch,
      preview: {
        type: 'wikipedia_search',
        keyword: validated.data.query,
      },
      signal,
    });

    switch (approval.status) {
    case 'approved':
      break;
    case 'denied':
      return createApprovalDeniedToolError({
        action: APPROVAL_ACTIONS.toolWikipediaSearch,
      });
    default: {
      const _ex: never = approval;
      throw new Error(`Unhandled approval status: ${String(_ex)}`);
    }
    }

    try {
      const result = await searchWikipedia({
        lang: validated.data.lang,
        query: validated.data.query,
        contextLanguage: undefined,
        signal,
        requestResponseImpl: undefined,
      });

      for (const group of result.groups) {
        for (const item of group.items) {
          rememberWikipediaPageTitle({
            lang: group.lang,
            pageId: item.pageId,
            title: item.title,
          });
        }
      }

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
Get the plain-text extract of a Wikipedia page by pageId.

Use pageId and lang from wikipedia_search results.
This tool returns the available plain-text page.
Long page text may be saved to sysfs Naidan instead of being returned inline.`;
  parametersSchema = WikipediaGetPageArgsSchema;

  async execute({
    args,
    signal,
    onEvent: _onEvent,
    approvalContext,
  }: {
    args: unknown;
    signal?: AbortSignal;
    onEvent?: (event: ToolExecutionEvent) => void | Promise<void>;
    approvalContext?: ToolApprovalContext;
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

    if (approvalContext === undefined) {
      return createMissingApprovalContextToolError({
        action: APPROVAL_ACTIONS.toolWikipediaGetPage,
      });
    }

    const rememberedTitle = getRememberedWikipediaPageTitle({
      lang: validated.data.lang,
      pageId: validated.data.pageId,
    });
    const approval = await approvalContext.ensureApproval({
      chatId: approvalContext.chatId,
      action: APPROVAL_ACTIONS.toolWikipediaGetPage,
      preview: {
        type: 'wikipedia_get_page',
        title: rememberedTitle,
        pageId: String(validated.data.pageId),
      },
      signal,
    });

    switch (approval.status) {
    case 'approved':
      break;
    case 'denied':
      return createApprovalDeniedToolError({
        action: APPROVAL_ACTIONS.toolWikipediaGetPage,
      });
    default: {
      const _ex: never = approval;
      throw new Error(`Unhandled approval status: ${String(_ex)}`);
    }
    }

    try {
      const page = await getWikipediaPage({
        lang: validated.data.lang,
        pageId: validated.data.pageId,
        signal,
        requestResponseImpl: undefined,
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
