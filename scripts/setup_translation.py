"""Install the pinned Argos en-zh model into the build cache."""
import argparse
import hashlib
import io
import os
from pathlib import Path
import urllib.request
import zipfile

URL = 'https://github.com/yehloo-ai/ai-news-station/releases/download/translation-model-en-zh-1.9/translate-en_zh-1_9.argosmodel'
SHA256 = '433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab'
PREFIX = 'translate-en_zh-1_9/'

def install(directory, archive=None):
    directory = Path(directory)
    marker = directory / '.verified-sha256'
    if marker.is_file() and marker.read_text().strip() == SHA256 and (directory / 'model/model.bin').is_file() and (directory / 'sentencepiece.model').is_file():
        return
    if archive:
        content = Path(archive).read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=120) as response:
            content = response.read()
    if hashlib.sha256(content).hexdigest() != SHA256:
        raise ValueError('Translation model checksum mismatch')
    with zipfile.ZipFile(io.BytesIO(content)) as package:
        for member in package.infolist():
            if member.is_dir() or not member.filename.startswith(PREFIX):
                continue
            relative = Path(member.filename[len(PREFIX):])
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('Invalid model archive path')
            destination = directory / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(package.read(member))
    marker.write_text(SHA256 + '\n')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive')
    args = parser.parse_args()
    install(os.environ['TRANSLATE_MODEL_DIR'], args.archive)
    from generate_feed import translate_offline, translation_terms, valid_translation
    sample = 'Researchers introduce a new language model.'
    result = translation_terms(translate_offline(sample), sample)
    if not valid_translation(result, sample):
        raise RuntimeError('Offline translation smoke test failed')
    print('Pinned English-Chinese model is ready; inference smoke test passed')
