"""一覧と状態画面の対応・観測JSONの差を検査する。"""
from pathlib import Path
import json
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from audit_observation_mapping import DirectoryParser, audit_directory, snapshot_ids, status_id

BUTTON = '<button id="observation-times" data-endpoint="https://192.168.68.221:8013/api/public-observation-times"></button>'


def card(repo='repo-a', ids=('comic',), links=None):
    if links is None:
        links = ids
    statuses = ''.join(
        '<a class="status-link" aria-label="状態を見る" '
        'href="https://192.168.68.221:8013/service-status.html?app=' + value + '"></a>'
        for value in links
    )
    observations = ''.join('<span data-observation-id="' + value + '"></span>' for value in ids)
    return ('<tr class="app-card"><td><a class="service-link" href="https://example.invalid/">app</a>'
            + statuses + observations + '</td><td><a class="repo-link" href="' + repo
            + '">repo</a></td></tr>')


def snapshot(*ids):
    return [{'id': value, 'collected_at': '2020-01-01T00:00:00+09:00'} for value in ids]


class ObservationMappingTests(unittest.TestCase):
    def test_real_directory_maps_both_comic_endpoints_individually(self):
        html = (ROOT / 'webui-apps.html').read_text(encoding='utf-8')
        result = audit_directory(html)
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['linked_observations'], 22)
        self.assertCountEqual(
            [card['repository'] for card in result['cards_without_observation']],
            ['https://github.com/besteffortnet/lan-direct-transfer',
             'https://github.com/besteffortnet/irodori-playground'],
        )
        parser = DirectoryParser()
        parser.feed(html)
        rows = [row for row in parser.cards if any('comic-reader' in repo for repo in row['repos'])]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row['services'], ['http://192.168.68.221:8012/', 'https://192.168.68.221:8019/'])
        self.assertEqual(row['observations'], ['comic', 'comic-https'])
        self.assertEqual([status_id(link['href']) for link in row['statuses']], row['observations'])
        self.assertIn('8012', row['statuses'][0]['label'])
        self.assertIn('8019', row['statuses'][1]['label'])
        music = [row for row in parser.cards if any('music-shelf' in repo for repo in row['repos'])]
        self.assertEqual(len(music), 1)
        self.assertEqual(music[0]['observations'], ['music-shelf'])
        self.assertEqual([status_id(link['href']) for link in music[0]['statuses']], ['music-shelf'])

    def test_missing_and_extra_snapshot_ids_are_not_reported_as_stopped(self):
        result = audit_directory(BUTTON + card(), snapshot('comic-https'))
        self.assertTrue(result['ok'])
        self.assertEqual(result['linked_but_not_in_snapshot'], ['comic'])
        self.assertEqual(result['in_snapshot_but_not_linked'], ['comic-https'])
        self.assertNotIn('stopped', str(result))

    def test_mismatched_missing_and_duplicate_ids_are_rejected(self):
        self.assertFalse(audit_directory(BUTTON + card(ids=('comic',), links=('comic-https',)))['ok'])
        self.assertFalse(audit_directory(BUTTON + card(ids=('comic',), links=()))['ok'])
        self.assertFalse(audit_directory(BUTTON + card(repo='one') + card(repo='two'))['ok'])
        self.assertFalse(audit_directory(BUTTON + card(repo='same') + card(repo='same', ids=('other',)))['ok'])
        self.assertFalse(audit_directory(BUTTON + card() + '<span data-observation-id="stray"></span>')['ok'])
        self.assertFalse(audit_directory(card())['ok'])

    def test_status_url_requires_expected_origin_path_and_single_id(self):
        good = 'https://192.168.68.221:8013/service-status.html?app=comic-https'
        self.assertEqual(status_id(good), 'comic-https')
        for bad in [good.replace('https://', 'http://'), good.replace('8013', '8014'),
                    good + '&app=other', good + '#fragment', good + '&next=elsewhere',
                    good.replace('comic-https', 'bad%0Avalue'), good.replace('/service-status.html', '/other')]:
            with self.subTest(url=bad):
                self.assertIsNone(status_id(bad))
        self.assertIsNone(status_id(None))

    def test_missing_attribute_values_report_failure_without_exception(self):
        malformed = card().replace('aria-label="状態を見る"', 'aria-label')
        self.assertFalse(audit_directory(BUTTON + malformed)['ok'])

    def test_description_literals_are_review_candidates_not_errors(self):
        desc = '<td><div class="desc-text" hidden>非表示の文章 <span>v1.2.3</span>、17サイト。</div></td>'
        html = BUTTON + card().replace('</tr>', desc + '</tr>')
        result = audit_directory(html)
        self.assertTrue(result['ok'])
        self.assertEqual(result['description_review_candidates'], [
            {'card': 1, 'repository': 'repo-a', 'versions': ['v1.2.3'],
             'site_counts': ['17サイト'], 'truncated': False},
        ])
        self.assertNotIn('非表示の文章', str(result))

    def test_many_description_candidates_are_bounded_and_marked(self):
        versions = ' '.join('v1.2.' + str(n) for n in range(25))
        desc = '<td><div class="desc-text">' + versions + '</div></td>'
        result = audit_directory(BUTTON + card().replace('</tr>', desc + '</tr>'))
        self.assertEqual(len(result['description_review_candidates'][0]['versions']), 20)
        self.assertTrue(result['description_review_candidates'][0]['truncated'])

    def test_description_scan_ignores_other_text_and_rejects_unclosed_description(self):
        outside = card().replace('>app</a>', '>v9.9</a>')
        self.assertEqual(audit_directory(BUTTON + outside)['description_review_candidates'], [])
        broken = card().replace('</tr>', '<td><div class="desc-text">v1.2</tr>')
        self.assertIn('unclosed app description', audit_directory(BUTTON + broken)['errors'])

    def test_common_app_description_has_no_fixed_version_or_site_count(self):
        html = (ROOT / 'webui-apps.html').read_text(encoding='utf-8')
        candidates = audit_directory(html)['description_review_candidates']
        self.assertFalse(any('/agent-ops/tree/' in (item['repository'] or '') for item in candidates))

    def test_snapshot_rejects_duplicates_wrong_shape_and_mixed_times(self):
        for bad in [snapshot('comic', 'comic'), [{'id': 'comic'}],
                    [{'id': 'bad id', 'collected_at': '2020-01-01T00:00:00+09:00'}],
                    [{'id': 'comic', 'collected_at': '2020-01-01T00:00:00'}],
                    [{'id': 'comic', 'collected_at': '2020-01-01 00:00:00+09:00'}],
                    [{'id': 'comic', 'collected_at': '2999-01-01T00:00:00Z'}],
                    snapshot('comic') + [{'id': 'other', 'collected_at': '2020-01-01T01:00:00+09:00'}]]:
            with self.subTest(snapshot=bad):
                with self.assertRaises(ValueError):
                    snapshot_ids(bad)

    def test_unlinked_documentation_is_reported_without_guessing_service_state(self):
        result = audit_directory(BUTTON + card(ids=(), links=()))
        self.assertTrue(result['ok'])
        self.assertEqual(result['cards_without_observation'], [{'card': 1, 'repository': 'repo-a'}])
        self.assertEqual(result['linked_observations'], 0)

    def test_cli_reports_coverage_and_rejects_bad_input_without_echo(self):
        command = [sys.executable, str(ROOT / 'tools/audit_observation_mapping.py'), '--observation-json', '-']
        valid = subprocess.run(command, input=json.dumps(snapshot('comic')).encode(), capture_output=True, check=False)
        self.assertEqual(valid.returncode, 0)
        report = json.loads(valid.stdout)
        self.assertEqual(report['snapshot_observations'], 1)
        self.assertIn('comic-https', report['linked_but_not_in_snapshot'])

        for invalid in (b'null', b'{"private-value":', b'x' * (1024 * 1024 + 1)):
            with self.subTest(size=len(invalid)):
                result = subprocess.run(command, input=invalid, capture_output=True, check=False)
                self.assertEqual(result.returncode, 2)
                self.assertNotIn(b'private-value', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
