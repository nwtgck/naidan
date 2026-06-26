import { handleFakeLmOllamaRequest } from '@/services/fake-lm/api/fakeLmOllamaApi';
import { handleFakeLmOpenAiRequest } from '@/services/fake-lm/api/fakeLmOpenAiApi';
import type { LmFetch } from '@/services/lm/fetch';

// eslint-disable-next-line local-rules-named-args/require-named-args -- fake fetch must match the native fetch signature.
export const fakeLmFetch: LmFetch = async (input, init) => {
  const request = await normalizeFakeLmFetchRequest({ input, init });
  const response = await handleFakeLmOpenAiRequest({ url: request.url, init: request.init })
    ?? await handleFakeLmOllamaRequest({ url: request.url, init: request.init });

  if (response !== undefined) {
    return response;
  }

  return Response.json({ error: `Unsupported fake LM route: ${request.url.pathname}` }, { status: 404 });
};

async function normalizeFakeLmFetchRequest({ input, init }: {
  input: RequestInfo | URL,
  init: RequestInit | undefined,
}): Promise<{ url: URL, init: RequestInit | undefined }> {
  if (!(input instanceof Request)) {
    return {
      url: toUrl({ input }),
      init: normalizeRequestInit({ init }),
    };
  }

  return {
    url: new URL(input.url),
    init: await mergeRequestInputAndInit({ request: input, init }),
  };
}

function toUrl({ input }: {
  input: Exclude<RequestInfo | URL, Request>,
}): URL {
  if (input instanceof URL) {
    return input;
  }

  return new URL(input);
}

function normalizeRequestInit({ init }: {
  init: RequestInit | undefined,
}): RequestInit | undefined {
  if (init?.method === undefined) {
    return init;
  }

  return {
    ...init,
    method: init.method.toUpperCase(),
  };
}

async function mergeRequestInputAndInit({ request, init }: {
  request: Request,
  init: RequestInit | undefined,
}): Promise<RequestInit> {
  const body = init?.body ?? await readRequestBodyText({ request });

  return {
    headers: init?.headers ?? request.headers,
    signal: init?.signal ?? request.signal,
    ...init,
    method: (init?.method ?? request.method).toUpperCase(),
    body,
  };
}

async function readRequestBodyText({ request }: {
  request: Request,
}): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  try {
    return await request.clone().text();
  } catch {
    return undefined;
  }
}
