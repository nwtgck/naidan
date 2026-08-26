import fs from "node:fs";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

import type { RolldownOutput } from "rolldown";
import { build } from "vite";

import {
  FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE,
  FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE,
} from "../../src/features/file-protocol-standalone/logic/file-protocol-standalone-protocol.js";
import { createNaidanStandalonePlugin } from "./plugin.js";

const require = createRequire(import.meta.url);

export const REPRESENTATIVE_WORKER_NAMES = ["highlight", "wesh", "search", "explorer", "editor"] as const;

function writeFixtureFile({ root, relativePath, contents }: Readonly<{
  root: string;
  relativePath: string;
  contents: string;
}>): void {
  const filename = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

function createFixtureSource(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "naidan-standalone-representative-artifact-"));
  fs.symlinkSync(path.resolve(import.meta.dirname, "../../node_modules"), path.join(root, "node_modules"), "dir");

  writeFixtureFile({
    root,
    relativePath: "index.html",
    contents: `\
<!doctype html>
<html>
<head><script id="representative-pre-runtime" ${FILE_PROTOCOL_STANDALONE_SCRIPT_PHASE_ATTRIBUTE}="${FILE_PROTOCOL_STANDALONE_PRE_RUNTIME_SCRIPT_PHASE}">globalThis.__representativePreRuntime = true;</script><script type="application/ld+json">{"name":"representative-standalone-artifact"}</script><link rel="stylesheet" media="print" href="./public-print.css"></head>
<body><div id="app"></div><script type="module" src="/src/main.js"></script></body>
</html>
`,
  });
  writeFixtureFile({ root, relativePath: "public/public-print.css", contents: ".representative-public-print { display: block; }\n" });
  writeFixtureFile({
    root,
    relativePath: "src/main.js",
    contents: `\
import "./initial.css";
import "./effect-free.css";
import "./mixed-empty.css";
import { staticMarker } from "./static-feature.js";
import payloadUrl from "./payload.txt?url";
import mixedEmptyCssUrl from "./mixed-empty.css?url";
import { createStandaloneWorker as createHighlightWorker } from "virtual:file-protocol-standalone/worker/representative-highlight";
import { createStandaloneWorker as createWeshWorker } from "virtual:file-protocol-standalone/worker/representative-wesh";
import { createStandaloneWorker as createSearchWorker } from "virtual:file-protocol-standalone/worker/representative-search";
import { createStandaloneWorker as createExplorerWorker } from "virtual:file-protocol-standalone/worker/representative-explorer";
import { createStandaloneWorker as createEditorWorker } from "virtual:file-protocol-standalone/worker/representative-editor";
globalThis.__representativeStaticMarker = staticMarker;
globalThis.__representativePayloadUrl = payloadUrl;
globalThis.__representativeMixedEmptyCssUrl = mixedEmptyCssUrl;
globalThis.__representativeWorkerFactories = [
  createHighlightWorker,
  createWeshWorker,
  createSearchWorker,
  createExplorerWorker,
  createEditorWorker,
];
globalThis.loadRepresentativeLazyFeature = () => import("./lazy-feature.js");
`,
  });
  writeFixtureFile({ root, relativePath: "src/initial.css", contents: ".representative-initial { border-left-width: 7px; }\n" });
  writeFixtureFile({ root, relativePath: "src/effect-free.css", contents: "" });
  writeFixtureFile({ root, relativePath: "src/mixed-empty.css", contents: "" });
  writeFixtureFile({ root, relativePath: "src/payload.txt", contents: "representative-payload-contract\n" });
  writeFixtureFile({
    root,
    relativePath: "src/static-feature.js",
    contents: `\
import "./static.css";
import { sharedUiMarker } from "./ui-worker-shared.js";
export const staticMarker = "representative-static:" + sharedUiMarker;
`,
  });
  writeFixtureFile({ root, relativePath: "src/static.css", contents: ".representative-static { width: 41px; }\n" });
  writeFixtureFile({
    root,
    relativePath: "src/lazy-feature.js",
    contents: `\
import "./lazy.css";
import { sharedUiMarker } from "./ui-worker-shared.js";
import { lazySharedUiWorkerMarker } from "./lazy-ui-worker-shared.js";
export const lazyMarker = "representative-lazy:" + sharedUiMarker + ":" + lazySharedUiWorkerMarker;
export const loadNested = () => import("./nested-lazy.js");
`,
  });
  writeFixtureFile({ root, relativePath: "src/lazy.css", contents: ".representative-lazy { --representative-lazy: applied; }\n" });
  writeFixtureFile({
    root,
    relativePath: "src/lazy-ui-worker-shared.js",
    contents: `\
import "./lazy-ui-worker-shared.css";
export const lazySharedUiWorkerMarker = "representative-lazy-ui-worker-shared";
`,
  });
  writeFixtureFile({ root, relativePath: "src/lazy-ui-worker-shared.css", contents: ".representative-lazy-ui-worker-shared { --representative-lazy-shared: applied; }\n" });
  writeFixtureFile({
    root,
    relativePath: "src/nested-lazy.js",
    contents: `\
import "./nested-lazy.css";
export const nestedMarker = "representative-nested-lazy";
`,
  });
  writeFixtureFile({ root, relativePath: "src/nested-lazy.css", contents: ".representative-nested-lazy { outline-width: 3px; }\n" });
  writeFixtureFile({
    root,
    relativePath: "src/ui-worker-shared.js",
    contents: `\
import "./ui-worker-shared.css";
export const sharedUiMarker = "representative-ui-worker-shared";
`,
  });
  writeFixtureFile({
    root,
    relativePath: "src/ui-worker-shared.css",
    contents: ".representative-ui-worker-shared { --representative-static-shared: applied; }\n",
  });
  writeFixtureFile({
    root,
    relativePath: "src/worker-shared.js",
    contents: `\
export const workerSharedMarker = "representative-worker-shared";
`,
  });
  writeFixtureFile({
    root,
    relativePath: "src/worker-subset-shared.js",
    contents: `\
export const workerSubsetSharedMarker = "representative-worker-subset-shared";
`,
  });
  writeFixtureFile({
    root,
    relativePath: "src/worker-subset-lazy.js",
    contents: `\
export const workerSubsetLazyMarker = "representative-worker-subset-lazy";
`,
  });
  writeFixtureFile({
    root,
    relativePath: "src/worker-lazy.js",
    contents: `\
export const workerLazyMarker = "representative-worker-lazy";
`,
  });

  for (const workerName of REPRESENTATIVE_WORKER_NAMES) {
    let editorLazy: string;
    let subsetShared: string;
    switch (workerName) {
    case "wesh":
    case "explorer":
      editorLazy = "";
      subsetShared = `\
import { workerSubsetSharedMarker } from "./worker-subset-shared.js";
globalThis.__representativeWorkerSubsetStaticMarker = workerSubsetSharedMarker;
globalThis.__representativeWorkerSubsetLazyLoader = () => import("./worker-subset-lazy.js");`;
      break;
    case "editor":
      editorLazy = "\nglobalThis.__representativeWorkerLazyLoader = () => import(\"./worker-lazy.js\");";
      subsetShared = "";
      break;
    case "highlight":
    case "search":
      editorLazy = "";
      subsetShared = "";
      break;
    default: {
      const _ex: never = workerName;
      throw new Error(`Unhandled representative Worker: ${_ex}`);
    }
    }
    writeFixtureFile({
      root,
      relativePath: `src/${workerName}-worker.js`,
      contents: `\
import { sharedUiMarker } from "./ui-worker-shared.js";
import { workerSharedMarker } from "./worker-shared.js";
globalThis.__representativeWorkerMarker = "representative-${workerName}:" + sharedUiMarker + ":" + workerSharedMarker;
globalThis.__representativeLazyUiWorkerLoader = () => import("./lazy-ui-worker-shared.js");${subsetShared}${editorLazy}
`,
    });
  }

  return root;
}

