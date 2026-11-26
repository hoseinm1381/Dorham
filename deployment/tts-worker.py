# SPDX-License-Identifier: GPL-3.0-or-later
# Local speech process. JSON lines in, PCM WAV JSON lines out. No text logs.
import base64,io,json,os,re,sys,wave
from pathlib import Path
import onnxruntime
from piper import PiperVoice
from piper.config import PiperConfig
from tts_model import load_session
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
models=Path(os.environ.get('DORHAM_TTS_MODELS','/opt/dorham-tts/voices'))
khadijah_root=models.parent/'khadijah'
khadijah=None
khadijah_checked=False
voices={}
if hasattr(os, 'nice'):os.nice(10)
def voice(language):
    if language not in voices:
        name='fa_IR-amir-medium' if language=='fa' else 'en_US-ljspeech-medium'
        voices[language]=PiperVoice(config=PiperConfig.from_dict(json.loads((models/(name+'.onnx.json')).read_text(encoding='utf-8'))),session=load_session(models/(name+'.onnx')))
    return voices[language]

def persian_voice():
    global khadijah, khadijah_checked
    if not khadijah_checked:
        khadijah_checked = True
        if (khadijah_root / '.ready').is_file():
            try:
                from tts_matcha import KhadijahVoice
                khadijah = KhadijahVoice(khadijah_root)
            except Exception:
                # An incomplete optional installation must leave Piper usable.
                print('Khadijah initialization failed, using Piper.', file=sys.stderr)
    return khadijah

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
    # Keep English and Persian segments in order in the same WAV.
    prepared=[]
    for language,part in segments:
        if language=='fa':part=part.replace('ي','ی').replace('ك','ک')
        matcha = persian_voice() if language == 'fa' else None
        current = None if matcha else voice(language)
        weight = max(1, len(part)) if matcha else (
            sum(len(sentence) for sentence in current.phonemize(part)) if progress else 0)
        prepared.append((language, part, weight, matcha, current))
    total=max(1,sum(weight for _,_,weight,_,_ in prepared));completed=0
    if progress:progress(5)
    for language, part, weight, matcha, current in prepared:
        if matcha:
            try:
                pcm.append(matcha.synthesize_pcm(part, rate))
            except Exception:
                current = voice(language)
        if current:
            for chunk in current.synthesize(part):
                if chunk.sample_channels!=1 or chunk.sample_width!=2 or chunk.sample_rate!=rate:raise ValueError('format')
                pcm.append(chunk.audio_int16_bytes)
                if not matcha:
                    completed+=len(chunk.phonemes)
                    if progress:progress(min(95,5+90*completed//total))
        if matcha:
            completed += weight
            if progress:progress(min(95,5+90*completed//total))
        pcm.append(b'\0\0'*1102)
    frames=b''.join(pcm)
    if len(frames)>rate*2*60:raise ValueError('duration')
    data=io.BytesIO()
    with wave.open(data,'wb') as output:output.setnchannels(1);output.setsampwidth(2);output.setframerate(rate);output.writeframes(frames)
    return data.getvalue()
def main():
    for line in sys.stdin:
        try:
            request=json.loads(line)
            if request.get('warmup'):
                if persian_voice() is None:
                    voice('fa')
                voice('en');print(json.dumps({'ready':True}),flush=True)
            else:
                progress=(lambda value:print(json.dumps({'progress':value}),flush=True)) if request.get('progress') else None
                audio=synthesize(request['text'],progress);print(json.dumps({'audio':base64.b64encode(audio).decode()}),flush=True)
        except Exception:print(json.dumps({'error':'Speech generation unavailable.'}),flush=True)


if __name__ == '__main__':
    main()
