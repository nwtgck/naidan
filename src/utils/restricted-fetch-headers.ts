import { z } from 'zod';

/** Browser-controlled and framing headers cannot be caller-controlled on the finite transport. */
const blocked = new Set(['host', 'origin', 'referer', 'cookie', 'cookie2', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding', 'access-control-request-method', 'access-control-request-headers']);
export const restrictedFetchHeadersSchema = z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(8192) })).max(32).superRefine((headers, context) => {
  const names = new Set<string>(); let bytes = 0;
  for (const header of headers) {
    const name = header.name.toLowerCase(); bytes += header.name.length + header.value.length;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header.name) || Array.from(header.value).some(character => {
      const code = character.charCodeAt(0); return code > 255 || code === 127 || (code < 32 && code !== 9);
    }) ||
        blocked.has(name) || name.startsWith('sec-') || name.startsWith('proxy-') || names.has(name))
      context.addIssue({ code: 'custom', message: 'Unsupported or duplicate HTTP request header' });
    names.add(name);
  }
  if (bytes > 16384) context.addIssue({ code: 'custom', message: 'HTTP request headers are too large' });
});
export const TEST_ONLY = {
};