function requireRolldownOutput({ result }: Readonly<{
  result: RolldownOutput | readonly RolldownOutput[];
}>): RolldownOutput {
  if ("output" in result) return result;
  if (result.length !== 1) throw new Error(`Expected one representative build output; found ${result.length}`);
  return result[0];
}

export async function buildRepresentativeStandaloneArtifactFixture(): Promise<Readonly<{
  root: string;
  output: RolldownOutput;
}>> {
  const root = createFixtureSource();
  try {
    const result = await build({
      root,
      base: "./",
      configFile: false,
      logLevel: "silent",
      plugins: [createNaidanStandalonePlugin({
        workers: REPRESENTATIVE_WORKER_NAMES.map(name => ({
          name: `representative-${name}-worker`,
          entry: path.join(root, `src/${name}-worker.js`),
          virtualId: `virtual:file-protocol-standalone/worker/representative-${name}`,
        })),
        systemRuntimePath: require.resolve("systemjs/dist/system.min.js"),
        sourceAudit: { mode: "inline" },
      })],
      build: {
        assetsInlineLimit: 0,
        cssCodeSplit: true,
        minify: false,
        modulePreload: false,
        outDir: path.join(root, "dist"),
        write: false,
        rollupOptions: {
          output: {
            entryFileNames: "assets/[name]-systemjs-[hash].js",
            chunkFileNames: "assets/[name]-systemjs-[hash].js",
          },
        },
      },
    }) as RolldownOutput | readonly RolldownOutput[];
    return { root, output: requireRolldownOutput({ result }) };
  } catch (error: unknown) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function removeRepresentativeStandaloneArtifactFixture({ root }: Readonly<{root: string}>): void {
  fs.rmSync(root, { recursive: true, force: true });
}
