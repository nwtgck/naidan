import fs from 'node:fs';
import path from 'node:path';
import type { Plugin, PluginOption } from 'vite';

type Metric = {
  calls: number;
  inputChars: number;
  items: number;
  maxWallMs: number;
  wallMs: number;
};

type MetricSample = Readonly<{
  inputChars?: number;
  items?: number;
}>;

const profileDirectory = process.env.NAIDAN_BUILD_PROFILE_DIR;
const metrics = new Map<string, Metric>();
const processStartedAt = process.hrtime.bigint();
const processCpuStartedAt = process.cpuUsage();
let configuredMode: string | undefined;
let exitHandlerInstalled = false;

function profileEnabled(): boolean {
  return profileDirectory !== undefined && profileDirectory !== '';
}

function addMeasurement({ name, wallMs, sample = {} }: {
  name: string;
  wallMs: number;
  sample?: MetricSample;
}): void {
  if (!profileEnabled()) return;
  const metric = metrics.get(name) ?? {
    calls: 0,
    inputChars: 0,
    items: 0,
    maxWallMs: 0,
    wallMs: 0,
  };
  metric.calls += 1;
  metric.inputChars += sample.inputChars ?? 0;
  metric.items += sample.items ?? 0;
  metric.maxWallMs = Math.max(metric.maxWallMs, wallMs);
  metric.wallMs += wallMs;
  metrics.set(name, metric);
}

function elapsedMs({ startedAt }: { startedAt: bigint }): number {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
}

export function profileBuildSync<T>({ name, sample, run }: {
  name: string;
  sample?: MetricSample;
  run: () => T;
}): T {
  if (!profileEnabled()) return run();
  const startedAt = process.hrtime.bigint();
  try {
    return run();
  } finally {
    addMeasurement({ name, sample, wallMs: elapsedMs({ startedAt }) });
  }
}

export async function profileBuildAsync<T>({ name, sample, run }: {
  name: string;
  sample?: MetricSample;
  run: () => Promise<T>;
}): Promise<T> {
  if (!profileEnabled()) return run();
  const startedAt = process.hrtime.bigint();
  try {
    return await run();
  } finally {
    addMeasurement({ name, sample, wallMs: elapsedMs({ startedAt }) });
  }
}

function writeBuildProfileReport(): void {
  if (!profileEnabled() || configuredMode === undefined || profileDirectory === undefined) return;
  fs.mkdirSync(profileDirectory, { recursive: true });
  const processCpu = process.cpuUsage(processCpuStartedAt);
  const report = {
    format: 'naidan-temporary-build-profile-v1',
    mode: configuredMode,
    generatedAt: new Date().toISOString(),
    notes: [
      'Temporary diagnostic data only; do not make build output depend on these timings.',
      'Nested metrics overlap and must not be added together as if they were disjoint phases.',
      'Hook wall times can overlap when Rolldown/Vite executes hooks concurrently.',
      'Use the Node CPU profiles and /usr/bin/time output alongside this report.',
    ],
    process: {
      wallMs: elapsedMs({ startedAt: processStartedAt }),
      cpuUserMs: processCpu.user / 1_000,
      cpuSystemMs: processCpu.system / 1_000,
      rssBytesAtReport: process.memoryUsage().rss,
    },
    metrics: [...metrics]
      .map(([name, metric]) => ({ name, ...metric }))
      .sort((left, right) => right.wallMs - left.wallMs || left.name.localeCompare(right.name)),
  };
  const jsonPath = path.join(profileDirectory, `${configuredMode}-plugin-profile.json`);
  const textPath = path.join(profileDirectory, `${configuredMode}-plugin-profile.txt`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    `mode\t${configuredMode}`,
    `process.wallMs\t${report.process.wallMs.toFixed(3)}`,
    `process.cpuUserMs\t${report.process.cpuUserMs.toFixed(3)}`,
    `process.cpuSystemMs\t${report.process.cpuSystemMs.toFixed(3)}`,
    `process.rssBytesAtReport\t${report.process.rssBytesAtReport}`,
    '',
    'wallMs\tmaxWallMs\tcalls\tinputChars\titems\tname',
    ...report.metrics.map((metric) => [
      metric.wallMs.toFixed(3),
      metric.maxWallMs.toFixed(3),
      String(metric.calls),
      String(metric.inputChars),
      String(metric.items),
      metric.name,
    ].join('\t')),
    '',
  ];
  fs.writeFileSync(textPath, lines.join('\n'));
}

