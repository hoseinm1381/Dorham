"""Host-local optimized ONNX artifacts. Runtime is read-only and may fall back.

Keep original verified models/configs intact. ORT layout optimizations are CPU
specific, so never distribute these artifacts as portable voice models.
"""
import hashlib
import json
import os
import platform
from pathlib import Path
import onnxruntime as ort


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def identity():
    flags = ''
    cpuinfo = Path('/proc/cpuinfo')
    if cpuinfo.exists():
        flags = next((line.split(':', 1)[1].strip() for line in cpuinfo.read_text().splitlines()
                      if line.startswith(('flags\t', 'Features\t'))), '')
    return {'onnxruntime': ort.__version__, 'machine': platform.machine(),
            'system': platform.system(), 'processor': platform.processor(),
            'cpuFlags': hashlib.sha256(flags.encode()).hexdigest()}


def options():
    value = ort.SessionOptions()
    value.intra_op_num_threads = 1
    value.inter_op_num_threads = 1
    return value


def optimized_paths(model):
    return model.with_suffix('.optimized.onnx'), model.with_suffix('.optimized.json')


def valid_optimized(model):
    optimized, receipt = optimized_paths(model)
    try:
        info = json.loads(receipt.read_text(encoding='utf-8'))
        return (info['identity'] == identity() and info['sourceSHA256'] == digest(model)
                and info['optimizedSHA256'] == digest(optimized))
    except (OSError, ValueError, KeyError):
        return False


def load_session(model):
    model = Path(model)
    optimized, _ = optimized_paths(model)
    if os.environ.get('DORHAM_TTS_DISABLE_OPTIMIZED') != '1' and valid_optimized(model):
        try:
            config = options()
            config.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
            return ort.InferenceSession(str(optimized), sess_options=config, providers=['CPUExecutionProvider'])
        except Exception:
            pass  # Incompatible/corrupt optional artifact must not disable speech.
    return ort.InferenceSession(str(model), sess_options=options(), providers=['CPUExecutionProvider'])


def prepare(model):
    model = Path(model)
    if valid_optimized(model):
        return False
    optimized, receipt = optimized_paths(model)
    temporary = optimized.with_suffix('.tmp.onnx')
    temporary_receipt = receipt.with_suffix('.tmp.json')
    try:
        config = options()
        config.optimized_model_filepath = str(temporary)
        config.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(str(model), sess_options=config, providers=['CPUExecutionProvider'])
        del session
        # Prove the saved graph loads without repeating optimization.
        verify = options()
        verify.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
        session = ort.InferenceSession(str(temporary), sess_options=verify, providers=['CPUExecutionProvider'])
        del session
        info = {'identity': identity(), 'sourceSHA256': digest(model), 'optimizedSHA256': digest(temporary)}
        temporary_receipt.write_text(json.dumps(info, indent=2), encoding='utf-8')
        temporary.replace(optimized)
        temporary_receipt.replace(receipt)
        return True
    finally:
        temporary.unlink(missing_ok=True)
        temporary_receipt.unlink(missing_ok=True)
