# Streaming downloads

The download sink accepts any `ReadableStream<Uint8Array>`. When the existing
PWA Service Worker supports the streaming protocol, it creates the download
response without assembling a Blob, writing to origin-private storage or
uploading the output. When that route is unavailable **before the download
starts**, the sink uses the former Blob/object-URL save. This includes ordinary
Vite development mode; it does not enable or register a development worker.
Neither route adds a dependency. ZIP generation and file byte sources remain
separate from the sink. The compatibility route retains the whole output and
therefore has the former large-file memory limitations.

## Public API and ownership

```ts
import { downloadStream, downloadReadableStream, downloadBlob } from '@/utils/stream-download';

await downloadStream({
  filename: 'archive.zip',
  size: undefined, // Only provide an exact byte length, never an estimate.
  signal: abortController.signal,
  openStream: async () => zipProducer.openStream(),
});

await downloadReadableStream({
  filename: 'archive.zip',
  size: undefined,
  signal: undefined,
  stream: existingZipStream,
});

// A native File/Blob need not be converted to ArrayBuffer first.
downloadBlob({ blob: existingFile, filename: existingFile.name });
```

`downloadStream` calls its factory at most once: on the browser's first response
body request after a valid readiness acknowledgement, or when starting the
Blob fallback with untouched input. A failed handshake does not cancel or open
the source. The factory must return an unlocked byte stream and must not create
unbounded producer queues.

`downloadReadableStream` takes ownership immediately. If the worker is missing
or incompatible, the same untouched stream goes to the fallback. On terminal
failure or cancellation, the supplied, unlocked stream is cancelled. Neither
API retries by reopening a source after its factory was invoked. Claiming the
response is also a no-retry boundary, even before the first byte: the browser
might already have opened a save dialog. Track both boundaries because data
and control messages can arrive in a different order across their two ports.
A retry after either boundary requires a new explicit user operation.

Cancellation closes the local readable side and releases its reader immediately;
producer cleanup is best-effort and is not awaited by the failed save. A producer's
`cancel()` hook may reject or remain pending. It must not replace the original
output error or keep the UI waiting indefinitely. The fallback retains ownership
of a newly returned source even when cancellation wins the asynchronous setup race;
a source returned after cancellation is also cancelled. This does not guarantee
that an uncooperative producer has finished releasing its own external resources.

The Promise resolves when the Service Worker observes the response stream's
end, or after dispatching the fallback Blob link. Neither is a notification
that the operating system has durably flushed the destination file.
Browser download permissions, final save-dialog cancellation, and filesystem
write failures cannot all be observed by the application. An unknown final ZIP
length is supported; there is no guessed Content-Length.

## Data and control planes

```
producer (page or File Explorer Worker)
  -> bounded pull-based MessagePort byte stream, when crossing a Worker boundary
  -> page download sink
  -> bounded pull-based MessagePort byte stream
  -> existing Service Worker
  -> Response(stream, Content-Disposition: attachment)
  -> browser download manager
```

Both byte boundaries use `byte-stream-port.ts` and the audited
`createValidatedMessagePort` in `worker-transport.ts`. Zod validates incoming and
outgoing messages. There is one outstanding pull per receiver, at most 256 KiB
per reply, and no receiver prefetch queue (`highWaterMark: 0`). Each reply owns a
fresh, exact-sized ArrayBuffer; transferring a producer's possibly shared,
reused, or oversized backing buffer is intentionally avoided.

The design does **not** depend on transferring ReadableStream objects, user-agent
sniffing, or a claimed browser version. MessagePorts and ArrayBuffers are the
transferred objects. Moving data is not necessarily zero-copy: the bounded copy
at each hop is deliberate. On the streaming route, memory use depends on bounded transport queues,
**the largest producer chunk**, and producer/browser internals, not an
application-held copy of the entire output file.

File Explorer and backup ZIP payload output use a 512 KiB high-water mark;
Evidence ZIP payload output uses 256 KiB. Its central-directory
metadata still grows with entry count; export metadata and the producer's own
working set are not made constant-size by this sink. A producer handing over a
multi-gigabyte chunk has already allocated that memory; the sink cannot undo it.

