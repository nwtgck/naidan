# Static Tailwind CSS

Naidan does not use Tailwind's broad source-string scanner. The build collects a finite set of Tailwind candidates from explicit syntax, validates them against the pinned Tailwind version, and generates CSS only for those candidates.

The production configuration uses split output. A source module imports the CSS registration modules for the candidates it owns, and Vite 8 / Rolldown places those registrations into the actual initial, shared, or lazy JavaScript chunks. The browser registry reconstructs the loaded Tailwind CSS in canonical order so lazy chunk load order does not change the cascade.

## Developer syntax

### Vue templates

Use ordinary `class` for component classes, DOM hooks, and third-party classes. Use `tw-class` for Tailwind utilities.

```vue
<div
  class="message-toolbar"
  tw-class="flex items-center gap-2"
/>
```

`:tw-class` accepts expressions whose complete Tailwind candidate set is statically enumerable: string literals, arrays, object keys, conditional branches, and `&&` expressions.

```vue
<div
  :tw-class="[
    'flex items-center',
    disabled && 'pointer-events-none opacity-50',
    active ? 'text-blue-600' : 'text-gray-500',
  ]"
/>
```

Runtime-created class names, spreads, computed object keys, and opaque values are rejected. An already branded `TailwindClass` value may be unwrapped with `twClasses()`; that wrapper does not register new candidates. The wrapper is valid only in a class-value position of `:tw-class`, not as a condition or nested inside another wrapper.

```vue
<div :tw-class="['flex', twClasses(appearanceClasses)]" />
```

Use `customClasses()` only to mark an opaque non-Tailwind value that is the complete value of an ordinary `:class` binding. Do not nest it or place it inside an array, conditional, or object value.

```vue
<div :class="customClasses(componentClasses)" tw-class="flex" />
```

Registered class-string props use their `tw-*` form. These props currently accept static strings only.

```vue
<Transition
  tw-enter-active-class="transition duration-200 ease-out"
  tw-enter-from-class="translate-y-2 opacity-0"
  tw-enter-to-class="translate-y-0 opacity-100"
/>

<draggable
  ghost-class="sortable-ghost"
  tw-fallback-class="opacity-0"
/>
```

The registry is defined in `tailwind-class-attributes.ts`. Add parser, compiler, and test coverage when introducing another class-string prop; do not invent an unsupported `tw-*` attribute at a call site.

### TypeScript and JavaScript

Import compile-time macros from `virtual:naidan-tailwind`.

```ts
import { tw, twClassString } from 'virtual:naidan-tailwind';

element.classList.add(
  tw('opacity-50'),
  tw('pointer-events-none'),
);

const htmlClasses = twClassString(
  'rounded-xl',
  'border',
  'shadow-lg',
);
```

`tw()` accepts exactly one string literal containing one utility. `twClassString()` accepts one or more string-literal arguments, each containing one utility. Calls are replaced with ordinary string literals and must not remain in production code.

The following are invalid:

```ts
tw(className);
tw(`bg-${color}-500`);
tw(active ? 'block' : 'hidden');
tw('opacity-50 hidden');
twClassString('flex gap-2');
```

`twClasses()` and `customClasses()` are Vue-template wrappers, not runtime helpers for TypeScript or JavaScript. Conversely, `tw()` and `twClassString()` are not valid inside Vue template expressions; use `tw-class` / `:tw-class` there. Misplaced compile-time macros fail the build instead of leaving a runtime call behind.

## Pipeline

### 1. Source analysis

`source-module-analyzer.ts` scans production source files under `src` using:

- `@vue/compiler-sfc` for Vue single-file components;
- `@vue/compiler-dom` for templates;
- the TypeScript Compiler API for JavaScript, JSX, TypeScript, and TSX.

It records every candidate occurrence and assigns source-module ownership. Tests and temporary lint fixtures are excluded. Compile-time macro imports and Vue `tw-*` attributes in files outside this production analysis boundary fail the build instead of being transformed without corresponding CSS. Ordinary strings and ordinary `class` attributes are intentionally ignored. External `<template src>` blocks and non-HTML template preprocessors are rejected because the HTML compiler cannot prove their candidate set. An external `<script src>` block is also rejected when the plugin would need to inject a registration import into that block. The analyzer does not resolve imports or predict chunks; production placement belongs exclusively to Vite / Rolldown.

