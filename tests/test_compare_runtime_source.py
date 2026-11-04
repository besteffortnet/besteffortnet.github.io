import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import compare_runtime_source as drift
from static_ui_inventory import make_opener


class Handler(BaseHTTPRequestHandler):
    routes = {}
    requests = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.requests.append((self.path, self.headers.get('Authorization'), self.headers.get('Cookie')))
        spec = self.routes[self.path]
        if spec.get('delay'):
            time.sleep(spec['delay'])
        self.send_response(spec.get('status', 200))
        self.send_header('Content-Type', spec.get('mime', 'text/html'))
        if 'length' in spec:
            if spec['length'] is not None:
                self.send_header('Content-Length', str(spec['length']))
        else:
            self.send_header('Content-Length', str(len(spec.get('body', b''))))
        if spec.get('location'):
            self.send_header('Location', spec['location'])
        if spec.get('encoding'):
            self.send_header('Content-Encoding', spec['encoding'])
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(spec.get('body', b''))
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True


class RuntimeSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.allowed = frozenset({('http', '127.0.0.1', cls.server.server_port)})
        cls.opener = make_opener()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)

    def setUp(self):
        Handler.routes = {}
        Handler.requests = []
        self.tmp = tempfile.TemporaryDirectory(prefix='runtime-drift-fixture-')
        self.repo = Path(self.tmp.name) / 'repo'
        self.repo.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Synthetic Test')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        self.git('remote', 'add', 'origin', 'https://github.com/example/synthetic.git')
        (self.repo / 'static').mkdir()
        (self.repo / 'static/index.html').write_bytes(b'<p>synthetic-private-fixture</p>')
        (self.repo / 'static/app.js').write_bytes(b'const fixture = true;\n')
        self.git('add', 'static')
        self.git('commit', '-q', '-m', 'synthetic fixture')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        self.rule = {'origin': self.origin, 'repository': 'example/synthetic',
                     'assets': [('index', '/', 'static/index.html', 'html'),
                                ('app', '/app.js', 'static/app.js', 'js')]}
        Handler.routes = {'/': {'body': b'<p>synthetic-private-fixture</p>'},
                          '/app.js': {'body': b'const fixture = true;\n', 'mime': 'text/javascript'}}

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout

    def fetch(self, endpoint, kind='html', timeout=1):
        return drift.runtime_asset(self.origin + endpoint, kind, self.opener, timeout, self.allowed)

    def test_matching_and_different_assets_without_content_leak(self):
        good = drift.compare(self.repo, self.commit, self.rule, self.opener, 1, self.allowed)
        self.assertEqual(good['overall'], 'match')
        self.assertEqual(good['counts'], {'match': 2, 'different': 0, 'unknown': 0})
        self.assertNotIn('synthetic-private-fixture', json.dumps(good))
        self.assertTrue(all(auth is None and cookie is None for _, auth, cookie in Handler.requests))
        Handler.routes['/app.js']['body'] = b'changed\n'
        changed = drift.compare(self.repo, self.commit, self.rule, self.opener, 1, self.allowed)
        self.assertEqual(changed['overall'], 'different')
        self.assertEqual(changed['counts']['different'], 1)
        self.assertEqual(changed['counts']['unknown'], 0)

    def test_redirect_is_not_followed(self):
        Handler.routes['/redirect'] = {'status': 302, 'location': '/target'}
        Handler.routes['/target'] = {'body': b'never fetched'}
        digest, reason, status = self.fetch('/redirect')
        self.assertEqual((digest, reason, status), (None, 'redirect', 302))
        self.assertNotIn('/target', [r[0] for r in Handler.requests])

    def test_unavailable_statuses_are_unknown(self):
        for status in (401, 403, 500):
            with self.subTest(status=status):
                Handler.routes['/'] = {'status': status}
                result = drift.compare(self.repo, self.commit, self.rule, self.opener, 1, self.allowed)
                item = result['results'][0]
                self.assertEqual(item['status'], 'unknown')
                self.assertEqual(item['reason'], 'access_restricted' if status in (401, 403) else 'http_error')
                self.assertEqual(item['http_status'], status)
                self.assertIsNone(item['runtime_sha256'])

    def test_incomplete_missing_length_wrong_type_and_encoding_are_unknown(self):
        cases = [({'body': b'abc', 'length': 20}, 'incomplete_response'),
                 ({'body': b'abc', 'length': None}, 'unknown_length'),
                 ({'body': b'abc', 'length': drift.MAX_BYTES + 1}, 'response_too_large'),
                 ({'body': b'abc', 'mime': 'application/json'}, 'unexpected_content_type'),
                 ({'body': b'abc', 'encoding': 'gzip'}, 'encoded_response')]
        for spec, expected in cases:
            with self.subTest(reason=expected):
                Handler.routes['/bad'] = spec
                value, reason, _ = self.fetch('/bad')
                self.assertIsNone(value)
                self.assertEqual(reason, expected)

    def test_timeout_is_not_a_difference(self):
        Handler.routes['/slow'] = {'body': b'late', 'delay': .6}
        value, reason, _ = self.fetch('/slow', timeout=.1)
        self.assertIsNone(value)
        self.assertEqual(reason, 'timeout')

    def test_missing_git_file_and_symlink_skip_network(self):
        (self.repo / 'static/link').symlink_to('index.html')
        self.git('add', 'static/link')
        self.git('commit', '-q', '-m', 'symlink fixture')
        commit = self.git('rev-parse', 'HEAD').strip()
        rule = {'origin': self.origin, 'assets': [('missing', '/', 'static/missing', 'html'),
                                                  ('link', '/', 'static/link', 'html')]}
        result = drift.compare(self.repo, commit, rule, self.opener, 1, self.allowed)
        self.assertEqual(result['overall'], 'unknown')
        self.assertEqual([x['reason'] for x in result['results']], ['git_file_unavailable', 'git_file_not_regular'])
        self.assertEqual(Handler.requests, [])

    def test_requested_fixed_commit_ignores_later_commit_and_worktree(self):
        (self.repo / 'static/app.js').write_bytes(b'new committed version')
        self.git('add', 'static/app.js')
        self.git('commit', '-q', '-m', 'new version')
        later = self.git('rev-parse', 'HEAD').strip()
        (self.repo / 'static/app.js').write_bytes(b'uncommitted local edit')
        self.assertEqual(drift.resolve_commit(self.repo, self.commit), self.commit)
        old = drift.compare(self.repo, self.commit, self.rule, self.opener, 1, self.allowed)
        new = drift.compare(self.repo, later, self.rule, self.opener, 1, self.allowed)
        self.assertEqual(old['overall'], 'match')
        self.assertEqual(new['overall'], 'different')

    def test_invalid_origin_commit_and_url_rejected(self):
        self.assertTrue(drift.repository_matches(self.repo, 'example/synthetic'))
        self.assertFalse(drift.repository_matches(self.repo, 'example/other'))
        self.assertIsNone(drift.resolve_commit(self.repo, 'HEAD'))
        self.assertIsNone(drift.resolve_commit(self.repo, 'f' * 40))
        value, reason, _ = self.fetch('/?unapproved=1')
        self.assertIsNone(value)
        self.assertEqual(reason, 'not_allowlisted')
        value, reason, _ = drift.runtime_asset('http://[broken', 'html', self.opener, 1, self.allowed)
        self.assertIsNone(value)
        self.assertEqual(reason, 'not_allowlisted')
        self.assertEqual(Handler.requests, [])
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = drift.main(['--app', 'duo-study', '--repo', str(self.repo)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(output.getvalue())['error'], 'repository_origin_mismatch')

    def test_cli_reports_match_difference_and_unknown_with_distinct_exit_codes(self):
        original_compare = drift.compare
        def local_compare(repo, commit, rule, opener, timeout):
            return original_compare(repo, commit, rule, opener, timeout, self.allowed)
        with mock.patch.dict(drift.RULES, {'fixture': self.rule}, clear=True), mock.patch.object(drift, 'compare', local_compare):
            for spec, expected_code, overall in [({'body': b'const fixture = true;\n', 'mime': 'text/javascript'}, 0, 'match'),
                                                 ({'body': b'changed', 'mime': 'text/javascript'}, 1, 'different'),
                                                 ({'status': 403}, 2, 'unknown')]:
                with self.subTest(overall=overall):
                    Handler.routes['/app.js'] = spec
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output):
                        code = drift.main(['--app', 'fixture', '--repo', str(self.repo), '--commit', self.commit])
                    data = json.loads(output.getvalue())
                    self.assertEqual(code, expected_code)
                    self.assertEqual(data['overall'], overall)
                    self.assertEqual(data['commit'], self.commit)
                    self.assertNotIn(str(self.repo), output.getvalue())
                    self.assertNotIn('synthetic-private-fixture', output.getvalue())

    def test_video_player_uses_only_fixed_static_paths_and_checks_json_type(self):
        rule = drift.RULES['video-player-2d']
        self.assertEqual(rule['repository'], 'besteffortnet/video-player-2d')
        self.assertEqual(len(rule['assets']), 8)
        self.assertEqual(len({asset[0] for asset in rule['assets']}), 8)
        for _, urlpath, filepath, _ in rule['assets']:
            self.assertTrue(urlpath == '/' or urlpath.startswith('/static/'))
            self.assertTrue(filepath.startswith('static/'))
            self.assertTrue(drift.safe_url(rule['origin'] + urlpath))
            self.assertNotIn('?', urlpath)
        Handler.routes['/history.json'] = {'body': b'{"releases":[]}', 'mime': 'application/json'}
        digest, reason, status = self.fetch('/history.json', kind='json')
        self.assertEqual((reason, status), (None, 200))
        self.assertIsNotNone(digest)
        Handler.routes['/history.json']['mime'] = 'text/html'
        digest, reason, _ = self.fetch('/history.json', kind='json')
        self.assertIsNone(digest)
        self.assertEqual(reason, 'unexpected_content_type')

    def test_study_apps_use_explicit_static_paths(self):
        for app, repository, count in [('toeic-study', 'besteffortnet/webtest', 7),
                                       ('equalification', 'besteffortnet/equalification', 10)]:
            with self.subTest(app=app):
                rule = drift.RULES[app]
                self.assertEqual(rule['repository'], repository)
                self.assertEqual(len(rule['assets']), count)
                self.assertEqual(len({asset[0] for asset in rule['assets']}), count)
                for _, urlpath, filepath, kind in rule['assets']:
                    self.assertTrue(drift.safe_url(rule['origin'] + urlpath))
                    self.assertTrue(filepath.startswith('static/'))
                    self.assertNotIn('/api/', urlpath)
                    self.assertNotIn('?', urlpath)
                    self.assertIn(kind, ('html', 'css', 'js'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
