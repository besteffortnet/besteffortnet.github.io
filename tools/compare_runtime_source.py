#!/usr/bin/env python3
"""許可した静的配信とローカルGitの固定commitを、本文を出さず照合する。"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import time
from urllib import error, parse, request

sys.dont_write_bytecode = True
from static_ui_inventory import ALLOWED_ORIGINS, make_opener, safe_url

MAX_BYTES = 1024 * 1024
RULES = {
    'toeic-study': {
        'origin': 'https://192.168.68.221:8009',
        'repository': 'besteffortnet/webtest',
        'assets': [('index', '/', 'static/index.html', 'html'),
                   ('shell-style', '/study-shell.css', 'static/study-shell.css', 'css'),
                   ('shell-script', '/study-shell.js', 'static/study-shell.js', 'js'),
                   ('request-client', '/request-client.js', 'static/request-client.js', 'js'),
                   ('releases-style', '/webui-releases.css', 'static/webui-releases.css', 'css'),
                   ('releases-script', '/webui-releases.js', 'static/webui-releases.js', 'js'),
                   ('history', '/version-history.html', 'static/version-history.html', 'html')],
    },
    'equalification': {
        'origin': 'https://192.168.68.221:8010',
        'repository': 'besteffortnet/equalification',
        'assets': [('index', '/', 'static/index.html', 'html'),
                   ('style', '/style.ui-2026.11.04.1.css', 'static/style.ui-2026.11.04.1.css', 'css'),
                   ('app', '/app.js', 'static/app.js', 'js'),
                   ('explanation', '/explanation.js', 'static/explanation.js', 'js'),
                   ('mathjax-lazy', '/mathjax-lazy.js', 'static/mathjax-lazy.js', 'js'),
                   ('reflow', '/reflow.js', 'static/reflow.js', 'js'),
                   ('history', '/webui-history.ui-2026.11.04.1.html', 'static/webui-history.ui-2026.11.04.1.html', 'html'),
                   ('history-script', '/webui-history.ui-2026.11.04.1.js', 'static/webui-history.ui-2026.11.04.1.js', 'js'),
                   ('history-style', '/webui-history.ui-2026.11.04.1.css', 'static/webui-history.ui-2026.11.04.1.css', 'css'),
                   ('history-loader', '/webui-history-loader.ui-2026.11.04.1.js', 'static/webui-history-loader.ui-2026.11.04.1.js', 'js')],
    },
    'webapp-common': {
        'origin': 'https://192.168.68.221:8013',
        'repository': 'besteffortnet/agent-ops',
        'assets': [('index', '/', 'tools/webapp-common/public/index.html', 'html'),
                   ('theme', '/theme-boot.js', 'tools/webapp-common/public/theme-boot.js', 'js'),
                   ('style', '/styles.css', 'tools/webapp-common/public/styles.css', 'css'),
                   ('app', '/app.js', 'tools/webapp-common/public/app.js', 'js'),
                   ('enhancements', '/enhancements.js', 'tools/webapp-common/public/enhancements.js', 'js'),
                   ('status', '/service-status.html', 'tools/webapp-common/releases/status-ui-v0.8.29/snapshot/service-status.html', 'html'),
                   ('status-style', '/service-status.css', 'tools/webapp-common/releases/status-ui-v0.8.29/snapshot/service-status.css', 'css'),
                   ('status-script', '/service-status.mjs', 'tools/webapp-common/releases/status-ui-v0.8.29/snapshot/service-status.mjs', 'js')],
    },
    'photo-editing': {
        'origin': 'https://192.168.68.221:8011',
        'repository': 'besteffortnet/photo-editing',
        'assets': [('index', '/', 'static/index.html', 'html'),
                   ('style', '/style.css', 'static/style.css', 'css'),
                   ('app', '/app.js', 'static/app.js', 'js'),
                   ('improvements', '/improvements.js', 'static/improvements.js', 'js'),
                   ('album-order', '/album-order.js', 'static/album-order.js', 'js')],
    },
    'duo-study': {
        'origin': 'https://192.168.68.221:8016',
        'repository': 'besteffortnet/duo-learning',
        'assets': [('index', '/', 'static/index.html', 'html'),
                   ('style', '/style.css', 'static/style.css', 'css'),
                   ('app', '/app.js', 'static/app.js', 'js'),
                   ('study-core', '/study-core.mjs', 'static/study-core.mjs', 'js')],
    },
    'video-player-2d': {
        'origin': 'https://192.168.68.221:8017',
        'repository': 'besteffortnet/video-player-2d',
        'assets': [('index', '/', 'static/index.html', 'html'),
                   ('style', '/static/style.css', 'static/style.css', 'css'),
                   ('app', '/static/app.js', 'static/app.js', 'js'),
                   ('theme', '/static/theme.js', 'static/theme.js', 'js'),
                   ('history', '/static/releases.html', 'static/releases.html', 'html'),
                   ('history-script', '/static/releases.js', 'static/releases.js', 'js'),
                   ('history-style', '/static/releases.css', 'static/releases.css', 'css'),
                   ('history-data', '/static/releases.json', 'static/releases.json', 'json')],
    },
}
MIME = {'html': {'text/html', 'application/xhtml+xml'}, 'css': {'text/css'},
        'js': {'text/javascript', 'application/javascript', 'application/x-javascript'},
        'json': {'application/json'}}
HEX = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})\Z')


def git(repo, *args):
    # Git側の外部コマンド・対話・作業ツリーの変更を必要としない読取りだけを使う。
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0', LC_ALL='C')
    try:
        result = subprocess.run(['git', '-C', str(repo), *args], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, timeout=8, env=env, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


def repository_matches(repo, expected):
    raw = git(repo, 'remote', 'get-url', 'origin')
    if raw is None or len(raw) > 2048:
        return False
    try:
        url = raw.decode('utf-8').strip()
    except UnicodeError:
        return False
    # originは誤った作業ツリーを避けるための照合で、リポジトリの真正性証明ではない。
    return url in {f'https://github.com/{expected}', f'https://github.com/{expected}.git',
                   f'git@github.com:{expected}', f'git@github.com:{expected}.git',
                   f'ssh://git@github.com/{expected}', f'ssh://git@github.com/{expected}.git'}


def resolve_commit(repo, requested=None):
    if requested is not None and not HEX.fullmatch(requested):
        return None
    raw = git(repo, 'rev-parse', '--verify', (requested or 'HEAD') + '^{commit}')
    if raw is None:
        return None
    try:
        value = raw.decode('ascii').strip()
    except UnicodeError:
        return None
    return value if HEX.fullmatch(value) and (requested is None or value == requested) else None


def git_asset(repo, commit, filepath):
    listing = git(repo, 'ls-tree', '-z', commit, '--', filepath)
    if listing is None:
        return None, 'git_tree_unavailable'
    rows = listing.split(b'\0')
    if len(rows) != 2 or not rows[0] or rows[1]:
        return None, 'git_file_unavailable'
    try:
        meta, actual_path = rows[0].split(b'\t', 1)
        mode, kind, oid = meta.decode('ascii').split(' ')
        if actual_path.decode('utf-8') != filepath or mode not in ('100644', '100755') or kind != 'blob' or not HEX.fullmatch(oid):
            return None, 'git_file_not_regular'
    except (ValueError, UnicodeError):
        return None, 'git_tree_invalid'
    size = git(repo, 'cat-file', '-s', oid)
    if size is None or not size.strip().isdigit():
        return None, 'git_object_unavailable'
    if int(size.strip()) > MAX_BYTES:
        return None, 'git_file_too_large'
    content = git(repo, 'cat-file', 'blob', oid)
    if content is None or len(content) != int(size.strip()):
        return None, 'git_object_unavailable'
    return hashlib.sha256(content).hexdigest(), None


def runtime_asset(url, kind, opener, timeout, allowed_origins=ALLOWED_ORIGINS):
    try:
        parsed = parse.urlsplit(url)
    except (TypeError, ValueError):
        return None, 'not_allowlisted', None
    if (not safe_url(url, allowed_origins) or parsed.query or parsed.fragment or kind not in MIME):
        return None, 'not_allowlisted', None
    req = request.Request(url, method='GET', headers={
        'User-Agent': 'WebUI-Runtime-Source-Check/1.0', 'Accept': '*/*',
        'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache',
    })
    try:
        with opener.open(req, timeout=timeout) as response:
            status = response.status
            if status != 200:
                return None, 'http_error', status
            if response.headers.get_content_type().lower() not in MIME[kind]:
                return None, 'unexpected_content_type', status
            if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                return None, 'encoded_response', status
            length = response.headers.get('Content-Length')
            if length is None or not length.isascii() or not length.isdigit():
                return None, 'unknown_length', status
            expected = int(length)
            if expected > MAX_BYTES:
                return None, 'response_too_large', status
            digest, size, deadline = hashlib.sha256(), 0, time.monotonic() + timeout
            while size < expected:
                if time.monotonic() > deadline:
                    return None, 'timeout', status
                chunk = response.read1(min(16384, expected - size))
                if not chunk:
                    return None, 'incomplete_response', status
                size += len(chunk)
                digest.update(chunk)
            return digest.hexdigest(), None, status
    except error.HTTPError as exc:
        status = exc.code
        exc.close()
        return None, ('redirect' if 300 <= status < 400 else
                      'access_restricted' if status in (401, 403) else 'http_error'), status
    except (socket.timeout, TimeoutError):
        return None, 'timeout', None
    except error.URLError as exc:
        return None, ('tls_error' if isinstance(exc.reason, ssl.SSLError) else
                      'timeout' if isinstance(exc.reason, (socket.timeout, TimeoutError)) else
                      'connection_error'), None
    except ssl.SSLError:
        return None, 'tls_error', None
    except (OSError, http.client.HTTPException, ValueError):
        return None, 'read_error', None


def compare(repo, commit, rule, opener, timeout, allowed_origins=ALLOWED_ORIGINS):
    results = []
    for name, urlpath, filepath, kind in rule['assets']:
        result = {'asset': name, 'checked_at': datetime.now(timezone.utc).isoformat(),
                  'status': 'unknown', 'reason': None, 'http_status': None,
                  'git_sha256': None, 'runtime_sha256': None}
        expected, problem = git_asset(repo, commit, filepath)
        if problem:
            result['reason'] = problem
        else:
            result['git_sha256'] = expected
            observed, problem, status = runtime_asset(rule['origin'] + urlpath, kind, opener,
                                                      timeout, allowed_origins)
            result['http_status'], result['runtime_sha256'] = status, observed
            if problem:
                result['reason'] = problem
            else:
                result['status'] = 'match' if expected == observed else 'different'
        results.append(result)
    counts = Counter(item['status'] for item in results)
    overall = 'different' if counts['different'] else 'unknown' if counts['unknown'] else 'match'
    return {'overall': overall, 'counts': {k: counts[k] for k in ('match', 'different', 'unknown')},
            'results': results}


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--app', required=True, choices=sorted(RULES))
    cli.add_argument('--repo', required=True, type=Path, help='比較対象のローカルGitリポジトリ')
    cli.add_argument('--commit', help='完全なcommit hash。省略すると開始時のHEADを固定')
    cli.add_argument('--ca-file', type=Path, help='既存の公開CAを通常の信頼ストアに追加')
    cli.add_argument('--timeout', type=float, default=4.0)
    args = cli.parse_args(argv)
    if not math.isfinite(args.timeout) or not 0.1 <= args.timeout <= 10:
        cli.error('timeout must be between 0.1 and 10 seconds')
    rule = RULES[args.app]
    if not repository_matches(args.repo, rule['repository']):
        print(json.dumps({'ok': False, 'error': 'repository_origin_mismatch'}))
        return 2
    commit = resolve_commit(args.repo, args.commit)
    if not commit:
        print(json.dumps({'ok': False, 'error': 'commit_unavailable'}))
        return 2
    try:
        opener = make_opener(args.ca_file)
        result = compare(args.repo, commit, rule, opener, args.timeout)
    except (OSError, ValueError, ssl.SSLError):
        print(json.dumps({'ok': False, 'error': 'ca_unavailable'}))
        return 2
    output = {'ok': True, 'schema': 1, 'app': args.app, 'commit': commit,
              'scope': 'fixed_git_commit_and_allowlisted_static_responses', **result}
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0 if result['overall'] == 'match' else 1 if result['overall'] == 'different' else 2


if __name__ == '__main__':
    sys.exit(main())
