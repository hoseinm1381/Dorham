"""Explicit installation step; no downloads, service restart, or voice changes."""
import argparse
from pathlib import Path
from tts_model import prepare

parser = argparse.ArgumentParser()
parser.add_argument('--models', type=Path, default=Path('/opt/dorham-tts/voices'))
args = parser.parse_args()
for name in ('fa_IR-amir-medium', 'en_US-ljspeech-medium'):
    changed = prepare(args.models / (name + '.onnx'))
    print(name + (': optimized and verified' if changed else ': verified existing optimized model'), flush=True)
