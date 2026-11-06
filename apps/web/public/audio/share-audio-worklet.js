/* global AudioWorkletProcessor, registerProcessor */
class DorhamShareAudio extends AudioWorkletProcessor {
  constructor() {
    super(); this.queue = []; this.offset = 0; this.closed = false;
    this.port.onmessage = event => {
      if (event.data === 'destroy') { this.closed = true; this.queue = []; return; }
      const samples = event.data;
      if (!(samples instanceof Float32Array) || !samples.length || samples.length > 9600 || samples.length % 2) return;
      if (this.queue.length >= 6) { this.queue.shift(); this.offset = 0; this.port.postMessage('ack'); }
      this.queue.push(samples);
    };
  }
  process(_inputs, outputs) {
    if (this.closed) return false;
    const output = outputs[0];
    for (let frame = 0; frame < output[0].length; frame++) {
      const chunk = this.queue[0];
      if (!chunk) break;
      output[0][frame] = chunk[this.offset++]; output[1][frame] = chunk[this.offset++];
      if (this.offset >= chunk.length) { this.queue.shift(); this.offset = 0; this.port.postMessage('ack'); }
    }
    return true;
  }
}
registerProcessor('dorham-share-audio', DorhamShareAudio);
