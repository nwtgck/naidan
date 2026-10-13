export const strings = {
  title: 'Use local AI with restricted external connections',
  description: 'Open Naidan’s Local-only hosted version, connect a local AI server, and use browser developer tools to check its connection policy and traffic.',
  intro: 'If you want to work with a local AI server while limiting where the Naidan page can connect, open the Local-only hosted version. Its Content Security Policy (CSP) is delivered with the page and enforced by your browser.',
  versionsTitle: 'Choose the hosted version before you start',
  versions: {
    standard: {
      title: 'Standard hosted version',
      url: 'https://naidan.pages.dev',
      body: 'Choose this for the usual hosted experience, including features that need external services such as downloading models. It does not use the Local-only connection policy.',
      link: 'Open the standard version',
    },
    curated: {
      title: 'Curated hosted version',
      url: 'https://naidan-curated.pages.dev',
      body: 'Choose this when you need local servers plus the selected external services in its CSP allowlist, currently Wikipedia, Wikimedia, and Hugging Face. That list may change.',
      link: 'Open the Curated version',
    },
    localOnly: {
      title: 'Local-only hosted version',
      url: 'https://naidan-local-only.pages.dev',
      body: 'Open this address to use the browser-enforced connection limits below. Selecting a local endpoint inside the standard version does not switch its CSP.',
      link: 'Open the Local-only version',
    },
  },
  switching: 'These versions use different site origins, so browser-stored conversations do not appear automatically when you switch between them. If you need existing conversations, export and import a ZIP:',
  backupLink: 'Back up and restore conversations',
  localTitle: 'Connect a server running on your device',
  localIntro: 'Start an AI server such as Ollama or llama.cpp server on your device, then choose its matching API provider and local URL in Naidan. The Local-only page permits connections to:',
  allowed: [
    { address: "'self'", meaning: 'Requests to the Local-only page’s own origin: the exact site you opened, rather than the Standard or Curated sites.' },
    { address: 'http://localhost:*', meaning: 'An HTTP service on this device, at the port you specify.' },
    { address: 'http://127.0.0.1:*', meaning: 'The same device reached through its loopback IP address.' },
  ],
  localConditions: 'The server must be running at the URL you enter, expose the matching API, and allow this page’s origin through CORS. A URL on another machine or a LAN address is outside this CSP allowlist. Check the connection in Naidan before choosing a model.',
  localGuideLink: 'Set up a local AI server connection',
  scopeTitle: 'What does this limit?',
  scope: 'The page’s CSP connect-src rule limits browser requests such as API calls made with fetch or XMLHttpRequest to those destinations. Other CSP rules govern resources such as scripts and images. A direct model download from an external service such as Hugging Face is outside the Local-only connection allowlist, so features needing it may fail.',
  outsideScope: 'The Local-only site itself still loads over the internet. A local AI server is a separate process with its own permissions and possible network activity; the page’s CSP does not control that process. Changing Naidan’s endpoint setting cannot widen the browser’s CSP allowlist.',
  checkTitle: 'Check the policy and the traffic in your browser',
  checkSteps: [
    {
      title: 'Read the policy received by the page',
      body: 'Open the Local-only URL. In browser developer tools, open ［Network］ and reload the page. Select the main document request, then look under ［Headers］ → Response Headers for Content-Security-Policy. Its connect-src should list the three allowed sources above.',
    },
    {
      title: 'Inspect a connection you actually use',
      body: 'With ［Network］ still recording, select ［Check Connection］ for your local server in Naidan. Inspect the request URL and result. This shows the destination attempted during that action; a successful response also depends on the server and browser origin rules.',
    },
    {
      title: 'Read a blocked request’s reason',
      body: 'If a connection fails, look in ［Console］ for a CSP violation or CORS error. A CSP message identifies a destination the page policy blocked. A failed local request may instead mean that the server is unavailable, its API URL is wrong, or its CORS settings do not allow the page.',
    },
  ],
  checkNote: 'The Network log covers requests made while it records and while you perform those actions. It helps you inspect page traffic; it does not audit a separate local server process.',
  relatedLocalTitle: 'Connect Naidan to Ollama or a llama.cpp server',
  relatedLocalDescription: 'Find the correct local API URL, check the model list, and resolve browser connection errors.',
};
