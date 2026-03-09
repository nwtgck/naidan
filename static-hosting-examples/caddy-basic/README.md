# Caddy Basic

## Host
Run from the parent directory:
```bash
caddy run --config caddy-basic/Caddyfile
```

## Docker
Run from the parent directory:
```bash
docker run --rm -v $(pwd)/naidan-hosted:/usr/share/caddy:ro -v $(pwd)/caddy-basic/Caddyfile:/etc/caddy/Caddyfile:ro -p 5536:5536 caddy:2.10
```
