export const strings = {
  title: 'Web apps and native apps: How much of your device can they access?',
  description: 'Compare what a browser page, a desktop app or CLI, and a mobile app can access before you approve a request, and what each can send afterward.',
  intro: [
    'Suppose a writing tool offers both a website and an installed app. Either can do the work, but the choice changes what the service’s code can reach on your device. Here, “web app” means page code running inside a browser; the browser itself has its own operating-system access. “Native app” includes desktop and mobile apps and command-line tools.',
    'Ask two questions: What on the device can the code read or observe? Once it has information, where can it send it?',
  ],
  noPrompt: {
    title: 'If no permission dialog appears, does the app have no access?',
    body: 'No. An Android developer can declare INTERNET in the app manifest, and Android grants this normal permission at installation. The app can then open network sockets without asking you to approve each connection. A developer declaration, an automatic grant, a request for your approval, and a notification are different things.',
    sources: [
      { label: 'Android: INTERNET permission', href: 'https://developer.android.com/reference/android/Manifest.permission#INTERNET' },
      { label: 'Android: how permissions are granted', href: 'https://developer.android.com/guide/topics/permissions/overview' },
    ],
  },
  reach: {
    title: 'What can the code reach on your device?',
    intro: 'The answer depends on where the code runs. These are the usual boundaries for an ordinary app or web page, before you grant it additional access.',
    cards: [
      {
        title: 'Desktop app or CLI',
        scope: 'The signed-in user’s access',
        body: 'Ordinary desktop programs often run with the signed-in user’s permissions. On Windows, one may read files that account can read and enumerate running processes without a separate approval for each. A non-sandboxed macOS app can also access files outside its own container. File protections and app sandboxes can narrow that reach.',
        sources: [
          { label: 'Microsoft: access tokens', href: 'https://learn.microsoft.com/en-us/windows/win32/secauthz/access-tokens' },
          { label: 'Microsoft: process enumeration', href: 'https://learn.microsoft.com/en-us/windows/win32/procthread/process-enumeration' },
          { label: 'Microsoft: desktop app permissions', href: 'https://support.microsoft.com/en-us/windows/apps/app-permissions' },
          { label: 'Apple: files outside an app container', href: 'https://developer.apple.com/documentation/foundation/using-the-file-system-effectively' },
        ],
      },
      {
        title: 'Mobile native app',
        scope: 'Its own app sandbox',
        body: 'Android and iOS isolate an app from another app’s private data. That does not make every device feature ask for approval. For example, Android apps can obtain raw accelerometer and gyroscope readings without a dedicated runtime consent prompt; background use and sampling rate have separate limits.',
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
        body: 'A normal page has no general API to scan your home directory or list the operating system’s processes. For local files, a browser API can give the page access to a file or folder you select. The page receives that scope; it does not inherit the browser’s full operating-system access.',
        sources: [
          { label: 'MDN: File System API', href: 'https://developer.mozilla.org/en-US/docs/Web/API/File_System_API' },
        ],
      },
    ],
    caption: 'An app’s packaging and operating-system protections matter. A sandboxed desktop app can have a narrower boundary than an ordinary desktop process.',
    sandboxSource: { label: 'Apple: macOS App Sandbox', href: 'https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox' },
  },
  send: {
    title: 'Can information it obtains leave the device?',
    first: 'Yes, in both forms. Native apps can make outgoing Internet connections without a new approval for each message. A web page can also send information it has received to its own service or another allowed web destination. Cross-origin rules often limit which responses a page may read; they do not generally prevent it from sending information.',
    second: 'The routes differ. An ordinary native app may use TCP and UDP sockets directly. A normal web page cannot open raw TCP or UDP sockets; it uses browser-provided protocols such as HTTP and WebSocket. Local networks and localhost have their own rules. A site can also restrict its own destinations with a Content Security Policy (CSP), but that policy belongs to the particular site.',
    sources: [
      { label: 'MDN: same-origin policy', href: 'https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy' },
      { label: 'Chrome: raw sockets and ordinary web pages', href: 'https://developer.chrome.com/docs/iwa/direct-sockets' },
      { label: 'Apple: local network rules', href: 'https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy' },
      { label: 'MDN: CSP connection limits', href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src' },
    ],
    localOnlyLink: 'See how Naidan’s Local-only edition restricts connections',
  },
  choose: {
    title: 'Which form should you choose for the same task?',
    body: 'If the web version does what you need, opening it in your browser lets page code work within the browser’s narrower access paths. You still trust the site with what you type, select, or grant it, and the page may send that information. If you need a native app, check its actual sandbox and the abilities it receives automatically. A mobile app and an ordinary desktop program start with different boundaries.',
    note: 'These are capabilities, not evidence that any particular app has collected or uploaded information.',
  },
  related: {
    boundary: { title: 'See Naidan’s browser boundary', description: 'Follow the paths from the page to files, the clipboard, and local services.' },
    localOnly: { title: 'Limit Naidan’s external connections', description: 'See the site-specific connection policy of the Local-only edition.' },
    standalone: { title: 'Start AI in your browser', description: 'Open Naidan Standalone without an installer or app server.' },
  },
};
