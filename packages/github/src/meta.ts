/** hub 裡給程式讀的數據都藏在 HTML 註解裡：GitHub 網頁上看不到，編輯時看得到。
 *
 *  - Issue 正文末尾的區塊：`<!-- apm:project … -->`、`<!-- apm:task … -->`，內容是每行一個 `key: value` 的極簡 YAML
 *  - 留言開頭的區塊：`<!-- apm {"kind":"checkpoint",…} -->`，內容是一行 JSON，下面是給人看的文字 */

export type Scalar = string | number | boolean | null;
export type Value = Scalar | Scalar[];
export type Block = Record<string, Value>;

/** `-->` 會提前結束 HTML 註解，寫進去之前換成等價的 JSON 跳脫 */
const safe = (s: string) => s.replace(/-->/g, '--\\u003e');

function parseScalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}

/** 把列表內容按逗號切開，但不切雙引號裡的逗號 */
function splitList(inner: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== '\\') quoted = !quoted;
    if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parseYamlish(text: string): Block {
  const out: Block = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const rest = line.slice(i + 1).trim();
    if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = splitList(rest.slice(1, -1))
        .map(parseScalar)
        .filter((v) => v !== null);
    } else out[key] = parseScalar(rest);
  }
  return out;
}

function fmtScalar(v: Scalar): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  const plain = /^[^\s"'#[\],:{}][^"#[\],:{}]*$/.test(v) && v === v.trim();
  const ambiguous = /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v);
  return plain && !ambiguous ? v : safe(JSON.stringify(v));
}

export function stringifyYamlish(data: Block): string {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(fmtScalar).join(', ')}]` : fmtScalar(v)}`)
    .join('\n');
}

// ───────────────────────── Issue 正文裡的區塊 ─────────────────────────

const blockRe = (tag: string) => new RegExp(`\\n*<!--\\s*${tag.replace(/[:]/g, '\\:')}\\s*\\n([\\s\\S]*?)-->\\s*$`);

/** 從 Issue 正文讀出 `<!-- apm:task … -->` 區塊；rest 是去掉區塊後給人看的部分 */
export function readBodyBlock(body: string | null | undefined, tag: string): { data: Block | null; rest: string } {
  const text = body ?? '';
  const m = text.match(blockRe(tag));
  if (!m) return { data: null, rest: text.trim() };
  return { data: parseYamlish(m[1]), rest: text.slice(0, m.index).trim() };
}

export function writeBodyBlock(rest: string, tag: string, data: Block): string {
  const head = rest.trim();
  return `${head ? `${head}\n\n` : ''}<!-- ${tag}\n${stringifyYamlish(data)}\n-->\n`;
}

// ───────────────────────── 留言開頭的 JSON ─────────────────────────

const commentRe = /^\s*<!--\s*apm\s+(\{[\s\S]*?\})\s*-->\s*\n?/;

export function readCommentMeta<T = Record<string, unknown>>(body: string | null | undefined): { meta: T; text: string } | null {
  const m = (body ?? '').match(commentRe);
  if (!m) return null;
  try {
    return { meta: JSON.parse(m[1]) as T, text: (body ?? '').slice(m[0].length) };
  } catch {
    return null;
  }
}

export function writeComment(meta: object, text: string): string {
  return `<!-- apm ${safe(JSON.stringify(meta))} -->\n${text.trim()}\n`;
}

// ───────────────────────── 任務正文的兩段 ─────────────────────────

const DESC_H = '## 說明';
const ACC_H = '## 驗收標準';

export function taskBody(description: string, acceptance: string): string {
  const parts: string[] = [];
  parts.push(`${DESC_H}\n\n${description.trim() || '（沒有說明）'}`);
  if (acceptance.trim()) parts.push(`${ACC_H}\n\n${acceptance.trim()}`);
  return parts.join('\n\n');
}

export function splitTaskBody(rest: string): { description: string; acceptance: string } {
  const a = rest.indexOf(ACC_H);
  const before = a >= 0 ? rest.slice(0, a) : rest;
  const acceptance = a >= 0 ? rest.slice(a + ACC_H.length).trim() : '';
  const description = before.replace(DESC_H, '').trim();
  return { description: description === '（沒有說明）' ? '' : description, acceptance };
}

export const asList = (v: Value | undefined): string[] =>
  Array.isArray(v) ? v.filter((x) => x !== null).map(String) : v === null || v === undefined || v === '' ? [] : [String(v)];

export const asNum = (v: Value | undefined, dflt: number | null): number | null =>
  typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : dflt;
