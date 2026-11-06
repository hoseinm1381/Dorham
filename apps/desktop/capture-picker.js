/* global window, document */
let model, selected = '', tab = 'window', busy = false;
const byId = id => document.getElementById(id);
const translations = { 'Choose what to share': 'انتخاب منبع اشتراک‌گذاری', 'Refresh': 'تازه‌سازی', 'Applications': 'برنامه‌ها', 'Screens': 'نمایشگرها', 'Search sources': 'جست‌وجوی منبع', 'Share sound': 'اشتراک صدا', 'No sound': 'بدون صدا', 'Selected application only': 'فقط برنامهٔ انتخاب‌شده', 'Computer sound, excluding Dorham': 'صدای رایانه به‌جز دورهم', 'Cancel': 'لغو', 'Share': 'اشتراک‌گذاری', 'Choose a source to continue.': 'برای ادامه یک منبع انتخاب کنید.', 'No matching sources. Try Refresh.': 'منبعی یافت نشد. فهرست را تازه‌سازی کنید.', 'Only sound from the selected application is shared.': 'فقط صدای برنامهٔ انتخاب‌شده به اشتراک گذاشته می‌شود.', 'Other apps may be audible. Dorham call audio is excluded.': 'صدای برنامه‌های دیگر ممکن است شنیده شود. صدای تماس دورهم ارسال نمی‌شود.', 'Video only. No application or computer sound is shared.': 'فقط تصویر ارسال می‌شود؛ صدای برنامه یا رایانه ارسال نمی‌شود.', 'Unable to list sources. Try Refresh.': 'فهرست منابع در دسترس نیست. دوباره تازه‌سازی کنید.', 'The source could not be shared. Refresh and choose again.': 'اشتراک این منبع ممکن نشد. فهرست را تازه‌سازی و دوباره انتخاب کنید.' };
const text = value => model?.language === 'fa-IR' ? translations[value] || value : value;
function audioScope() {
  const scope = byId('scope'), source = model.sources.find(item => item.id === selected);
  scope.querySelector('[value=application]').disabled = source?.kind !== 'window';
  if (scope.value === 'application' && source?.kind !== 'window') scope.value = model.audioRequested && model.audioSupported ? 'system' : 'none';
  byId('scope-description').textContent = text(scope.value === 'application' ? 'Only sound from the selected application is shared.' : scope.value === 'system' ? 'Other apps may be audible. Dorham call audio is excluded.' : 'Video only. No application or computer sound is shared.');
}
function render() {
  const list = byId('sources'), query = byId('search').value.trim().toLocaleLowerCase();
  list.replaceChildren();
  for (const source of model.sources.filter(item => item.kind === tab && item.name.toLocaleLowerCase().includes(query))) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'source'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(source.id === selected)); button.setAttribute('aria-label', source.name);
    const preview = document.createElement('img'); preview.className = 'preview'; preview.alt = ''; if (source.thumbnail) preview.src = source.thumbnail;
    const label = document.createElement('span'); label.className = 'source-name';
    if (source.icon) { const icon = document.createElement('img'); icon.src = source.icon; icon.alt = ''; label.append(icon); }
    const name = document.createElement('span'); name.textContent = source.name; label.append(name); button.append(preview, label);
    button.onclick = () => { const changed = selected !== source.id; selected = source.id; if (changed && model.audioRequested && model.audioSupported) byId('scope').value = source.kind === 'window' ? 'application' : 'system'; render(); };
    list.append(button);
  }
  byId('status').textContent = text(!list.childElementCount ? 'No matching sources. Try Refresh.' : selected ? '' : 'Choose a source to continue.');
  byId('share').disabled = !selected || busy; audioScope();
}
async function refresh() {
  if (busy) return; busy = true; byId('refresh').disabled = true;
  try {
    model = await window.capturePicker.model(); document.documentElement.lang = model.language; document.documentElement.dir = model.language === 'fa-IR' ? 'rtl' : 'ltr';
    for (const [id, value] of Object.entries({ title: 'Choose what to share', refresh: 'Refresh', windows: 'Applications', screens: 'Screens', 'audio-label': 'Share sound', cancel: 'Cancel', share: 'Share' })) byId(id).textContent = text(value);
    for (const option of byId('scope').options) option.textContent = text({ none: 'No sound', application: 'Selected application only', system: 'Computer sound, excluding Dorham' }[option.value]);
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
  finally { busy = false; byId('share').disabled = !selected; }
}
for (const [id, kind] of [['windows', 'window'], ['screens', 'screen']]) byId(id).onclick = () => { tab = kind; for (const key of ['windows', 'screens']) byId(key).setAttribute('aria-selected', String(key === id)); render(); };
byId('search').oninput = render; byId('scope').onchange = audioScope; byId('refresh').onclick = refresh;
byId('cancel').onclick = () => { void choose(''); }; byId('share').onclick = () => { void choose(selected); };
document.addEventListener('keydown', event => { if (event.key === 'Escape') void choose(''); });
void refresh();
