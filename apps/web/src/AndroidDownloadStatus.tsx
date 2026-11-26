import { useState } from 'react';
import { enqueueAndroidDownload, pauseAndroidDownload, removeAndroidDownload, useAndroidDownloads } from './android-transfer-queue';
import { openSavedAttachment } from './api';
import { formatNumber, t } from './i18n';
export function AndroidDownloadStatus() {
  const jobs = useAndroidDownloads();
  const [error, setError] = useState('');
  if (!jobs.length) return null;
  const pending = jobs.filter(job => job.state === 'waiting' || job.state === 'downloading').length;
  return <details className="android-download-status">
    <summary>{t('Downloads')}{pending > 0 ? ` · ${formatNumber(pending)}` : ''}</summary>
    {jobs.slice().reverse().map(job => <div key={job.id} className="android-transfer-row">
      <span><strong dir="auto">{job.name}</strong> · {t(job.state === 'downloading' ? 'Downloading file' : job.state === 'paused' ? 'Paused' : job.state === 'waiting' ? 'Queued' : 'File saved')}</span>
      {job.state === 'downloading' && <progress max={1} value={job.progress} aria-label={t('File download progress')}/>}
      {job.state === 'downloading' || job.state === 'waiting'
        ? <button type="button" onClick={() => pauseAndroidDownload(job.id)}>{t('Pause download')}</button>
        : <>
          {job.state === 'paused' && <button type="button" onClick={() => {
            setError('');
            try { enqueueAndroidDownload(job.id, job.name, job.conversation, job.gallery); }
            catch (cause) { setError(cause instanceof Error ? cause.message : 'Download paused. Select Download to resume.'); }
          }}>{t('Resume download')}</button>}
          {job.handle && <button type="button" onClick={() => {
            setError(''); void openSavedAttachment(job.handle!).catch(cause => setError(cause.message));
          }}>{t('Open saved file')}</button>}
          <button type="button" onClick={() => removeAndroidDownload(job.id)}>{t('Dismiss')}</button>
        </>}
    </div>)}
    {error && <p role="alert">{t(error)}</p>}
  </details>;
}
