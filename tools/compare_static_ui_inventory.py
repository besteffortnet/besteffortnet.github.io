#!/usr/bin/env python3
"""2回の静的UI点検結果から、比較可能な変化候補だけを集計する。"""
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
from audit_observation_mapping import ID_PATTERN
from static_ui_inventory import FIELDS, VERSION

MAX_REPORT = 1024 * 1024
OUTCOMES = frozenset({'unknown', 'documentation', 'not_allowlisted', 'html', 'http_error',
                      'not_html', 'too_large', 'timeout', 'redirect', 'access_restricted',
                      'connection_error', 'tls_error', 'invalid_text', 'read_error',
                      # 旧版で401/403を表した名称。原因の断定には使わない。
                      'authentication'})
HASH = re.compile(r'^[0-9a-f]{64}$')


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError('non-finite JSON value')


def checked_time(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError('invalid time')
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('timezone is missing')
    return parsed


def validate_report(data):
    if (not isinstance(data, dict) or data.get('ok') is not True or
            data.get('scope') != 'static_html_only'):
        raise ValueError('invalid report')
    schema = data.get('schema')
    if schema is not None and (type(schema) is not int or schema != 2):
        raise ValueError('invalid schema')
    entries = data.get('results')
    if not isinstance(entries, list) or len(entries) > 200:
        raise ValueError('invalid result count')
    found = {}
    for item in entries:
        if not isinstance(item, dict):
            raise ValueError('invalid entry')
        item_id, outcome = item.get('id'), item.get('outcome')
        if (not isinstance(item_id, str) or not ID_PATTERN.fullmatch(item_id) or
                item_id in found or not isinstance(outcome, str) or outcome not in OUTCOMES):
            raise ValueError('invalid id or outcome')
        moment = checked_time(item.get('checked_at'))
        binding = item.get('binding_sha256')
        if binding is not None and (not isinstance(binding, str) or not HASH.fullmatch(binding)):
            raise ValueError('invalid binding')
        http = item.get('http_status')
        if http is not None and (type(http) is not int or not 100 <= http <= 599):
            raise ValueError('invalid HTTP status')
        if outcome == 'html' and (http is None or not 200 <= http < 300):
            raise ValueError('inconsistent HTML status')
        if outcome in ('access_restricted', 'authentication') and http not in (401, 403):
            raise ValueError('inconsistent access status')
        if outcome == 'redirect' and (http is None or not 300 <= http < 400):
            raise ValueError('inconsistent redirect status')
        features, versions = item.get('static'), item.get('versions')
        if not isinstance(features, dict) or set(features) != set(FIELDS):
            raise ValueError('invalid static results')
        expected = {'observed', 'not_observed'} if outcome == 'html' else {'unknown'}
        if any(not isinstance(value, str) or value not in expected for value in features.values()):
            raise ValueError('inconsistent static results')
        if (not isinstance(versions, list) or len(versions) > 5 or
                any(not isinstance(v, str) or not VERSION.fullmatch(v) for v in versions) or
                len(versions) != len(set(versions)) or (outcome != 'html' and versions)):
            raise ValueError('invalid version list')
        found[item_id] = {'time': moment, 'binding': binding, 'outcome': outcome, 'http_status': http,
                          'static': features, 'versions': versions}
    return found


def read_report(path):
    with Path(path).open('rb') as stream:
        raw = stream.read(MAX_REPORT + 1)
    if len(raw) > MAX_REPORT:
        raise ValueError('report is too large')
    data = json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicate_keys,
                      parse_constant=reject_constant)
    return validate_report(data)


def compare(previous, current):
    entries = []
    for item_id in sorted(set(previous) | set(current)):
        old, new = previous.get(item_id), current.get(item_id)
        row = {'id': item_id, 'status': None, 'static_changes': [], 'version_change': None,
               'outcome_change': None, 'http_status_change': None}
        if old is None:
            row['status'] = 'only_in_current_report'
        elif new is None:
            row['status'] = 'only_in_previous_report'
        elif old['outcome'] == 'documentation' and new['outcome'] == 'documentation':
            row['status'] = 'documentation'
        elif old['binding'] is None or new['binding'] is None:
            row['status'] = 'identity_unknown'
        elif old['binding'] != new['binding']:
            row['status'] = 'target_changed'
        elif new['time'] <= old['time']:
            row['status'] = 'non_increasing_time'
        else:
            # 旧版名称と現行名称は同じアクセス制限として扱う。
            old_outcome = 'access_restricted' if old['outcome'] == 'authentication' else old['outcome']
            new_outcome = 'access_restricted' if new['outcome'] == 'authentication' else new['outcome']
            if old_outcome != new_outcome:
                row['outcome_change'] = {'previous': old_outcome, 'current': new_outcome}
            if old['http_status'] != new['http_status']:
                row['http_status_change'] = {'previous': old['http_status'], 'current': new['http_status']}
            if old_outcome != 'html' or new_outcome != 'html':
                row['status'] = 'not_both_html'
            else:
                row['status'] = 'compared'
                for name in FIELDS:
                    if old['static'][name] != new['static'][name]:
                        row['static_changes'].append({'field': name, 'previous': old['static'][name],
                                                      'current': new['static'][name]})
                if old['versions'] != new['versions']:
                    row['version_change'] = {'previous': old['versions'], 'current': new['versions']}
        entries.append(row)
    return {'ok': True, 'scope': 'static_html_comparison',
            'summary': {'statuses': dict(Counter(row['status'] for row in entries)),
                        'static_changes': sum(len(row['static_changes']) for row in entries),
                        'version_changes': sum(row['version_change'] is not None for row in entries),
                        'outcome_changes': sum(row['outcome_change'] is not None for row in entries),
                        'http_status_changes': sum(row['http_status_change'] is not None for row in entries)},
            'results': entries}


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('previous', type=Path)
    cli.add_argument('current', type=Path)
    args = cli.parse_args(argv)
    try:
        result = compare(read_report(args.previous), read_report(args.current))
    except (OSError, ValueError, UnicodeError, RecursionError, OverflowError):
        print(json.dumps({'ok': False, 'error': 'reports could not be validated'}))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
