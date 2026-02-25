import unittest
import os
import zipfile
import io
import shutil
import threading
import time
import http.server
import urllib.request
from pathlib import Path
import importlib.util

# Dynamic import of the hyphenated filename
spec = importlib.util.spec_from_file_location("naidan_server", "naidan-server.py")
naidan_server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(naidan_server)

class TestNaidanServer(unittest.TestCase):
    def setUp(self):
        self.test_dir = Path("test_env")
        self.test_dir.mkdir(parents=True, exist_ok=True)
        self.old_cwd = os.getcwd()
        os.chdir(self.test_dir)

    def tearDown(self):
        os.chdir(self.old_cwd)
        if self.test_dir.exists():
            shutil.rmtree(self.test_dir)

    def test_find_latest_zip_priority(self):
        Path("naidan-hosted-1.0.0.zip").touch()
        Path("naidan-standalone-1.2.4.zip").touch()
        # Hosted (v1.0.0) should be prioritized over Standalone (v1.2.4)
        self.assertEqual(naidan_server.find_latest_zip().name, "naidan-hosted-1.0.0.zip")
        # Higher version hosted should be picked
        Path("naidan-hosted-1.1.0.zip").touch()
        self.assertEqual(naidan_server.find_latest_zip().name, "naidan-hosted-1.1.0.zip")

    def test_zip_root_detection(self):
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w") as z:
            z.writestr("my-app-v1/index.html", "<html>Home</html>")
            z.writestr("my-app-v1/assets/app.js", "console.log(1)")
        
        zip_path = Path("test.zip")
        zip_path.write_bytes(zip_buf.getvalue())

        provider = naidan_server.ZipProvider(zip_path)
        self.assertEqual(provider.root_prefix, "my-app-v1/")
        
        # Testing path resolution
        content = provider.get_content("assets/app.js")
        self.assertEqual(content, b"console.log(1)")

class MockTargetHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(f"Proxied: {self.path}".encode())
    def log_message(self, format, *args): pass

class TestServerIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock_port = 5540
        cls.mock_server = http.server.HTTPServer(('localhost', cls.mock_port), MockTargetHandler)
        cls.mock_thread = threading.Thread(target=cls.mock_server.serve_forever, daemon=True)
        cls.mock_thread.start()

        cls.server_port = 5541
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w") as z:
            z.writestr("index.html", "Hello")
        
        zip_path = Path("test_integration.zip")
        zip_path.write_bytes(zip_buf.getvalue())

        naidan_server.NaidanHandler.zip_provider = naidan_server.ZipProvider(zip_path)
        naidan_server.NaidanHandler.proxies = [("/myapi", f"http://localhost:{cls.mock_port}")]
        naidan_server.NaidanHandler.allow_origins = ["*"]
        naidan_server.NaidanHandler.csp_header = "default-src 'self'; connect-src 'self';"
        
        cls.naidan_server = http.server.HTTPServer(('localhost', cls.server_port), naidan_server.NaidanHandler)
        cls.naidan_thread = threading.Thread(target=cls.naidan_server.serve_forever, daemon=True)
        cls.naidan_thread.start()
        time.sleep(0.5)

    def test_proxy_and_csp(self):
        url = f"http://localhost:{self.server_port}/myapi/status"
        with urllib.request.urlopen(url) as res:
            self.assertEqual(res.read().decode(), "Proxied: /status")
            csp = res.headers.get("Content-Security-Policy")
            self.assertIn("connect-src 'self'", csp)
            self.assertNotIn("http://localhost:5540", csp) # CSP is now simplified to 'self'

    def test_cors_enabled(self):
        url = f"http://localhost:{self.server_port}/index.html"
        req = urllib.request.Request(url, method="OPTIONS")
        with urllib.request.urlopen(req) as res:
            self.assertEqual(res.status, 204)
            self.assertEqual(res.headers.get("Access-Control-Allow-Origin"), "*")

if __name__ == "__main__":
    unittest.main()
