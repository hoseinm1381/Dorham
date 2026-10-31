# SPDX-License-Identifier: GPL-3.0-or-later
# Separate local Piper process. JSON lines in, PCM WAV JSON lines out. No text logs.
import base64,io,json,os,re,sys,wave
from pathlib import Path
import onnxruntime
from piper import PiperVoice
from piper.config import PiperConfig
models=Path(os.environ.get('DORHAM_TTS_MODELS','/opt/dorham-tts/voices'))
voices={}
if hasattr(os, 'nice'):os.nice(10)
def voice(language):
    if language not in voices:
        name='fa_IR-amir-medium' if language=='fa' else 'en_US-ljspeech-medium'
        options=onnxruntime.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
        voices[language]=PiperVoice(config=PiperConfig.from_dict(json.loads((models/(name+'.onnx.json')).read_text())),session=onnxruntime.InferenceSession(str(models/(name+'.onnx')),sess_options=options,providers=['CPUExecutionProvider']))
    return voices[language]
def synthesize(text):
    if not text or len(text)>400:raise ValueError('length')
    segments=[];language='fa' if re.search('[\u0600-\u06ff]',text) else 'en';buffer=''
    for character in text:
        next_language='fa' if re.match('[\u0620-\u06ff]',character) and character.isalpha() else 'en' if re.match('[a-zA-Z]',character) else language
        if next_language!=language and buffer.strip():segments.append((language,buffer));buffer=''
        buffer+=character;language=next_language
    if buffer.strip():segments.append((language,buffer))
    if len(segments)>20:raise ValueError('segments')
    pcm=[];rate=22050
    for language,part in segments:
        if language=='fa':part=part.replace('ي','ی').replace('ك','ک')
        data=io.BytesIO()
        with wave.open(data,'wb') as output:voice(language).synthesize_wav(part,output)
        with wave.open(io.BytesIO(data.getvalue()),'rb') as source:
            if source.getnchannels()!=1 or source.getsampwidth()!=2 or source.getframerate()!=rate:raise ValueError('format')
            pcm.append(source.readframes(source.getnframes()))
        pcm.append(b'\0\0'*1102)
    frames=b''.join(pcm)
    if len(frames)>rate*2*60:raise ValueError('duration')
    data=io.BytesIO()
    with wave.open(data,'wb') as output:output.setnchannels(1);output.setsampwidth(2);output.setframerate(rate);output.writeframes(frames)
    return data.getvalue()
for line in sys.stdin:
    try:
        request=json.loads(line);audio=synthesize(request['text']);print(json.dumps({'audio':base64.b64encode(audio).decode()}),flush=True)
    except Exception:print(json.dumps({'error':'Speech generation unavailable.'}),flush=True)
