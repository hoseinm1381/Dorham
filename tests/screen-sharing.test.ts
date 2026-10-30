import { afterEach, expect, it, vi } from 'vitest';
import { clampScreenBandwidth, screenBandwidths, screenSettings } from '../packages/media/src/screen-quality';
import { effectiveScreenPreferences, readScreenPreferences, saveScreenPreferences } from '../apps/web/src/ScreenShareSettings';
afterEach(()=>vi.unstubAllGlobals());
it('applies the full selected bandwidth independently of resolution, with shared sound inside the budget',()=>{
  for(const quality of ['480p15','480p30','720p15','720p30'] as const)for(const bandwidth of screenBandwidths){
    const policy={maxBitrate:1500000,maxFrameRate:30},silent=screenSettings(quality,policy,{},bandwidth),audio=screenSettings(quality,policy,{includeAudio:true},bandwidth);
    expect(silent.bitrate).toBe(bandwidth);expect(audio.bitrate+audio.audioBitrate).toBe(bandwidth);expect(audio.audioBitrate).toBe(48000);
  }
});
it('respects lower server/slot ceilings, bounds invalid inputs and preserves legacy settings',()=>{
  expect(screenSettings('720p30',{maxBitrate:450000,maxFrameRate:30},{maxFrameRate:15,includeAudio:true},1500000)).toMatchObject({fps:15,bitrate:402000,audioBitrate:48000});
  expect(clampScreenBandwidth(NaN)).toBe(450000);expect(clampScreenBandwidth(-100)).toBe(300000);expect(clampScreenBandwidth(2000000)).toBe(1500000);
  expect(screenSettings('480p15',{maxBitrate:1500000,maxFrameRate:30})).toMatchObject({bitrate:400000,fps:15});
});
it('saves supported sharing choices and recovers safely from malformed or unavailable storage',()=>{
  const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k),setItem:(k:string,v:string)=>values.set(k,v)});
  expect(readScreenPreferences()).toEqual({quality:'720p15',bandwidth:450000});saveScreenPreferences({quality:'480p30',bandwidth:1500000});expect(readScreenPreferences()).toEqual({quality:'480p30',bandwidth:1500000});
  values.set('dorham.screen-sharing.v1','{"quality":"8k","bandwidth":99999999}');expect(readScreenPreferences().bandwidth).toBe(450000);
  vi.stubGlobal('localStorage',{getItem:()=>{throw Error('disabled');}});expect(readScreenPreferences().quality).toBe('720p15');
});
it('does not display or silently enable 30fps after a fallback slot is promoted',()=>{
  const prefs={quality:'720p30' as const,bandwidth:1500000},share:any={requestedFrameRate:15,maxFrameRate:30};
  expect(effectiveScreenPreferences(prefs,share).quality).toBe('720p15');expect(effectiveScreenPreferences(prefs,{...share,requestedFrameRate:30}).quality).toBe('720p30');
});
