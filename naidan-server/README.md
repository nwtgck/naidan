# Naidan Server

Naidan Server is a single executable that serves the generated `dist/hosted`
assets on `localhost:5536`. `--port` / `-p` and `--version` keep their existing
behavior. The server does not need an asset directory or a writable temporary
directory at runtime.

## Build

Generate `dist/hosted` with the normal frontend build pipeline first, then run
with Go 1.24 or newer:

```sh
cd naidan-server
go run build.go
```

The build utility creates `packed/assets.pack` and embeds it in `naidan-server`.
It reads the hosted assets without changing them. The generated pack and binary
are ignored by Git. `go run build.go --skip-build` prepares only the
pack; GoReleaser uses this before cross-compiling the release binaries.

Both build paths use `-trimpath` and `-ldflags "-s -w ..."`. These omit build
paths, the symbol table, and Go debug information. Browser source maps remain in
the hosted assets. No C compiler or external compression program is required.

GitHub Actions reads the `toolchain` directive in `go.mod` to select the Go
version for the server build and GoReleaser. For an offline build, prepare the
toolchain and run `go mod download` beforehand with network access. In GitHub
Actions, `go mod download` fills a job-local module cache that both build
containers mount read-only while running with networking disabled.

## Embedded assets

The generated pack contains a compressed manifest and independently addressable
blocks of at most 1 MiB (1,048,576 bytes). Ordinary asset blocks use Zstandard's
best compression setting when it reduces their size. Existing `.gz` files and
compressed ZIP member data are stored directly, without a second compression
layer. Files refer to spans within those blocks, allowing identical data to be
shared.

Source maps remain available at their original paths. Standalone ZIP files are
served with exactly their original bytes, including compressed entry data,
headers, and archive metadata. Downloading a ZIP therefore preserves its
SHA-256 (Secure Hash Algorithm 256-bit) digest. Zstandard is an internal storage
format and does not change the ZIP compression method or add an HTTP
(Hypertext Transfer Protocol) `Content-Encoding` header.

Only the manifest is decoded at startup. File contents are read from the
embedded string, with compressed blocks decoded as needed. There is no runtime
extraction to disk, temporary asset tree, or expansion of the entire asset set
into memory. Seeking and HTTP byte ranges read the referenced blocks without
decoding the preceding contents of a file.

The shared cache has four slots. Each slot allocates at most a 1 MiB compressed
input buffer and a 1 MiB decoded output buffer, so these buffers total at most
8 MiB. Slots are released after each read; a slow network client does not hold a
slot while waiting for its response to be written. Request cancellation also
cancels waits for a slot. The 8 MiB figure is not a bound on total process
memory: manifest structures, decoder state, per-request buffers, the Go runtime,
and resident executable pages use additional memory.

The handler retains Go's `net/http.FileServer` behavior for directory indexes,
redirects, content type detection, `HEAD`, and byte ranges. Compression is not
performed while downloading an asset.

## Targeted checks

The asset packages can be tested without rebuilding the frontend:

```sh
go test ./internal/packedfs ./internal/packbuild
```

Regenerate the pack after changing hosted assets. A direct `go build main.go`
requires an existing pack, just as the previous build required prepared embedded
assets.

## Dependency maintenance

`go.mod` pins `github.com/klauspost/compress` and `go.sum` records its checksums.
The selected version supports the module's Go 1.24 baseline.

When updating the dependency, update `go.mod` and `go.sum` and review
`go list -deps ./internal/packedfs` for the release targets. Each section in
`THIRD-PARTY-NOTICES.txt` names its upstream source. Refresh the applicable
license text verbatim and check the dependency's source for any newly bundled
code. Run the targeted checks and release cross-compilation checks.
GoReleaser includes the notices in release archives and under
`/usr/share/doc/naidan-server/` in Debian and RPM (RPM Package Manager) packages.
Actions server artifacts include the notices beside the executable. Signed
branch distributions publish them as `naidan-server-THIRD-PARTY-NOTICES.txt`.
