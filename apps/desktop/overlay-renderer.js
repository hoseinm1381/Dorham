/* global window, document */
window.voiceOverlay.onState(value => {
 if (!value) return;
 document.documentElement.dir = value.language === 'fa-IR' ? 'rtl' : 'ltr';
 document.getElementById('channel').textContent = value.channel;
 const list = document.getElementById('members'); list.replaceChildren();
 const fa = value.language === 'fa-IR';
 for (const person of value.members) {
  const muted = person.muted || person.serverMuted || person.deafened;
  const row = document.createElement('div'); row.className = 'member ' + (muted ? 'muted' : person.speaking ? 'speaking' : '');
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = Array.from(person.name).slice(0,2).join('');
  const name = document.createElement('bdi'); name.className = 'name'; name.textContent = person.name;
  const status = document.createElement('span'); status.className = 'state';
  status.textContent = person.serverMuted ? (fa ? 'بی‌صدا توسط مدیر' : 'Server muted') : person.deafened ? (fa ? 'ناشنوا' : 'Deafened') : person.muted ? (fa ? 'بی‌صدا' : 'Muted') : person.speaking ? (fa ? 'در حال صحبت' : 'Speaking') : (fa ? 'در حال شنیدن' : 'Listening');
  row.append(avatar,name,status); list.append(row);
 }
});
