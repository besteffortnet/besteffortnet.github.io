from html.parser import HTMLParser
from pathlib import Path
import unittest


class DirectoryParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.rows = []
        self.row = None
        self.text = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "tr":
            self.row = {"links": [], "observation_ids": [], "text": []}
        if self.row is not None:
            if tag == "a":
                self.row["links"].append(attrs)
            if "data-observation-id" in attrs:
                self.row["observation_ids"].append(attrs["data-observation-id"])

    def handle_data(self, data):
        if self.row is not None:
            self.row["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None


class VrServiceScopeTests(unittest.TestCase):
    def test_vr_link_explicitly_limits_status_to_the_service(self):
        parser = DirectoryParser()
        parser.feed((Path(__file__).resolve().parents[1] / "webui-apps.html").read_text())
        rows = [r for r in parser.rows if any("8006/" in a.get("href", "") for a in r["links"])]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        links = [a for a in row["links"] if "status-link" in a.get("class", "").split()]
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0]["href"], "https://192.168.68.221:8013/service-status.html?app=vr")
        self.assertIn("サービス全体", "".join(row["text"]))
        self.assertIn("表示条件は未評価", "".join(row["text"]))
        self.assertEqual(row["observation_ids"], ["vr"])
        ids = [item for r in parser.rows for item in r["observation_ids"]]
        self.assertEqual(len(ids), 20)
        self.assertEqual(len(set(ids)), 20)


if __name__ == "__main__":
    unittest.main()
