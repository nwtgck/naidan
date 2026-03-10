# Static Hosting Examples

## 1. Preparation
Download or build the static files into `naidan-hosted/`.

### Option A: Download
```bash
wget https://github.com/nwtgck/naidan/releases/download/v0.24.1/naidan-hosted-v0.24.1.zip
unzip naidan-hosted-v0.24.1.zip -d naidan-hosted
```

### Option B: Build
```bash
cd ..
npm ci && npm run build
cp -r dist/hosted static-hosting-examples/naidan-hosted
cd static-hosting-examples
```

## 2. Examples
- [nginx-basic](./nginx-basic/): Standard Nginx
- [nginx-csp-local-only](./nginx-csp-local-only/): Nginx with local-only CSP
- [caddy-basic](./caddy-basic/): Standard Caddy
- [caddy-csp-local-only](./caddy-csp-local-only/): Caddy with local-only CSP
