export function ttsMessage(content: string) {
  const requested = /^\/tts(?:\s|$)/i.test(content.trim());
  return { requested, text: requested ? content.trim().replace(/^\/tts\s*/i, '').trim() : content };
}
export type VoiceTts = { id: string; channelId: string; userId: string; expiresAt: number };
