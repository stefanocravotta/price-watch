import fs from 'node:fs';
import * as cheerio from 'cheerio';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const topic = process.env.NTFY_TOPIC;
const STATE_FILE = 'state.json';
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
state.prices ??= {};
state.seen ??= [];

const headers = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'it-IT,it;q=0.9',
};

const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const tgChat = process.env.TELEGRAM_CHAT_ID;

async function notify(title, message, click) {
  console.log(`[notify] ${title} - ${message}`);
  const jobs = [];
  if (tgToken && tgChat) {
    const text = [title, message, click].filter(Boolean).join('\n');
    jobs.push(
      fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text }),
      }).then(async (r) => { if (!r.ok) console.warn('Telegram errore:', r.status, await r.text()); }),
    );
  }
  if (topic) {
    jobs.push(
      fetch('https://ntfy.sh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, title, message, click, priority: 4 }),
      }),
    );
  }
  await Promise.allSettled(jobs);
}

function parsePrice(text) {
  const tok = text.match(/\d[\d.,]*/)?.[0];
  if (!tok) return null;
  const n = tok.includes(',')
    ? tok.replace(/\./g, '').replace(',', '.')
    : /\.\d{2}$/.test(tok) ? tok : tok.replace(/\./g, '');
  return parseFloat(n) || null;
}

async function checkPage({ name, url, selector, maxPrice, dropPercent = 5 }) {
  const res = await fetch(url, { headers });
  if (!res.ok) return console.warn(`[${name}] HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const price = parsePrice($(selector).first().text());
  if (price == null) return console.warn(`[${name}] prezzo non trovato (selector da rivedere o pagina bloccata)`);

  const prev = state.prices[url];
  const belowMax = maxPrice != null && price <= maxPrice && prev?.notified !== price;
  const bigDrop = prev && price <= prev.last * (1 - dropPercent / 100);
  if (belowMax || bigDrop) {
    await notify(`${name}: ${price} €`, belowMax ? `Sotto soglia (${maxPrice} €)` : `Calo da ${prev.last} € a ${price} €`, url);
  }
  state.prices[url] = { last: price, notified: belowMax || bigDrop ? price : prev?.notified };
  console.log(`[${name}] ${price} €`);
}

async function checkFeed({ name, url, keywords = [] }) {
  const res = await fetch(url, { headers });
  if (!res.ok) return console.warn(`[${name}] HTTP ${res.status}`);
  const xml = await res.text();
  const clean = (s = '') => s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = clean(item.match(/<title>([\s\S]*?)<\/title>/)?.[1]);
    const link = clean(item.match(/<link>([\s\S]*?)<\/link>/)?.[1]);
    if (!link || state.seen.includes(link)) continue;
    state.seen.push(link);
    if (keywords.every((k) => title.toLowerCase().includes(k.toLowerCase()))) {
      await notify(`Offerta: ${name}`, title, link);
    }
  }
}

async function checkTelegram({ name, channel, keywords = [], any = [], maxPrice }) {
  let html;
  for (const host of ['t.me', 'telegram.me']) {
    const res = await fetch(`https://${host}/s/${channel}`, { headers }).catch(() => null);
    if (res?.ok) { html = await res.text(); break; }
  }
  if (!html) return console.warn(`[${name}] canale non raggiungibile (privato o anteprima web disattivata?)`);

  state.init ??= {};
  const first = !state.init[channel]; // al primo giro segno i post come visti senza notificare
  state.init[channel] = true;

  const $ = cheerio.load(html);
  const posts = $('.tgme_widget_message[data-post]').map((_, el) => ({
    id: $(el).attr('data-post'),
    text: $(el).find('.tgme_widget_message_text').first().text(),
  })).get();

  for (const { id, text } of posts) {
    if (state.seen.includes(id)) continue;
    state.seen.push(id);
    if (first) continue;
    const low = text.toLowerCase();
    const okWords = keywords.every((k) => low.includes(k.toLowerCase()))
      && (!any.length || any.some((k) => low.includes(k.toLowerCase())));
    const prices = [...text.matchAll(/(\d[\d.,]*)\s*€|€\s*(\d[\d.,]*)/g)]
      .map((m) => parsePrice(m[1] ?? m[2])).filter(Boolean);
    const okPrice = maxPrice == null || prices.some((p) => p <= maxPrice);
    if (okWords && okPrice) await notify(name, text.slice(0, 300), `https://t.me/${id}`);
  }
}

if (process.env.NOTIFY_TEST) await notify('Test price-watch', 'Le notifiche funzionano', undefined);

for (const p of cfg.pages ?? []) await checkPage(p).catch((e) => console.error(p.name, e.message));
for (const f of cfg.feeds ?? []) await checkFeed(f).catch((e) => console.error(f.name, e.message));
for (const t of cfg.telegram ?? []) await checkTelegram(t).catch((e) => console.error(t.name, e.message));
state.seen = state.seen.slice(-3000);

fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
