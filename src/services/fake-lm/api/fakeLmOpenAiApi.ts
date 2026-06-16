import { OPENAI_FAKE_LM_MODELS, getFakeLmLanguageForModel, getFakeLmModeForModel } from '@/services/fake-lm/api/fakeLmModel';
import { createFakeLmSeedFromRequest } from '@/services/fake-lm/api/fakeLmRequestSeed';
import { FakeLmOpenAiChatRequestSchema } from '@/services/fake-lm/api/schemas';
import { analyzeFakeLmInputFromMessages } from '@/services/fake-lm/core/inputAnalysis';
import { streamFakeLmMarkdown, type FakeLmStreamItem } from '@/services/fake-lm/core/stream';
import { normalizeFakeLmThinkingEffort } from '@/services/fake-lm/core/thinking';

export async function handleFakeLmOpenAiRequest({ url, init }: {
  url: URL;
  init: RequestInit | undefined;
}): Promise<Response | undefined> {
  if (init?.method === undefined || init.method === 'GET') {
    if (url.pathname.endsWith('/models')) {
      return Response.json({
        data: OPENAI_FAKE_LM_MODELS.map((id) => ({ id })),
      });
    }
  }

  if (init?.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const rawBody = parseJsonBody({ body: init.body });
    const request = FakeLmOpenAiChatRequestSchema.safeParse(rawBody);
    if (!request.success) {
      return Response.json({ error: request.error.message }, { status: 400 });
    }

    const thinkingEffort = normalizeFakeLmThinkingEffort({
      value: request.data.thinking ?? request.data.reasoning?.effort ?? request.data.reasoning_effort,
    });
    const inputAnalysis = analyzeFakeLmInputFromMessages({ messages: request.data.messages });
    const seed = createFakeLmSeedFromRequest({
      model: request.data.model,
      messages: request.data.messages,
      thinkingEffort,
    });
    const language = getFakeLmLanguageForModel({ model: request.data.model, seed });
    const mode = getFakeLmModeForModel({ model: request.data.model });
    const chunks = streamFakeLmMarkdown({
      language,
      mode,
      seed,
      thinkingEffort,
      inputAnalysis,
      signal: init.signal ?? undefined,
      chunking: {
        minChars: 8,
        maxChars: 24,
        delayMs: 45,
      },
    });

    return createOpenAiSseResponse({ chunks });
  }

  return undefined;
}

function createOpenAiSseResponse({ chunks }: {
  chunks: AsyncIterable<FakeLmStreamItem>;
}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const item of chunks) {
        const delta = makeOpenAiDelta({ item });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [
            { delta },
          ],
        })}\n\n`));
      }

      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

function makeOpenAiDelta({ item }: {
  item: FakeLmStreamItem;
}): { reasoning_content: string } | { content: string } {
  switch (item.type) {
  case 'thinking':
    return { reasoning_content: item.chunk };
  case 'content':
    return { content: item.chunk };
  default: {
    const _ex: never = item;
    throw new Error(`Unhandled fake LM stream item: ${String(((_ex satisfies never) as { readonly type: string }).type)}`);
  }
  }
}

function parseJsonBody({ body }: {
  body: BodyInit | null | undefined;
}): unknown {
  if (typeof body !== 'string') {
    return undefined;
  }

  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
