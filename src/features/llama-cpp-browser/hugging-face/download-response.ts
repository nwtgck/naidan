export function responseOffset({ status, headers, offset, size }: { status: number, headers: Headers, offset: number, size: number }): number {
  const length = headers.get('content-length');
  if (status === 200) {
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) throw new Error('Invalid download response size');
    return 0;
  }
  if (status !== 206) throw new Error(`Download HTTP ${status}`);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') ?? '');
  if (!range || Number(range[1]) !== offset || Number(range[2]) !== size - 1 || Number(range[3]) !== size || (length !== null && (!/^\d+$/.test(length) || Number(length) !== size - offset))) throw new Error('Invalid download Content-Range');
  return offset;
}
export const TEST_ONLY = {
};
