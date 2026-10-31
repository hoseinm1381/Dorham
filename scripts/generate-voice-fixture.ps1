$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voiceFixture = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tests\fixtures\synthetic-voice.wav'))
$speechGenerator = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speechGenerator.Rate = 0
    $speechGenerator.SetOutputToWaveFile($voiceFixture)
    $speechGenerator.Speak('Good friends make every conversation better. We can hear each other clearly, even when the room is busy.')
} finally { $speechGenerator.Dispose() }
