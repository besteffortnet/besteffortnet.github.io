import json
import hashlib
from pathlib import Path
import socket
import ssl
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib import error

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import static_ui_inventory as audit


class Fixture(BaseHTTPRequestHandler):
    requests_seen = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.requests_seen.append((self.path, self.headers.get('Cookie')))
        if self.path.startswith('/redirect'):
            self.send_response(302)
            self.send_header('Location', '/forbidden')
            self.end_headers()
            return
        if self.path.startswith('/auth'):
            self.send_response(401)
            self.end_headers()
            return
        if self.path.startswith('/denied'):
            self.send_response(403)
            self.end_headers()
            return
        if self.path == '/large':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(audit.MAX_HTML + 1))
            self.end_headers()
            return
        if self.path == '/large2':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(2 * audit.MAX_HTML + 1))
            self.end_headers()
            return
        if self.path == '/truncated':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', '1000')
            self.end_headers()
            self.wfile.write(b'<html>incomplete</html>')
            self.close_connection = True
            return
        if self.path.startswith('/large-stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            try:
                self.wfile.write(b'x' * (audit.MAX_HTML + 1))
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if self.path.startswith('/not-html'):
            body, content_type = b'{"ok":true}', 'application/json'
        else:
            body = '''<!doctype html><html><head><link rel="stylesheet" href="/forbidden.css"></head><body>
                <button id="theme-toggle"><span><svg><path></path></svg></span></button>
                <a class="version-link" href="/history.html">v1.2.3</a>
                <a href="https://besteffortnet.github.io/webui-apps.html"><svg></svg></a>
                <img src="/forbidden-image"><script src="/forbidden.js"></script>
                <p>EXAMPLE-PRIVATE-USER-CONTENT</p></body></html>'''.encode()
            content_type = 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class StaticUIInventoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.allowed = {('http', '127.0.0.1', cls.server.server_port)}
        cls.opener = audit.make_opener()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Fixture.requests_seen.clear()

    def fetch(self, path, **kwargs):
        return audit.fetch_one({'id': 'fixture', 'url': self.base + path, 'documentation': False},
                               self.opener, timeout=2, allowed_origins=self.allowed, **kwargs)

    def test_inventory_from_real_directory(self):
        html = (Path(__file__).resolve().parents[1] / 'webui-apps.html').read_text(encoding='utf-8')
        targets = audit.inventory_targets(html)
        ids = [item['id'] for item in targets]
        self.assertGreaterEqual(len(targets), 2)
        self.assertEqual(len(set(ids)), len(ids))
        self.assertIn('comic', ids)
        self.assertIn('comic-https', ids)
        self.assertGreaterEqual(sum(item['documentation'] for item in targets), 1)

    def test_invalid_directory_is_rejected(self):
        with self.assertRaises(ValueError):
            audit.inventory_targets('<html></html>')

    def test_success_only_fetches_one_document_and_does_not_report_content_or_url(self):
        result = self.fetch('/html?private-query-value')
        self.assertEqual(result['outcome'], 'html')
        self.assertEqual(result['http_status'], 200)
        self.assertEqual(result['static'], {name: 'observed' for name in audit.FIELDS})
        self.assertEqual(result['versions'], ['v1.2.3'])
        self.assertEqual(result['binding_sha256'], hashlib.sha256((self.base + '/html?private-query-value').encode()).hexdigest())
        self.assertEqual(Fixture.requests_seen, [('/html?private-query-value', None)])
        report = json.dumps(result)
        for secret in ('EXAMPLE-PRIVATE-USER-CONTENT', 'private-query-value', self.base, '/html'):
            self.assertNotIn(secret, report)

    def test_larger_limit_is_restricted_to_exact_miniui_target(self):
        self.assertEqual(audit.HTML_SIZE_EXCEPTIONS,
                         {('miniui', 'http://192.168.68.221:8000/extensions/miniui/index.html'): 2 * audit.MAX_HTML})
        url = self.base + '/large-stream'
        with patch.dict(audit.HTML_SIZE_EXCEPTIONS, {('miniui', url): 2 * audit.MAX_HTML}, clear=True):
            target = {'id': 'miniui', 'url': url, 'documentation': False}
            accepted = audit.fetch_one(target, self.opener, timeout=2, allowed_origins=self.allowed)
            self.assertEqual(accepted['outcome'], 'html')
            self.assertNotIn('x' * 256, json.dumps(accepted))
            target['id'] = 'another-app'
            self.assertEqual(audit.fetch_one(target, self.opener, 2, self.allowed)['outcome'], 'too_large')
            target.update(id='miniui', url=self.base + '/large')
            self.assertEqual(audit.fetch_one(target, self.opener, 2, self.allowed)['outcome'], 'too_large')

    def test_miniui_exception_retains_a_hard_size_limit(self):
        url = self.base + '/large2'
        with patch.dict(audit.HTML_SIZE_EXCEPTIONS, {('miniui', url): 2 * audit.MAX_HTML}, clear=True):
            target = {'id': 'miniui', 'url': url, 'documentation': False}
            self.assertEqual(audit.fetch_one(target, self.opener, 2, self.allowed)['outcome'], 'too_large')

    def test_truncated_html_is_not_reported_as_a_valid_page(self):
        result = self.fetch('/truncated')
        self.assertEqual(result['outcome'], 'read_error')
        self.assertTrue(all(value == 'unknown' for value in result['static'].values()))

    def test_redirect_is_not_followed(self):
        result = self.fetch('/redirect')
        self.assertEqual((result['outcome'], result['http_status']), ('redirect', 302))
        self.assertEqual(result['static'], audit.unknown_features())
        self.assertEqual([path for path, _ in Fixture.requests_seen], ['/redirect'])

    def test_auth_and_non_html_are_unknown(self):
        auth = self.fetch('/auth')
        denied = self.fetch('/denied')
        other = self.fetch('/not-html')
        self.assertEqual((auth['outcome'], auth['http_status']), ('access_restricted', 401))
        self.assertEqual((denied['outcome'], denied['http_status']), ('access_restricted', 403))
        self.assertEqual(other['outcome'], 'not_html')
        self.assertEqual(auth['static'], audit.unknown_features())
        self.assertEqual(other['static'], audit.unknown_features())

    def test_large_response_is_not_read(self):
        result = self.fetch('/large')
        self.assertEqual(result['outcome'], 'too_large')
        self.assertEqual(result['static'], audit.unknown_features())

    def test_stream_without_content_length_is_bounded(self):
        result = self.fetch('/large-stream')
        self.assertEqual(result['outcome'], 'too_large')
        self.assertEqual(result['static'], audit.unknown_features())

    def test_unknown_host_credentials_fragment_and_scheme_are_rejected(self):
        for url in ('http://evil.example/', 'http://user:pass@127.0.0.1/',
                    'http://127.0.0.1/#fragment', 'file:///etc/passwd',
                    'http://127.0.0.1:99999/', 'http://127.0.0.1/\nattack'):
            with self.subTest(url=url):
                self.assertFalse(audit.safe_url(url, self.allowed))
        target = {'id': 'x', 'url': self.base + '/forbidden', 'documentation': False}
        result = audit.fetch_one(target, self.opener, allowed_origins={('http', 'other.example', 80)})
        self.assertEqual(result['outcome'], 'not_allowlisted')
        self.assertIsNone(result['binding_sha256'])
        self.assertEqual(Fixture.requests_seen, [])

    def test_documentation_is_not_fetched(self):
        target = {'id': 'reference-1', 'url': self.base + '/forbidden', 'documentation': True}
        result = audit.fetch_one(target, self.opener, allowed_origins=self.allowed)
        self.assertEqual(result['outcome'], 'documentation')
        self.assertEqual(Fixture.requests_seen, [])

    def test_tls_and_timeout_classification_do_not_expose_exception(self):
        target = {'id': 'fixture', 'url': self.base, 'documentation': False}
        for exc, outcome in ((error.URLError(ssl.SSLError('EXAMPLE-PRIVATE-ERROR')), 'tls_error'),
                             (error.URLError(socket.timeout('EXAMPLE-PRIVATE-ERROR')), 'timeout')):
            class Failing:
                def open(self, *args, **kwargs):
                    raise exc
            result = audit.fetch_one(target, Failing(), allowed_origins=self.allowed)
            self.assertEqual(result['outcome'], outcome)
            self.assertNotIn('EXAMPLE-PRIVATE-ERROR', json.dumps(result))

    def test_static_absence_is_not_a_claim_of_missing_function(self):
        parser = audit.StaticUIParser(self.base + '/')
        parser.feed('<button id="theme-toggle">文字だけ</button><script>/* dynamic UI */</script>')
        parser.close()
        self.assertEqual(parser.features, {name: 'not_observed' for name in audit.FIELDS})

    def test_html_nesting_limit_is_bounded(self):
        parser = audit.StaticUIParser(self.base + '/')
        with self.assertRaises(ValueError):
            parser.feed('<div>' * 513)

    def test_history_requires_real_same_origin_link(self):
        parser = audit.StaticUIParser(self.base + '/')
        parser.feed('<a class="version" href="javascript:history()">v2.3</a>'
                    '<a class="version" href="https://elsewhere.example/history">v3.4</a>'
                    '<a class="version" href="https://127.0.0.1/history">v4.0</a>'
                    '<a class="version" href="#history">v4.5</a>')
        parser.close()
        self.assertEqual(parser.features['history_link'], 'not_observed')
        self.assertEqual(parser.versions, [])

    def test_explicit_empty_proxy_does_not_read_proxy_environment(self):
        with patch('urllib.request.getproxies', side_effect=AssertionError('proxy must not be read')):
            audit.make_opener()


if __name__ == '__main__':
    unittest.main()
