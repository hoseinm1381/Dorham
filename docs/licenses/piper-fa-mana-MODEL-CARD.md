---
license: mit
datasets:
- MahtaFetrat/Mana-TTS
language:
- fa
base_model:
- rhasspy/piper-voices
---

# Mana Persian Piper (fa-IR)

This repository hosts a **Persian (fa-IR) Piper TTS model** trained for **low-latency, high-quality speech synthesis**.

The model is a **medium-sized Piper checkpoint**, fine-tuned on the **Mana-TTS** dataset to produce natural and intelligible Persian speech while remaining suitable for **real-time and on-device inference**.

---

## Model Description

* **Architecture:** Piper (medium)
* **Language:** Persian (fa-IR)
* **Base Checkpoint:**
  [https://huggingface.co/SadeghK/persian-text-to-speech/tree/main/farsi/amir](https://huggingface.co/SadeghK/persian-text-to-speech/tree/main/farsi/amir)
* **Fine-tuning:**
  ~1000 epochs on Mana-TTS
* **Training Dataset:**
  [https://huggingface.co/datasets/MahtaFetrat/Mana-TTS](https://huggingface.co/datasets/MahtaFetrat/Mana-TTS)

This model was trained as part of a broader effort to build efficient Persian TTS systems that integrate well with **lightweight and context-aware phonemization pipelines**.

---

## Inference

### Install Piper

```bash
pip install piper-tts
```

### Download the Model

```bash
git clone https://huggingface.co/MahtaFetrat/Mana-Persian-Piper
```

### Run Inference (Python)

```python
import wave
from piper import PiperVoice

voice = PiperVoice.load("/content/Mana-Persian-Piper/fa_IR-mana-medium.onnx")

with wave.open("test.wav", "wb") as wav_file:
    voice.synthesize_wav("سلام به همگی!", wav_file)
```

This will generate a `test.wav` file containing synthesized Persian speech.

---

## Model Files

* `fa_IR-mana-medium.onnx` – Piper acoustic model
* `fa_IR-mana-medium.onnx.json` – Model configuration and metadata

---

## Recommended Usage

This model is **best used in conjunction with context-aware phonemization**, as proposed in the paper:

> **Beyond Unified Models: A Service-Oriented Approach to Low-Latency, Context-Aware Phonemization for Real-Time TTS**

In particular, combining this Piper model with:

* Lightweight G2P
* Ezafe-aware context disambiguation

results in improved pronunciation accuracy while preserving real-time performance.

The full system implementation is available in the companion repository associated with the paper.

---

## Citation

If you use this model in your research or applications, please cite the following paper:

```bibtex
@misc{fetrat2025servicetts,
      title={Beyond Unified Models: A Service-Oriented Approach to Low Latency, Context Aware Phonemization for Real Time TTS}, 
      author={Mahta Fetrat and Donya Navabi and Zahra Dehghanian and Morteza Abolghasemi and Hamid R. Rabiee},
      year={2025},
      eprint={2512.08006},
      archivePrefix={arXiv},
      primaryClass={cs.SD},
      url={https://arxiv.org/abs/2512.08006}, 
}
```