### 2. Validation and compilation

`tailwind-candidate-validator.ts` loads the Tailwind design system and rejects unknown candidates with source locations. Tailwind and its PostCSS integration are pinned because this implementation uses compiler APIs whose output is version-sensitive. Since split fragments bypass Vite's CSS-asset pipeline, compiler output and per-candidate ownership hints are explicitly passed through Autoprefixer with the same options exported to `postcss.config.ts`; otherwise runtime CSS would silently lose vendor declarations that ordinary CSS assets receive. The split planner also rejects relative `url()` references because Vite cannot rebase or emit those assets after the CSS has become a JavaScript runtime string. Use data URLs, fragment URLs, root-relative URLs, or absolute URLs instead.

The planner compiles the complete candidate set once. It also compiles the empty candidate set to identify base, theme, license, property, and other support CSS that must be available initially.

### 3. CSS atom ownership

`css-ownership-planner.ts` parses the compiled CSS with PostCSS and preserves its canonical atom sequence.

Candidate-specific selectors and keyframes are mapped back to the source modules that declared those candidates. CSS that cannot be attributed safely is assigned to `initial`; it is never silently discarded.

When the number of lazy ownership groups exceeds `maxSplitCssGroups`, the smallest excess groups are promoted to `initial`. Promotion trades initial size for bounded module count without dropping CSS.

Before compiling, the planner verifies that candidate occurrences and the `candidateOwners` map describe exactly the same non-empty ownership set. Before returning a plan, it reconstructs the canonical CSS from all ordered fragments. Missing, duplicated, or reordered atoms cause a build error.

### 4. Virtual registration modules

`tw-class-vite-plugin.ts` injects side-effect imports into the owning source modules. Each canonical ownership set has one virtual JavaScript registration module. Every non-initial registration also imports the initial registration, so a secondary HTML entry or isolated lazy graph cannot load utility rules without the theme, properties, and other support CSS they depend on. Vite / Rolldown, rather than a second import-graph implementation, decides whether those modules belong to initial, shared, or lazy chunks.

The Tailwind stylesheet entry itself is empty in split mode. Tailwind CSS is carried by the registration modules, including for standalone builds where CSS is embedded in JavaScript. During the post-order `generateBundle` check, the plugin verifies that every registration required by an emitted owner survives exactly once and is in the owner's static load graph or the initial graph of every HTML entry that can load that owner. A registration that is merely present in an unrelated lazy chunk or another HTML entry fails the build.

A completely unreachable owner and its registration can be removed by production tree-shaking. Ownership is module-reachability based rather than export-use based, however: if a retained barrel module re-exports a component, the side-effect registration import can conservatively keep that component's Tailwind fragment even when the re-export is not consumed. This may over-include CSS but must never omit required CSS.

### 5. Runtime ordering

`tailwind-css-runtime-source.ts` maintains one `<style data-naidan-tailwind-runtime>` element. Registration modules provide `[canonicalOrder, css]` fragments. The registry batches synchronous registrations, sorts all loaded fragments by canonical order, and rewrites the style element only when its text changes. During an HMR ownership transition, the most recently registered fragment wins for a temporarily duplicated canonical order until the retired module is removed.

The style element is prepended to `<head>` so component and scoped styles retain their expected ability to override global Tailwind utilities. Loading lazy features in different orders must produce the same final CSS sequence.

### 6. HMR

In dev mode, relevant client-environment source changes rebuild the candidate plan. Non-client environments and files outside the production static-analysis boundary are ignored before planning. The stylesheet entry and the local CSS dependencies discovered while Tailwind compiles it remain planning inputs even though they are not source modules scanned for candidates; unrelated CSS files are ignored. Refresh requests are generation-coalesced and serialized so a slower older analysis cannot overwrite a newer plan: a synchronous burst uses the latest filesystem state in one refresh, and changes received during an active refresh cause at most one trailing refresh. Content-equivalent input events are ignored against the last plan whose browser reloads completed successfully only when no refresh is pending; an event received during an active refresh always requests a trailing generation so a temporary edit followed by a revert cannot leave stale CSS. Planning state may be prepared before reloads run, but it is not treated as applied until all reloads and retired-module notifications succeed, allowing the same file content to retry a failed HMR application. After a planning failure, the next local CSS event is also allowed to retry because a newly created imported stylesheet may not yet be present in the last successful dependency set. Changed registration modules and owner modules are reloaded. CSS modules whose ownership sets disappear are explicitly retired from the browser registry.

