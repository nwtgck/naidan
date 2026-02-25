#!/usr/bin/env python3
"""
Naidan Server - Python Implementation

Philosophy:
- Zero Dependencies: Uses only the Python standard library for immediate execution 
  in any environment without installation (npm/pip/etc).
- Single File: Entire server in one file for easy distribution and auditing.
- Security & Trust: Minimizes dependencies to reduce attack surface.
"""

import argparse
import http.server
import logging
import mimetypes
import os
import re
import urllib.request
import urllib.error
import urllib.parse
import zipfile
from pathlib import Path
from typing import List, Optional, Tuple, Dict

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("naidan-server")

class ZipProvider:
    """
    Accesses ZIP files without caching content. 
    Detects the root directory (e.g., dist/ or naidan-standalone/) automatically.
    """
    def __init__(self, zip_path: Path):
        self.zip_path = zip_path
        self.root_prefix = self._detect_root()
        logger.info(f"Initialized ZipProvider. Root prefix detected: '{self.root_prefix}'")

    def _detect_root(self) -> str:
        with zipfile.ZipFile(self.zip_path, 'r') as z:
            for name in z.namelist():
                if name.endswith('index.html'):
                    return name[:-len('index.html')]
        return ""

    def get_content(self, internal_path: str) -> Optional[bytes]:
        full_path = self.root_prefix + internal_path.lstrip('/')
        try:
            with zipfile.ZipFile(self.zip_path, 'r') as z:
                return z.read(full_path)
        except KeyError:
            return None

def find_latest_zip() -> Path:
    """
    Priority: Hosted > Standalone. Picks the highest version among them.
    """
    cwd = Path('.')
    # Match naidan-hosted*.zip or naidan-standalone*.zip
    h_pat = re.compile(r"naidan-hosted(.*)\.zip")
    s_pat = re.compile(r"naidan-standalone(.*)\.zip")
    
    hosted, standalone = [], []
    for item in cwd.iterdir():
        if not item.is_file(): continue
        m = h_pat.match(item.name)
        if m: 
            v = tuple(map(lambda x: int(x) if x.isdigit() else x, m.group(1).strip('-').split('.')))
            hosted.append((v, item))
        m = s_pat.match(item.name)
        if m:
            v = tuple(map(lambda x: int(x) if x.isdigit() else x, m.group(1).strip('-').split('.')))
            standalone.append((v, item))

    if hosted: return max(hosted)[1]
    if standalone: return max(standalone)[1]
    raise FileNotFoundError("No naidan-hosted*.zip or naidan-standalone*.zip found in CWD.")