export function configureBuildProfile({ mode }: { mode: string }): void {
  if (!profileEnabled()) return;
  configuredMode = mode;
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    try {
      writeBuildProfileReport();
    } catch (error) {
      console.error('[build-profile] Failed to write exit profile:', error);
    }
  });
}

type HookHandler = (this: unknown, ...args: unknown[]) => unknown;

function hookSample({ args, hookName }: { args: unknown[]; hookName: string }): MetricSample {
  const first = args[0];
  const inputChars = ['transform', 'renderChunk', 'transformIndexHtml'].includes(hookName) && typeof first === 'string'
    ? first.length
    : 0;
  const bundle = ['generateBundle', 'writeBundle'].includes(hookName) ? args[1] : undefined;
  const items = typeof bundle === 'object' && bundle !== null ? Object.keys(bundle).length : 0;
  return { inputChars, items };
}

function wrapHookHandler({ handler, metricName, hookName }: {
  handler: HookHandler;
  metricName: string;
  hookName: string;
}): HookHandler {
  return function profiledHook(this: unknown, ...args: unknown[]): unknown {
    if (!profileEnabled()) return Reflect.apply(handler, this, args);
    const startedAt = process.hrtime.bigint();
    const finish = (): void => {
      addMeasurement({
        name: metricName,
        sample: hookSample({ args, hookName }),
        wallMs: elapsedMs({ startedAt }),
      });
    };
    try {
      const result = Reflect.apply(handler, this, args);
      if (
        typeof result === 'object'
        && result !== null
        && 'then' in result
        && typeof (result as { then?: unknown }).then === 'function'
      ) {
        return Promise.resolve(result).then(
          (value) => {
            finish();
            return value;
          },
          (error: unknown) => {
            finish();
            throw error;
          },
        );
      }
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  };
}

const profiledHookNames = [
  'buildStart',
  'load',
  'transform',
  'renderChunk',
  'augmentChunkHash',
  'generateBundle',
  'writeBundle',
  'closeBundle',
  'transformIndexHtml',
] as const;

function shouldProfilePlugin({ plugin }: { plugin: Plugin }): boolean {
  return plugin.name.startsWith('naidan-')
    || plugin.name.startsWith('zip-packager-plugin-')
    || plugin.name === 'manual-gzip-wasm-plugin'
    || plugin.name === 'copy-zip-plugin';
}

function profilePlugin({ plugin }: { plugin: Plugin }): Plugin {
  if (!profileEnabled() || !shouldProfilePlugin({ plugin })) return plugin;
  const pluginRecord = plugin as unknown as Record<string, unknown>;
  const wrapped = { ...plugin } as Plugin;
  const wrappedRecord = wrapped as unknown as Record<string, unknown>;
  for (const hookName of profiledHookNames) {
    const hook = pluginRecord[hookName];
    const metricName = `plugin.${plugin.name}.${hookName}`;
    if (typeof hook === 'function') {
      wrappedRecord[hookName] = wrapHookHandler({
        handler: hook as HookHandler,
        hookName,
        metricName,
      });
      continue;
    }
    if (
      typeof hook === 'object'
      && hook !== null
      && 'handler' in hook
      && typeof (hook as { handler?: unknown }).handler === 'function'
    ) {
      const hookObject = hook as Record<string, unknown> & { handler: HookHandler };
      wrappedRecord[hookName] = {
        ...hookObject,
        handler: wrapHookHandler({
          handler: hookObject.handler,
          hookName,
          metricName,
        }),
      };
    }
  }
  return wrapped;
}

export function profilePluginOptions(options: PluginOption[]): PluginOption[] {
  if (!profileEnabled()) return options;
  const visit = ({ option }: { option: PluginOption }): PluginOption => {
    if (Array.isArray(option)) return option.map((nestedOption) => visit({ option: nestedOption }));
    if (option === false || option === null || option === undefined) return option;
    if (typeof option === 'object' && 'then' in option) return option;
    return profilePlugin({ plugin: option as Plugin });
  };
  return options.map((option) => visit({ option }));
}

export function createBuildProfileReporterPlugin(): Plugin {
  return {
    name: 'naidan-temporary-build-profile-reporter',
    closeBundle: {
      order: 'post',
      sequential: true,
      handler() {
        writeBuildProfileReport();
      },
    },
  };
}
