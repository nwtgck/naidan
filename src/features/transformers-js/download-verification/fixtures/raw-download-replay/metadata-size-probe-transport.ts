/**
 * Counterfactual HTTP conditions on unchanged evidence bytes, not recorded
 * browser headers. This transport contract intentionally applies to every model;
 * model-specific resource and preparation expectations remain in separate tests.
 */
export function metadataSizeProbeTransport({ originalFetch }: { originalFetch: typeof fetch }): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const response = await originalFetch(input, init);
    if (response.status !== 200) return response;
    if (request.headers.has('Range')) {
      if (request.headers.get('Range') !== 'bytes=0-0') throw new Error('Unexpected fixture metadata range');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(bytes.slice(0, 1), { status: 206, headers: {
        'Content-Length': '1', 'Content-Range': `bytes 0-0/${bytes.byteLength}`,
      } });
    }
    response.headers.delete('Content-Length');
    return response;
  };
}

export const TEST_ONLY = {
};
