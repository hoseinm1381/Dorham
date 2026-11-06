# SPDX-License-Identifier: GPL-3.0-or-later
# Separate local Piper process. JSON lines in, PCM WAV JSON lines out. No text logs.
import base64,io,json,os,re,sys,wave
from pathlib import Path
import onnxruntime
from piper import PiperVoice
from piper.config import PiperConfig
from tts_model import load_session
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
models=Path(os.environ.get('DORHAM_TTS_MODELS','/opt/dorham-tts/voices'))
voices={}
if hasattr(os, 'nice'):os.nice(10)
def voice(language):
    if language not in voices:
        name='fa_IR-amir-medium' if language=='fa' else 'en_US-ljspeech-medium'
        voices[language]=PiperVoice(config=PiperConfig.from_dict(json.loads((models/(name+'.onnx.json')).read_text(encoding='utf-8'))),session=load_session(models/(name+'.onnx')))
    return voices[language]
def synthesize(text,progress=None):
    if not text or len(text)>400:raise ValueError('length')
    segments=[];language='fa' if re.search('[\u0600-\u06ff]',text) else 'en';buffer=''
    for character in text:
        next_language='fa' if re.match('[\u0620-\u06ff]',character) and character.isalpha() else 'en' if re.match('[a-zA-Z]',character) else language
        if next_language!=language and buffer.strip():segments.append((language,buffer));buffer=''
        buffer+=character;language=next_language
    if buffer.strip():segments.append((language,buffer))
    if len(segments)>20:raise ValueError('segments')
    pcm=[];rate=22050
    # Use Piper's natural sentences and normal waveform conversion. Count
    # completed phonemes for progress without splitting a sentence for playback.
    prepared=[]
    for language,part in segments:
        if language=='fa':part=part.replace('ي','ی').replace('ك','ک')
        current=voice(language)
        weight=sum(len(sentence) for sentence in current.phonemize(part)) if progress else 0
        prepared.append((current,part,weight))
    total=max(1,sum(weight for _,_,weight in prepared));completed=0
    if progress:progress(5)
    for current,part,_ in prepared:
        for chunk in current.synthesize(part):
            if chunk.sample_channels!=1 or chunk.sample_width!=2 or chunk.sample_rate!=rate:raise ValueError('format')
            pcm.append(chunk.audio_int16_bytes)
            completed+=len(chunk.phonemes)
            if progress:progress(min(95,5+90*completed//total))
        pcm.append(b'\0\0'*1102)
    frames=b''.join(pcm)
    if len(frames)>rate*2*60:raise ValueError('duration')
    data=io.BytesIO()
    with wave.open(data,'wb') as output:output.setnchannels(1);output.setsampwidth(2);output.setframerate(rate);output.writeframes(frames)
    return data.getvalue()
for line in sys.stdin:
    try:
        request=json.loads(line)
        if request.get('warmup'):
            voice('fa');voice('en');print(json.dumps({'ready':True}),flush=True)
        else:
            progress=(lambda value:print(json.dumps({'progress':value}),flush=True)) if request.get('progress') else None
            audio=synthesize(request['text'],progress);print(json.dumps({'audio':base64.b64encode(audio).decode()}),flush=True)
    except Exception:print(json.dumps({'error':'Speech generation unavailable.'}),flush=True)