Control messages use a separate port so cancellation and liveness checks are
not blocked behind a slow data read. Ports are owned by the receiving realm
after transfer; the sender closes only endpoints it still owns.

## Reservation and lifecycle

1. Inspect browser capabilities and look up the existing matching registration
   with `getRegistration()`. Do not await `.ready`: it can stay pending when
   no worker exists. Missing/unactivated registrations select the fallback
   immediately. A failing/stalled lookup has a 5-second safety timeout. Never
   register a worker, force activation, call skipWaiting, update or reload.
2. Send a version-2 preparation message, a cryptographic random token, metadata,
   and two ports to `registration.active`. A new download navigation is served
   by the active registration, which need not be the old page controller.
3. The worker validates the source page, version, metadata, token and ports,
   stores a bounded reservation, and acknowledges readiness. This v2 exchange
   is the protocol feature check; old v1-only workers select Blob saving instead
   of a token-bearing path. Timeout (5 seconds), malformed replies,
   unsupported versions or failed port transfer select the fallback after
   cancelling/cleaning up the attempt. The input factory has not been called.
4. Navigate a hidden iframe to the scoped, same-origin URL only after
   acknowledgement. Do not navigate away from the producing page. Keep the
   frame for the entire response plus a 60-second cleanup grace period.
5. Claim the reservation once. The worker immediately removes the URL from the
   pending map, then pulls the response body on demand.
6. Propagate completion, failure or cancellation, close ports, remove listeners,
   clear timers, release readers, and remove the active reservation. If the
   browser never claims the URL, expiry can still select the fallback provided
   the factory was never invoked and no claim notification was received. The
   failed frame and local ports are cleaned up before that switch.

Check capability on each save, not a permanent module-level flag: registration
can appear/disappear or change while the page stays open. Recheck the selected
active worker at acknowledgement to avoid knowingly navigating after it was
replaced. Caller cancellation/pagehide is terminal throughout detection,
negotiation and buffered saving; it must never cause a fallback download. A late
factory result is cancelled after cancellation rather than being saved.

A reservation expires after 30 seconds without a browser request. No more than
8 pending/active downloads are allowed per Service Worker. While a download is
active, the page sends a real `ServiceWorker.postMessage` heartbeat every 15
seconds; 120 seconds without a reply is treated as a lost worker. A MessagePort
ping alone does not create an ExtendableMessageEvent. The worker accepts leases
only from the owning WindowClient and answers over the independent control port.

Preparation uses `waitUntil` only until claim/cancel/expiry. Each claimed-fetch
or heartbeat event holds a lease of at most 90 seconds. Renewal attaches the
successor lease before resolving the previous event, retaining one timer per
session rather than one per heartbeat. End/error/cancellation resolves the live
lease. No event waits indefinitely for completion of a multi-hour producer. The
worker also checks every 15 seconds that the owner page still exists.

These are peer checks, not an elapsed-time limit on generation. `waitUntil` and
response streaming are not guarantees against browser/operating-system
termination or background freezing. Keep the producing page open. There is no
restart/resume protocol or Range support for a one-shot generated stream.

An AbortSignal, pagehide, worker replacement, source error, rejected protocol
message or download-body cancellation ends the operation. File Explorer also
observes its source Worker's error/messageerror events so a dead producer does
not leave a read or archive metadata promise pending. Some browser/OS download
cancellations are not reliably exposed to script; actual target browsers must
be tested for those paths.

## URL, headers and security

New pages use a fixed path relative to the existing worker scope, with the
one-shot token in a fragment: `__naidan_download__/v2/#?id=<random-token>`.
There is no request query. Filename, byte length and content are never encoded
into the URL. Both peers construct the canonical URL with `createDownloadUrl`;
the worker matches the complete `Request.url` (including the fragment) exactly,
so stripped fragments, query IDs, duplicate IDs and modified URLs are not aliases.
Nested-path hosting is supported. A fragment is not part of an HTTP request target.

