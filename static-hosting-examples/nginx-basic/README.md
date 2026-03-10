# Nginx Basic

## Host
Run from the parent directory:
```bash
nginx -c $(pwd)/nginx-basic/nginx.conf
```

## Docker
Run from the parent directory:
```bash
docker run --rm -v $(pwd)/naidan-hosted:/usr/share/nginx/html:ro -v $(pwd)/nginx-basic/nginx.conf:/etc/nginx/nginx.conf:ro -p 5536:5536 nginx:1.28
```
