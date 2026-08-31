import fs from 'node:fs';
import path from 'node:path';

const [inputDirectory, jsonOutputPath, textOutputPath] = process.argv.slice(2);
if (!inputDirectory || !jsonOutputPath || !textOutputPath) {
  throw new Error('Usage: node scripts/summarize-cpu-profile.mjs <cpu-profile-dir> <summary.json> <summary.txt>');
}

function packageNameFromUrl({ url }) {
  const normalized = url.replaceAll('\\', '/');
  const marker = '/node_modules/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) {
    if (normalized.startsWith('node:') || normalized.includes('/internal/')) return '<node-internal>';
    return normalized === '' ? '<anonymous>' : '<project-or-runtime>';
  }
  const rest = normalized.slice(index + marker.length);
  const parts = rest.split('/');
  if (rest.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] || '<node_modules>';
}

function add({ map, key, value }) {
  map.set(key, (map.get(key) ?? 0) + value);
}

const files = fs.existsSync(inputDirectory)
  ? fs.readdirSync(inputDirectory).filter(file => file.endsWith('.cpuprofile')).sort()
  : [];
const profiles = [];
for (const file of files) {
  const filePath = path.join(inputDirectory, file);
  const profile = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const nodeById = new Map(profile.nodes.map(node => [node.id, node]));
  const byFunction = new Map();
  const byUrl = new Map();
  const byPackage = new Map();
  let sampledMicros = 0;
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const node = nodeById.get(samples[index]);
    if (!node) continue;
    const micros = deltas[index] ?? 0;
    sampledMicros += micros;
    const frame = node.callFrame ?? {};
    const functionName = frame.functionName || '(anonymous)';
    const url = frame.url || '';
    add({ map: byFunction, key: `${functionName}\t${url}\t${(frame.lineNumber ?? -1) + 1}`, value: micros });
    add({ map: byUrl, key: url || '<anonymous>', value: micros });
    add({ map: byPackage, key: packageNameFromUrl({ url }), value: micros });
  }
  const top = ({ map }) => [...map]
    .map(([name, micros]) => ({ name, ms: micros / 1_000, percent: sampledMicros === 0 ? 0 : micros * 100 / sampledMicros }))
    .sort((left, right) => right.ms - left.ms)
    .slice(0, 100);
  profiles.push({
    file,
    sampledMs: sampledMicros / 1_000,
    topFunctions: top({ map: byFunction }),
    topUrls: top({ map: byUrl }),
    topPackages: top({ map: byPackage }),
  });
}

const summary = {
  format: 'naidan-temporary-cpu-profile-summary-v1',
  inputDirectory,
  profiles,
};
fs.mkdirSync(path.dirname(jsonOutputPath), { recursive: true });
fs.writeFileSync(jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`);
const lines = [];
for (const profile of profiles) {
  lines.push(`# ${profile.file}`, `sampledMs\t${profile.sampledMs.toFixed(3)}`, '', '## packages', 'ms\tpercent\tname');
  for (const row of profile.topPackages.slice(0, 40)) lines.push(`${row.ms.toFixed(3)}\t${row.percent.toFixed(2)}\t${row.name}`);
  lines.push('', '## functions', 'ms\tpercent\tname');
  for (const row of profile.topFunctions.slice(0, 80)) lines.push(`${row.ms.toFixed(3)}\t${row.percent.toFixed(2)}\t${row.name}`);
  lines.push('');
}
if (profiles.length === 0) lines.push('No .cpuprofile files were found.', '');
fs.mkdirSync(path.dirname(textOutputPath), { recursive: true });
fs.writeFileSync(textOutputPath, lines.join('\n'));
