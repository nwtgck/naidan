import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function usage() {
  console.error('usage: node scripts/summarize-cpu-profile.mjs PROFILE_DIR OUTPUT_JSON OUTPUT_TXT');
  process.exit(2);
}

if (process.argv.length !== 5) usage();
const [, , inputDirectory, outputJson, outputText] = process.argv;

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
}

function normalizeUrl(url) {
  if (!url) return '';
  if (url.startsWith('file://')) {
    try {
      return fileURLToPath(url);
    } catch {
      return url;
    }
  }
  return url;
}

function packageNameFromUrl(rawUrl, functionName) {
  if (functionName === '(garbage collector)') return '<garbage-collector>';
  const url = normalizeUrl(rawUrl).replaceAll('\\', '/');
  if (url.startsWith('node:') || url.includes('/node:internal/') || url.includes('/internal/')) return '<node-internal>';
  const marker = '/node_modules/';
  const markerIndex = url.lastIndexOf(marker);
  if (markerIndex !== -1) {
    const after = url.slice(markerIndex + marker.length);
    const parts = after.split('/');
    if (parts[0]?.startsWith('@') && parts[1]) return `${parts[0]}/${parts[1]}`;
    if (parts[0]) return parts[0];
  }
  if (url.includes('/.vite-temp/')) return '.vite-temp';
  if (url === '') return '<anonymous>';
  return '<project-or-other>';
}

function add(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}

const profileFiles = walk(inputDirectory).filter((file) => file.endsWith('.cpuprofile')).sort();
const packageMs = new Map();
const functionMs = new Map();
let sampledMs = 0;
let sampleCount = 0;
let startTime = Number.POSITIVE_INFINITY;
let endTime = 0;

for (const file of profileFiles) {
  const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodeById = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const count = Math.min(samples.length, deltas.length);
  for (let index = 0; index < count; index += 1) {
    const node = nodeById.get(samples[index]);
    if (!node) continue;
    const deltaMs = Number(deltas[index] ?? 0) / 1_000;
    if (!Number.isFinite(deltaMs) || deltaMs < 0) continue;
    const frame = node.callFrame ?? {};
    const functionName = frame.functionName || '(anonymous)';
    const url = frame.url || '';
    const location = `${normalizeUrl(url)}:${Number(frame.lineNumber ?? -1) + 1}:${Number(frame.columnNumber ?? -1) + 1}`;
    const key = `${functionName}\t${location}`;
    add(functionMs, key, deltaMs);
    add(packageMs, packageNameFromUrl(url, functionName), deltaMs);
    sampledMs += deltaMs;
    sampleCount += 1;
  }
  if (Number.isFinite(profile.startTime)) startTime = Math.min(startTime, profile.startTime);
  if (Number.isFinite(profile.endTime)) endTime = Math.max(endTime, profile.endTime);
}

function sortedRows(map, limit = 200) {
  return [...map.entries()]
    .map(([name, ms]) => ({ name, ms, percent: sampledMs === 0 ? 0 : ms / sampledMs * 100 }))
    .sort((left, right) => right.ms - left.ms || left.name.localeCompare(right.name))
    .slice(0, limit);
}

const report = {
  inputDirectory,
  profileFiles,
  profileCount: profileFiles.length,
  sampleCount,
  sampledMs,
  profileSpanMs: Number.isFinite(startTime) && endTime >= startTime ? (endTime - startTime) / 1_000 : null,
  packages: sortedRows(packageMs),
  functions: sortedRows(functionMs),
};

fs.mkdirSync(path.dirname(outputJson), { recursive: true });
fs.writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`);

const lines = [
  `profiles\t${report.profileCount}`,
  `samples\t${report.sampleCount}`,
  `sampledMs\t${report.sampledMs.toFixed(3)}`,
  `profileSpanMs\t${report.profileSpanMs === null ? '' : report.profileSpanMs.toFixed(3)}`,
  '',
  'sampledMs\tpercent\tpackage',
  ...report.packages.slice(0, 80).map((row) => `${row.ms.toFixed(3)}\t${row.percent.toFixed(2)}\t${row.name}`),
  '',
  'sampledMs\tpercent\tfunction',
  ...report.functions.slice(0, 120).map((row) => `${row.ms.toFixed(3)}\t${row.percent.toFixed(2)}\t${row.name}`),
];
fs.writeFileSync(outputText, `${lines.join('\n')}\n`);
