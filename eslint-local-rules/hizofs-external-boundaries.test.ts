import { beforeAll, describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import * as parser from '@typescript-eslint/parser';
import { rule as networkRule } from './no-hizofs-external-network.js';
import { rule as processRule } from './no-hizofs-test-external-process.js';

const repoRoot = path.resolve(__dirname, '..');

function createRuleEslint({ name, rule }: {
  name: string;
  rule: typeof networkRule;
}): ESLint {
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: {
      files: ['**/*.ts'],
      languageOptions: {
        parser,
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
      },
      plugins: {
        guard: {
          rules: { [name]: rule },
        },
      },
      rules: { [`guard/${name}`]: 'error' },
    },
  });
}

async function lintText({ code, eslint, filePath }: {
  code: string;
  eslint: ESLint;
  filePath: string;
}) {
  const [result] = await eslint.lintText(code, { filePath: path.resolve(repoRoot, filePath) });
  return result.messages;
}

describe('HizoFS external network guard', () => {
  const eslint = createRuleEslint({ name: 'network', rule: networkRule });

  it('rejects direct, member, aliased, and destructured browser network APIs', async () => {
    const messages = await lintText({
      code: `\
fetch('/same-origin');
globalThis.fetch('http://localhost');
new WebSocket('ws://127.0.0.1');
new window.XMLHttpRequest();
new WebSocketStream('wss://example.test');
new WebTransport('https://example.test');
new RTCPeerConnection();
new Image();
new Audio();
importScripts('./classic-worker-helper.js');
navigator.sendBeacon('/audit', bytes);
navigator.serviceWorker.register('./service-worker.js');
CSS.paintWorklet.addModule('./paint-worklet.js');
const request = self.fetch;
const { EventSource: Stream } = globalThis;
const boundFetch = fetch.bind(globalThis);
const { sendBeacon: beacon } = navigator;
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/example.ts',
    });

    expect(messages.map(message => message.messageId)).toEqual([
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
      'browserNetworkApi',
    ]);
  });

  it('rejects document capability references without banning shadowed local values', async () => {
    const messages = await lintText({
      code: `\
document;
window.document;
const browserDocument = globalThis.document;
const { document: aliasedDocument } = self;
function inspect(document: unknown) {
  return document;
}
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/example.ts',
    });

    expect(messages.map(message => message.messageId)).toEqual([
      'documentCapability',
      'documentCapability',
      'documentCapability',
      'documentCapability',
    ]);
  });

  it('rejects navigation side effects while allowing location reads and reload', async () => {
    const messages = await lintText({
      code: `\
location.href = '/next';
document.location = '/next';
window.location.href = '/next';
location.assign('/next');
globalThis.location.replace('/next');
window.open('/next');
const navigate = self.location.assign;
const current = location.href;
location.reload();
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/example.ts',
    });

    expect(messages.map(message => message.messageId)).toEqual([
      'navigationSideEffect',
      'navigationSideEffect',
      'documentCapability',
      'navigationSideEffect',
      'navigationSideEffect',
      'navigationSideEffect',
      'navigationSideEffect',
      'navigationSideEffect',
    ]);
  });

  it('rejects static, dynamic, require, network-client, and project-wrapper imports', async () => {
    const messages = await lintText({
      code: `\
import http from 'node:http';
import http2 from 'node:http2';
import client from 'undici';
import { createPrivacyFetchClient } from '@/features/privacy-fetch/client-hosted';
void import('node:dns/promises');
void import('https://example.test/module.js');
const tls = require('tls');
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/example.ts',
    });

    expect(messages.map(message => message.messageId)).toEqual([
      'networkModule',
      'networkModule',
      'networkModule',
      'networkModule',
      'networkModule',
      'remoteModule',
      'networkModule',
    ]);
  }, 20_000);

  it('allows shadowed names, URL parsing, local module loading, and in-browser coordination', async () => {
    const messages = await lintText({
      code: `\
import { fetch } from './fixture-fetch';
const parsed = new URL('./worker-entry.ts', import.meta.url);
void import('./codec');
fetch('/in-process-fixture');
new Worker(parsed, { type: 'module' });
new SharedWorker(parsed, { type: 'module' });
new BroadcastChannel('hizofs');
new MessageChannel();
navigator.locks.request('hizofs', async () => undefined);
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/example.ts',
    });

    expect(messages).toHaveLength(0);
  }, 20_000);
});

describe('HizoFS test external process guard', () => {
  const eslint = createRuleEslint({ name: 'process', rule: processRule });

  it('rejects aliased, namespace, dynamic, and require-based Node process APIs', async () => {
    const messages = await lintText({
      code: `\
import { execFile as run } from 'node:child_process';
import * as execa from 'execa';
void import('cross-spawn');
const shell = require('shelljs');
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/tests/example.test.ts',
    });

    expect(messages.map(message => message.messageId)).toEqual([
      'processModule',
      'processModule',
      'processModule',
      'processModule',
    ]);
  });

  it('allows command-like fixture strings and in-process workers', async () => {
    const messages = await lintText({
      code: `\
const fixture = 'tool --flag';
const spawn = () => fixture;
spawn();
new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/tests/example.test.ts',
    });

    expect(messages).toHaveLength(0);
  });
});

describe('HizoFS external boundary lint config integration', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint({ cwd: repoRoot });
  });

  it('enables network guard for HizoFS production and tests but not unrelated source', async () => {
    const production = await lintText({
      code: `fetch('/same-origin');`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/compatibility/index.ts',
    });
    const test = await lintText({
      code: `fetch('http://localhost');`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/tests/private-provenance.test.ts',
    });
    const unrelated = await lintText({
      code: `fetch('/allowed-outside-hizofs');`,
      eslint,
      filePath: 'src/utils/module-loader.ts',
    });

    expect(production.map(message => message.ruleId)).toContain('local-rules-hizofs-network/no-external-network');
    expect(test.map(message => message.ruleId)).toContain('local-rules-hizofs-network/no-external-network');
    expect(unrelated.map(message => message.ruleId)).not.toContain('local-rules-hizofs-network/no-external-network');
  }, 20_000);

  it('enables process guard only for HizoFS test assets, including testing helpers', async () => {
    const test = await lintText({
      code: `import { spawn } from 'node:child_process';`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/tests/private-provenance.test.ts',
    });
    const testingHelper = await lintText({
      code: `import { execFile } from 'node:child_process';`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/runtime/testing/home-record-reference-fixture.ts',
    });
    const production = await lintText({
      code: `import { spawn } from 'node:child_process';`,
      eslint,
      filePath: 'src/00-storage/service/hizofs/compatibility/index.ts',
    });

    expect(test.map(message => message.ruleId)).toContain('local-rules-hizofs-test-process/no-external-process');
    expect(testingHelper.map(message => message.ruleId)).toContain('local-rules-hizofs-test-process/no-external-process');
    expect(production.map(message => message.ruleId)).not.toContain('local-rules-hizofs-test-process/no-external-process');
  }, 20_000);
});
