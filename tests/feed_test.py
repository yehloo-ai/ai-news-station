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
        feeds.TRANSLATIONS = {}
        feeds.TRANSLATION_UNAVAILABLE = False

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

    def test_translation_covers_title_and_summary_and_preserves_originals(self):
        item = {'title':'New language models', 'description':'Models can now reason.'}
        with patch.object(feeds, 'translate_offline', side_effect=['新语言模型', '模型现在能够进行推理。']):
            self.assertEqual(feeds.translate_items_en([item]), {'translated':2, 'pending':0})
        self.assertEqual(item['titleOriginal'], 'New language models')
        self.assertEqual(item['descriptionOriginal'], 'Models can now reason.')
        self.assertEqual(item['description'], '模型现在能够进行推理。')
        self.assertTrue(item['_translated'] and item['_descTranslated'])

    def test_chinese_with_product_names_is_not_retranslated(self):
        item = {'title':'Tripo 与 GPT-6 Astra 工作流', 'description':'使用 Claude Code 开发。'}
        with patch.object(feeds, 'translate_offline') as translate:
            self.assertEqual(feeds.translate_items_en([item]), {'translated':0, 'pending':0})
            translate.assert_not_called()

    def test_cached_translation_works_without_model(self):
        with patch.object(feeds, 'translate_offline', return_value='新模型') as translate:
            self.assertEqual(feeds.translate_one('New models'), '新模型')
            feeds.TRANSLATION_UNAVAILABLE = True
            self.assertEqual(feeds.translate_one('New models'), '新模型')
            translate.assert_called_once()

    def test_failed_translation_keeps_original_and_marks_pending(self):
        item = {'title':'New language models', 'description':'Models can reason.'}
        with patch.object(feeds, 'translate_offline', side_effect=RuntimeError) as translate:
            feeds.translate_items_en([item])
            translate.assert_called_once()
        self.assertEqual(item['title'], 'New language models')
        self.assertEqual(item['translationPending'], ['title','description'])
        self.assertEqual(feeds.TRANSLATIONS, {})

    def test_translation_failure_recovers_on_next_run(self):
        item = {'title':'New models', 'translationPending':['title']}
        with patch.object(feeds, 'translate_offline', return_value='新模型'):
            feeds.translate_items_en([item])
        self.assertNotIn('translationPending', item)

    def test_error_response_is_not_a_translation(self):
        for result in ['', 'RATE LIMIT', '<html>错误</html>', None, {'text':'中文'}]:
            with patch.object(feeds, 'translate_offline', return_value=result):
                self.assertEqual(feeds.translate_one('New models'), '')
        self.assertEqual(feeds.TRANSLATIONS, {})

    def test_arxiv_metadata_removed_before_translation(self):
        text = 'arXiv:2609.12345v1 Announce Type: new Abstract: Models &amp; agents.'
        self.assertEqual(feeds.translation_text(text), 'Models & agents.')

    def test_ai_terms_and_tokenizer_artifacts(self):
        self.assertEqual(feeds.translation_terms('\u2581大赦国际与多式联运', 'AI and multimodal'), '人工智能与多模态')
        self.assertEqual(feeds.translation_terms('大赦国际', 'Amnesty International'), '大赦国际')
        self.assertFalse(feeds.valid_translation('模型\u2047', 'Models'))

if __name__ == '__main__':
    unittest.main()
