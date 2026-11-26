"""Optional CPU-only Khadijah inference for Dorham's local speech worker."""

import importlib
import sys

import numpy as np


class KhadijahVoice:
    def __init__(self, root):
        # Keep the optional Sherpa dependencies separate from the Piper environment.
        runtime = str(root / 'runtime')
        sys.path.append(runtime)
        try:
            sherpa = importlib.import_module('sherpa_onnx')
        finally:
            sys.path.remove(runtime)
        voice = root / 'matcha-tts-fa_en-khadijah'
        config = sherpa.OfflineTtsConfig(
            model=sherpa.OfflineTtsModelConfig(
                matcha=sherpa.OfflineTtsMatchaModelConfig(
                    acoustic_model=str(voice / 'model.onnx'),
                    vocoder=str(root / 'vocos.onnx'),
                    tokens=str(voice / 'tokens.txt'),
                    data_dir=str(voice / 'espeak-ng-data'),
                ),
                num_threads=1,
                provider='cpu',
            ),
            max_num_sentences=1,
        )
        if not config.validate():
            raise ValueError('Invalid Khadijah configuration')
        self.tts = sherpa.OfflineTts(config)

    def synthesize_pcm(self, text, rate):
        audio = self.tts.generate(text, sid=0, speed=1.0)
        samples = np.asarray(audio.samples, dtype=np.float32)
        if (audio.sample_rate != rate or samples.ndim != 1 or not samples.size
                or samples.size > rate * 60 or not np.isfinite(samples).all()
                or not np.any(np.abs(samples) > 0.001)):
            raise ValueError('Invalid Khadijah audio')
        return np.rint(np.clip(samples, -1.0, 1.0) * 32767).astype('<i2').tobytes()
