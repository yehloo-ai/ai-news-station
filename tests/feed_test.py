import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch, Mock
from pathlib import Path

spec = importlib.util.spec_from_file_location('feeds', Path(__file__).parents[1] / 'scripts/generate_feed.py')
feeds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(feeds)

class FeedTests(unittest.TestCase):
    def setUp(self):
        feeds.SOURCE_CACHE = {}
        feeds.SOURCE_HEALTH = {}
        feeds.RUN_CACHE = {}

    def test_invalid_dates_are_not_now(self):
        self.assertIsNone(feeds.parse_date('not-a-date'))
        self.assertIsNone(feeds.parse_date(None))

    def test_sort_uses_timestamps(self):
        values = [{'pubDate':'2026-09-16T08:00:00+08:00'}, {'pubDate':'2026-09-16T01:00:00Z'}]
        self.assertEqual(feeds.sort_items(values)[0], values[1])

    def test_failed_source_preserves_cache(self):
        url = 'https://example.test/feed'
        feeds.SOURCE_CACHE[url] = {'items':[{'title':'Old'}], 'checkedAt':'2026-09-15T00:00:00Z'}
        with patch.object(feeds.requests, 'get', side_effect=TimeoutError):
            self.assertEqual(len(feeds.fetch_rss('Example',url,'#123456')),1)
        self.assertEqual(feeds.SOURCE_HEALTH[url]['status'],'stale')

    def test_empty_html_is_not_success(self):
        response = Mock(content=b'<html>not a feed</html>')
        with patch.object(feeds.requests,'get',return_value=response):
            self.assertEqual(feeds.fetch_rss('Bad','https://example.test/bad','#123456'),[])
        self.assertEqual(feeds.SOURCE_HEALTH['https://example.test/bad']['status'],'unavailable')

    def test_empty_channel_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(feeds,'DATA_DIR',directory):
            path = Path(directory) / 'all.json'
            old = {'updated':'2026-09-15','items':[{'title':'Saved'}]}
            path.write_text(json.dumps(old))
            self.assertEqual(feeds.save_json('all.json',[]),old['items'])
            self.assertEqual(json.loads(path.read_text()),old)

    def test_aihot_nested_items(self):
        response = Mock()
        response.json.return_value={'data':{'items':[{'title':'News','url':'https://example.test/story'}]}}
        with patch.object(feeds.requests,'get',return_value=response):
            self.assertEqual(len(feeds.fetch_aihot()),1)

    def test_general_news_requires_ai_relevance(self):
        items = [{'title':'今日生活资讯','description':'普通新闻','link':'https://example.test/a'},
                 {'title':'OpenAI 任命财务官','description':'公司动态','link':'https://example.test/b'}]
        with patch.object(feeds,'CHINESE_SOURCES',[('Example','https://example.test/rss','#123456')]), patch.object(feeds,'fetch_rss',return_value=items):
            self.assertEqual([item['link'] for item in feeds.gen_chinese_base()],['https://example.test/b'])

    def test_protocol_restriction(self):
        for value in ['javascript:alert(1)','data:text/html,x','https://user:pass@example.test']:
            self.assertEqual(feeds.safe_url(value),'')

if __name__ == '__main__':
    unittest.main()
