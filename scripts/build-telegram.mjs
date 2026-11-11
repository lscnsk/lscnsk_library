// Builds telegram/: the books cut into parts that the CoolRead Telegram bot sends as
// rich messages (one message holds up to 32 768 characters and 500 blocks).
// Run by .github/workflows/catalog.yml after every push; by hand: node scripts/build-telegram.mjs
//
// For every book in catalog.json it writes
//   telegram/<id>/index.json  { title, author, parts, chars, toc: [{ title, part }] }
//   telegram/<id>/<n>.html    part n (from 1) in Telegram's rich HTML
// A part never cuts a paragraph. Each story or chapter from the table of contents starts
// a new part, so "Прибрежный пират" opens from its first line.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const OUT = join(root, 'telegram');
const MAX_CHARS = 28000; // leaves room for the bot's own lines and the notes
const MAX_BLOCKS = 420;
const SMALL_PART = 2500; // a part this short (a dedication) may take the next chapter too
// A longer book is too many messages to read in a chat: only its opening is kept,
// and the bot offers the rest in the CoolRead app
const MAX_PARTS = 40;

// ---- a small XML reader (fb2 files are plain, well-formed XML) ----
const unescape = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parse(xml) {
  const top = { name: '#root', attrs: {}, children: [] };
  const stack = [top];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const cur = stack[stack.length - 1];
    if (m[1] !== undefined) cur.children.push(m[1]);
    else if (m[6] !== undefined) cur.children.push(unescape(m[6]));
    else if (m[3]) {
      const name = m[3].replace(/^.*:/, '').toLowerCase();
      if (m[2]) {
        // closing tag: pop up to the matching element
        for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === name) { stack.length = i; break; }
      } else {
        const attrs = {};
        for (const a of (m[4] || '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
          attrs[a[1].replace(/^.*:/, '').toLowerCase()] = unescape(a[2] ?? a[3] ?? '');
        }
        const el = { name, attrs, children: [] };
        cur.children.push(el);
        if (!m[5]) stack.push(el);
      }
    }
  }
  return top;
}
const kids = (el, name) => el.children.filter(c => typeof c !== 'string' && (!name || c.name === name));
const plain = el => typeof el === 'string' ? el : el.children.map(plain).join('');
const squash = s => s.replace(/\s+/g, ' ').trim();

