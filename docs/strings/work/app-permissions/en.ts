export const strings = {
  title: 'Web apps and native apps: How much of your device can they access?',
  description: 'Compare what a browser page, a desktop app or CLI, and a mobile app can access on your device, and what each can send afterward.',
  intro: [
    'Suppose a writing tool offers both a website and an installed app. Either can do the work, but the choice changes what the service’s code can reach on your device. Here, “web app” means page code running inside a browser; the browser itself has its own operating-system access. “Native app” includes desktop and mobile apps and command-line tools.',
    'First compare which files or device features the code can access. Then consider whether it can send information it obtains. A web page can send information you give it, too.',
  ],
  noPrompt: {
    title: 'Does no permission dialog mean no access?',
    body: 'No. On Android, a developer declares INTERNET in the app manifest, and the system automatically grants this normal permission at installation. The app does not ask you to approve each outgoing connection. Microphone recording is different: the developer declares RECORD_AUDIO and the app must request a runtime permission. If you have not already granted it, Android shows an approval prompt. A developer declaration, an automatic grant, and your approval play different roles.',
    sources: [
      { label: 'Android: INTERNET and RECORD_AUDIO permissions', href: 'https://developer.android.com/reference/android/Manifest.permission' },
      { label: 'Android: how permissions are granted', href: 'https://developer.android.com/guide/topics/permissions/overview' },
    ],
  },
  reach: {
    title: 'What device information and features can the code access?',
    intro: 'The answer depends on where the code runs. Follow three examples of an ordinary app or web page before you grant it additional access.',
    cards: [
      {
        title: 'Desktop app or CLI',
        scope: 'The signed-in user’s access',
        body: 'An ordinary Windows desktop program often runs with the signed-in user’s permissions. It may read a file that account can read without separate approval for that file. A temporary-file location does not by itself isolate files per app; whether each file is readable still depends on its protection. A list of running process names can also give clues about which apps are in use on the device. File protections and app sandboxes can narrow access.',
        sources: [
          { label: 'Microsoft: access tokens', href: 'https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens' },
          { label: 'Microsoft: process enumeration', href: 'https://learn.microsoft.com/en-us/windows/win32/procthread/process-enumeration' },
          { label: 'Microsoft: executable names in process lists', href: 'https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w' },
          { label: 'Microsoft: temporary-file paths', href: 'https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-gettemppath2a' },
          { label: 'Microsoft: file access rights', href: 'https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights' },
          { label: 'Microsoft: desktop app permissions', href: 'https://support.microsoft.com/en-us/windows/apps/app-permissions' },
        ],
      },
      {
        title: 'Mobile native app',
        scope: 'Its own app sandbox',
        body: 'Android and iOS isolate an app from another app’s private data. That does not make every device feature ask for approval. For example, Android apps can obtain raw accelerometer readings without a dedicated runtime consent prompt; background use and sampling rate have separate limits.',
        sources: [
          { label: 'Android: app sandbox', href: 'https://source.android.com/docs/security/app-sandbox' },
          { label: 'Apple: iOS app sandbox', href: 'https://support.apple.com/guide/security/sec15bfe098e/web' },
          { label: 'Android: sensor limits', href: 'https://developer.android.com/develop/sensors-and-location/sensors/sensors_overview' },
          { label: 'Android: high-rate sensor permission', href: 'https://developer.android.com/reference/android/Manifest.permission#HIGH_SAMPLING_RATE_SENSORS' },
        ],
      },
      {
        title: 'Web app page',
        scope: 'Access through browser APIs',
        body: 'A normal page has no general API to scan your home directory or list the operating system’s processes. For a local file, the browser can give the page a file you select. The page receives that scope; it does not inherit the browser’s full operating-system access. Selection and ongoing permission details depend on the browser API.',
        sources: [
          { label: 'HTML Standard: file selection', href: 'https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file)' },
          { label: 'MDN: File System API', href: 'https://developer.mozilla.org/en-US/docs/Web/API/File_System_API' },
        ],
      },
    ],
    caption: 'An app’s packaging and operating-system protections matter. A sandboxed desktop app can have a narrower boundary than an ordinary desktop process.',
    sandboxSource: { label: 'Apple: macOS App Sandbox', href: 'https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox' },
  },
  send: {
    title: 'Can information it obtains leave the device?',
    first: 'Yes. Native apps can make outgoing Internet connections without a new approval for each message. A web page can also send information it has received through browser networking APIs. Accessing a file or sensor and sending what it yields are separate questions. The paths below show possibilities, not actual behavior by a particular app.',
    second: 'The routes differ. A normal web page cannot open raw TCP or UDP sockets; it uses browser-provided protocols such as HTTP and WebSocket. Cross-origin rules often limit which responses a page may read; they do not generally prohibit sending information. Local networks and localhost have their own rules. A site can restrict its own destinations with Content Security Policy (CSP), but that policy belongs to the particular site.',
    sources: [
      { label: 'MDN: Fetch API', href: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API' },
      { label: 'MDN: same-origin policy', href: 'https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy' },
      { label: 'Chrome: raw sockets and ordinary web pages', href: 'https://developer.chrome.com/docs/iwa/direct-sockets' },
      { label: 'Apple: local network rules', href: 'https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy' },
      { label: 'MDN: CSP connection limits', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src' },
    ],
    localOnlyLink: 'See how Naidan’s Local-only edition restricts connections',
  },
  choose: {
    title: 'Which form should you choose for the same task?',
    body: 'If the web version meets your needs, the browser enforces a boundary around what the page can do to your device. A normal page cannot directly read arbitrary files or enumerate operating-system processes just because the signed-in user or browser can; it receives files through browser-provided paths, such as a file you select. As long as that boundary works as designed, the browser blocks those direct operations without relying solely on the site’s restraint or on you noticing every access. Some work requires a native app, whose actual sandbox and default access still matter. When both can do the job within the browser’s boundary, you can give the service less device access from the start.',
    note: 'These are capabilities, not evidence that any particular app has collected or uploaded information.',
    sources: [
      { label: 'Chromium: browser sandbox and site isolation', href: 'https://www.chromium.org/Home/chromium-security/site-isolation/' },
    ],
  },
  visual: {
    desktop: { eyebrow: 'Ordinary Windows desktop program', account: 'Signed-in user', program: 'Desktop app or CLI', file: 'File this user can read', fileName: 'draft.txt', sample: 'Draft text', outcome: 'File content reaches the program', limit: 'File protections and sandbox rules still apply', caption: 'A program running as the signed-in user reads draft.txt, a file that user can access.' },
    mobile: { eyebrow: 'Android app example', app: 'This app', privateData: 'Another app’s private data', blocked: 'Stopped by the app sandbox', blockedToken: 'Private data', sensor: 'Raw accelerometer readings', sensorValue: 'x: 0.2', available: 'No dedicated runtime approval prompt', caption: 'The sandbox stops another app’s private data. This app can receive an accelerometer reading without a dedicated approval prompt.' },
    web: { eyebrow: 'Normal web page example', file: 'File the user selects', fileName: 'draft.txt', browser: 'Browser file selection', page: 'Web page', received: 'Receives draft.txt', outside: 'Other files and the OS process list are not directly handed to the page', caption: 'The browser gives the page the selected draft.txt file. Other files are outside this selection.' },
    send: { desktop: 'Readable example file', desktopApp: 'Desktop program', mobile: 'Accelerometer reading', mobileApp: 'Android app', web: 'Selected file', webApp: 'Web page via browser HTTP', service: 'Example service', caption: 'Each example carries the information obtained above toward a service. The paths show what could be sent.' },
    noPrompt: { eyebrow: 'Two Android permission paths', internet: 'Internet connection', microphone: 'Microphone recording', declaration: 'Developer declares permission', automatic: 'OS grants automatically', request: 'If needed, Android asks the user', connected: 'Connection can be made', approved: 'Recording after approval', noDialog: 'No runtime approval dialog', dialog: 'Runtime approval prompt', caption: 'Both abilities are declared by the developer; microphone recording needs user approval at runtime.' },
  },
  related: {
    boundary: { title: 'See Naidan’s browser boundary', description: 'Follow the paths from the page to files, the clipboard, and local services.' },
    localOnly: { title: 'Limit Naidan’s external connections', description: 'See the site-specific connection policy of the Local-only edition.' },
    standalone: { title: 'Start AI in your browser', description: 'Open Naidan Standalone without an installer or app server.' },
  },
};
