"""登録済み写真アプリの埋込み版メタデータだけを、内容を出さずに点検する。"""
from datetime import date
from html.parser import HTMLParser
import json
import re

PHOTO_TARGET = ('photo', 'https://192.168.68.221:8011/')
MAX_EMBEDDED_BYTES = 128 * 1024
MAX_RELEASES = 100
VERSION = re.compile(r'UI ([0-9]{4})\.([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{1,3})\Z')
MINUTE = re.compile(r'(?<![0-9])(?:[01][0-9]|2[0-3]):[0-5][0-9](?![0-9])')


def eligible(target):
    """同じIDを別URLに付け替えても、埋込み情報は読まない。"""
    return (target.get('id'), target.get('url')) == PHOTO_TARGET and not target.get('documentation')


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def bad_constant(_value):
    raise ValueError('invalid constant')


def version_key(value):
    if not isinstance(value, str) or len(value) > 40:
        raise ValueError('invalid version')
    match = VERSION.fullmatch(value)
    if not match:
        raise ValueError('invalid version')
    year, month, day, number = map(int, match.groups())
    date(year, month, day)
    return year, month, day, number


def inspect_value(value):
    if not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1:
        raise ValueError('invalid schema')
    current = value.get('current')
    version_key(current)
    releases = value.get('releases')
    if not isinstance(releases, list) or not 1 <= len(releases) <= MAX_RELEASES:
        raise ValueError('invalid releases')
    keys, author_count, minute_count, change_count, restore_count, command_count = [], 0, 0, 0, 0, 0
    for item in releases:
        if not isinstance(item, dict):
            raise ValueError('invalid release')
        keys.append(version_key(item.get('version')))
        date_text, author = item.get('date'), item.get('author')
        if not isinstance(date_text, str) or not 1 <= len(date_text) <= 160:
            raise ValueError('invalid date')
        if author is not None and (not isinstance(author, str) or len(author) > 120):
            raise ValueError('invalid author')
        minute_count += bool(MINUTE.search(date_text))
        author_count += bool(author and author.strip() and author.strip() != '未記録')
        changes = item.get('changes')
        if not isinstance(changes, list) or len(changes) > 100 or any(not isinstance(x, str) or len(x) > 4000 for x in changes):
            raise ValueError('invalid changes')
        change_count += any(change.strip() for change in changes)
        rollback = item.get('rollback')
        if not isinstance(rollback, dict):
            raise ValueError('invalid rollback')
        steps, command = rollback.get('steps', []), rollback.get('command')
        if (not isinstance(steps, list) or len(steps) > 100 or
                any(not isinstance(x, str) or len(x) > 4000 for x in steps) or
                (command is not None and (not isinstance(command, str) or len(command) > 8000))):
            raise ValueError('invalid restore description')
        restore_count += any(step.strip() for step in steps)
        command_count += bool(command and command.strip())
    if len(set(keys)) != len(keys):
        raise ValueError('duplicate versions')
    return {
        'status': 'validated', 'current': current, 'release_count': len(releases),
        'descending': keys == sorted(keys, reverse=True), 'current_first': version_key(current) == keys[0],
        'author_recorded_count': author_count, 'minute_recorded_count': minute_count,
        'change_description_count': change_count, 'restore_description_count': restore_count,
        'restore_command_count': command_count, 'scope': 'embedded_metadata_only',
    }


class EmbeddedParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.seen = 0
        self.capturing = False
        self.invalid = False
        self.size = 0
        self.parts = []

    def handle_starttag(self, tag, raw_attrs):
        if tag != 'script':
            return
        ids = [value for key, value in raw_attrs if key == 'id']
        if 'webui-release-data' not in ids:
            return
        self.seen += 1
        types = [value for key, value in raw_attrs if key == 'type']
        if len(ids) != 1 or len(types) != 1 or types[0] != 'application/json' or any(key == 'src' for key, _ in raw_attrs):
            self.invalid = True
            return
        self.capturing = True

    def handle_data(self, text):
        if not self.capturing:
            return
        self.size += len(text.encode('utf-8'))
        if self.size > MAX_EMBEDDED_BYTES:
            self.invalid = True
            return
        self.parts.append(text)

    def handle_endtag(self, tag):
        if tag == 'script':
            self.capturing = False


def inspect_html(html):
    """本文や個々の履歴・復元コマンドを結果へ含めない。"""
    parser = EmbeddedParser()
    try:
        parser.feed(html)
        parser.close()
        if parser.seen == 0:
            return {'status': 'missing', 'scope': 'embedded_metadata_only'}
        if parser.seen != 1 or parser.invalid or parser.capturing:
            raise ValueError('invalid embedded data')
        data = json.loads(''.join(parser.parts), object_pairs_hook=unique_object, parse_constant=bad_constant)
        return inspect_value(data)
    except (ValueError, TypeError, RecursionError, UnicodeError):
        return {'status': 'invalid', 'scope': 'embedded_metadata_only'}
