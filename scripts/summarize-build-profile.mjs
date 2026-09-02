import fs from 'node:fs';
import path from 'node:path';

if (process.argv.length !== 3) {
  console.error('usage: node scripts/summarize-build-profile.mjs PROFILE_ROOT');
  process.exit(2);
}
const root = process.argv[2];

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function readJson(file) {
  if (!fs.existsSync(file)) return undefined;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function parseTsv(file) {
  const text = readText(file).trim();
  if (!text) return [];
  const [header, ...rows] = text.split(/\r?\n/u);
  const names = header.split('\t');
  return rows.filter(Boolean).map((line) => Object.fromEntries(line.split('\t').map((value, index) => [names[index], value])));
}

function parseTimeV(file) {
  const text = readText(file);
  const result = {};
  const elapsedKey = 'Elapsed (wall clock) time (h:mm:ss or m:ss)';
  const elapsedPrefix = `${elapsedKey}:`;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith(elapsedPrefix)) {
      result[elapsedKey] = trimmed.slice(elapsedPrefix.length).trim();
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    result[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return result;
}

function parseElapsedSeconds(value) {
  if (!value) return undefined;
  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number(value);
}

function loadPhase(phase) {
  const time = parseTimeV(path.join(root, `${phase}-time.txt`));
  return {
    phase,
    wallMs: parseElapsedSeconds(time['Elapsed (wall clock) time (h:mm:ss or m:ss)']) * 1_000,
    userSeconds: Number(time['User time (seconds)'] ?? NaN),
    systemSeconds: Number(time['System time (seconds)'] ?? NaN),
    cpuPercent: Number(String(time['Percent of CPU this job got'] ?? '').replace('%', '')),
    maxRssKiB: Number(time['Maximum resident set size (kbytes)'] ?? NaN),
    majorPageFaults: Number(time['Major (requiring I/O) page faults'] ?? NaN),
    minorPageFaults: Number(time['Minor (reclaiming a frame) page faults'] ?? NaN),
    fileInputs: Number(time['File system inputs'] ?? NaN),
    fileOutputs: Number(time['File system outputs'] ?? NaN),
    exitStatus: Number(time['Exit status'] ?? NaN),
  };
}

const topLevel = parseTsv(path.join(root, 'top-level-phases.tsv'));
const controlAPhases = ['control-a-vue-tsc', 'control-a-standalone', 'control-a-hosted'].map(loadPhase);
const timingPhases = ['timing-vue-tsc', 'timing-standalone', 'timing-hosted'].map(loadPhase);
const controlBPhases = ['control-b-vue-tsc', 'control-b-standalone', 'control-b-hosted'].map(loadPhase);
const cpuPhases = ['cpu-vue-tsc', 'cpu-standalone', 'cpu-hosted'].map(loadPhase);
const pluginDirectory = path.join(root, 'plugin-phases');
const pluginReports = fs.existsSync(pluginDirectory)
  ? fs.readdirSync(pluginDirectory)
    .filter((file) => file.endsWith('-build-profile.json'))
    .sort()
    .map((file) => readJson(path.join(pluginDirectory, file)))
    .filter(Boolean)
  : [];

function reportForMode(mode) {
  return pluginReports.find((report) => report.mode === mode);
}

function topMetrics(mode, limit = 50) {
  const report = reportForMode(mode);
  return (report?.metrics ?? []).slice(0, limit);
}

const cpuSummaries = Object.fromEntries(['vue-tsc', 'standalone', 'hosted'].map((phase) => [
  phase,
  readJson(path.join(root, `${phase}-cpu-summary.json`)),
]));

const artifactRows = parseTsv(path.join(root, 'artifact-sizes.tsv'));
const distTotalText = readText(path.join(root, 'dist-total-bytes.txt')).trim();
const distTotalBytes = Number(distTotalText.split(/\s+/u)[0] ?? NaN);

const overview = {
  generatedAt: new Date().toISOString(),
  topLevel,
  controlAPhases,
  timingPhases,
  controlBPhases,
  cpuPhases,
  pluginReports,
  cpuSummaries,
  artifact: {
    distTotalBytes: Number.isFinite(distTotalBytes) ? distTotalBytes : null,
    largestFiles: artifactRows.slice(0, 100),
  },
};
fs.writeFileSync(path.join(root, 'overview.json'), `${JSON.stringify(overview, null, 2)}\n`);

function fmtMs(value) {
  return Number.isFinite(value) ? value.toFixed(1) : 'n/a';
}
function fmtMiB(kib) {
  return Number.isFinite(kib) ? (kib / 1024).toFixed(1) : 'n/a';
}
function mdEscape(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const md = [];
md.push('# Naidan temporary exhaustive build profile', '');
md.push('Diagnostic-only. Nested/plugin timings overlap; do not sum them blindly. Control A/B are the primary wall/RSS references; the detailed timing pass is for attribution. CPU-profile runs are separate and intentionally slower.', '');
md.push('## Top-level wall/RSS controls and instrumented timing', '');
md.push('Control A runs before detailed instrumentation and Control B after it. Both have plugin/subphase collection disabled. Their spread helps expose filesystem/cache drift. The instrumented pass is for attribution, not canonical total wall time.', '');
md.push('| phase | wall ms | CPU | max RSS MiB | major faults | file outputs |');
md.push('|---|---:|---:|---:|---:|---:|');
for (const phase of [...controlAPhases, ...timingPhases, ...controlBPhases]) {
  md.push(`| ${phase.phase} | ${fmtMs(phase.wallMs)} | ${Number.isFinite(phase.cpuPercent) ? `${phase.cpuPercent}%` : 'n/a'} | ${fmtMiB(phase.maxRssKiB)} | ${Number.isFinite(phase.majorPageFaults) ? phase.majorPageFaults : 'n/a'} | ${Number.isFinite(phase.fileOutputs) ? phase.fileOutputs : 'n/a'} |`);
}
md.push('');

md.push('### Instrumentation overhead estimate', '');
md.push('| phase | control A ms | instrumented ms | control B ms | instrumented - control midpoint ms |');
md.push('|---|---:|---:|---:|---:|');
for (let index = 0; index < timingPhases.length; index += 1) {
  const left = controlAPhases[index]?.wallMs;
  const instrumented = timingPhases[index]?.wallMs;
  const right = controlBPhases[index]?.wallMs;
  const midpoint = Number.isFinite(left) && Number.isFinite(right) ? (left + right) / 2 : NaN;
  const delta = Number.isFinite(instrumented) && Number.isFinite(midpoint) ? instrumented - midpoint : NaN;
  md.push(`| ${['vue-tsc', 'standalone', 'hosted'][index]} | ${fmtMs(left)} | ${fmtMs(instrumented)} | ${fmtMs(right)} | ${fmtMs(delta)} |`);
}
md.push('');

for (const mode of ['timing-standalone', 'timing-hosted']) {
  const report = reportForMode(mode);
  md.push(`## ${mode} plugin/subphase timings`, '');
  if (!report) {
    md.push('_No report found._', '');
    continue;
  }
  md.push('| wall ms | max call ms | calls | CPU user ms | input chars | items | metric |');
  md.push('|---:|---:|---:|---:|---:|---:|---|');
  for (const metric of topMetrics(mode, 70)) {
    md.push(`| ${metric.wallMs.toFixed(3)} | ${metric.maxWallMs.toFixed(3)} | ${metric.calls} | ${metric.cpuUserMs.toFixed(3)} | ${metric.inputChars} | ${metric.items} | ${mdEscape(metric.name)} |`);
  }
  md.push('');
  const slowMetrics = (report.metrics ?? []).filter((metric) => (metric.slowest ?? []).some((entry) => entry.detail));
  md.push(`### ${mode} slowest labeled calls`, '');
  md.push('| wall ms | metric | detail |');
  md.push('|---:|---|---|');
  const calls = slowMetrics.flatMap((metric) => (metric.slowest ?? []).filter((entry) => entry.detail).map((entry) => ({ metric: metric.name, ...entry })))
    .sort((left, right) => right.wallMs - left.wallMs)
    .slice(0, 100);
  for (const call of calls) md.push(`| ${call.wallMs.toFixed(3)} | ${mdEscape(call.metric)} | ${mdEscape(call.detail)} |`);
  md.push('');
}

md.push('## CPU-profile hotspots', '');
for (const phase of ['vue-tsc', 'standalone', 'hosted']) {
  const summary = cpuSummaries[phase];
  md.push(`### ${phase}`, '');
  if (!summary) {
    md.push('_No CPU summary found._', '');
    continue;
  }
  md.push('| sampled ms | % | package |');
  md.push('|---:|---:|---|');
  for (const row of (summary.packages ?? []).slice(0, 35)) {
    md.push(`| ${row.ms.toFixed(3)} | ${row.percent.toFixed(2)} | ${mdEscape(row.name)} |`);
  }
  md.push('', '| sampled ms | % | function |', '|---:|---:|---|');
  for (const row of (summary.functions ?? []).slice(0, 35)) {
    md.push(`| ${row.ms.toFixed(3)} | ${row.percent.toFixed(2)} | ${mdEscape(row.name)} |`);
  }
  md.push('');
}

md.push('## Artifact sizes', '');
md.push(`dist total bytes: ${Number.isFinite(distTotalBytes) ? distTotalBytes : 'n/a'}`, '');
if (artifactRows.length > 0) {
  md.push('| bytes | path |', '|---:|---|');
  for (const row of artifactRows.slice(0, 60)) md.push(`| ${row.bytes ?? row.size ?? ''} | ${mdEscape(row.path ?? '')} |`);
  md.push('');
}

fs.writeFileSync(path.join(root, 'overview.md'), `${md.join('\n')}\n`);
