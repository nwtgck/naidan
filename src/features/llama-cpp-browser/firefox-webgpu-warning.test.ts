import { describe, expect, it } from 'vitest';
import { hasFirefoxWebGpuPollingIssue } from './firefox-webgpu-warning';

describe('Firefox WebGPU polling advisory policy', () => {
  it.each([
    ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0'],
    ['Android', 'Mozilla/5.0 (Android 15; Mobile; rv:155.0) Gecko/155.0 Firefox/155.0'],
    ['Gecko derivative', 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0 LibreWolf/155.0'],
  ])('includes Firefox on %s without an OS or GPU vendor restriction', (_name, userAgent) => {
    expect(hasFirefoxWebGpuPollingIssue({ userAgent })).toBe(true);
  });

  it.each([
    ['Chrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'],
    ['Edge', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0'],
    ['Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'],
    ['Firefox for iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/155.0 Mobile/15E148 Safari/605.1.15'],
    ['iOS with both tokens', 'FxiOS/155.0 Firefox/155.0'],
    ['missing version', 'Firefox/'],
    ['unrelated token', 'NotFirefox/155.0'],
    ['unknown browser', ''],
  ])('excludes %s', (_name, userAgent) => {
    expect(hasFirefoxWebGpuPollingIssue({ userAgent })).toBe(false);
  });
});
