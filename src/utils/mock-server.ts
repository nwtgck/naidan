import http from 'http';
import type { AddressInfo } from 'net';
import type { RequestListener } from 'http';

export interface CapturedRequest {
  url?: string,
  method?: string,
  headers: http.IncomingHttpHeaders,
  body?: unknown,
}

/**
 * Starts a local mock HTTP server for testing LM providers.
 * Returns the base URL and a way to close the server and access captured requests.
 */
export async function startMockServer({ handler }: {
  handler: RequestListener,
}) {
  const capturedRequests: CapturedRequest[] = [];
  let server: http.Server | null = null;

  const baseUrl = await new Promise<string>((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const captured: CapturedRequest = {
          url: req.url,
          method: req.method,
          headers: req.headers,
        };
        if (body) {
          try {
            captured.body = JSON.parse(body);
          } catch {
            captured.body = body;
          }
        }
        capturedRequests.push(captured);
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  return {
    baseUrl,
    capturedRequests,
    close: () => new Promise<void>((resolve) => server?.close(() => resolve())),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
