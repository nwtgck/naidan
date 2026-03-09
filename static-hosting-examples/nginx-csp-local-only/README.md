# Nginx CSP Local Only

This configuration restricts connections only to local APIs (localhost/127.0.0.1) via CSP for enhanced privacy.

## Host
Run from the parent directory:
```bash
nginx -c $(pwd)/nginx-csp-local-only/nginx.conf
```

## Docker
Run from the parent directory:
```bash
docker run --rm -v $(pwd)/naidan-hosted:/usr/share/nginx/html:ro -v $(pwd)/nginx-csp-local-only/nginx.conf:/etc/nginx/nginx.conf:ro -p 5536:5536 nginx:1.28
```
