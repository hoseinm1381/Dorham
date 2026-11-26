import { Capacitor, registerPlugin } from '@capacitor/core';
import { readDownloadFolder, storeDownloadFolder } from './offline-storage';

type Directory = FileSystemDirectoryHandle & {
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};
type FolderControls = {
  getDownloadFolder(): Promise<string | null>;
  chooseDownloadFolder(): Promise<string | null>;
  resetDownloadFolder(): Promise<void>;
};
const android = registerPlugin<{
  getDownloadFolder(): Promise<{ folder: string | null }>;
  chooseDownloadFolder(): Promise<{ folder: string | null }>;
  resetDownloadFolder(): Promise<void>;
}>('DorhamFiles');
const browserPicker = () => (window as Window & {
  showDirectoryPicker?: (options: { mode: 'readwrite'; id: string; startIn: 'downloads' }) => Promise<Directory>
}).showDirectoryPicker?.bind(window);

export function downloadFolderControls(): FolderControls | undefined {
  if (Capacitor.getPlatform() === 'android') return {
    getDownloadFolder: async () => (await android.getDownloadFolder()).folder,
    chooseDownloadFolder: async () => (await android.chooseDownloadFolder()).folder,
    resetDownloadFolder: () => android.resetDownloadFolder(),
  };
  if (window.desktop?.getDownloadFolder && window.desktop.chooseDownloadFolder && window.desktop.resetDownloadFolder)
    return window.desktop as NonNullable<Window['desktop']> & FolderControls;
  const picker = browserPicker();
  if (!picker) return;
  return {
    async getDownloadFolder() { return (await readDownloadFolder<Directory>())?.name ?? null; },
    async chooseDownloadFolder() {
      try {
        const folder = await picker({ mode: 'readwrite', id: 'dorham-downloads', startIn: 'downloads' });
        await storeDownloadFolder(folder);
        return folder.name;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        throw error;
      }
    },
    resetDownloadFolder: () => storeDownloadFolder(),
  };
}

// Called from the download gesture, before fetching or waiting for bandwidth.
export async function prepareBrowserDownload() {
  if (!browserPicker() || window.desktop?.getDownloadFolder || Capacitor.isNativePlatform()) return;
  const folder = await readDownloadFolder<Directory>().catch(() => undefined);
  if (!folder) return;
  if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted')
    throw new Error('Allow access to the saved download folder or change it in Storage & Downloads.');
  return folder;
}

export async function writeBrowserDownload(folder: Directory, name: string, data: Blob | ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'download';
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  const extension = dot > 0 ? clean.slice(dot) : '';
  const save = async () => {
    for (let index = 0; index < 1000; index++) {
      signal?.throwIfAborted();
      const candidate = index ? `${base} (${index})${extension}` : clean;
      try { await folder.getFileHandle(candidate); }
      catch (error) {
        if (!(error instanceof DOMException)) throw error;
        if (error.name === 'TypeMismatchError') continue;
        if (error.name !== 'NotFoundError') throw error;
        const handle = await folder.getFileHandle(candidate, { create: true });
        const writable = await handle.createWritable();
        try {
          signal?.throwIfAborted();
          if (data instanceof Blob) {
            await writable.write(data);
            signal?.throwIfAborted();
            await writable.close();
          } else await data.pipeTo(writable, { signal });
        } catch (cause) {
          await writable.abort().catch(() => {});
          await folder.removeEntry(candidate).catch(() => {});
          throw cause;
        }
        return;
      }
    }
    throw new Error('Too many files have this name in the download folder.');
  };
  if (navigator.locks) await navigator.locks.request('dorham-download-folder', save);
  else await save();
}