def parse_proxy_arg(proxy_str: str) -> Tuple[str, str]:
    parts = proxy_str.split(':', 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid proxy format: {proxy_str}. Expected /path:target_url")
    prefix, target = parts[0], parts[1]
    if not target.startswith(('http://', 'https://')):
        target = 'http://' + target
    return prefix, target

class NaidanHandler(http.server.BaseHTTPRequestHandler):
    zip_provider: Optional[ZipProvider] = None
    proxies: List[Tuple[str, str]] = []
    allow_origins: List[str] = []
    csp_header: Optional[str] = None

    def _send_cors_headers(self):
        if self.allow_origins:
            origin = self.headers.get("Origin")
            if "*" in self.allow_origins:
                self.send_header("Access-Control-Allow-Origin", "*")
            elif origin in self.allow_origins:
                self.send_header("Access-Control-Allow-Origin", origin)
            
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, DELETE, PATCH")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send_csp_headers(self):
        if self.csp_header:
            self.send_header("Content-Security-Policy", self.csp_header)

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def handle_request(self):
        path = urllib.parse.urlparse(self.path).path
        for prefix, target in self.proxies:
            if path.startswith(prefix):
                self._handle_reverse_proxy(prefix, target)
                return
        if self.command == 'GET':
            self._handle_static(path)
        else:
            self.send_error(405)

    do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = handle_request

    def _handle_reverse_proxy(self, prefix: str, target: str):
        rel_path = self.path[len(prefix):]
        if not rel_path.startswith('/'): rel_path = '/' + rel_path
        target_url = target.rstrip('/') + rel_path
        
        logger.info(f"Proxy: {self.command} {self.path} -> {target_url}")
        headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'content-length', 'connection')}
        
        body = None
        if self.command in ('POST', 'PUT', 'PATCH'):
            length = int(self.headers.get('Content-Length', 0))
            if length > 0: body = self.rfile.read(length)

        req = urllib.request.Request(target_url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req) as res:
                self.send_response(res.status)
                self._send_cors_headers()
                self._send_csp_headers()
                for k, v in res.getheaders():
                    if k.lower() not in ('connection', 'transfer-encoding', 'access-control-allow-origin', 'content-security-policy'):
                        self.send_header(k, v)
                self.end_headers()
                try:
                    while chunk := res.read(128):
                        self.wfile.write(chunk)
                        self.wfile.flush()
                except (ConnectionResetError, BrokenPipeError): pass
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self.end_headers()
            self.wfile.write(e.read())
        except Exception as e:
            logger.error(f"Proxy error: {e}")
            self.send_error(502)

    def _handle_static(self, path: str):
        if not self.zip_provider: return self.send_error(500)
        p = path.lstrip('/') or 'index.html'
        content = self.zip_provider.get_content(p)
        if content is None:
            content = self.zip_provider.get_content('index.html')
            p = 'index.html'
            if content is None: return self.send_error(404)

        self.send_response(200)
        self._set_content_type(p)
        self.send_header("Content-Length", str(len(content)))
        self._send_cors_headers()
        self._send_csp_headers()
        
        # Inform the frontend about the reverse proxy configuration via a cookie.
        # This allows OnboardingModal to suggest the correct endpoint automatically.
        if self.proxies:
            prefix = self.proxies[0][0]
            self.send_header("Set-Cookie", f"reverse_proxy_path={prefix}; Path=/; SameSite=Lax")
            
        self.end_headers()
        self.wfile.write(content)

    def _set_content_type(self, path: str):
        mime, _ = mimetypes.guess_type(path)
        if not mime:
            ext = os.path.splitext(path)[1].lower()
            mime = {'.wasm': 'application/wasm', '.js': 'application/javascript'}.get(ext, 'application/octet-stream')
        self.send_header("Content-Type", mime)

def main():
    parser = argparse.ArgumentParser(description="Naidan Server (Standard Library Only)")
    parser.add_argument("-z", "--hosted-zip", help="Path to ZIP. If omitted, selects latest from CWD.")
    parser.add_argument("-p", "--port", type=int, default=5536, help="Port (default: 5536)")
    parser.add_argument("--host", default="127.0.0.1", help="Host (default: 127.0.0.1)")
    parser.add_argument("-r", "--reverse-proxy", action="append", help="e.g., /myapi:localhost:11434")
    parser.add_argument("--allow-origin", action="append", help="Enable CORS for specific origin(s)")
    
    args = parser.parse_args()
    if args.reverse_proxy:
        parser.epilog = "Note: Reverse proxying automatically enables a strong Content-Security-Policy (CSP)."

    try:
        zip_path = Path(args.hosted_zip) if args.hosted_zip else find_latest_zip()
        NaidanHandler.zip_provider = ZipProvider(zip_path)
    except Exception as e:
        return logger.error(e)

    if args.reverse_proxy:
        for ps in args.reverse_proxy:
            prefix, target = parse_proxy_arg(ps)
            NaidanHandler.proxies.append((prefix, target))
            logger.info(f"Reverse Proxy: {prefix} -> {target}")
        
        NaidanHandler.csp_header = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "font-src 'self' data:; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; form-action 'none';"
        )
        logger.info(f"Security: CSP enabled for reverse proxy: {NaidanHandler.csp_header}")

    NaidanHandler.allow_origins = args.allow_origin or []

    httpd = http.server.ThreadingHTTPServer((args.host, args.port), NaidanHandler)
    logger.info(f"Naidan Server starting at http://{args.host}:{args.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()

if __name__ == "__main__":
    main()
