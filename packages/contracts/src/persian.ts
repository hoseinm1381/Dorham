// Search only: preserve the original display name and every message byte.
export function normalizePeopleSearch(text: string) {
  return text.normalize('NFKC').toLowerCase()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[۰-۹٠-٩]/g, char => String(char.charCodeAt(0) - (char >= '۰' ? 0x6f0 : 0x660)))
    .replace(/[\u064b-\u065f\u0670\u0640\s\u200c\u200d]/g, '');
}
