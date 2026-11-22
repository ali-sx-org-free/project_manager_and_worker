#!/usr/bin/env node
// apm 0.2.0 · agent-pm 命令行（由 scripts/build-apm.mjs 從 packages/github 打包，不要手改）

// packages/github/src/cli.ts
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir as homedir2, hostname as hostname2 } from "node:os";
import { dirname as dirname3, join as join3, resolve } from "node:path";

// packages/github/src/client.ts
import { execFileSync } from "node:child_process";
var GitHubError = class extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
    this.name = "GitHubError";
  }
  status;
  data;
};
var fetchTransport = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers = {};
  res.headers.forEach((v, k) => headers[k.toLowerCase()] = v);
  return { status: res.status, headers, text: await res.text() };
};
function resolveToken() {
  const env = process.env.APM_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env.trim();
  try {
    const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return t || void 0;
  } catch {
    return void 0;
  }
}
var GitHub = class {
  apiBase;
  transport;
  token;
  localNow;
  offset = 0;
  synced = false;
  rate = null;
  etagCache;
  /** 統計：請求數、其中 304 的數目 */
  stats = { requests: 0, notModified: 0 };
  constructor(opts = {}) {
    this.etagCache = opts.etags ? /* @__PURE__ */ new Map() : null;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.transport = opts.transport ?? fetchTransport;
    this.token = opts.token;
    this.localNow = opts.now ?? Date.now;
  }
  /** 以 GitHub 的時鐘為準的「現在」（毫秒） */
  now() {
    return this.localNow() + this.offset;
  }
  async syncClock() {
    if (!this.synced) await this.request("GET", "/rate_limit");
  }
  async request(method, path, body, opts = {}) {
    const url = path.startsWith("http") ? path : `${this.apiBase}${path}`;
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agent-pm-apm"
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== void 0) headers["content-type"] = "application/json";
    const cached = method === "GET" ? this.etagCache?.get(url) : void 0;
    if (cached) headers["if-none-match"] = cached.etag;
    let res;
    let lastErr;
    let slowdowns = 0;
    for (let i = 0; i < 3; i++) {
      try {
        res = await this.transport({ method, url, headers, body: body !== void 0 ? JSON.stringify(body) : void 0 });
        if ((res.status === 403 || res.status === 429) && slowdowns < 2 && /secondary rate limit|abuse/i.test(res.text)) {
          const wait = Math.min(120, Number(res.headers["retry-after"]) || 30 * (slowdowns + 1));
          slowdowns++;
          i--;
          process.stderr.write(`GitHub \u8981\u6C42\u653E\u6162\u5BEB\u5165\u901F\u5EA6\uFF0C\u7B49 ${wait} \u79D2\u518D\u8A66\u2026
`);
          await new Promise((r) => setTimeout(r, wait * 1e3));
          continue;
        }
        if (res.status < 500) break;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    if (!res) throw new GitHubError(0, `\u9023\u4E0D\u4E0A GitHub\uFF1A${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    this.stats.requests++;
    if (res.status === 304 && cached) {
      this.stats.notModified++;
      res = { ...res, status: 200, text: cached.text };
    } else if (method === "GET" && this.etagCache && res.status === 200 && res.headers["etag"]) {
      this.etagCache.set(url, { etag: res.headers["etag"], text: res.text });
    }
    const date = res.headers["date"];
    if (date) {
      const t = Date.parse(date);
      if (!Number.isNaN(t)) {
        this.offset = t - this.localNow();
        this.synced = true;
      }
    }
    if (res.headers["x-ratelimit-remaining"]) {
      this.rate = {
        limit: Number(res.headers["x-ratelimit-limit"]),
        remaining: Number(res.headers["x-ratelimit-remaining"]),
        reset: Number(res.headers["x-ratelimit-reset"]) * 1e3
      };
    }
    let data = null;
    if (res.text) {
      try {
        data = JSON.parse(res.text);
      } catch {
        data = res.text;
      }
    }
    if (res.status === 404 && opts.accept404) return { status: 404, data: null, headers: res.headers };
    if (res.status >= 400) {
      const msg = data?.message ?? `HTTP ${res.status}`;
      const hint = res.status === 401 ? "\uFF08GitHub \u767B\u5165\u7121\u6548\uFF1A\u57F7\u884C gh auth login\uFF09" : res.status === 403 && /rate limit/i.test(msg) ? "\uFF08API \u984D\u5EA6\u7528\u5B8C\uFF0C\u7A0D\u5F8C\u518D\u8A66\uFF09" : res.status === 404 ? "\uFF08\u4E0D\u5B58\u5728\uFF0C\u6216\u4F60\u6C92\u6709\u9019\u500B\u5009\u5EAB\u7684\u6B0A\u9650\uFF09" : "";
      throw new GitHubError(res.status, `${method} ${path}\uFF1A${msg}${hint}`, data);
    }
    return { status: res.status, data, headers: res.headers };
  }
  get(path) {
    return this.request("GET", path).then((r) => r.data);
  }
  async getOrNull(path) {
    const r = await this.request("GET", path, void 0, { accept404: true });
    return r.status === 404 ? null : r.data;
  }
  post(path, body) {
    return this.request("POST", path, body).then((r) => r.data);
  }
  patch(path, body) {
    return this.request("PATCH", path, body).then((r) => r.data);
  }
  put(path, body) {
    return this.request("PUT", path, body).then((r) => r.data);
  }
  del(path) {
    return this.request("DELETE", path).then(() => void 0);
  }
  /** 逐頁讀完一個列表（每頁 100 筆） */
  async paginate(path, max = 50) {
    const out2 = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= max; page++) {
      const items = await this.get(`${path}${sep}per_page=100&page=${page}`);
      out2.push(...items);
      if (items.length < 100) break;
    }
    return out2;
  }
};

// packages/github/src/locks.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
var LOCK_PREFIX = "apm-lock/";
var lockBranch = (task) => `${LOCK_PREFIX}${task}`;
var isAlive = (l, now) => !!l && l.status === "held" && l.expires_at !== null && l.expires_at > now;
function parseLock(sha, subject) {
  try {
    const p = JSON.parse(subject);
    if (p && typeof p.task === "number" && typeof p.worker === "string") return { ...p, sha };
  } catch {
  }
  return null;
}
var MemoryLockStore = class {
  /** 測試用：每次操作前讓出事件循環，模擬網路延遲造成的交錯 */
  constructor(jitter = 0) {
    this.jitter = jitter;
  }
  jitter;
  refs = /* @__PURE__ */ new Map();
  seq = 0;
  async tick() {
    if (this.jitter) await new Promise((r) => setTimeout(r, Math.random() * this.jitter));
  }
  mk(p) {
    return { ...p, sha: `m${(++this.seq).toString(16).padStart(8, "0")}` };
  }
  async list() {
    await this.tick();
    return new Map(this.refs);
  }
  async get(task) {
    await this.tick();
    return this.refs.get(task) ?? null;
  }
  async create(p) {
    await this.tick();
    if (this.refs.has(p.task)) return null;
    const l = this.mk(p);
    this.refs.set(p.task, l);
    return l;
  }
  async advance(prevSha, p) {
    await this.tick();
    if (this.refs.get(p.task)?.sha !== prevSha) return null;
    const l = this.mk(p);
    this.refs.set(p.task, l);
    return l;
  }
  async force(p) {
    await this.tick();
    const l = this.mk(p);
    this.refs.set(p.task, l);
    return l;
  }
  async remove(task, expectSha) {
    await this.tick();
    if (this.refs.get(task)?.sha !== expectSha) return false;
    this.refs.delete(task);
    return true;
  }
};
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
var CONFLICT_RE = /stale info|cannot lock ref|fetch first|non-fast-forward|already exists|\[rejected\]|\[remote rejected\]/i;
var AUTH_RE = /HTTP 40[13]|Permission to .* denied|Authentication failed|could not read Username|terminal prompts disabled|Repository not found/i;
var LOCAL_LOCK_RE = /Unable to create .*\.lock|cannot lock ref '?refs\/apm|could not lock config file|shallow.*lock/i;
var GitLockStore = class {
  constructor(opts) {
    this.opts = opts;
  }
  opts;
  ready = null;
  env() {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "agent-pm",
      GIT_AUTHOR_EMAIL: "agent-pm@users.noreply.github.com",
      GIT_COMMITTER_NAME: "agent-pm",
      GIT_COMMITTER_EMAIL: "agent-pm@users.noreply.github.com"
    };
    if (this.opts.token && this.opts.remoteUrl.startsWith("https://github.com/") && process.env.APM_GIT_AUTH !== "none") {
      const basic = Buffer.from(`x-access-token:${this.opts.token}`).toString("base64");
      const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
      env.GIT_CONFIG_COUNT = String(n + 1);
      env[`GIT_CONFIG_KEY_${n}`] = "http.https://github.com/.extraheader";
      env[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${basic}`;
    }
    return env;
  }
  git(args, input, extraEnv = {}) {
    return new Promise((resolve2, reject) => {
      const p = spawn("git", ["--git-dir", this.opts.dir, ...args], {
        env: { ...this.env(), ...extraEnv },
        stdio: ["pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => stdout += d);
      p.stderr.on("data", (d) => stderr += d);
      p.on(
        "error",
        (err) => reject(new Error(`\u627E\u4E0D\u5230 git\uFF08${err.message}\uFF09\u3002\u8ACB\u5148\u5B89\u88DD git\uFF1Ahttps://git-scm.com/downloads`))
      );
      p.on("close", (code) => resolve2({ code: code ?? 1, stdout, stderr }));
      p.stdin.on("error", () => void 0);
      if (input) p.stdin.end(input);
      else p.stdin.end();
    });
  }
  /** 本機並行的 apm 進程（例如 keepalive 和 checkpoint）可能同時改本機的 ref，碰到檔案鎖就稍等重試 */
  async gitRetry(args, input, extraEnv) {
    let r = { code: 1, stdout: "", stderr: "" };
    for (let i = 0; i < 5; i++) {
      r = await this.git(args, input, extraEnv);
      if (r.code === 0 || !LOCAL_LOCK_RE.test(r.stderr)) return r;
      await new Promise((res) => setTimeout(res, 100 + Math.random() * 400));
    }
    return r;
  }
  ensure() {
    this.ready ??= (async () => {
      if (!existsSync(`${this.opts.dir}/HEAD`)) {
        mkdirSync(dirname(this.opts.dir), { recursive: true });
        await new Promise((resolve2, reject) => {
          const p = spawn("git", ["init", "--bare", "-q", this.opts.dir], { stdio: "ignore" });
          p.on("error", (err) => reject(new Error(`\u627E\u4E0D\u5230 git\uFF08${err.message}\uFF09`)));
          p.on("close", () => resolve2());
        });
      }
      await this.gitRetry(["config", "remote.origin.url", this.opts.remoteUrl]);
      await this.git(["hash-object", "-w", "-t", "tree", "--stdin"], "");
    })();
    return this.ready;
  }
  fail(what, r) {
    const text = (r.stderr || r.stdout).trim().split("\n").slice(-4).join(" / ");
    if (AUTH_RE.test(text)) {
      return new Error(`${what}\u5931\u6557\uFF1A\u6C92\u6709 hub \u5009\u5EAB\u7684\u63A8\u9001\u6B0A\u9650\uFF0C\u6216 git \u6C92\u6709\u767B\u5165\uFF08${text}\uFF09`);
    }
    return new Error(`${what}\u5931\u6557\uFF1A${text}`);
  }
  async readLocal() {
    const r = await this.git(["for-each-ref", "--format=%(refname)%09%(objectname)%09%(contents:subject)", "refs/apm/lock/"]);
    const out2 = /* @__PURE__ */ new Map();
    for (const line of r.stdout.split("\n")) {
      if (!line) continue;
      const [ref, sha, ...rest] = line.split("	");
      const n = Number(ref.slice("refs/apm/lock/".length));
      if (!Number.isInteger(n)) continue;
      const l = parseLock(sha, rest.join("	"));
      if (l) out2.set(n, l);
    }
    return out2;
  }
  async list() {
    await this.ensure();
    const r = await this.gitRetry([
      "fetch",
      "-q",
      "--prune",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/heads/${LOCK_PREFIX}*:refs/apm/lock/*`
    ]);
    if (r.code !== 0) {
      const ls = await this.git(["ls-remote", "--heads", "origin", `${LOCK_PREFIX}*`]);
      if (ls.code !== 0) throw this.fail("\u8B80\u53D6 hub \u7684\u9396", ls.stderr ? ls : r);
      if (ls.stdout.trim()) throw this.fail("\u8B80\u53D6 hub \u7684\u9396", r);
      for (const n of (await this.readLocal()).keys()) await this.git(["update-ref", "-d", `refs/apm/lock/${n}`]);
      return /* @__PURE__ */ new Map();
    }
    return this.readLocal();
  }
  async get(task) {
    await this.ensure();
    const r = await this.gitRetry([
      "fetch",
      "-q",
      "--no-tags",
      "--depth=1",
      "origin",
      `+refs/heads/${lockBranch(task)}:refs/apm/lock/${task}`
    ]);
    if (r.code !== 0) {
      if (/couldn't find remote ref|no such ref/i.test(r.stderr)) {
        await this.git(["update-ref", "-d", `refs/apm/lock/${task}`]);
        return null;
      }
      throw this.fail("\u8B80\u53D6\u9396", r);
    }
    return (await this.readLocal()).get(task) ?? null;
  }
  async commit(payload, parent) {
    const date = `${Math.floor(payload.at / 1e3)} +0000`;
    const args = ["commit-tree", EMPTY_TREE, "-m", JSON.stringify(payload)];
    if (parent) args.push("-p", parent);
    const r = await this.git(args, void 0, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    if (r.code !== 0) throw this.fail("\u5EFA\u7ACB\u9396\u7684 commit", r);
    return r.stdout.trim();
  }
  /** 帶「預期舊值」推送。expect 為空字串表示「分支必須還不存在」 */
  async push(task, sha, expect) {
    const ref = `refs/heads/${lockBranch(task)}`;
    const r = await this.git(["push", "-q", "--porcelain", `--force-with-lease=${ref}:${expect}`, "origin", `${sha}:${ref}`]);
    const out2 = `${r.stdout}
${r.stderr}`;
    if (r.code === 0) {
      await this.gitRetry(["update-ref", `refs/apm/lock/${task}`, sha]);
      return "ok";
    }
    if (CONFLICT_RE.test(out2) && !AUTH_RE.test(out2)) return "conflict";
    throw this.fail("\u5BEB\u5165\u9396", r);
  }
  async create(payload) {
    await this.ensure();
    const sha = await this.commit(payload);
    return await this.push(payload.task, sha, "") === "ok" ? { ...payload, sha } : null;
  }
  async advance(prevSha, payload) {
    await this.ensure();
    const has = async () => (await this.git(["cat-file", "-e", `${prevSha}^{commit}`])).code === 0;
    if (!await has()) {
      const cur = await this.get(payload.task);
      if (!cur || cur.sha !== prevSha || !await has()) return null;
    }
    const sha = await this.commit(payload, prevSha);
    return await this.push(payload.task, sha, prevSha) === "ok" ? { ...payload, sha } : null;
  }
  async force(payload) {
    await this.ensure();
    for (let i = 0; i < 4; i++) {
      const cur = await this.get(payload.task);
      const sha = await this.commit(payload, cur?.sha);
      if (await this.push(payload.task, sha, cur?.sha ?? "") === "ok") return { ...payload, sha };
    }
    throw new Error(`\u5F37\u5236\u6539\u5BEB\u4EFB\u52D9 #${payload.task} \u7684\u9396\u5931\u6557\uFF1A\u4E00\u76F4\u6709\u4EBA\u5728\u6539\u5B83`);
  }
  async remove(task, expectSha) {
    await this.ensure();
    const ref = `refs/heads/${lockBranch(task)}`;
    const r = await this.git(["push", "-q", "--porcelain", `--force-with-lease=${ref}:${expectSha}`, "origin", `:${ref}`]);
    if (r.code === 0) {
      await this.git(["update-ref", "-d", `refs/apm/lock/${task}`]);
      return true;
    }
    if (CONFLICT_RE.test(`${r.stdout}
${r.stderr}`) && !AUTH_RE.test(r.stderr)) return false;
    throw this.fail("\u522A\u9664\u9396", r);
  }
  /** hub 還是空倉庫時，推一個初始 commit 到預設分支（設定檔和說明）。已有該分支就不動。 */
  async initBranch(branch, files, message) {
    await this.ensure();
    const ls = await this.git(["ls-remote", "--heads", "origin", branch]);
    if (ls.code !== 0) throw this.fail("\u8B80\u53D6 hub", ls);
    if (ls.stdout.trim()) return "exists";
    const dirs = /* @__PURE__ */ new Map();
    const top = [];
    for (const [path, content] of Object.entries(files)) {
      const blob = (await this.git(["hash-object", "-w", "--stdin"], content)).stdout.trim();
      const parts = path.split("/");
      if (parts.length === 1) top.push(`100644 blob ${blob}	${path}`);
      else {
        const list2 = dirs.get(parts[0]) ?? [];
        list2.push(`100644 blob ${blob}	${parts.slice(1).join("/")}`);
        dirs.set(parts[0], list2);
      }
    }
    for (const [d, entries] of dirs) {
      const tree2 = (await this.git(["mktree"], entries.join("\n") + "\n")).stdout.trim();
      top.push(`040000 tree ${tree2}	${d}`);
    }
    const tree = (await this.git(["mktree"], top.join("\n") + "\n")).stdout.trim();
    const sha = (await this.git(["commit-tree", tree, "-m", message])).stdout.trim();
    const ref = `refs/heads/${branch}`;
    const r = await this.git(["push", "-q", "--porcelain", `--force-with-lease=${ref}:`, "origin", `${sha}:${ref}`]);
    if (r.code === 0) return "created";
    if (CONFLICT_RE.test(`${r.stdout}
${r.stderr}`)) return "exists";
    throw this.fail("\u521D\u59CB\u5316 hub", r);
  }
};

// packages/github/src/meta.ts
var safe = (s) => s.replace(/-->/g, "--\\u003e");
function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  return s;
}
function splitList(inner) {
  const out2 = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && inner[i - 1] !== "\\") quoted = !quoted;
    if (c === "," && !quoted) {
      out2.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out2.push(cur);
  return out2;
}
function parseYamlish(text) {
  const out2 = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const rest = line.slice(i + 1).trim();
    if (rest.startsWith("[") && rest.endsWith("]")) {
      out2[key] = splitList(rest.slice(1, -1)).map(parseScalar).filter((v) => v !== null);
    } else out2[key] = parseScalar(rest);
  }
  return out2;
}
function fmtScalar(v) {
  if (v === null) return "null";
  if (typeof v !== "string") return String(v);
  const plain = /^[^\s"'#[\],:{}][^"#[\],:{}]*$/.test(v) && v === v.trim();
  const ambiguous = /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v);
  return plain && !ambiguous ? v : safe(JSON.stringify(v));
}
function stringifyYamlish(data) {
  return Object.entries(data).filter(([, v]) => v !== void 0).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(fmtScalar).join(", ")}]` : fmtScalar(v)}`).join("\n");
}
var blockRe = (tag) => new RegExp(`\\n*<!--\\s*${tag.replace(/[:]/g, "\\:")}\\s*\\n([\\s\\S]*?)-->\\s*$`);
function readBodyBlock(body, tag) {
  const text = body ?? "";
  const m = text.match(blockRe(tag));
  if (!m) return { data: null, rest: text.trim() };
  return { data: parseYamlish(m[1]), rest: text.slice(0, m.index).trim() };
}
function writeBodyBlock(rest, tag, data) {
  const head = rest.trim();
  return `${head ? `${head}

` : ""}<!-- ${tag}
${stringifyYamlish(data)}
-->
`;
}
var commentRe = /^\s*<!--\s*apm\s+(\{[\s\S]*?\})\s*-->\s*\n?/;
function readCommentMeta(body) {
  const m = (body ?? "").match(commentRe);
  if (!m) return null;
  try {
    return { meta: JSON.parse(m[1]), text: (body ?? "").slice(m[0].length) };
  } catch {
    return null;
  }
}
function writeComment(meta, text) {
  return `<!-- apm ${safe(JSON.stringify(meta))} -->
${text.trim()}
`;
}
var DESC_H = "## \u8AAA\u660E";
var ACC_H = "## \u9A57\u6536\u6A19\u6E96";
function taskBody(description, acceptance) {
  const parts = [];
  parts.push(`${DESC_H}

${description.trim() || "\uFF08\u6C92\u6709\u8AAA\u660E\uFF09"}`);
  if (acceptance.trim()) parts.push(`${ACC_H}

${acceptance.trim()}`);
  return parts.join("\n\n");
}
function splitTaskBody(rest) {
  const a = rest.indexOf(ACC_H);
  const before = a >= 0 ? rest.slice(0, a) : rest;
  const acceptance = a >= 0 ? rest.slice(a + ACC_H.length).trim() : "";
  const description = before.replace(DESC_H, "").trim();
  return { description: description === "\uFF08\u6C92\u6709\u8AAA\u660E\uFF09" ? "" : description, acceptance };
}
var asList = (v) => Array.isArray(v) ? v.filter((x) => x !== null).map(String) : v === null || v === void 0 || v === "" ? [] : [String(v)];
var asNum = (v, dflt) => typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : dflt;

// packages/github/src/hub.ts
function parseRepo(s) {
  const m = (s ?? "").trim().match(/^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`hub \u5009\u5EAB\u8981\u5BEB\u6210 owner/repo\uFF0C\u4F8B\u5982 ali-sx-org-free/agent-pm-hub\uFF08\u6536\u5230\u300C${s ?? ""}\u300D\uFF09`);
  return { owner: m[1], name: m[2] };
}
var repoName = (r) => `${r.owner}/${r.name}`;
var DEFAULT_CONFIG = { lease_minutes: 10, heartbeat_minutes: 2, idle_minutes: 30, admins: [] };
var LABELS = {
  project: "apm:project",
  task: "apm:task",
  roster: "apm:roster",
  human: "review:human"
};
var STATUS_LABEL = {
  pending: "status:pending",
  ready: "status:ready",
  claimed: "status:claimed",
  in_review: "status:in-review",
  changes_requested: "status:changes-requested",
  blocked: "status:blocked",
  done: null
};
var LABEL_STATE = new Map(
  Object.entries(STATUS_LABEL).filter(([, l]) => l).map(([s, l]) => [l, s])
);
var LABEL_COLORS = {
  "apm:project": "5319e7",
  "apm:task": "8a63d2",
  "apm:roster": "c5def5",
  "review:human": "d93f0b",
  "status:pending": "bfbfbf",
  "status:ready": "0e8a16",
  "status:claimed": "fbca04",
  "status:in-review": "6f42c1",
  "status:changes-requested": "e99695",
  "status:blocked": "b60205"
};
var labelColor = (name) => LABEL_COLORS[name] ?? (name.startsWith("project:") ? "1d76db" : name.startsWith("cap:") ? "ededed" : "cccccc");
var ts = (s) => s ? Date.parse(s) : 0;
var labelNames = (i) => i.labels.map((l) => typeof l === "string" ? l : l.name);
function toProject(i) {
  const { data, rest } = readBodyBlock(i.body, "apm:project");
  const key = data?.key ? String(data.key) : labelNames(i).find((l) => l.startsWith("project:"))?.slice(8);
  if (!key) return null;
  const b = data ?? {};
  return {
    number: i.number,
    issue_id: i.id,
    key,
    title: i.title,
    description: rest,
    priority: Math.max(1, Math.min(5, asNum(b.priority, 3) ?? 3)),
    max_parallel: b.max_parallel === null || b.max_parallel === "none" ? null : asNum(b.max_parallel, null),
    repo: b.repo ? String(b.repo) : null,
    base: b.base ? String(b.base) : null,
    merge_on_approve: b.merge_on_approve !== false,
    kind: b.kind === "chore" ? "chore" : "dev",
    managers: asList(b.managers),
    contributors: asList(b.contributors),
    viewers: asList(b.viewers),
    open: i.state === "open",
    author: i.user?.login ?? "",
    created_at: ts(i.created_at),
    closed_at: i.closed_at ? ts(i.closed_at) : null,
    url: i.html_url,
    block: b,
    rest
  };
}
function toTask(i) {
  const { data, rest } = readBodyBlock(i.body, "apm:task");
  if (!data) return null;
  const project = asNum(data.project, null);
  if (project === null) return null;
  const labels = labelNames(i);
  const { description, acceptance } = splitTaskBody(rest);
  return {
    number: i.number,
    issue_id: i.id,
    key: String(data.key ?? `t${i.number}`),
    project,
    title: i.title,
    description,
    acceptance,
    caps: asList(data.caps),
    deps: asList(data.deps).map((d) => Number(d.replace(/^#/, ""))).filter((n) => Number.isInteger(n)),
    branch: data.branch ? String(data.branch) : null,
    status: labels.map((l) => LABEL_STATE.get(l)).find(Boolean) ?? null,
    labels,
    open: i.state === "open",
    state_reason: i.state_reason ?? null,
    human_review: labels.includes(LABELS.human),
    assignees: (i.assignees ?? []).map((a) => a.login),
    author: i.user?.login ?? "",
    created_at: ts(i.created_at),
    updated_at: ts(i.updated_at),
    closed_at: i.closed_at ? ts(i.closed_at) : null,
    url: i.html_url,
    block: data,
    rest
  };
}
function toComment(c) {
  const parsed = readCommentMeta(c.body);
  if (!parsed || typeof parsed.meta?.kind !== "string") return null;
  return {
    id: c.id,
    issue: Number(c.issue_url.split("/").pop()),
    meta: parsed.meta,
    text: parsed.text,
    author: c.user?.login ?? "",
    created_at: ts(c.created_at),
    updated_at: ts(c.updated_at),
    url: c.html_url
  };
}
var Hub = class {
  gh;
  repo;
  locks;
  cfg = null;
  login = null;
  info = null;
  labelCache = null;
  constructor(opts) {
    this.repo = typeof opts.repo === "string" ? parseRepo(opts.repo) : opts.repo;
    this.gh = new GitHub(opts);
    this.locks = opts.locks ?? new GitLockStore({
      remoteUrl: opts.gitRemote ?? `https://github.com/${this.name}.git`,
      dir: `${opts.gitDir ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.agent-pm/git`}/${this.repo.owner}/${this.repo.name}.git`,
      token: opts.token
    });
  }
  get name() {
    return repoName(this.repo);
  }
  get base() {
    return `/repos/${this.repo.owner}/${this.repo.name}`;
  }
  now() {
    return this.gh.now();
  }
  async me() {
    this.login ??= (await this.gh.get("/user")).login;
    return this.login;
  }
  async repoInfo() {
    this.info ??= await this.gh.get(`${this.base}`);
    return this.info;
  }
  async config() {
    if (this.cfg) return this.cfg;
    const f = await this.gh.getOrNull(`${this.base}/contents/.agent-pm/config.yml`);
    let b = {};
    if (f?.content) {
      b = parseYamlish(Buffer.from(f.content, f.encoding ?? "base64").toString("utf8"));
    }
    this.cfg = {
      lease_minutes: asNum(b.lease_minutes, DEFAULT_CONFIG.lease_minutes) ?? DEFAULT_CONFIG.lease_minutes,
      heartbeat_minutes: asNum(b.heartbeat_minutes, DEFAULT_CONFIG.heartbeat_minutes) ?? DEFAULT_CONFIG.heartbeat_minutes,
      idle_minutes: asNum(b.idle_minutes, DEFAULT_CONFIG.idle_minutes) ?? DEFAULT_CONFIG.idle_minutes,
      admins: asList(b.admins)
    };
    return this.cfg;
  }
  async leaseMs() {
    return (await this.config()).lease_minutes * 6e4;
  }
  /** 是不是 hub 管理員：倉庫的 admin，或寫在 config.yml 的 admins 裡 */
  async isAdmin(login) {
    const who = login ?? await this.me();
    if ((await this.config()).admins.includes(who)) return true;
    if (who !== await this.me()) return false;
    return !!(await this.repoInfo()).permissions?.admin;
  }
  // ───────────── Issue ─────────────
  async listIssues(label, state, since) {
    const q = `labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=asc${since ? `&since=${new Date(since).toISOString()}` : ""}`;
    return (await this.gh.paginate(`${this.base}/issues?${q}`)).filter((i) => !i.pull_request);
  }
  async projects(state = "open") {
    return (await this.listIssues(LABELS.project, state)).map(toProject).filter((p) => !!p);
  }
  async tasks(state = "open", since) {
    return (await this.listIssues(LABELS.task, state, since)).map(toTask).filter((t) => !!t);
  }
  async rawIssues(label, state, since) {
    return this.listIssues(label, state, since);
  }
  async issue(n) {
    return this.gh.get(`${this.base}/issues/${n}`);
  }
  async task(n) {
    const t = toTask(await this.issue(n));
    if (!t) throw new Error(`#${n} \u4E0D\u662F agent-pm \u7684\u4EFB\u52D9`);
    return t;
  }
  async project(ref) {
    const s = String(ref).replace(/^#/, "");
    if (/^\d+$/.test(s)) {
      const p2 = toProject(await this.issue(Number(s)));
      if (!p2) throw new Error(`#${s} \u4E0D\u662F agent-pm \u7684\u9805\u76EE`);
      return p2;
    }
    const all = await this.projects("all");
    const p = all.find((x) => x.key === s && x.open) ?? all.find((x) => x.key === s);
    if (!p) throw new Error(`\u627E\u4E0D\u5230\u9805\u76EE\u300C${s}\u300D`);
    return p;
  }
  createIssue(body) {
    return this.gh.post(`${this.base}/issues`, body);
  }
  updateIssue(n, patch) {
    return this.gh.patch(`${this.base}/issues/${n}`, patch);
  }
  /** 換掉 status:* 標籤（只改這一個，其他標籤保留） */
  async setStatus(t, state, extra = {}) {
    const label = STATUS_LABEL[state];
    const labels = [...t.labels.filter((l) => !l.startsWith("status:")), ...label ? [label] : []];
    if (label) await this.ensureLabels([label]);
    const same = labels.length === t.labels.length && labels.every((l) => t.labels.includes(l));
    if (same && !Object.keys(extra).length) return;
    const issue = await this.updateIssue(t.number, { labels, ...extra });
    t.labels = labelNames(issue);
  }
  async addSubIssue(parent, childIssueId) {
    try {
      await this.gh.post(`${this.base}/issues/${parent}/sub_issues`, { sub_issue_id: childIssueId });
      return true;
    } catch {
      return false;
    }
  }
  /** 名冊 Issue（每個 worker 一條留言）。還沒有就建一個 */
  async rosterIssue() {
    const open = await this.rawIssues(LABELS.roster, "open");
    if (open.length) return open[0].number;
    await this.ensureLabels([LABELS.roster]);
    const i = await this.createIssue({
      title: "Worker \u540D\u518A",
      body: "\u6BCF\u500B worker \u5728\u9019\u88E1\u6709\u4E00\u689D\u81EA\u5DF1\u7684\u7559\u8A00\uFF08\u7531 apm \u81EA\u52D5\u7DAD\u8B77\uFF09\uFF0C\u8A18\u9304\u5B83\u7684\u80FD\u529B\u3001\u5728\u505A\u4EC0\u9EBC\u3001\u6700\u5F8C\u51FA\u73FE\u7684\u6642\u9593\u3002\u8ACB\u4E0D\u8981\u624B\u52D5\u7DE8\u8F2F\u3002",
      labels: [LABELS.roster]
    });
    return i.number;
  }
  // ───────────── 留言 ─────────────
  async comments(n) {
    return (await this.gh.paginate(`${this.base}/issues/${n}/comments`)).map(toComment).filter((c) => !!c);
  }
  /** 整個 hub 的留言（since 之後新增或編輯過的），管理端用它一次拿到所有變化 */
  async allComments(since) {
    const q = `sort=created&direction=asc${since ? `&since=${new Date(since).toISOString()}` : ""}`;
    return (await this.gh.paginate(`${this.base}/issues/comments?${q}`, 200)).map(toComment).filter((c) => !!c);
  }
  async comment(n, meta, text) {
    const c = await this.gh.post(`${this.base}/issues/${n}/comments`, { body: writeComment(meta, text) });
    return toComment(c);
  }
  async editComment(id, meta, text) {
    await this.gh.patch(`${this.base}/issues/comments/${id}`, { body: writeComment(meta, text) });
  }
  async deleteComment(id) {
    await this.gh.del(`${this.base}/issues/comments/${id}`);
  }
  /** 普通留言（不帶 apm 區塊），例如在 PR 上留退回意見 */
  async plainComment(repo, n, body) {
    await this.gh.post(`/repos/${repo}/issues/${n}/comments`, { body });
  }
  // ───────────── 標籤 ─────────────
  async ensureLabels(names) {
    if (!this.labelCache) {
      const all = await this.gh.paginate(`${this.base}/labels`);
      this.labelCache = new Set(all.map((l) => l.name));
    }
    for (const name of new Set(names)) {
      if (this.labelCache.has(name)) continue;
      try {
        await this.gh.post(`${this.base}/labels`, { name, color: labelColor(name) });
      } catch (err) {
        if (!(err instanceof Error && /already_exists|422/.test(err.message))) throw err;
      }
      this.labelCache.add(name);
    }
  }
};

// packages/github/src/local.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname as dirname2, join } from "node:path";
var apmHome = () => process.env.APM_HOME || join(homedir(), ".agent-pm");
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJson(path, data) {
  mkdirSync2(dirname2(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}
var configPath = () => join(apmHome(), "config.json");
var loadConfig = () => readJson(configPath()) ?? {};
var saveConfig = (c) => writeJson(configPath(), c);
var defaultWorkerId = () => process.env.APM_WORKER_ID || hostname().toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
var StateFile = class {
  path;
  constructor(hub, worker) {
    this.path = join(apmHome(), "state", hub.replace("/", "__"), `${worker}.json`);
  }
  load() {
    return existsSync2(this.path) ? readJson(this.path) : null;
  }
  save(s) {
    writeJson(this.path, s);
  }
  clear() {
    rmSync(this.path, { force: true });
  }
  /** 記下「agent 剛剛還在動」 */
  touch() {
    const s = this.load();
    if (s) this.save({ ...s, last_activity: Date.now() });
  }
};

// packages/core/src/types.ts
var PmError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "PmError";
  }
  code;
};

// packages/core/src/engine.ts
var INTERRUPT_LABEL = {
  lease_expired: "\u65B7\u7DDA\uFF0C\u79DF\u7D04\u8D85\u6642",
  interrupted: "\u88AB\u4EBA\u5DE5\u6253\u65B7",
  usage_limit: "\u7528\u91CF\u984D\u5EA6\u7528\u5B8C",
  released: "\u4E3B\u52D5\u91CB\u653E",
  blocked: "\u53D7\u963B",
  error: "agent \u7570\u5E38\u9000\u51FA",
  changes_requested: "review \u9000\u56DE"
};
function buildResume(task) {
  const checkpoints = task.worklog.filter((e) => e.kind === "checkpoint");
  const latest = checkpoints.at(-1);
  if (!latest) return null;
  const last = checkpoints.filter((e) => !e.auto).at(-1) ?? latest;
  const auto = checkpoints.filter((e) => e.auto).at(-1);
  const stop = task.worklog.at(-1)?.kind === "interrupted" ? task.worklog.at(-1) : null;
  const rejected = task.state === "changes_requested" || task.reviews.at(-1)?.decision === "reject";
  return {
    from_worker: task.last_assignee ?? last.worker_id,
    reason: stop?.reason ?? (rejected ? "changes_requested" : null),
    handoff_note: stop?.summary ?? null,
    progress: task.progress,
    summary: last.summary,
    next_steps: last.next_steps ?? null,
    auto_note: auto && auto !== last ? auto.summary : null,
    branch: task.branch,
    commit: [...checkpoints].reverse().find((e) => e.commit)?.commit ?? null,
    artifacts: [...new Set(checkpoints.flatMap((e) => e.artifacts ?? []))],
    checkpoints: checkpoints.length
  };
}

// packages/github/src/derive.ts
function entriesOf(comments) {
  const out2 = [];
  for (const c of comments) {
    const m = c.meta;
    const at = typeof m.at === "number" ? m.at : c.created_at;
    if (m.kind === "attempt") {
      out2.push({ at, key: `c${c.id}`, kind: "attempt", meta: m, comment: c });
      (m.checkpoints ?? []).forEach(
        (cp, index) => out2.push({ at: cp.at ?? at, key: `c${c.id}.${index}`, kind: "checkpoint", meta: m, cp, index, comment: c })
      );
    } else if (["interrupted", "submitted", "blocked", "unblocked", "review", "revoked"].includes(m.kind)) {
      out2.push({ at, key: `c${c.id}`, kind: m.kind, meta: m, comment: c });
    }
  }
  return out2.sort((a, b) => a.at - b.at || a.comment.id - b.comment.id || a.key.localeCompare(b.key));
}
function replay(entries) {
  const r = {
    state: null,
    assignee: null,
    last_assignee: null,
    attempt: 0,
    progress: 0,
    worklog: [],
    reviews: [],
    result: null,
    blocked_reason: null,
    updated_at: 0
  };
  const log = (e) => r.worklog.push({ seq: r.worklog.length + 1, ...e });
  for (const e of entries) {
    r.updated_at = Math.max(r.updated_at, e.at);
    switch (e.kind) {
      case "attempt":
        r.state = "claimed";
        r.assignee = e.meta.worker;
        r.last_assignee = e.meta.worker;
        r.attempt = Math.max(r.attempt, e.meta.attempt);
        r.blocked_reason = null;
        break;
      case "checkpoint": {
        const cp = e.cp;
        if (typeof cp.progress === "number") r.progress = Math.max(0, Math.min(100, Math.round(cp.progress)));
        log({
          kind: "checkpoint",
          worker_id: e.meta.worker,
          attempt: e.meta.attempt,
          at: e.at,
          summary: cp.summary,
          next_steps: cp.next_steps,
          progress: r.progress,
          commit: cp.commit,
          artifacts: cp.artifacts,
          auto: cp.auto
        });
        break;
      }
      case "interrupted": {
        const m = e.meta;
        r.state = "ready";
        r.assignee = null;
        r.last_assignee = m.worker;
        log({
          kind: "interrupted",
          worker_id: m.worker,
          attempt: m.attempt,
          at: e.at,
          summary: m.note || INTERRUPT_LABEL[m.reason] || m.reason,
          reason: m.reason
        });
        break;
      }
      case "submitted": {
        const m = e.meta;
        r.state = "in_review";
        r.assignee = null;
        r.last_assignee = m.worker;
        r.progress = 100;
        r.result = { summary: m.summary, pr_url: m.pr_url || void 0, submitted_by: m.worker, submitted_at: e.at };
        break;
      }
      case "blocked": {
        const m = e.meta;
        r.state = "blocked";
        r.assignee = null;
        r.last_assignee = m.worker;
        r.blocked_reason = m.reason;
        log({ kind: "interrupted", worker_id: m.worker, attempt: m.attempt, at: e.at, summary: m.reason, reason: "blocked" });
        break;
      }
      case "unblocked":
        r.state = "ready";
        r.blocked_reason = null;
        break;
      case "review": {
        const m = e.meta;
        r.reviews.push({ reviewer: m.reviewer, decision: m.decision, comment: m.comment, at: e.at });
        if (m.decision === "approve") r.state = "done";
        else {
          r.state = "changes_requested";
          r.progress = Math.min(r.progress, 80);
        }
        break;
      }
      case "revoked": {
        const m = e.meta;
        r.state = "ready";
        r.assignee = null;
        r.last_assignee = m.worker;
        log({
          kind: "interrupted",
          worker_id: m.worker,
          attempt: m.attempt,
          at: e.at,
          summary: m.note || `\u7BA1\u7406\u54E1 ${m.by} \u6536\u56DE\u4E86\u4EFB\u52D9`,
          reason: "released"
        });
        break;
      }
    }
  }
  return r;
}
var refSafe = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "task";
var branchOf = (t, projectKey) => t.branch ?? `project/${projectKey}/${refSafe(t.key)}-${t.number}`;
var depsDone = (t, openNumbers) => t.deps.every((d) => !openNumbers.has(d));
function effectiveState(t, lock, now, depsOk) {
  if (!t.open) return { state: "done", expired: false };
  if (lock?.status === "held") {
    if (isAlive(lock, now)) return { state: "claimed", expired: false };
    return { state: t.status === "changes_requested" ? "changes_requested" : "ready", expired: true };
  }
  let s = t.status ?? (depsOk ? "ready" : "pending");
  if (s === "claimed") {
    if (!lock || lock.status === "released" || lock.status === "revoked") s = "ready";
    else if (lock.status === "submitted") s = "in_review";
    else if (lock.status === "blocked") s = "blocked";
  }
  if (s === "done") s = "ready";
  if (s === "pending" || s === "ready") s = depsOk ? "ready" : "pending";
  return { state: s, expired: false };
}
function deriveTask(t, projectKey, comments, lock, now, depsOk) {
  const r = replay(entriesOf(comments));
  const eff = effectiveState(t, lock, now, depsOk);
  const worklog = [...r.worklog];
  let assignee = null;
  let lease = null;
  let last = lock?.worker ?? r.last_assignee;
  const attempt = Math.max(r.attempt, lock?.attempt ?? 0);
  if (eff.state === "claimed" && lock) {
    assignee = lock.worker;
    lease = lock.expires_at;
  }
  if (eff.expired && lock) {
    const already = worklog.some((e) => e.kind === "interrupted" && e.attempt === lock.attempt && e.worker_id === lock.worker);
    if (!already) {
      worklog.push({
        seq: worklog.length + 1,
        kind: "interrupted",
        worker_id: lock.worker,
        attempt: lock.attempt,
        at: lock.expires_at ?? now,
        summary: "\u5FC3\u8DF3\u4E2D\u65B7\uFF0C\u79DF\u7D04\u8D85\u6642",
        reason: "lease_expired"
      });
    }
    last = lock.worker;
  }
  let progress = r.progress;
  if (eff.state === "done" || eff.state === "in_review") progress = 100;
  return {
    id: String(t.number),
    number: t.number,
    url: t.url,
    human_review: t.human_review,
    expired: eff.expired,
    project_id: String(t.project),
    project_key: projectKey,
    key: t.key,
    title: t.title,
    description: t.description,
    acceptance: t.acceptance,
    labels: t.caps,
    deps: t.deps.map(String),
    state: eff.state,
    assignee,
    last_assignee: last ?? null,
    lease_expires_at: lease,
    attempt,
    result: r.result,
    reviews: r.reviews,
    blocked_reason: eff.state === "blocked" ? r.blocked_reason ?? "\u53D7\u963B" : null,
    worklog,
    progress,
    branch: branchOf(t, projectKey),
    created_at: t.created_at,
    updated_at: Math.max(t.updated_at, r.updated_at)
  };
}
function resumeOf(task) {
  return buildResume(task);
}
function canParticipate(p, login, admin) {
  if (admin) return true;
  return p.managers.includes(login) || p.contributors.includes(login) || p.author === login;
}
function isManager(p, login, admin) {
  return admin || p.managers.includes(login) || p.author === login;
}
function listClaimable(w, admin, projects, tasks, locks, now) {
  const byNumber = new Map(projects.map((p) => [p.number, p]));
  const open = new Set(tasks.filter((t) => t.open).map((t) => t.number));
  const running = /* @__PURE__ */ new Map();
  for (const t of tasks) {
    if (t.open && isAlive(locks.get(t.number), now)) running.set(t.project, (running.get(t.project) ?? 0) + 1);
  }
  const why = /* @__PURE__ */ new Map();
  const candidates = [];
  for (const t of tasks) {
    const p = byNumber.get(t.project);
    if (!p || !p.open) {
      why.set(t.number, "\u9805\u76EE\u4E0D\u5728\u9032\u884C\u4E2D");
      continue;
    }
    const lock = locks.get(t.number);
    const eff = effectiveState(t, lock, now, depsDone(t, open));
    if (eff.state !== "ready" && eff.state !== "changes_requested") {
      why.set(t.number, eff.state === "claimed" ? `\u5DF2\u88AB ${lock?.worker} \u9818\u8D70` : `\u72C0\u614B\u662F ${eff.state}`);
      continue;
    }
    if (!canParticipate(p, w.owner, admin)) {
      why.set(t.number, `${w.owner} \u4E0D\u662F\u9805\u76EE\u300C${p.title}\u300D\u7684\u6210\u54E1\uFF08contributor \u6216 manager\uFF09`);
      continue;
    }
    if (w.projects && !w.projects.includes(p.key)) {
      why.set(t.number, `\u9019\u500B worker \u53EA\u505A ${w.projects.join("\u3001")}`);
      continue;
    }
    if (!t.caps.every((c) => w.labels.includes(c))) {
      why.set(t.number, `\u80FD\u529B\u4E0D\u7B26\uFF1A\u4EFB\u52D9\u8981 ${t.caps.join("\u3001")}\uFF0Cworker \u6709 ${w.labels.join("\u3001") || "\uFF08\u7121\uFF09"}`);
      continue;
    }
    if (p.max_parallel !== null && (running.get(p.number) ?? 0) >= p.max_parallel) {
      why.set(t.number, p.max_parallel === 0 ? `\u9805\u76EE\u300C${p.title}\u300D\u66AB\u505C\u6D3E\u5DE5` : `\u9805\u76EE\u300C${p.title}\u300D\u7684\u4E26\u884C\u914D\u984D ${p.max_parallel} \u5DF2\u6EFF`);
      continue;
    }
    candidates.push({ task: t, project: p, state: eff.state, lock, expired: eff.expired });
  }
  const rank = (c) => {
    if (c.lock?.worker !== w.id) return 1;
    const handedOff = c.lock.status === "released" && (c.lock.reason === "usage_limit" || c.lock.reason === "interrupted");
    return handedOff ? 2 : 0;
  };
  candidates.sort(
    (a, b) => b.project.priority - a.project.priority || rank(a) - rank(b) || (running.get(a.project.number) ?? 0) - (running.get(b.project.number) ?? 0) || a.task.created_at - b.task.created_at || a.task.number - b.task.number
  );
  return { candidates, running, why };
}
function deriveProject(p) {
  return {
    id: String(p.number),
    number: p.number,
    url: p.url,
    repo: p.repo,
    merge_on_approve: p.merge_on_approve,
    key: p.key,
    priority: p.priority,
    max_parallel: p.max_parallel,
    title: p.title,
    description: p.description,
    kind: p.kind,
    status: p.open ? "active" : "delivered",
    created_at: p.created_at,
    delivered_at: p.closed_at
  };
}
function deriveWorkers(model, now) {
  const leaseMs = model.config.lease_minutes * 6e4;
  const out2 = /* @__PURE__ */ new Map();
  for (const c of model.roster) {
    const m = c.meta;
    if (m.kind !== "worker" || !m.id) continue;
    out2.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      machine: m.machine ?? "",
      labels: m.labels ?? [],
      owner: m.owner ?? c.author,
      projects: m.projects ?? null,
      status: m.status === "left" ? "offline" : "online",
      current_task: null,
      last_seen: Math.max(m.seen ?? 0, c.updated_at),
      registered_at: m.registered_at ?? c.created_at
    });
  }
  const openTasks = new Set(model.tasks.filter((t) => t.open).map((t) => t.number));
  for (const [n, l] of model.locks) {
    let w = out2.get(l.worker);
    if (!w) {
      w = {
        id: l.worker,
        name: l.worker,
        machine: "",
        labels: [],
        owner: l.owner,
        projects: null,
        status: "offline",
        current_task: null,
        last_seen: 0,
        registered_at: l.at
      };
      out2.set(l.worker, w);
    }
    w.last_seen = Math.max(w.last_seen, l.at);
    if (openTasks.has(n) && isAlive(l, now)) w.current_task = String(n);
  }
  for (const w of out2.values()) {
    if (w.current_task) w.status = "online";
    else if (w.status === "online" && now - w.last_seen > leaseMs * 2) w.status = "offline";
  }
  return [...out2.values()].sort((a, b) => a.registered_at - b.registered_at);
}
function deriveSnapshot(model, now) {
  const projects = model.projects.map(deriveProject);
  const keyOf = new Map(model.projects.map((p) => [p.number, p.key]));
  const open = new Set(model.tasks.filter((t) => t.open).map((t) => t.number));
  const known = new Set(model.projects.map((p) => p.number));
  const tasks = model.tasks.filter((t) => known.has(t.project) && !(t.state_reason === "not_planned" && !t.open)).map(
    (t) => deriveTask(t, keyOf.get(t.project) ?? "?", model.comments.get(t.number) ?? [], model.locks.get(t.number), now, depsDone(t, open))
  );
  const members = [];
  const logins = new Set(model.admins);
  for (const p of model.projects) {
    const seen = /* @__PURE__ */ new Set();
    const add = (user_id, role) => {
      if (seen.has(user_id)) return;
      seen.add(user_id);
      logins.add(user_id);
      members.push({ project_id: String(p.number), user_id, role });
    };
    if (p.author) add(p.author, "manager");
    p.managers.forEach((u) => add(u, "manager"));
    p.contributors.forEach((u) => add(u, "contributor"));
    p.viewers.forEach((u) => add(u, "viewer"));
  }
  const workers = deriveWorkers(model, now);
  for (const w of workers) if (w.owner) logins.add(w.owner);
  const users = [...logins].sort().map((id) => ({ id, name: id, admin: model.admins.includes(id), created_at: 0 }));
  return {
    server_time: now,
    lease_ms: model.config.lease_minutes * 6e4,
    projects,
    tasks,
    workers,
    users,
    members,
    last_event_id: 0
  };
}

// packages/github/src/model.ts
async function loadModel(hub, opts = {}) {
  const [config, projects, tasks, comments, locks] = await Promise.all([
    hub.config(),
    hub.projects(opts.closedProjects === false ? "open" : "all"),
    hub.tasks("all"),
    hub.allComments(),
    hub.locks.list()
  ]);
  const roster = await rosterIssues(hub);
  const byIssue = /* @__PURE__ */ new Map();
  const rosterComments = [];
  for (const c of comments) {
    if (roster.has(c.issue)) {
      if (c.meta.kind === "worker") rosterComments.push(c);
      continue;
    }
    const list2 = byIssue.get(c.issue) ?? [];
    list2.push(c);
    byIssue.set(c.issue, list2);
  }
  const me = await hub.me();
  const admins = [...config.admins];
  if (!admins.includes(me) && await hub.isAdmin(me)) admins.push(me);
  return { config, projects, tasks, comments: byIssue, roster: rosterComments, locks, admins };
}
async function rosterIssues(hub) {
  return new Set((await hub.rawIssues(LABELS.roster, "all")).map((i) => i.number));
}

// packages/github/src/worker.ts
var LeaseLost = class extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
    this.name = "LeaseLost";
  }
  detail;
  code = "lease_lost";
};
var NothingHeld = class extends Error {
  code = "no_task";
  constructor() {
    super("\u9019\u500B worker \u624B\u4E0A\u6C92\u6709\u4EFB\u52D9\u3002\u5148\u7528 apm claim \u9818\u4E00\u500B");
  }
};
function renderAttempt(m, title) {
  const last = m.checkpoints.at(-1);
  const head = m.resumed?.progress ? `**\u7B2C ${m.attempt} \u6B21\u9818\u53D6** \xB7 ${m.worker}\uFF08${m.owner}\uFF09\u5F9E ${m.resumed.progress}% \u63A5\u624B${m.resumed.from_worker && m.resumed.from_worker !== m.worker ? `\uFF08\u4E0A\u4E00\u4F4D ${m.resumed.from_worker}\uFF09` : ""}` : `**\u7B2C ${m.attempt} \u6B21\u9818\u53D6** \xB7 ${m.worker}\uFF08${m.owner}\uFF09`;
  const lines = [head, ""];
  if (!last) lines.push(`\u958B\u59CB\u505A\u300C${title}\u300D\uFF0C\u9084\u6C92\u6709\u6AA2\u67E5\u9EDE\u3002`);
  else {
    lines.push(`**\u9032\u5EA6 ${last.progress ?? 0}%**${last.commit ? ` \xB7 commit \`${last.commit}\`` : ""}`, "", `\u505A\u5B8C\u4E86\uFF1A${last.summary}`);
    if (last.next_steps) lines.push("", `\u63A5\u4E0B\u4F86\uFF1A${last.next_steps}`);
    if (m.checkpoints.length > 1) {
      lines.push("", "<details><summary>\u4E4B\u524D\u7684\u6AA2\u67E5\u9EDE</summary>", "");
      for (const cp of m.checkpoints.slice(0, -1).reverse()) lines.push(`- ${cp.progress ?? 0}% ${cp.summary.replace(/\n/g, " ")}`);
      lines.push("", "</details>");
    }
  }
  lines.push("", "_\u9019\u689D\u7559\u8A00\u6703\u96A8\u8457\u6AA2\u67E5\u9EDE\u66F4\u65B0\uFF08\u7DE8\u8F2F\u7559\u8A00\u4E0D\u767C\u901A\u77E5\uFF09\u3002_");
  return lines.join("\n");
}
var REASON_TEXT = {
  interrupted: "\u88AB\u4EBA\u5DE5\u6253\u65B7",
  usage_limit: "\u7528\u91CF\u984D\u5EA6\u7528\u5B8C",
  released: "\u4E3B\u52D5\u4EA4\u51FA",
  error: "\u74B0\u5883\u51FA\u932F",
  lease_expired: "\u5FC3\u8DF3\u4E2D\u65B7\uFF0C\u79DF\u7D04\u8D85\u6642"
};
var WorkerOps = class {
  constructor(hub, me, state) {
    this.hub = hub;
    this.me = me;
    this.state = state;
  }
  hub;
  me;
  state;
  async leaseMs() {
    return (await this.hub.config()).lease_minutes * 6e4;
  }
  // ───────────── 名冊 ─────────────
  async updateRoster(patch = {}) {
    const issue = await this.hub.rosterIssue();
    const mine = (await this.hub.comments(issue)).find((c) => c.meta.kind === "worker" && c.meta.id === this.me.id);
    const prev = mine?.meta;
    if (prev && prev.owner && prev.owner !== this.me.owner) {
      throw new Error(`worker id\u300C${this.me.id}\u300D\u5DF2\u7D93\u767B\u8A18\u5728 ${prev.owner} \u540D\u4E0B\uFF0C\u63DB\u4E00\u500B id\uFF08apm join --id \u65B0\u540D\u5B57\uFF09`);
    }
    const now = this.hub.now();
    const meta = {
      kind: "worker",
      id: this.me.id,
      name: this.me.name,
      machine: this.me.machine,
      owner: this.me.owner,
      labels: this.me.labels,
      projects: this.me.projects,
      status: "online",
      current_task: prev?.current_task ?? null,
      seen: now,
      registered_at: prev?.registered_at ?? now,
      ...patch
    };
    const text = [
      `**${meta.name}**\uFF08\`${meta.id}\`\uFF09\xB7 ${meta.owner} \u7684 ${meta.machine || "\u96FB\u8166"}`,
      `\u80FD\u529B\uFF1A${meta.labels.join("\u3001") || "\uFF08\u7121\uFF09"}\uFF1B${meta.projects?.length ? `\u53EA\u505A ${meta.projects.join("\u3001")}` : "\u6240\u6709\u80FD\u53C3\u8207\u7684\u9805\u76EE"}`,
      meta.status === "left" ? "\u72C0\u614B\uFF1A\u5DF2\u96E2\u958B" : meta.current_task ? `\u6B63\u5728\u505A #${meta.current_task}` : "\u9592\u7F6E",
      `\u6700\u5F8C\u51FA\u73FE\uFF1A${new Date(meta.seen).toISOString()}`
    ].join("\n\n");
    if (mine) await this.hub.editComment(mine.id, meta, text);
    else await this.hub.comment(issue, meta, text);
    return meta;
  }
  async join() {
    return this.updateRoster({ status: "online" });
  }
  async forget() {
    const issue = await this.hub.rosterIssue();
    const mine = (await this.hub.comments(issue)).find((c) => c.meta.kind === "worker" && c.meta.id === this.me.id);
    if (mine) await this.hub.deleteComment(mine.id);
  }
  // ───────────── 領取 ─────────────
  async list() {
    const [admin, projects, tasks, locks] = await Promise.all([
      this.hub.isAdmin(this.me.owner),
      this.hub.projects("open"),
      this.hub.tasks("open"),
      this.hub.locks.list()
    ]);
    const now = this.hub.now();
    return { ...listClaimable(this.me, admin, projects, tasks, locks, now), now };
  }
  /** 手上還有沒做完的任務嗎（以遠端的鎖為準） */
  async current() {
    const held = this.state.load();
    if (!held) return { held: null, lock: null, alive: false };
    await this.hub.gh.syncClock();
    const lock = await this.hub.locks.get(held.task);
    const mine = !!lock && lock.worker === this.me.id && lock.attempt === held.attempt && lock.status === "held";
    return { held, lock, alive: mine && isAlive(lock, this.hub.now()) };
  }
  async claim(taskNumber) {
    const cur = await this.current();
    if (cur.held && !cur.held.lost) {
      const l = cur.lock;
      if (l && l.worker === this.me.id && l.attempt === cur.held.attempt && l.status === "held") {
        throw Object.assign(
          new Error(`\u9019\u500B worker \u9084\u6301\u6709\u4EFB\u52D9 #${cur.held.task}\u300C${cur.held.title}\u300D\uFF0C\u4E00\u6B21\u53EA\u80FD\u9818\u4E00\u500B\u3002\u63A5\u8457\u505A\u5B83\uFF08apm current \u770B\u8A73\u60C5\uFF09\uFF0C\u6216\u5148 apm release`),
          { code: "conflict" }
        );
      }
      this.state.clear();
    } else if (cur.held) this.state.clear();
    const [cfg, admin, projects, tasks, locks] = await Promise.all([
      this.hub.config(),
      this.hub.isAdmin(this.me.owner),
      this.hub.projects("open"),
      this.hub.tasks("open"),
      this.hub.locks.list()
    ]);
    const leaseMs = cfg.lease_minutes * 6e4;
    const res = listClaimable(this.me, admin, projects, tasks, locks, this.hub.now());
    let cands = res.candidates;
    if (taskNumber !== void 0) {
      cands = cands.filter((c) => c.task.number === taskNumber);
      if (!cands.length) {
        throw Object.assign(new Error(`\u4EFB\u52D9 #${taskNumber} \u76EE\u524D\u4E0D\u53EF\u9818\u53D6\uFF1A${res.why.get(taskNumber) ?? "\u4E0D\u5B58\u5728\u3001\u5DF2\u95DC\u9589\uFF0C\u6216\u4E0D\u662F agent-pm \u7684\u4EFB\u52D9"}`), {
          code: "conflict"
        });
      }
    }
    const skipProjects = /* @__PURE__ */ new Set();
    for (const c of cands.slice(0, 10)) {
      if (skipProjects.has(c.project.number)) continue;
      const now = this.hub.now();
      const prev = c.lock;
      const payload = {
        v: 1,
        task: c.task.number,
        project: c.project.key,
        worker: this.me.id,
        owner: this.me.owner,
        attempt: (prev?.attempt ?? 0) + 1,
        status: "held",
        at: now,
        expires_at: now + leaseMs
      };
      const lock = prev ? await this.hub.locks.advance(prev.sha, payload) : await this.hub.locks.create(payload);
      if (!lock) continue;
      if (await this.overQuota(c.project, tasks, lock)) {
        await this.hub.locks.advance(
          lock.sha,
          prev ? { ...stripSha(prev), at: this.hub.now() } : { ...payload, attempt: 0, status: "released", reason: "quota", expires_at: null, at: this.hub.now() }
        );
        skipProjects.add(c.project.number);
        continue;
      }
      return this.afterClaim(c.task, c.project, tasks, prev, lock, leaseMs, cfg.heartbeat_minutes * 6e4);
    }
    return null;
  }
  async overQuota(p, tasks, mine) {
    if (p.max_parallel === null) return false;
    const fresh = await this.hub.locks.list();
    const now = this.hub.now();
    const live = tasks.filter((t) => t.project === p.number).map((t) => fresh.get(t.number)).filter((l) => isAlive(l, now)).sort((a, b) => a.at - b.at || a.sha.localeCompare(b.sha));
    if (live.length <= p.max_parallel) return false;
    return live.slice(p.max_parallel).some((l) => l.sha === mine.sha);
  }
  async afterClaim(t, p, openTasks, prev, lock, leaseMs, heartbeatMs) {
    const now = this.hub.now();
    if (prev && prev.status === "held") {
      await this.hub.comment(
        t.number,
        {
          kind: "interrupted",
          attempt: prev.attempt,
          worker: prev.worker,
          reason: "lease_expired",
          note: "\u5FC3\u8DF3\u4E2D\u65B7\uFF0C\u79DF\u7D04\u8D85\u6642",
          at: now,
          by: this.me.id
        },
        `**\u79DF\u7D04\u8D85\u6642** \xB7 ${prev.worker}\uFF08\u7B2C ${prev.attempt} \u6B21\u9818\u53D6\uFF09\u8D85\u904E\u79DF\u7D04\u6C92\u6709\u7E8C\u7D04\uFF0C\u7531 ${this.me.id} \u63A5\u624B\u3002`
      );
    }
    const comments = await this.hub.comments(t.number);
    const open = new Set(openTasks.map((x) => x.number));
    const view = deriveTask(t, p.key, comments, prev, now, depsDone(t, open));
    if (view.state === "claimed") view.state = "ready";
    const resume = resumeOf(view);
    const meta = {
      kind: "attempt",
      attempt: lock.attempt,
      worker: this.me.id,
      owner: this.me.owner,
      at: now,
      resumed: resume ? { from_worker: resume.from_worker, progress: resume.progress, reason: resume.reason } : null,
      checkpoints: []
    };
    const c = await this.hub.comment(t.number, meta, renderAttempt(meta, t.title));
    try {
      await this.hub.setStatus(t, "claimed", { assignees: [this.me.owner] });
    } catch {
      await this.hub.setStatus(t, "claimed");
    }
    const codeRepo = p.repo ?? this.hub.name;
    const branch = branchOf(t, p.key);
    const held = {
      hub: this.hub.name,
      worker: this.me.id,
      task: t.number,
      project_key: p.key,
      title: t.title,
      attempt: lock.attempt,
      lock,
      comment_id: c.id,
      branch,
      code_repo: codeRepo,
      claimed_at: now,
      last_activity: Date.now()
    };
    this.state.save(held);
    await this.updateRoster({ current_task: t.number }).catch(() => void 0);
    const taskRef = `${this.hub.name}#${t.number}`;
    return {
      task: {
        number: t.number,
        id: String(t.number),
        url: t.url,
        title: t.title,
        description: t.description,
        acceptance: t.acceptance,
        project: p.key,
        project_title: p.title,
        key: t.key,
        caps: t.caps,
        deps: t.deps,
        human_review: t.human_review
      },
      attempt: lock.attempt,
      resume,
      reviews: view.reviews,
      git: {
        repo: codeRepo,
        base: p.base,
        branch,
        commit_prefix: `[${p.key}/${t.key}]`,
        commit_trailers: `Project: ${p.key}
Task: ${taskRef}
Worker: ${this.me.id}`,
        pr_title: `[${p.key}/${t.key}] ${t.title}`,
        pr_body_footer: `Project: ${p.key}
Task: ${taskRef}`
      },
      lease_ms: leaseMs,
      heartbeat_every_ms: heartbeatMs,
      lease_expires_at: lock.expires_at
    };
  }
  // ───────────── 持有期間 ─────────────
  requireHeld() {
    const s = this.state.load();
    if (!s) throw new NothingHeld();
    if (s.lost) {
      throw new LeaseLost(`\u4EFB\u52D9 #${s.task} \u5DF2\u7D93\u88AB ${s.lost.holder ?? "\u5225\u4EBA"} \u63A5\u624B\uFF0C\u8ACB\u505C\u624B`, {
        task: s.task,
        holder: s.lost.holder,
        status: null
      });
    }
    return s;
  }
  /** 把鎖往前推一步。被別人改過就拋 LeaseLost。自己的另一個進程（keepalive）剛推過的話，接著它往前推 */
  async writeLock(s, status, extra = {}, touch = true) {
    await this.hub.gh.syncClock();
    const leaseMs = await this.leaseMs();
    let base = s.lock;
    for (let i = 0; i < 3; i++) {
      const now = this.hub.now();
      const payload = {
        ...stripSha(base),
        status,
        at: now,
        expires_at: status === "held" ? now + leaseMs : null,
        reason: void 0,
        ...extra
      };
      const next = await this.hub.locks.advance(base.sha, payload);
      if (next) {
        const latest = this.state.load();
        const keep = latest && latest.task === s.task && latest.attempt === s.attempt ? latest : s;
        this.state.save({ ...keep, lock: next, last_activity: touch ? Date.now() : keep.last_activity });
        return next;
      }
      const cur = await this.hub.locks.get(s.task);
      if (cur && cur.worker === this.me.id && cur.attempt === s.attempt && cur.status === "held") {
        base = cur;
        continue;
      }
      this.state.save({ ...s, lost: { at: Date.now(), holder: cur?.worker ?? null } });
      throw new LeaseLost(
        cur?.status === "revoked" ? `\u4EFB\u52D9 #${s.task} \u88AB\u7BA1\u7406\u54E1\u6536\u56DE\u4E86\uFF0C\u8ACB\u505C\u624B\uFF1A\u4E0D\u8981\u518D push\uFF0C\u4E5F\u4E0D\u8981\u4EA4\u4ED8` : `\u4EFB\u52D9 #${s.task} \u7684\u79DF\u7D04\u5DF2\u7D93\u4E0D\u5C6C\u65BC\u4F60\uFF08\u73FE\u5728\uFF1A${cur ? `${cur.worker} ${cur.status}` : "\u6C92\u6709\u9396"}\uFF09\uFF0C\u8ACB\u505C\u624B\uFF1A\u4E0D\u8981\u518D push\uFF0C\u4E5F\u4E0D\u8981\u4EA4\u4ED8`,
        { task: s.task, holder: cur?.worker ?? null, status: cur?.status ?? null }
      );
    }
    throw new Error("\u7E8C\u7D04\u4E00\u76F4\u885D\u7A81\uFF0C\u7A0D\u5F8C\u518D\u8A66");
  }
  /** 續約。background：apm keepalive 的自動續約，不算 agent 的活動（不然 agent 死了 keepalive 也會一直續下去） */
  async heartbeat(opts = {}) {
    const s = this.requireHeld();
    const l = await this.writeLock(s, "held", {}, !opts.background);
    return { task: s.task, lease_expires_at: l.expires_at, attempt: s.attempt };
  }
  async checkpoint(cp) {
    if (!cp.summary?.trim()) throw new Error("\u6AA2\u67E5\u9EDE\u9700\u8981 --summary\uFF1A\u5230\u76EE\u524D\u70BA\u6B62\u5B8C\u6210\u4E86\u4EC0\u9EBC");
    const s = this.requireHeld();
    const l = await this.writeLock(s, "held");
    const c = await this.hub.gh.get(`/repos/${this.hub.name}/issues/comments/${s.comment_id}`);
    const parsed = readCommentMeta(c.body);
    const meta = parsed?.meta ?? {
      kind: "attempt",
      attempt: s.attempt,
      worker: this.me.id,
      owner: this.me.owner,
      at: s.claimed_at,
      checkpoints: []
    };
    const prevProgress = meta.checkpoints.at(-1)?.progress ?? meta.resumed?.progress ?? 0;
    const entry = {
      at: this.hub.now(),
      summary: cp.summary.trim().slice(0, 4e3),
      next_steps: cp.next_steps?.trim().slice(0, 2e3) || void 0,
      progress: cp.progress === void 0 || Number.isNaN(cp.progress) ? prevProgress : Math.max(0, Math.min(100, Math.round(cp.progress))),
      commit: cp.commit || void 0,
      artifacts: cp.artifacts?.length ? cp.artifacts.slice(0, 20) : void 0,
      auto: cp.auto || void 0
    };
    meta.checkpoints = [...meta.checkpoints, entry].slice(-40);
    await this.hub.editComment(s.comment_id, meta, renderAttempt(meta, s.title));
    return { task: s.task, progress: entry.progress, lease_expires_at: l.expires_at };
  }
  async finish(s) {
    this.state.clear();
    await this.updateRoster({ current_task: null }).catch(() => void 0);
  }
  async submit(r) {
    if (!r.summary?.trim()) throw new Error("\u4EA4\u4ED8\u9700\u8981 --summary\uFF1A\u505A\u4E86\u4EC0\u9EBC\u3001\u600E\u9EBC\u9A57\u8B49\u3001\u5C0D\u7167\u9A57\u6536\u6A19\u6E96\u7684\u7D50\u679C");
    const s = this.requireHeld();
    await this.writeLock(s, "submitted");
    const pr = r.pr_url || await this.findPr(s);
    const meta = { kind: "submitted", attempt: s.attempt, worker: this.me.id, summary: r.summary.trim(), pr_url: pr ?? void 0, at: this.hub.now() };
    await this.hub.comment(
      s.task,
      meta,
      `**\u5DF2\u4EA4\u4ED8\uFF0C\u7B49\u5F85 review** \xB7 ${this.me.id}\uFF08\u7B2C ${s.attempt} \u6B21\u9818\u53D6\uFF09${pr ? `

PR\uFF1A${pr}` : ""}

${r.summary.trim()}`
    );
    const t = await this.hub.task(s.task);
    await this.hub.setStatus(t, "in_review");
    await this.finish(s);
    return { task: s.task, pr_url: pr, url: t.url };
  }
  async block(reason) {
    if (!reason?.trim()) throw new Error("\u9700\u8981 --reason\uFF1A\u7F3A\u4EC0\u9EBC\u3001\u9700\u8981\u8AB0\u505A\u4EC0\u9EBC\u6C7A\u5B9A");
    const s = this.requireHeld();
    await this.writeLock(s, "blocked");
    await this.hub.comment(
      s.task,
      { kind: "blocked", attempt: s.attempt, worker: this.me.id, reason: reason.trim(), at: this.hub.now() },
      `**\u53D7\u963B** \xB7 ${this.me.id}\uFF08\u7B2C ${s.attempt} \u6B21\u9818\u53D6\uFF09

${reason.trim()}`
    );
    await this.hub.setStatus(await this.hub.task(s.task), "blocked");
    await this.finish(s);
    return { task: s.task };
  }
  async release(reason = "released", note = "") {
    const s = this.requireHeld();
    await this.writeLock(s, "released", { reason });
    const text = note.trim() || REASON_TEXT[reason] || reason;
    await this.hub.comment(
      s.task,
      { kind: "interrupted", attempt: s.attempt, worker: this.me.id, reason, note: note.trim(), at: this.hub.now() },
      `**\u4EA4\u51FA\u4EFB\u52D9**\uFF08${REASON_TEXT[reason] ?? reason}\uFF09\xB7 ${this.me.id}\uFF08\u7B2C ${s.attempt} \u6B21\u9818\u53D6\uFF09

\u4EA4\u63A5\u8AAA\u660E\uFF1A${text}`
    );
    await this.hub.setStatus(await this.hub.task(s.task), "ready");
    await this.finish(s);
    return { task: s.task };
  }
  /** 交付時沒給 PR 網址：按任務分支在代碼倉庫找一個開著的 PR */
  async findPr(s) {
    try {
      const owner = s.code_repo.split("/")[0];
      const prs = await this.hub.gh.get(
        `/repos/${s.code_repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${s.branch}`)}`
      );
      return prs[0]?.html_url ?? null;
    } catch {
      return null;
    }
  }
};
function stripSha(l) {
  const { sha: _sha, ...rest } = l;
  return rest;
}

// packages/github/src/pm.ts
var KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
var ROLES = ["manager", "contributor", "viewer"];
var LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
var invalid = (m) => new PmError("invalid", m);
var forbidden = (m) => new PmError("forbidden", m);
var conflict = (m) => new PmError("conflict", m);
function checkPriority(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw invalid("\u512A\u5148\u7D1A priority \u5FC5\u9808\u662F 1 \u5230 5 \u7684\u6574\u6578");
  return n;
}
function checkQuota(v) {
  if (v === null || v === void 0 || v === "" || v === "none") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw invalid("\u4E26\u884C\u914D\u984D max_parallel \u5FC5\u9808\u662F 0 \u4EE5\u4E0A\u7684\u6574\u6578\uFF0C\u6216 none \u8868\u793A\u4E0D\u9650");
  return n;
}
function checkRepo(v) {
  if (v === null || v === void 0 || v === "") return null;
  const s = String(v).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(s)) throw invalid(`\u4EE3\u78BC\u5009\u5EAB\u8981\u5BEB\u6210 owner/repo\uFF08\u6536\u5230\u300C${s}\u300D\uFF09`);
  return s;
}
function checkLogins(list2, what) {
  if (list2 === void 0 || list2 === null) return [];
  if (!Array.isArray(list2)) throw invalid(`${what} \u8981\u662F GitHub \u5E33\u865F\u7684\u5217\u8868`);
  const out2 = list2.map((x) => String(x).replace(/^@/, "").trim()).filter(Boolean);
  for (const l of out2) if (!LOGIN_RE.test(l)) throw invalid(`${what} \u88E1\u7684\u300C${l}\u300D\u4E0D\u50CF GitHub \u5E33\u865F`);
  return [...new Set(out2)];
}
var capsOf = (t) => [...new Set((t.caps ?? t.labels ?? []).map((c) => String(c).trim()).filter(Boolean))];
var issueRef = (d) => {
  const m = String(d).trim().match(/^#?(\d+)$/);
  return m ? Number(m[1]) : null;
};
function validatePlan(plan) {
  if (!plan || typeof plan !== "object") throw invalid("\u8A08\u5283\u8981\u662F\u4E00\u500B JSON \u7269\u4EF6");
  if (!plan.title?.trim()) throw invalid("\u9805\u76EE\u9700\u8981\u6A19\u984C title");
  if (!Array.isArray(plan.tasks) || !plan.tasks.length) throw invalid("\u9805\u76EE\u81F3\u5C11\u9700\u8981\u4E00\u500B\u4EFB\u52D9 tasks");
  if (plan.key !== void 0 && !KEY_RE.test(plan.key)) {
    throw invalid("\u9805\u76EE\u77ED\u540D key \u53EA\u80FD\u7528\u5C0F\u5BEB\u5B57\u6BCD\u3001\u6578\u5B57\u548C\u9023\u5B57\u865F\uFF0C\u6700\u9577 32 \u500B\u5B57\u5143\uFF0C\u4F8B\u5982 site");
  }
  if (plan.kind !== void 0 && plan.kind !== "dev" && plan.kind !== "chore") throw invalid("kind \u53EA\u80FD\u662F dev \u6216 chore");
  checkPriority(plan.priority ?? 3);
  checkQuota(plan.max_parallel ?? null);
  checkRepo(plan.repo);
  for (const m of plan.members ?? []) {
    if (!ROLES.includes(m.role)) throw invalid(`\u89D2\u8272\u53EA\u80FD\u662F ${ROLES.join(" / ")}`);
  }
  const keys = /* @__PURE__ */ new Set();
  for (const t of plan.tasks) {
    if (!t?.key || !t?.title) throw invalid("\u6BCF\u500B\u4EFB\u52D9\u90FD\u9700\u8981 key \u548C title");
    if (keys.has(t.key)) throw invalid(`\u4EFB\u52D9 key \u91CD\u8907\uFF1A${t.key}`);
    keys.add(t.key);
  }
  for (const t of plan.tasks) {
    for (const d of t.deps ?? []) {
      if (String(d) === t.key) throw invalid(`\u4EFB\u52D9 ${t.key} \u4E0D\u80FD\u4F9D\u8CF4\u81EA\u5DF1`);
      if (!keys.has(String(d)) && issueRef(d) === null) throw invalid(`\u4EFB\u52D9 ${t.key} \u4F9D\u8CF4\u4E86\u4E0D\u5B58\u5728\u7684 ${d}`);
    }
  }
  const inner = (t) => (t.deps ?? []).map(String).filter((d) => keys.has(d));
  const indeg = new Map(plan.tasks.map((t) => [t.key, inner(t).length]));
  const queue = plan.tasks.filter((t) => !inner(t).length);
  const order = [];
  while (queue.length) {
    const t = queue.shift();
    order.push(t);
    for (const u of plan.tasks) {
      if (inner(u).includes(t.key)) {
        const n = indeg.get(u.key) - 1;
        indeg.set(u.key, n);
        if (n === 0) queue.push(u);
      }
    }
  }
  if (order.length !== plan.tasks.length) throw invalid("\u4EFB\u52D9\u4F9D\u8CF4\u5B58\u5728\u74B0\uFF0C\u5FC5\u9808\u662F\u6709\u5411\u7121\u74B0\u5716");
  return { tasks: plan.tasks, order };
}
function projectBlock(p) {
  const b = {
    key: p.key,
    priority: p.priority,
    max_parallel: p.max_parallel === null ? "none" : p.max_parallel,
    repo: p.repo,
    base: p.base,
    merge_on_approve: p.merge_on_approve,
    kind: p.kind,
    managers: p.managers,
    contributors: p.contributors,
    viewers: p.viewers
  };
  if (p.merge_method) b.merge_method = p.merge_method;
  return b;
}
function taskBlock(t) {
  const b = { key: t.key, project: t.project, deps: t.deps, caps: t.caps };
  if (t.branch) b.branch = t.branch;
  return b;
}
var taskLabels = (key, caps, human, state) => [
  LABELS.task,
  `project:${key}`,
  STATUS_LABEL[state],
  ...caps.map((c) => `cap:${c}`),
  ...human ? [LABELS.human] : []
];
var changeNote = (by, changes) => `**\u9805\u76EE\u8A2D\u5B9A\u66F4\u65B0** \xB7 ${by}

${changes.map((c) => `- ${c}`).join("\n")}`;
var PmOps = class {
  constructor(hub) {
    this.hub = hub;
  }
  hub;
  async who() {
    const [me, admin] = await Promise.all([this.hub.me(), this.hub.isAdmin()]);
    return { me, admin };
  }
  async mustManage(p, what) {
    const { me, admin } = await this.who();
    if (!isManager(p, me, admin)) {
      throw forbidden(`${me} \u4E0D\u662F\u9805\u76EE\u300C${p.title}\u300D\u7684 manager\uFF0C\u4E0D\u80FD${what}\u3002\u8ACB\u9805\u76EE\u8CA0\u8CAC\u4EBA\u5728\u9805\u76EE\u8A2D\u5B9A\u88E1\u628A\u4F60\u52A0\u9032 managers`);
    }
    return me;
  }
  // ───────────── 建 hub ─────────────
  async init(opts = {}) {
    const notes = [];
    const me = await this.hub.me();
    let info = await this.hub.gh.getOrNull(
      `/repos/${this.hub.name}`
    );
    let created = false;
    if (!info) {
      if (!opts.create) throw new PmError("not_found", `\u627E\u4E0D\u5230 ${this.hub.name}\u3002\u5148\u5728 GitHub \u5EFA\u4E00\u500B\u79C1\u6709\u5009\u5EAB\uFF0C\u6216\u52A0 --create \u8B93 apm \u5EFA`);
      const body = { name: this.hub.repo.name, private: true, has_wiki: false, description: opts.description ?? "agent-pm hub\uFF1A\u9805\u76EE\u548C\u4EFB\u52D9\u90FD\u5728 Issues \u88E1" };
      info = await this.hub.gh.post(this.hub.repo.owner === me ? "/user/repos" : `/orgs/${this.hub.repo.owner}/repos`, body);
      created = true;
    }
    if (!info.private) {
      throw forbidden(
        `${this.hub.name} \u662F\u516C\u958B\u5009\u5EAB\u3002hub \u5FC5\u9808\u662F\u79C1\u6709\u7684\uFF1A\u4EFB\u52D9\u6B63\u6587\u6703\u88AB agent \u7576\u4F5C\u6307\u4EE4\u57F7\u884C\uFF0C\u516C\u958B\u7B49\u65BC\u4EFB\u4F55\u4EBA\u90FD\u80FD\u4E0B\u6307\u4EE4\u3002\u5230\u5009\u5EAB Settings \u2192 General \u2192 Danger Zone \u6539\u6210 Private`
      );
    }
    if (info.permissions && !info.permissions.push) throw forbidden(`${me} \u6C92\u6709 ${this.hub.name} \u7684\u5BEB\u5165\u6B0A\u9650`);
    const base = [LABELS.project, LABELS.task, LABELS.roster, LABELS.human, ...Object.values(STATUS_LABEL).filter((l) => !!l)];
    await this.hub.ensureLabels(base);
    const configText = [
      "# agent-pm hub \u8A2D\u5B9A\uFF08\u6539\u5B8C commit \u5C31\u751F\u6548\uFF09",
      `# \u79DF\u7D04\u6642\u9577\uFF1A\u6301\u6709\u8005\u8D85\u904E\u9019\u9EBC\u4E45\u6C92\u7E8C\u7D04\uFF0C\u5225\u4EBA\u5C31\u53EF\u4EE5\u63A5\u624B`,
      `lease_minutes: ${DEFAULT_CONFIG.lease_minutes}`,
      `# apm keepalive \u7684\u7E8C\u7D04\u9593\u9694`,
      `heartbeat_minutes: ${DEFAULT_CONFIG.heartbeat_minutes}`,
      `# agent \u9019\u9EBC\u4E45\u6C92\u8ABF\u7528\u4EFB\u4F55 apm \u547D\u4EE4\uFF0Ckeepalive \u5C31\u505C\u6B62\u7E8C\u7D04\uFF08\u9632\u6B62\u6B7B\u6389\u7684 agent \u4E00\u76F4\u4F54\u8457\u4EFB\u52D9\uFF09`,
      `idle_minutes: ${DEFAULT_CONFIG.idle_minutes}`,
      `# \u9664\u4E86\u5009\u5EAB admin \u4E4B\u5916\u7684 hub \u7BA1\u7406\u54E1`,
      `admins: [${me}]`,
      ""
    ].join("\n");
    let config = "exists";
    const existing = await this.hub.gh.getOrNull(`/repos/${this.hub.name}/contents/.agent-pm/config.yml`);
    if (!existing) {
      const branches = await this.hub.gh.get(`/repos/${this.hub.name}/branches?per_page=1`);
      const readme = hubReadme(this.hub.name);
      if (!branches.length) {
        const store = this.hub.locks;
        if (store.initBranch) {
          await store.initBranch(info.default_branch || "main", { ".agent-pm/config.yml": configText, "README.md": readme }, "agent-pm: \u521D\u59CB\u5316 hub");
          config = "created";
        } else config = "default";
      } else {
        try {
          await this.hub.gh.put(`/repos/${this.hub.name}/contents/.agent-pm/config.yml`, {
            message: "agent-pm: \u52A0\u4E0A hub \u8A2D\u5B9A",
            content: Buffer.from(configText).toString("base64")
          });
          config = "created";
        } catch {
          config = "default";
          notes.push("\u6C92\u80FD\u5BEB\u5165 .agent-pm/config.yml\uFF0C\u5148\u7528\u9810\u8A2D\u8A2D\u5B9A\uFF08\u79DF\u7D04 10 \u5206\u9418\uFF09\u3002\u8981\u6539\u7684\u8A71\u624B\u52D5\u5728\u5009\u5EAB\u52A0\u9019\u500B\u6A94\u6848");
        }
      }
    }
    const roster = await this.hub.rosterIssue();
    if (!await this.hub.isAdmin(me)) notes.push(`${me} \u4E0D\u662F hub \u7684 admin\uFF1A\u9080\u8ACB\u6210\u54E1\u3001\u5F37\u5236\u6536\u56DE\u8981\u7531 admin \u505A`);
    return { hub: this.hub.name, url: info.html_url, private: true, created_repo: created, config, roster, labels: base.length, notes };
  }
  // ───────────── 項目 ─────────────
  async createProject(plan, opts = {}) {
    const { order } = validatePlan(plan);
    const me = await this.hub.me();
    const key = plan.key ?? `p-${Math.random().toString(36).slice(2, 6)}`;
    const allProjects = await this.hub.projects("all");
    let project = allProjects.find((p) => p.key === key && p.open) ?? null;
    if (project && !opts.resume) {
      throw conflict(`\u9805\u76EE\u77ED\u540D ${key} \u5DF2\u88AB #${project.number}\u300C${project.title}\u300D\u4F7F\u7528\u3002\u662F\u4E0A\u6B21\u5EFA\u5230\u4E00\u534A\u7684\u8A71\uFF0C\u52A0 --resume \u88DC\u9F4A\u7F3A\u7684\u4EFB\u52D9`);
    }
    const members = plan.members ?? [];
    const pick = (role, extra) => checkLogins([...extra ?? [], ...members.filter((m) => m.role === role).map((m) => m.user_id)], role);
    const settings = {
      key,
      priority: checkPriority(plan.priority ?? 3),
      max_parallel: checkQuota(plan.max_parallel ?? null),
      repo: checkRepo(plan.repo),
      base: plan.base?.trim() || null,
      merge_on_approve: plan.merge_on_approve !== false,
      merge_method: plan.merge_method,
      kind: plan.kind ?? "dev",
      managers: pick("manager", plan.managers),
      contributors: pick("contributor", plan.contributors),
      viewers: pick("viewer", plan.viewers)
    };
    if (settings.repo && settings.repo !== this.hub.name) {
      const r = await this.hub.gh.getOrNull(`/repos/${settings.repo}`);
      if (!r) throw invalid(`\u627E\u4E0D\u5230\u4EE3\u78BC\u5009\u5EAB ${settings.repo}\uFF0C\u6216 ${me} \u6C92\u6709\u6B0A\u9650`);
    }
    const caps = new Set(plan.tasks.flatMap(capsOf));
    await this.hub.ensureLabels([
      LABELS.project,
      LABELS.task,
      `project:${key}`,
      STATUS_LABEL.ready,
      STATUS_LABEL.pending,
      ...[...caps].map((c) => `cap:${c}`),
      ...plan.tasks.some((t) => t.human_review) ? [LABELS.human] : []
    ]);
    if (!project) {
      const issue = await this.hub.createIssue({
        title: plan.title.trim(),
        body: writeBodyBlock(plan.description ?? "", "apm:project", projectBlock(settings)),
        labels: [LABELS.project, `project:${key}`]
      });
      project = toProject(issue);
    }
    const existing = opts.resume ? (await this.hub.tasks("all")).filter((t) => t.project === project.number) : [];
    const numberOf = new Map(existing.map((t) => [t.key, t.number]));
    const openNow = new Set((await this.hub.tasks("open")).map((t) => t.number));
    const created = [];
    for (const t of order) {
      if (numberOf.has(t.key)) continue;
      const deps = (t.deps ?? []).map((d) => numberOf.get(String(d)) ?? issueRef(d));
      for (const d of deps) {
        if (!numberOf.has(String(d)) && ![...numberOf.values()].includes(d)) {
          const ext = await this.hub.issue(d).catch(() => null);
          if (!ext || !toTask(ext)) throw invalid(`\u4EFB\u52D9 ${t.key} \u4F9D\u8CF4\u7684 #${d} \u4E0D\u662F agent-pm \u7684\u4EFB\u52D9`);
          if (ext.state === "open") openNow.add(d);
        }
      }
      const state = deps.some((d) => openNow.has(d)) ? "pending" : "ready";
      const tc = capsOf(t);
      const issue = await this.hub.createIssue({
        title: t.title.trim(),
        body: writeBodyBlock(taskBody(t.description ?? "", t.acceptance ?? ""), "apm:task", taskBlock({ key: t.key, project: project.number, deps, caps: tc, branch: t.branch })),
        labels: taskLabels(key, tc, !!t.human_review, state)
      });
      numberOf.set(t.key, issue.number);
      openNow.add(issue.number);
      created.push({ key: t.key, number: issue.number, url: issue.html_url, state });
      await this.hub.addSubIssue(project.number, issue.id);
    }
    return {
      project: { number: project.number, key, title: project.title, url: project.url },
      tasks: created,
      skipped: existing.map((t) => ({ key: t.key, number: t.number }))
    };
  }
  async updateProject(ref, patch) {
    const p = await this.hub.project(ref);
    const me = await this.mustManage(p, "\u6539\u9805\u76EE\u8A2D\u5B9A");
    const next = {
      key: p.key,
      priority: p.priority,
      max_parallel: p.max_parallel,
      repo: p.repo,
      base: p.base,
      merge_on_approve: p.merge_on_approve,
      merge_method: p.block.merge_method ? String(p.block.merge_method) : void 0,
      kind: p.kind,
      managers: p.managers,
      contributors: p.contributors,
      viewers: p.viewers
    };
    const changes = [];
    if (patch.priority !== void 0) {
      const v = checkPriority(patch.priority);
      if (v !== p.priority) changes.push(`\u512A\u5148\u7D1A ${p.priority} \u2192 ${v}`);
      next.priority = v;
    }
    if (patch.max_parallel !== void 0) {
      const v = checkQuota(patch.max_parallel);
      if (v !== p.max_parallel) changes.push(`\u4E26\u884C\u914D\u984D ${p.max_parallel ?? "\u4E0D\u9650"} \u2192 ${v ?? "\u4E0D\u9650"}`);
      next.max_parallel = v;
    }
    if (patch.repo !== void 0) {
      const v = checkRepo(patch.repo);
      if (v !== p.repo) changes.push(`\u4EE3\u78BC\u5009\u5EAB ${p.repo ?? "\uFF08hub\uFF09"} \u2192 ${v ?? "\uFF08hub\uFF09"}`);
      next.repo = v;
    }
    if (patch.base !== void 0) {
      const v = patch.base?.trim() || null;
      if (v !== p.base) changes.push(`\u57FA\u790E\u5206\u652F ${p.base ?? "\uFF08\u9810\u8A2D\uFF09"} \u2192 ${v ?? "\uFF08\u9810\u8A2D\uFF09"}`);
      next.base = v;
    }
    if (patch.merge_on_approve !== void 0 && patch.merge_on_approve !== p.merge_on_approve) {
      changes.push(`\u6279\u51C6\u6642\u5408\u4F75 PR\uFF1A${p.merge_on_approve ? "\u662F" : "\u5426"} \u2192 ${patch.merge_on_approve ? "\u662F" : "\u5426"}`);
      next.merge_on_approve = patch.merge_on_approve;
    }
    if (patch.merge_method !== void 0) {
      if (!["squash", "merge", "rebase"].includes(patch.merge_method)) throw invalid("merge_method \u53EA\u80FD\u662F squash / merge / rebase");
      if (patch.merge_method !== next.merge_method) changes.push(`\u5408\u4F75\u65B9\u5F0F ${next.merge_method ?? "squash"} \u2192 ${patch.merge_method}`);
      next.merge_method = patch.merge_method;
    }
    const title = patch.title?.trim();
    if (title && title !== p.title) changes.push(`\u6A19\u984C\u300C${p.title}\u300D\u2192\u300C${title}\u300D`);
    if (!changes.length) return { project: p.number, changes };
    await this.hub.updateIssue(p.number, {
      ...title ? { title } : {},
      body: writeBodyBlock(p.rest, "apm:project", projectBlock(next))
    });
    await this.hub.comment(p.number, { kind: "project_updated", by: me, changes, at: this.hub.now() }, changeNote(me, changes));
    return { project: p.number, changes };
  }
  async setMember(ref, login, role) {
    const p = await this.hub.project(ref);
    const me = await this.mustManage(p, "\u6539\u6210\u54E1");
    const user = checkLogins([login], "\u5E33\u865F")[0];
    if (!user) throw invalid("\u9700\u8981 GitHub \u5E33\u865F");
    if (role !== "none" && !ROLES.includes(role)) throw invalid(`\u89D2\u8272\u53EA\u80FD\u662F ${ROLES.join(" / ")} \u6216 none\uFF08\u79FB\u9664\uFF09`);
    const lists = {
      managers: p.managers.filter((u) => u !== user),
      contributors: p.contributors.filter((u) => u !== user),
      viewers: p.viewers.filter((u) => u !== user)
    };
    if (role === "manager") lists.managers.push(user);
    if (role === "contributor") lists.contributors.push(user);
    if (role === "viewer") lists.viewers.push(user);
    if (role === "none" && p.author === user) throw invalid(`${user} \u662F\u9805\u76EE\u5EFA\u7ACB\u8005\uFF0C\u4E00\u76F4\u662F manager`);
    await this.hub.updateIssue(p.number, {
      body: writeBodyBlock(
        p.rest,
        "apm:project",
        projectBlock({
          key: p.key,
          priority: p.priority,
          max_parallel: p.max_parallel,
          repo: p.repo,
          base: p.base,
          merge_on_approve: p.merge_on_approve,
          merge_method: p.block.merge_method ? String(p.block.merge_method) : void 0,
          kind: p.kind,
          ...lists
        })
      )
    });
    const change = role === "none" ? `\u79FB\u9664\u6210\u54E1 ${user}` : `${user} \u7684\u89D2\u8272\u8A2D\u70BA ${role}`;
    await this.hub.comment(p.number, { kind: "project_updated", by: me, changes: [change], at: this.hub.now() }, changeNote(me, [change]));
    let collaborator = null;
    try {
      await this.hub.gh.get(`/repos/${this.hub.name}/collaborators/${user}`);
      collaborator = true;
    } catch {
      collaborator = role === "none" ? null : false;
    }
    return {
      project: p.number,
      user,
      role,
      hint: collaborator === false ? `${user} \u9084\u4E0D\u662F hub \u7684\u5354\u4F5C\u8005\uFF0C\u8ACB\u7BA1\u7406\u54E1\u9080\u8ACB\uFF1Aapm invite ${user}` : void 0
    };
  }
  /** 交付（所有任務都關了）或取消（--cancel：剩下的任務一起以 not planned 關閉） */
  async closeProject(ref, opts = {}) {
    const p = await this.hub.project(ref);
    const me = await this.mustManage(p, "\u95DC\u9589\u9805\u76EE");
    const open = (await this.hub.tasks("open")).filter((t) => t.project === p.number);
    if (open.length && !opts.cancel) {
      throw conflict(`\u9805\u76EE\u9084\u6709 ${open.length} \u500B\u4EFB\u52D9\u6C92\u5B8C\u6210\uFF08${open.map((t) => `#${t.number}`).join("\u3001")}\uFF09\u3002\u8981\u653E\u68C4\u5B83\u5011\u5C31\u52A0 --cancel`);
    }
    for (const t of open) await this.hub.updateIssue(t.number, { state: "closed", state_reason: "not_planned" });
    await this.deliver(p, me, opts.cancel ? "not_planned" : "completed", opts.note);
    return { project: p.number, cancelled_tasks: open.map((t) => t.number), state: opts.cancel ? "cancelled" : "delivered" };
  }
  async deliver(p, by, reason, note) {
    await this.hub.comment(
      p.number,
      { kind: reason === "completed" ? "delivered" : "cancelled", by, at: this.hub.now() },
      reason === "completed" ? `**\u9805\u76EE\u4EA4\u4ED8** \xB7 ${by}${note ? `

${note}` : "\n\n\u6240\u6709\u4EFB\u52D9\u90FD\u5DF2\u5B8C\u6210\u3002"}` : `**\u9805\u76EE\u53D6\u6D88** \xB7 ${by}${note ? `

${note}` : ""}`
    );
    await this.hub.updateIssue(p.number, { state: "closed", state_reason: reason });
  }
  // ───────────── 看狀態 ─────────────
  async status(ref) {
    const model = await loadModel(this.hub);
    const now = this.hub.now();
    const snap = deriveSnapshot(model, now);
    let projects = snap.projects;
    if (ref !== void 0) {
      const p = await this.hub.project(ref);
      projects = projects.filter((x) => x.number === p.number);
    } else projects = projects.filter((p) => p.status === "active");
    const ids = new Set(projects.map((p) => p.id));
    const tasks = snap.tasks.filter((t) => ids.has(t.project_id));
    return {
      hub: this.hub.name,
      now,
      projects: projects.map((p) => {
        const mine = tasks.filter((t) => t.project_id === p.id);
        const counts = {};
        for (const t of mine) counts[t.state] = (counts[t.state] ?? 0) + 1;
        const info = model.projects.find((x) => x.number === p.number);
        return {
          number: p.number,
          key: p.key,
          title: p.title,
          url: p.url,
          status: p.status,
          priority: p.priority,
          max_parallel: p.max_parallel,
          repo: p.repo ?? this.hub.name,
          merge_on_approve: p.merge_on_approve,
          managers: [.../* @__PURE__ */ new Set([info.author, ...info.managers])],
          contributors: info.contributors,
          counts,
          tasks: mine.map((t) => taskRow(t, now))
        };
      }),
      workers: snap.workers.map((w) => ({ id: w.id, owner: w.owner, status: w.status, current_task: w.current_task ? Number(w.current_task) : null, labels: w.labels, last_seen: w.last_seen }))
    };
  }
  async showTask(n) {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    const [comments, lock, open] = await Promise.all([this.hub.comments(n), this.hub.locks.get(n), this.hub.tasks("open")]);
    const now = this.hub.now();
    const view = deriveTask(t, p.key, comments, lock, now, depsDone(t, new Set(open.map((x) => x.number))));
    return {
      ...taskRow(view, now),
      project: { number: p.number, key: p.key, title: p.title },
      description: view.description,
      acceptance: view.acceptance,
      deps: t.deps,
      caps: t.caps,
      branch: view.branch,
      repo: p.repo ?? this.hub.name,
      result: view.result,
      reviews: view.reviews,
      blocked_reason: view.blocked_reason,
      resume: resumeOf({ ...view, state: view.state === "claimed" ? "ready" : view.state }),
      lock: lock ? { ...stripSha(lock), alive: isAlive(lock, now) } : null,
      worklog: view.worklog
    };
  }
  // ───────────── 重新拆解 ─────────────
  async addTask(ref, t) {
    const p = await this.hub.project(ref);
    if (!p.open) throw conflict(`\u9805\u76EE\u300C${p.title}\u300D\u5DF2\u7D93\u95DC\u9589`);
    await this.mustManage(p, "\u52A0\u4EFB\u52D9");
    if (!t?.key || !t?.title) throw invalid("\u4EFB\u52D9\u9700\u8981 key \u548C title");
    const all = await this.hub.tasks("all");
    const siblings = all.filter((x) => x.project === p.number);
    if (siblings.some((x) => x.key === t.key && !(x.state_reason === "not_planned" && !x.open))) {
      throw conflict(`\u9805\u76EE\u88E1\u5DF2\u7D93\u6709 key \u70BA ${t.key} \u7684\u4EFB\u52D9`);
    }
    const deps = this.resolveDeps(t.deps ?? [], siblings, all, t.key);
    const open = new Set(all.filter((x) => x.open).map((x) => x.number));
    const state = deps.some((d) => open.has(d)) ? "pending" : "ready";
    const caps = capsOf(t);
    const labels = taskLabels(p.key, caps, !!t.human_review, state);
    await this.hub.ensureLabels(labels);
    const issue = await this.hub.createIssue({
      title: t.title.trim(),
      body: writeBodyBlock(taskBody(t.description ?? "", t.acceptance ?? ""), "apm:task", taskBlock({ key: t.key, project: p.number, deps, caps, branch: t.branch })),
      labels
    });
    await this.hub.addSubIssue(p.number, issue.id);
    return { number: issue.number, key: t.key, url: issue.html_url, state, deps };
  }
  resolveDeps(deps, siblings, all, self) {
    const out2 = [];
    for (const d of deps) {
      const byKey = siblings.find((x) => x.key === String(d));
      const n = byKey?.number ?? issueRef(d);
      if (n === null || n === void 0 || !all.some((x) => x.number === n)) throw invalid(`\u4F9D\u8CF4\u300C${d}\u300D\u627E\u4E0D\u5230\uFF1A\u5BEB\u540C\u9805\u76EE\u4EFB\u52D9\u7684 key\uFF0C\u6216\u4EFB\u52D9\u7684 Issue \u7DE8\u865F`);
      if (String(d) === self) throw invalid("\u4EFB\u52D9\u4E0D\u80FD\u4F9D\u8CF4\u81EA\u5DF1");
      out2.push(n);
    }
    return [...new Set(out2)];
  }
  async editTask(n, patch) {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    await this.mustManage(p, "\u6539\u4EFB\u52D9");
    if (!t.open) throw conflict(`\u4EFB\u52D9 #${n} \u5DF2\u7D93\u95DC\u9589`);
    const all = await this.hub.tasks("all");
    const changes = [];
    let deps = t.deps;
    if (patch.deps !== void 0) {
      deps = this.resolveDeps(patch.deps, all.filter((x) => x.project === p.number), all, t.key);
      if (deps.includes(n)) throw invalid("\u4EFB\u52D9\u4E0D\u80FD\u4F9D\u8CF4\u81EA\u5DF1");
      const graph = new Map(all.map((x) => [x.number, x.number === n ? deps : x.deps]));
      const seen = /* @__PURE__ */ new Set();
      const stack = [...deps];
      while (stack.length) {
        const k = stack.pop();
        if (k === n) throw invalid("\u9019\u6A23\u6539\u6703\u8B93\u4EFB\u52D9\u4F9D\u8CF4\u6210\u74B0");
        if (seen.has(k)) continue;
        seen.add(k);
        stack.push(...graph.get(k) ?? []);
      }
      changes.push(`\u4F9D\u8CF4 ${t.deps.map((d) => `#${d}`).join("\u3001") || "\uFF08\u7121\uFF09"} \u2192 ${deps.map((d) => `#${d}`).join("\u3001") || "\uFF08\u7121\uFF09"}`);
    }
    const caps = patch.caps !== void 0 ? [...new Set(patch.caps.map((c) => c.trim()).filter(Boolean))] : t.caps;
    if (patch.caps !== void 0) changes.push(`\u80FD\u529B ${t.caps.join("\u3001") || "\uFF08\u7121\uFF09"} \u2192 ${caps.join("\u3001") || "\uFF08\u7121\uFF09"}`);
    const human = patch.human_review ?? t.human_review;
    if (patch.human_review !== void 0 && patch.human_review !== t.human_review) changes.push(human ? "\u6539\u6210\u5FC5\u9808\u7531\u4EBA\u6279\u51C6" : "\u4E0D\u518D\u8981\u6C42\u7531\u4EBA\u6279\u51C6");
    const description = patch.description ?? t.description;
    const acceptance = patch.acceptance ?? t.acceptance;
    if (patch.description !== void 0) changes.push("\u6539\u4E86\u8AAA\u660E");
    if (patch.acceptance !== void 0) changes.push("\u6539\u4E86\u9A57\u6536\u6A19\u6E96");
    if (patch.title !== void 0) changes.push(`\u6A19\u984C \u2192 ${patch.title}`);
    const branch = patch.branch === void 0 ? t.branch : patch.branch;
    if (patch.branch !== void 0) changes.push(`\u5206\u652F \u2192 ${branch ?? "\uFF08\u6309\u898F\u5247\u751F\u6210\uFF09"}`);
    if (!changes.length) return { task: n, changes };
    const open = new Set(all.filter((x) => x.open).map((x) => x.number));
    let labels = t.labels.filter((l) => !l.startsWith("cap:") && l !== LABELS.human);
    labels.push(...caps.map((c) => `cap:${c}`));
    if (human) labels.push(LABELS.human);
    if (t.status === "pending" || t.status === "ready") {
      const st = deps.some((d) => open.has(d)) ? "pending" : "ready";
      labels = [...labels.filter((l) => !l.startsWith("status:")), STATUS_LABEL[st]];
    }
    await this.hub.ensureLabels(labels);
    await this.hub.updateIssue(n, {
      ...patch.title?.trim() ? { title: patch.title.trim() } : {},
      body: writeBodyBlock(taskBody(description, acceptance), "apm:task", taskBlock({ key: t.key, project: p.number, deps, caps, branch })),
      labels
    });
    return { task: n, changes };
  }
  /** 取消一個任務（以 not planned 關閉）。依賴它的任務會被當作依賴已滿足 */
  async cancelTask(n, note = "") {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    const me = await this.mustManage(p, "\u53D6\u6D88\u4EFB\u52D9");
    const lock = await this.hub.locks.get(n);
    if (lock && isAlive(lock, this.hub.now())) {
      await this.hub.locks.force({ ...stripSha(lock), status: "revoked", at: this.hub.now(), expires_at: null, reason: "cancelled" });
    }
    await this.hub.comment(n, { kind: "cancelled", by: me, note, at: this.hub.now() }, `**\u4EFB\u52D9\u53D6\u6D88** \xB7 ${me}${note ? `

${note}` : ""}`);
    await this.hub.setStatus(t, "done", { state: "closed", state_reason: "not_planned" });
    const unlocked = await this.unlockDependents(n);
    return { task: n, unlocked };
  }
  // ───────────── review、解除阻塞、收回 ─────────────
  async viewOf(n) {
    const t = await this.hub.task(n);
    const p = await this.hub.project(t.project);
    const [comments, lock] = await Promise.all([this.hub.comments(n), this.hub.locks.get(n)]);
    const view = deriveTask(t, p.key, comments, lock, this.hub.now(), true);
    return { t, p, view, lock };
  }
  async review(n, decision, comment = "", opts = {}) {
    const { t, p, view } = await this.viewOf(n);
    const me = opts.reviewer ?? await this.mustManage(p, "review");
    if (view.state !== "in_review") throw conflict(`\u4EFB\u52D9 #${n} \u73FE\u5728\u662F ${view.state}\uFF0C\u53EA\u6709 in_review\uFF08\u5DF2\u4EA4\u4ED8\uFF09\u7684\u4EFB\u52D9\u80FD review`);
    if (decision === "reject" && !comment.trim()) throw invalid("\u9000\u56DE\u8981\u5BEB\u610F\u898B\uFF08--comment\uFF09\uFF1A\u54EA\u689D\u9A57\u6536\u6A19\u6E96\u6C92\u9054\u5230\u3001\u8981\u600E\u9EBC\u6539");
    if (decision === "approve" && t.human_review && !opts.human && !opts.viaGitHub) {
      throw forbidden(`\u4EFB\u52D9 #${n} \u5E36 review:human \u6A19\u7C64\uFF0C\u5FC5\u9808\u7531\u4EBA\u6279\u51C6\u3002PM agent \u8ACB\u628A\u610F\u898B\u6574\u7406\u7D66\u4EBA\u770B\uFF1B\u4EBA\u78BA\u8A8D\u904E\u4E86\u518D\u52A0 --human`);
    }
    const pr = view.result?.pr_url ?? null;
    let merged = false;
    if (decision === "approve" && pr && p.merge_on_approve && opts.merge !== false) {
      merged = await this.mergePr(pr, p);
    }
    const meta = { kind: "review", reviewer: me, decision, comment: comment.trim(), at: this.hub.now(), merged: merged || void 0 };
    await this.hub.comment(
      n,
      meta,
      decision === "approve" ? `**\u901A\u904E** \xB7 ${me}${merged ? "\uFF0CPR \u5DF2\u5408\u4F75" : ""}${comment.trim() ? `

${comment.trim()}` : ""}` : `**\u9000\u56DE\u4FEE\u6539** \xB7 ${me}

${comment.trim()}`
    );
    if (decision === "reject") {
      await this.hub.setStatus(t, "changes_requested");
      if (pr && !opts.viaGitHub) {
        const m = pr.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
        if (m) await this.hub.plainComment(m[1], Number(m[2]), `**\u9000\u56DE\u4FEE\u6539**\uFF08agent-pm\uFF0C${me}\uFF09

${comment.trim()}

\u4EFB\u52D9\uFF1A${this.hub.name}#${n}`).catch(() => void 0);
      }
      return { task: n, decision, merged: false, pr_url: pr, unlocked: [], delivered: false };
    }
    await this.hub.setStatus(t, "done", { state: "closed", state_reason: "completed" });
    const unlocked = await this.unlockDependents(n);
    let delivered = false;
    const left = (await this.hub.tasks("open")).filter((x) => x.project === p.number && x.number !== n);
    if (!left.length) {
      await this.deliver(p, me, "completed");
      delivered = true;
    }
    return { task: n, decision, merged, pr_url: pr, unlocked, delivered };
  }
  /** 上游完成後，依賴都齊了的下游從 pending 改成 ready（狀態推導本來就會這樣算，這裡是讓標籤跟上） */
  async unlockDependents(done) {
    const open = await this.hub.tasks("open");
    const openSet = new Set(open.map((x) => x.number));
    openSet.delete(done);
    const out2 = [];
    for (const d of open) {
      if (!d.deps.includes(done) || !depsDone(d, openSet)) continue;
      if (d.status === "pending" || d.status === null) {
        await this.hub.setStatus(d, "ready");
        out2.push(d.number);
      }
    }
    return out2;
  }
  async mergePr(url, p) {
    const m = url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (!m) return false;
    const [, repo, num2] = m;
    const pr = await this.hub.gh.get(`/repos/${repo}/pulls/${num2}`);
    if (pr.merged) return true;
    if (pr.state === "closed") throw conflict(`PR ${url} \u5DF2\u7D93\u95DC\u9589\u4F46\u6C92\u6709\u5408\u4F75\u3002\u91CD\u65B0\u6253\u958B\u5B83\uFF0C\u6216\u52A0 --no-merge \u53EA\u95DC\u9589\u4EFB\u52D9`);
    const preferred = String(p.block.merge_method ?? "squash");
    const methods = [preferred, ...["squash", "merge", "rebase"].filter((x) => x !== preferred)];
    let last = "";
    for (const merge_method of methods) {
      try {
        await this.hub.gh.put(`/repos/${repo}/pulls/${num2}/merge`, { merge_method, sha: pr.head.sha, commit_title: `${pr.title} (#${num2})` });
        return true;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        if (!/not allowed|merge method/i.test(last)) break;
      }
    }
    throw conflict(`PR ${url} \u5408\u4F75\u5931\u6557\uFF1A${last}\u3002\u6709\u885D\u7A81\u6216\u6AA2\u67E5\u6C92\u904E\u7684\u8A71\uFF0C\u5148 reject \u8B93 worker \u8655\u7406\uFF1B\u53EA\u60F3\u95DC\u9589\u4EFB\u52D9\u5C31\u52A0 --no-merge`);
  }
  async unblock(n, note = "") {
    const { t, p, view } = await this.viewOf(n);
    const me = await this.mustManage(p, "\u89E3\u9664\u963B\u585E");
    if (view.state !== "blocked") throw conflict(`\u4EFB\u52D9 #${n} \u73FE\u5728\u662F ${view.state}\uFF0C\u4E0D\u662F blocked`);
    await this.hub.comment(n, { kind: "unblocked", by: me, note: note.trim(), at: this.hub.now() }, `**\u89E3\u9664\u963B\u585E** \xB7 ${me}${note.trim() ? `

${note.trim()}` : ""}`);
    const open = new Set((await this.hub.tasks("open")).map((x) => x.number));
    await this.hub.setStatus(t, depsDone(t, open) ? "ready" : "pending");
    return { task: n, state: depsDone(t, open) ? "ready" : "pending" };
  }
  /** 管理員或 manager 強制收回一個正在執行的任務。持有者下一次續約會收到 lease_lost */
  async revoke(n, note = "") {
    const { t, p, lock } = await this.viewOf(n);
    const me = await this.mustManage(p, "\u6536\u56DE\u4EFB\u52D9");
    if (!lock || lock.status !== "held") throw conflict(`\u4EFB\u52D9 #${n} \u6C92\u6709\u4EBA\u5728\u505A`);
    const now = this.hub.now();
    await this.hub.locks.force({ ...stripSha(lock), status: "revoked", at: now, expires_at: null, reason: "revoked" });
    await this.hub.comment(
      n,
      { kind: "revoked", by: me, attempt: lock.attempt, worker: lock.worker, note: note.trim(), at: now },
      `**\u6536\u56DE\u4EFB\u52D9** \xB7 ${me} \u6536\u56DE\u4E86 ${lock.worker}\uFF08\u7B2C ${lock.attempt} \u6B21\u9818\u53D6\uFF09\u624B\u4E0A\u7684\u4EFB\u52D9${note.trim() ? `

${note.trim()}` : ""}`
    );
    await this.hub.setStatus(t, "ready");
    return { task: n, from: lock.worker, attempt: lock.attempt };
  }
  // ───────────── 對齊、鎖、成員 ─────────────
  /** 讓標籤跟上鎖和 Issue 開關；讀 PR 的狀態補上在 GitHub 網頁上做的 review；全部完成的項目交付 */
  async reconcile(opts = {}) {
    const model = await loadModel(this.hub);
    const now = this.hub.now();
    const snap = deriveSnapshot(model, now);
    const byNumber = new Map(model.tasks.map((t) => [t.number, t]));
    const changes = [];
    for (const v of snap.tasks) {
      const t = byNumber.get(v.number);
      if (!t.open) continue;
      const want = STATUS_LABEL[v.state];
      const has = t.labels.filter((l) => l.startsWith("status:"));
      if (want && !(has.length === 1 && has[0] === want)) {
        changes.push({ task: t.number, change: `\u6A19\u7C64 ${has.join(",") || "\uFF08\u7121\uFF09"} \u2192 ${want}` });
        if (!opts.dryRun) await this.hub.setStatus(t, v.state);
      }
    }
    if (opts.prs !== false) {
      for (const v of snap.tasks) {
        if (v.state !== "in_review" || !v.result?.pr_url) continue;
        const p = model.projects.find((x) => x.number === Number(v.project_id));
        if (!p) continue;
        const outcome = await this.prOutcome(v, p, model.admins);
        if (!outcome) continue;
        changes.push({ task: v.number, change: `PR \u4E0A\u7684 review\uFF1A${outcome.decision === "approve" ? "\u5DF2\u6279\u51C6/\u5408\u4F75" : "\u8981\u6C42\u4FEE\u6539"}\uFF08${outcome.by}\uFF09` });
        if (!opts.dryRun) {
          await this.review(v.number, outcome.decision, outcome.comment, { reviewer: outcome.by, viaGitHub: true, merge: outcome.merged ? false : void 0 }).catch(
            (err) => changes.push({ task: v.number, change: `\u6C92\u80FD\u5957\u7528\uFF1A${err instanceof Error ? err.message : err}` })
          );
        }
      }
    }
    if (!opts.dryRun) {
      const open = await this.hub.tasks("open");
      for (const p of await this.hub.projects("open")) {
        const has = model.tasks.some((t) => t.project === p.number);
        if (has && !open.some((t) => t.project === p.number)) {
          changes.push({ project: p.number, change: "\u6240\u6709\u4EFB\u52D9\u90FD\u5B8C\u6210\u4E86\uFF0C\u4EA4\u4ED8\u9805\u76EE" });
          await this.deliver(p, await this.hub.me(), "completed");
        }
      }
    }
    return { changes, dry_run: !!opts.dryRun };
  }
  async prOutcome(v, p, admins) {
    const m = v.result.pr_url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (!m) return null;
    const [, repo, num2] = m;
    const pr = await this.hub.gh.getOrNull(`/repos/${repo}/pulls/${num2}`);
    if (!pr) return null;
    if (pr.merged) return { decision: "approve", by: pr.merged_by?.login ?? "github", comment: "PR \u5DF2\u5728 GitHub \u4E0A\u5408\u4F75", merged: true };
    const reviews = await this.hub.gh.get(
      `/repos/${repo}/pulls/${num2}/reviews?per_page=100`
    );
    const since = v.result.submitted_at;
    const relevant = reviews.filter((r) => r.user && Date.parse(r.submitted_at) > since && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")).filter((r) => isManager(p, r.user.login, admins.includes(r.user.login)));
    const last = relevant.at(-1);
    if (!last) return null;
    return {
      decision: last.state === "APPROVED" ? "approve" : "reject",
      by: last.user.login,
      comment: last.body?.trim() || (last.state === "APPROVED" ? "\u5728 GitHub \u4E0A\u6279\u51C6" : "\u5728 GitHub \u4E0A\u8981\u6C42\u4FEE\u6539\uFF0C\u898B PR"),
      merged: false
    };
  }
  async locks() {
    const [locks, tasks] = await Promise.all([this.hub.locks.list(), this.hub.tasks("all")]);
    const now = this.hub.now();
    const byNumber = new Map(tasks.map((t) => [t.number, t]));
    return [...locks.values()].sort((a, b) => a.task - b.task).map((l) => {
      const t = byNumber.get(l.task);
      return {
        task: l.task,
        title: t?.title ?? null,
        task_open: t?.open ?? false,
        worker: l.worker,
        owner: l.owner,
        attempt: l.attempt,
        status: l.status,
        alive: isAlive(l, now),
        expires_in_s: l.status === "held" && l.expires_at ? Math.round((l.expires_at - now) / 1e3) : null,
        at: l.at,
        sha: l.sha
      };
    });
  }
  /** 刪掉已關閉任務的鎖分支 */
  async prune(opts = {}) {
    const { me, admin } = await this.who();
    if (!admin) throw forbidden(`${me} \u4E0D\u662F hub \u7BA1\u7406\u54E1\uFF0C\u4E0D\u80FD\u6E05\u7406\u9396`);
    const [locks, open] = await Promise.all([this.hub.locks.list(), this.hub.tasks("open")]);
    const openSet = new Set(open.map((t) => t.number));
    const removed = [];
    const failed = [];
    for (const l of locks.values()) {
      if (openSet.has(l.task)) continue;
      if (opts.dryRun) {
        removed.push(l.task);
        continue;
      }
      try {
        if (await this.hub.locks.remove(l.task, l.sha)) removed.push(l.task);
      } catch (err) {
        failed.push({ task: l.task, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { removed, failed, dry_run: !!opts.dryRun };
  }
  async invite(login, permission = "push") {
    const user = checkLogins([login], "\u5E33\u865F")[0];
    const { me, admin } = await this.who();
    if (!admin) throw forbidden(`${me} \u4E0D\u662F hub \u7BA1\u7406\u54E1\uFF0C\u4E0D\u80FD\u9080\u8ACB\u6210\u54E1`);
    const r = await this.hub.gh.request("PUT", `/repos/${this.hub.name}/collaborators/${user}`, { permission });
    return { user, permission, state: r.status === 201 ? "invited" : "already_member", hint: r.status === 201 ? `\u8ACB ${user} \u5230 https://github.com/${this.hub.name}/invitations \u63A5\u53D7\u9080\u8ACB` : void 0 };
  }
  async uninvite(login) {
    const user = checkLogins([login], "\u5E33\u865F")[0];
    const { me, admin } = await this.who();
    if (!admin) throw forbidden(`${me} \u4E0D\u662F hub \u7BA1\u7406\u54E1`);
    await this.hub.gh.del(`/repos/${this.hub.name}/collaborators/${user}`);
    return { user, removed: true };
  }
  async collaborators() {
    const list2 = await this.hub.gh.paginate(
      `/repos/${this.hub.name}/collaborators?affiliation=all`
    );
    return list2.map((c) => ({ login: c.login, role: c.role_name ?? (c.permissions?.admin ? "admin" : c.permissions?.push ? "write" : "read") }));
  }
};
function taskRow(t, now) {
  return {
    number: t.number,
    key: t.key,
    title: t.title,
    url: t.url,
    state: t.state,
    expired: t.expired,
    assignee: t.assignee,
    last_assignee: t.last_assignee,
    attempt: t.attempt,
    progress: t.progress,
    lease_left_s: t.lease_expires_at ? Math.round((t.lease_expires_at - now) / 1e3) : null,
    human_review: t.human_review,
    pr_url: t.result?.pr_url ?? null
  };
}
function hubReadme(hub) {
  return `# agent-pm hub

\u9019\u500B\u79C1\u6709\u5009\u5EAB\u662F agent-pm \u7684\u300C\u4E2D\u9593\u5C64\u300D\uFF1A\u9805\u76EE\u548C\u4EFB\u52D9\u90FD\u662F\u9019\u88E1\u7684 Issue\uFF0C\u4EFB\u52D9\u7684\u9818\u53D6\u9396\u662F \`apm-lock/*\` \u5206\u652F\u3002
\u4E0D\u9700\u8981\u4EFB\u4F55\u670D\u52D9\u5668\u3002

- \u9805\u76EE\uFF1A\u5E36 \`apm:project\` \u6A19\u7C64\u7684 Issue\uFF0C\u4EFB\u52D9\u662F\u5B83\u7684 sub-issue
- \u4EFB\u52D9\uFF1A\u5E36 \`apm:task\` \u6A19\u7C64\u7684 Issue\uFF1B\u72C0\u614B\u770B \`status:*\` \u6A19\u7C64\uFF0C\u95DC\u9589 = \u5B8C\u6210
- \u63A5\u529B\u8A18\u9304\uFF1A\u4EFB\u52D9 Issue \u7684\u7559\u8A00
- Worker \u540D\u518A\uFF1A\u5E36 \`apm:roster\` \u6A19\u7C64\u7684 Issue
- \u8A2D\u5B9A\uFF1A\`.agent-pm/config.yml\`

## \u600E\u9EBC\u52A0\u5165

1. \u8ACB hub \u7BA1\u7406\u54E1\u9080\u8ACB\u4F60\u6210\u70BA\u5354\u4F5C\u8005\uFF08Write\uFF09\uFF0C\u5230 https://github.com/${hub}/invitations \u63A5\u53D7
2. \u5B89\u88DD GitHub CLI \u4E26\u767B\u5165\uFF1A\`gh auth login\`
3. \u5728 Claude Code \u88E1\u5B89\u88DD\u63D2\u4EF6\uFF1A
   \`\`\`
   /plugin marketplace add ali-sx-org-free/project_manager_and_worker
   /plugin install agent-pm@agent-pm
   \`\`\`
4. \u544A\u8A34 agent\uFF1A\u300C\u7528 agent-pm \u52A0\u5165 ${hub}\u300D\uFF0C\u6216\u81EA\u5DF1\u8DD1 \`apm setup --hub ${hub}\`

\u8ACB\u4E0D\u8981\u624B\u52D5\u6539 Issue \u6B63\u6587\u672B\u5C3E\u7684\u96B1\u85CF\u5340\u584A\uFF08\`<!-- apm:\u2026 -->\`\uFF09\uFF0C\u4E5F\u4E0D\u8981\u522A \`apm-lock/*\` \u5206\u652F\u3002
`;
}

// packages/github/src/selftest.ts
import { mkdtempSync, rmSync as rmSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// packages/github/src/fake.ts
var iso = (t) => t === null ? null : new Date(t).toISOString();
var FakeGitHub = class {
  users = /* @__PURE__ */ new Map();
  repos = /* @__PURE__ */ new Map();
  seq = 1e3;
  commentSeq = 5e3;
  /** 每個請求記一筆（測試用來數寫入次數） */
  log = [];
  clock;
  /** 測試用：讓某個請求失敗 */
  failNext = null;
  constructor(start = Date.parse("2026-11-22T00:00:00Z")) {
    this.clock = start;
  }
  now = () => this.clock;
  advance(ms) {
    this.clock += ms;
  }
  addUser(login) {
    const token = `tok-${login}`;
    this.users.set(token, { login, token });
    return token;
  }
  addRepo(full, opts = {}) {
    const [owner, name] = full.split("/");
    const r = {
      owner,
      name,
      private: opts.private ?? true,
      default_branch: "main",
      collaborators: /* @__PURE__ */ new Map(),
      invitations: /* @__PURE__ */ new Set(),
      issues: /* @__PURE__ */ new Map(),
      pulls: /* @__PURE__ */ new Map(),
      comments: /* @__PURE__ */ new Map(),
      labels: /* @__PURE__ */ new Map(),
      files: /* @__PURE__ */ new Map(),
      branches: new Set(opts.empty ? [] : ["main"]),
      next: 1,
      allowedMerge: /* @__PURE__ */ new Set(["merge", "squash", "rebase"])
    };
    if (opts.owner) r.collaborators.set(opts.owner, "admin");
    this.repos.set(full, r);
    return r;
  }
  repo(full) {
    const r = this.repos.get(full);
    if (!r) throw new Error(`fake: no repo ${full}`);
    return r;
  }
  grant(full, login, perm = "push") {
    this.repo(full).collaborators.set(login, perm);
  }
  /** 模擬 worker 開 PR */
  openPr(full, head, title, user) {
    const r = this.repo(full);
    const number = r.next++;
    r.pulls.set(number, { number, title, head, base: r.default_branch, state: "open", merged: false, merged_by: null, mergeable: true, user, reviews: [], sha: `sha${number}` });
    return `https://github.com/${full}/pull/${number}`;
  }
  reviewPr(full, n, user, state, body = "") {
    this.repo(full).pulls.get(n).reviews.push({ user, state, body, submitted_at: this.clock });
  }
  mergePrByHand(full, n, user) {
    const pr = this.repo(full).pulls.get(n);
    pr.merged = true;
    pr.state = "closed";
    pr.merged_by = user;
  }
  pull(full, n) {
    return this.repo(full).pulls.get(n);
  }
  writes() {
    return this.log.filter((l) => l.method !== "GET").length;
  }
  // ───────────────────────── HTTP ─────────────────────────
  transport = async (req) => {
    await Promise.resolve();
    const auth = req.headers.authorization?.replace(/^Bearer\s+/, "");
    const user = auth ? this.users.get(auth)?.login ?? null : null;
    const u = new URL(req.url);
    this.log.push({ method: req.method, path: u.pathname, user });
    const headers = {
      date: new Date(this.clock).toUTCString(),
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": String(Math.floor(this.clock / 1e3) + 3600)
    };
    const reply = (status, data) => ({
      status,
      headers,
      text: data === void 0 ? "" : JSON.stringify(data)
    });
    if (!user) return reply(401, { message: "Bad credentials" });
    const forced = this.failNext?.(req.method, u.pathname);
    if (forced) {
      this.failNext = null;
      return reply(forced.status, { message: forced.message });
    }
    try {
      const body = req.body ? JSON.parse(req.body) : {};
      return this.route(req.method, u, body, user, reply);
    } catch (err) {
      return reply(500, { message: err instanceof Error ? err.message : String(err) });
    }
  };
  route(method, u, body, user, reply) {
    const p = u.pathname;
    const q = u.searchParams;
    if (p === "/user" && method === "GET") return reply(200, { login: user });
    if (p === "/rate_limit") return reply(200, { resources: { core: { limit: 5e3, remaining: 4999 } } });
    if ((p === "/user/repos" || /^\/orgs\/[^/]+\/repos$/.test(p)) && method === "POST") {
      const owner = p === "/user/repos" ? user : p.split("/")[2];
      const full = `${owner}/${body.name}`;
      if (this.repos.has(full)) return reply(422, { message: "name already exists on this account" });
      const r2 = this.addRepo(full, { private: body.private !== false, owner: user, empty: true });
      return reply(201, this.repoJson(r2, user));
    }
    const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return reply(404, { message: "Not Found" });
    const r = this.repos.get(`${m[1]}/${m[2]}`);
    const perm = r?.collaborators.get(user);
    if (!r || !perm) return reply(404, { message: "Not Found" });
    const canWrite = perm === "admin" || perm === "push";
    const canTriage = canWrite || perm === "triage";
    const rest = m[3] ?? "";
    const page = (list2) => {
      const per = Number(q.get("per_page") ?? 30);
      const pg = Number(q.get("page") ?? 1);
      return list2.slice((pg - 1) * per, pg * per);
    };
    const now = this.clock;
    if (rest === "" && method === "GET") return reply(200, this.repoJson(r, user));
    let mm = rest.match(/^\/contents\/(.+)$/);
    if (mm) {
      const path = decodeURIComponent(mm[1]);
      if (method === "GET") {
        const f = r.files.get(path);
        return f === void 0 ? reply(404, { message: "Not Found" }) : reply(200, { content: Buffer.from(f).toString("base64"), encoding: "base64" });
      }
      if (method === "PUT") {
        if (!canWrite) return reply(403, { message: "Resource not accessible" });
        r.files.set(path, Buffer.from(String(body.content), "base64").toString("utf8"));
        r.branches.add(r.default_branch);
        return reply(201, { content: { path } });
      }
    }
    if (rest === "/branches") return reply(200, page([...r.branches].map((name) => ({ name }))));
    if (rest === "/labels") {
      if (method === "GET") return reply(200, page([...r.labels].map(([name, color]) => ({ name, color }))));
      if (method === "POST") {
        if (!canWrite) return reply(403, { message: "Resource not accessible" });
        if (r.labels.has(String(body.name))) return reply(422, { message: "Validation Failed", errors: [{ code: "already_exists" }] });
        r.labels.set(String(body.name), String(body.color ?? "cccccc"));
        return reply(201, { name: body.name });
      }
    }
    if (rest === "/collaborators" && method === "GET") {
      return reply(200, page([...r.collaborators].map(([login, perm2]) => ({ login, role_name: perm2 === "push" ? "write" : perm2 }))));
    }
    mm = rest.match(/^\/collaborators\/([^/]+)$/);
    if (mm) {
      const who = mm[1];
      if (method === "GET") return r.collaborators.has(who) ? reply(204) : reply(404, { message: "Not Found" });
      if (perm !== "admin") return reply(403, { message: "Must have admin rights" });
      if (method === "PUT") {
        if (r.collaborators.has(who)) {
          r.collaborators.set(who, body.permission ?? "push");
          return reply(204);
        }
        r.invitations.add(who);
        r.collaborators.set(who, body.permission ?? "push");
        return reply(201, { invitee: { login: who } });
      }
      if (method === "DELETE") {
        r.collaborators.delete(who);
        return reply(204);
      }
    }
    if (rest === "/issues/comments" && method === "GET") {
      const since = q.get("since") ? Date.parse(q.get("since")) : 0;
      const list2 = [...r.comments.values()].filter((c) => c.updated_at >= since).sort((a, b) => a.updated_at - b.updated_at || a.id - b.id);
      return reply(200, page(list2.map((c) => this.commentJson(r, c))));
    }
    mm = rest.match(/^\/issues\/comments\/(\d+)$/);
    if (mm) {
      const c = r.comments.get(Number(mm[1]));
      if (!c) return reply(404, { message: "Not Found" });
      if (method === "GET") return reply(200, this.commentJson(r, c));
      if (c.user !== user && !canWrite) return reply(403, { message: "Resource not accessible" });
      if (method === "PATCH") {
        c.body = String(body.body);
        c.updated_at = now;
        return reply(200, this.commentJson(r, c));
      }
      if (method === "DELETE") {
        r.comments.delete(c.id);
        return reply(204);
      }
    }
    if (rest === "/issues") {
      if (method === "GET") {
        const labels = (q.get("labels") ?? "").split(",").filter(Boolean);
        const state = q.get("state") ?? "open";
        const since = q.get("since") ? Date.parse(q.get("since")) : 0;
        const list2 = [...r.issues.values()].filter((i) => state === "all" || i.state === state).filter((i) => labels.every((l) => i.labels.includes(l))).filter((i) => i.updated_at >= since).sort((a, b) => a.created_at - b.created_at || a.number - b.number);
        return reply(200, page(list2.map((i) => this.issueJson(r, i))));
      }
      if (method === "POST") {
        if (!canTriage) return reply(403, { message: "Resource not accessible" });
        const number = r.next++;
        const labels = (body.labels ?? []).map(String);
        for (const l of labels) if (!r.labels.has(l)) r.labels.set(l, "ededed");
        const i = {
          id: ++this.seq,
          number,
          title: String(body.title),
          body: String(body.body ?? ""),
          state: "open",
          state_reason: null,
          labels,
          assignees: canWrite ? body.assignees ?? [] : [],
          user,
          created_at: now,
          updated_at: now,
          closed_at: null,
          sub_issues: []
        };
        r.issues.set(number, i);
        return reply(201, this.issueJson(r, i));
      }
    }
    mm = rest.match(/^\/issues\/(\d+)(\/.*)?$/);
    if (mm) {
      const n = Number(mm[1]);
      const sub = mm[2] ?? "";
      const i = r.issues.get(n);
      const pr = r.pulls.get(n);
      if (!i && !pr) return reply(404, { message: "Not Found" });
      if (sub === "" && i) {
        if (method === "GET") return reply(200, this.issueJson(r, i));
        if (method === "PATCH") {
          if (!canTriage) return reply(403, { message: "Resource not accessible" });
          if (body.title !== void 0) i.title = String(body.title);
          if (body.body !== void 0) i.body = String(body.body);
          if (body.labels !== void 0) {
            i.labels = body.labels.map(String);
            for (const l of i.labels) if (!r.labels.has(l)) r.labels.set(l, "ededed");
          }
          if (body.assignees !== void 0) {
            const bad = body.assignees.find((a) => !r.collaborators.has(a));
            if (bad) return reply(422, { message: `Validation Failed: ${bad} cannot be assigned` });
            i.assignees = body.assignees;
          }
          if (body.state !== void 0 && body.state !== i.state) {
            i.state = body.state;
            i.closed_at = i.state === "closed" ? now : null;
            i.state_reason = i.state === "closed" ? String(body.state_reason ?? "completed") : "reopened";
          } else if (body.state_reason !== void 0) i.state_reason = String(body.state_reason);
          i.updated_at = now;
          return reply(200, this.issueJson(r, i));
        }
      }
      if (sub === "/comments") {
        if (method === "GET") {
          const list2 = [...r.comments.values()].filter((c) => c.issue === n).sort((a, b) => a.created_at - b.created_at || a.id - b.id);
          return reply(200, page(list2.map((c) => this.commentJson(r, c))));
        }
        if (method === "POST") {
          const c = { id: ++this.commentSeq, issue: n, body: String(body.body), user, created_at: now, updated_at: now };
          r.comments.set(c.id, c);
          if (i) i.updated_at = now;
          return reply(201, this.commentJson(r, c));
        }
      }
      if (sub === "/sub_issues" && method === "POST" && i) {
        if (!canTriage) return reply(403, { message: "Resource not accessible" });
        const child = [...r.issues.values()].find((x) => x.id === Number(body.sub_issue_id));
        if (!child) return reply(422, { message: "Validation Failed" });
        if (i.sub_issues.length >= 100) return reply(422, { message: "Sub-issue limit reached" });
        i.sub_issues.push(child.number);
        return reply(201, this.issueJson(r, i));
      }
    }
    if (rest === "/pulls" && method === "GET") {
      const head = q.get("head");
      const state = q.get("state") ?? "open";
      const list2 = [...r.pulls.values()].filter((x) => state === "all" || x.state === state).filter((x) => !head || `${r.owner}:${x.head}` === head);
      return reply(200, page(list2.map((x) => this.pullJson(r, x))));
    }
    mm = rest.match(/^\/pulls\/(\d+)(\/.*)?$/);
    if (mm) {
      const pr = r.pulls.get(Number(mm[1]));
      if (!pr) return reply(404, { message: "Not Found" });
      const sub = mm[2] ?? "";
      if (sub === "" && method === "GET") return reply(200, this.pullJson(r, pr));
      if (sub === "/reviews" && method === "GET") {
        return reply(200, pr.reviews.map((x) => ({ user: { login: x.user }, state: x.state, body: x.body, submitted_at: iso(x.submitted_at) })));
      }
      if (sub === "/merge" && method === "PUT") {
        if (!canWrite) return reply(403, { message: "Resource not accessible" });
        if (pr.merged) return reply(405, { message: "Pull Request is not mergeable" });
        if (!r.allowedMerge.has(String(body.merge_method ?? "merge"))) return reply(405, { message: "Merge method not allowed" });
        if (!pr.mergeable) return reply(405, { message: "Pull Request is not mergeable" });
        if (body.sha && body.sha !== pr.sha) return reply(409, { message: "Head branch was modified" });
        pr.merged = true;
        pr.state = "closed";
        pr.merged_by = user;
        return reply(200, { merged: true, sha: `m${pr.sha}` });
      }
    }
    return reply(404, { message: `fake: ${method} ${p} not implemented` });
  }
  repoJson(r, user) {
    const perm = r.collaborators.get(user);
    return {
      full_name: `${r.owner}/${r.name}`,
      private: r.private,
      html_url: `https://github.com/${r.owner}/${r.name}`,
      default_branch: r.default_branch,
      size: r.branches.size ? 1 : 0,
      permissions: { admin: perm === "admin", push: perm === "admin" || perm === "push", triage: !!perm && perm !== "pull", pull: !!perm }
    };
  }
  issueJson(r, i) {
    return {
      id: i.id,
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      state_reason: i.state_reason,
      labels: i.labels.map((name) => ({ name })),
      assignees: i.assignees.map((login) => ({ login })),
      user: { login: i.user },
      created_at: iso(i.created_at),
      updated_at: iso(i.updated_at),
      closed_at: iso(i.closed_at),
      html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
      sub_issues_summary: { total: i.sub_issues.length, completed: i.sub_issues.filter((n) => r.issues.get(n)?.state === "closed").length }
    };
  }
  commentJson(r, c) {
    return {
      id: c.id,
      body: c.body,
      user: { login: c.user },
      created_at: iso(c.created_at),
      updated_at: iso(c.updated_at),
      html_url: `https://github.com/${r.owner}/${r.name}/issues/${c.issue}#issuecomment-${c.id}`,
      issue_url: `https://api.github.com/repos/${r.owner}/${r.name}/issues/${c.issue}`
    };
  }
  pullJson(r, x) {
    return {
      number: x.number,
      title: x.title,
      state: x.state,
      merged: x.merged,
      merged_by: x.merged_by ? { login: x.merged_by } : null,
      mergeable: x.mergeable,
      html_url: `https://github.com/${r.owner}/${r.name}/pull/${x.number}`,
      head: { ref: x.head, sha: x.sha },
      base: { ref: x.base },
      user: { login: x.user }
    };
  }
};

// packages/github/src/selftest.ts
async function selftest() {
  const steps = [];
  const prevHome = process.env.APM_HOME;
  const home = mkdtempSync(join2(tmpdir(), "apm-selftest-"));
  process.env.APM_HOME = home;
  const step = async (name, fn) => {
    try {
      steps.push({ name, ok: true, detail: await fn() || void 0 });
    } catch (err) {
      steps.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const must = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  try {
    const gh = new FakeGitHub();
    const repo = "selftest/hub";
    const users = ["pm", ...Array.from({ length: 4 }, (_, i) => `dev${i}`)];
    for (const u of users) gh.addUser(u);
    gh.addRepo(repo, { owner: "pm" });
    for (const u of users.slice(1)) gh.grant(repo, u);
    const locks = new MemoryLockStore(4);
    const hubFor = (u) => new Hub({ repo, token: `tok-${u}`, transport: gh.transport, now: gh.now, locks });
    const pm = new PmOps(hubFor("pm"));
    const worker = (u, id) => new WorkerOps(hubFor(u), { id, name: id, machine: "selftest", labels: ["code"], projects: null, owner: u }, new StateFile(repo, id));
    await step("\u5EFA hub\uFF08\u6A19\u7C64\u3001\u8A2D\u5B9A\u3001\u540D\u518A\uFF09", async () => {
      const r = await pm.init();
      must(r.private && r.config === "created", "\u521D\u59CB\u5316\u7D50\u679C\u4E0D\u5C0D");
    });
    await step("20 \u500B worker \u540C\u6642\u6436 5 \u500B\u4EFB\u52D9\uFF0C\u6BCF\u500B\u4EFB\u52D9\u53EA\u6709\u4E00\u500B\u4EBA\u62FF\u5230", async () => {
      const { tasks } = await pm.createProject({
        key: "race",
        title: "\u6436\u4EFB\u52D9",
        contributors: users.slice(1),
        tasks: Array.from({ length: 5 }, (_, i) => ({ key: `t${i}`, title: `\u4EFB\u52D9 ${i}` }))
      });
      void tasks;
      const ws = Array.from({ length: 20 }, (_, i) => worker(users[1 + i % 4], `racer-${i}`));
      const got = (await Promise.all(ws.map((w) => w.claim()))).filter(Boolean);
      const distinct = new Set(got.map((g) => g.task.number));
      must(got.length === 5 && distinct.size === 5, `${got.length} \u500B\u4EBA\u9818\u5230\u3001${distinct.size} \u500B\u4E0D\u540C\u4EFB\u52D9`);
      return `${got.length} \u500B worker \u9818\u5230\uFF0C15 \u500B\u4EC0\u9EBC\u90FD\u6C92\u62FF\u5230`;
    });
    await step("\u4E0A\u6E38\u6279\u51C6\u524D\u4E0B\u6E38\u4E0D\u53EF\u9818\uFF1B\u6279\u51C6\u5F8C\u89E3\u9396\uFF1B\u5168\u90E8\u5B8C\u6210\u5F8C\u4EA4\u4ED8", async () => {
      const { tasks } = await pm.createProject({
        key: "chain",
        title: "\u6709\u4F9D\u8CF4\u7684\u9805\u76EE",
        contributors: users.slice(1),
        tasks: [
          { key: "api", title: "API" },
          { key: "ui", title: "\u524D\u7AEF", deps: ["api"] }
        ]
      });
      const a = worker("dev0", "chain-a");
      const c = await a.claim();
      must(c?.task.number === tasks[0].number, "\u61C9\u8A72\u5148\u9818\u5230 API");
      const b = worker("dev1", "chain-b");
      must((await b.list()).candidates.every((x) => x.task.number !== tasks[1].number), "\u4E0B\u6E38\u5728\u4E0A\u6E38\u5B8C\u6210\u524D\u5C31\u80FD\u9818\u4E86");
      await a.submit({ summary: "\u5B8C\u6210" });
      const r = await pm.review(tasks[0].number, "approve");
      must(r.unlocked.includes(tasks[1].number), "\u6279\u51C6\u5F8C\u6C92\u6709\u89E3\u9396\u4E0B\u6E38");
      const c2 = await b.claim(tasks[1].number);
      must(c2, "\u4E0B\u6E38\u89E3\u9396\u5F8C\u9818\u4E0D\u5230");
      await b.submit({ summary: "\u5B8C\u6210" });
      const last = await pm.review(tasks[1].number, "approve");
      must(last.delivered, "\u5168\u90E8\u4EFB\u52D9\u5B8C\u6210\u5F8C\u9805\u76EE\u6C92\u6709\u4EA4\u4ED8");
      return "\u5168\u90E8\u5B8C\u6210\u5F8C\u9805\u76EE\u81EA\u52D5\u4EA4\u4ED8";
    });
    await step("\u4EA4\u51FA\u5F8C\u5225\u4EBA\u7E8C\u4F5C\uFF0C\u62FF\u5230\u4E0A\u4E00\u4F4D\u7684\u6AA2\u67E5\u9EDE", async () => {
      const { tasks } = await pm.createProject({ key: "relay", title: "\u63A5\u529B", contributors: users.slice(1), tasks: [{ key: "doc", title: "\u5BEB\u6587\u4EF6" }] });
      const a = worker("dev2", "relay-a");
      await a.claim(tasks[0].number);
      await a.checkpoint({ summary: "\u5BEB\u5B8C\u7B2C\u4E00\u3001\u4E8C\u7AE0", next_steps: "\u5BEB\u7B2C\u4E09\u7AE0", progress: 40 });
      await a.release("usage_limit", "\u984D\u5EA6\u7528\u5B8C");
      const b = worker("dev3", "relay-b");
      const c = await b.claim(tasks[0].number);
      must(c?.resume?.progress === 40 && c.resume.from_worker === "relay-a", "\u7E8C\u4F5C\u8CC7\u8A0A\u4E0D\u5C0D");
      return `\u5F9E ${c.resume.progress}% \u63A5\u8457\u505A\uFF1A${c.resume.next_steps}`;
    });
    await step("\u65B7\u7DDA\u8D85\u904E\u79DF\u7D04\uFF0C\u5225\u4EBA\u63A5\u624B\uFF1B\u539F worker \u56DE\u4F86\u5F97\u5230 lease_lost", async () => {
      const { tasks } = await pm.createProject({ key: "lost", title: "\u65B7\u7DDA", contributors: users.slice(1), tasks: [{ key: "x", title: "X" }] });
      const a = worker("dev0", "lost-a");
      await a.claim(tasks[0].number);
      gh.advance(11 * 6e4);
      const b = worker("dev1", "lost-b");
      const c = await b.claim(tasks[0].number);
      must(c?.resume === null || c?.attempt === 2, "\u6C92\u6709\u63A5\u624B");
      let lost = false;
      try {
        await a.heartbeat();
      } catch (err) {
        lost = err instanceof LeaseLost;
      }
      must(lost, "\u539F worker \u7E8C\u7D04\u6C92\u6709\u5F97\u5230 lease_lost");
    });
  } finally {
    if (prevHome === void 0) delete process.env.APM_HOME;
    else process.env.APM_HOME = prevHome;
    rmSync2(home, { recursive: true, force: true });
  }
  return { ok: steps.every((s) => s.ok), steps };
}

// packages/github/src/cli.ts
var VERSION = "0.2.0";
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY && !process.env.APM_NO_REEXEC && Number(process.versions.node.split(".")[0]) >= 22) {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: "1",
      APM_NO_REEXEC: "1",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --disable-warning=UNDICI-EHPA`.trim()
    }
  });
  process.exit(r.status ?? 1);
}
var BOOL = /* @__PURE__ */ new Set([
  "json",
  "text",
  "help",
  "approve",
  "reject",
  "human",
  "merge",
  "resume",
  "dry-run",
  "cancel",
  "create",
  "forget",
  "once",
  "permissions",
  "launcher",
  "link",
  "prs",
  "yes"
]);
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const put = (k, v) => {
    const prev = flags[k];
    if (prev === void 0 || typeof v === "boolean") flags[k] = v;
    else flags[k] = Array.isArray(prev) ? [...prev, v] : typeof prev === "string" ? [prev, v] : v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) {
        put(k, a.slice(eq + 1));
        continue;
      }
      if (k.startsWith("no-") && BOOL.has(k.slice(3))) {
        put(k.slice(3), false);
        continue;
      }
      if (BOOL.has(k)) {
        put(k, true);
        continue;
      }
      const next = argv[i + 1];
      if (next === void 0 || next.startsWith("--") && next.length > 2) put(k, true);
      else {
        put(k, next);
        i++;
      }
    } else if (a === "-f" && argv[i + 1] !== void 0) {
      put("file", argv[++i]);
    } else if (a === "-h") put("help", true);
    else pos.push(a);
  }
  return { pos, flags };
}
var str = (f, k) => {
  const v = f[k];
  if (v === void 0 || typeof v === "boolean") return void 0;
  return Array.isArray(v) ? v.at(-1) : v;
};
var list = (f, k) => {
  const v = f[k];
  if (v === void 0 || typeof v === "boolean") return void 0;
  return (Array.isArray(v) ? v : [v]).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
};
var num = (f, k) => {
  const v = str(f, k);
  if (v === void 0) return void 0;
  const n = Number(v.replace(/^#/, ""));
  if (Number.isNaN(n)) throw new UsageError(`--${k} \u8981\u662F\u6578\u5B57\uFF08\u6536\u5230\u300C${v}\u300D\uFF09`);
  return n;
};
var bool = (f, k) => {
  const v = f[k];
  if (v === void 0) return void 0;
  if (typeof v === "boolean") return v;
  const s = String(Array.isArray(v) ? v.at(-1) : v).toLowerCase();
  if (["true", "yes", "1", "on", "\u662F"].includes(s)) return true;
  if (["false", "no", "0", "off", "\u5426"].includes(s)) return false;
  throw new UsageError(`--${k} \u8981\u662F true \u6216 false`);
};
var taskNo = (s, what = "\u4EFB\u52D9\u7DE8\u865F") => {
  const n = Number(String(s ?? "").replace(/^#/, ""));
  if (!s || !Number.isInteger(n) || n <= 0) throw new UsageError(`\u9700\u8981${what}\uFF0C\u4F8B\u5982 apm task show 42`);
  return n;
};
var UsageError = class extends Error {
  code = "usage";
};
function makeCtx(args) {
  const cfg = loadConfig();
  const hubName = str(args.flags, "hub") || process.env.APM_HUB || cfg.hub;
  let hub = null;
  const getHub = () => {
    if (hub) return hub;
    if (!hubName) throw new UsageError("\u9084\u6C92\u8A2D\u5B9A hub\u3002\u5148\u8DD1 apm setup --hub owner/repo\uFF08\u6216\u52A0 --hub\u3001\u8A2D APM_HUB\uFF09");
    const token = resolveToken();
    if (!token) throw new UsageError("\u6C92\u6709 GitHub \u767B\u5165\uFF1A\u5148\u57F7\u884C gh auth login\uFF0C\u6216\u8A2D\u74B0\u5883\u8B8A\u91CF GH_TOKEN");
    hub = new Hub({ repo: hubName, token, apiBase: process.env.APM_API_BASE || void 0, gitRemote: process.env.APM_GIT_REMOTE || void 0 });
    return hub;
  };
  return {
    args,
    cfg,
    hubName,
    hub: getHub,
    pm: () => new PmOps(getHub()),
    worker: async () => {
      const h = getHub();
      const id = str(args.flags, "worker") || process.env.APM_WORKER_ID || cfg.worker?.id || defaultWorkerId();
      const me = {
        id,
        name: cfg.worker?.name || id,
        machine: cfg.worker?.machine || hostname2(),
        labels: cfg.worker?.labels ?? [],
        projects: cfg.worker?.projects?.length ? cfg.worker.projects : null,
        owner: await h.me()
      };
      return new WorkerOps(h, me, new StateFile(h.name, id));
    }
  };
}
var tty = () => !!process.stdout.isTTY;
var forceJson = false;
function out(data, text) {
  if (text && tty() && !forceJson) process.stdout.write(text() + "\n");
  else process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}
var fmtTime = (t) => t ? new Date(t).toLocaleString() : "\u2014";
var fmtLeft = (s) => s === null || s === void 0 ? "" : s <= 0 ? "\u5DF2\u904E\u671F" : s < 120 ? `${s} \u79D2` : `${Math.round(s / 60)} \u5206`;
var pad = (s, n) => {
  const w = [...s].reduce((a, c) => a + (c.charCodeAt(0) > 11904 ? 2 : 1), 0);
  return s + " ".repeat(Math.max(1, n - w));
};
var STATE_ZH = {
  pending: "\u7B49\u4F9D\u8CF4",
  ready: "\u53EF\u9818\u53D6",
  claimed: "\u57F7\u884C\u4E2D",
  in_review: "\u5F85 review",
  changes_requested: "\u9000\u56DE\u4FEE\u6539",
  blocked: "\u53D7\u963B",
  done: "\u5B8C\u6210"
};
function selfPath() {
  return resolve(process.argv[1]);
}
function installLauncher(link) {
  const home = apmHome();
  const binDir = join3(home, "bin");
  mkdirSync3(binDir, { recursive: true });
  const me = selfPath();
  let cmd;
  let mode = "bundle";
  if (me.endsWith(".ts")) {
    mode = "dev";
    const root = resolve(dirname3(me), "../../..");
    cmd = `"${process.execPath}" "${join3(root, "node_modules/tsx/dist/cli.mjs")}" "${me}"`;
  } else {
    const lib = join3(home, "lib");
    mkdirSync3(lib, { recursive: true });
    copyFileSync(me, join3(lib, "apm.mjs"));
    cmd = `node "${join3(lib, "apm.mjs")}"`;
  }
  const sh = join3(binDir, "apm");
  writeFileSync2(sh, `#!/bin/sh
# agent-pm \u7684 apm \u555F\u52D5\u5668\uFF08apm setup \u751F\u6210\uFF09
exec ${cmd} "$@"
`);
  chmodSync(sh, 493);
  writeFileSync2(join3(binDir, "apm.cmd"), `@echo off\r
${cmd.replace(/\//g, "\\")} %*\r
`);
  let linked = null;
  if (link) {
    const local = join3(homedir2(), ".local", "bin");
    mkdirSync3(local, { recursive: true });
    const target = join3(local, "apm");
    writeFileSync2(target, `#!/bin/sh
exec "${sh}" "$@"
`);
    chmodSync(target, 493);
    linked = target;
  }
  return { bin: sh, linked, mode };
}
var RULES = (bin) => ["Bash(apm *)", "Bash(apm:*)", `Bash(${bin} *)`];
function claudeSettingsPath() {
  return join3(process.env.CLAUDE_CONFIG_DIR || join3(homedir2(), ".claude"), "settings.json");
}
function allowInClaude(bin) {
  const path = claudeSettingsPath();
  let data = {};
  if (existsSync3(path)) {
    try {
      data = JSON.parse(readFileSync2(path, "utf8"));
    } catch {
      return { path, added: [], error: `${path} \u4E0D\u662F\u5408\u6CD5\u7684 JSON\uFF0C\u6C92\u6709\u6539\u5B83\u3002\u8ACB\u624B\u52D5\u5728 permissions.allow \u52A0\u4E0A "Bash(apm *)"` };
    }
  }
  data.permissions ??= {};
  data.permissions.allow ??= [];
  const added = RULES(bin).filter((r) => !data.permissions.allow.includes(r));
  if (added.length) {
    data.permissions.allow.push(...added);
    mkdirSync3(dirname3(path), { recursive: true });
    writeFileSync2(path, JSON.stringify(data, null, 2) + "\n");
  }
  return { path, added };
}
function permissionsOk() {
  try {
    const d = JSON.parse(readFileSync2(claudeSettingsPath(), "utf8"));
    const allow = d?.permissions?.allow ?? [];
    return allow.some((r) => r === "Bash(apm *)" || r === "Bash(apm:*)");
  } catch {
    return false;
  }
}
async function checks(ctx, deep) {
  const out2 = [];
  const add = (name, ok, detail) => out2.push({ name, ok, detail });
  const major = Number(process.versions.node.split(".")[0]);
  add("Node.js", major >= 20, `v${process.versions.node}${major < 20 ? "\uFF08\u9700\u8981 20 \u4EE5\u4E0A\uFF09" : ""}`);
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  add("git", git.status === 0, git.status === 0 ? git.stdout.trim() : "\u627E\u4E0D\u5230 git\uFF0C\u8ACB\u5148\u5B89\u88DD\uFF1Ahttps://git-scm.com/downloads");
  const token = resolveToken();
  add("GitHub \u767B\u5165", !!token, token ? process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.APM_TOKEN ? "\u7528\u74B0\u5883\u8B8A\u91CF\u88E1\u7684 token" : "\u7528 gh auth token" : "\u6C92\u6709\u767B\u5165\uFF1A\u57F7\u884C gh auth login");
  if (!token || !ctx.hubName) {
    if (!ctx.hubName) add("hub", false, "\u9084\u6C92\u8A2D\u5B9A\uFF1Aapm setup --hub owner/repo");
    return out2;
  }
  const hub = ctx.hub();
  try {
    const me = await hub.me();
    add("\u5E33\u865F", true, me);
    const info = await hub.repoInfo();
    add("hub \u5009\u5EAB", true, hub.name);
    add("hub \u662F\u79C1\u6709\u7684", info.private, info.private ? "\u662F" : "\u4E0D\u662F\uFF01\u4EFB\u52D9\u6B63\u6587\u6703\u88AB agent \u7576\u6307\u4EE4\u57F7\u884C\uFF0C\u8ACB\u6539\u6210 Private");
    add("hub \u5BEB\u5165\u6B0A\u9650", !!info.permissions?.push, info.permissions?.admin ? "admin" : info.permissions?.push ? "write" : "\u6C92\u6709\uFF1A\u8ACB\u7BA1\u7406\u54E1\u9080\u8ACB\u4F60\uFF08Write\uFF09");
    const cfg = await hub.config();
    add("hub \u8A2D\u5B9A", true, `\u79DF\u7D04 ${cfg.lease_minutes} \u5206\u9418\u3001\u7E8C\u7D04\u9593\u9694 ${cfg.heartbeat_minutes} \u5206\u9418`);
    const skew = hub.now() - Date.now();
    add("\u672C\u6A5F\u6642\u9418", Math.abs(skew) < 12e4, `\u548C GitHub \u5DEE ${Math.round(skew / 1e3)} \u79D2\uFF08\u79DF\u7D04\u4E00\u5F8B\u6309 GitHub \u7684\u6642\u9593\u7B97\uFF09`);
    if (deep) {
      const t0 = Date.now();
      const locks = await hub.locks.list();
      add("\u8B80\u53D6\u9396\uFF08git\uFF09", true, `${locks.size} \u689D\u9396\uFF0C${Date.now() - t0} ms`);
      const projects = await hub.projects("open");
      add("\u9805\u76EE", true, `${projects.length} \u500B\u9032\u884C\u4E2D`);
      const rate = hub.gh.rate;
      if (rate) add("API \u984D\u5EA6", rate.remaining > 200, `\u672C\u5C0F\u6642\u9084\u5269 ${rate.remaining}/${rate.limit}`);
    }
  } catch (err) {
    add("\u9023\u63A5 hub", false, err instanceof Error ? err.message : String(err));
  }
  add("Claude Code \u6B0A\u9650", permissionsOk(), permissionsOk() ? `${claudeSettingsPath()} \u5DF2\u5141\u8A31 apm` : "\u9084\u6C92\u5141\u8A31 apm \u547D\u4EE4\uFF1Aapm setup \u6703\u52A0\u4E0A\uFF08\u5F8C\u53F0\u7E8C\u7D04\u9700\u8981\uFF09");
  return out2;
}
var checksText = (cs) => cs.map((c) => `${c.ok ? "\u2713" : "\u2717"} ${pad(c.name, 18)}${c.detail}`).join("\n");
var HELP = `apm ${VERSION} \xB7 agent-pm \u7684\u547D\u4EE4\u884C\uFF08GitHub \u7576\u4E2D\u9593\u5C64\uFF0C\u4E0D\u9700\u8981\u670D\u52D9\u5668\uFF09

\u958B\u59CB
  apm setup --hub owner/repo [--id \u540D\u5B57] [--labels code,gpu]   \u6AA2\u67E5\u74B0\u5883\u3001\u5BEB\u672C\u6A5F\u8A2D\u5B9A\u3001\u5B89\u88DD\u555F\u52D5\u5668\u3001\u5141\u8A31 Claude Code \u8ABF\u7528 apm
  apm doctor                     \u6AA2\u67E5\u767B\u5165\u3001hub \u6B0A\u9650\u3001\u6642\u9418\u3001\u9396
  apm selftest                   \u4E0D\u9023\u7DB2\uFF0C\u7528\u5047 GitHub \u8DD1\u4E00\u904D\u5B8C\u6574\u6D41\u7A0B\uFF08\u542B 20 \u500B worker \u6436 5 \u500B\u4EFB\u52D9\uFF09
  apm init owner/repo [--create] \u5EFA hub\uFF08\u6A19\u7C64\u3001\u8A2D\u5B9A\u3001\u540D\u518A\uFF09

Worker
  apm join [--labels code] [--projects site,blog] [--repo owner/r=/\u672C\u6A5F\u8DEF\u5F91]
  apm list                       \u6211\u80FD\u9818\u7684\u4EFB\u52D9\uFF08\u6392\u597D\u5E8F\uFF09
  apm claim [--task 42]          \u9818\u53D6\uFF08\u8FD4\u56DE\u4EFB\u52D9\u3001\u7E8C\u4F5C\u8CC7\u8A0A\u3001\u5206\u652F\u548C commit \u683C\u5F0F\uFF09
  apm keepalive                  \u5728\u5F8C\u53F0\u8DD1\uFF1A\u5B9A\u6642\u7E8C\u7D04\uFF0C\u4EFB\u52D9\u7D50\u675F\u6216\u88AB\u63A5\u624B\u6642\u9000\u51FA
  apm heartbeat                  \u624B\u52D5\u7E8C\u7D04
  apm checkpoint --summary "\u2026" [--next "\u2026"] [--progress 60] [--commit abc123] [--artifact \u8DEF\u5F91]
  apm submit --summary "\u2026" [--pr \u7DB2\u5740]
  apm block --reason "\u2026"
  apm release [--reason usage_limit|interrupted|released|error] [--note "\u4EA4\u63A5\u8AAA\u660E"]
  apm current                    \u624B\u4E0A\u7684\u4EFB\u52D9
  apm leave [--note "\u2026"] [--forget]

PM
  apm status [\u9805\u76EE]
  apm project create -f plan.json [--resume]
  apm project set <\u9805\u76EE> [--priority 1-5] [--max-parallel N|none] [--repo owner/r] [--base main] [--merge-on-approve true|false]
  apm project member <\u9805\u76EE> <GitHub \u5E33\u865F> manager|contributor|viewer|none
  apm project close <\u9805\u76EE> [--cancel] [--note "\u2026"]
  apm task show <\u7DE8\u865F>
  apm task add <\u9805\u76EE> --key k --title "\u2026" [--desc "\u2026"] [--acceptance "\u2026"] [--caps code] [--deps api,#57] [--human]
  apm task edit <\u7DE8\u865F> [--title \u2026] [--desc \u2026] [--acceptance \u2026] [--caps \u2026] [--deps \u2026] [--human true|false]
  apm task cancel <\u7DE8\u865F> [--note "\u2026"]
  apm review <\u7DE8\u865F> --approve|--reject [--comment "\u2026"] [--human] [--no-merge]
  apm unblock <\u7DE8\u865F> [--note "\u2026"]
  apm revoke <\u7DE8\u865F> [--note "\u2026"]          \u6536\u56DE\u6B63\u5728\u57F7\u884C\u7684\u4EFB\u52D9
  apm reconcile [--dry-run]               \u8B93\u6A19\u7C64\u8DDF\u4E0A\u9396\uFF0C\u88DC\u4E0A\u5728 GitHub \u7DB2\u9801\u4E0A\u505A\u7684 PR review

\u7BA1\u7406\u54E1
  apm locks [prune [--dry-run]]
  apm invite <\u5E33\u865F> [--permission push]   apm uninvite <\u5E33\u865F>   apm members

\u901A\u7528\u53C3\u6578\uFF1A--hub owner/repo  --worker <id>  --json
\u9000\u51FA\u78BC\uFF1A0 \u6210\u529F \xB7 1 \u51FA\u932F \xB7 2 \u6C92\u6709\u4EFB\u52D9 \xB7 3 \u79DF\u7D04\u5DF2\u4E0D\u5C6C\u65BC\u4F60\uFF08\u7ACB\u523B\u505C\u624B\uFF09`;
var commands = {
  async help() {
    process.stdout.write(HELP + "\n");
  },
  async version() {
    out({ version: VERSION }, () => VERSION);
  },
  async selftest() {
    const r = await selftest();
    out(r, () => r.steps.map((s) => `${s.ok ? "\u2713" : "\u2717"} ${s.name}${s.detail ? `\uFF1A${s.detail}` : ""}`).join("\n") + `

${r.ok ? "\u5168\u90E8\u901A\u904E" : "\u6709\u5931\u6557"}`);
    return r.ok ? 0 : 1;
  },
  async setup(ctx) {
    const f = ctx.args.flags;
    const cfg = { ...ctx.cfg, worker: { ...ctx.cfg.worker } };
    const hub = str(f, "hub") || ctx.cfg.hub;
    if (hub) cfg.hub = hub;
    applyWorkerFlags(cfg, f);
    saveConfig(cfg);
    const ctx2 = makeCtx({ ...ctx.args, flags: { ...f, hub: cfg.hub ?? "" } });
    const result = { config: join3(apmHome(), "config.json"), hub: cfg.hub ?? null, worker: cfg.worker };
    if (f.launcher !== false) result.launcher = installLauncher(f.link === true);
    if (f.permissions !== false) {
      const bin = result.launcher?.bin ?? join3(apmHome(), "bin", "apm");
      result.permissions = allowInClaude(bin);
    }
    const cs = await checks(ctx2, true);
    result.checks = cs;
    result.ok = cs.every((c) => c.ok || c.name === "Claude Code \u6B0A\u9650");
    out(result, () => {
      const l = result.launcher;
      const p = result.permissions;
      return [
        `\u672C\u6A5F\u8A2D\u5B9A\uFF1A${result.config}`,
        l ? `\u555F\u52D5\u5668\uFF1A${l.bin}${l.linked ? `\uFF08\u4E5F\u653E\u5230\u4E86 ${l.linked}\uFF09` : ""}` : "",
        p ? p.error ? `\u6B0A\u9650\uFF1A${p.error}` : `Claude Code \u6B0A\u9650\uFF1A${p.added.length ? `\u5728 ${p.path} \u52A0\u4E0A ${p.added.join("\u3001")}` : "\u5DF2\u7D93\u6709\u4E86"}` : "",
        "",
        checksText(cs)
      ].filter((x) => x !== "").join("\n");
    });
    return result.ok ? 0 : 1;
  },
  async doctor(ctx) {
    const cs = await checks(ctx, true);
    const w = ctx.hubName ? new StateFile(ctx.hubName, str(ctx.args.flags, "worker") || process.env.APM_WORKER_ID || ctx.cfg.worker?.id || defaultWorkerId()).load() : null;
    const ok = cs.every((c) => c.ok);
    out(
      { ok, checks: cs, held: w ? { task: w.task, title: w.title, attempt: w.attempt, lost: w.lost ?? null } : null },
      () => checksText(cs) + (w ? `

\u624B\u4E0A\u7684\u4EFB\u52D9\uFF1A#${w.task}\u300C${w.title}\u300D\u7B2C ${w.attempt} \u6B21\u9818\u53D6${w.lost ? "\uFF08\u5DF2\u88AB\u63A5\u624B\uFF09" : ""}` : "")
    );
    return ok ? 0 : 1;
  },
  async init(ctx) {
    const repo = ctx.args.pos[1] || ctx.hubName;
    if (!repo) throw new UsageError("\u7528\u6CD5\uFF1Aapm init owner/repo [--create]");
    const c = makeCtx({ ...ctx.args, flags: { ...ctx.args.flags, hub: repo } });
    const r = await c.pm().init({ create: ctx.args.flags.create === true });
    if (!ctx.cfg.hub) saveConfig({ ...ctx.cfg, hub: r.hub });
    out(
      r,
      () => [
        `hub \u5DF2\u5C31\u7DD2\uFF1A${r.url}`,
        `\u79C1\u6709\uFF1A\u662F \xB7 \u8A2D\u5B9A\u6A94\uFF1A${{ created: "\u5DF2\u5EFA\u7ACB", exists: "\u5DF2\u5B58\u5728", default: "\u7528\u9810\u8A2D\u503C" }[r.config]} \xB7 \u540D\u518A\uFF1A#${r.roster}`,
        ...r.notes.map((n) => `\u6CE8\u610F\uFF1A${n}`),
        "",
        `\u4E0B\u4E00\u6B65\uFF1A\u9080\u8ACB\u6210\u54E1 apm invite <\u5E33\u865F>\uFF0C\u7136\u5F8C\u5EFA\u9805\u76EE apm project create -f plan.json`
      ].join("\n")
    );
  },
  // ───────────── Worker ─────────────
  async join(ctx) {
    const cfg = { ...ctx.cfg, worker: { ...ctx.cfg.worker } };
    applyWorkerFlags(cfg, ctx.args.flags);
    if (!cfg.worker.id) cfg.worker.id = str(ctx.args.flags, "worker") || process.env.APM_WORKER_ID || defaultWorkerId();
    saveConfig(cfg);
    const w = await makeCtx({ ...ctx.args, flags: { ...ctx.args.flags, worker: cfg.worker.id } }).worker();
    const meta = await w.join();
    out(
      { worker: meta, config: join3(apmHome(), "config.json") },
      () => `\u5DF2\u52A0\u5165 ${w.hub.name}\uFF1A${meta.id}\uFF08${meta.owner}\uFF09\uFF0C\u80FD\u529B ${meta.labels.join("\u3001") || "\uFF08\u7121\uFF09"}${meta.projects?.length ? `\uFF0C\u53EA\u505A ${meta.projects.join("\u3001")}` : ""}`
    );
  },
  async leave(ctx) {
    const w = await ctx.worker();
    let released = null;
    const held = w.state.load();
    if (held && !held.lost) {
      try {
        released = (await w.release("released", str(ctx.args.flags, "note") ?? "\u4E3B\u52D5\u96E2\u958B")).task;
      } catch (err) {
        if (!(err instanceof LeaseLost)) throw err;
      }
    }
    w.state.clear();
    if (ctx.args.flags.forget === true) {
      await w.forget();
      const cfg = { ...ctx.cfg };
      delete cfg.worker;
      saveConfig(cfg);
    } else await w.updateRoster({ status: "left", current_task: null });
    out(
      { left: w.me.id, released, forgot: ctx.args.flags.forget === true },
      () => `${w.me.id} \u5DF2\u96E2\u958B${released ? `\uFF0C\u4EA4\u51FA\u4E86 #${released}` : ""}${ctx.args.flags.forget === true ? "\uFF0C\u540D\u518A\u8A18\u9304\u548C\u672C\u6A5F\u8A2D\u5B9A\u5DF2\u522A\u9664" : ""}`
    );
  },
  async list(ctx) {
    const w = await ctx.worker();
    const r = await w.list();
    const rows = r.candidates.map((c) => ({
      number: c.task.number,
      title: c.task.title,
      project: c.project.key,
      priority: c.project.priority,
      state: c.state,
      caps: c.task.caps,
      expired: c.expired,
      mine: c.lock?.worker === w.me.id,
      url: c.task.url
    }));
    const why = [...r.why.entries()].slice(0, 30).map(([n, reason]) => ({ number: n, reason }));
    out(
      { worker: w.me.id, claimable: rows, not_claimable: why },
      () => rows.length ? rows.map((x, i) => `${i + 1}. #${x.number} ${pad(x.title, 30)} ${x.project}\uFF08\u512A\u5148\u7D1A ${x.priority}\uFF09${x.state === "changes_requested" ? " \u9000\u56DE\u4FEE\u6539" : ""}${x.expired ? " \u79DF\u7D04\u904E\u671F\u5F85\u63A5\u624B" : ""}${x.mine ? " \u2190 \u4F60\u505A\u904E" : ""}`).join("\n") : `\u6C92\u6709\u53EF\u9818\u7684\u4EFB\u52D9\u3002${why.length ? `

${why.slice(0, 10).map((x) => `#${x.number}\uFF1A${x.reason}`).join("\n")}` : ""}`
    );
  },
  async claim(ctx) {
    const w = await ctx.worker();
    const n = num(ctx.args.flags, "task") ?? (ctx.args.pos[1] ? taskNo(ctx.args.pos[1]) : void 0);
    const r = await w.claim(n);
    if (!r) {
      out({ claimed: null, message: "\u6C92\u6709\u53EF\u9818\u7684\u4EFB\u52D9" }, () => "\u6C92\u6709\u53EF\u9818\u7684\u4EFB\u52D9");
      return 2;
    }
    const local = ctx.cfg.worker?.repos?.[r.git.repo] ?? null;
    const res = { ...r, git: { ...r.git, local_path: local } };
    out(
      res,
      () => [
        `\u9818\u5230 #${r.task.number}\u300C${r.task.title}\u300D\uFF08${r.task.project}\uFF0C\u7B2C ${r.attempt} \u6B21\u9818\u53D6\uFF09`,
        r.resume ? `\u7E8C\u4F5C\uFF1A\u4E0A\u4E00\u4F4D ${r.resume.from_worker ?? "\u2014"} \u505A\u5230 ${r.resume.progress}%\uFF08${r.resume.reason ?? ""}\uFF09
  ${r.resume.summary}
  \u63A5\u4E0B\u4F86\uFF1A${r.resume.next_steps ?? "\u2014"}` : "\u5F9E\u982D\u958B\u59CB",
        `\u4EE3\u78BC\u5009\u5EAB ${r.git.repo}${local ? `\uFF08\u672C\u6A5F ${local}\uFF09` : ""}\uFF0C\u5206\u652F ${r.git.branch}`,
        `\u79DF\u7D04\u5230 ${fmtTime(r.lease_expires_at)}\u3002\u73FE\u5728\u5728\u5F8C\u53F0\u8DD1 apm keepalive`
      ].join("\n")
    );
  },
  async current(ctx) {
    const w = await ctx.worker();
    const c = await w.current();
    if (!c.held) {
      out({ held: null }, () => "\u624B\u4E0A\u6C92\u6709\u4EFB\u52D9");
      return 2;
    }
    const data = {
      held: { task: c.held.task, title: c.held.title, project: c.held.project_key, attempt: c.held.attempt, branch: c.held.branch, repo: c.held.code_repo, claimed_at: c.held.claimed_at },
      alive: c.alive,
      lost: c.held.lost ?? (c.lock && !(c.lock.worker === w.me.id && c.lock.attempt === c.held.attempt) ? { holder: c.lock.worker } : null),
      lease_expires_at: c.lock?.expires_at ?? null
    };
    out(
      data,
      () => `#${c.held.task}\u300C${c.held.title}\u300D\u7B2C ${c.held.attempt} \u6B21\u9818\u53D6 \xB7 ${data.lost ? `\u5DF2\u88AB ${data.lost.holder ?? "\u5225\u4EBA"} \u63A5\u624B\uFF0C\u8ACB\u505C\u624B` : c.alive ? `\u79DF\u7D04\u5230 ${fmtTime(data.lease_expires_at)}` : "\u79DF\u7D04\u5DF2\u904E\u671F\uFF08\u9084\u6C92\u4EBA\u63A5\u624B\uFF0C\u7E8C\u7D04\u53EF\u4EE5\u9818\u56DE\uFF09"}`
    );
    return data.lost ? 3 : 0;
  },
  async heartbeat(ctx) {
    const w = await ctx.worker();
    const r = await w.heartbeat();
    out(r, () => `#${r.task} \u5DF2\u7E8C\u7D04\uFF0C\u5230 ${fmtTime(r.lease_expires_at)}`);
  },
  async keepalive(ctx) {
    const w = await ctx.worker();
    const cfg = await w.hub.config();
    const every = (num(ctx.args.flags, "interval") ?? cfg.heartbeat_minutes * 60) * 1e3;
    const idleMs = (num(ctx.args.flags, "idle") ?? cfg.idle_minutes * 60) * 1e3;
    const parent = num(ctx.args.flags, "pid") ?? process.ppid;
    const start = w.state.load();
    if (!start) {
      out({ stopped: "no_task" });
      return 2;
    }
    const line = (o) => process.stdout.write(JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), task: start.task, ...o }) + "\n");
    const alive = (pid) => {
      if (pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return err.code === "EPERM";
      }
    };
    line({ started: true, every_s: every / 1e3, idle_stop_s: idleMs / 1e3, parent });
    for (; ; ) {
      const s = w.state.load();
      if (!s || s.task !== start.task || s.attempt !== start.attempt) {
        line({ stopped: "task_finished" });
        return 0;
      }
      if (s.lost) {
        line({ stopped: "lease_lost", holder: s.lost.holder });
        return 3;
      }
      if (!alive(parent)) {
        line({ stopped: "parent_gone" });
        return 0;
      }
      if (Date.now() - s.last_activity > idleMs) {
        line({ stopped: "agent_idle", idle_s: Math.round((Date.now() - s.last_activity) / 1e3) });
        return 0;
      }
      try {
        const r = await w.heartbeat({ background: true });
        line({ renewed: true, lease_expires_at: new Date(r.lease_expires_at).toISOString() });
      } catch (err) {
        if (err instanceof LeaseLost) {
          line({ stopped: "lease_lost", message: err.message, holder: err.detail.holder });
          return 3;
        }
        if (err instanceof NothingHeld) {
          line({ stopped: "task_finished" });
          return 0;
        }
        line({ error: err instanceof Error ? err.message : String(err) });
      }
      if (ctx.args.flags.once === true) return 0;
      await new Promise((r) => setTimeout(r, every));
    }
  },
  async checkpoint(ctx) {
    const f = ctx.args.flags;
    const w = await ctx.worker();
    const r = await w.checkpoint({
      summary: str(f, "summary") ?? "",
      next_steps: str(f, "next") ?? str(f, "next-steps"),
      progress: num(f, "progress"),
      commit: str(f, "commit"),
      artifacts: list(f, "artifact") ?? list(f, "artifacts")
    });
    out(r, () => `#${r.task} \u6AA2\u67E5\u9EDE\u5DF2\u4FDD\u5B58\uFF08${r.progress}%\uFF09\uFF0C\u79DF\u7D04\u5230 ${fmtTime(r.lease_expires_at)}`);
  },
  async submit(ctx) {
    const w = await ctx.worker();
    const r = await w.submit({ summary: str(ctx.args.flags, "summary") ?? "", pr_url: str(ctx.args.flags, "pr") });
    out(r, () => `#${r.task} \u5DF2\u4EA4\u4ED8\uFF0C\u7B49\u5F85 review${r.pr_url ? `\uFF1A${r.pr_url}` : "\uFF08\u6C92\u6709\u627E\u5230 PR\uFF09"}`);
  },
  async block(ctx) {
    const w = await ctx.worker();
    const r = await w.block(str(ctx.args.flags, "reason") ?? "");
    out(r, () => `#${r.task} \u5DF2\u6A19\u8A18\u53D7\u963B\uFF0C\u7B49 PM \u8655\u7406`);
  },
  async release(ctx) {
    const w = await ctx.worker();
    const reason = str(ctx.args.flags, "reason") ?? "released";
    if (!["usage_limit", "interrupted", "released", "error"].includes(reason)) {
      throw new UsageError("--reason \u53EA\u80FD\u662F usage_limit / interrupted / released / error");
    }
    const r = await w.release(reason, str(ctx.args.flags, "note") ?? "");
    out(r, () => `#${r.task} \u5DF2\u4EA4\u51FA`);
  },
  // ───────────── PM ─────────────
  async status(ctx) {
    const r = await ctx.pm().status(ctx.args.pos[1]);
    out(r, () => {
      const lines = [`${r.hub} \xB7 ${fmtTime(r.now)}`, ""];
      if (!r.projects.length) lines.push("\u6C92\u6709\u9032\u884C\u4E2D\u7684\u9805\u76EE");
      for (const p of r.projects) {
        const counts = Object.entries(p.counts).map(([k, v]) => `${STATE_ZH[k] ?? k} ${v}`).join("\u3001");
        lines.push(`#${p.number} ${p.key} ${p.title}${p.status !== "active" ? "\uFF08\u5DF2\u7D50\u675F\uFF09" : ""}`);
        lines.push(`   \u512A\u5148\u7D1A ${p.priority} \xB7 \u914D\u984D ${p.max_parallel ?? "\u4E0D\u9650"} \xB7 \u4EE3\u78BC ${p.repo} \xB7 ${counts}`);
        for (const t of p.tasks) {
          const who = t.assignee ? `${t.assignee} \u79DF\u7D04\u5269 ${fmtLeft(t.lease_left_s)}` : t.expired ? `${t.last_assignee} \u5931\u806F\uFF0C\u5F85\u63A5\u624B` : t.last_assignee ? `\u4E0A\u4E00\u4F4D ${t.last_assignee}` : "";
          lines.push(`   #${pad(String(t.number), 5)}${pad(t.key, 12)}${pad(STATE_ZH[t.state] ?? t.state, 10)}${pad(`${t.progress}%`, 6)}${who}${t.human_review ? " [\u4EBA\u5DE5 review]" : ""}${t.pr_url ? ` ${t.pr_url}` : ""}`);
        }
        lines.push("");
      }
      if (r.workers.length) {
        lines.push("Workers");
        for (const w of r.workers) lines.push(`   ${pad(w.id, 18)}${pad(w.owner ?? "", 14)}${w.status === "online" ? w.current_task ? `\u5728\u505A #${w.current_task}` : "\u9592\u7F6E" : "\u96E2\u7DDA"} \xB7 \u6700\u5F8C\u51FA\u73FE ${fmtTime(w.last_seen)}`);
      }
      return lines.join("\n");
    });
  },
  async project(ctx) {
    const [, sub, ref, ...rest] = ctx.args.pos;
    const f = ctx.args.flags;
    const pm = ctx.pm();
    if (sub === "create") {
      const file = str(f, "file") ?? ref;
      if (!file) throw new UsageError("\u7528\u6CD5\uFF1Aapm project create -f plan.json");
      const plan = JSON.parse(file === "-" ? readFileSync2(0, "utf8") : readFileSync2(file, "utf8"));
      const r = await pm.createProject(plan, { resume: f.resume === true });
      out(
        r,
        () => [`\u5EFA\u597D\u9805\u76EE #${r.project.number}\u300C${r.project.title}\u300D\uFF08${r.project.key}\uFF09\uFF1A${r.project.url}`, ...r.tasks.map((t) => `   #${t.number} ${t.key} ${STATE_ZH[t.state]}`), r.skipped.length ? `   \u8DF3\u904E\u5DF2\u6709\u7684 ${r.skipped.length} \u500B\u4EFB\u52D9` : ""].filter(Boolean).join("\n")
      );
      return;
    }
    if (!ref) throw new UsageError("\u7528\u6CD5\uFF1Aapm project set|member|close <\u9805\u76EE\u77ED\u540D\u6216\u7DE8\u865F> \u2026");
    if (sub === "set") {
      const mp = str(f, "max-parallel");
      const r = await pm.updateProject(ref, {
        priority: num(f, "priority"),
        max_parallel: mp === void 0 ? void 0 : mp === "none" || mp === "null" ? null : Number(mp),
        repo: str(f, "repo") === void 0 ? void 0 : str(f, "repo") === "hub" ? null : str(f, "repo"),
        base: str(f, "base"),
        merge_on_approve: bool(f, "merge-on-approve"),
        merge_method: str(f, "merge-method"),
        title: str(f, "title")
      });
      out(r, () => r.changes.length ? r.changes.join("\n") : "\u6C92\u6709\u8B8A\u5316");
      return;
    }
    if (sub === "member") {
      const [login, role] = rest;
      if (!login || !role) throw new UsageError("\u7528\u6CD5\uFF1Aapm project member <\u9805\u76EE> <GitHub \u5E33\u865F> manager|contributor|viewer|none");
      const r = await pm.setMember(ref, login, role);
      out(r, () => `${r.user} \u2192 ${r.role}${r.hint ? `
${r.hint}` : ""}`);
      return;
    }
    if (sub === "close") {
      const r = await pm.closeProject(ref, { cancel: f.cancel === true, note: str(f, "note") });
      out(r, () => `\u9805\u76EE #${r.project} ${r.state === "delivered" ? "\u5DF2\u4EA4\u4ED8" : "\u5DF2\u53D6\u6D88"}`);
      return;
    }
    throw new UsageError("\u7528\u6CD5\uFF1Aapm project create|set|member|close \u2026");
  },
  async task(ctx) {
    const [, sub, ref] = ctx.args.pos;
    const f = ctx.args.flags;
    const pm = ctx.pm();
    if (sub === "show") {
      const r = await pm.showTask(taskNo(ref));
      out(
        r,
        () => [
          `#${r.number} ${r.title}\uFF08${r.project.key}/${r.key}\uFF09${STATE_ZH[r.state] ?? r.state} ${r.progress}% \xB7 \u7B2C ${r.attempt} \u6B21\u9818\u53D6`,
          r.url,
          "",
          r.description,
          r.acceptance ? `
\u9A57\u6536\u6A19\u6E96\uFF1A
${r.acceptance}` : "",
          r.result ? `
\u4EA4\u4ED8\uFF1A${r.result.summary}${r.result.pr_url ? `
PR\uFF1A${r.result.pr_url}` : ""}` : "",
          r.blocked_reason ? `
\u53D7\u963B\uFF1A${r.blocked_reason}` : "",
          r.worklog.length ? `
\u63A5\u529B\u8A18\u9304\uFF1A
${r.worklog.map((e) => `  ${fmtTime(e.at)} ${e.worker_id} ${e.kind === "checkpoint" ? `${e.progress}% ${e.summary}` : `\u4E2D\u65B7\uFF08${e.reason}\uFF09${e.summary}`}`).join("\n")}` : ""
        ].filter(Boolean).join("\n")
      );
      return;
    }
    if (sub === "add") {
      if (!ref) throw new UsageError('\u7528\u6CD5\uFF1Aapm task add <\u9805\u76EE> --key k --title "\u2026"\uFF08\u6216 -f task.json\uFF09');
      const file = str(f, "file");
      const t = file ? JSON.parse(readFileSync2(file, "utf8")) : {
        key: str(f, "key") ?? "",
        title: str(f, "title") ?? "",
        description: str(f, "desc") ?? str(f, "description"),
        acceptance: str(f, "acceptance"),
        caps: list(f, "caps"),
        deps: list(f, "deps"),
        human_review: f.human === true,
        branch: str(f, "branch")
      };
      const r = await pm.addTask(ref, t);
      out(r, () => `\u52A0\u4E86\u4EFB\u52D9 #${r.number} ${r.key}\uFF08${STATE_ZH[r.state]}\uFF09\uFF1A${r.url}`);
      return;
    }
    if (sub === "edit") {
      const r = await pm.editTask(taskNo(ref), {
        title: str(f, "title"),
        description: str(f, "desc") ?? str(f, "description"),
        acceptance: str(f, "acceptance"),
        caps: f.caps === void 0 ? void 0 : list(f, "caps") ?? [],
        deps: f.deps === void 0 ? void 0 : list(f, "deps") ?? [],
        human_review: bool(f, "human"),
        branch: str(f, "branch")
      });
      out(r, () => r.changes.length ? r.changes.join("\n") : "\u6C92\u6709\u8B8A\u5316");
      return;
    }
    if (sub === "cancel") {
      const r = await pm.cancelTask(taskNo(ref), str(f, "note") ?? "");
      out(r, () => `#${r.task} \u5DF2\u53D6\u6D88${r.unlocked.length ? `\uFF0C\u89E3\u9396\u4E86 ${r.unlocked.map((n) => `#${n}`).join("\u3001")}` : ""}`);
      return;
    }
    throw new UsageError("\u7528\u6CD5\uFF1Aapm task show|add|edit|cancel \u2026");
  },
  async review(ctx) {
    const f = ctx.args.flags;
    const n = taskNo(ctx.args.pos[1]);
    const decision = f.approve === true ? "approve" : f.reject === true ? "reject" : str(f, "decision");
    if (decision !== "approve" && decision !== "reject") throw new UsageError('\u7528\u6CD5\uFF1Aapm review <\u7DE8\u865F> --approve \u6216 --reject --comment "\u610F\u898B"');
    const comment = str(f, "comment") ?? "";
    const r = await ctx.pm().review(n, decision, comment, { human: f.human === true, merge: f.merge === false ? false : void 0 });
    out(
      r,
      () => r.decision === "approve" ? `#${r.task} \u901A\u904E${r.merged ? "\uFF0CPR \u5DF2\u5408\u4F75" : ""}${r.unlocked.length ? `\uFF1B\u89E3\u9396 ${r.unlocked.map((x) => `#${x}`).join("\u3001")}` : ""}${r.delivered ? "\uFF1B\u9805\u76EE\u5168\u90E8\u5B8C\u6210\uFF0C\u5DF2\u4EA4\u4ED8" : ""}` : `#${r.task} \u5DF2\u9000\u56DE\u4FEE\u6539`
    );
  },
  async unblock(ctx) {
    const r = await ctx.pm().unblock(taskNo(ctx.args.pos[1]), str(ctx.args.flags, "note") ?? "");
    out(r, () => `#${r.task} \u5DF2\u89E3\u9664\u963B\u585E\uFF08${STATE_ZH[r.state]}\uFF09`);
  },
  async revoke(ctx) {
    const r = await ctx.pm().revoke(taskNo(ctx.args.pos[1]), str(ctx.args.flags, "note") ?? "");
    out(r, () => `\u5DF2\u6536\u56DE #${r.task}\uFF08\u539F\u4F86\u662F ${r.from} \u7B2C ${r.attempt} \u6B21\u9818\u53D6\uFF09`);
  },
  async reconcile(ctx) {
    const r = await ctx.pm().reconcile({ dryRun: ctx.args.flags["dry-run"] === true, prs: ctx.args.flags.prs !== false });
    out(r, () => r.changes.length ? r.changes.map((c) => `${c.task ? `#${c.task}` : `\u9805\u76EE #${c.project}`}\uFF1A${c.change}`).join("\n") + (r.dry_run ? "\n\uFF08\u53EA\u662F\u9810\u89BD\uFF0C\u6C92\u6709\u6539\uFF09" : "") : "\u6A19\u7C64\u548C\u9396\u4E00\u81F4\uFF0C\u6C92\u6709\u8981\u6539\u7684");
  },
  async locks(ctx) {
    const pm = ctx.pm();
    if (ctx.args.pos[1] === "prune") {
      const r2 = await pm.prune({ dryRun: ctx.args.flags["dry-run"] === true });
      out(r2, () => `${r2.dry_run ? "\u6703\u522A\u9664" : "\u522A\u9664\u4E86"} ${r2.removed.length} \u689D\u5DF2\u95DC\u9589\u4EFB\u52D9\u7684\u9396${r2.failed.length ? `\uFF1B${r2.failed.length} \u689D\u5931\u6557\uFF1A${r2.failed[0].error}` : ""}`);
      return;
    }
    const r = await pm.locks();
    out(
      r,
      () => r.length ? r.map((l) => `#${pad(String(l.task), 5)}${pad(l.status, 10)}${pad(l.worker, 18)}\u7B2C ${l.attempt} \u6B21 ${l.status === "held" ? l.alive ? `\u5269 ${fmtLeft(l.expires_in_s)}` : "\u5DF2\u904E\u671F" : ""}${l.task_open ? "" : "\uFF08\u4EFB\u52D9\u5DF2\u95DC\u9589\uFF09"}`).join("\n") : "\u6C92\u6709\u9396"
    );
  },
  async invite(ctx) {
    const login = ctx.args.pos[1];
    if (!login) throw new UsageError("\u7528\u6CD5\uFF1Aapm invite <GitHub \u5E33\u865F> [--permission push]");
    const r = await ctx.pm().invite(login, str(ctx.args.flags, "permission") ?? "push");
    out(r, () => r.state === "invited" ? `\u5DF2\u9080\u8ACB ${r.user}\u3002${r.hint}` : `${r.user} \u5DF2\u7D93\u662F\u5354\u4F5C\u8005\uFF0C\u6B0A\u9650\u8A2D\u70BA ${r.permission}`);
  },
  async uninvite(ctx) {
    const login = ctx.args.pos[1];
    if (!login) throw new UsageError("\u7528\u6CD5\uFF1Aapm uninvite <GitHub \u5E33\u865F>");
    const r = await ctx.pm().uninvite(login);
    out(r, () => `\u5DF2\u79FB\u9664 ${r.user}`);
  },
  async members(ctx) {
    const r = await ctx.pm().collaborators();
    out(r, () => r.map((c) => `${pad(c.login, 20)}${c.role}`).join("\n"));
  }
};
function applyWorkerFlags(cfg, f) {
  cfg.worker ??= {};
  const id = str(f, "id");
  if (id) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new UsageError("worker id \u53EA\u80FD\u7528\u5C0F\u5BEB\u5B57\u6BCD\u3001\u6578\u5B57\u548C\u9023\u5B57\u865F\uFF0C\u4F8B\u5982 home-pc");
    cfg.worker.id = id;
  }
  if (str(f, "name")) cfg.worker.name = str(f, "name");
  if (str(f, "machine")) cfg.worker.machine = str(f, "machine");
  if (f.labels !== void 0) cfg.worker.labels = list(f, "labels") ?? [];
  if (f.projects !== void 0) {
    const p = list(f, "projects") ?? [];
    cfg.worker.projects = p.length && !(p.length === 1 && p[0] === "all") ? p : null;
  }
  for (const spec of list(f, "repo") ?? []) {
    const i = spec.indexOf("=");
    if (i <= 0) throw new UsageError("--repo \u5BEB\u6210 owner/repo=/\u672C\u6A5F/\u8DEF\u5F91");
    cfg.worker.repos = { ...cfg.worker.repos, [spec.slice(0, i)]: resolve(spec.slice(i + 1)) };
  }
}
function exitCode(err) {
  if (err instanceof LeaseLost) return 3;
  if (err instanceof NothingHeld) return 2;
  return 1;
}
async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  forceJson = args.flags.json === true;
  const cmd = args.pos[0] ?? "help";
  if (args.flags.help === true || cmd === "--help") {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  const h = commands[cmd === "-v" || cmd === "--version" ? "version" : cmd];
  if (!h) {
    process.stderr.write(`\u4E0D\u8A8D\u8B58\u7684\u547D\u4EE4\u300C${cmd}\u300D\u3002apm help \u770B\u5168\u90E8\u547D\u4EE4
`);
    return 1;
  }
  const ctx = makeCtx(args);
  if (cmd !== "keepalive" && cmd !== "doctor" && cmd !== "status" && ctx.hubName) {
    try {
      new StateFile(ctx.hubName, str(args.flags, "worker") || process.env.APM_WORKER_ID || ctx.cfg.worker?.id || defaultWorkerId()).touch();
    } catch {
    }
  }
  try {
    return await h(ctx) ?? 0;
  } catch (err) {
    const e = err;
    const code = e.code ?? (err instanceof UsageError ? "usage" : "error");
    const body = { ok: false, error: code, message: e.message };
    if (err instanceof LeaseLost) {
      body.detail = err.detail;
      body.what_to_do = '\u7ACB\u523B\u505C\u624B\uFF1A\u4E0D\u8981\u518D push\uFF0C\u4E0D\u8981 submit\u3002\u6C92\u63A8\u4E0A\u53BB\u7684\u6539\u52D5\u7528 git stash push -u -m "apm lease_lost #\u4EFB\u52D9" \u6536\u8D77\u4F86\uFF0C\u7136\u5F8C apm claim \u9818\u4E0B\u4E00\u500B';
    }
    if (tty() && !forceJson) process.stderr.write(`\u932F\u8AA4\uFF1A${e.message}${body.what_to_do ? `
${body.what_to_do}` : ""}
`);
    else process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    if (process.env.APM_DEBUG) process.stderr.write(`${e.stack}
`);
    return exitCode(err);
  }
}
var isMain = (() => {
  try {
    const a = resolve(process.argv[1] ?? "");
    return /(?:^|[\\/])(cli\.ts|apm\.mjs|apm)$/.test(a);
  } catch {
    return false;
  }
})();
if (isMain) main().then((c) => process.stdout.write("", () => process.exit(c)));
export {
  VERSION,
  main,
  parseArgs
};
