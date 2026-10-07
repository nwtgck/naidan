import { expect, it } from 'vitest';
import { restrictedFetchHeadersSchema } from './restricted-fetch-headers';

it('takes a private snapshot of ordinary request headers', () => {
  const input = [{ name: 'Authorization', value: 'Bearer test-only' }];
  const parsed = restrictedFetchHeadersSchema.parse(input);
  input[0]!.value = 'changed';
  expect(parsed).toEqual([{ name: 'Authorization', value: 'Bearer test-only' }]);
});
it.each(['Host', 'Origin', 'Cookie', 'Content-Length', 'Transfer-Encoding', 'Sec-Test', 'Proxy-Authorization'])('rejects browser controlled header %s', name => {
  expect(restrictedFetchHeadersSchema.safeParse([{ name, value: 'value' }]).success).toBe(false);
});
it.each(['value' + String.fromCharCode(13, 10) + 'injected: yes', '\0', '\u007f', '\u0100'])('rejects invalid header values without reporting their contents', value => {
  const result = restrictedFetchHeadersSchema.safeParse([{ name: 'Authorization', value }]);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues.every(issue => !issue.message.includes(value))).toBe(true);
});
it('rejects duplicate names case-insensitively and enforces aggregate limits', () => {
  expect(restrictedFetchHeadersSchema.safeParse([{ name: 'X-Test', value: 'a' }, { name: 'x-test', value: 'b' }]).success).toBe(false);
  expect(restrictedFetchHeadersSchema.safeParse(Array.from({ length: 3 }, (_, i) => ({ name: `X-${i}`, value: 'x'.repeat(8192) }))).success).toBe(false);
  expect(restrictedFetchHeadersSchema.safeParse(Array.from({ length: 33 }, (_, i) => ({ name: `X-${i}`, value: '' }))).success).toBe(false);
});
