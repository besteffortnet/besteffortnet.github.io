#!/usr/bin/env python3
"""一覧に登録された入口の静的UIを、非認証のGETで点検する。"""
import argparse
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
import http.client
import json
import math
from pathlib import Path
import re
import socket
import ssl
import sys
import time
from urllib import error, parse, request

# 点検だけで作業ディレクトリにbytecodeを書かない。
sys.dont_write_bytecode = True
from audit_observation_mapping import DirectoryParser, audit_directory


ROOT = Path(__file__).resolve().parents[1]
MAX_HTML = 1024 * 1024
ALLOWED_ORIGINS = frozenset(
    [('http', '192.168.68.221', port) for port in (3000, 8000, 8002, 8006, 8008, 8012)] +
    [('https', '192.168.68.221', port) for port in
     (8004, 8007, 8009, 8010, 8011, 8013, 8014, 8015, 8016, 8017, 8018, 8019)] +
    [('https', host, 443) for host in
     ('script.google.com', 'narrative-tsuzuri.akioueki.chatgpt.site', 'uekiakio.com')]
)
DOC_HOST = 'github.com'
THEME = re.compile(r'theme|color.?scheme|テーマ|ダーク|ライト', re.I)
HISTORY = re.compile(r'version|release|history|changelog|バージョン|履歴', re.I)
VERSION = re.compile(r'(?<![\w.])v?\d{1,6}(?:\.\d{1,6}){1,5}(?![\w.])', re.I)
GLYPHS = frozenset('☀☼☾☽🌙🌞◐◑⚙')
VOID = frozenset({'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                  'link', 'meta', 'param', 'source', 'track', 'wbr'})
FIELDS = ('history_link', 'theme_icon', 'directory_icon')


def unknown_features():
    return {name: 'unknown' for name in FIELDS}


def safe_url(url, allowed_origins=ALLOWED_ORIGINS):
    """許可したスキーム・ホスト・ポートの組合せだけを受け付ける。"""
    try:
        if not isinstance(url, str) or len(url) > 4096 or any(ord(c) < 32 for c in url):
            return False
        p = parse.urlsplit(url)
        port = p.port  # 不正なポート番号をここで拒否する。
        effective_port = port or (443 if p.scheme == 'https' else 80)
        return (p.scheme in ('http', 'https') and
                (p.scheme, p.hostname, effective_port) in allowed_origins and
                p.username is None and p.password is None and not p.fragment and
                (port is None or 1 <= port <= 65535))
    except (TypeError, ValueError):
        return False


def inventory_targets(html):
    """一覧のサービス順と検証済み観測ID順を対応づける。"""
    if not audit_directory(html)['ok']:
        raise ValueError('directory contract is invalid')
    parser = DirectoryParser()
    parser.feed(html)
    parser.close()
    targets = []
    for index, card in enumerate(parser.cards, 1):
        services, ids = card['services'], card['observations']
        if ids and len(ids) != len(services):
            raise ValueError('service and observation counts differ')
        for pos, url in enumerate(services):
            item_id = ids[pos] if ids else 'reference-' + str(index)
            try:
                doc = parse.urlsplit(url).hostname == DOC_HOST
            except ValueError:
                doc = False
            targets.append({'id': item_id, 'url': url, 'documentation': doc})
    return targets


class StaticUIParser(HTMLParser):
    """本文を保持せず、該当するコントロールの限定的な根拠だけを集める。"""
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base = parse.urlsplit(base_url)
        self.stack = []
        self.active = []
        self.features = {name: 'not_observed' for name in FIELDS}
        self.versions = []

    def handle_starttag(self, tag, raw_attrs):
        attrs = dict(raw_attrs)
        if tag not in VOID:
            if len(self.stack) >= 512:
                raise ValueError('HTML nesting is too deep')
            self.stack.append(tag)
        for item in self.active:
            if tag in ('svg', 'img') or (tag == 'i' and 'icon' in (attrs.get('class') or '').lower()):
                item['icon'] = True
        if tag not in ('a', 'button'):
            return
        marker = ' '.join(str(attrs.get(k) or '') for k in
                          ('id', 'class', 'name', 'aria-label', 'title', 'data-theme-toggle'))
        href = attrs.get('href') or ''
        kinds = []
        if THEME.search(marker):
            kinds.append('theme')
        if tag == 'a' and href and not href.startswith('#') and HISTORY.search(marker + ' ' + href):
            try:
                p = parse.urlsplit(parse.urljoin(self.base.geturl(), href))
                if (p.scheme == self.base.scheme and p.netloc == self.base.netloc and
                        p.username is None and p.password is None):
                    kinds.append('history')
            except ValueError:
                pass
        if tag == 'a':
            try:
                p = parse.urlsplit(href)
                if p.scheme == 'https' and p.hostname == 'besteffortnet.github.io' and p.path == '/webui-apps.html':
                    kinds.append('directory')
            except ValueError:
                pass
        if kinds:
            self.active.append({'depth': len(self.stack), 'kinds': kinds, 'icon': False, 'text': ''})

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_data(self, data):
        for item in self.active:
            # 判定に必要な短いコントロール文字列だけを一時保持する。
            item['text'] = (item['text'] + data)[:256]

    def finish(self, item):
        icon = item['icon'] or any(char in GLYPHS for char in item['text'])
        if 'theme' in item['kinds'] and icon:
            self.features['theme_icon'] = 'observed'
        if 'directory' in item['kinds'] and icon:
            self.features['directory_icon'] = 'observed'
        if 'history' in item['kinds']:
            self.features['history_link'] = 'observed'
            for match in VERSION.findall(item['text']):
                if match not in self.versions and len(self.versions) < 5:
                    self.versions.append(match)

    def handle_endtag(self, tag):
        if tag not in self.stack:
            return
        while self.stack:
            closed = self.stack.pop()
            still_active = []
            for item in self.active:
                if item['depth'] > len(self.stack):
                    self.finish(item)
                else:
                    still_active.append(item)
            self.active = still_active
            if closed == tag:
                break

    def close(self):
        super().close()
        for item in self.active:
            self.finish(item)
        self.active.clear()


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def make_opener(ca_file=None):
    context = ssl.create_default_context()
    if ca_file:
        context.load_verify_locations(cafile=str(ca_file))
    return request.build_opener(request.ProxyHandler({}), NoRedirect(),
                                request.HTTPSHandler(context=context))


def fetch_one(target, opener, timeout=4.0, allowed_origins=ALLOWED_ORIGINS):
    result = {'id': target['id'], 'checked_at': datetime.now(timezone.utc).isoformat(),
              'outcome': 'unknown', 'http_status': None, 'static': unknown_features(), 'versions': []}
    if target['documentation']:
        result['outcome'] = 'documentation'
        return result
    if not safe_url(target['url'], allowed_origins):
        result['outcome'] = 'not_allowlisted'
        return result
    req = request.Request(target['url'], method='GET', headers={
        'User-Agent': 'WebUI-Static-Inventory/1.0', 'Accept': 'text/html',
        'Cache-Control': 'no-cache',
    })
    try:
        with opener.open(req, timeout=timeout) as response:
            result['http_status'] = response.status
            if not 200 <= response.status < 300:
                result['outcome'] = 'http_error'
                return result
            if response.headers.get_content_type().lower() not in ('text/html', 'application/xhtml+xml'):
                result['outcome'] = 'not_html'
                return result
            raw_length = response.headers.get('Content-Length')
            if raw_length and raw_length.isdigit() and int(raw_length) > MAX_HTML:
                result['outcome'] = 'too_large'
                return result
            chunks, size, deadline = [], 0, time.monotonic() + timeout
            while True:
                if time.monotonic() > deadline:
                    result['outcome'] = 'timeout'
                    return result
                chunk = response.read1(min(16384, MAX_HTML + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_HTML:
                    result['outcome'] = 'too_large'
                    return result
            text = b''.join(chunks).decode('utf-8')
            parser = StaticUIParser(target['url'])
            parser.feed(text)
            parser.close()
            result.update(outcome='html', static=parser.features, versions=parser.versions)
            return result
    except error.HTTPError as exc:
        result['http_status'] = exc.code
        result['outcome'] = ('redirect' if 300 <= exc.code < 400 else
                             'access_restricted' if exc.code in (401, 403) else 'http_error')
        exc.close()
    except (socket.timeout, TimeoutError):
        result['outcome'] = 'timeout'
    except error.URLError as exc:
        result['outcome'] = ('tls_error' if isinstance(exc.reason, ssl.SSLError) else
                             'timeout' if isinstance(exc.reason, (socket.timeout, TimeoutError)) else
                             'connection_error')
    except ssl.SSLError:
        result['outcome'] = 'tls_error'
    except UnicodeError:
        result['outcome'] = 'invalid_text'
    except (OSError, http.client.HTTPException, ValueError):
        result['outcome'] = 'read_error'
    return result


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--ca-file', type=Path, help='既存の公開CAを通常の信頼ストアに追加')
    cli.add_argument('--id', action='append', default=[], help='対象の観測ID。複数指定可')
    cli.add_argument('--timeout', type=float, default=4.0, help='接続と読取の目安秒数（0.1〜10）')
    args = cli.parse_args(argv)
    if not math.isfinite(args.timeout) or not 0.1 <= args.timeout <= 10:
        cli.error('timeout must be between 0.1 and 10 seconds')
    try:
        with (ROOT / 'webui-apps.html').open('rb') as stream:
            data = stream.read(MAX_HTML + 1)
        if len(data) > MAX_HTML:
            raise ValueError('directory is too large')
        targets = inventory_targets(data.decode('utf-8'))
        wanted = set(args.id)
        if wanted - {target['id'] for target in targets}:
            raise ValueError('unknown observation id')
        if wanted:
            targets = [target for target in targets if target['id'] in wanted]
        opener = make_opener(args.ca_file)
        result = [fetch_one(target, opener, args.timeout) for target in targets]
    except (OSError, ValueError, UnicodeError):
        print(json.dumps({'ok': False, 'error': 'input or CA could not be validated'}))
        return 2
    summary = {'outcomes': dict(Counter(item['outcome'] for item in result)),
               'static': {name: dict(Counter(item['static'][name] for item in result))
                          for name in FIELDS}}
    print(json.dumps({'ok': True, 'scope': 'static_html_only', 'summary': summary, 'results': result},
                     ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
