import { test, expect } from '@playwright/test';
test('local RTC prerequisite gathers and decodes between two bare peer connections', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['microphone'] }), page = await context.newPage();
  try { await page.goto('/'); const result = await page.evaluate(async () => {
    const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] }), events: string[] = [], candidates: RTCIceCandidateInit[] = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t => a.addTrack(t, stream));
    a.onicecandidate = e => { if (e.candidate) { candidates.push(e.candidate.toJSON()); void b.addIceCandidate(e.candidate).catch(() => {}); } }; b.onicecandidate = e => { if (e.candidate) void a.addIceCandidate(e.candidate).catch(() => {}); }; a.onicegatheringstatechange = () => events.push(a.iceGatheringState);
    const offer = await a.createOffer(); await a.setLocalDescription(offer); await b.setRemoteDescription(offer); const answer = await b.createAnswer(); await b.setLocalDescription(answer); await a.setRemoteDescription(answer);
    await new Promise(r => setTimeout(r, 7000)); const stats: any[] = []; (await b.getStats()).forEach((r: any) => { if (r.type === 'inbound-rtp') stats.push({ kind: r.kind, packetsReceived: r.packetsReceived }); }); const output = { a: a.connectionState, b: b.connectionState, events, candidates: candidates.map(c => c.candidate?.split(' ').slice(6, 9).join(' ')), stats }; a.close(); b.close(); stream.getTracks().forEach(t => t.stop()); return output;
  }); console.log(JSON.stringify(result)); expect(result.a).toBe('connected'); expect(result.stats.some(s => s.packetsReceived > 0)).toBe(true); } finally { await context.close(); }
});
