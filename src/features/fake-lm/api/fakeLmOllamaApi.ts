import { z } from 'zod';
import { OLLAMA_FAKE_LM_MODELS, getFakeLmLanguageForModel, getFakeLmModeForModel } from '@/features/fake-lm/api/fakeLmModel';
import { createFakeLmSeedFromRequest } from '@/features/fake-lm/api/fakeLmRequestSeed';
import { FakeLmOllamaChatRequestSchema } from '@/features/fake-lm/api/schemas';
import { analyzeFakeLmInputFromMessages } from '@/features/fake-lm/core/inputAnalysis';
import { streamFakeLmMarkdown, type FakeLmStreamItem } from '@/features/fake-lm/core/stream';
import { normalizeFakeLmThinkingEffort } from '@/features/fake-lm/core/thinking';

const FakeLmOllamaUnloadRequestSchema = z.object({
  model: z.string(),
  stream: z.literal(false).optional(),
  keep_alive: z.literal(0),
});

export async function handleFakeLmOllamaRequest({ url, init }: {
  url: URL,
  init: RequestInit | undefined,
}): Promise<Response | undefined> {
  if ((init?.method === undefined || init.method === 'GET') && url.pathname.endsWith('/api/tags')) {
    return Response.json({
      models: OLLAMA_FAKE_LM_MODELS.map((name) => ({ name })),
    });
  }

  if ((init?.method === undefined || init.method === 'GET') && url.pathname.endsWith('/api/ps')) {
    return Response.json({ models: [] });
  }

  if (init?.method === 'POST' && url.pathname.endsWith('/api/generate')) {
    const rawBody = parseJsonBody({ body: init.body });
    const request = FakeLmOllamaUnloadRequestSchema.safeParse(rawBody);
    if (request.success) {
      return Response.json({
        model: request.data.model,
        response: '',
        done: true,
        done_reason: 'unload',
      });
    }
  }

  if (init?.method === 'POST' && url.pathname.endsWith('/api/chat')) {
    const rawBody = parseJsonBody({ body: init.body });
    const request = FakeLmOllamaChatRequestSchema.safeParse(rawBody);
    if (!request.success) {
      return Response.json({ error: request.error.message }, { status: 400 });
    }

    const thinkingEffort = normalizeFakeLmThinkingEffort({
      value: request.data.think ?? request.data.thinking,
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

    return createOllamaNdjsonResponse({ chunks });
  }

  return undefined;
}

function createOllamaNdjsonResponse({ chunks }: {
  chunks: AsyncIterable<FakeLmStreamItem>,
}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const item of chunks) {
        const message = makeOllamaMessage({ item });
        controller.enqueue(encoder.encode(`${JSON.stringify({
          message,
          done: false,
        })}\n`));
      }

      controller.enqueue(encoder.encode(`${JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
        },
        done: true,
      })}\n`));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
    },
  });
}

function makeOllamaMessage({ item }: {
  item: FakeLmStreamItem,
}): { role: 'assistant', thinking: string } | { role: 'assistant', content: string } {
  switch (item.type) {
  case 'thinking':
    return { role: 'assistant', thinking: item.chunk };
  case 'content':
    return { role: 'assistant', content: item.chunk };
  default: {
    const _ex: never = item;
    throw new Error(`Unhandled fake LM stream item: ${String(((_ex satisfies never) as { readonly type: string }).type)}`);
  }
  }
}

function parseJsonBody({ body }: {
  body: BodyInit | null | undefined,
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
