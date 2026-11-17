// Teste de ponta a ponta: app real + supabase-js real + réplica local da base de dados
// O "servidor Supabase" é simulado por cima do Postgres local com o esquema real.
const { chromium, devices } = require('playwright');
const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

types.setTypeParser(1700, v => (v == null ? null : parseFloat(v))); // numeric -> número (como o PostgREST)
types.setTypeParser(20, v => parseInt(v, 10));                        // bigint
types.setTypeParser(1082, v => v);                                    // date -> 'YYYY-MM-DD'

const SCR = path.dirname(__filename);
const ROOT = path.resolve(SCR, '..', '..');
const DIST = path.join(ROOT, 'docs');
const MIGR = path.join(ROOT, 'supabase', 'migrations');
const SOCK = process.env.PGHOST || '/var/lib/postgresql/fintest';
const BASE = 'https://klmjdjhvsxvopctgmhyu.supabase.co';
const SHOTS = path.join(SCR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- base de dados limpa ----------
const P = `psql -h ${SOCK} -p 5433 -U postgres -X -q -v ON_ERROR_STOP=1`;
execSync(`${P} -c 'drop database if exists fin' -c 'create database fin'`, { stdio: 'pipe' });
execSync(`${P} -d fin -f ${path.join(ROOT, 'tests', 'sql', 'stub_supabase.sql')}`, { stdio: 'pipe' });
fs.readdirSync(MIGR).filter(f => f.endsWith('.sql')).sort().forEach(f => execSync(`${P} -d fin -f ${path.join(MIGR, f)}`, { stdio: 'pipe' }));
const pool = new Pool({ host: SOCK, port: 5433, user: 'postgres', database: 'fin' });

// ---------- servidor simulado ----------
const USERS = [
  { id: '11111111-1111-1111-1111-111111111111', email: 'goncalo@teste.pt', password: 'teste1234' },
  { id: '22222222-2222-2222-2222-222222222222', email: 'bia@teste.pt', password: 'bia12345' }
];
const [USER, BIA] = USERS;
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sessao(u) {
  const now = Math.floor(Date.now() / 1000);
  const tok = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now, session_id: 's-' + u.id }) + '.assinatura';
  return { access_token: tok, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'rt-' + u.id, user: userObj(u) };
}
const userObj = u => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: '2026-11-05T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z' });
function subDe(hdr) {
  if (!hdr) return null;
  const parts = hdr.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) return null;
  try { const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); return p.role === 'authenticated' ? p.sub : null; } catch (e) { return null; }
}
const ident = k => { if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('identificador inválido ' + k); return '"' + k + '"'; };
const ESCALARES = ['criar_casal', 'gerar_convite', 'aceitar_convite', 'definir_divisao', 'gerar_recorrentes', 'registar_apple_pay', 'registar_notificacao', 'criar_conta', 'ajustar_saldo', 'definir_principal', 'renovar_token_calendario', 'calendario_dados'];
const COMPOSTAS = ['garantir_config'];
const log = [];

async function rest(method, p, search, headers, bodyText) {
  const sub = subDe(headers['authorization']);
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(sub ? 'set local role authenticated' : 'set local role anon');
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub || '']);
    const single = /vnd\.pgrst\.object/.test(headers['accept'] || '');
    if (p.startsWith('rpc/')) {
      const fn = p.slice(4), args = bodyText ? JSON.parse(bodyText) : {}, ks = Object.keys(args);
      const a = ks.map((k, i) => ident(k) + ' => $' + (i + 1)).join(', '), vals = ks.map(k => args[k]);
      let body;
      if (ESCALARES.includes(fn)) body = (await c.query(`select public.${ident(fn)}(${a}) as v`, vals)).rows[0].v;
      else {
        const r = await c.query(`select * from public.${ident(fn)}(${a})`, vals);
        body = COMPOSTAS.includes(fn) || single ? r.rows[0] : r.rows;
      }
      await c.query('commit');
      return { status: 200, body };
    }
    const params = new URLSearchParams(search), where = [], vals = [];
    let order = '', limit = '';
    for (const [k, v] of params) {
      if (k === 'select' || k === 'columns') continue;
      if (k === 'order') { order = ' order by ' + v.split(',').map(x => { const [col, dir] = x.split('.'); return ident(col) + (dir === 'desc' ? ' desc' : ' asc'); }).join(', '); continue; }
      if (k === 'limit') { limit = ' limit ' + parseInt(v, 10); continue; }
      const m = v.match(/^(eq|neq|lt|lte|gt|gte)\.(.*)$/);
      if (!m) throw new Error('filtro não suportado ' + k + '=' + v);
      vals.push(m[2]);
      where.push(ident(k) + ' ' + { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' }[m[1]] + ' $' + vals.length);
    }
    const W = where.length ? ' where ' + where.join(' and ') : '';
    const ret = /return=representation/.test(headers['prefer'] || '');
    let rows;
    if (method === 'GET') rows = (await c.query(`select * from public.${ident(p)}${W}${order}${limit}`, vals)).rows;
    else if (method === 'POST') {
      rows = [];
      const body = JSON.parse(bodyText);
      for (const o of Array.isArray(body) ? body : [body]) {
        const ks = Object.keys(o);
        rows.push(...(await c.query(`insert into public.${ident(p)} (${ks.map(ident).join(',')}) values (${ks.map((_, i) => '$' + (i + 1)).join(',')}) returning *`, ks.map(k => o[k]))).rows);
      }
    } else if (method === 'PATCH') {
      const o = JSON.parse(bodyText), ks = Object.keys(o);
      rows = (await c.query(`update public.${ident(p)} set ${ks.map((k, i) => ident(k) + ' = $' + (vals.length + i + 1)).join(', ')}${W} returning *`, [...vals, ...ks.map(k => o[k])])).rows;
    } else if (method === 'DELETE') rows = (await c.query(`delete from public.${ident(p)}${W} returning *`, vals)).rows;
    await c.query('commit');
    if (method === 'GET') {
      if (single) return rows.length === 1 ? { status: 200, body: rows[0] } : { status: 406, body: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains ' + rows.length + ' rows', hint: null } };
      return { status: 200, body: rows };
    }
    if (method === 'POST') return { status: 201, body: ret ? rows : null };
    return { status: ret ? 200 : 204, body: ret ? rows : null };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    log.push('ERRO BD ' + method + ' ' + p + ': ' + e.message);
    return { status: e.code === '42501' ? 403 : 400, body: { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null } };
  } finally { c.release(); }
}

async function rota(route) {
  const req = route.request(), u = new URL(req.url()), hdr = req.headers();
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: body == null ? '' : JSON.stringify(body) });
  if (u.pathname.startsWith('/app/')) {
    const f = path.join(DIST, u.pathname.slice(5) || 'index.html');
    const ct = f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.png') ? 'image/png' : 'application/manifest+json';
    return fs.existsSync(f) ? route.fulfill({ status: 200, contentType: ct, body: fs.readFileSync(f) }) : route.fulfill({ status: 404, body: '' });
  }
  if (u.pathname === '/auth/v1/token') {
    const g = u.searchParams.get('grant_type'), b = JSON.parse(req.postData() || '{}');
    if (g === 'password') {
      const us = USERS.find(x => x.email === b.email && x.password === b.password);
      if (us) return json(200, sessao(us));
      return json(400, { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
    }
    if (g === 'refresh_token') { const us = USERS.find(x => 'rt-' + x.id === b.refresh_token) || USER; return json(200, sessao(us)); }
  }
  if (u.pathname === '/auth/v1/signup') {   // confirmação por email ligada: sem sessão
    const b = JSON.parse(req.postData() || '{}');
    return json(200, Object.assign(userObj({ id: '99999999-9999-9999-9999-999999999999', email: b.email }), { email_confirmed_at: null, confirmation_sent_at: '2026-11-17T10:00:00Z' }));
  }
  if (u.pathname === '/auth/v1/user') { const sub = subDe(hdr['authorization']); return json(200, userObj(USERS.find(x => x.id === sub) || USER)); }
  if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, body: '' });
  if (u.pathname.startsWith('/rest/v1/')) {
    const r = await rest(req.method(), u.pathname.slice(9), u.search, hdr, req.postData());
    log.push(req.method() + ' ' + u.pathname.slice(9) + u.search.slice(0, 60) + ' -> ' + r.status);
    return route.fulfill({ status: r.status, contentType: 'application/json', body: r.body === null || r.body === undefined ? '' : JSON.stringify(r.body) });
  }
  log.push('SEM ROTA ' + req.method() + ' ' + u.href);
  return route.fulfill({ status: 404, body: '' });
}


