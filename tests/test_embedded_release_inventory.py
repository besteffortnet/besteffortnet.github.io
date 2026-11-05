import copy
import json
from pathlib import Path
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import embedded_release_inventory as embedded
import static_ui_inventory as inventory


def sample():
    return {'schema':1,'current':'UI 2026.11.05.1','note':'PRIVATE-NOTE', 'releases':[
        {'version':'UI 2026.11.05.1','date':'2026-11-05 18:56 JST','author':'Codex',
         'changes':['PRIVATE-CHANGE'], 'rollback':{'steps':['PRIVATE-PATH'], 'command':'PRIVATE-COMMAND'}},
        {'version':'UI 2026.10.28.2','date':'2026-10-28','changes':['別の変更'],
         'rollback':{'steps':['以前の記録']}},
    ]}


def document(value):
    return '<html><head><script type="application/json" id="webui-release-data">' + json.dumps(value) + '</script></head></html>'


class EmbeddedMetadataTests(unittest.TestCase):
    def test_counts_without_exposing_content(self):
        result = embedded.inspect_html(document(sample()))
        self.assertEqual(result, {'status':'validated','current':'UI 2026.11.05.1','release_count':2,
            'descending':True,'current_first':True,'author_recorded_count':1,'minute_recorded_count':1,
            'change_description_count':2,'restore_description_count':2,'restore_command_count':1,
            'scope':'embedded_metadata_only'})
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_order_and_current_are_separate_facts(self):
        value = sample();value['releases'].reverse()
        result = embedded.inspect_html(document(value))
        self.assertEqual(result['status'], 'validated')
        self.assertFalse(result['descending'])
        self.assertFalse(result['current_first'])

    def test_invalid_time_and_blank_descriptions_do_not_count_as_recorded(self):
        value = sample()
        value['releases'][0]['date'] = '2026-11-05 29:99 JST'
        value['releases'][0]['changes'] = [' ']
        value['releases'][0]['rollback']['steps'] = [' ']
        result = embedded.inspect_html(document(value))
        self.assertEqual(result['status'], 'validated')
        self.assertEqual(result['minute_recorded_count'], 0)
        self.assertEqual(result['change_description_count'], 1)
        self.assertEqual(result['restore_description_count'], 1)

    def test_exact_target_only(self):
        base = {'id':'photo','url':'https://192.168.68.221:8011/','documentation':False}
        self.assertTrue(embedded.eligible(base))
        for change in ({'id':'other'}, {'url':base['url']+'?x=1'}, {'url':base['url']+'#x'},
                       {'url':'https://192.168.68.221.evil.invalid:8011/'}, {'documentation':True}):
            self.assertFalse(embedded.eligible({**base,**change}))

    def test_missing_ambiguous_and_external_scripts_are_not_accepted(self):
        good = document(sample())
        self.assertEqual(embedded.inspect_html('<html/>')['status'], 'missing')
        for html in (good + good, good.replace('application/json','text/javascript'),
                     good.replace('id="webui-release-data"','id="webui-release-data" src="/secret"'),
                     good.replace('</script>',''),
                     good.replace('id="webui-release-data"','id="webui-release-data" id="webui-release-data"')):
            self.assertEqual(embedded.inspect_html(html)['status'],'invalid')

    def test_invalid_json_and_schema_fail_without_echoing_input(self):
        value = sample()
        cases = []
        for mutation in ('duplicate-version','bad-version','bad-date','bad-steps','bad-schema','too-many'):
            v = copy.deepcopy(value)
            if mutation == 'duplicate-version': v['releases'][1]['version'] = v['releases'][0]['version']
            if mutation == 'bad-version': v['current'] = 'PRIVATE-NOTE'
            if mutation == 'bad-date': v['releases'][0]['version'] = 'UI 2026.13.40.1'
            if mutation == 'bad-steps': v['releases'][0]['rollback']['steps'] = 'PRIVATE-NOTE'
            if mutation == 'bad-schema': v['schema'] = True
            if mutation == 'too-many': v['releases'] *= 51
            cases.append(document(v))
        cases.extend([document(value).replace('"schema": 1','"schema": 1, "schema": 1'),
                      document(value).replace('"schema": 1','"schema": NaN'),
                      '<script type="application/json" id="webui-release-data">PRIVATE-NOTE</script>'])
        for html in cases:
            with self.subTest(case=cases.index(html)):
                result = embedded.inspect_html(html)
                self.assertEqual(result['status'], 'invalid')
                self.assertNotIn('PRIVATE', json.dumps(result))

    def test_oversize_embedded_data_is_rejected(self):
        value=sample();value['note']='x'*(embedded.MAX_EMBEDDED_BYTES+1)
        self.assertEqual(embedded.inspect_html(document(value))['status'],'invalid')


class Fixture(BaseHTTPRequestHandler):
    requests = []
    def log_message(self, *args):
        pass
    def do_GET(self):
        self.requests.append((self.path,self.headers.get('Cookie')))
        data=document(sample()).encode()
        self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8')
        self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)


class EmbeddedIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server=ThreadingHTTPServer(('127.0.0.1',0),Fixture)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True);cls.thread.start()
        cls.url=f'http://127.0.0.1:{cls.server.server_port}/'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def test_single_get_and_no_claim_that_dynamic_link_is_visible(self):
        Fixture.requests.clear()
        target={'id':'photo','url':self.url,'documentation':False}
        allowed={('http','127.0.0.1',self.server.server_port)}
        with patch.object(embedded,'PHOTO_TARGET',('photo',self.url)):
            result=inventory.fetch_one(target,inventory.make_opener(),timeout=2,
                                       allowed_origins=allowed,check_history=True)
        self.assertEqual(Fixture.requests,[('/',None)])
        self.assertEqual(result['static']['history_link'],'not_observed')
        self.assertEqual(result['history_probe']['mode'],'embedded_metadata')
        self.assertEqual(result['history_probe']['links'],[])
        self.assertEqual(result['history_probe']['embedded_metadata']['release_count'],2)
        self.assertNotIn('PRIVATE',json.dumps(result))

    def test_history_disabled_or_wrong_id_does_not_read_embedded_metadata(self):
        allowed={('http','127.0.0.1',self.server.server_port)}
        with patch.object(embedded,'PHOTO_TARGET',('photo',self.url)):
            target={'id':'photo','url':self.url,'documentation':False}
            result=inventory.fetch_one(target,inventory.make_opener(),timeout=2,allowed_origins=allowed)
            self.assertNotIn('history_probe',result)
            result=inventory.fetch_one({**target,'id':'other'},inventory.make_opener(),timeout=2,
                                       allowed_origins=allowed,check_history=True)
            self.assertEqual(result['history_probe']['mode'],'not_configured')
            self.assertNotIn('embedded_metadata',result['history_probe'])


if __name__=='__main__':
    unittest.main()
