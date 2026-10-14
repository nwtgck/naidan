export const strings = {
  title: 'Check this browser',
  scope: 'This result is for the browser displaying this page. To check another browser, open this URL in that browser.',
  initial: 'Not checked yet. If JavaScript is enabled, this page checks after loading.',
  checking: 'Checking this browser’s text language model…',
  available: 'This browser reports that its text language model is available.',
  downloadable: 'This browser reports that a text model can be downloaded. This page has not started a download.',
  downloading: 'This browser reports that a text model is downloading. This page does not track its progress.',
  unavailable: 'This browser reports that its text language model is unavailable.',
  apiAbsent: 'The LanguageModel API needed by Naidan is not exposed here. This alone does not identify a device limitation.',
  unknown: 'The browser returned an unrecognized status, so availability could not be confirmed.',
  rejected: 'The browser could not complete the check. Try again.',
  recheck: 'Check again',
  limits: 'This check does not prepare a model or guarantee chat with every language or setting.',
};

export type BrowserAiAvailabilityCopy = typeof strings;
