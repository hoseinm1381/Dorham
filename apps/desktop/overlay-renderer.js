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
const rows = new Map();
window.voiceOverlay.onState(value => {
 if (!value) return;
 document.documentElement.dir = value.language === 'fa-IR' ? 'rtl' : 'ltr';
 document.title = 'Dorham voice — ' + value.channel;
 const list = document.getElementById('members'), wanted = new Set(), fa = value.language === 'fa-IR';
 for (const [index, person] of value.members.entries()) {
  const key = person.id || String(index); wanted.add(key);
  let item = rows.get(key);
  if (!item) {
   const row = document.createElement('div'), avatar = document.createElement('span'), name = document.createElement('bdi'), status = document.createElement('span');
   avatar.className = 'avatar'; name.className = 'name'; status.className = 'state'; status.setAttribute('role', 'img');
   row.append(avatar, name, status); item = { row, avatar, name, status, previous: {} }; rows.set(key, item);
  }
  const muted = person.muted || person.serverMuted || person.deafened, old = item.previous;
  const avatar = Object.hasOwn(person, 'avatar') && person.avatar !== undefined ? person.avatar : old.avatar;
  if (person.name !== old.name) item.name.textContent = person.name;
  if (avatar !== old.avatar || (!avatar && person.name !== old.name)) {
   item.avatar.textContent = Array.from(person.name).slice(0, 2).join('');
   if (avatar) { const image = document.createElement('img'); image.src = avatar; image.alt = ''; image.addEventListener('error', () => { item.avatar.textContent = Array.from(person.name).slice(0, 2).join(''); }, { once: true }); item.avatar.replaceChildren(image); }
  }
  const className = 'member ' + (muted ? 'muted' : person.speaking ? 'speaking' : '');
  if (item.row.className !== className) item.row.className = className;
  const label = person.serverMuted ? (fa ? 'بی‌صدا توسط مدیر' : 'Server muted') : person.deafened ? (fa ? 'ناشنوا' : 'Deafened') : person.muted ? (fa ? 'بی‌صدا' : 'Muted') : person.speaking ? (fa ? 'در حال صحبت' : 'Speaking') : (fa ? 'در حال شنیدن' : 'Listening');
  if (item.status.title !== label) { item.status.setAttribute('aria-label', label); item.status.title = label; }
  if (muted !== old.effectiveMuted || person.deafened !== old.deafened) item.status.replaceChildren(statusIcon('mic', muted), statusIcon('headphones', person.deafened));
  if (list.children[index] !== item.row) list.insertBefore(item.row, list.children[index] || null);
  item.previous = { ...person, avatar, effectiveMuted: muted };
 }
 for (const [key, item] of rows) if (!wanted.has(key)) { item.row.remove(); rows.delete(key); }
});
