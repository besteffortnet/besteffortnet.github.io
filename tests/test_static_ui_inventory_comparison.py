import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import compare_static_ui_inventory as comparison


def entry(item_id='app', minute=1, binding='a' * 64, outcome='html', http=200):
    return {'id': item_id, 'checked_at': f'2026-11-04T05:{minute:02}:00+00:00',
            'binding_sha256': binding, 'outcome': outcome, 'http_status': http,
            'static': {name: ('observed' if outcome == 'html' else 'unknown')
                       for name in comparison.FIELDS},
            'versions': ['v1.2.3'] if outcome == 'html' else []}


def report(*items, schema=2):
    result = {'ok': True, 'scope': 'static_html_only', 'results': list(items)}
    if schema is not None:
        result['schema'] = schema
    return result


class InventoryComparisonTest(unittest.TestCase):
    def compare(self, old, new):
        return comparison.compare(comparison.validate_report(old), comparison.validate_report(new))

    def test_reports_static_and_version_changes_as_candidates(self):
        previous, current = entry(), entry(minute=2)
        current['static']['theme_icon'] = 'not_observed'
        current['versions'] = ['v1.2.4']
        result = self.compare(report(previous), report(current))
        row = result['results'][0]
        self.assertEqual(row['status'], 'compared')
        self.assertEqual(row['static_changes'], [{'field': 'theme_icon', 'previous': 'observed',
                                                   'current': 'not_observed'}])
        self.assertEqual(row['version_change'], {'previous': ['v1.2.3'], 'current': ['v1.2.4']})
        self.assertEqual(result['summary']['static_changes'], 1)
        self.assertEqual(result['summary']['version_changes'], 1)

    def test_failed_collection_is_not_feature_loss(self):
        current = entry(minute=2, outcome='access_restricted', http=401)
        result = self.compare(report(entry()), report(current))
        row = result['results'][0]
        self.assertEqual(row['status'], 'not_both_html')
        self.assertEqual(row['static_changes'], [])
        self.assertIsNone(row['version_change'])
        self.assertEqual(row['outcome_change'], {'previous': 'html', 'current': 'access_restricted'})
        self.assertEqual(row['http_status_change'], {'previous': 200, 'current': 401})

    def test_changed_or_unknown_target_is_not_compared(self):
        for current, expected in ((entry(minute=2, binding='b' * 64), 'target_changed'),
                                  (entry(minute=2, binding=None), 'identity_unknown')):
            with self.subTest(expected=expected):
                current['static']['theme_icon'] = 'not_observed'
                row = self.compare(report(entry()), report(current))['results'][0]
                self.assertEqual(row['status'], expected)
                self.assertEqual(row['static_changes'], [])
                self.assertIsNone(row['outcome_change'])

    def test_old_schema_without_binding_is_identity_unknown(self):
        old = entry()
        del old['binding_sha256']
        row = self.compare(report(old, schema=None), report(entry(minute=2)))['results'][0]
        self.assertEqual(row['status'], 'identity_unknown')

    def test_documentation_is_not_a_runtime_comparison(self):
        old = entry(item_id='reference-1', binding=None, outcome='documentation', http=None)
        new = entry(item_id='reference-1', minute=2, binding=None, outcome='documentation', http=None)
        row = self.compare(report(old), report(new))['results'][0]
        self.assertEqual(row['status'], 'documentation')
        self.assertEqual(row['static_changes'], [])

    def test_same_or_reversed_times_do_not_establish_change(self):
        for minute in (1, 0):
            with self.subTest(minute=minute):
                current = entry(minute=minute)
                current['static']['history_link'] = 'not_observed'
                row = self.compare(report(entry()), report(current))['results'][0]
                self.assertEqual(row['status'], 'non_increasing_time')
                self.assertEqual(row['static_changes'], [])

    def test_partial_report_is_not_reported_as_addition_or_deletion(self):
        old = report(entry('first'), entry('omitted'))
        new = report(entry('first', minute=2), entry('other', minute=2))
        result = self.compare(old, new)
        rows = {row['id']: row for row in result['results']}
        self.assertEqual(rows['first']['status'], 'compared')
        self.assertEqual(rows['omitted']['status'], 'only_in_previous_report')
        self.assertEqual(rows['other']['status'], 'only_in_current_report')

    def test_http_codes_can_change_without_assuming_cause(self):
        old = entry(outcome='http_error', http=500)
        new = entry(minute=2, outcome='http_error', http=404)
        row = self.compare(report(old), report(new))['results'][0]
        self.assertEqual(row['status'], 'not_both_html')
        self.assertIsNone(row['outcome_change'])
        self.assertEqual(row['http_status_change'], {'previous': 500, 'current': 404})

    def test_legacy_access_label_is_normalized(self):
        old = entry(outcome='authentication', http=401)
        new = entry(minute=2, outcome='access_restricted', http=401)
        row = self.compare(report(old, schema=None), report(new))['results'][0]
        self.assertEqual(row['status'], 'not_both_html')
        self.assertIsNone(row['outcome_change'])

    def test_rejects_duplicate_ids_invalid_fields_and_inconsistent_state(self):
        original = entry()
        bad = []
        duplicate = report(original, copy.deepcopy(original))
        bad.append(duplicate)
        for key, value in [('id', 'bad id'), ('outcome', {}), ('checked_at', 'no-time'),
                           ('binding_sha256', 'short'), ('http_status', True),
                           ('static', {'history_link': [], 'theme_icon': 'observed',
                                       'directory_icon': 'observed'}),
                           ('versions', ['private content']), ('versions', ['v1.2', 'v1.2'])]:
            item = copy.deepcopy(original)
            item[key] = value
            bad.append(report(item))
        item = entry(outcome='access_restricted', http=401)
        item['static']['theme_icon'] = 'observed'
        bad.append(report(item))
        bad.append(report(original, schema=2.0))
        for value in bad:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    comparison.validate_report(value)

    def test_json_reader_rejects_duplicate_keys_nan_and_oversize(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'input.json'
            for raw in (b'{"ok":true,"ok":false}', b'{"number":NaN}',
                        b'x' * (comparison.MAX_REPORT + 1)):
                p.write_bytes(raw)
                with self.subTest(size=len(raw)):
                    with self.assertRaises(ValueError):
                        comparison.read_report(p)

    def test_cli_failure_does_not_echo_content(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'input.json'
            p.write_text('{"private":"EXAMPLE-PRIVATE-CONTENT"}', encoding='utf-8')
            script = Path(__file__).resolve().parents[1] / 'tools/compare_static_ui_inventory.py'
            proc = subprocess.run([sys.executable, '-B', str(script), str(p), str(p)],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(json.loads(proc.stdout)['ok'], False)
            self.assertNotIn('EXAMPLE-PRIVATE-CONTENT', proc.stdout + proc.stderr)

    def test_compare_does_not_open_network(self):
        with patch('urllib.request.build_opener', side_effect=AssertionError('no network')):
            result = self.compare(report(entry()), report(entry(minute=2)))
        self.assertEqual(result['results'][0]['status'], 'compared')
        self.assertEqual(result['summary']['static_changes'], 0)

    def test_optional_history_probe_metadata_is_not_compared(self):
        old, new = entry(), entry(minute=2)
        new['history_probe'] = {'mode': 'checked', 'links': [{'outcome': 'redirect'}]}
        result = self.compare(report(old), report(new))
        self.assertEqual(result['results'][0]['status'], 'compared')
        self.assertEqual(result['summary']['static_changes'], 0)


if __name__ == '__main__':
    unittest.main()
