import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { __unstable__loadDesignSystem, compile } from 'tailwindcss';

import { postprocessStaticTailwindCss } from './css-postprocessor';
import { isTailwindMarkerCandidate } from './marker-candidates';
import type { TailwindCandidateOccurrence } from './tw-class-core';
import { profileBuildAsync, profileBuildSync } from '../build-profile.js';

const require = createRequire(import.meta.url);

type TailwindCompileOptions = NonNullable<Parameters<typeof compile>[1]>;
type LoadedModule = Awaited<ReturnType<NonNullable<TailwindCompileOptions['loadModule']>>>;
type LoadedStylesheet = Awaited<ReturnType<NonNullable<TailwindCompileOptions['loadStylesheet']>>>;

export type TailwindCandidateClassification = {
  candidates: string[];
  validCandidates: string[];
  generatedCandidates: string[];
  markerCandidates: string[];
  invalidCandidates: string[];
  generatedCss: (string | null)[];
};

export type TailwindCandidateValidator = {
  tailwindVersion: string;
  cssEntryPath: string;
  classify(options: { candidates: string[] }): TailwindCandidateClassification;
  getClassOrder(options: { candidates: string[] }): Map<string, bigint | null>;
  validate(options: { occurrences: TailwindCandidateOccurrence[] }): {
    candidates: string[];
    invalidCandidates: string[];
    generatedCssCount: number;
    markerCandidateCount: number;
  };
};

function resolveDependency({ id, base, stylesheet }: {
  id: string;
  base: string;
  stylesheet: boolean;
}): string {
  if (path.isAbsolute(id)) return id;
  if (id.startsWith('.')) return path.resolve(base, id);
  const request = stylesheet && id === 'tailwindcss' ? 'tailwindcss/index.css' : id;
  return require.resolve(request, { paths: [base] });
}

async function loadModule({ id, base }: {
  id: string;
  base: string;
}): Promise<LoadedModule> {
  const resolvedPath = resolveDependency({ id, base, stylesheet: false });
  const modifiedAt = fs.statSync(resolvedPath).mtimeMs;
  const namespace: Record<string, unknown> = await profileBuildAsync({
    name: 'tailwind.dependency.load-module',
    sample: { detail: resolvedPath, items: 1 },
    run: () => import(`${pathToFileURL(resolvedPath).href}?mtime=${modifiedAt}`),
  });
  return {
    path: resolvedPath,
    base: path.dirname(resolvedPath),
    module: (namespace.default ?? namespace) as LoadedModule['module'],
  };
}

function loadStylesheet({ id, base, stylesheetDependencies }: {
  id: string;
  base: string;
  stylesheetDependencies: Set<string>;
}): LoadedStylesheet {
  const resolvedPath = resolveDependency({ id, base, stylesheet: true });
  stylesheetDependencies.add(resolvedPath);
  return {
    path: resolvedPath,
    base: path.dirname(resolvedPath),
    content: profileBuildSync({
      name: 'tailwind.dependency.load-stylesheet',
      sample: { detail: resolvedPath, items: 1 },
      run: () => fs.readFileSync(resolvedPath, 'utf8'),
    }),
  };
}

function readTailwindVersion(): string {
  const packageJsonPath = require.resolve('tailwindcss/package.json');
  const packageJson: unknown = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (
    typeof packageJson !== 'object'
    || packageJson === null
    || !('version' in packageJson)
    || typeof packageJson.version !== 'string'
  ) {
    throw new Error('[tw-class] Tailwind package.json has no string version.');
  }
  return packageJson.version;
}

function assertTailwindVersion({ expectedTailwindVersion }: {
  expectedTailwindVersion: string | undefined;
}): string {
  const installedTailwindVersion = readTailwindVersion();
  if (expectedTailwindVersion !== undefined && installedTailwindVersion !== expectedTailwindVersion) {
    throw new Error(
      `[tw-class] Tailwind version mismatch: expected ${expectedTailwindVersion}, installed ${installedTailwindVersion}. `
      + 'The static dependency implementation requires an exact Tailwind version pin.',
    );
  }
  return installedTailwindVersion;
}

function compileOptions({ absoluteCssEntryPath, stylesheetDependencies }: {
  absoluteCssEntryPath: string;
  stylesheetDependencies: Set<string>;
}): TailwindCompileOptions {
  return {
    base: path.dirname(absoluteCssEntryPath),
    from: absoluteCssEntryPath,
    loadModule: async (id, base) => loadModule({ id, base }),
    loadStylesheet: async (id, base) => loadStylesheet({ id, base, stylesheetDependencies }),
  };
}

export async function compileTailwindCss({
  cssEntryPath,
  candidates,
  expectedTailwindVersion,
}: {
  cssEntryPath: string;
  candidates: string[];
  expectedTailwindVersion: string | undefined;
}): Promise<{ css: string; tailwindVersion: string; stylesheetDependencies: string[] }> {
  const installedTailwindVersion = assertTailwindVersion({ expectedTailwindVersion });
  if (typeof compile !== 'function') throw new Error('[tw-class] Tailwind compile() is unavailable.');
  const absoluteCssEntryPath = path.resolve(cssEntryPath);
  const stylesheetDependencies = new Set([absoluteCssEntryPath]);
  const css = fs.readFileSync(absoluteCssEntryPath, 'utf8');
  const compiler = await profileBuildAsync({
    name: 'tailwind.compile.create-compiler',
    sample: { detail: absoluteCssEntryPath, inputChars: css.length, items: 1 },
    run: () => compile(css, compileOptions({ absoluteCssEntryPath, stylesheetDependencies })),
  });
  const builtCss = profileBuildSync({
    name: 'tailwind.compile.compiler-build',
    sample: { detail: absoluteCssEntryPath, items: candidates.length },
    run: () => compiler.build([...new Set(candidates)].sort()),
  });
  return {
    css: profileBuildSync({
      name: 'tailwind.compile.postprocess-css',
      sample: { detail: absoluteCssEntryPath, inputChars: builtCss.length, items: 1 },
      run: () => postprocessStaticTailwindCss({ css: builtCss }),
    }),
    tailwindVersion: installedTailwindVersion,
    stylesheetDependencies: [...stylesheetDependencies].sort(),
  };
}

export async function createTailwindCandidateValidator({
  projectRoot,
  cssEntryPath,
  expectedTailwindVersion,
}: {
  projectRoot: string;
  cssEntryPath: string;
  expectedTailwindVersion: string | undefined;
}): Promise<TailwindCandidateValidator> {
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
  const designSystem = await profileBuildAsync({
    name: 'tailwind.validator.load-design-system',
    sample: { detail: absoluteCssEntryPath, inputChars: css.length, items: 1 },
    run: () => __unstable__loadDesignSystem(
      css,
      compileOptions({
        absoluteCssEntryPath,
        stylesheetDependencies: new Set([absoluteCssEntryPath]),
      }),
    ),
  });

  function classify({ candidates }: {
    candidates: string[];
  }): TailwindCandidateClassification {
    const uniqueCandidates = [...new Set(candidates)].sort();
    const generatedCss = profileBuildSync({
      name: 'tailwind.validator.classify-candidates',
      sample: { detail: absoluteCssEntryPath, items: uniqueCandidates.length },
      run: () => designSystem.candidatesToCss(uniqueCandidates).map((candidateCss) => (
        candidateCss === null ? null : postprocessStaticTailwindCss({ css: candidateCss })
      )),
    });
    const generatedCandidates = uniqueCandidates.filter((_candidate, index) => generatedCss[index] !== null);
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
