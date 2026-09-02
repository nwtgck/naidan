import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Plugin, PluginOption } from 'vite';

type ProfileSample = Readonly<{
  detail?: string;
  inputChars?: number;
  items?: number;
}>;

type SlowCall = Readonly<{
  wallMs: number;
  detail?: string;
  inputChars: number;
  items: number;
}>;

type Aggregate = {
  name: string;
  calls: number;
  wallMs: number;
  maxWallMs: number;
  minWallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  inputChars: number;
  items: number;
  maxObservedRssBytes: number;
  slowest: SlowCall[];
};

const profileDirectory = process.env.NAIDAN_BUILD_PROFILE_DIR?.trim();
const profileMode = process.env.NAIDAN_BUILD_PROFILE_MODE?.trim();
const profilingEnabled = Boolean(profileDirectory && profileMode);
const aggregates = new Map<string, Aggregate>();
const slowCallLimit = 40;
let exitHandlerInstalled = false;
const processStartedAt = performance.now();
const processCpuStartedAt = process.cpuUsage();

function safeProfileMode(): string {
  return (profileMode ?? 'unknown').replaceAll(/[^A-Za-z0-9._-]/gu, '_');
}

function currentRssBytes(): number {
  return typeof process.memoryUsage.rss === 'function'
    ? process.memoryUsage.rss()
    : process.memoryUsage().rss;
}

function observeSlowCall(aggregate: Aggregate, call: SlowCall): void {
  if (aggregate.slowest.length < slowCallLimit) {
    aggregate.slowest.push(call);
    aggregate.slowest.sort((left, right) => right.wallMs - left.wallMs);
    return;
  }
  const last = aggregate.slowest.at(-1);
  if (last !== undefined && call.wallMs <= last.wallMs) return;
  aggregate.slowest.pop();
  aggregate.slowest.push(call);
  aggregate.slowest.sort((left, right) => right.wallMs - left.wallMs);
}

function recordProfile({ name, wallMs, cpu, sample }: {
  name: string;
  wallMs: number;
  cpu: NodeJS.CpuUsage;
  sample: ProfileSample;
}): void {
  const inputChars = sample.inputChars ?? 0;
  const items = sample.items ?? 0;
  const rss = currentRssBytes();
  const aggregate = aggregates.get(name) ?? {
    name,
    calls: 0,
    wallMs: 0,
    maxWallMs: 0,
    minWallMs: Number.POSITIVE_INFINITY,
    cpuUserMs: 0,
    cpuSystemMs: 0,
    inputChars: 0,
    items: 0,
    maxObservedRssBytes: 0,
    slowest: [],
  };
  aggregate.calls += 1;
  aggregate.wallMs += wallMs;
  aggregate.maxWallMs = Math.max(aggregate.maxWallMs, wallMs);
  aggregate.minWallMs = Math.min(aggregate.minWallMs, wallMs);
  aggregate.cpuUserMs += cpu.user / 1_000;
  aggregate.cpuSystemMs += cpu.system / 1_000;
  aggregate.inputChars += inputChars;
  aggregate.items += items;
  aggregate.maxObservedRssBytes = Math.max(aggregate.maxObservedRssBytes, rss);
  observeSlowCall(aggregate, {
    wallMs,
    detail: sample.detail,
    inputChars,
    items,
  });
  aggregates.set(name, aggregate);
}

function reportObject(): unknown {
  const processCpu = process.cpuUsage(processCpuStartedAt);
  const resourceUsage = process.resourceUsage();
  return {
    mode: profileMode,
    generatedAt: new Date().toISOString(),
    process: {
      wallMs: performance.now() - processStartedAt,
      cpuUserMs: processCpu.user / 1_000,
      cpuSystemMs: processCpu.system / 1_000,
      rssBytesAtReport: currentRssBytes(),
      resourceUsage: {
        maxRssKiB: resourceUsage.maxRSS,
        minorPageFaults: resourceUsage.minorPageFault,
        majorPageFaults: resourceUsage.majorPageFault,
        voluntaryContextSwitches: resourceUsage.voluntaryContextSwitches,
        involuntaryContextSwitches: resourceUsage.involuntaryContextSwitches,
        fsRead: resourceUsage.fsRead,
        fsWrite: resourceUsage.fsWrite,
      },
    },
    metrics: [...aggregates.values()]
      .map((aggregate) => ({
        ...aggregate,
        minWallMs: Number.isFinite(aggregate.minWallMs) ? aggregate.minWallMs : 0,
      }))
      .sort((left, right) => right.wallMs - left.wallMs || left.name.localeCompare(right.name)),
  };
}

