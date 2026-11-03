"""一覧のポート表示が各リンクの接続先とずれないことを確認する。"""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
import unittest


class ServiceCards(HTMLParser):
    def __init__(self):
        super().__init__()
        self.cards = []
        self.card = None
        self.badge = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = attrs.get('class', '').split()
        if tag == 'a' and 'service-link' in classes:
            self.card = {'urls': [attrs.get('href', '')], 'badges': []}
            self.cards.append(self.card)
        elif tag == 'a' and 'alternate-service-link' in classes:
            if self.card is None:
                raise ValueError('追加のサービスリンクがアプリのセル外にあります')
            self.card['urls'].append(attrs.get('href', ''))
        elif tag == 'span' and 'port-badge' in classes and self.card is not None:
            self.badge = {'text': '', 'label': attrs.get('aria-label', ''), 'classes': classes}
            self.card['badges'].append(self.badge)

    def handle_data(self, value):
        if self.badge is not None:
            self.badge['text'] += value

    def handle_endtag(self, tag):
        if tag == 'span':
            self.badge = None
        elif tag == 'td':
            self.card = None


class PortBadgesTest(unittest.TestCase):
    def test_every_link_has_an_accurate_and_distinguished_port(self):
        parser = ServiceCards()
        parser.feed((Path(__file__).resolve().parents[1] / 'webui-apps.html').read_text(encoding='utf-8'))
        self.assertTrue(parser.cards, '一覧にサービスリンクがありません')
        for index, card in enumerate(parser.cards, 1):
            with self.subTest(card=index):
                self.assertEqual(len(card['badges']), len(card['urls']), '各接続先にバッジが必要です')
                for raw_url, badge in zip(card['urls'], card['badges']):
                    with self.subTest(url=raw_url):
                        url = urlsplit(raw_url)
                        self.assertIn(url.scheme, ('http', 'https'))
                        self.assertTrue(url.hostname)
                        port = url.port or (443 if url.scheme == 'https' else 80)
                        self.assertEqual(badge['text'].split()[-1], str(port))
                        self.assertIn(str(port), badge['label'])
                        if url.port is None:
                            self.assertIn('port-badge-standard', badge['classes'])
                            self.assertIn('標準', badge['label'])
                            self.assertIn(url.scheme.upper(), badge['text'])
                        else:
                            self.assertNotIn('port-badge-standard', badge['classes'])
                            self.assertTrue(badge['text'].startswith('PORT '))


if __name__ == '__main__':
    unittest.main()
