#!/usr/bin/env python3
"""一覧の状態リンクと観測IDの対応を、通信せずに検査する。"""
import argparse
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parents[1]
ID_PATTERN = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
TIME_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$')
OBSERVATION_URL = 'https://192.168.68.221:8013/api/public-observation-times'
STATUS_ORIGIN = '192.168.68.221:8013'
MAX_INPUT_BYTES = 1024 * 1024
UNSUPPLIED = object()


class DirectoryParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.cards = []
        self.card = None
        self.buttons = []
        self.outside_observations = 0

    def handle_starttag(self, tag, raw_attrs):
        attrs = dict(raw_attrs)
        classes = (attrs.get('class') or '').split()
        if tag == 'tr' and 'app-card' in classes:
            if self.card is not None:
                raise ValueError('nested app card')
            self.card = {'services': [], 'repos': [], 'statuses': [], 'observations': []}
        if tag == 'button' and attrs.get('id') == 'observation-times':
            self.buttons.append(attrs)
        if 'data-observation-id' in attrs:
            if self.card is None:
                self.outside_observations += 1
            else:
                self.card['observations'].append(attrs['data-observation-id'])
        if self.card is None or tag != 'a':
            return
        if 'service-link' in classes or 'alternate-service-link' in classes:
            self.card['services'].append(attrs.get('href') or '')
        if 'repo-link' in classes:
            self.card['repos'].append(attrs.get('href') or '')
        if 'status-link' in classes:
            self.card['statuses'].append({'href': attrs.get('href') or '',
                                          'label': attrs.get('aria-label') or ''})

    def handle_endtag(self, tag):
        if tag == 'tr' and self.card is not None:
            self.cards.append(self.card)
            self.card = None


def status_id(href):
    if not isinstance(href, str):
        return None
    try:
        parsed = urlsplit(href)
        if (parsed.scheme != 'https' or parsed.netloc != STATUS_ORIGIN or
                parsed.path != '/service-status.html' or parsed.fragment):
            return None
        args = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
        if len(args) != 1 or args[0][0] != 'app' or not ID_PATTERN.fullmatch(args[0][1]):
            return None
        return args[0][1]
    except ValueError:
        return None


def snapshot_ids(snapshot):
    if not isinstance(snapshot, list) or len(snapshot) > 100:
        raise ValueError('invalid observation snapshot')
    found = set()
    timestamps = set()
    for item in snapshot:
        if not isinstance(item, dict) or set(item) != {'id', 'collected_at'}:
            raise ValueError('invalid observation entry')
        item_id, timestamp = item['id'], item['collected_at']
        if (not isinstance(item_id, str) or not ID_PATTERN.fullmatch(item_id) or
                item_id in found or not isinstance(timestamp, str) or not TIME_PATTERN.fullmatch(timestamp)):
            raise ValueError('invalid observation entry')
        try:
            parsed = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        except ValueError as exc:
            raise ValueError('invalid observation time') from exc
        if parsed.tzinfo is None:
            raise ValueError('observation time has no timezone')
        if parsed > datetime.now(timezone.utc):
            raise ValueError('observation time is in the future')
        found.add(item_id)
        timestamps.add(timestamp)
    if len(timestamps) > 1:
        raise ValueError('observation times are from different collections')
    return found


def audit_directory(html, snapshot=UNSUPPLIED):
    parser = DirectoryParser()
    parser.feed(html)
    parser.close()
    errors = []
    if parser.card is not None:
        errors.append('unclosed app card')
    if not parser.cards:
        errors.append('no app cards')
    if len(parser.buttons) != 1 or parser.buttons[0].get('data-endpoint') != OBSERVATION_URL:
        errors.append('observation endpoint is missing or differs')
    if parser.outside_observations:
        errors.append('observation marker is outside an app card')
    ids, repos, unlinked = [], set(), []
    for index, card in enumerate(parser.cards, 1):
        prefix = 'card ' + str(index) + ': '
        repo = None
        if not card['services']:
            errors.append(prefix + 'service link is missing')
        if len(card['repos']) != 1 or not card['repos'][0]:
            errors.append(prefix + 'exactly one repository link is required')
        else:
            repo = card['repos'][0]
            if repo in repos:
                errors.append(prefix + 'duplicate repository link')
            repos.add(repo)
        linked = []
        for link in card['statuses']:
            value = status_id(link['href'])
            if value is None or not link['label'].strip():
                errors.append(prefix + 'invalid status link or accessible label')
            linked.append(value)
        observations = card['observations']
        if any(not isinstance(value, str) or not ID_PATTERN.fullmatch(value) for value in observations):
            errors.append(prefix + 'invalid observation id')
        if linked != observations:
            errors.append(prefix + 'status links and observation ids differ')
        if not linked and not observations:
            unlinked.append({'card': index, 'repository': repo})
        ids.extend(value for value in observations if isinstance(value, str) and ID_PATTERN.fullmatch(value))
    if len(ids) != len(set(ids)):
        errors.append('duplicate observation id')
    if len(ids) > 100:
        errors.append('too many observation ids')
    report = {'ok': not errors, 'cards': len(parser.cards), 'linked_observations': len(ids),
              'cards_without_observation': unlinked, 'errors': errors}
    if snapshot is not UNSUPPLIED:
        available = snapshot_ids(snapshot)
        report['snapshot_observations'] = len(available)
        report['linked_but_not_in_snapshot'] = sorted(set(ids) - available)
        report['in_snapshot_but_not_linked'] = sorted(available - set(ids))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--html', type=Path, default=ROOT / 'webui-apps.html')
    parser.add_argument('--observation-json', metavar='PATH',
                        help='観測JSONのローカルファイル。- は標準入力。通信は行わない。')
    args = parser.parse_args()
    try:
        with args.html.open('rb') as stream:
            html_bytes = stream.read(MAX_INPUT_BYTES + 1)
        if len(html_bytes) > MAX_INPUT_BYTES:
            raise ValueError('HTML input is too large')
        snapshot = UNSUPPLIED
        if args.observation_json:
            if args.observation_json == '-':
                raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            else:
                with Path(args.observation_json).open('rb') as stream:
                    raw = stream.read(MAX_INPUT_BYTES + 1)
            if len(raw) > MAX_INPUT_BYTES:
                raise ValueError('observation input is too large')
            snapshot = json.loads(raw)
        result = audit_directory(html_bytes.decode('utf-8'), snapshot)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
        print(json.dumps({'ok': False, 'errors': ['input could not be validated']}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
