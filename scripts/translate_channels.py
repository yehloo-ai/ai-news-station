"""Backfill current channel snapshots without changing their freshness dates."""
import json
from pathlib import Path
import generate_feed as feeds

def main():
    for channel in ['featured', 'all', 'official', 'videos', 'products', 'design', 'daily']:
        path = Path(feeds.DATA_DIR) / (channel + '.json')
        payload = json.loads(path.read_text())
        result = feeds.translate_items_en(payload.get('items', []))
        path.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
        print(channel, result)
        if channel == 'featured':
            feeds.gen_rss_xml(payload['items'])
    (Path(feeds.DATA_DIR) / 'translations.json').write_text(json.dumps(feeds.TRANSLATIONS, ensure_ascii=False, separators=(',', ':')))

if __name__ == '__main__':
    main()
