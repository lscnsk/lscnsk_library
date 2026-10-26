// Builds catalog.json: the list of books the CoolRead app shows in its lscnsk catalog.
// Run by .github/workflows/catalog.yml after every push; by hand: node scripts/build-catalog.mjs
// Everything comes from the fb2 files themselves (title, author, series, date, annotation),
// and the cover from covers/<name>.jpg (or .png/.webp) when there is one.
// The same file feeds the showcase site (lscnsk/library), which reads the fields coverUrl,
// fileSize, annotation, genres and path; the app reads cover, size and description.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = 'https://raw.githubusercontent.com/lscnsk/lscnsk_library/main';
const root = new URL('..', import.meta.url).pathname;
const covers = new Map(
  (() => { try { return readdirSync(join(root, 'covers')); } catch { return []; } })()
    .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
    .map(f => [f.replace(/\.[^.]+$/, '').toLowerCase(), f]),
);

const unescape = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const text = s => unescape((s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const tag = (xml, name) => xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))?.[1];

function book(file) {
  const raw = readFileSync(join(root, file), 'utf8');
  const xml = raw.replace(/<binary[\s\S]*?<\/binary>/gi, '');
  const info = tag(xml, 'title-info') || '';
  const id = file.replace(/\.fb2$/i, '');

  const authors = [...info.matchAll(/<author>([\s\S]*?)<\/author>/gi)].map(([, a]) =>
    [tag(a, 'first-name'), tag(a, 'last-name')].map(text).filter(Boolean).join(' ') || text(tag(a, 'nickname')),
  ).filter(Boolean);
  const seq = info.match(/<sequence\b[^>]*>/i)?.[0] || '';
  const attr = n => unescape(seq.match(new RegExp(`${n}=["']([^"']*)["']`))?.[1] || '').trim();
  const annotation = tag(info, 'annotation');
  const description = annotation
    ? annotation.split(/<\/p>|<empty-line\s*\/>/i).map(text).filter(Boolean).join('\n\n')
    : '';
  const body = xml.match(/<body[\s\S]*<\/body>/i)?.[0] || '';
  const chars = unescape(body.replace(/<[^>]+>/g, '')).length;
  const cover = covers.get(id.toLowerCase());
  const genres = [...info.matchAll(/<genre[^>]*>([\s\S]*?)<\/genre>/gi)].map(([, g]) => text(g)).filter(Boolean);
  const size = statSync(join(root, file)).size;
  const lang = text(tag(info, 'lang'));

  return {
    id,
    filename: file,
    title: text(tag(info, 'book-title')) || id,
    author: authors.join(', ') || 'Неизвестный автор',
    ...(attr('name') ? { series: attr('name') } : {}),
    ...(attr('number') ? { seriesNumber: Number(attr('number')) || attr('number') } : {}),
    ...(text(tag(info, 'date')) ? { year: text(tag(info, 'date')) } : {}),
    ...(description ? { description } : {}),
    ...(cover ? { cover: `covers/${cover}` } : {}),
    size,
    pageCount: Math.max(1, Math.round(chars / 1850)),
    // For the showcase site
    path: file,
    format: 'fb2',
    fileSize: size,
    genres,
    ...(description ? { annotation: description } : {}),
    ...(cover ? { coverUrl: `${RAW}/covers/${encodeURIComponent(cover)}` } : {}),
    ...(lang ? { language: lang } : {}),
  };
}

const books = readdirSync(root).filter(f => /\.fb2$/i.test(f)).sort().map(book);
writeFileSync(join(root, 'catalog.json'), JSON.stringify({ version: 1, books }, null, 2) + '\n');
console.log(`catalog.json: ${books.length} books`);
