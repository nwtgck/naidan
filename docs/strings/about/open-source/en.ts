export const strings = {
  title: 'Naidan is open source software',
  description: 'Use Naidan under the MIT license, inspect its source and release builds, then build a version yourself or download a published app.',
  intro: 'Naidan publishes its code and build records on GitHub under the MIT license. You can examine a version before deciding whether to build it yourself or use a published package.',
  license: {
    title: 'Use, modify, and share for free',
    body: 'You can use, copy, modify, and redistribute Naidan’s code without a license fee, including for commercial use. You may give away copies or sell them. When distributing copies or substantial portions, keep the copyright and permission notices.',
    link: 'Read the full MIT license',
    note: 'Dependencies and models you use may have different terms; Naidan’s MIT license does not grant rights to all of them.',
  },
  source: {
    title: 'Inspect the source and its changes',
    body: 'The public repository lets you read how features work and how data is handled. You can follow changes in the commit history and open the source at a release tag to examine a particular version.',
    link: 'Browse the source code',
    historyLink: 'View commit history',
  },
  build: {
    title: 'Inspect how releases are built',
    body: 'On a version-tag run, GitHub Actions checks out the source, installs dependencies, builds the app, and saves the result as a build artifact. The release job downloads that artifact from the same run, adds the tag to the app ZIP names, and uploads them to GitHub Releases.',
    note: 'The linked workflow shows the current definition; open it at a release tag to inspect the definition for that version alongside its run log. The workflow does not compare the app ZIPs with an independent rebuild or attach a signature linking them to the source.',
    workflowLink: 'Read the current release workflow',
    runsLink: 'View build and release runs',
    diagram: {
      source: 'Public source',
      build: 'GitHub Actions',
      release: 'Published release',
    },
    diagramCaption: 'Source, build run, and published package can each be inspected on GitHub.',
  },
  use: {
    title: 'Build it yourself or use a published version',
    body: 'You can build a revision you have inspected and use your own output, or download a built version to start without building it yourself.',
    selfBuild: {
      title: 'Build from source',
      body: 'The README documents npm ci and npm run build. Run them for a revision you have inspected to use your own build output instead of the published ZIP.',
      link: 'Read the build instructions',
    },
    release: {
      title: 'Use a ready-built release',
      body: 'GitHub Releases offers Hosted files for serving from your own HTTP server and Standalone files you can open directly in your browser after extracting the ZIP.',
      link: 'Browse the latest release',
    },
    relatedTitle: 'Open the Standalone setup guide',
    relatedDescription: 'Download, extract, and open the app from local files in your browser.',
  },
};
