import fs from 'node:fs';
import path from 'node:path';

const [profileRoot] = process.argv.slice(2);
if (!profileRoot) throw new Error('Usage: node scripts/summarize-build-profile.mjs <profile-root>');

function readJson({ filePath }) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : undefined;
}

function readTsv({ filePath }) {
  if (!fs.existsSync(filePath)) return [];
  const [headerLine, ...lines] = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  const headers = headerLine.split('\t');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split('\t').map((value, index) => [headers[index], value])));
}

const phases = readTsv({ filePath: path.join(profileRoot, 'top-level-phases.tsv') });
const pluginDirectory = path.join(profileRoot, 'plugin-phases');
const pluginReports = ['standalone', 'hosted']
  .map(mode => readJson({ filePath: path.join(pluginDirectory, `${mode}-plugin-profile.json`) }))
  .filter(Boolean);
const cpuReports = ['vue-tsc', 'standalone', 'hosted']
  .map(mode => ({ mode, report: readJson({ filePath: path.join(profileRoot, `${mode}-cpu-summary.json`) }) }))
  .filter(({ report }) => report !== undefined);

const overview = {
  format: 'naidan-temporary-build-profile-overview-v1',
  phases,
  pluginReports,
  cpuReports,
};
fs.writeFileSync(path.join(profileRoot, 'overview.json'), `${JSON.stringify(overview, null, 2)}\n`);

const lines = [
  '# Naidan temporary build profile',
  '',
  'This report is diagnostic-only. Nested/plugin timings can overlap; do not sum them blindly.',
  '',
  '## Top-level phases',
  '',
  '| phase | wall ms | exit |',
  '|---|---:|---:|',
  ...phases.map(row => `| ${row.phase} | ${row.wall_ms} | ${row.exit_status} |`),
  '',
];
for (const report of pluginReports) {
  lines.push(`## ${report.mode} plugin/subphase timings`, '', '| wall ms | calls | input chars | items | metric |', '|---:|---:|---:|---:|---|');
  for (const metric of report.metrics.slice(0, 80)) {
    lines.push(`| ${metric.wallMs.toFixed(3)} | ${metric.calls} | ${metric.inputChars} | ${metric.items} | ${metric.name} |`);
  }
  lines.push('');
}
for (const { mode, report } of cpuReports) {
  const profile = report.profiles?.[0];
  if (!profile) continue;
  lines.push(`## ${mode} CPU samples by package`, '', '| sampled ms | % | package |', '|---:|---:|---|');
  for (const row of profile.topPackages.slice(0, 30)) {
    lines.push(`| ${row.ms.toFixed(3)} | ${row.percent.toFixed(2)} | ${row.name} |`);
  }
  lines.push('');
}
fs.writeFileSync(path.join(profileRoot, 'overview.md'), `${lines.join('\n')}\n`);
