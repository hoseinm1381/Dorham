// RNNoise confidence updates once per 10 ms frame. Keep a short hold to
// preserve quiet syllables and tails, and ramp per sample to avoid clicks.
export function speechGate() {
  const floor = 0.025;
  let gain = floor;
  let hold = 0;
  let previousSpeech = false;
  return (frame, confidence) => {
    const speech = confidence >= 0.48;
    if (confidence >= 0.72 || (speech && previousSpeech)) hold = 14;
    previousSpeech = speech;
    const target = hold ? 1 : Math.max(floor, Math.min(0.28, (confidence - 0.2) * 0.7 || 0));
    if (hold) hold--;
    const next = target > gain ? target : gain + (target - gain) * 0.25;
    const step = (next - gain) / frame.length;
    for (let i = 0; i < frame.length; i++) frame[i] *= gain + step * (i + 1);
    gain = next;
  };
}
