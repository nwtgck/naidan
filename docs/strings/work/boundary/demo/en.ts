export const boundaryComparisonEn = {
  os: 'The OS on this PC',
  browser: 'Browser',
  naidanRuntime: 'Runs inside the browser',
  directOperation: 'Attempt a direct OS operation',
  blocked: 'Direct access prevented',
  api: 'Browser APIs and permissions',
  allowed: 'Use the permitted access path',
  files: 'Selected files and folders',
  fileAccess: 'Read or write within the granted scope.',
  clipboard: 'Clipboard',
  clipboardAccess: 'Browser permission and interaction rules apply.',
  localServer: 'Local server',
  localhostAccess: 'Connect through an allowed HTTP API.',
  serverNote: 'The localhost server runs separately, with its own OS permissions.',
  note: 'OS permissions still apply. File, clipboard and network access also follow browser rules and site policy.',
};

export type BoundaryComparisonText = typeof boundaryComparisonEn;