// ---- fb2 → rich HTML ----
function bookParts(xml) {
  xml = xml.replace(/<binary[\s\S]*?<\/binary>/gi, '');
  const doc = parse(xml);
  const fb = kids(doc).find(c => c.name === 'fictionbook') || doc;
  const bodies = kids(fb, 'body');
  const main = bodies.find(b => !b.attrs.name) || bodies[0];
  if (!main) return null;

  // Notes: <body name="notes"><section id="n1">…</section>
  const notes = new Map();
  for (const b of bodies) {
    if (b === main) continue;
    const walk = el => {
      for (const s of kids(el, 'section')) {
        if (s.attrs.id) {
          const text = squash(kids(s).filter(c => c.name !== 'title').map(plain).join(' '));
          if (text) notes.set(s.attrs.id, text);
        }
        walk(s);
      }
    };
    walk(b);
  }

  // Inline content: <emphasis>, <strong>, links to notes
  let usedNotes = [];
  const inline = el => el.children.map(c => {
    if (typeof c === 'string') return esc(c.replace(/\s+/g, ' '));
    const inner = inline(c);
    switch (c.name) {
      case 'emphasis': return inner.trim() ? `<i>${inner}</i>` : inner;
      case 'strong': return inner.trim() ? `<b>${inner}</b>` : inner;
      case 'strikethrough': return `<s>${inner}</s>`;
      case 'sup': return `<sup>${inner}</sup>`;
      case 'sub': return `<sub>${inner}</sub>`;
      case 'code': return `<code>${inner}</code>`;
      case 'a': {
        const href = c.attrs.href || '';
        const id = href.replace(/^#/, '');
        if (href.startsWith('#') && notes.has(id)) {
          const label = squash(plain(c)).replace(/^\[|\]$/g, '') || String(usedNotes.length + 1);
          usedNotes.push({ id, label });
          return `<sup>[${esc(label)}]</sup>`;
        }
        if (/^https?:\/\//.test(href)) return `<a href="${esc(href).replace(/"/g, '&quot;')}">${inner}</a>`;
        return inner;
      }
      case 'image': return '';
      default: return inner;
    }
  }).join('');
  const lines = el => kids(el).filter(c => c.name === 'p' || c.name === 'v' || c.name === 'subtitle')
    .map(inline).map(s => s.trim()).filter(Boolean);

  // Flat list of blocks: { html, chars, blocks, notes, starts? }
  const out = [];
  const add = (html, chars, extra = {}) => {
    out.push({ html, chars, blocks: 1, notes: usedNotes, ...extra });
    usedNotes = [];
  };
  const quote = (rows, author) => {
    if (!rows.length) return;
    const cite = author ? `<cite>${author}</cite>` : '';
    const html = `<blockquote>${rows.join('<br>')}${cite}</blockquote>`;
    add(html, squash(html.replace(/<[^>]+>/g, '')).length);
  };
  const poem = el => {
    const rows = [];
    for (const c of kids(el)) {
      if (c.name === 'title') rows.push(...lines(c).map(s => `<b>${s}</b>`), '');
      else if (c.name === 'stanza') { if (rows.length && rows[rows.length - 1] !== '') rows.push(''); rows.push(...lines(c)); }
      else if (c.name === 'v' || c.name === 'p') rows.push(inline(c).trim());
    }
    while (rows[rows.length - 1] === '') rows.pop();
    const author = kids(el, 'text-author').map(inline).join(', ');
    quote(rows, author);
  };
  const content = (el, depth) => {
    for (const c of kids(el)) {
      switch (c.name) {
        case 'title': {
          const t = lines(c).join(' · ');
          if (t) add(`<h${Math.min(1 + depth, 5)}>${t}</h${Math.min(1 + depth, 5)}>`, squash(plain(c)).length, { heading: squash(plain(c)) });
          break;
        }
        case 'p': {
          const html = inline(c).trim();
          if (html) add(`<p>${html}</p>`, squash(plain(c)).length);
          break;
        }
        case 'subtitle': {
          const html = inline(c).trim();
          if (html) add(`<h5>${html}</h5>`, squash(plain(c)).length);
          break;
        }
        case 'empty-line': break;
        case 'epigraph':
        case 'cite': {
          const rows = [];
          for (const x of kids(c)) {
            if (x.name === 'p' || x.name === 'subtitle') rows.push(inline(x).trim());
            else if (x.name === 'poem') { for (const st of kids(x, 'stanza')) rows.push(...lines(st)); }
          }
          quote(rows.filter(Boolean), kids(c, 'text-author').map(inline).join(', '));
          break;
        }
        case 'poem': poem(c); break;
        case 'section': section(c, depth + 1); break;
        case 'table':
          for (const tr of kids(c, 'tr')) {
            const row = kids(tr).map(inline).map(s => s.trim()).filter(Boolean).join(' | ');
            if (row) add(`<p>${row}</p>`, squash(plain(tr)).length);
          }
          break;
        default: break;
      }
    }
  };
  const section = (el, depth) => {
    out.push({ html: '', chars: 0, blocks: 0, notes: [], starts: el });
    content(el, depth);
    out.push({ html: '', chars: 0, blocks: 0, notes: [], ends: el });
  };

  // Table of contents: the titled sections at the first level that has more than one
  let level = kids(main, 'section');
  while (level.filter(s => kids(s, 'title').length).length === 1 && level.length === 1) level = kids(level[0], 'section');
  const tocSet = new Set(level.filter(s => kids(s, 'title').length && squash(plain(kids(s, 'title')[0]))));

  // The book's own title is the card's job; skip it here
  content({ ...main, children: main.children.filter(c => typeof c === 'string' || c.name !== 'title') }, 0);

  // Length of every section, to keep a chapter whole when it fits
  const sizeOf = new Map();
  {
    const open = [];
    for (const b of out) {
      if (b.starts) open.push({ el: b.starts, chars: 0, blocks: 0 });
      else if (b.ends) { const o = open.pop(); sizeOf.set(o.el, o); if (open.length) { open[open.length - 1].chars += o.chars; open[open.length - 1].blocks += o.blocks; } }
      else if (open.length) { open[open.length - 1].chars += b.chars; open[open.length - 1].blocks += b.blocks; }
    }
  }

  // Pack the blocks into parts
  const parts = [];
  let cur = null;
  const toc = [];
  const noteChars = n => n.reduce((s, x) => s + (notes.get(x.id) || '').length + x.label.length + 3, 0);
  const newPart = () => { cur = { html: [], chars: 0, blocks: 0, notes: [] }; parts.push(cur); };
  newPart();
  for (const b of out) {
    if (b.ends) continue;
    if (b.starts) {
      const size = sizeOf.get(b.starts) || { chars: 0, blocks: 0 };
      const isToc = tocSet.has(b.starts);
      const fits = cur.chars + size.chars <= MAX_CHARS && cur.blocks + size.blocks <= MAX_BLOCKS;
      if (cur.chars > 0 && ((isToc && cur.chars >= SMALL_PART) || !fits && cur.chars >= SMALL_PART)) newPart();
      if (isToc) toc.push({ title: squash(plain(kids(b.starts, 'title')[0])), part: parts.length });
      continue;
    }
    const extra = noteChars(b.notes);
    if (cur.chars > 0 && (cur.chars + b.chars + extra > MAX_CHARS || cur.blocks + b.blocks + b.notes.length + 2 > MAX_BLOCKS)) newPart();
    cur.html.push(b.html);
    cur.chars += b.chars + extra;
    cur.blocks += b.blocks + b.notes.length;
    cur.notes.push(...b.notes);
  }
  while (parts.length > 1 && parts[parts.length - 1].chars === 0) parts.pop();

  const html = parts.map(p => {
    let s = p.html.join('\n');
    if (p.notes.length) {
      const seen = new Set();
      const items = p.notes.filter(n => !seen.has(n.id) && seen.add(n.id))
        .map(n => `<p><b>[${esc(n.label)}]</b> ${esc(notes.get(n.id))}</p>`);
      s += `\n<details><summary>Примечания</summary>${items.join('')}</details>`;
    }
    return s;
  });
  const chars = parts.reduce((s, p) => s + p.chars, 0);
  return { html, toc, chars };
}

// ---- all books from catalog.json ----
const catalog = JSON.parse(readFileSync(join(root, 'catalog.json'), 'utf8'));
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let total = 0;
for (const b of catalog.books || []) {
  const r = bookParts(readFileSync(join(root, b.path || b.filename), 'utf8'));
  if (!r || !r.html.length) continue;
  const all = r.html.length;
  const excerpt = all > MAX_PARTS;
  if (excerpt) { r.html = r.html.slice(0, 1); r.toc = r.toc.filter(t => t.part === 1); }
  const dir = join(OUT, b.id);
  mkdirSync(dir, { recursive: true });
  r.html.forEach((h, i) => writeFileSync(join(dir, `${i + 1}.html`), h + '\n'));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    title: b.title, author: b.author, edition: b.edition, parts: r.html.length, chars: r.chars, toc: r.toc,
    ...(excerpt ? { excerpt: true, fullParts: all } : {}),
  }, null, 1) + '\n');
  total += r.html.length;
  console.log(`${b.id}: ${excerpt ? `opening only (of ${all})` : `${all} parts`}, ${r.toc.length} in contents, ${r.chars} characters`);
}
console.log(`telegram/: ${total} parts`);
