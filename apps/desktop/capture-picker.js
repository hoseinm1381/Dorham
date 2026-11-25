/* global window, document */
let model, selected = '', tab = 'window', busy = false;
const byId = id => document.getElementById(id);
const previews = new Map();
let previewGeneration = 0, previewLoading = false, previewActive = false, previewTimer;
const translations = { 'Choose what to share': 'انتخاب منبع اشتراک‌گذاری', 'Refresh': 'تازه‌سازی', 'Applications': 'برنامه‌ها', 'Screens': 'نمایشگرها', 'Search sources': 'جست‌وجوی منبع', 'Share sound': 'اشتراک صدا', 'No sound': 'بدون صدا', 'Selected application only': 'فقط برنامهٔ انتخاب‌شده', 'Computer sound, excluding Dorham': 'صدای رایانه به‌جز دورهم', 'Cancel': 'لغو', 'Share': 'اشتراک‌گذاری', 'Choose a source to continue.': 'برای ادامه یک منبع انتخاب کنید.', 'No matching sources. Try Refresh.': 'منبعی یافت نشد. فهرست را تازه‌سازی کنید.', 'Only sound from the selected application is shared.': 'فقط صدای برنامهٔ انتخاب‌شده به اشتراک گذاشته می‌شود.', 'Other apps may be audible. Dorham call audio is excluded.': 'صدای برنامه‌های دیگر ممکن است شنیده شود. صدای تماس دورهم ارسال نمی‌شود.', 'Video only. No application or computer sound is shared.': 'فقط تصویر ارسال می‌شود؛ صدای برنامه یا رایانه ارسال نمی‌شود.', 'Unable to list sources. Try Refresh.': 'فهرست منابع در دسترس نیست. دوباره تازه‌سازی کنید.', 'The source could not be shared. Refresh and choose again.': 'اشتراک این منبع ممکن نشد. فهرست را تازه‌سازی و دوباره انتخاب کنید.' };
const text = value => model?.language === 'fa-IR' ? translations[value] || value : value;
translations['Loading preview…'] = 'در حال بارگیری پیش‌نمایش…';
translations['Preview unavailable'] = 'پیش‌نمایش در دسترس نیست';
translations['Window minimized'] = 'پنجره کوچک شده است';
translations['Minimized. Restore the window if its picture pauses.'] = 'اگر تصویر متوقف شد، پنجره را باز کنید.';
translations['Restore window'] = 'بازگرداندن پنجره';
translations['Open the window from the taskbar, then select Refresh.'] = 'پنجره را از نوار وظیفه باز کنید، سپس فهرست را تازه‌سازی کنید.';
translations['All sound on the default output'] = 'همهٔ صدای خروجی پیش‌فرض';
translations['Windows 10 shares all sound on your default output, including notifications and Dorham voices. To avoid echo, use a different output for Dorham calls. Only enable this if you want to share that sound.'] = 'ویندوز ۱۰ همهٔ صدای خروجی پیش‌فرض، از جمله اعلان‌ها و صدای تماس دورهم را ارسال می‌کند. برای جلوگیری از اکو، خروجی دیگری برای تماس دورهم انتخاب کنید. فقط اگر می‌خواهید این صداها ارسال شوند، این گزینه را فعال کنید.';
const previewObserver = new window.IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) target.toggleAttribute('data-visible', isIntersecting);
  schedulePreviews(100);
}, { root: byId('sources') });

function showPreview(preview, thumbnail, pending = false) {
  if (thumbnail) {
    let image = preview.querySelector('img');
    if (!image) {
      image = document.createElement('img');
      image.alt = '';
      image.onerror = () => showPreview(preview, null);
      preview.replaceChildren(image);
    }
    if (image.src !== thumbnail) image.src = thumbnail;
  } else {
    preview.textContent = text(pending ? 'Loading preview…' : 'Preview unavailable');
  }
}

