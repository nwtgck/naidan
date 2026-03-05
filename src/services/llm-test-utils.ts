import http from 'http';
import type { AddressInfo } from 'net';

export interface CapturedRequest {
  url?: string;
  method?: string;
  headers: http.IncomingHttpHeaders;
  body?: any;
}

/**
 * Starts a local mock HTTP server for testing LLM providers.
 * Returns the base URL and a way to close the server and access captured requests.
 */
export async function startMockServer({ handler }: {
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
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