HMR is an additional path, not the production proof. Production also applies Rolldown tree-shaking and final chunk placement.

## Output modes

- `single`: all validated candidates are emitted through the stylesheet entry. This is a diagnostic and fallback baseline.
- `split`: source modules import runtime CSS registrations and Rolldown performs the real code-split placement. This is Naidan's production mode.

Both modes use the same static candidate syntax and validation. The difference is CSS placement, not candidate discovery.

Split mode reconstructs CSS inside a runtime `<style>` element, so it does not provide a browser-consumable CSS asset source map and cannot use Vite's relative asset URL rewriting. Relative `url()` references fail the build. Use the debug fragments and source analysis output when diagnosing ownership or ordering.

## Dev and production parity

Dev and production use the same analysis and planner, but their module execution differs:

- dev serves unbundled modules and updates virtual modules through HMR;
- production tree-shakes modules and assigns registrations to final Rolldown chunks;
- standalone then converts the output for `file://` loading.

Therefore a dev-only visual check is insufficient for changes to this subsystem. Targeted tests must cover both serve-mode injection and production bundle retention. A final static-Tailwind change must also run `npm run build:standalone` and exercise initial and affected lazy paths from the generated output.

Important invariants are:

1. every candidate is valid and has at least one source owner;
2. unattributed support CSS falls back to `initial`;
3. the complete fragment set reconstructs the canonical global CSS exactly;
4. each required virtual registration module survives production tree-shaking exactly once;
5. every non-initial registration statically depends on the initial support registration;
6. each registration is loaded with every emitted owner, either through its static chunk graph or the initial graph;
7. split runtime CSS contains no unresolved relative asset URL;
8. one runtime style element is used;
9. loading the same lazy features in different orders produces identical CSS;
10. HMR retirement cannot leave stale fragments behind.

## Debug output

Production planning writes diagnostics to the mode-specific directory configured by Vite:

- standalone: `dist/debug-tailwind-standalone`;
- hosted: `dist/debug-tailwind-hosted`.

Each directory contains:

- `source-analysis.json`: candidate occurrences and source ownership;
- `ownership-plan.json`: groups, fragment orders, compression, and byte metrics;
- `css-groups/base.css`: CSS generated without candidates;
- `css-groups/single-global.css`: the canonical full Tailwind result;
- `css-groups/all-utilities.css`: candidate-driven delta;
- `css-groups/group-<sha256>.css`: one final ownership group;
- `css-groups/groups.json`: hash-to-owner mapping.

Hashed filenames avoid filesystem name-length limits. Each debug directory is disposable build output and is not a build input. Because it is recursively cleared before production planning, `debugOutputDirectory` is accepted only as a dedicated child below a top-level project `dist*` directory, such as `dist/debug-tailwind-standalone`; project roots, source directories, the `dist*` directory itself, and paths outside the project are rejected, and existing path components may not be symbolic links. Separate directories keep the later hosted build from replacing the standalone diagnostics.

## Tests

The focused suite is:

```bash
npm run test:only-failed -- \
  build/static-tailwind/css-postprocessor.test.ts \
  build/static-tailwind/tw-class-core.test.ts \
  build/static-tailwind/source-module-analyzer.test.ts \
  build/static-tailwind/css-ownership-planner.test.ts \
  build/static-tailwind/tailwind-css-runtime-source.test.ts \
  build/static-tailwind/tw-class-vite-plugin.test.ts \
  build/static-tailwind/tw-class-vite-plugin.build.test.ts
```

Also run:

```bash
npm run typecheck
npm run build:standalone
```

Do not replace the production build check with `npm run dev`. Hosted build coverage is additionally required when hosted-only output handling changes.

## Extending the system

When a valid class source cannot be represented:

1. add an explicit static API or registered attribute;
2. parse it with the appropriate real parser, not a source-structure regular expression;
3. produce source-located diagnostics for opaque or invalid input;
4. add analyzer, transform, HMR, and production-build tests;
5. preserve the planner and runtime invariants above.

Do not work around the system with raw Tailwind classes, type assertions, comments containing utility names, feature-specific CSS imports, or manual `@source` entries.
