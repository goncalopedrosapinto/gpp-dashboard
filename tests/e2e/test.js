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
const SQL = path.join(ROOT, 'supabase', 'migrations', '20261105_financas_v1_1.sql');
const SOCK = process.env.PGHOST || '/var/lib/postgresql/fintest';
const BASE = 'https://klmjdjhvsxvopctgmhyu.supabase.co';
const SHOTS = path.join(SCR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- base de dados limpa ----------
const P = `psql -h ${SOCK} -p 5433 -U postgres -X -q -v ON_ERROR_STOP=1`;
execSync(`${P} -c 'drop database if exists fin' -c 'create database fin'`, { stdio: 'pipe' });
execSync(`${P} -d fin -f ${path.join(ROOT, 'tests', 'sql', 'stub_supabase.sql')}`, { stdio: 'pipe' });
execSync(`${P} -d fin -f ${SQL}`, { stdio: 'pipe' });
const pool = new Pool({ host: SOCK, port: 5433, user: 'postgres', database: 'fin' });

// ---------- servidor simulado ----------
const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'goncalo@teste.pt', password: 'teste1234' };
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sessao() {
  const now = Math.floor(Date.now() / 1000);
  const tok = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: USER.id, email: USER.email, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now, session_id: 's1' }) + '.assinatura';
  return { access_token: tok, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'rt1', user: userObj() };
}
const userObj = () => ({ id: USER.id, aud: 'authenticated', role: 'authenticated', email: USER.email, email_confirmed_at: '2026-11-05T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-11-05T00:00:00Z', updated_at: '2026-11-05T00:00:00Z' });
function subDe(hdr) {
  if (!hdr) return null;
  const parts = hdr.replace(/^Bearer\s+/i, '').split('.');
  if (parts.length !== 3) return null;
  try { const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); return p.role === 'authenticated' ? p.sub : null; } catch (e) { return null; }
}
const ident = k => { if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('identificador inválido ' + k); return '"' + k + '"'; };
const ESCALARES = ['gerar_recorrentes', 'registar_apple_pay', 'definir_rendimento'];
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
    const g = u.searchParams.get('grant_type');
    if (g === 'password') {
      const b = JSON.parse(req.postData() || '{}');
      if (b.email === USER.email && b.password === USER.password) return json(200, sessao());
      return json(400, { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' });
    }
    if (g === 'refresh_token') return json(200, sessao());
  }
  if (u.pathname === '/auth/v1/user') return json(200, userObj());
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

(async () => {
  const browser = await chromium.launch();
  const dev = devices['iPhone 15 Pro'] || devices['iPhone 14 Pro'];
  const ctx = await browser.newContext({ ...dev, colorScheme: 'light', locale: 'pt-PT', timezoneId: 'Europe/Lisbon' });
  const umd = fs.readFileSync(path.join(SCR, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: umd }));
  await ctx.route(BASE + '/**', rota);
  const page = await ctx.newPage();
  const erros = [];
  page.on('pageerror', e => erros.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') erros.push('console: ' + m.text()); });
  const shot = n => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const toastTem = async t => { await page.waitForFunction(x => document.getElementById('toast').textContent.includes(x), t, { timeout: 5000 }); };
  const texto = () => page.evaluate(() => document.body.innerText);
  const fechado = () => page.waitForSelector('.backdrop', { state: 'detached', timeout: 5000 });
  const tab = async n => { await page.click(`.tab:has-text("${n}")`); await page.waitForTimeout(250); };

  await page.goto(BASE + '/app/index.html');
  await page.waitForSelector('form.login');
  await shot('01-login');

  console.log('Entrada');
  await page.fill('input[type=email]', USER.email);
  await page.fill('input[type=password]', 'errada');
  await page.click('button[type=submit]');
  await toastTem('Email ou palavra-passe errados');
  check(true, 'palavra-passe errada mostra erro em português');
  erros.length = 0; // o 400 do login errado gera um erro de consola esperado
  await page.fill('input[type=password]', USER.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('h1:has-text("Resumo")');
  await page.waitForTimeout(400);
  check((await texto()).includes('Novembro 2026'), 'entra no Resumo de novembro 2026');
  await shot('02-resumo-vazio');

  console.log('Rendimentos');
  await page.fill('[aria-label="O meu rendimento"]', '1500');
  await page.press('[aria-label="O meu rendimento"]', 'Enter');
  await toastTem('Rendimento guardado');
  await page.fill('[aria-label="Rendimento dela"]', '1.000,00');
  await page.press('[aria-label="Rendimento dela"]', 'Enter');
  await page.waitForFunction(() => document.body.innerText.includes('Pagas 60%'));
  check((await texto()).includes('Pagas 60% das despesas partilhadas; Ela paga 40%'), 'proporção 60/40 a partir de 1500 / 1.000,00');

  console.log('Despesas fixas');
  await tab('Fixas');
  async function novaFixa(valor, nome, dia, cat, partilhada, pagoEla) {
    await page.click('.addbtn');
    await page.waitForSelector('.sheet');
    await page.fill('.sheet [aria-label="Valor mensal"]', valor);
    await page.fill('.sheet [aria-label="Nome"]', nome);
    await page.fill('.sheet [aria-label="Dia do pagamento"]', dia);
    await page.click(`.sheet .chip:has-text("${cat}")`);
    if (partilhada) await page.check('.sheet [aria-label="Partilhada"]');
    if (pagoEla) await page.click('.sheet .seg button:has-text("Ela")');
    await page.click('.sheet .snav .link.b');
    await fechado();
  }
  await novaFixa('511', 'Crédito habitação', '5', 'Casa', true, false);
  await toastTem('Fixa criada');
  await novaFixa('40', 'Água', '31', 'Casa', true, true);
  await novaFixa('35', 'Ginásio', '28', 'Saúde', false, false);
  await page.waitForTimeout(300);
  const tf = await texto();
  check(tf.includes('586,00'), 'total das fixas = 586,00 €');
  check(tf.includes('Partilhada, paga por Ela'), 'água marcada como paga por ela');
  await shot('03-fixas');

  console.log('Despesas');
  await tab('Despesas');
  let td = await texto();
  check(td.includes('3 despesas'), 'as 3 fixas entraram sozinhas em novembro');
  check(td.toLowerCase().includes('segunda-feira, 30 de novembro'), 'água (dia 31) passou para 30 de novembro');
  await page.click('.addbtn');
  await page.waitForSelector('.sheet');
  await page.fill('.sheet [aria-label="Valor"]', '30');
  await page.fill('.sheet [aria-label="Descrição"]', 'Jantar');
  await page.click('.sheet .chip:has-text("Restauração")');
  await page.check('.sheet [aria-label="Partilhada"]');
  await page.waitForTimeout(150);
  check((await page.textContent('.sheet .split')).includes('Tu 18,00') , 'pré-visualização da divisão: Tu 18,00 € · Ela 12,00 €');
  await shot('04-nova-despesa');
  await page.click('.sheet .snav .link.b');
  await fechado();

  console.log('Apple Pay (Atalho)');
  const token = (await pool.query('select token_atalho from config')).rows[0].token_atalho;
  const ap = (b) => rest('POST', 'rpc/registar_apple_pay', '', { apikey: 'sb_publishable_x' }, JSON.stringify(Object.assign({ token }, b)));
  const r1 = await ap({ valor: '12,50 €', comerciante: 'Continente', cartao: 'Visa CGD' });
  const r2 = await ap({ valor: '3,20', comerciante: 'Padaria Aveiro' });
  const rx = await rest('POST', 'rpc/registar_apple_pay', '', {}, JSON.stringify({ token: 'falso', valor: '1' }));
  check(r1.status === 200 && r2.status === 200, 'Atalho anónimo regista gastos com o token');
  check(rx.status === 400 && /token/.test(rx.body.message), 'token falso é recusado');
  const anonLe = await rest('GET', 'despesas', '?select=*', {}, null);
  check(anonLe.status === 403, 'sem sessão não se lê nenhuma despesa');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.body.innerText.includes('Por rever (2)'));
  await page.click('.chip:has-text("Por rever")');
  await page.waitForTimeout(200);
  await shot('05-por-rever');
  await page.click('.lrow:has-text("Continente")');
  await page.waitForSelector('.sheet');
  check((await page.textContent('.sheet')).includes('ficam memorizadas'), 'folha avisa que o comerciante fica memorizado');
  await page.click('.sheet .chip:has-text("Supermercado")');
  await page.check('.sheet [aria-label="Partilhada"]');
  await shot('06-rever-continente');
  await page.click('.sheet .snav .link.b');
  await fechado();
  await ap({ valor: '20,00', comerciante: 'CONTINENTE' });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(500);
  await page.click('.chip:has-text("Todas")');
  await page.waitForTimeout(200);
  const novo = await page.textContent('.lrow:has-text("CONTINENTE")');
  check(novo.includes('Supermercado') && novo.includes('Partilhada'), 'segunda compra no Continente já entra como Supermercado + partilhada');
  check((await texto()).includes('Por rever (1)'), 'só a padaria fica por rever');
  await shot('07-despesas');

  console.log('Resumo');
  await tab('Resumo');
  await page.waitForTimeout(300);
  let tr = await texto();
  // partilhadas: 511 + 40 + 30 + 12,50 + 20 = 613,50; 60% = 368,10; pagaste 573,50 -> ela deve 205,40
  check(tr.includes('Ela deve-te') && tr.includes('205,40'), 'acerto: Ela deve-te 205,40 €');
  check(tr.includes('613,50') && tr.includes('368,10') && tr.includes('245,40') && tr.includes('573,50'), 'detalhe do acerto bate certo');
  // pessoais: ginásio 35 + padaria 3,20 = 38,20; custo real 406,30; sobra 1093,70
  check(tr.includes('38,20') && tr.includes('406,30') && tr.includes('1093,70'), 'custo real 406,30 € e sobra 1093,70 €');
  await shot('08-resumo');
  await page.evaluate(() => window.scrollTo(0, 2000));
  await page.waitForTimeout(200);
  await shot('09-resumo-fundo');
  await page.evaluate(() => window.scrollTo(0, 0));

  console.log('Calcular');
  await tab('Calcular');
  await page.fill('[aria-label="Valor a dividir"]', '30');
  await page.waitForTimeout(100);
  const eu = await page.textContent('[data-r=eu]'), ela = await page.textContent('[data-r=ela]');
  check(eu.includes('18,00') && ela.includes('12,00'), 'calculadora: 30 € -> 18,00 € / 12,00 €');
  await page.fill('[aria-label="O meu rendimento"]', '1200');
  await page.waitForTimeout(100);
  const eu2 = await page.textContent('[data-r=eu]');
  check(eu2.includes('16,36'), 'simulação 1200/1000: 30 € -> 16,36 € para ti');
  await shot('10-calcular');

  console.log('Ajustes');
  await tab('Ajustes');
  const ta = await texto();
  check(ta.includes(token.slice(0, 8)), 'mostra o token do Atalho (abreviado)');
  await shot('11-ajustes');
  await page.fill('[aria-label="Nome da namorada"]', 'Inês');
  await page.press('[aria-label="Nome da namorada"]', 'Enter');
  await toastTem('Guardado');
  await tab('Resumo');
  await page.waitForTimeout(200);
  check((await texto()).includes('Inês deve-te'), 'nome dela aparece no acerto');

  console.log('Editar fixa e apagar despesa');
  await tab('Fixas');
  await page.click('.lrow:has-text("Ginásio")');
  await page.waitForSelector('.sheet');
  await page.fill('.sheet [aria-label="Valor mensal"]', '40');
  await page.click('.sheet .snav .link.b');
  await fechado();
  const gin = (await pool.query("select valor from despesas where descricao = 'Ginásio'")).rows;
  check(gin.length === 1 && gin[0].valor === 40, 'mudar a fixa atualiza o lançamento deste mês (ginásio 40 €)');
  await tab('Despesas');
  await page.click('.lrow:has-text("Jantar")');
  await page.waitForSelector('.sheet');
  await page.click('.sheet .btn.danger');
  await page.click('.sheet .btn.danger');
  await fechado();
  await page.waitForFunction(() => !document.body.innerText.includes('Jantar'), null, { timeout: 4000 }).catch(() => {});
  check(!(await texto()).includes('Jantar') && (await pool.query("select count(*)::int n from despesas where descricao = 'Jantar'")).rows[0].n === 0, 'apagar com dois toques');

  console.log('Meses e sessão');
  await page.click('[aria-label="Mês anterior"]');
  await page.waitForTimeout(400);
  td = await texto();
  check(td.includes('Outubro 2026') && td.includes('Sem despesas em outubro'), 'outubro vazio (fixas só começam em novembro)');
  await page.click('.link.small:has-text("Este mês")');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('h1:has-text("Resumo")', { timeout: 5000 });
  check(true, 'sessão mantém-se ao reabrir a app');

  // modo escuro
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot('12-resumo-escuro');
  await tab('Despesas');
  await shot('13-despesas-escuro');
  await page.emulateMedia({ colorScheme: 'light' });

  await tab('Ajustes');
  await page.click('button:has-text("Terminar sessão")');
  await page.waitForSelector('form.login', { timeout: 5000 });
  check(true, 'terminar sessão volta ao ecrã de entrada');

  // sem overflow horizontal
  const ov = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!ov, 'sem scroll horizontal');

  check(erros.length === 0, 'sem erros de JavaScript na consola' + (erros.length ? ': ' + erros.join(' | ') : ''));
  const esperados = ['token inválido', 'permission denied for table despesas'];
  const bdErros = log.filter(l => (l.startsWith('ERRO') || l.startsWith('SEM ROTA')) && !esperados.some(x => l.includes(x)));
  check(bdErros.length === 0, 'sem pedidos rejeitados pela base de dados' + (bdErros.length ? ': ' + bdErros.join(' | ') : ''));

  await browser.close();
  await pool.end();
  console.log(falhas.length ? '\n' + falhas.length + ' FALHAS' : '\nTUDO OK');
  process.exit(falhas.length ? 1 : 0);
})().catch(async e => { console.error('ERRO NO TESTE', e); console.error(log.slice(-15).join('\n')); process.exit(2); });
