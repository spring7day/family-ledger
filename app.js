/* 우리집 경비 — 월별 공동 경비 정산 웹앱
 * 데이터: GitHub 비공개 저장소(settings.json, months/YYYY-MM.json) 또는 기기 로컬 저장소
 */
(() => {
'use strict';

const CFG = window.LEDGER_CONFIG || {};
const $app = document.getElementById('app');
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem(k),
};

/* ---------- 유틸 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원';
const num = (s) => Number(String(s ?? '').replace(/[^0-9]/g, '')) || 0;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));
const pad = (n) => String(n).padStart(2, '0');
const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const ymShift = (ym, k) => { const [y, m] = ym.split('-').map(Number); return ymOf(new Date(y, m - 1 + k, 1)); };
const ymLabel = (ym) => { const [y, m] = ym.split('-'); return `${y}년 ${Number(m)}월`; };

function toast(msg, ms = 1800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

function b64enc(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
const b64bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

async function sha256hex(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function decryptToken(blob, pw) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64bytes(blob.salt), iterations: blob.iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64bytes(blob.iv) }, key, b64bytes(blob.ct));
  return new TextDecoder().decode(pt);
}

/* ---------- 저장소 ---------- */
class GhStore {
  constructor(token, repo, branch) { this.token = token; this.repo = repo; this.branch = branch || 'main'; this.kind = 'github'; }
  h() { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }; }
  url(path) { return `https://api.github.com/repos/${this.repo}/contents/${path}`; }
  async get(path) {
    const r = await fetch(`${this.url(path)}?ref=${this.branch}&t=${Date.now()}`, { headers: this.h(), cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw Object.assign(new Error(`GET ${path} ${r.status}`), { status: r.status });
    const j = await r.json();
    return { data: JSON.parse(b64dec(j.content)), sha: j.sha };
  }
  async put(path, data, sha, message) {
    const body = { message: message || `update ${path}`, content: b64enc(JSON.stringify(data, null, 1) + '\n'), branch: this.branch };
    if (sha) body.sha = sha;
    const r = await fetch(this.url(path), { method: 'PUT', headers: { ...this.h(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw Object.assign(new Error(`PUT ${path} ${r.status}`), { status: r.status });
    const j = await r.json();
    return j.content.sha;
  }
  async list(dir) {
    const r = await fetch(`${this.url(dir)}?ref=${this.branch}&t=${Date.now()}`, { headers: this.h(), cache: 'no-store' });
    if (r.status === 404) return [];
    if (!r.ok) throw Object.assign(new Error(`LIST ${dir} ${r.status}`), { status: r.status });
    return (await r.json()).map((f) => f.name);
  }
}
class LocalStore {
  constructor() { this.kind = 'local'; }
  async get(path) { const d = LS.get('fl:data:' + path, null); return d == null ? null : { data: d, sha: 'local' }; }
  async put(path, data) { LS.set('fl:data:' + path, data); return 'local'; }
  async list(dir) {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith('fl:data:' + dir + '/')) out.push(k.slice(('fl:data:' + dir + '/').length));
    }
    return out;
  }
}

/* ---------- 동기화 (낙관적 반영 + 순차 저장 + 충돌 시 재적용) ---------- */
const Sync = {
  store: null,
  remote: {},   // path -> {data, sha}
  pending: {},  // path -> [ {fn, msg} ]
  running: {},
  status: 'idle', // idle | saving | error | offline
  inits: {},
  view(path) {
    const base = this.remote[path] ? clone(this.remote[path].data) : (this.inits[path] ? this.inits[path]() : null);
    if (!base) return null;
    for (const p of this.pending[path] || []) p.fn(base);
    return base;
  },
  async load(path, init) {
    if (init) this.inits[path] = init;
    const cached = LS.get('fl:cache:' + path, null);
    if (cached && !this.remote[path]) this.remote[path] = cached;
    const r = await this.store.get(path);
    if (r) { this.remote[path] = r; LS.set('fl:cache:' + path, r); }
    else if (!this.remote[path] || this.store.kind === 'github') { delete this.remote[path]; LS.del('fl:cache:' + path); }
    return this.view(path);
  },
  mutate(path, fn, msg, init) {
    if (init) this.inits[path] = init;
    (this.pending[path] ||= []).push({ fn, msg });
    this.run(path);
  },
  async run(path) {
    if (this.running[path]) return;
    this.running[path] = true; this.setStatus('saving');
    let tries = 0;
    try {
      while ((this.pending[path] || []).length) {
        const op = this.pending[path][0];
        const cur = this.remote[path];
        const base = cur ? clone(cur.data) : this.inits[path]();
        op.fn(base);
        try {
          const sha = await this.store.put(path, base, cur && cur.sha, op.msg);
          this.remote[path] = { data: base, sha };
          LS.set('fl:cache:' + path, this.remote[path]);
          this.pending[path].shift(); tries = 0;
        } catch (e) {
          if ((e.status === 409 || e.status === 422 || e.status === 400) && tries < 4) {
            tries++;
            const fresh = await this.store.get(path);
            if (fresh) this.remote[path] = fresh; else delete this.remote[path];
            continue;
          }
          throw e;
        }
      }
      this.setStatus('idle');
    } catch (e) {
      console.error(e);
      this.setStatus(navigator.onLine ? 'error' : 'offline');
      toast(e.status === 401 ? '인증이 만료됐어요. 다시 로그인해 주세요.' : '저장 실패 — 잠시 후 상단 ⟳ 를 눌러 다시 시도해 주세요', 3000);
    } finally {
      this.running[path] = false;
      App.render();
    }
  },
  retryAll() { for (const p of Object.keys(this.pending)) if (this.pending[p].length) this.run(p); },
  hasPending() { return Object.values(this.pending).some((a) => a.length); },
  setStatus(s) { this.status = s; const el = document.querySelector('.sync'); if (el) App.paintSync(el); },
};

/* ---------- 기본 데이터 ---------- */
const DEFAULT_SETTINGS = () => ({ version: 1, names: { me: '지민', wife: '와이프' }, groups: ['생활비'], accounts: [], items: [] });
const monthInit = (ym) => () => ({ ym, entries: [], done: {} });
const BANKS = ['카카오뱅크', '토스뱅크', '국민은행', '신한은행', '우리은행', '하나은행', '농협은행', '지역농축협', '기업은행', 'SC제일은행', '케이뱅크', '새마을금고', '우체국', '수협은행', '신협', 'iM뱅크(대구)', '부산은행', '경남은행', '광주은행', '전북은행', '제주은행', '한국씨티은행', '산업은행', '저축은행'];

/* ---------- 앱 ---------- */
const App = {
  tab: LS.get('fl:tab', 'list'),
  ym: LS.get('fl:ym', ymOf(new Date())),
  filter: 'all',
  months: [],
  loading: true,

  get S() { return Sync.view('settings.json') || DEFAULT_SETTINGS(); },
  get M() { return Sync.view(this.mpath()) || monthInit(this.ym)(); },
  mpath(ym) { return `months/${ym || this.ym}.json`; },
  acc(id) { return this.S.accounts.find((a) => a.id === id); },
  item(id) { return this.S.items.find((i) => i.id === id); },
  pname(p) { const n = this.S.names; return p === 'me' ? n.me : p === 'wife' ? n.wife : '공동'; },
  accLabel(a) { return a ? `${a.bank} ${a.number}` : '(삭제된 계좌)'; },

  setSettings(fn, msg) { Sync.mutate('settings.json', fn, msg || '설정 변경', DEFAULT_SETTINGS); this.render(); },
  setMonth(fn, msg) { const ym = this.ym; Sync.mutate(this.mpath(ym), fn, `${ym} ${msg || '내역 변경'}`, monthInit(ym)); this.render(); },

  async start() {
    const auth = LS.get('fl:auth', null);
    if (auth && !auth.token && CFG.tokenBlob) LS.del('fl:auth');
    if (!LS.get('fl:auth', null)) return this.renderLogin();
    Sync.store = auth.token ? new GhStore(auth.token, CFG.repo, CFG.branch) : new LocalStore();
    this.renderShell();
    await this.refresh(true);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refresh(); });
    window.addEventListener('online', () => Sync.retryAll());
  },

  async refresh(first) {
    if (Sync.hasPending()) { Sync.retryAll(); return; }
    this.loading = first; if (first) this.render();
    try {
      await Promise.all([
        Sync.load('settings.json', DEFAULT_SETTINGS),
        Sync.load(this.mpath(), monthInit(this.ym)),
        Sync.store.list('months').then((l) => { this.months = l.filter((n) => /^\d{4}-\d{2}\.json$/.test(n)).map((n) => n.slice(0, 7)).sort(); }),
      ]);
      Sync.setStatus('idle');
    } catch (e) {
      console.error(e);
      if (e.status === 401) { toast('인증이 만료됐어요. 다시 로그인해 주세요.', 3000); LS.del('fl:auth'); return setTimeout(() => location.reload(), 1500); }
      Sync.setStatus(navigator.onLine ? 'error' : 'offline');
      toast('서버에서 불러오지 못했어요 — 마지막 저장본을 보여드려요', 2600);
    }
    this.loading = false; this.render();
  },

  async goYm(ym) {
    this.ym = ym; LS.set('fl:ym', ym); this.filter = 'all';
    this.loading = !Sync.remote[this.mpath()]; this.render();
    try { await Sync.load(this.mpath(), monthInit(ym)); } catch (e) { Sync.setStatus('error'); }
    this.loading = false; this.render();
  },

  /* ----- 로그인 ----- */
  renderLogin() {
    $app.innerHTML = `
      <form class="login" id="loginForm" autocomplete="on">
        <div style="font-size:44px">💳</div>
        <h1>우리집 경비</h1>
        <p>매달 공동 경비를 정리하고 계좌별로 이체해요</p>
        <input type="text" name="username" value="family" autocomplete="username" hidden>
        <input class="input" type="password" id="pw" placeholder="비밀번호" autocomplete="current-password" required>
        <div class="err" id="loginErr"></div>
        <button class="btn block" type="submit" id="loginBtn">입장하기</button>
      </form>`;
    const f = document.getElementById('loginForm');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const pw = document.getElementById('pw').value; const err = document.getElementById('loginErr'); const btn = document.getElementById('loginBtn');
      btn.disabled = true; btn.textContent = '확인 중…'; err.textContent = '';
      try {
        let token = null;
        if (CFG.tokenBlob) {
          try { token = await decryptToken(CFG.tokenBlob, pw); } catch { throw new Error('비밀번호가 맞지 않아요'); }
          const r = await fetch(`https://api.github.com/repos/${CFG.repo}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) throw new Error(`저장소 연결 실패 (${r.status})`);
        } else if ((await sha256hex(CFG.pwSalt + pw)) !== CFG.pwHash) throw new Error('비밀번호가 맞지 않아요');
        LS.set('fl:auth', { token, at: Date.now() });
        location.reload();
      } catch (ex) {
        err.textContent = ex.message || '로그인 실패'; btn.disabled = false; btn.textContent = '입장하기';
      }
    };
  },

  /* ----- 레이아웃 ----- */
  renderShell() {
    $app.innerHTML = `<div id="top"></div><div id="main"></div><div id="fabWrap"></div>
      <nav class="tabs"><div class="in">
        <button data-tab="list"><span class="ic">🧾</span>내역</button>
        <button data-tab="transfer"><span class="ic">💸</span>이체</button>
        <button data-tab="manage"><span class="ic">⚙️</span>관리</button>
      </div></nav>`;
    $app.addEventListener('click', (e) => this.onClick(e));
    $app.addEventListener('change', (e) => this.onChange(e));
  },

  paintSync(el) {
    const m = { idle: Sync.store && Sync.store.kind === 'local' ? '기기저장' : '', saving: '저장중…', error: '저장실패', offline: '오프라인' };
    el.textContent = m[Sync.status] ?? ''; el.className = 'sync' + (Sync.status === 'error' || Sync.status === 'offline' ? ' err' : '');
  },

  render() {
    if (!document.getElementById('main')) return;
    const [y, m] = this.ym.split('-').map(Number);
    const nowY = new Date().getFullYear();
    const years = []; for (let i = Math.min(2025, y); i <= Math.max(nowY + 1, y); i++) years.push(i);
    document.getElementById('top').innerHTML = `
      <div class="top">
        <button class="icon-btn" data-act="refresh" title="새로고침">⟳</button>
        <div class="ym">
          <button class="icon-btn" data-act="prevYm">‹</button>
          <select id="selY">${years.map((v) => `<option value="${v}" ${v === y ? 'selected' : ''}>${v}년</option>`).join('')}</select>
          <select id="selM">${Array.from({ length: 12 }, (_, i) => i + 1).map((v) => `<option value="${v}" ${v === m ? 'selected' : ''}>${v}월</option>`).join('')}</select>
          <button class="icon-btn" data-act="nextYm">›</button>
        </div>
        <span class="sync"></span>
      </div>`;
    this.paintSync(document.querySelector('.sync'));
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const main = document.getElementById('main');
    document.getElementById('fabWrap').innerHTML = this.tab === 'list' && !this.loading ? `<button class="fab" data-act="addEntry" aria-label="추가">＋</button>` : '';
    if (this.loading) { main.innerHTML = `<div class="loading">불러오는 중…</div>`; return; }
    main.innerHTML = this.tab === 'list' ? this.viewList() : this.tab === 'transfer' ? this.viewTransfer() : this.viewManage();
  },

  /* ----- 집계 ----- */
  totals() {
    const M = this.M; const t = { total: 0, me: 0, wife: 0, common: 0, byAcc: {}, byGroup: {} };
    for (const e of M.entries) {
      const a = Number(e.amount) || 0; t.total += a; t[e.payer] = (t[e.payer] || 0) + a;
      (t.byAcc[e.accountId] ||= { sum: 0, list: [] }); t.byAcc[e.accountId].sum += a; t.byAcc[e.accountId].list.push(e);
      const g = (this.item(e.itemId) || {}).group || '기타'; t.byGroup[g] = (t.byGroup[g] || 0) + a;
    }
    return t;
  },

  /* ----- 내역 탭 ----- */
  viewList() {
    const S = this.S, M = this.M, t = this.totals();
    const pct = (v) => (t.total ? (v / t.total) * 100 : 0);
    const groupsOrder = [...S.groups, '기타'];
    const summary = `
      <div class="card">
        <div class="muted">${ymLabel(this.ym)} 총 경비</div>
        <div class="sum-total amt">${won(t.total)}</div>
        <div class="sum-grid">
          <div><div class="l">${esc(S.names.me)}</div><div class="v amt" style="color:var(--me)">${won(t.me)}</div></div>
          <div><div class="l">${esc(S.names.wife)}</div><div class="v amt" style="color:var(--wife)">${won(t.wife)}</div></div>
          <div><div class="l">공동</div><div class="v amt" style="color:var(--common)">${won(t.common)}</div></div>
        </div>
        <div class="bar"><i style="width:${pct(t.me)}%;background:var(--me)"></i><i style="width:${pct(t.wife)}%;background:var(--wife)"></i><i style="width:${pct(t.common)}%;background:var(--common)"></i></div>
        ${Object.keys(t.byGroup).length ? `<div style="margin-top:12px">${groupsOrder.filter((g) => t.byGroup[g]).map((g) => `<div class="grp-line"><span class="muted">${esc(g)}</span><span class="amt">${won(t.byGroup[g])}</span></div>`).join('')}</div>` : ''}
      </div>`;
    if (!M.entries.length) {
      const prev = [...this.months].filter((m) => m < this.ym).pop();
      return `<div class="wrap">${summary}
        <div class="card empty">아직 ${ymLabel(this.ym)} 내역이 없어요.<br>오른쪽 아래 ＋ 로 추가하세요.
          ${prev ? `<div style="margin-top:16px"><button class="btn gray block" data-act="copyPrev" data-ym="${prev}">${ymLabel(prev)} 내역 불러오기</button></div>` : ''}
        </div></div>`;
    }
    const chips = ['all', 'me', 'wife', 'common'].map((p) => {
      const n = p === 'all' ? M.entries.length : M.entries.filter((e) => e.payer === p).length;
      return `<button class="chip ${this.filter === p ? 'on' : ''}" data-act="filter" data-p="${p}">${p === 'all' ? '전체' : esc(this.pname(p))} ${n}</button>`;
    }).join('');
    const list = M.entries.filter((e) => this.filter === 'all' || e.payer === this.filter);
    const byG = {};
    for (const e of list) { const g = (this.item(e.itemId) || {}).group || '기타'; (byG[g] ||= []).push(e); }
    const cards = groupsOrder.filter((g) => byG[g]).map((g) => {
      const es = byG[g]; const sum = es.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      return `<div class="card"><div class="grp-h"><span>${esc(g)} · ${es.length}건</span><span class="amt">${won(sum)}</span></div>
        ${es.map((e) => this.entryRow(e)).join('')}</div>`;
    }).join('');
    return `<div class="wrap">${summary}<div class="chips">${chips}</div>${cards || '<div class="card empty">해당 내역이 없어요</div>'}
      <button class="btn gray block" data-act="copyPrevAsk">다른 달 내역 불러오기</button></div>`;
  },

  entryRow(e) {
    const it = this.item(e.itemId); const a = this.acc(e.accountId);
    return `<div class="entry" data-act="editEntry" data-id="${e.id}">
      <div class="grow">
        <div class="t ellipsis">${esc(it ? it.name : '(삭제된 항목)')}</div>
        <div class="s ellipsis">${a ? esc(a.bank) + ' ' + esc(a.number) : '(삭제된 계좌)'}${e.memo ? ' · ' + esc(e.memo) : ''}</div>
      </div>
      <span class="badge b-${e.payer}">${esc(this.pname(e.payer))}</span>
      <span class="amt">${won(e.amount)}</span>
    </div>`;
  },

  /* ----- 이체 탭 ----- */
  viewTransfer() {
    const S = this.S, M = this.M, t = this.totals();
    const ids = Object.keys(t.byAcc).filter((id) => t.byAcc[id].sum > 0);
    if (!ids.length) return `<div class="wrap"><div class="card empty">${ymLabel(this.ym)}에 이체할 내역이 없어요</div></div>`;
    const order = (id) => { const i = S.accounts.findIndex((a) => a.id === id); return i < 0 ? 999 : i; };
    ids.sort((a, b) => (!!M.done[a] - !!M.done[b]) || order(a) - order(b));
    const doneCnt = ids.filter((id) => M.done[id]).length;
    const doneSum = ids.filter((id) => M.done[id]).reduce((s, id) => s + t.byAcc[id].sum, 0);
    const head = `<div class="card">
      <div class="row"><div class="grow"><div class="muted">${ymLabel(this.ym)} 이체 합계 · ${ids.length}개 계좌</div>
        <div class="sum-total amt" style="margin:2px 0 0">${won(t.total)}</div></div></div>
      <div class="progress"><i style="width:${(doneCnt / ids.length) * 100}%"></i></div>
      <div class="row" style="margin-top:8px"><span class="muted grow">완료 ${doneCnt}/${ids.length} · 남은 금액 <b class="amt" style="color:var(--text)">${won(t.total - doneSum)}</b></span></div>
    </div>`;
    const cards = ids.map((id) => {
      const a = this.acc(id); const x = t.byAcc[id]; const done = !!M.done[id];
      const names = [...new Set(x.list.map((e) => (this.item(e.itemId) || {}).name).filter(Boolean))];
      const title = (a && a.alias) || names.join(', ');
      return `<div class="card acc ${done ? 'done' : ''}">
        <div class="row">
          <div class="grow">
            <div class="bank ellipsis">${esc(a ? a.bank : '(삭제된 계좌)')}${a && a.holder ? ` <span class="muted">· ${esc(a.holder)}</span>` : ''}</div>
            <div class="num">${esc(a ? a.number : '')}</div>
          </div>
          <button class="check ${done ? 'on' : ''}" data-act="toggleDone" data-id="${id}" aria-label="이체 완료">✓</button>
        </div>
        <div class="row" style="margin-top:8px"><div class="grow muted ellipsis">${esc(title)}</div><div class="big amt">${won(x.sum)}</div></div>
        <details><summary>▾ 내역 ${x.list.length}건 보기</summary>
          ${x.list.map((e) => `<div class="grp-line"><span>${esc((this.item(e.itemId) || {}).name || '')} <span class="badge b-${e.payer}">${esc(this.pname(e.payer))}</span>${e.memo ? ' ' + esc(e.memo) : ''}</span><span class="amt">${won(e.amount)}</span></div>`).join('')}
        </details>
        ${a ? `<button class="btn kakao block" style="margin-top:12px;height:48px" data-act="copyTx" data-id="${id}">이체정보 복사</button>
        <div class="muted" style="text-align:center;margin-top:6px;font-size:12px">${x.sum} ${esc(a.bank)} ${esc(a.number)}</div>` : ''}
      </div>`;
    }).join('');
    return `<div class="wrap">${head}
      <div class="muted" style="padding:0 4px">‘이체정보 복사’를 누르면 금액·은행명·계좌번호가 한 번에 복사돼요. 카카오뱅크를 열어 바로 이체하고, 끝나면 ✓ 를 눌러 표시해 두세요.</div>
      ${cards}</div>`;
  },

  /* ----- 관리 탭 ----- */
  viewManage() {
    const S = this.S;
    const accs = S.accounts.filter((a) => !a.archived);
    const items = S.items.filter((i) => !i.archived);
    const inUse = (id) => items.filter((i) => i.accountId === id).length;
    const accHtml = accs.map((a) => `<div class="mg-item" data-act="editAcc" data-id="${a.id}">
        <div class="grow"><div class="ellipsis"><b>${esc(a.bank)}</b> <span class="muted">${esc(a.number)}</span></div>
        <div class="muted ellipsis">${esc([a.holder && '명의 ' + a.holder, a.alias].filter(Boolean).join(' · ') || '별칭 없음')} · 항목 ${inUse(a.id)}개</div></div><span class="muted">›</span></div>`).join('');
    const itemHtml = [...S.groups, '기타'].map((g) => {
      const its = items.filter((i) => (S.groups.includes(i.group) ? i.group : '기타') === g);
      if (!its.length) return '';
      return `<div class="grp-h" style="margin-top:10px">${esc(g)}</div>` + its.map((i) => {
        const a = this.acc(i.accountId);
        return `<div class="mg-item" data-act="editItem" data-id="${i.id}"><div class="grow"><div class="ellipsis"><b>${esc(i.name)}</b>${i.dueDay ? ` <span class="muted">· ${esc(i.dueDay)}일</span>` : ''}</div>
          <div class="muted ellipsis">${a ? esc(a.bank + ' ' + a.number) : '계좌 미지정'}</div></div><span class="muted">›</span></div>`;
      }).join('');
    }).join('');
    const isGh = Sync.store.kind === 'github';
    return `<div class="wrap">
      <div class="card"><h3>계좌 <button class="btn sm" data-act="addAcc">＋ 추가</button></h3>${accHtml || '<div class="empty">계좌가 없어요</div>'}</div>
      <div class="card"><h3>비용 항목 <button class="btn sm" data-act="addItem">＋ 추가</button></h3>${itemHtml || '<div class="empty">항목이 없어요</div>'}</div>
      <div class="card"><h3>구분 <button class="btn sm" data-act="addGroup">＋ 추가</button></h3>
        <div class="chips" style="flex-wrap:wrap">${S.groups.map((g, i) => `<button class="chip" data-act="editGroup" data-i="${i}">${esc(g)}</button>`).join('')}</div></div>
      <div class="card"><h3>이름</h3>
        <div class="row"><input class="input" id="nmMe" value="${esc(S.names.me)}" placeholder="나"><input class="input" id="nmWife" value="${esc(S.names.wife)}" placeholder="와이프"></div>
        <button class="btn gray block" style="margin-top:10px" data-act="saveNames">이름 저장</button></div>
      <div class="card"><h3>데이터</h3>
        <div class="muted" style="margin-bottom:10px">${isGh ? `GitHub 비공개 저장소에 저장 중이라 두 사람 폰에서 같은 내용이 보여요.` : `⚠️ 이 기기에만 저장 중이에요. 다른 폰과 공유되지 않아요.`}<br>기록된 달: ${this.months.length ? this.months.map(ymLabel).join(', ') : '없음'}</div>
        <div class="row"><button class="btn gray grow" data-act="export">백업 파일 받기</button><button class="btn danger" data-act="logout">로그아웃</button></div></div>
    </div>`;
  },

  /* ----- 이벤트 ----- */
  onChange(e) {
    if (e.target.id === 'selY' || e.target.id === 'selM') {
      const y = document.getElementById('selY').value, m = document.getElementById('selM').value;
      this.goYm(`${y}-${pad(m)}`);
    }
  },
  async onClick(e) {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { this.tab = tabBtn.dataset.tab; LS.set('fl:tab', this.tab); window.scrollTo(0, 0); return this.render(); }
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    const t = () => this.totals();
    switch (act) {
      case 'refresh': Sync.hasPending() ? Sync.retryAll() : (await this.refresh(), toast('최신 내용으로 불러왔어요')); break;
      case 'prevYm': this.goYm(ymShift(this.ym, -1)); break;
      case 'nextYm': this.goYm(ymShift(this.ym, 1)); break;
      case 'filter': this.filter = el.dataset.p; this.render(); break;
      case 'addEntry': this.entrySheet(); break;
      case 'editEntry': this.entrySheet(this.M.entries.find((x) => x.id === id)); break;
      case 'copyPrev': this.copyFromSheet(el.dataset.ym); break;
      case 'copyPrevAsk': this.pickMonthSheet(); break;
      case 'toggleDone': this.setMonth((d) => { d.done ||= {}; if (d.done[id]) delete d.done[id]; else d.done[id] = true; }, '이체 완료 표시'); break;
      case 'copyTx': { const a = this.acc(id); const sum = t().byAcc[id].sum; const txt = `${sum} ${a.bank} ${a.number}`;
        if (await copyText(txt)) toast(`복사됨: ${txt}`, 2200); else toast('복사에 실패했어요'); break; }
      case 'addAcc': this.accSheet(); break;
      case 'editAcc': this.accSheet(this.acc(id)); break;
      case 'addItem': this.itemSheet(); break;
      case 'editItem': this.itemSheet(this.item(id)); break;
      case 'addGroup': { const g = (prompt('새 구분 이름') || '').trim(); if (g && !this.S.groups.includes(g)) this.setSettings((s) => s.groups.push(g), `구분 추가: ${g}`); break; }
      case 'editGroup': this.groupSheet(Number(el.dataset.i)); break;
      case 'saveNames': { const me = document.getElementById('nmMe').value.trim() || '나'; const wife = document.getElementById('nmWife').value.trim() || '와이프';
        this.setSettings((s) => { s.names = { me, wife }; }, '이름 변경'); toast('저장했어요'); break; }
      case 'export': this.exportAll(); break;
      case 'logout': if (confirm('로그아웃할까요? 다시 들어오려면 비밀번호가 필요해요.')) { LS.del('fl:auth'); location.reload(); } break;
    }
  },

  /* ----- 시트 공통 ----- */
  sheet(html, bind) {
    const dim = document.createElement('div'); dim.className = 'dim';
    dim.innerHTML = `<div class="sheet"><div class="grab"></div>${html}</div>`;
    const close = () => dim.remove();
    dim.addEventListener('click', (e) => { if (e.target === dim || e.target.closest('[data-close]')) close(); });
    document.body.appendChild(dim);
    bind && bind(dim.querySelector('.sheet'), close);
    return close;
  },

  accountOptions(sel) {
    const accs = this.S.accounts.filter((a) => !a.archived || a.id === sel);
    return `<option value="">계좌 선택</option>` + accs.map((a) => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.bank)} ${esc(a.number)}${a.alias ? ' · ' + esc(a.alias) : ''}</option>`).join('');
  },
  itemOptions(sel) {
    const S = this.S; const items = S.items.filter((i) => !i.archived || i.id === sel);
    const gs = [...S.groups, '기타'];
    return `<option value="">항목 선택</option>` + gs.map((g) => {
      const its = items.filter((i) => (S.groups.includes(i.group) ? i.group : '기타') === g); if (!its.length) return '';
      return `<optgroup label="${esc(g)}">${its.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</optgroup>`;
    }).join('') + `<option value="__new">＋ 새 항목 만들기…</option>`;
  },

  /* ----- 내역 입력 시트 ----- */
  entrySheet(entry, draft) {
    const isNew = !entry; const S = this.S;
    const d = draft || (entry ? clone(entry) : { payer: LS.get('fl:lastPayer', 'me'), itemId: '', accountId: '', amount: 0, memo: '' });
    this.sheet(`
      <h2>${isNew ? '경비 추가' : '경비 수정'} <span class="muted" style="font-size:13px;font-weight:500">${ymLabel(this.ym)}</span></h2>
      <label class="f">누가 썼나요</label>
      <div class="seg" id="payer">${['me', 'wife', 'common'].map((p) => `<button type="button" data-p="${p}" class="${d.payer === p ? 'on' : ''}">${esc(this.pname(p))}</button>`).join('')}</div>
      <label class="f">비용 항목</label><select class="input" id="fItem">${this.itemOptions(d.itemId)}</select>
      <label class="f">보낼 계좌</label><select class="input" id="fAcc">${this.accountOptions(d.accountId)}</select>
      <label class="f">금액</label><input class="input amount-input" id="fAmt" inputmode="numeric" placeholder="0" value="${d.amount ? Number(d.amount).toLocaleString('ko-KR') : ''}">
      <div class="quick">${[10000, 50000, 100000, 1000000].map((v) => `<button type="button" data-add="${v}">+${v >= 10000 ? v / 10000 + '만' : v}</button>`).join('')}<button type="button" data-add="0">지우기</button></div>
      <label class="f">메모 (선택)</label><input class="input" id="fMemo" value="${esc(d.memo)}" placeholder="예: 8월분, 카드 결제일 25일">
      <div class="actions">
        ${isNew ? `<button class="btn gray" id="saveMore">저장 후 계속</button>` : `<button class="btn danger" id="del">삭제</button>`}
        <button class="btn" id="save">저장</button>
      </div>`, (sh, close) => {
      const $ = (s) => sh.querySelector(s);
      const amt = $('#fAmt');
      sh.querySelectorAll('#payer button').forEach((b) => b.onclick = () => { d.payer = b.dataset.p; sh.querySelectorAll('#payer button').forEach((x) => x.classList.toggle('on', x === b)); });
      $('#fItem').onchange = () => {
        const v = $('#fItem').value;
        if (v === '__new') {
          d.amount = num(amt.value); d.memo = $('#fMemo').value; d.accountId = $('#fAcc').value; close();
          return this.itemSheet(null, (newId) => { d.itemId = newId; d.accountId = (this.item(newId) || {}).accountId || d.accountId; this.entrySheet(entry, d); }, () => this.entrySheet(entry, d));
        }
        d.itemId = v; const it = this.item(v); if (it && it.accountId) $('#fAcc').value = it.accountId;
      };
      amt.oninput = () => { const n = num(amt.value); amt.value = n ? n.toLocaleString('ko-KR') : ''; };
      sh.querySelectorAll('[data-add]').forEach((b) => b.onclick = () => { const v = Number(b.dataset.add); const n = v ? num(amt.value) + v : 0; amt.value = n ? n.toLocaleString('ko-KR') : ''; });
      const save = (more) => {
        const rec = { id: entry ? entry.id : uid('e'), payer: d.payer, itemId: $('#fItem').value, accountId: $('#fAcc').value, amount: num(amt.value), memo: $('#fMemo').value.trim() };
        if (!rec.itemId || rec.itemId === '__new') return toast('비용 항목을 골라주세요');
        if (!rec.accountId) return toast('보낼 계좌를 골라주세요');
        if (!rec.amount) return toast('금액을 입력해 주세요');
        LS.set('fl:lastPayer', rec.payer);
        const name = (this.item(rec.itemId) || {}).name;
        this.setMonth((doc) => {
          const i = doc.entries.findIndex((x) => x.id === rec.id);
          if (i >= 0) doc.entries[i] = { ...doc.entries[i], ...rec }; else doc.entries.push({ ...rec, at: Date.now() });
        }, `${isNew ? '추가' : '수정'}: ${name} ${rec.amount}`);
        if (!this.months.includes(this.ym)) this.months = [...this.months, this.ym].sort();
        close();
        if (more) { toast(`${name} ${won(rec.amount)} 저장`); this.entrySheet(null, { payer: rec.payer, itemId: '', accountId: '', amount: 0, memo: '' }); }
      };
      $('#save').onclick = () => save(false);
      if ($('#saveMore')) $('#saveMore').onclick = () => save(true);
      if ($('#del')) $('#del').onclick = () => { if (!confirm('이 내역을 삭제할까요?')) return; this.setMonth((doc) => { doc.entries = doc.entries.filter((x) => x.id !== entry.id); }, '삭제'); close(); };
      if (isNew && !draft) setTimeout(() => $('#fItem').focus(), 250);
    });
  },

  /* ----- 지난달 불러오기 ----- */
  pickMonthSheet() {
    const others = this.months.filter((m) => m !== this.ym).reverse();
    if (!others.length) return toast('불러올 다른 달 기록이 없어요');
    this.sheet(`<h2>어느 달 내역을 불러올까요?</h2><div class="muted">${ymLabel(this.ym)}에 항목이 추가돼요 (기존 내역은 그대로)</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">${others.map((m) => `<button class="btn gray block" data-ym="${m}">${ymLabel(m)}</button>`).join('')}</div>
      <div class="actions"><button class="btn gray" data-close>닫기</button></div>`, (sh, close) => {
      sh.querySelectorAll('[data-ym]').forEach((b) => b.onclick = () => { close(); this.copyFromSheet(b.dataset.ym); });
    });
  },
  copyFromSheet(src) {
    this.sheet(`<h2>${ymLabel(src)} 내역 불러오기</h2><div class="muted">항목·계좌·사용자를 그대로 가져와요. 금액도 가져올까요?</div>
      <div class="actions" style="flex-direction:column"><button class="btn block" id="withAmt">금액까지 그대로 가져오기</button>
      <button class="btn gray block" id="noAmt">항목만 가져오고 금액은 비우기</button><button class="btn gray block" data-close>취소</button></div>`, (sh, close) => {
      const go = async (withAmt) => {
        close(); toast('불러오는 중…');
        try {
          const r = await Sync.store.get(this.mpath(src));
          const es = (r ? r.data.entries : []).map((e) => ({ ...e, id: uid('e'), amount: withAmt ? e.amount : 0, at: Date.now() }));
          if (!es.length) return toast('가져올 내역이 없어요');
          this.setMonth((doc) => { doc.entries.push(...es); }, `${src}에서 ${es.length}건 불러오기`);
          if (!this.months.includes(this.ym)) this.months = [...this.months, this.ym].sort();
          toast(`${es.length}건을 불러왔어요${withAmt ? '' : ' — 금액을 채워주세요'}`, 2400);
        } catch (e) { toast('불러오기 실패'); }
      };
      sh.querySelector('#withAmt').onclick = () => go(true);
      sh.querySelector('#noAmt').onclick = () => go(false);
    });
  },

  /* ----- 계좌 시트 ----- */
  accSheet(acc) {
    const isNew = !acc; const a = acc ? clone(acc) : { bank: '카카오뱅크', number: '', holder: '', alias: '' };
    const known = BANKS.includes(a.bank);
    this.sheet(`<h2>${isNew ? '계좌 추가' : '계좌 수정'}</h2>
      <label class="f">은행</label>
      <select class="input" id="aBank">${BANKS.map((b) => `<option ${b === a.bank ? 'selected' : ''}>${b}</option>`).join('')}<option value="__etc" ${known ? '' : 'selected'}>기타 (직접 입력)</option></select>
      <input class="input" id="aBankEtc" style="margin-top:8px;${known ? 'display:none' : ''}" placeholder="은행 이름" value="${known ? '' : esc(a.bank)}">
      <label class="f">계좌번호</label><input class="input" id="aNum" inputmode="numeric" value="${esc(a.number)}" placeholder="예: 3333-01-1234567">
      <label class="f">예금주 (선택)</label><input class="input" id="aHolder" value="${esc(a.holder)}" placeholder="예: 지민 / 와이프">
      <label class="f">별칭 (선택)</label><input class="input" id="aAlias" value="${esc(a.alias)}" placeholder="예: 생활비 통장">
      <div class="actions">${isNew ? '<button class="btn gray" data-close>취소</button>' : '<button class="btn danger" id="del">삭제</button>'}<button class="btn" id="save">저장</button></div>`, (sh, close) => {
      const $ = (s) => sh.querySelector(s);
      $('#aBank').onchange = () => { $('#aBankEtc').style.display = $('#aBank').value === '__etc' ? '' : 'none'; };
      $('#save').onclick = () => {
        const bank = $('#aBank').value === '__etc' ? $('#aBankEtc').value.trim() : $('#aBank').value;
        const rec = { bank, number: $('#aNum').value.trim(), holder: $('#aHolder').value.trim(), alias: $('#aAlias').value.trim() };
        if (!rec.bank) return toast('은행 이름을 입력해 주세요');
        if (!/\d/.test(rec.number)) return toast('계좌번호를 입력해 주세요');
        const id = acc ? acc.id : uid('a');
        this.setSettings((s) => { const i = s.accounts.findIndex((x) => x.id === id); if (i >= 0) s.accounts[i] = { ...s.accounts[i], ...rec }; else s.accounts.push({ id, ...rec }); }, `계좌 ${isNew ? '추가' : '수정'}: ${rec.bank} ${rec.number}`);
        close(); toast('저장했어요');
      };
      if ($('#del')) $('#del').onclick = () => {
        const used = this.S.items.filter((i) => !i.archived && i.accountId === acc.id);
        if (used.length) return toast(`이 계좌를 쓰는 항목이 ${used.length}개 있어요 (${used.slice(0, 2).map((i) => i.name).join(', ')}…). 먼저 항목의 계좌를 바꿔주세요.`, 3500);
        if (!confirm(`${acc.bank} ${acc.number} 계좌를 삭제할까요?\n(지난 달 기록에는 그대로 남아요)`)) return;
        this.setSettings((s) => { const x = s.accounts.find((y) => y.id === acc.id); if (x) x.archived = true; }, `계좌 삭제: ${acc.bank} ${acc.number}`);
        close(); toast('삭제했어요');
      };
    });
  },

  /* ----- 항목 시트 ----- */
  itemSheet(item, onSaved, onCancel) {
    const isNew = !item; const it = item ? clone(item) : { name: '', group: this.S.groups[0] || '생활비', accountId: '', dueDay: '' };
    this.sheet(`<h2>${isNew ? '비용 항목 추가' : '비용 항목 수정'}</h2>
      <label class="f">항목 이름</label><input class="input" id="iName" value="${esc(it.name)}" placeholder="예: 현대카드 생활비카드 대금">
      <label class="f">구분</label><select class="input" id="iGroup">${this.S.groups.map((g) => `<option ${g === it.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      <label class="f">기본 이체 계좌</label><select class="input" id="iAcc">${this.accountOptions(it.accountId)}</select>
      <label class="f">납기일 (선택)</label><input class="input" id="iDue" inputmode="numeric" value="${esc(it.dueDay)}" placeholder="예: 25">
      <div class="actions">${isNew ? '<button class="btn gray" id="cancel">취소</button>' : '<button class="btn danger" id="del">삭제</button>'}<button class="btn" id="save">저장</button></div>`, (sh, close) => {
      const $ = (s) => sh.querySelector(s);
      if ($('#cancel')) $('#cancel').onclick = () => { close(); onCancel && onCancel(); };
      $('#save').onclick = () => {
        const rec = { name: $('#iName').value.trim(), group: $('#iGroup').value, accountId: $('#iAcc').value, dueDay: String(num($('#iDue').value) || '') };
        if (!rec.name) return toast('항목 이름을 입력해 주세요');
        const id = item ? item.id : uid('i');
        this.setSettings((s) => { const i = s.items.findIndex((x) => x.id === id); if (i >= 0) s.items[i] = { ...s.items[i], ...rec }; else s.items.push({ id, ...rec }); }, `항목 ${isNew ? '추가' : '수정'}: ${rec.name}`);
        close(); toast('저장했어요'); onSaved && onSaved(id);
      };
      if ($('#del')) $('#del').onclick = () => {
        if (!confirm(`'${item.name}' 항목을 삭제할까요?\n(지난 달 기록에는 그대로 남아요)`)) return;
        this.setSettings((s) => { const x = s.items.find((y) => y.id === item.id); if (x) x.archived = true; }, `항목 삭제: ${item.name}`);
        close(); toast('삭제했어요');
      };
    });
  },

  /* ----- 구분 시트 ----- */
  groupSheet(i) {
    const g = this.S.groups[i];
    this.sheet(`<h2>구분 수정</h2><label class="f">이름</label><input class="input" id="gName" value="${esc(g)}">
      <div class="actions"><button class="btn danger" id="del">삭제</button><button class="btn" id="save">저장</button></div>`, (sh, close) => {
      sh.querySelector('#save').onclick = () => {
        const n = sh.querySelector('#gName').value.trim(); if (!n) return;
        if (n !== g && this.S.groups.includes(n)) return toast('같은 이름이 있어요');
        this.setSettings((s) => { const k = s.groups.indexOf(g); if (k >= 0) s.groups[k] = n; s.items.forEach((x) => { if (x.group === g) x.group = n; }); }, `구분 이름 변경: ${g}→${n}`);
        close();
      };
      sh.querySelector('#del').onclick = () => {
        const used = this.S.items.filter((x) => !x.archived && x.group === g).length;
        if (used) return toast(`'${g}'를 쓰는 항목이 ${used}개 있어요. 먼저 옮겨주세요.`, 3000);
        this.setSettings((s) => { s.groups = s.groups.filter((x) => x !== g); }, `구분 삭제: ${g}`); close();
      };
    });
  },

  async exportAll() {
    toast('백업 파일 만드는 중…');
    try {
      const out = { exportedAt: new Date().toISOString(), settings: this.S, months: {} };
      for (const m of this.months) { const r = await Sync.store.get(this.mpath(m)); if (r) out.months[m] = r.data; }
      const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `우리집경비_백업_${ymOf(new Date())}.json`; a.click();
    } catch (e) { toast('백업 실패'); }
  },
};
window.App = App;
App.start();
})();
