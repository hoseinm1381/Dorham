import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { cleanPreferences, cleanState } = createRequire(import.meta.url)('../apps/desktop/voice-overlay.cjs');
it('defaults the native overlay off and restricts its saved position', () => {
 expect(cleanPreferences(null)).toEqual({ enabled: false, position: 'top-left' });
 expect(cleanPreferences({ enabled: 'true', position: 'arbitrary' })).toEqual({ enabled: false, position: 'top-left' });
 expect(cleanPreferences({ enabled: true, position: 'bottom-right' })).toEqual({ enabled: true, position: 'bottom-right' });
});
it('bounds renderer status data and drops nonboolean state and invalid members', () => {
 expect(cleanState(null)).toBeNull(); expect(cleanState({ channel: 'x', members: 'bad' })).toBeNull();
 const state = cleanState({ channel: 'x'.repeat(100), language: 'arbitrary', members: [{ name: '<script>x</script>', muted: 'true', speaking: true }, { name: 2 }] });
 expect(state.channel).toHaveLength(80); expect(state.language).toBe('en-US'); expect(state.members).toEqual([{ name: '<script>x</script>', muted: false, deafened: false, serverMuted: false, speaking: true }]);
 expect(cleanState({ channel: 'x', members: Array.from({length:40}, () => ({name:'m'.repeat(100)})) }).members).toHaveLength(16);
});
it('allows bounded PNG thumbnails without passing paths, remote URLs or SVG into the overlay', () => {
 const avatar = 'data:image/png;base64,iVBORw0KGgo=';
 const member = (image: string) => cleanState({ channel: 'x', members: [{ name: 'm', avatar: image }] }).members[0];
 expect(member(avatar).avatar).toBe(avatar);
 for (const value of ['https://example.com/avatar.png', 'file:///C:/private.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,' + 'A'.repeat(32768)]) expect(member(value).avatar).toBeUndefined();
});
