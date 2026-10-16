# Static Hosting Examples

## 1. Preparation
Download or build the Hosted static files into `naidan-hosted/`. The examples serve that directory and expect `naidan-hosted/index.html`.

### Option A: Download
Open the [latest GitHub release](https://github.com/nwtgck/naidan/releases/latest) and download its Hosted ZIP asset. Save it in this directory as `naidan-hosted.zip` (rename the versioned download if needed), then extract it:

```bash
unzip naidan-hosted.zip
```

The ZIP extracts a versioned folder containing `index.html` and its assets. Rename that folder to `naidan-hosted` in this directory before running an example.

### Option B: Build
```bash
cd ..
npm ci && npm run build
cp -r dist/hosted static-hosting-examples/naidan-hosted
cd static-hosting-examples
```

The Docker commands in the examples bind-mount `naidan-hosted/` and need no path changes. If you run Nginx or Caddy directly on the host, change each `root` directive in the chosen config to the absolute path of this directory's `naidan-hosted/` before starting the server; the Nginx configs have two `root` directives.

## 2. Examples
- [nginx-basic](./nginx-basic/): Standard Nginx
- [nginx-csp-local-only](./nginx-csp-local-only/): Nginx with local-only CSP
- [caddy-basic](./caddy-basic/): Standard Caddy
- [caddy-csp-local-only](./caddy-csp-local-only/): Caddy with local-only CSP
