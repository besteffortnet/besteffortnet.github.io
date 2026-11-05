from email.message import Message
import json
from pathlib import Path
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import static_ui_inventory as audit
from test_static_ui_inventory import Fixture


class HistoryProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_port
        cls.base = f'http://127.0.0.1:{cls.port}'
        cls.origin = ('http', '127.0.0.1', cls.port)
        cls.allowed = {cls.origin}
        cls.opener = audit.make_opener()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        Fixture.requests_seen.clear()
        self.target = {'id': 'fixture', 'url': self.base + '/html', 'documentation': False}
        self.rules = {'fixture': (self.origin, {'ui': r'/history\.html'})}

    def fetch(self, enabled=False):
        with patch.dict(audit.HISTORY_RULES, self.rules):
            return audit.fetch_one(self.target, self.opener, timeout=2,
                                   allowed_origins=self.allowed, check_history=enabled)

    def probe(self, urls, rules=None, overflow=False):
        parser = SimpleNamespace(history_urls=urls, history_overflow=overflow)
        with patch.dict(audit.HISTORY_RULES, rules or self.rules):
            return audit.probe_history_links(self.target, parser, self.opener, 2, self.allowed)

    def test_default_does_not_request_history(self):
        result = self.fetch()
        self.assertNotIn('history_probe', result)
        self.assertEqual([p for p, _ in Fixture.requests_seen], ['/html'])

    def test_explicit_option_fetches_only_registered_link_and_does_not_report_url(self):
        result = self.fetch(enabled=True)
        self.assertEqual(result['history_probe']['mode'], 'checked')
        self.assertEqual(result['history_probe']['links'][0]['kind'], 'ui')
        self.assertEqual(result['history_probe']['links'][0]['outcome'], 'html_response')
        self.assertEqual(result['history_probe']['links'][0]['http_status'], 200)
        self.assertEqual([p for p, _ in Fixture.requests_seen], ['/html', '/history.html'])
        self.assertNotIn('/history.html', json.dumps(result))
        self.assertNotIn('EXAMPLE-PRIVATE-USER-CONTENT', json.dumps(result))

    def test_unconfigured_or_wrong_origin_never_fetches_history(self):
        with patch.dict(audit.HISTORY_RULES, {'fixture': (('https', 'example.test', 443),
                                                         {'ui': r'/history\.html'})}):
            result = audit.fetch_one(self.target, self.opener, 2, self.allowed, check_history=True)
        self.assertEqual(result['history_probe']['mode'], 'origin_mismatch')
        self.assertEqual([p for p, _ in Fixture.requests_seen], ['/html'])
        Fixture.requests_seen.clear()
        self.target['id'] = 'unknown-fixture'
        result = audit.fetch_one(self.target, self.opener, 2, self.allowed, check_history=True)
        self.assertEqual(result['history_probe']['mode'], 'not_configured')
        self.assertEqual([p for p, _ in Fixture.requests_seen], ['/html'])

    def test_unregistered_query_fragment_credentials_and_other_origin_are_not_fetched(self):
        urls = [self.base + '/history.html?delete=1', self.base + '/history.html#section',
                self.base + '/unregistered-history.html',
                f'http://name:password@127.0.0.1:{self.port}/history.html',
                'http://another.example/history.html']
        result = self.probe(urls)
        self.assertEqual(result['unapproved_count'], len(urls))
        self.assertEqual(result['links'][0]['outcome'], 'not_observed')
        self.assertEqual(Fixture.requests_seen, [])

    def test_only_the_explicit_history_query_is_fetched(self):
        rules = {'fixture': (self.origin, {'ui': r'/'})}
        with patch.dict(audit.EXACT_HISTORY_QUERIES, {('fixture', 'ui'): ('/', 'view=releases')}, clear=True):
            result = self.probe([self.base + '/?view=releases'], rules)
        self.assertEqual(result['links'][0]['outcome'], 'html_response')
        self.assertEqual([p for p, _ in Fixture.requests_seen], ['/?view=releases'])
        self.assertNotIn('view=releases', json.dumps(result))

    def test_history_query_exception_rejects_homepage_and_modified_queries(self):
        rules = {'fixture': (self.origin, {'ui': r'/'})}
        urls = [self.base + '/', self.base + '/?view=other',
                self.base + '/?view=releases&delete=1', self.base + '/?view=releases&view=releases',
                self.base + '/?view=releases#section', self.base + '/?view=%72eleases']
        with patch.dict(audit.EXACT_HISTORY_QUERIES, {('fixture', 'ui'): ('/', 'view=releases')}, clear=True):
            result = self.probe(urls, rules)
        self.assertEqual(result['unapproved_count'], len(urls))
        self.assertEqual(result['links'][0]['outcome'], 'not_observed')
        self.assertEqual(Fixture.requests_seen, [])

    def test_query_exception_is_bound_to_app_and_origin(self):
        for app, port in [('duo', 8016), ('audiobook', 8015), ('ai-activity', 8014)]:
            with self.subTest(app=app):
                self.assertEqual(audit.HISTORY_RULES[app][0], ('https', audit.LAN, port))
                self.assertEqual(audit.EXACT_HISTORY_QUERIES[(app, 'ui')], ('/', 'view=releases'))
        self.assertEqual(len(audit.EXACT_HISTORY_QUERIES), 3)
        rules = {'fixture': (self.origin, {'ui': r'/'})}
        result = self.probe([self.base + '/?view=releases'], rules)
        self.assertEqual(result['unapproved_count'], 1)
        self.assertEqual(Fixture.requests_seen, [])

    def test_miniui_history_is_limited_to_its_versioned_path(self):
        origin, patterns = audit.HISTORY_RULES['miniui']
        self.assertEqual(origin, ('http', audit.LAN, 8000))
        rules = {'fixture': (self.origin, patterns)}
        valid = '/extensions/miniui/release-history-ui-2026.11.04.1.html'
        result = self.probe([self.base + valid], rules)
        self.assertEqual(result['links'][0]['outcome'], 'html_response')
        self.assertEqual([p for p, _ in Fixture.requests_seen], [valid])
        Fixture.requests_seen.clear()
        variants = [valid + '?delete=1', valid + '#fragment',
                    '/extensions/other/release-history-ui-2026.11.04.1.html',
                    '/extensions/miniui/release-history-ui-latest.html']
        result = self.probe([self.base + path for path in variants], rules)
        self.assertEqual(result['unapproved_count'], len(variants))
        self.assertEqual(Fixture.requests_seen, [])

    def test_multiple_matching_links_are_ambiguous_and_not_fetched(self):
        rules = {'fixture': (self.origin, {'ui': r'/history-[0-9]+\.html'})}
        result = self.probe([self.base + '/history-1.html', self.base + '/history-2.html'], rules)
        self.assertEqual(result['links'][0]['outcome'], 'ambiguous')
        self.assertEqual(Fixture.requests_seen, [])

    def test_redirect_and_access_restriction_are_not_followed(self):
        for path, expected in (('/redirect', 'redirect'), ('/auth', 'access_restricted')):
            with self.subTest(path=path):
                Fixture.requests_seen.clear()
                rules = {'fixture': (self.origin, {'ui': path})}
                result = self.probe([self.base + path], rules)
                self.assertEqual(result['links'][0]['outcome'], expected)
                self.assertEqual([p for p, _ in Fixture.requests_seen], [path])

    def test_history_response_body_is_not_read(self):
        headers = Message()
        headers['Content-Type'] = 'text/html'
        class Response:
            status = 200
            def __init__(self): self.headers = headers
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): raise AssertionError('body must not be read')
            def read1(self, *args): raise AssertionError('body must not be read')
        class Opener:
            def open(self, req, timeout):
                self_method = req.get_method()
                if self_method != 'GET': raise AssertionError('only GET is permitted')
                return Response()
        result = audit.probe_history_url(self.base + '/history.html', Opener(), 2, self.allowed)
        self.assertEqual(result['outcome'], 'html_response')

    def test_non_200_success_does_not_claim_html_response(self):
        headers = Message()
        headers['Content-Type'] = 'text/html'
        class Response:
            status = 204
            def __init__(self): self.headers = headers
            def __enter__(self): return self
            def __exit__(self, *args): pass
        class Opener:
            def open(self, req, timeout): return Response()
        result = audit.probe_history_url(self.base + '/history.html', Opener(), 2, self.allowed)
        self.assertEqual(result['outcome'], 'non_200_response')

    def test_too_many_history_links_never_fetch(self):
        parser = audit.StaticUIParser(self.base + '/')
        parser.feed(''.join(f'<a class="version" href="/history-{i}.html">v1.2</a>'
                            for i in range(audit.MAX_HISTORY_LINKS + 1)))
        parser.close()
        self.assertTrue(parser.history_overflow)
        with patch.dict(audit.HISTORY_RULES, self.rules):
            result = audit.probe_history_links(self.target, parser, self.opener, 2, self.allowed)
        self.assertEqual(result['mode'], 'too_many_links')
        self.assertEqual(Fixture.requests_seen, [])


if __name__ == '__main__':
    unittest.main()
