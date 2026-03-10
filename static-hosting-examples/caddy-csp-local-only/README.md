# Caddy CSP Local Only

This configuration restricts connections only to local APIs (localhost/127.0.0.1) via CSP for enhanced privacy.

## Host
Run from the parent directory:
```bash
caddy run --config caddy-csp-local-only/Caddyfile
```

## Docker
Run from the parent directory:
```bash
docker run --rm -v $(pwd)/naidan-hosted:/usr/share/caddy:ro -v $(pwd)/caddy-csp-local-only/Caddyfile:/etc/caddy/Caddyfile:ro -p 5536:5536 caddy:2.10
```
