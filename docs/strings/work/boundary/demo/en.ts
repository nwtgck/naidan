export const boundaryComparisonEn = {
  os: 'The OS on this PC',
  browser: 'Browser',
  naidanRuntime: 'Runs inside the browser',
  directOperation: 'Attempt a direct OS operation',
  blocked: 'Direct access prevented',
  api: 'Browser-mediated APIs',
  allowed: 'Scope and conditions depend on the API',
  files: 'Selected files and folders',
  fileAccess: 'Selected scope; writing has separate permission.',
  clipboard: 'Clipboard',
  clipboardAccess: 'Reading and writing have different browser rules.',
  localServer: 'Local server',
  localhostAccess: 'HTTP to the endpoint you specify.',
  serverNote: 'The localhost server runs separately, with its own OS permissions.',
  note: 'OS permissions still apply. File, clipboard and network access also follow browser rules and site policy.',
};

export type BoundaryComparisonText = typeof boundaryComparisonEn;