function reportText(report: ReturnType<typeof reportObject>): string {
  const typed = report as {
    mode: string | undefined;
    process: {
      wallMs: number;
      cpuUserMs: number;
      cpuSystemMs: number;
      rssBytesAtReport: number;
      resourceUsage: { maxRssKiB: number };
    };
    metrics: Array<Aggregate>;
  };
  const lines = [
    `mode\t${typed.mode ?? 'unknown'}`,
    `process.wallMs\t${typed.process.wallMs.toFixed(3)}`,
    `process.cpuUserMs\t${typed.process.cpuUserMs.toFixed(3)}`,
    `process.cpuSystemMs\t${typed.process.cpuSystemMs.toFixed(3)}`,
    `process.rssBytesAtReport\t${typed.process.rssBytesAtReport}`,
    `process.maxRssKiB\t${typed.process.resourceUsage.maxRssKiB}`,
    '',
    'wallMs\tmaxWallMs\tminWallMs\tcalls\tcpuUserMs\tcpuSystemMs\tinputChars\titems\tmaxObservedRssBytes\tname',
  ];
  for (const metric of typed.metrics) {
    lines.push([
      metric.wallMs.toFixed(3),
      metric.maxWallMs.toFixed(3),
      metric.minWallMs.toFixed(3),
      metric.calls,
      metric.cpuUserMs.toFixed(3),
      metric.cpuSystemMs.toFixed(3),
      metric.inputChars,
      metric.items,
      metric.maxObservedRssBytes,
      metric.name,
    ].join('\t'));
    for (const slow of metric.slowest.slice(0, 10)) {
      if (slow.detail === undefined) continue;
      lines.push([
        '#slow',
        slow.wallMs.toFixed(3),
        slow.inputChars,
        slow.items,
        slow.detail.replaceAll(/[\r\n\t]/gu, ' '),
      ].join('\t'));
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeReport(): void {
  if (!profilingEnabled || profileDirectory === undefined) return;
  fs.mkdirSync(profileDirectory, { recursive: true });
  const report = reportObject();
  const stem = `${safeProfileMode()}-build-profile`;
  fs.writeFileSync(path.join(profileDirectory, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(profileDirectory, `${stem}.txt`), reportText(report));
}

function installExitHandler(): void {
  if (!profilingEnabled || exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.once('exit', writeReport);
}

installExitHandler();

export function profileBuildSync<T>({ name, sample = {}, run }: {
  name: string;
  sample?: ProfileSample;
  run: () => T;
}): T {
  if (!profilingEnabled) return run();
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  try {
    return run();
  } finally {
    recordProfile({
      name,
      wallMs: performance.now() - startedAt,
      cpu: process.cpuUsage(cpuStartedAt),
      sample,
    });
  }
}

export async function profileBuildAsync<T>({ name, sample = {}, run }: {
  name: string;
  sample?: ProfileSample;
  run: () => Promise<T>;
}): Promise<T> {
  if (!profilingEnabled) return run();
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  try {
    return await run();
  } finally {
    recordProfile({
      name,
      wallMs: performance.now() - startedAt,
      cpu: process.cpuUsage(cpuStartedAt),
      sample,
    });
  }
}

type ProfiledHookName =
  | 'config'
  | 'configResolved'
  | 'buildStart'
  | 'resolveId'
  | 'load'
  | 'transform'
  | 'moduleParsed'
  | 'resolveDynamicImport'
  | 'buildEnd'
  | 'outputOptions'
  | 'renderStart'
  | 'renderDynamicImport'
  | 'augmentChunkHash'
  | 'renderChunk'
  | 'generateBundle'
  | 'writeBundle'
  | 'closeBundle'
  | 'transformIndexHtml';

const profiledHookNames: readonly ProfiledHookName[] = [
  'config',
  'configResolved',
  'buildStart',
  'resolveId',
  'load',
  'transform',
  'moduleParsed',
  'resolveDynamicImport',
  'buildEnd',
  'outputOptions',
  'renderStart',
  'renderDynamicImport',
  'augmentChunkHash',
  'renderChunk',
  'generateBundle',
  'writeBundle',
  'closeBundle',
  'transformIndexHtml',
];

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object'
    && value !== null
    && 'then' in value
    && typeof value.then === 'function';
}

function hookSample({ hookName, args }: {
  hookName: ProfiledHookName;
  args: readonly unknown[];
}): ProfileSample {
  const first = args[0];
  const second = args[1];
  let detail: string | undefined;
  let inputChars = 0;
  let items = 0;
  if (hookName === 'transform' && typeof first === 'string') {
    inputChars = first.length;
    if (typeof second === 'string') detail = second;
  } else if (['load', 'resolveId', 'resolveDynamicImport'].includes(hookName) && typeof first === 'string') {
    detail = first;
  } else if (hookName === 'renderChunk' && typeof first === 'string') {
    inputChars = first.length;
    if (typeof second === 'object' && second !== null && 'fileName' in second && typeof second.fileName === 'string') {
      detail = second.fileName;
    }
  } else if (hookName === 'augmentChunkHash' && typeof first === 'object' && first !== null && 'fileName' in first && typeof first.fileName === 'string') {
    detail = first.fileName;
  } else if ((hookName === 'generateBundle' || hookName === 'writeBundle') && typeof second === 'object' && second !== null) {
    items = Object.keys(second).length;
  } else if (hookName === 'transformIndexHtml' && typeof first === 'string') {
    inputChars = first.length;
  }
  return { detail, inputChars, items };
}

function invokeProfiledHook<T>({ name, sample, run }: {
  name: string;
  sample: ProfileSample;
  run: () => T;
}): T {
  if (!profilingEnabled) return run();
  const startedAt = performance.now();
  const cpuStartedAt = process.cpuUsage();
  let result: T;
  try {
    result = run();
  } catch (error) {
    recordProfile({ name, wallMs: performance.now() - startedAt, cpu: process.cpuUsage(cpuStartedAt), sample });
    throw error;
  }
  if (!isPromiseLike(result)) {
    recordProfile({ name, wallMs: performance.now() - startedAt, cpu: process.cpuUsage(cpuStartedAt), sample });
    return result;
  }
  return Promise.resolve(result).then(
    (value) => {
      recordProfile({ name, wallMs: performance.now() - startedAt, cpu: process.cpuUsage(cpuStartedAt), sample });
      return value;
    },
    (error) => {
      recordProfile({ name, wallMs: performance.now() - startedAt, cpu: process.cpuUsage(cpuStartedAt), sample });
      throw error;
    },
  ) as T;
}

function wrapHookHandler({ pluginName, hookName, handler }: {
  pluginName: string;
  hookName: ProfiledHookName;
  handler: (...args: never[]) => unknown;
}): (...args: never[]) => unknown {
  return function profiledHook(this: unknown, ...args: never[]): unknown {
    return invokeProfiledHook({
      name: `plugin.${pluginName}.${hookName}`,
      sample: hookSample({ hookName, args }),
      run: () => handler.apply(this, args),
    });
  };
}

function profilePlugin(plugin: Plugin): Plugin {
  if (!profilingEnabled) return plugin;
  const profiled = { ...plugin } as Plugin;
  const pluginRecord = plugin as unknown as Record<string, unknown>;
  const profiledRecord = profiled as unknown as Record<string, unknown>;
  for (const hookName of profiledHookNames) {
    const hook = pluginRecord[hookName];
    if (typeof hook === 'function') {
      profiledRecord[hookName] = wrapHookHandler({
        pluginName: plugin.name,
        hookName,
        handler: hook as (...args: never[]) => unknown,
      });
      continue;
    }
    if (
      typeof hook === 'object'
      && hook !== null
      && 'handler' in hook
      && typeof hook.handler === 'function'
    ) {
      profiledRecord[hookName] = {
        ...hook,
        handler: wrapHookHandler({
          pluginName: plugin.name,
          hookName,
          handler: hook.handler as (...args: never[]) => unknown,
        }),
      };
    }
  }
  return profiled;
}

function profilePluginOption(option: PluginOption): PluginOption {
  if (!profilingEnabled) return option;
  if (Array.isArray(option)) return option.map(profilePluginOption);
  if (!option || typeof option !== 'object') return option;
  if ('then' in option && typeof option.then === 'function') {
    return Promise.resolve(option).then(profilePluginOption);
  }
  if ('name' in option && typeof option.name === 'string') {
    return profilePlugin(option as Plugin);
  }
  return option;
}

export function profileVitePluginOptions(options: readonly PluginOption[]): PluginOption[] {
  if (!profilingEnabled) return [...options];
  return options.map(profilePluginOption);
}
