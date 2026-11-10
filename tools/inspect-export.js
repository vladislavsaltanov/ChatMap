#!/usr/bin/env node
// One-off analyzer for a Telegram export result.json
// Usage: node inspect-export.js <path-to-result.json>
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node inspect-export.js <result.json>'); process.exit(1); }
const raw = fs.readFileSync(file, 'utf8');

// NOTE: deliberately NOT using JSON.parse on the exact structure we want to flexibly
// detect — we do use JSON.parse, but we also scan raw keys.
const data = JSON.parse(raw);

const keySlices = Object.entries(data).map(([k, v]) => {
  const t = Array.isArray(v) ? `array(${v.length})` : typeof v === 'object' && v !== null ? 'object' : typeof v;
  return `  ${k}: ${t}`;
});
console.log('== TOP-LEVEL KEYS ==\n' + keySlices.join('\n'));

console.log('\nchat meta:', JSON.stringify({ name: data.name, type: data.type, id: data.id }, null, 2));

const msgs = data.messages ?? [];
console.log('\ntotal messages:', msgs.length);

// participants
const bySpeaker = new Map();
for (const m of msgs) {
  const who = m.from ?? m.actor ?? '(none)';
  bySpeaker.set(who, (bySpeaker.get(who) ?? 0) + 1);
}
console.log('\n== PARTICIPANTS ==');
for (const [who, n] of [...bySpeaker.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${who}: ${n} messages`);

// key census per message, and per "text is array" messages
const msgKeyCount = new Map();
const entityTypes = new Map();
let textString = 0, textArray = 0, textMissing = 0, emptyText = 0;
const arrayEntityShapes = new Set();
const msgTypes = new Map();
let replies = 0, forwards = 0, edits = 0, withReactions = 0, stickerEmoji = 0, inlineButtons = 0;
let dateMin, dateMax;

for (const m of msgs) {
  msgTypes.set(m.type, (msgTypes.get(m.type) ?? 0) + 1);
  for (const k of Object.keys(m)) msgKeyCount.set(k, (msgKeyCount.get(k) ?? 0) + 1);
  if (m.reply_to_message_id !== undefined) replies++;
  if (m.forwarded_from !== undefined) forwards++;
  if (m.edited !== undefined) edits++;
  if (m.reactions) withReactions++;
  if (m.sticker_emoji) stickerEmoji++;
  if (m.keyboard_buttons || m.inline_bot_buttons) inlineButtons++;
  const d = m.date; if (d && (!dateMin || d < dateMin)) dateMin = d; if (d && (!dateMax || d > dateMax)) dateMax = d;

  const t = m.text;
  if (t === undefined) { textMissing++; continue; }
  if (Array.isArray(t)) {
    textArray++;
    const flat = [];
    for (const part of t) {
      if (typeof part === 'string') { flat.push(part); continue; }
      entityTypes.set(part.type, (entityTypes.get(part.type) ?? 0) + 1);
      // nested shapes
      if (part.text && Array.isArray(part.text)) arrayEntityShapes.add(`${part.type}:nested`);
      const keys = Object.keys(part).sort().join(',');
      arrayEntityShapes.add(`${part.type}:keys=${keys}`);
      flat.push(typeof part.text === 'string' ? part.text : '');
    }
    if (flat.join('').trim() === '') emptyText++;
  } else if (typeof t === 'string') {
    textString++;
    if (t.trim() === '') emptyText++;
  }
}

console.log('\n== MESSAGE TYPES =='); for (const [k, v] of msgTypes) console.log(`  ${k}: ${v}`);
console.log('\n== TEXT FIELD SHAPE ==');
console.log(`  string: ${textString} | array: ${textArray} | missing: ${textMissing} | empty: ${emptyText}`);
console.log('\n== ENTITY TYPES (inside text arrays) ==');
for (const [k, v] of [...entityTypes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\n== ENTITY SHAPES ==');
for (const s of [...arrayEntityShapes].sort()) console.log('  ' + s);

console.log('\n== KEY FREQUENCY (over all message objects) ==');
for (const [k, v] of [...msgKeyCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log(`\nreplies=${replies} forwards=${forwards} edited=${edits} reactions=${withReactions} sticker_emoji=${stickerEmoji} keyboard/inline=${inlineButtons}`);
console.log(`date range: ${dateMin} .. ${dateMax}`);

// samples of interesting messages
const interesting = msgs.filter(m => Array.isArray(m.text) && m.text.length > 1).slice(0, 3);
console.log('\n== SAMPLE: text-as-array messages ==');
for (const m of interesting) console.log(JSON.stringify({ id: m.id, from: m.from, text: m.text }, null, 1));
const services = msgs.filter(m => m.type !== 'message').slice(0, 5);
console.log('\n== SAMPLE: non-"message" type ==');
for (const s of services) console.log(JSON.stringify(s, null, 1).slice(0, 600));
const keyboard = msgs.find(m => m.inline_bot_buttons || m.keyboard_buttons);
if (keyboard) console.log('\n== SAMPLE: keyboard ==\n' + JSON.stringify(keyboard, null, 1).slice(0, 800));
const sticker = msgs.find(m => m.sticker_emoji);
if (sticker) console.log('\n== SAMPLE: sticker ==\n' + JSON.stringify(sticker, null, 1).slice(0, 600));
const reply = msgs.find(m => m.reply_to_message_id);
if (reply) console.log('\n== SAMPLE: reply ==\n' + JSON.stringify(reply, null, 1).slice(0, 600));