The preparation source must be a same-origin WindowClient inside that scope.
v2 treats the cryptographically random token as a one-shot bearer capability,
not as proof that a requesting iframe is the same client as its parent.
Only a GET navigation can use that capability; non-navigation fetches cannot read
it, even when their clientId equals the owner. The generated iframe sets
`referrerPolicy = 'no-referrer'` BEFORE assigning its src. Response headers also
set `Referrer-Policy: no-referrer`. Authorization does not require a Referer.
This protects against guessing or ambient cross-origin access, not against
compromised same-origin scripts, extensions or someone who already has the token.

Before any navigation, the page checks the existing registration for BOTH the
page and the exact fixed download destination. An overlapping registration is
not used. Where the navigation-preload API exists, an enabled, unreadable or
invalid preload state selects Blob saving instead. None of these checks uses
fetch, register, update, enable or disable. The download-specific feature check
is the versioned prepare/ready exchange over private MessagePorts.

The worker still accepts v1 preparation and `__naidan_download__/v1/<token>`
requests from old open pages. Their previous referrer/clientId check is retained.
New pages demand a v2 acknowledgement and NEVER downgrade to a token-bearing
path; with a v1-only worker they use Blob saving instead. Updating the worker
cannot rewrite an already-running old page: reload that page to stop it from
using the old path layout.

HEAD, POST, Range, reused/expired tokens and modified URLs cannot consume a
reservation. All reserved-prefix requests terminate locally, including invalid
ones, in both cache-first and network-only update modes. They cannot fall through
to Workbox/precache/network **when this fetch handler handles them**.

This is not a promise that every browser sends zero requests in every lifecycle
race. A navigation that no worker intercepts can still request the fixed path,
and a browser's speculative fetching is not universally controlled by the
navigation-preload state. The fragment token is absent from that HTTP request
target, and the initiating page's Referer is omitted. No producer bytes are
uploaded by this implementation. The host can still observe the fixed request
and ambient credentials if such a request occurs. A response script/redirect
could also observe/inherit a fragment if the handler is bypassed; fragments are
not encryption or a security boundary against same-origin scripts. Browser
integration/network observations must not be inferred from Node mocks.

Responses use attachment disposition, application/octet-stream, no-store,
nosniff and a restrictive content security policy (`sandbox allow-downloads`,
not bare `sandbox`, which forbids downloads). The attachment response carries
`Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy:
same-origin` so its hidden-frame navigation is compatible with an isolated
parent. These headers do not grant script or same-origin sandbox privileges.
Filenames have path/control/
bidirectional-control characters removed and use separately encoded ASCII and
UTF-8 disposition parameters. Caller-controlled response headers and active
document content types are intentionally not accepted. Provided exact lengths
are checked for underrun and overrun before reporting successful consumption.

## Build and update integration

`pwa/sw.ts` imports and installs the download handler before its existing
Workbox router. The provided base already uses `injectManifest`: keep that
configuration and its full automatic precache manifest. There is no extra
registration, generated side script, build plugin or dependency.

The handler owns the whole `__naidan_download__/` root, including other protocol
versions and invalid/expired tokens, and stops later fetch handlers. This rule
precedes both cache-first routing and the explicit network-only update mode. A
local generated download must not turn into a server request when that mode is
enabled. Update activation, consent, startup gating and cache ownership are
otherwise unchanged.

A protocol version and readiness timeout prevent new pages from assuming an
old worker implements download streaming. New pages require v2 and use
the former save path with v1-only/missing/incompatible workers. The new worker
continues to serve v1 for old open pages. Existing PWA
update policy stays authoritative; saving does not force an update/reload or
require the page and worker to have identical application build identifiers.

## Compatibility boundaries

- Hosted HTTPS/localhost: prefer the existing worker only when lookup and the
  versioned readiness handshake succeed. Before source opening/response claim,
  unavailable/rejected/blocked streaming selects the buffered Blob save.
- `file://`, no Service Worker API, insecure pages, unavailable registration:
  use the buffered compatibility path without waiting for a worker to appear.
  This preserves saving but may exhaust memory on large output. It is not a
  bounded-memory path.
- Generator errors, size mismatches, a failed read after source opening, a
  claimed download, caller cancellation and pagehide do not trigger a second
  save. In particular, an explicit cancel must not become a Blob download.
- Existing native File/Blob: `downloadBlob` uses an object URL directly, without
  first reading it as ArrayBuffer. The URL is released later, not immediately
  after a successful click. Synchronous setup/click failures release it immediately
  without leaving a cleanup timer.