// ---------- teste ----------
const falhas = [];
const check = (cond, msg) => { console.log((cond ? '  OK  ' : '  FALHA ') + msg); if (!cond) falhas.push(msg); };
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const a11y = [], alvosPeq = [], erros = [];
const bd = async (sql, a) => (await pool.query(sql, a || [])).rows;
const bdComo = async (uid, sql) => { const c = await pool.connect(); try { await c.query('begin'); await c.query('set local role authenticated'); await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]); const r = (await c.query(sql)).rows; await c.query('commit'); return r; } finally { c.release(); } };
const EURN = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const eur = v => EURN.format(v).replace(/[\s  ]/g, '');
const hoje = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
const diaHoje = new Date().getDate();

// Ferramentas por iPhone (cada pessoa tem o seu)
function ferramentas(page, quem) {
  page.on('pageerror', e => erros.push(quem + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push(quem + ' console: ' + m.text()); });
  const T = {
    page,
    shot: n => page.screenshot({ path: path.join(SHOTS, n + '.png') }),
    texto: () => page.evaluate(() => document.body.innerText),
    semEsp: async () => (await page.evaluate(() => document.body.innerText)).replace(/[\s  ]/g, ''),
    tem: async t => { await page.waitForFunction(x => document.body.innerText.toLowerCase().includes(x.toLowerCase()), t, { timeout: 5000 }).catch(() => {}); return (await T.texto()).toLowerCase().includes(t.toLowerCase()); },
    toastTem: async t => { await page.waitForFunction(x => document.getElementById('toast').textContent.includes(x), t, { timeout: 5000 }); },
    fechado: () => page.waitForSelector('dialog.sheet', { state: 'detached', timeout: 5000 }),
    guardar: async () => { await page.click('.sheet .snav .link.b'); await T.fechado(); },
    tab: async n => { await page.click(`.tab:has-text("${n}")`); await page.waitForTimeout(300); },
    pin: async d => { for (const c of d) await page.click('.pin-tecla:text-is("' + c + '")'); await page.waitForTimeout(250); },
    apagarNaFolha: async () => { await page.click('.sheet .btn.danger'); await page.waitForSelector('dialog.alert[open]'); await page.click('dialog.alert .danger'); await T.fechado(); },
    auditar: async nome => {
      const v = await page.evaluate(async src => {
        if (!window.axe) { const sc = document.createElement('script'); sc.textContent = src; document.head.append(sc); }
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
        return r.violations.map(x => ({ id: x.id, impact: x.impact, n: x.nodes.length, alvo: x.nodes.slice(0, 2).map(n => n.target.join(' ')).join(' | ') }));
      }, AXE);
      v.forEach(x => a11y.push(quem + ' ' + nome + ': ' + x.id + ' [' + x.impact + '] x' + x.n + ' -> ' + x.alvo));
      const peq = await page.evaluate(() => {
        const px = v => parseFloat(v) || 0, out = [];
        const aberto = document.querySelector('dialog[open]');
        for (const el of document.querySelectorAll('button, a[href], select, input:not(.sr-only)')) {
          if (el.closest('[hidden]') || (aberto && !aberto.contains(el)) || (el.closest('dialog') && !el.closest('dialog').open)) continue;
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
          let w = r.width, h = r.height;
          if (el.classList.contains('visto')) { w = r.width; h = r.height; }   // a borda transparente já conta (44×44)
          for (const ps of ['::before', '::after']) {
            const q = getComputedStyle(el, ps);
            if (q.content === 'none' || q.position !== 'absolute') continue;
            const t = Math.min(0, px(q.top)), b = Math.min(0, px(q.bottom)), l = Math.min(0, px(q.left)), rr = Math.min(0, px(q.right));
            w = Math.max(w, r.width - l - rr); h = Math.max(h, r.height - t - b);
          }
          if (el.matches('input, select') && el.closest('.grow')) h = Math.max(h, el.closest('.grow').getBoundingClientRect().height);
          if (w < 43.5 || h < 43.5) out.push((el.getAttribute('aria-label') || el.textContent.trim().slice(0, 18) || el.className) + ' ' + Math.round(w) + '×' + Math.round(h));
        }
        return [...new Set(out)];
      });
      peq.forEach(x => alvosPeq.push(quem + ' ' + nome + ': ' + x));
    }
  };
  return T;
}

