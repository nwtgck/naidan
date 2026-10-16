// Docs may persist only theme and motion through the two local exceptions in
// docs/client/preferences.ts. These selectors cover ordinary direct browser API
// use; they do not claim to prove the behavior of arbitrary dynamic JavaScript.
const host = '^(?:window|globalThis|self)$';
const storageGlobal = '^(?:localStorage|sessionStorage|indexedDB|caches|cookieStore)$';
const fileSystemMethod = '^(?:getDirectory|getDirectoryHandle|getFileHandle|createWritable|createSyncAccessHandle|removeEntry|showSaveFilePicker)$';

const staticTemplate = ({ field, pattern }) => `[${field}.type=TemplateLiteral][${field}.expressions.length=0][${field}.quasis.0.value.cooked=/${pattern}/]`;

const staticProperties = ({ field, pattern }) => [
  `[${field}.name=/${pattern}/]`,
  `[${field}.value=/${pattern}/]`,
  staticTemplate({ field, pattern }),
];

const selectors = [
  `Identifier[name=/${storageGlobal}/]`,
  `MemberExpression[computed=true][property.value=/${storageGlobal}/]`,
  `MemberExpression[computed=true]${staticTemplate({ field: 'property', pattern: storageGlobal })}`,
  `VariableDeclarator[init.name=/${host}/] > ObjectPattern > Property[key.value=/${storageGlobal}/]`,
  `VariableDeclarator[init.name=/${host}/] > ObjectPattern > Property${staticTemplate({ field: 'key', pattern: storageGlobal })}`,
  `AssignmentExpression[right.name=/${host}/] > ObjectPattern > Property[key.value=/${storageGlobal}/]`,
  `AssignmentExpression[right.name=/${host}/] > ObjectPattern > Property${staticTemplate({ field: 'key', pattern: storageGlobal })}`,
  `Identifier[name=/${fileSystemMethod}/]`,
  `MemberExpression[computed=true][property.value=/${fileSystemMethod}/]`,
  `MemberExpression[computed=true]${staticTemplate({ field: 'property', pattern: fileSystemMethod })}`,
];

for (const { root, properties } of [
  { root: 'navigator', properties: '^(?:storage|serviceWorker)$' },
  { root: 'document', properties: '^cookie$' },
]) {
  // Computed access on window/globalThis/self is forbidden below, so only
  // dotted host access needs the nested-root forms here.
  const memberObjects = [`[object.name=${root}]`, `[object.object.name=/${host}/][object.property.name=${root}]`];
  const boundObjects = [`[init.name=${root}]`, `[init.object.name=/${host}/][init.property.name=${root}]`];
  const assignedObjects = [`[right.name=${root}]`, `[right.object.name=/${host}/][right.property.name=${root}]`];
  for (const object of memberObjects) {
    for (const property of staticProperties({ field: 'property', pattern: properties })) selectors.push(`MemberExpression${object}${property}`);
  }
  for (const object of boundObjects) {
    for (const property of staticProperties({ field: 'key', pattern: properties })) selectors.push(`VariableDeclarator${object} > ObjectPattern > Property${property}`);
  }
  for (const object of assignedObjects) {
    for (const property of staticProperties({ field: 'key', pattern: properties })) selectors.push(`AssignmentExpression${object} > ObjectPattern > Property${property}`);
  }
}

const restrictions = [
  { selector: `MemberExpression[computed=true][object.name=/${host}/]`, message: 'Use dotted access on window, globalThis and self in Docs; computed global access is prohibited.' },
  ...selectors.map(selector => ({ selector, message: 'Docs browser persistence belongs only in docs/client/preferences.ts.' })),
];

export default {
  name: 'naidan/docs-no-browser-persistence',
  files: ['docs/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}'],
  ignores: ['docs/tests/**', 'docs/**/*.test.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}', 'docs/**/*.spec.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}', 'docs/**/*.test-support.{js,jsx,mjs,cjs,ts,tsx,mts,cts,vue}'],
  rules: {
    'no-restricted-syntax': ['error', ...restrictions],
    'vue/no-restricted-syntax': ['error', ...restrictions],
  },
};