- Plain Vite development mode still does not enable/register a Service Worker.
  Saves fall back when none exists. No dev/production build flag or user-agent
  sniffing is used to decide capability. Use a hosted build to verify the
  browser's actual streaming download behavior.
- Native file-picker writes are not added here; existing specialized filesystem
  writers are unchanged. This feature is the ordinary browser-download sink.

## Integration points

File Explorer single-file downloads now use `openFileStream`, backed by
`File.stream()` or the existing virtual-filesystem reader, instead of `readFile`
materialization. Preview keeps its existing Blob API. Bounded virtual text/media
previews now stop reading at the configured limit plus one byte before returning
the oversized response; unsupported binary previews do not read the payload.
Explicit full-preview operations may still allocate the complete displayed file.

Directory archive jobs return `{stream, result, cancel}`. Consume `stream`
**before** awaiting `result`: waiting for metadata first deadlocks a bounded
ZIP producer. Cancelling the output cancels the currently open input file too.
Generation-id checks prevent a previous dialog's failure from cancelling a
newer job.

Import/export passes the already streaming export output to the common sink.
The modal aborts its active download when closed or unmounted. Producer-specific
snapshot/metadata memory is outside this transport's bound. JSON text entries
are encoded in bounded chunks instead of allocating a second full encoded copy.

Chat Markdown/plain-text export writes each message, argument and result to a
bounded text stream. Binary tool results use incremental UTF-8 decoding.

Model Support Investigation partial/batch/retained-timing exports and the Worker
Download Verification export operation return prepared immutable Blob entries,
then stream the ZIP over the same byte bridge. Manifest/hash/association checks
run before serialization; the final ZIP is not reopened and verified before
saving (that would require buffering or temporary storage). Independent decoder
tests cover serialization. Worker disposal waits for consumption, not just the
filename response. Legacy Blob-returning archive APIs remain for inspection,
round-trip verification and other non-download callers; download UI does not
use them.

The new-base audio history and image galleries retain their existing media
Blobs/object URLs for playback/display and download without rebuffering. Image
diagnostic text is a separately bounded ring: its small Blob save deliberately
remains available even when diagnosing a missing Service Worker. Diagnostics and
image-metadata saves use the shared deferred object-URL release helper.

Native attachments, generated images already held as Blobs, and server-hosted
portable-app ZIP links are not transformed into full in-memory byte arrays.
Image metadata rewriting still uses an image-sized representation; it is a
producer transformation rather than an arbitrary byte-download sink. Object
URLs used for previews and full-buffer URL sharing/import/model inference are
not download exports and remain outside this change.

The existing ZIP writer is not ZIP64: its 32-bit sizes/offsets and 16-bit entry
count constraints still apply. A bounded download sink does not remove these
format limits. A direct file/byte-stream download has no corresponding ZIP
format restriction.

## Verification

Automated coverage includes lazy source opening, paused consumers, bounded
chunks, buffer ownership, cross-realm buffers, malformed messages, cancellation
of blocked reads, source errors, worker loss, first-visit registration selection,
dev/hosted/standalone fallback, missing APIs/registrations, old-worker protocol
rejection/timeouts, cancellation without fallback, late replies, no source
replay, ZIP generation through the byte bridge into a decoded fallback archive,
single-use scoped fragment routes, v1 coexistence, no-referrer navigation,
preload rejection/timeouts/cancellation, overlapping scopes, content-length mismatches,
failed claim acknowledgement, bounded lease renewals without data production,
ZIP round trips, and the actual Workbox-injected worker bundle. The latter
consumes a 64 MiB payload through two bounded MessagePort hops, checks byte
content and paused-producer behavior in both update modes, and verifies that
reserved invalid requests never reach the network. These are Node integration
tests, not proof of browser download-manager behavior.

Before release, also run a hosted build in each supported browser: first visit,
subpath hosting, offline after installation, a large generated ZIP, a virtual
file, non-ASCII filenames, zero-byte/unknown-size output, cancellation, a paused
source, update/reload, and standalone regression. Browser download UI and durable
file writes cannot be validated by mocked FetchEvent/MessagePort tests alone.