(async () => {
  const browser = await chromium.launch();
  const dev = devices['iPhone 15 Pro'] || devices['iPhone 14 Pro'];
  const umd = fs.readFileSync(path.join(SCR, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
  const novoIphone = async () => {
    const ctx = await browser.newContext({ ...dev, colorScheme: 'light', locale: 'pt-PT', timezoneId: 'Europe/Lisbon' });
    await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: umd }));
    await ctx.route(BASE + '/**', rota);
    return ctx.newPage();
  };
  const G = ferramentas(await novoIphone(), 'Gonçalo');
  const page = G.page;

  // ===== Entrada =====
  console.log('Entrada');
  await page.goto(BASE + '/app/index.html');
  await page.waitForSelector('form.login');
  await G.shot('01-login');
  check((await page.evaluate(() => getComputedStyle(document.querySelector('.logo')).backgroundColor)) === 'rgb(234, 88, 12)', 'logo laranja no ecrã de entrada');
  await page.fill('input[type=email]', USER.email);
  await page.fill('input[type=password]', 'errada');
  await page.click('button[type=submit]');
  await page.waitForSelector('#login-erro:not([hidden])');
  check((await page.textContent('#login-erro')).includes('Email ou palavra-passe errados'), 'palavra-passe errada: erro junto ao formulário');
  await G.auditar('login com erro');
  await page.click('button:has-text("Criar conta")');
  await page.waitForSelector('h1:has-text("Criar conta")');
  await page.fill('input[type=email]', 'nova@teste.pt');
  await page.fill('input[type=password]', 'curta');
  await page.click('button[type=submit]');
  check(await G.tem('pelo menos 8 caracteres'), 'criar conta: palavra-passe curta recusada');
  await page.fill('input[type=password]', 'umaboa123');
  await page.click('button[type=submit]');
  await page.waitForSelector('h1:has-text("GPP Dashboard")');
  check(await G.tem('Abre o email de confirmação'), 'criar conta: pede para confirmar o email e volta a «Entrar»');
  await G.auditar('criar conta');
  erros.length = 0;
  await page.fill('input[type=email]', USER.email);
  await page.fill('input[type=password]', USER.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('h1:has-text("Cria um PIN")');
  await G.pin('1111');
  check(await G.tem('PIN demasiado óbvio'), 'PIN óbvio recusado');
  await G.pin('1379'); await page.waitForSelector('h1:has-text("Confirma o PIN")'); await G.pin('1379');
  await page.waitForSelector('h1:has-text("Por pagar")');
  check((await page.$$('.tab')).length === 5 && !(await G.texto()).includes('Ganhos') && !(await G.texto()).includes('Disponível'), 'cinco separadores e nada de saldos nem ganhos');
  check(await G.tem('Adicionar despesa fixa'), 'por pagar vazio sugere criar as despesas fixas');
  await G.shot('02-por-pagar-vazio');
  await G.auditar('por pagar vazio');

  // ===== Números à portuguesa =====
  console.log('Números');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  const leu = async t => { await page.fill('.sheet [aria-label="Valor"]', t); await page.click('.sheet [aria-label="Descrição"]'); return page.inputValue('.sheet [aria-label="Valor"]'); };
  const errados = [];
  for (const [t, e] of [['12.500', '12500,00'], ['1.250', '1250,00'], ['1.234,56', '1234,56'], ['12,5', '12,50'], ['12.5', '12,50']]) { const r = await leu(t); if (r !== e) errados.push(t + ' → ' + r); }
  check(errados.length === 0, 'números à portuguesa (12.500 = doze mil e quinhentos)' + (errados.length ? ': ' + errados.join('; ') : ''));
  await page.keyboard.press('Escape'); await G.fechado();

  // ===== Fixas =====
  console.log('Fixas');
  await page.click('[aria-label="Despesas fixas"]'); await page.waitForSelector('h1:has-text("Fixas")');
  const diaFuturo = Math.min(diaHoje + 3, 28);
  async function novaFixa(v, n, dia, cat, extra) {
    await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
    await page.fill('.sheet [aria-label="Valor mensal"]', v);
    await page.fill('.sheet [aria-label="Nome"]', n);
    await page.fill('.sheet [aria-label="Dia do pagamento"]', String(dia));
    await page.click(`.sheet .chip:has-text("${cat}")`);
    if (extra) await extra();
    await G.guardar();
  }
  await novaFixa('600', 'Renda', 1, 'Casa');
  await G.toastTem('Por pagar');
  await novaFixa('40', 'Água', diaFuturo, 'Casa', async () => { await page.check('.sheet [aria-label="Valor variável"]'); });
  await novaFixa('26,98', 'Be Fit', diaFuturo, 'Saúde', async () => { await page.check('.sheet [aria-label="Débito direto"]'); });
  check((await G.semEsp()).includes('≈666,98€'), 'fixas: total ≈ 666,98 € por mês');
  await G.shot('03-fixas');
  await G.auditar('fixas');
  await page.click('button:has-text("Fechar")');
  await page.waitForSelector('h1:has-text("Por pagar")');
  await page.waitForTimeout(300);
  const t1 = (await G.texto()).toLowerCase();
  const renda1 = diaHoje > 1;
  check(t1.includes(renda1 ? 'em atraso' : 'próximos 7 dias') && (await G.semEsp()).includes('666,98€'), 'por pagar: 666,98 € com a renda ' + (renda1 ? 'em atraso' : 'a vencer'));
  check((await bd("select count(*)::int n from despesas where not pago"))[0].n === 3, 'as 3 fixas entraram por pagar');
  await G.shot('04-por-pagar');
  await G.auditar('por pagar');

  // ===== Visto =====
  console.log('Visto');
  await page.click('[aria-label="Marcar como paga: Renda"]');
  await G.toastTem('Paga');
  const renda = (await bd("select pago, pago_em::text from despesas where descricao = 'Renda'"))[0];
  check(renda.pago && renda.pago_em === hoje, 'visto: renda paga hoje');
  check((await G.texto()).toLowerCase().includes('já pagos') && await page.$('[aria-label="Paga: Renda"][aria-checked="true"]') !== null, 'renda passa para «Já pagos» com o visto marcado');
  await page.click('[aria-label="Paga: Renda"]');
  await G.toastTem('Voltou');
  check(!(await bd("select pago from despesas where descricao = 'Renda'"))[0].pago, 'tocar outra vez tira o visto');
  await page.click('[aria-label="Marcar como paga: Renda"]'); await G.toastTem('Paga');
  await page.click('[aria-label="Marcar como paga: Água"]');
  await page.waitForSelector('dialog.sheet[open]');
  check(await G.tem('Confirmar e pagar'), 'fatura estimada: o visto pede primeiro o valor real');
  await page.fill('.sheet [aria-label="Valor"]', '43,17');
  await G.guardar();
  await G.toastTem('Valor confirmado');
  const agua = (await bd("select d.valor, d.pago, d.estimado, r.valor est from despesas d join despesas_recorrentes r on r.id = d.recorrente_id where d.descricao = 'Água'"))[0];
  check(agua.valor === 43.17 && agua.pago && !agua.estimado && agua.est === 43.17, 'água: 43,17 €, paga, e a estimativa passa a 43,17 €');
  await G.shot('05-visto');

  // ===== Despesas =====
  console.log('Despesas');
  await G.tab('Despesas');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  check(await page.isChecked('.sheet [aria-label="Já está paga"]'), 'despesa nova de hoje já vem paga');
  check(await page.$('.sheet [aria-label="Em comum com Bia"]') === null, 'sem conta em comum não aparece a opção «em comum»');
  await page.fill('.sheet [aria-label="Valor"]', '12,50');
  await page.fill('.sheet [aria-label="Descrição"]', 'Almoço');
  await page.click('.sheet .chip:has-text("Restauração")');
  await G.guardar();
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Valor"]', '89');
  await page.fill('.sheet [aria-label="Descrição"]', 'Seguro moto');
  const futuro = new Date(); futuro.setDate(futuro.getDate() + 5);
  const fISO = futuro.getFullYear() + '-' + String(futuro.getMonth() + 1).padStart(2, '0') + '-' + String(futuro.getDate()).padStart(2, '0');
  await page.fill('.sheet [aria-label="Data"]', fISO);
  await page.dispatchEvent('.sheet [aria-label="Data"]', 'change');
  check(!(await page.isChecked('.sheet [aria-label="Já está paga"]')), 'data futura: fica «por pagar» sozinho');
  await G.guardar();
  check(!(await bd("select pago from despesas where descricao = 'Seguro moto'"))[0].pago, 'seguro gravado por pagar');
  await page.click('.chip:has-text("Por pagar")');
  check((await G.texto()).includes('Seguro moto') && !(await G.texto()).includes('Almoço'), 'filtro «Por pagar»');
  await page.click('.chip:has-text("Todas")');
  await G.shot('06-despesas');
  await G.auditar('despesas');

  // ===== Despesa que se repete todos os meses =====
  console.log('Repete todos os meses');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Valor"]', '515');
  await page.click('.sheet .chip:has-text("Fixa · todos os meses")');
  check(await page.isVisible('.sheet .chip:has-text("Única")') && (await page.getAttribute('.sheet .chip:has-text("Única")', 'aria-pressed')) === 'false', 'nova despesa: escolha «Única» / «Fixa · todos os meses» logo no topo');
  check(await page.isVisible('.sheet [aria-label="Débito direto"]') && await page.$('.sheet [aria-label="Nome"]') !== null, '«Fixa» mostra o débito direto e pede um nome');
  await page.click('.sheet .snav .link.b');
  check(await G.tem('Dá um nome à despesa fixa'), 'sem nome: erro junto ao Guardar');
  await page.fill('.sheet [aria-label="Nome"]', 'Crédito habitação');
  await page.check('.sheet [aria-label="Débito direto"]');
  await page.click('.sheet .chip:has-text("Casa")');
  await G.shot('06b-repete');
  await G.auditar('repete todos os meses');
  await G.guardar();
  await G.toastTem('Despesa fixa criada');
  const ch = (await bd("select r.dia_vencimento, r.debito_direto, d.pago from despesas_recorrentes r join despesas d on d.recorrente_id = r.id where r.nome = 'Crédito habitação'"));
  check(ch.length === 1 && ch[0].dia_vencimento === diaHoje && ch[0].debito_direto && ch[0].pago, 'crédito habitação: fixa no dia ' + diaHoje + ', débito direto, e o lançamento de hoje já pago');
  await page.click('.lrow:has-text("Seguro moto")'); await page.waitForSelector('dialog.sheet[open]');
  await page.click('.sheet .chip:has-text("Fixa · todos os meses")');
  check(await G.tem('a partir do próximo mês'), 'editar uma despesa única: pode passar a fixa');
  await G.guardar();
  await G.toastTem('Passa a repetir');
  const sm = (await bd("select r.inicio::text, d.recorrente_id is not null ligada from despesas_recorrentes r join despesas d on d.recorrente_id = r.id where r.nome = 'Seguro moto'"));
  check(sm.length === 1 && sm[0].ligada && sm[0].inicio > hoje.slice(0, 8) + '01' && (await bd("select count(*)::int n from despesas where descricao = 'Seguro moto'"))[0].n === 1, 'Seguro moto: fixa a partir do mês seguinte, sem duplicar este mês');
  await page.click('.lrow:has-text("Crédito habitação")'); await page.waitForSelector('dialog.sheet[open]');
  check(await page.$('.sheet .chip:has-text("Única")') === null && await G.tem('Gerir fixa'), 'uma despesa que vem de uma fixa mostra «Gerir fixa» em vez da escolha');
  await page.keyboard.press('Escape'); await G.fechado();
  await G.tab('Por pagar');
  check((await G.texto()).includes('Despesas fixas') && (await G.texto()).includes('5 ativas'), '«Por pagar» mostra a entrada «Despesas fixas» (5 ativas)');
  await page.click('.lrow:has(.rtitle:text-is("Despesas fixas"))'); await page.waitForSelector('h1:has-text("Fixas")');
  check((await G.texto()).includes('Crédito habitação'), 'a entrada abre a lista das fixas');
  await page.click('button:has-text("Fechar")'); await page.waitForSelector('h1:has-text("Por pagar")');

  // ===== Categorias próprias =====
  console.log('Categorias');
  await page.click('[aria-label="Ajustes"]'); await page.waitForSelector('h1:has-text("Ajustes")');
  check((await G.texto()).includes('Subscrições'), 'Ajustes mostra as categorias de sempre');
  await page.click('.lrow:has(.rtitle:text-is("Casa"))'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Nome da categoria"]', 'Casa Aveiro');
  await G.guardar();
  await G.toastTem('Categoria guardada');
  check((await bd("select count(*)::int n from despesas where categoria = 'Casa'"))[0].n === 0 && (await bd("select count(*)::int n from despesas where categoria = 'Casa Aveiro'"))[0].n > 0, 'mudar «Casa» para «Casa Aveiro» acompanha as despesas');
  await page.click('button:has-text("Nova categoria")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Nome da categoria"]', 'casa aveiro');
  await page.click('.sheet .snav .link.b');
  check(await G.tem('Já existe uma categoria com esse nome'), 'categoria repetida: erro claro');
  await page.fill('.sheet [aria-label="Nome da categoria"]', 'Casa Esmoriz');
  await G.guardar();
  await G.shot('06c-categorias');
  await G.auditar('categorias');
  await page.click('button:has-text("Nova conta")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Nome da conta"]', 'CGD');
  await G.guardar();
  await G.toastTem('Conta criada');
  check((await G.texto()).includes('CGD') && !(await G.texto()).includes('Saldo'), 'conta bancária criada só com o nome, sem saldo');
  await page.click('button:has-text("Fechar")'); await page.waitForSelector('h1:has-text("Por pagar")');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  check(await page.$('.sheet .chip:text-is("Casa Esmoriz")') !== null && await page.$('.sheet .chip:text-is("Casa")') === null, 'nova despesa já mostra «Casa Esmoriz»');
  await page.click('.sheet .chip:has-text("Fixa · todos os meses")');
  check(await page.isVisible('.sheet [aria-label="Valor variável"]'), '«Repete todos os meses» também oferece «Valor variável»');
  await page.check('.sheet [aria-label="Débito direto"]');
  check(await page.isVisible('.sheet [aria-label="Sai da conta"]'), 'com débito direto aparece «Sai da conta»');
  await page.keyboard.press('Escape'); await G.fechado();
  await page.click('[aria-label="Despesas fixas"]'); await page.waitForSelector('h1:has-text("Fixas")');
  await page.click('.lrow:has(.rtitle:text-is("Be Fit"))'); await page.waitForSelector('dialog.sheet[open]');
  await page.selectOption('.sheet [aria-label="Sai da conta"]', { label: 'CGD' });
  await G.auditar('fixa com conta');
  await G.guardar();
  const bf = (await bd("select c.nome from despesas_recorrentes r join contas c on c.id = r.conta_id where r.nome = 'Be Fit'"))[0];
  check(bf && bf.nome === 'CGD' && (await G.texto()).includes('Débito direto · CGD'), 'Be Fit: débito direto da CGD gravado e mostrado nas fixas');
  await page.click('button:has-text("Fechar")'); await page.waitForSelector('h1:has-text("Por pagar")');
  check((await G.texto()).includes('Débito direto · CGD'), '«Por pagar» mostra de que conta sai o débito');

  // ===== Inquilinos: renda + despesas cobradas − transferências =====
  console.log('Inquilinos');
  await bd("insert into despesas (owner, data, valor, descricao, categoria) values ($1, current_date - 3, 644.30, 'Obras antes do contrato', 'Casa Esmoriz')", [USER.id]);
  await G.tab('Inquilinos');
  await page.click('button:has-text("Configurar imóvel")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Nome do imóvel"]', 'T1 Esmoriz');
  await page.selectOption('.sheet [aria-label="Categoria das despesas"]', { label: 'Casa Esmoriz' });
  await G.guardar();
  await G.toastTem('Imóvel configurado');
  await page.click('button:has-text("Adicionar inquilino")'); await page.waitForSelector('dialog.sheet[open]');
  check(await page.$('.sheet [aria-label="Saída"]') === null && (await page.inputValue('.sheet [aria-label="Data de início"]')) === hoje, 'inquilino: nome e data de início (hoje), sem data de saída');
  await page.fill('.sheet [aria-label="Nome do inquilino"]', 'Ana');
  await page.fill('.sheet [aria-label="Renda mensal"]', '650');
  await G.auditar('novo inquilino');
  await G.guardar();
  check(await G.tem('Deve 650,00') && (await page.$$('button:has-text("Novo inquilino")')).length === 0, 'Ana deve a renda deste mês (650 €); um só inquilino por imóvel');
  await page.click('button:has-text("Cobrar despesa")'); await page.waitForSelector('dialog.sheet[open]');
  check((await page.getAttribute('.sheet .chip:has-text("Já registada")', 'aria-pressed')) === 'true', 'cobrar: por defeito escolhe uma despesa já registada (já paga por ti)');
  await page.click('.sheet .chip:text-is("Nova")');
  await page.fill('.sheet [aria-label="Valor a cobrar"]', '20');
  await page.fill('.sheet [aria-label="Descrição"]', 'Água Esmoriz');
  await G.auditar('cobrar despesa');
  await G.guardar();
  await G.toastTem('Cobrada a Ana');
  check(await G.tem('Deve 670,00'), 'água cobrada: Ana deve 670 €');
  await page.click('button:has-text("Recebi uma transferência")'); await page.waitForSelector('dialog.sheet[open]');
  check((await page.inputValue('.sheet [aria-label="Valor transferido"]')) === '670,00', 'transferência já sugere o que deve (670 €)');
  await page.fill('.sheet [aria-label="Nota"]', 'renda + água');
  await G.auditar('transferência');
  await G.guardar();
  check(await G.tem('Tem tudo pago') && (await G.texto()).includes('Transferência recebida'), 'depois da transferência: tem tudo pago, com o movimento na lista');
  check((await G.semEsp()).includes('+650,00€'), 'balanço do imóvel desde o início: 670 − 20 = +650,00 € (as obras de antes não contam)');
  const rb = await bd("select tipo, valor from recebimentos");
  const ag = (await bd("select inquilino_id is not null a, cobrada_em::text c from despesas where descricao = 'Água Esmoriz'"))[0];
  check(rb.length === 1 && rb[0].tipo === 'outro' && rb[0].valor === 670 && ag.a && ag.c === hoje, 'base de dados: uma transferência de 670 € e a água cobrada hoje');
  await G.shot('06d-inquilinos');
  await G.auditar('inquilinos');
  await page.click('button:has-text("Novo imóvel")'); await page.waitForSelector('dialog.sheet[open]');
  check(await G.tem('Configurar imóvel'), '«Novo imóvel» abre a configuração de outro imóvel');
  await page.keyboard.press('Escape'); await G.fechado();

  // ===== Em comum (Gonçalo) =====
  console.log('Em comum');
  await G.tab('Em comum');
  check(await G.tem('Criar conta em comum'), 'sem conta em comum: ecrã para criar ou entrar com código');
  await G.auditar('criar conta em comum');
  await page.fill('[aria-label="O teu nome"]', 'Gonçalo');
  await page.fill('[aria-label="Nome dela"]', 'Bia');
  await page.fill('[aria-label="A tua parte em percentagem"]', '60');
  await page.click('button:has-text("Criar conta em comum")');
  await G.toastTem('Conta em comum criada');
  check(await G.tem('Estão acertados') && (await G.semEsp()).includes('60%') && (await G.semEsp()).includes('40%'), 'conta criada: acertados, divisão 60/40');
  await page.click('button:has-text("Gerar código de convite")');
  await page.waitForSelector('dialog.sheet[open] .codigo');
  const codigo = (await page.textContent('.sheet .codigo')).trim();
  check(/^[0-9A-Z]{6}$/.test(codigo) && (await bd('select count(*)::int n from casal_convites where codigo = $1', [codigo]))[0].n === 1, 'código de convite com 6 caracteres: ' + codigo);
  await G.shot('07-convite');
  await G.auditar('convite');
  await page.click('.sheet .snav .link');   // Fechar
  await G.fechado();
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  check(await page.isChecked('.sheet [aria-label="Em comum com Bia"]') && (await page.inputValue('.sheet [aria-label="A tua parte em percentagem"]')) === '60', 'despesa nova a partir de «Em comum» já vem em comum, 60%');
  await page.fill('.sheet [aria-label="Valor"]', '80');
  await page.fill('.sheet [aria-label="Descrição"]', 'Supermercado');
  await page.click('.sheet .chip:has-text("Supermercado")');
  check((await page.textContent('.sheet .split')).replace(/[\s  ]/g, '').includes('Tu48,00€·Bia32,00€'), 'mostra a divisão: tu 48 € · Bia 32 €');
  await G.shot('08-despesa-comum');
  await G.auditar('despesa em comum');
  await G.guardar();
  check(await G.tem('Bia deve-te') && (await G.semEsp()).includes('32,00€'), 'Bia deve-te 32,00 €');
  await G.tab('Por pagar');
  const parteBd = (await bdComo(USER.id, "select round(sum(valor * case when casal_id is null then 100 else pct_m1 end / 100), 2)::float8 t from despesas where mes = date_trunc('month', current_date)::date"))[0].t;
  check((await G.semEsp()).toLowerCase().includes('atuaparte' + eur(parteBd)), 'resumo do mês: a tua parte (' + eur(parteBd) + ') bate com a base de dados');
  check((await G.texto()).includes('Bia deve-te'), 'por pagar mostra o saldo com a Bia');

  // ===== A Bia entra =====
  console.log('A Bia entra');
  const B = ferramentas(await novoIphone(), 'Bia');
  await B.page.goto(BASE + '/app/index.html');
  await B.page.waitForSelector('form.login');
  await B.page.fill('input[type=email]', BIA.email);
  await B.page.fill('input[type=password]', BIA.password);
  await B.page.click('button[type=submit]');
  await B.page.waitForSelector('h1:has-text("Cria um PIN")');
  await B.pin('2580'); await B.page.waitForSelector('h1:has-text("Confirma o PIN")'); await B.pin('2580');
  await B.page.waitForSelector('h1:has-text("Por pagar")');
  check(!(await B.texto()).includes('Renda') && !(await B.texto()).includes('Supermercado'), 'antes do código a Bia não vê nada do Gonçalo');
  await B.tab('Em comum');
  await B.page.fill('[aria-label="Código de convite"]', 'ZZZZZZ');
  await B.page.click('button:has-text("Entrar com o código")');
  check(await B.tem('Código inválido'), 'código errado: explica e não entra');
  for (let i = erros.length - 1; i >= 0; i--) if (/^Bia console: Failed to load resource.*400/.test(erros[i])) erros.splice(i, 1);   // o 400 do código errado é esperado
  await B.page.fill('[aria-label="Código de convite"]', codigo.toLowerCase());
  await B.page.click('button:has-text("Entrar com o código")');
  await B.toastTem('Entraste');
  check(await B.tem('Deves a Gonçalo') && (await B.semEsp()).includes('32,00€') && (await B.texto()).includes('Supermercado'), 'Bia vê a despesa em comum e que deve 32,00 € ao Gonçalo');
  await B.tab('Despesas');
  check(!(await B.texto()).includes('Almoço') && !(await B.texto()).includes('Renda') && (await B.texto()).includes('Supermercado'), 'Bia não vê as despesas pessoais do Gonçalo');
  await B.page.click('.addbtn'); await B.page.waitForSelector('dialog.sheet[open]');
  await B.page.fill('.sheet [aria-label="Valor"]', '50');
  await B.page.fill('.sheet [aria-label="Descrição"]', 'Jantar');
  await B.page.check('.sheet [aria-label="Em comum com Gonçalo"]');
  check((await B.page.inputValue('.sheet [aria-label="A tua parte em percentagem"]')) === '40', 'para a Bia a parte por defeito é 40%');
  await B.guardar();
  await B.tab('Em comum');
  check(await B.tem('Deves a Gonçalo') && (await B.semEsp()).includes('2,00€'), 'depois do jantar (pago pela Bia) ela deve só 2,00 €');
  await B.page.click('button:has-text("Acertar contas")'); await B.page.waitForSelector('dialog.sheet[open]');
  check((await B.page.inputValue('.sheet [aria-label="Valor do acerto"]')) === '2,00' && (await B.page.getAttribute('.sheet .chip:has-text("Paguei a Gonçalo")', 'aria-pressed')) === 'true', 'acertar já vem com 2,00 € e «Paguei a Gonçalo»');
  await B.page.fill('.sheet [aria-label="Nota"]', 'MB Way');
  await B.shot('09-bia-acertar');
  await B.auditar('acertar');
  await B.guardar();
  await B.toastTem('Acerto registado');
  check(await B.tem('Estão acertados'), 'depois do acerto: acertados');
  await B.shot('10-bia-em-comum');
  await B.auditar('em comum da Bia');

  // ===== De volta ao Gonçalo =====
  console.log('Gonçalo vê o que a Bia fez');
  await page.reload();
  await page.waitForSelector('.pin-teclado');
  check(!(await G.texto()).includes('Por pagar'), 'ao reabrir pede o PIN antes de mostrar dados');
  await G.pin('0000');
  check(await G.tem('Faltam 4 tentativas'), 'PIN errado: diz quantas tentativas faltam');
  await page.keyboard.type('1379');
  await page.waitForSelector('h1:has-text("Por pagar")');
  await G.tab('Em comum');
  check(await G.tem('Estão acertados') && (await G.texto()).includes('Bia pagou-te') && (await G.texto()).includes('Jantar'), 'Gonçalo vê o jantar da Bia e o acerto dela');
  const saldos = await bdComo(USER.id, 'select nome, saldo::float8 s from casal_saldos order by ordem');
  check(saldos[0].s === 0 && saldos[1].s === 0, 'base de dados: saldos a zero');
  await G.shot('11-em-comum');
  await G.auditar('em comum');
  await page.click('button:has-text("Alterar divisão")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="A tua parte em percentagem"]', '55');
  await G.guardar();
  check((await G.semEsp()).includes('55%') && (await G.semEsp()).includes('45%'), 'divisão alterada para 55/45');
  check(await G.tem('Estão acertados'), 'mudar a divisão não mexe nas despesas já registadas');

  // fixa em comum e feed do calendário
  await page.click('.tab:has-text("Despesas")'); await page.click('[aria-label="Despesas fixas"]'); await page.waitForSelector('h1:has-text("Fixas")');
  await novaFixa('40', 'Internet', diaFuturo, 'Casa', async () => { await page.check('.sheet [aria-label="Em comum com Bia"]'); });
  check((await G.texto()).includes('Comum · tua parte 22,00'), 'fixa em comum: a tua parte 22,00 €');
  const tkCal = (await bd('select token_calendario from config where owner = $1', [USER.id]))[0].token_calendario;
  const rf = await rest('POST', 'rpc/calendario_dados', '', {}, JSON.stringify({ token: tkCal, p_agenda: 'pagamentos' }));
  const net = (rf.body.pagamentos || []).find(p => p.nome === 'Internet');
  check(rf.status === 200 && net && net.comum && net.minha_parte === 22, 'feed do iPhone: Internet em comum com a tua parte (22 €)');
  const tkCalB = (await bd('select token_calendario from config where owner = $1', [BIA.id]))[0].token_calendario;
  const rfB = await rest('POST', 'rpc/calendario_dados', '', {}, JSON.stringify({ token: tkCalB, p_agenda: 'pagamentos' }));
  const netB = (rfB.body.pagamentos || []).find(p => p.nome === 'Internet');
  check(netB && netB.minha_parte === 18 && !(rfB.body.pagamentos || []).some(p => p.nome === 'Renda'), 'feed da Bia: só as fixas em comum, com a parte dela (18 €)');
  await page.click('button:has-text("Fechar")');

  // Wallet + banco
  const token = (await bd('select token_atalho from config where owner = $1', [USER.id]))[0].token_atalho;
  const rw = await rest('POST', 'rpc/registar_apple_pay', '', {}, JSON.stringify({ token, valor: '€5.40', comerciante: 'Padaria Ramos', cartao: 'Visa' }));
  const rn = await rest('POST', 'rpc/registar_notificacao', '', {}, JSON.stringify({ token, tipo: 'compra', valor: '5,40', entidade: 'PADARIA', conta: 'x' }));
  const pad = await bd("select fonte, pago from despesas where valor = 5.4");
  check(rw.status === 200 && rn.body === 'duplicado' && pad.length === 1 && pad[0].fonte === 'ambas' && pad[0].pago, 'Wallet + banco na mesma compra: uma só, já paga');

  // ===== Agenda =====
  console.log('Agenda');
  await G.tab('Agenda');
  await page.waitForSelector('.cal');
  await page.click('.cal-dia:has(.cal-num:text-is("' + diaFuturo + '"))');
  check(await G.tem('Débito direto: Be Fit') && await G.tem('Pagar Internet'), 'agenda mostra os pagamentos do dia');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Título"]', 'Gerês');
  await page.check('.sheet [aria-label="Todo o dia"]');
  await page.fill('.sheet [aria-label="Data"]', hoje);
  await page.fill('.sheet [aria-label="Data de fim"]', (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })());
  await G.auditar('evento');
  await G.guardar();
  check(await G.tem('Dia 1 de 3'), 'evento de vários dias');
  await G.shot('12-agenda');
  await G.auditar('agenda');

  // ===== Bloqueio, mobile-native, sessão =====
  console.log('Bloqueio e sessão');
  const fora = (estado, ms) => page.evaluate(([e, m]) => {
    if (m) { window.__agora = window.__agora || Date.now; const r = window.__agora; Date.now = () => r() + m; }
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => e });
    document.dispatchEvent(new Event('visibilitychange'));
  }, [estado, ms]);
  await fora('hidden');
  check(await page.evaluate(() => document.body.classList.contains('privado')), 'fora da app o conteúdo fica escondido');
  await fora('visible', 120000);
  await page.waitForSelector('.pin-teclado', { timeout: 3000 });
  check(true, 'voltar depois de 2 minutos pede o PIN');
  await G.pin('1379');
  await page.waitForSelector('h1:has-text("Agenda")');
  await page.evaluate(() => { delete document.visibilityState; if (window.__agora) Date.now = window.__agora; });
  const nativo = await page.evaluate(() => {
    const cs = e => getComputedStyle(e);
    const vp = document.querySelector('meta[name=viewport]').content;
    return {
      overscroll: cs(document.documentElement).overscrollBehaviorY === 'none',
      touch: [...document.querySelectorAll('button')].every(b => cs(b).touchAction === 'manipulation'),
      fonte16: [...document.querySelectorAll('input, select, textarea')].every(i => parseFloat(cs(i).fontSize) >= 16),
      viewport: vp.includes('viewport-fit=cover') && vp.includes('interactive-widget=resizes-content') && !/user-scalable|maximum-scale/.test(vp)
    };
  });
  const naoNativo = Object.keys(nativo).filter(k => !nativo[k]);
  check(naoNativo.length === 0, 'mobile-native' + (naoNativo.length ? ' — falhou: ' + naoNativo.join(', ') : ''));
  await page.emulateMedia({ colorScheme: 'dark' });
  await G.tab('Por pagar');
  await G.shot('13-por-pagar-escuro');
  await G.auditar('por pagar escuro');
  await G.tab('Em comum');
  await G.auditar('em comum escuro');
  await page.emulateMedia({ colorScheme: 'light' });
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'sem scroll horizontal');
  await G.tab('Por pagar');
  await page.click('[aria-label="Ajustes"]');
  await G.auditar('ajustes');
  await page.click('button:has-text("Terminar sessão")');
  await page.waitForSelector('form.login', { timeout: 5000 });
  check(true, 'terminar sessão volta ao ecrã de entrada');

  check(alvosPeq.length === 0, 'alvos de toque ≥ 44×44 px' + (alvosPeq.length ? '\n      ' + alvosPeq.slice(0, 25).join('\n      ') : ''));
  check(a11y.length === 0, 'axe-core: sem violações de acessibilidade' + (a11y.length ? '\n      ' + a11y.join('\n      ') : ''));
  check(erros.length === 0, 'sem erros de JavaScript' + (erros.length ? ': ' + erros.join(' | ') : ''));
  const esperados = ['Código inválido'];
  const bdErros = log.filter(l => (l.startsWith('ERRO') || l.startsWith('SEM ROTA')) && !esperados.some(x => l.includes(x)));
  check(bdErros.length === 0, 'sem pedidos rejeitados' + (bdErros.length ? ': ' + bdErros.join(' | ') : ''));

  await browser.close();
  await pool.end();
  console.log(falhas.length ? '\n' + falhas.length + ' FALHAS' : '\nTUDO OK');
  process.exit(falhas.length ? 1 : 0);
})().catch(async e => { console.error(e); process.exit(2); });
const r2 = n => Math.round(n * 100) / 100;
