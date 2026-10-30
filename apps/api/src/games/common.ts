import { randomInt } from 'node:crypto';
import type { GameSettings, Picture, Stroke } from '../../../../packages/contracts/src/games';
export type Engine = { phase: string; deadline: number; result: string | null; [key: string]: any };
export function insist(value: unknown, message = 'That action is unavailable.'): asserts value { if (!value) throw new Error(message); }
export function integer(value: unknown, min: number, max: number): number { insist(typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max, 'Choose a valid number.'); return value; }
export function text(value: unknown, max = 180): string { insist(typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max, 'Enter a shorter, nonempty answer.'); return value.trim().normalize('NFC'); }
export function shuffle<T>(values: T[]): T[] { const a = values.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
export const nextSeat = (seat: number, n: number) => (seat + 1) % n;
export const freshPicture = (): Picture => ({ strokes: [], points: 0 });
const colors = ['#20232b', '#ffffff', '#e45b63', '#4a86e8', '#43a477', '#ecc64c', '#9a69d5', '#e78e48'];
export function stroke(picture: Picture, value: any) {
  insist(value && colors.includes(value.color) && [3, 7, 14].includes(value.width), 'Choose a drawing tool.');
  insist(Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= 100, 'Draw shorter strokes.');
  insist(picture.points + value.points.length <= 1000 && picture.strokes.length < 160, 'This drawing is full. Clear it or submit it.');
  const item: Stroke = { color: value.color, width: value.width, points: value.points.map((p: any) => { insist(Array.isArray(p) && p.length === 2); return [integer(p[0], 0, 1000), integer(p[1], 0, 1000)]; }) };
  picture.strokes.push(item); picture.points += item.points.length;
}
// Original, deliberately small word lists. No scraped dictionary or external API.
const english = ['apple','bridge','castle','dragon','elephant','flower','guitar','island','jungle','kite','lantern','mountain','notebook','ocean','pencil','queen','rainbow','snowman','tiger','umbrella','volcano','window','yacht','zebra','balloon','camera','dolphin','eagle','forest','garden','hammer','iceberg','jacket','kettle','lemon','moon','needle','orange','penguin','rocket','sailboat','turtle','unicorn','violin','waterfall','anchor','bicycle','cloud','desert','envelope','feather','glove','helmet','igloo','jellyfish','key','ladder','mirror','nest','owl','planet','rabbit','sunflower','train','village','whale','zipper','robot','candle','butterfly','crown','diamond','fire','ghost','heart','leaf','magnet','pearl','star','tower'];
const persian = ['سیب','پل','قلعه','اژدها','فیل','گل','گیتار','جزیره','جنگل','بادبادک','فانوس','کوه','دفتر','دریا','مداد','ملکه','رنگین‌کمان','آدم‌برفی','ببر','چتر','آتشفشان','پنجره','قایق','گورخر','بادکنک','دوربین','دلفین','عقاب','باغ','چکش','کاپشن','کتری','لیمو','ماه','سوزن','پرتقال','پنگوئن','موشک','لاک‌پشت','ویولن','آبشار','لنگر','دوچرخه','ابر','بیابان','پاکت','پر','دستکش','کلاه','کلید','نردبان','آینه','لانه','جغد','سیاره','خرگوش','قطار','روستا','نهنگ','ربات','شمع','پروانه','تاج','الماس','آتش','روح','قلب','برگ','آهنربا','مروارید','ستاره','برج'];
export const words = (s: GameSettings) => shuffle(s.language === 'fa' ? persian : english);
export const normalizeAnswer = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\s|\u200c|\u200d|ـ/g, '');
