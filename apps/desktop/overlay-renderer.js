/* global window, document */
function statusIcon(kind, off) {
 const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
 svg.setAttribute('viewBox', '0 0 24 24');
 svg.setAttribute('fill', 'none');
 svg.setAttribute('stroke', 'currentColor');
 svg.setAttribute('stroke-width', '2');
 svg.setAttribute('stroke-linecap', 'round');
 svg.setAttribute('stroke-linejoin', 'round');
 svg.setAttribute('aria-hidden', 'true');
 svg.dataset.icon = kind + (off ? '-off' : '-on');
 svg.classList.add(off ? 'off' : 'on');
 const paths = kind === 'mic'
  ? off ? ['m2 2 20 20', 'M9 9v3a3 3 0 0 0 5.12 2.12', 'M15 9.34V5a3 3 0 0 0-5.94-.6', 'M5 10v2a7 7 0 0 0 12 4.9', 'M19 10v2a7 7 0 0 1-.27 1.93', 'M12 19v3', 'M8 22h8']
   : ['M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z', 'M5 10v2a7 7 0 0 0 14 0v-2', 'M12 19v3', 'M8 22h8']
  : off ? ['m2 2 20 20', 'M3 14v-3a9 9 0 0 1 1.55-5.05', 'M8.25 2.82A9 9 0 0 1 21 11v6', 'M3 14h3v7H5a2 2 0 0 1-2-2Z', 'M18 14h3v5a2 2 0 0 1-2 2h-1v-3']
   : ['M3 14v-3a9 9 0 0 1 18 0v3', 'M3 14h3v7H5a2 2 0 0 1-2-2Z', 'M18 14h3v5a2 2 0 0 1-2 2h-1Z'];
 for (const d of paths) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d); svg.append(path);
 }
 return svg;
}
window.voiceOverlay.onState(value => {
 if (!value) return;
 document.documentElement.dir = value.language === 'fa-IR' ? 'rtl' : 'ltr';
 document.title = 'Dorham voice — ' + value.channel;
 const list = document.getElementById('members'); list.replaceChildren();
 const fa = value.language === 'fa-IR';
 for (const person of value.members) {
  const muted = person.muted || person.serverMuted || person.deafened;
  const row = document.createElement('div'); row.className = 'member ' + (muted ? 'muted' : person.speaking ? 'speaking' : '');
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = Array.from(person.name).slice(0,2).join('');
  if (person.avatar) { const image = document.createElement('img'); image.src = person.avatar; image.alt = ''; image.addEventListener('error', () => { avatar.textContent = Array.from(person.name).slice(0,2).join(''); }, { once: true }); avatar.replaceChildren(image); }
  const name = document.createElement('bdi'); name.className = 'name'; name.textContent = person.name;
  const status = document.createElement('span'); status.className = 'state';
  const label = person.serverMuted ? (fa ? 'بی‌صدا توسط مدیر' : 'Server muted') : person.deafened ? (fa ? 'ناشنوا' : 'Deafened') : person.muted ? (fa ? 'بی‌صدا' : 'Muted') : person.speaking ? (fa ? 'در حال صحبت' : 'Speaking') : (fa ? 'در حال شنیدن' : 'Listening');
  status.setAttribute('role', 'img'); status.setAttribute('aria-label', label); status.title = label;
  status.append(statusIcon('mic', muted), statusIcon('headphones', person.deafened));
  row.append(avatar,name,status); list.append(row);
 }
});
