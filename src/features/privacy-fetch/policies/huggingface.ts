import type { PrivacyFetchValidationResult } from '@/features/privacy-fetch/types';

const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateHuggingFacePrivacyFetchUrl({ url }: { url: URL }): PrivacyFetchValidationResult {
  const reject = (): PrivacyFetchValidationResult => ({
    ok: false, code: 'unsupported_policy', message: 'The URL does not match a supported public Hugging Face model request',
  });
  let parts: string[];
  try {
    parts = url.pathname.slice(1).split('/').map(part => decodeURIComponent(part));
  } catch {
    return reject();
  }
  if (url.hostname !== 'huggingface.co' || parts.some(part => part.length === 0 || part === '.' || part === '..' || /[\\/]/u.test(part) || [...part].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    return reject();
  }
  const metadata = parts[0] === 'api' && parts[1] === 'models' && (
    parts.length === 4 || (parts.length === 6 && parts[4] === 'revision')
  );
  const tree = parts[0] === 'api' && parts[1] === 'models' && parts[4] === 'tree' && parts.length >= 6;
  const resolve = parts[2] === 'resolve' && parts.length >= 5 && /\.(gguf|safetensors|sft)$/i.test(parts.at(-1) ?? '');
  if (!metadata && !tree && !resolve) return reject();
  const identifiers = resolve ? [parts[0], parts[1], parts[3]] : [parts[2], parts[3], ...(parts[5] === undefined ? [] : [parts[5]])];
  if (identifiers.some(part => part === undefined || !segmentPattern.test(part))) return reject();
  const allowedKeys = tree ? ['recursive', 'expand', 'limit', 'cursor'] : resolve ? ['download'] : [];
  for (const [key, value] of url.searchParams) {
    if (!allowedKeys.includes(key) || url.searchParams.getAll(key).length !== 1) return reject();
    if ((key === 'recursive' || key === 'expand' || key === 'download') && !['true', 'false', '1', '0'].includes(value)) return reject();
    if (key === 'limit' && (!/^[1-9]\d{0,3}$/.test(value) || Number(value) > 1000)) return reject();
    if (key === 'cursor' && (value.length === 0 || value.length > 8192 || /[\r\n]/.test(value))) return reject();
  }
  return { ok: true, policyName: 'huggingface_models', normalizedUrl: url.href };
}

// Fetch follows CORS redirects internally; intermediate hops cannot be inspected by JavaScript.
// Only a validated resolve request may finish on the model delivery services below.
export function isAllowedHuggingFaceResponseUrl({ requestUrl, responseUrl }: { requestUrl: string, responseUrl: string }): boolean {
  let final: URL;
  try {
    final = new URL(responseUrl);
  } catch {
    return false;
  }
  if (final.protocol !== 'https:' || final.username || final.password || final.port || final.hash) return false;
  if (final.hostname === 'huggingface.co') return true;
  if (new URL(requestUrl).pathname.split('/')[3] !== 'resolve') return false;
  return [
    'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co', 'cdn-lfs-eu-1.hf.co',
    // https://huggingface.co/docs/hub/models-downloading#downloading-behind-a-proxy-or-firewall
    'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co', 'us.gcp.cdn.hf.co',
  ].includes(final.hostname);
}

export const TEST_ONLY = {
};