function paintPreview(preview, source) {
  if (source.minimized) preview.textContent = text(model.minimizedCapture ? 'Minimized. Restore the window if its picture pauses.' : 'Window minimized');
  else showPreview(preview, source.thumbnail || previews.get(source.id), Boolean(preview.dataset.preview) && !previews.has(source.id));
}

function schedulePreviews(delay = 0) {
  window.clearTimeout(previewTimer);
  if (window.capturePicker.previewFrames) previewTimer = window.setTimeout(pollPreviews, delay);
}

async function pollPreviews() {
  if (busy || previewLoading) return;
  const visible = document.hidden ? [] : [...byId('sources').querySelectorAll('[data-preview][data-visible]')];
  const requested = visible.map(item => item.dataset.preview);
  const selectedIndex = requested.indexOf(selected);
  if (selectedIndex > 0) requested.unshift(...requested.splice(selectedIndex, 1));
  if (!requested.length && !previewActive) return;
  previewActive = requested.length > 0;
  const generation = previewGeneration;
  previewLoading = true;
  try {
    const { frames, minimized } = await window.capturePicker.previewFrames(requested, generation).catch(() => ({
      frames: Object.fromEntries(requested.filter(id => !previews.has(id)).map(id => [id, null])),
      minimized: {},
    }));
    if (generation === previewGeneration) {
      const changed = new Set(Object.keys(frames));
      for (const source of model.sources) {
        if (Object.hasOwn(minimized, source.id) && source.minimized !== minimized[source.id]) {
          source.minimized = minimized[source.id];
          previews.delete(source.id);
          changed.add(source.id);
          if (source.id === selected) updateShareButton();
        }
      }
      for (const [id, thumbnail] of Object.entries(frames)) previews.set(id, thumbnail);
      for (const item of byId('sources').querySelectorAll('[data-preview]')) {
        const id = item.dataset.preview;
        if (changed.has(id)) paintPreview(item, model.sources.find(source => source.id === id));
      }
    }
  } finally {
    previewLoading = false;
    schedulePreviews(250);
  }
}
function audioScope() {
  const scope = byId('scope'), source = model.sources.find(item => item.id === selected);
  scope.querySelector('[value=application]').disabled = source?.kind !== 'window' || model.processAudioSupported === false;
  if (scope.value === 'application' && (source?.kind !== 'window' || model.processAudioSupported === false)) scope.value = model.processAudioSupported === false ? 'none' : model.audioRequested && model.audioSupported ? 'system' : 'none';
  byId('scope-description').textContent = text(model.processAudioSupported === false && model.audioRequested ? 'Windows 10 shares all sound on your default output, including notifications and Dorham voices. To avoid echo, use a different output for Dorham calls. Only enable this if you want to share that sound.' : scope.value === 'application' ? 'Only sound from the selected application is shared.' : scope.value === 'system' ? 'Other apps may be audible. Dorham call audio is excluded.' : 'Video only. No application or computer sound is shared.');
}
function updateShareButton() {
  const source = model.sources.find(item => item.id === selected);
  const button = byId('share');
  button.textContent = text(source?.minimized && !model.minimizedCapture ? 'Restore window' : 'Share');
  button.disabled = !source || busy;
}
function render() {
  if (!model) return;
  const list = byId('sources'), query = byId('search').value.trim().toLocaleLowerCase();
  previewObserver.disconnect();
  list.replaceChildren();
  for (const source of model.sources.filter(item => item.kind === tab && item.name.toLocaleLowerCase().includes(query))) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'source'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(source.id === selected)); button.setAttribute('aria-label', source.name);
    const preview = document.createElement('span'); preview.className = 'preview';
    const live = !source.thumbnail && Boolean(window.capturePicker.previewFrames);
    if (live) preview.dataset.preview = source.id;
    paintPreview(preview, source);
    const label = document.createElement('span'); label.className = 'source-name';
    if (source.icon) { const icon = document.createElement('img'); icon.src = source.icon; icon.alt = ''; label.append(icon); }
    const name = document.createElement('span'); name.textContent = source.name; label.append(name); button.append(preview, label);
    button.onclick = () => {
      const changed = selected !== source.id; selected = source.id;
      if (changed && model.audioRequested && model.audioSupported && model.processAudioSupported !== false) byId('scope').value = source.kind === 'window' ? 'application' : 'system';
      for (const item of list.children) item.setAttribute('aria-selected', String(item === button));
      byId('status').textContent = ''; updateShareButton(); audioScope();
      schedulePreviews();
    };
    list.append(button);
    if (live) previewObserver.observe(preview);
  }
  byId('status').textContent = text(!list.childElementCount ? 'No matching sources. Try Refresh.' : selected ? '' : 'Choose a source to continue.');
  updateShareButton(); audioScope();
  schedulePreviews(100);
}
async function refresh() {
  if (busy) return; busy = true; byId('refresh').disabled = true;
  try {
    model = await window.capturePicker.model(); document.documentElement.lang = model.language; document.documentElement.dir = model.language === 'fa-IR' ? 'rtl' : 'ltr';
    previewGeneration++; previews.clear();
    for (const [id, value] of Object.entries({ title: 'Choose what to share', refresh: 'Refresh', windows: 'Applications', screens: 'Screens', 'audio-label': 'Share sound', cancel: 'Cancel', share: 'Share' })) byId(id).textContent = text(value);
    for (const option of byId('scope').options) option.textContent = text({ none: 'No sound', application: 'Selected application only', system: 'Computer sound, excluding Dorham' }[option.value]);
    if (model.processAudioSupported === false) byId('scope').querySelector('[value=system]').textContent = text('All sound on the default output');
    byId('search').placeholder = text('Search sources'); byId('search').setAttribute('aria-label', text('Search sources'));
    byId('scope').disabled = !model.audioRequested || !model.audioSupported;
    if (!model.audioRequested || !model.audioSupported) byId('scope').value = 'none';
    if (!model.sources.some(item => item.id === selected)) selected = '';
    if (!model.sources.some(item => item.kind === tab)) tab = 'screen';
    for (const [id, kind] of [['windows', 'window'], ['screens', 'screen']]) byId(id).setAttribute('aria-selected', String(tab === kind));
  } catch { byId('status').textContent = text('Unable to list sources. Try Refresh.'); }
  finally { busy = false; byId('refresh').disabled = false; if (model) render(); }
}
async function choose(id) {
  if (!id) { await window.capturePicker.choose({ id: '', audioScope: 'none' }); return; }
  if (busy) return; busy = true; byId('share').disabled = true;
  try { await window.capturePicker.choose({ id, audioScope: byId('scope').value }); }
  catch { byId('status').textContent = text('The source could not be shared. Refresh and choose again.'); }
  finally { busy = false; updateShareButton(); schedulePreviews(); }
}
async function actOnSelection() {
  if (busy || !selected) return;
  const source = model.sources.find(item => item.id === selected);
  if (!source?.minimized || model.minimizedCapture) { await choose(selected); return; }
  busy = true;
  updateShareButton();
  try {
    await window.capturePicker.restore(source.id);
  } catch {
    byId('status').textContent = text('Open the window from the taskbar, then select Refresh.');
    return;
  } finally {
    busy = false;
    updateShareButton();
    schedulePreviews();
  }
  await refresh();
  byId('sources').querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}
for (const [id, kind] of [['windows', 'window'], ['screens', 'screen']]) byId(id).onclick = () => { tab = kind; for (const key of ['windows', 'screens']) byId(key).setAttribute('aria-selected', String(key === id)); render(); };
byId('search').oninput = render; byId('scope').onchange = audioScope; byId('refresh').onclick = refresh;
byId('cancel').onclick = () => { void choose(''); }; byId('share').onclick = () => { void actOnSelection(); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') void choose(''); });
document.addEventListener('visibilitychange', () => schedulePreviews());
window.addEventListener('focus', () => schedulePreviews());
void refresh();
