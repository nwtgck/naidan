import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { __unstable__loadDesignSystem, compile } from 'tailwindcss';
import { isTailwindMarkerCandidate } from './marker-candidates.mjs';
import { postprocessStaticTailwindCss } from './css-postprocessor.mjs';

const require = createRequire(import.meta.url);

function resolveDependency({ id, base, stylesheet }) {
  if (path.isAbsolute(id)) return id;
  if (id.startsWith('.')) return path.resolve(base, id);
  const request = stylesheet && id === 'tailwindcss' ? 'tailwindcss/index.css' : id;
  return require.resolve(request, { paths: [base] });
}

async function loadModule({ id, base }) {
  const resolvedPath = resolveDependency({ id, base, stylesheet: false });
  const modifiedAt = fs.statSync(resolvedPath).mtimeMs;
  const namespace = await import(`${pathToFileURL(resolvedPath).href}?mtime=${modifiedAt}`);
  return {
    path: resolvedPath,
    base: path.dirname(resolvedPath),
    module: namespace.default ?? namespace,
  };
}

function loadStylesheet({ id, base }) {
  const resolvedPath = resolveDependency({ id, base, stylesheet: true });
  return {
    path: resolvedPath,
    base: path.dirname(resolvedPath),
    content: fs.readFileSync(resolvedPath, 'utf8'),
  };
}

function readTailwindVersion() {
  const packageJsonPath = require.resolve('tailwindcss/package.json');
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
}

function assertTailwindVersion({ expectedTailwindVersion }) {
  const installedTailwindVersion = readTailwindVersion();
  if (expectedTailwindVersion !== undefined && installedTailwindVersion !== expectedTailwindVersion) {
    throw new Error(
      `[tw-class] Tailwind version mismatch: expected ${expectedTailwindVersion}, installed ${installedTailwindVersion}. `
      + 'The static dependency implementation requires an exact Tailwind version pin.',
    );
  }
  return installedTailwindVersion;
}

function compileOptions({ absoluteCssEntryPath }) {
  return {
    base: path.dirname(absoluteCssEntryPath),
    from: absoluteCssEntryPath,
    loadModule: async (id, base) => loadModule({ id, base }),
    loadStylesheet: async (id, base) => loadStylesheet({ id, base }),
  };
}

export async function compileTailwindCss({
  cssEntryPath,
  candidates,
  expectedTailwindVersion,
}) {
  const installedTailwindVersion = assertTailwindVersion({ expectedTailwindVersion });
  if (typeof compile !== 'function') throw new Error('[tw-class] Tailwind compile() is unavailable.');
  const absoluteCssEntryPath = path.resolve(cssEntryPath);
  const css = fs.readFileSync(absoluteCssEntryPath, 'utf8');
  const compiler = await compile(css, compileOptions({ absoluteCssEntryPath }));
  return {
    css: postprocessStaticTailwindCss({
      css: compiler.build([...new Set(candidates)].sort()),
    }),
    tailwindVersion: installedTailwindVersion,
  };
}

export async function createTailwindCandidateValidator({
  projectRoot,
  cssEntryPath,
  expectedTailwindVersion,
}) {
  const absoluteProjectRoot = path.resolve(projectRoot);
  if (!fs.existsSync(absoluteProjectRoot)) {
    throw new Error(`[tw-class] Project root does not exist: ${absoluteProjectRoot}`);
  }

  const installedTailwindVersion = assertTailwindVersion({ expectedTailwindVersion });
  if (typeof __unstable__loadDesignSystem !== 'function') {
    throw new Error('[tw-class] Tailwind __unstable__loadDesignSystem() is unavailable.');
  }

  const absoluteCssEntryPath = path.resolve(cssEntryPath);
  const css = fs.readFileSync(absoluteCssEntryPath, 'utf8');
  const designSystem = await __unstable__loadDesignSystem(
    css,
    compileOptions({ absoluteCssEntryPath }),
  );

  function classify({ candidates }) {
    const uniqueCandidates = [...new Set(candidates)].sort();
    const generatedCss = designSystem.candidatesToCss(uniqueCandidates).map((css) => (
      css === null ? null : postprocessStaticTailwindCss({ css })
    ));
    const generatedCandidates = uniqueCandidates.filter((candidate, index) => generatedCss[index] !== null);
    const markerCandidates = uniqueCandidates.filter((candidate, index) => (
      generatedCss[index] === null && isTailwindMarkerCandidate({ candidate })
    ));
    const validCandidates = [...generatedCandidates, ...markerCandidates].sort();
    const invalidCandidates = uniqueCandidates.filter((candidate, index) => (
      generatedCss[index] === null && !isTailwindMarkerCandidate({ candidate })
    ));
    return {
      candidates: uniqueCandidates,
      validCandidates,
      generatedCandidates,
      markerCandidates,
      invalidCandidates,
      generatedCss,
    };
  }

  return {
    tailwindVersion: installedTailwindVersion,
    cssEntryPath: absoluteCssEntryPath,
    classify,
    getClassOrder({ candidates }) {
      return new Map(designSystem.getClassOrder([...new Set(candidates)].sort()));
    },
    validate({ occurrences }) {
      const classification = classify({ candidates: occurrences.map(({ candidate }) => candidate) });
      if (classification.invalidCandidates.length > 0) {
        const invalidSet = new Set(classification.invalidCandidates);
        const details = occurrences
          .filter(({ candidate }) => invalidSet.has(candidate))
          .map(({ candidate, filename, line, column, sourceKind }) => (
            `Unknown Tailwind candidate "${candidate}" at ${filename}:${line}:${column} (${sourceKind}).`
          ));
        throw new Error(`[tw-class] ${details.join('\n[tw-class] ')}`);
      }
      return {
        candidates: classification.candidates,
        invalidCandidates: classification.invalidCandidates,
        generatedCssCount: classification.generatedCandidates.length,
        markerCandidateCount: classification.markerCandidates.length,
      };
    },
  };
}
