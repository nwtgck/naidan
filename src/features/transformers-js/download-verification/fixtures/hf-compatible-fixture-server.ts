import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface FixtureLfsMetadata {
  sha256: string;
  size: number;
  pointerSize: number;
}

export interface HuggingFaceRepositoryFixtureFile {
  path: string;
  size: number;
  blobId?: string;
  lfs?: FixtureLfsMetadata;
}

export interface HuggingFaceRepositoryFixture {
  modelId: string;
  resolvedRevision: string;
  files: HuggingFaceRepositoryFixtureFile[];
}

export interface HuggingFaceFixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

export interface HuggingFaceFixtureServerBehavior {
  head?: 'normal' | 'insufficient' | 'not-found';
  range?: 'normal' | 'ignore' | 'not-found' | 'disconnect' | 'slow';
  fullGet?: 'refuse' | 'synthetic' | 'disconnect';
  disconnectAfterBytes?: number;
  ignoredRangeBodyBytes?: number;
  syntheticFullGetBytes?: number;
  slowDelayMs?: number;
}

const DEFAULT_DISCONNECT_AFTER_BYTES = 2048;
const DEFAULT_IGNORED_RANGE_BODY_BYTES = 96 * 1024;
const DEFAULT_SYNTHETIC_FULL_GET_BYTES = 32 * 1024;
const DEFAULT_SLOW_DELAY_MS = 100;

function setCommonHeaders({ response }: { response: ServerResponse }): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Cache-Control', 'no-store');
}

function writeJson({ response, value }: { response: ServerResponse; value: unknown }): void {
  const body = JSON.stringify(value);
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function parseRange({ value, size }: { value: string | undefined; size: number }): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(value ?? '');
  if (match === null) return undefined;
  const start = Number(match[1]);
  const requestedEnd = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || requestedEnd < start || start >= size) {
    return undefined;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function artifactEtag({ file }: { file: HuggingFaceRepositoryFixtureFile }): string {
  return file.lfs?.sha256 ?? file.blobId ?? `fixture-${encodeURIComponent(file.path)}`;
}

function handleHead({ response, file, behavior }: {
  response: ServerResponse;
  file: HuggingFaceRepositoryFixtureFile;
  behavior: HuggingFaceFixtureServerBehavior['head'];
}): void {
  const normalizedBehavior = behavior ?? 'normal';
  switch (normalizedBehavior) {
  case 'normal':
    response.statusCode = 200;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', file.size);
    response.end();
    return;
  case 'insufficient':
    response.statusCode = 200;
    response.end();
    return;
  case 'not-found':
    response.statusCode = 404;
    response.end();
    return;
  default: {
    const _ex: never = normalizedBehavior;
    throw new Error(`Unhandled HEAD fixture behavior: ${_ex}`);
  }
  }
}

function writeNormalRange({ response, file, range }: {
  response: ServerResponse;
  file: HuggingFaceRepositoryFixtureFile;
  range: { start: number; end: number };
}): void {
  const byteLength = range.end - range.start + 1;
  response.statusCode = 206;
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
  response.setHeader('Content-Length', byteLength);
  response.end(Buffer.alloc(byteLength, 0x5a));
}

function handleRange({ request, response, file, behavior }: {
  request: IncomingMessage;
  response: ServerResponse;
  file: HuggingFaceRepositoryFixtureFile;
  behavior: HuggingFaceFixtureServerBehavior;
}): void {
  const range = parseRange({ value: request.headers.range, size: file.size });
  if (range === undefined) {
    const fullGetBehavior = behavior.fullGet ?? 'refuse';
    switch (fullGetBehavior) {
    case 'refuse':
      // Default safety rule: a test bug must never turn repository metadata into
      // a transfer proportional to a real model artifact's declared size.
      response.statusCode = 416;
      response.setHeader('Content-Range', `bytes */${file.size}`);
      response.end();
      return;
    case 'synthetic': {
      const bodyBytes = Math.max(1, Math.min(
        file.size,
        behavior.syntheticFullGetBytes ?? DEFAULT_SYNTHETIC_FULL_GET_BYTES,
      ));
      response.statusCode = 200;
      response.setHeader('Content-Length', bodyBytes);
      response.end(Buffer.alloc(bodyBytes, 0x46));
      return;
    }
    case 'disconnect': {
      const fullBodyBytes = Math.max(2, Math.min(
        file.size,
        behavior.syntheticFullGetBytes ?? DEFAULT_SYNTHETIC_FULL_GET_BYTES,
      ));
      const deliveredBytes = Math.max(1, Math.min(
        fullBodyBytes - 1,
        behavior.disconnectAfterBytes ?? DEFAULT_DISCONNECT_AFTER_BYTES,
      ));
      response.statusCode = 200;
      response.setHeader('Content-Length', fullBodyBytes);
      response.flushHeaders();
      response.write(Buffer.alloc(deliveredBytes, 0x44));
      setImmediate(() => response.destroy());
      return;
    }
    default: {
      const _ex: never = fullGetBehavior;
      throw new Error(`Unhandled full GET fixture behavior: ${_ex}`);
    }
    }
  }

  const normalizedRangeBehavior = behavior.range ?? 'normal';
  switch (normalizedRangeBehavior) {
  case 'normal':
    writeNormalRange({ response, file, range });
    return;
  case 'ignore': {
    response.statusCode = 200;
    const bodyBytes = Math.max(1, Math.min(
      file.size,
      behavior.ignoredRangeBodyBytes ?? DEFAULT_IGNORED_RANGE_BODY_BYTES,
    ));
    response.end(Buffer.alloc(bodyBytes, 0x49));
    return;
  }
  case 'not-found':
    response.statusCode = 404;
    response.end();
    return;
  case 'disconnect': {
    const requestedBytes = range.end - range.start + 1;
    const deliveredBytes = Math.max(1, Math.min(
      requestedBytes,
      behavior.disconnectAfterBytes ?? DEFAULT_DISCONNECT_AFTER_BYTES,
    ));
    response.statusCode = 206;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    response.setHeader('Content-Length', requestedBytes);
    response.flushHeaders();
    response.write(Buffer.alloc(deliveredBytes, 0x44));
    setImmediate(() => response.destroy());
    return;
  }
  case 'slow': {
    const delayMs = Math.max(1, behavior.slowDelayMs ?? DEFAULT_SLOW_DELAY_MS);
    setTimeout(() => {
      if (response.destroyed) return;
      writeNormalRange({ response, file, range });
    }, delayMs);
    return;
  }
  default: {
    const _ex: never = normalizedRangeBehavior;
    throw new Error(`Unhandled Range fixture behavior: ${_ex}`);
  }
  }
}

function handleCdnArtifact({ request, response, file, behavior }: {
  request: IncomingMessage;
  response: ServerResponse;
  file: HuggingFaceRepositoryFixtureFile;
  behavior: HuggingFaceFixtureServerBehavior;
}): void {
  setCommonHeaders({ response });
  response.setHeader('ETag', artifactEtag({ file }));
  response.setHeader('Content-Type', 'application/octet-stream');

  if (request.method === 'HEAD') {
    handleHead({ response, file, behavior: behavior.head });
    return;
  }

  if (request.method !== 'GET') {
    response.statusCode = 405;
    response.end();
    return;
  }

  handleRange({ request, response, file, behavior });
}

export async function createHuggingFaceFixtureServer({ repository, behavior = {} }: {
  repository: HuggingFaceRepositoryFixture;
  behavior?: HuggingFaceFixtureServerBehavior;
}): Promise<HuggingFaceFixtureServer> {
  const filesByPath = new Map(repository.files.map(file => [file.path, file]));
  const apiPath = `/api/models/${repository.modelId}/revision/main`;
  const resolvePrefix = `/${repository.modelId}/resolve/${repository.resolvedRevision}/`;
  const cdnPrefix = `/fixture-cdn/${repository.modelId}/${repository.resolvedRevision}/`;

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://fixture.invalid');
    setCommonHeaders({ response });

    if (requestUrl.pathname === apiPath && request.method === 'GET') {
      writeJson({
        response,
        value: {
          sha: repository.resolvedRevision,
          siblings: repository.files.map(file => ({
            rfilename: file.path,
            size: file.size,
            blobId: file.blobId,
            ...(file.lfs === undefined ? {} : {
              lfs: {
                sha256: file.lfs.sha256,
                size: file.lfs.size,
                pointerSize: file.lfs.pointerSize,
              },
            }),
          })),
        },
      });
      return;
    }

    if (requestUrl.pathname.startsWith(resolvePrefix)) {
      const path = decodeURIComponent(requestUrl.pathname.slice(resolvePrefix.length));
      const file = filesByPath.get(path);
      if (file === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = 302;
      response.setHeader(
        'Location',
        `${cdnPrefix}${path.split('/').map(part => encodeURIComponent(part)).join('/')}?X-Amz-Signature=fixture-secret`,
      );
      response.end();
      return;
    }

    if (requestUrl.pathname.startsWith(cdnPrefix)) {
      const path = decodeURIComponent(requestUrl.pathname.slice(cdnPrefix.length));
      const file = filesByPath.get(path);
      if (file === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      handleCdnArtifact({ request, response, file, behavior });
      return;
    }

    response.statusCode = 404;
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Hugging Face fixture server did not expose a TCP address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error));
      });
    },
  };
}

// Test-only fixture server. Do not reference this module from production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  DEFAULT_DISCONNECT_AFTER_BYTES,
  DEFAULT_IGNORED_RANGE_BODY_BYTES,
  DEFAULT_SYNTHETIC_FULL_GET_BYTES,
  DEFAULT_SLOW_DELAY_MS,
};
