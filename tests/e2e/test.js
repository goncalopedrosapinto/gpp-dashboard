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
const ESCALARES = ['gerar_recorrentes', 'registar_apple_pay', 'criar_conta', 'ajustar_saldo', 'definir_principal'];
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
  const tem = async t => { await page.waitForFunction(x => document.body.innerText.includes(x), t, { timeout: 5000 }).catch(() => {}); return (await texto()).includes(t); };
  const fechado = () => page.waitForSelector('dialog.sheet', { state: 'detached', timeout: 5000 });
  const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const a11y = [];
  async function auditar(nome) {
    const v = await page.evaluate(async src => {
      if (!window.axe) { const sc = document.createElement('script'); sc.textContent = src; document.head.append(sc); }
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
      return r.violations.map(x => ({ id: x.id, impact: x.impact, n: x.nodes.length, alvo: x.nodes.slice(0, 2).map(n => n.target.join(' ')).join(' | ') }));
    }, AXE);
    v.forEach(x => a11y.push(nome + ': ' + x.id + ' [' + x.impact + '] x' + x.n + ' -> ' + x.alvo));
  }
  const apagarNaFolha = async () => { await page.click('.sheet .btn.danger'); await page.waitForSelector('dialog.alert[open]'); await page.click('dialog.alert .danger'); await fechado(); };
  const tab = async n => { await page.click(`.tab:has-text("${n}")`); await page.waitForTimeout(250); };
  const guardar = async () => { await page.click('.sheet .snav .link.b'); await fechado(); };
  const bd = async (sql, a) => (await pool.query(sql, a || [])).rows;
  const bdUser = async sql => { const c = await pool.connect(); try { await c.query('begin'); await c.query('set local role authenticated'); await c.query("select set_config('request.jwt.claim.sub', $1, true)", [USER.id]); const r = (await c.query(sql)).rows; await c.query('commit'); return r; } finally { c.release(); } };
  const semEsp = async () => (await texto()).replace(/[\s\u00a0\u202f]/g, '');
  const EURN = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
  const eur = v => EURN.format(v).replace(/[\s\u00a0\u202f]/g, '');

  await page.goto(BASE + '/app/index.html');
  await page.waitForSelector('form.login');
  await shot('01-login');

  console.log('Entrada');
  await page.fill('input[type=email]', USER.email);
  await page.fill('input[type=password]', 'errada');
  await page.click('button[type=submit]');
  await page.waitForSelector('#login-erro:not([hidden])');
  check((await page.textContent('#login-erro')).includes('Email ou palavra-passe errados') && (await page.getAttribute('input[type=password]', 'aria-invalid')) === 'true', 'palavra-passe errada: erro junto ao formulário, campos marcados');
  await auditar('login com erro');
  erros.length = 0;
  await page.fill('input[type=password]', USER.password);
  await page.click('button[type=submit]');
  await page.waitForSelector('h1:has-text("Resumo")');
  await page.waitForTimeout(300);
  check(await tem('Novembro 2026'), 'entra no Resumo de novembro 2026');
  check((await bd('select nome_ela from config'))[0].nome_ela === 'Bia', 'nome por defeito: Bia');
  await shot('02-resumo-vazio');
  await auditar('resumo vazio');
  console.log('Contas');
  await page.click('button:has-text("Indicar o saldo da conta principal")');
  await page.waitForSelector('dialog.sheet[open]');
  check(await page.isDisabled('.sheet [aria-label="Conta principal"]') && await page.isChecked('.sheet [aria-label="Conta principal"]'), 'primeira conta é a principal');
  await page.click('.sheet .snav .link.b');
  check(await tem('Indica quanto tens hoje nesta conta'), 'sem saldo: erro junto ao Guardar');
  await page.fill('.sheet [aria-label="Saldo hoje"]', '2.500,00');
  await page.fill('.sheet [aria-label="Nome da conta"]', 'CGD à ordem');
  await guardar();
  await toastTem('Conta criada');
  await page.click('button:has-text("Nova conta")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Saldo hoje"]', '8000');
  await page.fill('.sheet [aria-label="Nome da conta"]', 'Poupança');
  await page.click('.sheet .chip:has-text("Poupança")');
  await guardar();
  await page.waitForTimeout(300);
  check((await semEsp()).includes('10500,00€'), 'o meu dinheiro: 2500 + 8000 = 10 500,00 €');
  const contasBd = await bd('select id, nome, tipo, principal from contas order by id');
  check(contasBd.length === 2 && contasBd[0].principal && contasBd[1].tipo === 'poupanca' && !contasBd[1].principal, 'contas gravadas: CGD principal, Poupança do tipo poupança');
  await shot('02b-contas');
  await auditar('contas');


  console.log('Ganhos');
  await tab('Ganhos');
  async function novoGanho(v, d, tipo) {
    await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
    await page.fill('.sheet [aria-label="Valor do ganho"]', v);
    await page.fill('.sheet [aria-label="Descrição"]', d);
    if (tipo) await page.click(`.sheet .chip:has-text("${tipo}")`);
    await guardar();
  }
  await novoGanho('1250', 'Salário de novembro');
  await toastTem('Ganho guardado');
  await novoGanho('340,50', 'Comissões outubro', 'Comissões');
  check(await tem('1590,50'), 'total de ganhos 1590,50 €');
  check((await bd("select categoria from ganhos where valor = 1250"))[0].categoria === 'Salário', 'tipo Salário por defeito');
  await shot('03-ganhos');

  console.log('Fixas');
  await tab('Fixas');
  async function novaFixa(v, n, dia, cat, parteDela, metade) {
    await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
    await page.fill('.sheet [aria-label="Valor mensal"]', v);
    await page.fill('.sheet [aria-label="Nome"]', n);
    await page.fill('.sheet [aria-label="Dia do pagamento"]', dia);
    await page.click(`.sheet .chip:has-text("${cat}")`);
    if (parteDela || metade) {
      await page.check('.sheet [aria-label="Partilhada"]');
      if (metade) await page.click('.sheet button:has-text("Metade")');
      else await page.fill('.sheet [aria-label="Parte da Bia"]', parteDela);
    }
    await guardar();
  }
  await novaFixa('600', 'Renda', '1', 'Casa', '300');
  await toastTem('Fixa criada');
  await novaFixa('40', 'Água', '31', 'Casa', null, true);
  await novaFixa('35', 'Ginásio', '28', 'Saúde');
  const tf = await texto();
  check(tf.includes('675,00') && tf.includes('320,00') && tf.includes('355,00'), 'fixas: total 675 €, parte da Bia 320 €, teu custo 355 €');
  check(tf.includes('Bia paga 20,00'), '"Metade" põe 20 € na água');
  await shot('04-fixas');
  await auditar('fixas');

  console.log('Gastos');
  await tab('Gastos');
  let td = await texto();
  check(td.includes('3 gastos'), 'as 3 fixas entraram sozinhas');
  check(td.toLowerCase().includes('segunda-feira, 30 de novembro'), 'água (dia 31) passou para 30 de novembro');
  check(td.includes('Bia deve 300,00'), 'renda mostra "Bia deve 300,00 €"');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  await page.click('.sheet .snav .link.b');
  await page.waitForSelector('.sheet .ferr:not([hidden])');
  check((await page.textContent('.sheet .ferr')).includes('Indica um valor maior que zero') && (await page.getAttribute('.sheet [aria-label="Valor"]', 'aria-invalid')) === 'true', 'guardar sem valor: erro junto ao botão, campo marcado, folha continua aberta');
  await shot('05a-erro-valor');
  await auditar('folha com erro');
  await page.keyboard.press('Escape');
  await fechado();
  check(true, 'Escape fecha a folha');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Valor"]', '50');
  await page.fill('.sheet [aria-label="Descrição"]', 'Jantar');
  await page.click('.sheet .chip:has-text("Restauração")');
  await page.check('.sheet [aria-label="Partilhada"]');
  await page.fill('.sheet [aria-label="Parte da Bia"]', '25');
  await page.check('.sheet [aria-label="Já recebi"]');
  await page.waitForTimeout(100);
  check((await page.textContent('.sheet .split')).includes('Custa-te 25,00'), 'conta de 50 € com 25 € da Bia: custa-te 25,00 €');
  await shot('05-gasto-partilhado');
  await guardar();
  check(await tem('Bia pagou 25,00'), 'jantar aparece como "Bia pagou 25,00 €"');

  console.log('Calculadora');
  await tab('Calcular');
  check((await page.inputValue('[aria-label="O meu rendimento"]')) === '1590,50', 'calculadora sugere os teus ganhos do mês');
  await page.fill('[aria-label="Rendimento da Bia"]', '1000'); await page.press('[aria-label="Rendimento da Bia"]', 'Tab');
  await page.fill('[aria-label="O meu rendimento"]', '1500'); await page.press('[aria-label="O meu rendimento"]', 'Tab');
  await page.fill('[aria-label="Valor a dividir"]', '30');
  await page.waitForTimeout(300);
  check((await page.textContent('[data-r=eu]')).includes('18,00') && (await page.textContent('[data-r=ela]')).includes('12,00'), 'calculadora: 30 € -> 18,00 € / 12,00 €');
  const cfg = (await bd('select calc_eu, calc_ela from config'))[0];
  check(cfg.calc_eu === 1500 && cfg.calc_ela === 1000, 'rendimentos da calculadora ficam guardados');
  await shot('06-calcular');
  await auditar('calcular');
  await page.click('button:has-text("Registar como gasto partilhado")');
  await page.waitForSelector('dialog.sheet[open]');
  check((await page.inputValue('.sheet [aria-label="Parte da Bia"]')) === '12,00', 'registar a partir da calculadora preenche a parte da Bia (12,00)');
  await page.fill('.sheet [aria-label="Descrição"]', 'Gasolina');
  await guardar();
  const gas = (await bd("select valor, partilhada, parte_dela, recebido from despesas where descricao = 'Gasolina'"))[0];
  check(gas && gas.valor === 30 && gas.parte_dela === 12 && gas.partilhada && !gas.recebido, 'gasolina: 30 € pelo total, 12 € a receber');

  console.log('Apple Pay');
  const token = (await bd('select token_atalho from config'))[0].token_atalho;
  const ap = b => rest('POST', 'rpc/registar_apple_pay', '', { apikey: 'sb_publishable_x' }, JSON.stringify(Object.assign({ token }, b)));
  const r1 = await ap({ valor: '12,50 €', comerciante: 'Continente', cartao: 'Visa CGD' });
  const r2 = await ap({ valor: '3,20', comerciante: 'Padaria Aveiro' });
  const rx = await rest('POST', 'rpc/registar_apple_pay', '', {}, JSON.stringify({ token: 'falso', valor: '1' }));
  check(r1.status === 200 && r2.status === 200, 'Atalho regista gastos com o token');
  check(rx.status === 400, 'token falso recusado');
  check((await rest('GET', 'ganhos', '?select=*', {}, null)).status === 403, 'sem sessão não se lêem ganhos');
  await tab('Gastos');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  check(await tem('Por rever (2)'), 'dois gastos Apple Pay por rever');
  await page.click('.chip:has-text("Por rever")');
  await page.waitForTimeout(200);
  await shot('07-por-rever');
  await page.click('.lrow:has-text("Continente")'); await page.waitForSelector('dialog.sheet[open]');
  await page.click('.sheet .chip:has-text("Supermercado")');
  await page.check('.sheet [aria-label="Partilhada"]');
  await guardar();
  await ap({ valor: '20,00', comerciante: 'CONTINENTE' });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(400);
  await page.click('.chip:has-text("Todos")'); await page.waitForTimeout(200);
  const cont = await page.textContent('.lrow:has-text("CONTINENTE")');
  check(cont.includes('Supermercado') && cont.includes('parte da Bia por definir'), 'segunda compra no Continente já entra como Supermercado + partilhada');
  await shot('08-gastos');
  await auditar('gastos');

  console.log('Resumo');
  await tab('Resumo');
  // gastos 600+40+35+50+30+12,50+3,20+20 = 790,70; recebido 25; custo liquido 765,70; ganhos 1590,50; saldo 824,80
  // a receber: renda 300 + agua 20 + gasolina 12 = 332 (+2 Continente sem parte)
  let tr = await texto();
  check(tr.includes('824,80'), 'saldo 824,80 €');
  check(tr.includes('790,70') && tr.includes('765,70') && tr.includes('25,00'), 'gastos 790,70 €, recebido 25 €, custo líquido 765,70 €');
  check(tr.includes('332,00') && tr.includes('5 contas partilhadas') && tr.includes('2 contas sem a parte da Bia definida'), 'a receber da Bia: 332,00 € em 5 contas (2 por definir)');
  await shot('09-resumo');
  await auditar('resumo');
  await page.click('.lrow:has-text("Renda") .mini');
  await toastTem('Recebido: 300,00');
  check(await tem('1124,80'), 'marcar a renda como recebida: saldo sobe para 1124,80 €');
  await page.click('.lrow:has(.rtitle:text-is("Continente")) .mini');
  await page.waitForSelector('dialog.sheet[open]');
  await page.click('.sheet button:has-text("Metade")');
  await page.check('.sheet [aria-label="Já recebi"]');
  await guardar();
  check(await tem('1131,05'), '"Definir" no Continente: metade (6,25 €) recebida, saldo 1131,05 €');
  await page.evaluate(() => window.scrollTo(0, 700)); await page.waitForTimeout(200);
  await shot('10-resumo-a-receber');
  await page.evaluate(() => window.scrollTo(0, 0));

  console.log('Ajustes');
  await page.click('[aria-label="Ajustes"]');
  await page.waitForSelector('h1:has-text("Ajustes")');
  check((await page.inputValue('[aria-label="Nome dela"]')) === 'Bia' && (await tem(token.slice(0, 8))), 'Ajustes: nome Bia e token do Atalho');
  await shot('11-ajustes');
  await auditar('ajustes');
  await page.click('button:has-text("Fechar")');
  await page.waitForSelector('h1:has-text("Resumo")');


  console.log('Ajustar, transferir, gastar da poupança');
  await page.waitForSelector('h1:has-text("Resumo")');
  const dbTot = (await bdUser('select sum(saldo_atual)::float8 t from saldos_contas'))[0].t;
  check((await semEsp()).includes(eur(dbTot)), 'total no ecrã bate com a base de dados (' + eur(dbTot) + ')');
  await page.click('[aria-label="Ajustar: CGD à ordem"]'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Saldo real hoje"]', '3000');
  await page.waitForTimeout(100);
  check((await page.textContent('.sheet .split')).includes('diferença'), 'ajustar mostra a diferença face ao calculado');
  await shot('11b-ajustar');
  await auditar('ajustar');
  await guardar();
  await toastTem('Saldo ajustado');
  const cgd = async () => (await page.textContent('.lrow:has(.rtitle:text-is("CGD à ordem")) .rval')).replace(/[\s\u00a0\u202f]/g, '');
  const pou = async () => (await page.textContent('.lrow:has(.rtitle:text-is("Poupança")) .rval')).replace(/[\s\u00a0\u202f]/g, '');
  check((await cgd()) === '3000,00€', 'depois do ajuste a CGD mostra exatamente 3000,00 €');
  const pouAntes = Number((await bdUser("select saldo_atual::float8 s from saldos_contas where nome = 'Poupança'"))[0].s);
  await page.click('button:has-text("Transferir")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Valor a transferir"]', '500');
  await guardar();
  await toastTem('Transferido');
  check((await cgd()) === '2500,00€' && (await pou()) === eur(pouAntes + 500), 'transferir 500 €: CGD 2500 €, Poupança +500 €');
  await tab('Gastos');
  await page.click('.addbtn'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Valor"]', '100');
  await page.fill('.sheet [aria-label="Descrição"]', 'Seguro');
  await page.selectOption('.sheet [aria-label="Conta"]', { label: 'Poupança' });
  await guardar();
  const seg = (await bd("select d.conta_id, c.nome from despesas d join contas c on c.id = d.conta_id where d.descricao = 'Seguro'"))[0];
  check(seg && seg.nome === 'Poupança', 'gasto com conta escolhida grava na Poupança');
  await tab('Resumo');
  check((await pou()) === eur(pouAntes + 400) && (await cgd()) === '2500,00€', 'o seguro sai da Poupança e não mexe na CGD');

  console.log('Editar e apagar');
  await tab('Fixas');
  await page.click('.lrow:has-text("Ginásio")'); await page.waitForSelector('dialog.sheet[open]');
  await page.fill('.sheet [aria-label="Valor mensal"]', '40');
  await guardar();
  check((await bd("select valor from despesas where descricao = 'Ginásio'"))[0].valor === 40, 'mudar a fixa atualiza o lançamento deste mês');
  await tab('Gastos');
  await page.click('.lrow:has-text("Jantar")'); await page.waitForSelector('dialog.sheet[open]');
  await page.click('.sheet .btn.danger'); await page.waitForSelector('dialog.alert[open]');
  await shot('12a-confirmar-apagar');
  await auditar('confirmar apagar');
  await page.click('dialog.alert button:has-text("Cancelar")');
  await page.waitForSelector('dialog.alert', { state: 'detached' });
  check((await bd("select count(*)::int n from despesas where descricao = 'Jantar'"))[0].n === 1, 'Cancelar na confirmação não apaga');
  await apagarNaFolha();
  await page.waitForTimeout(400);
  check((await bd("select count(*)::int n from despesas where descricao = 'Jantar'"))[0].n === 0 && !(await texto()).includes('Jantar'), 'apagar gasto com dois toques');
  await tab('Ganhos');
  await page.click('.lrow:has-text("Comissões")'); await page.waitForSelector('dialog.sheet[open]');
  await apagarNaFolha();
  check(await tem('1250,00'), 'apagar ganho: total passa a 1250,00 €');

  console.log('Meses e sessão');
  await page.click('[aria-label="Mês anterior"]');
  check(await tem('Sem ganhos em outubro'), 'outubro sem ganhos');
  await page.click('.link.small:has-text("Este mês")');
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('h1:has-text("Resumo")', { timeout: 5000 });
  check(true, 'sessão mantém-se ao reabrir');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(300);
  await shot('12-resumo-escuro');
  await auditar('resumo escuro');
  await tab('Gastos'); await shot('13-gastos-escuro');
  await page.emulateMedia({ colorScheme: 'light' });
  await tab('Resumo');
  await page.click('[aria-label="Ajustes"]');
  await page.click('button:has-text("Terminar sessão")');
  await page.waitForSelector('form.login', { timeout: 5000 });
  check(true, 'terminar sessão volta ao ecrã de entrada');
  check(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'sem scroll horizontal');

  check(a11y.length === 0, 'axe-core: sem violações de acessibilidade' + (a11y.length ? '\n      ' + a11y.join('\n      ') : ''));
  check(erros.length === 0, 'sem erros de JavaScript' + (erros.length ? ': ' + erros.join(' | ') : ''));
  const esperados = ['token inválido', 'permission denied for table ganhos'];
  const bdErros = log.filter(l => (l.startsWith('ERRO') || l.startsWith('SEM ROTA')) && !esperados.some(x => l.includes(x)));
  check(bdErros.length === 0, 'sem pedidos rejeitados' + (bdErros.length ? ': ' + bdErros.join(' | ') : ''));

  await browser.close();
  await pool.end();
  console.log(falhas.length ? '\n' + falhas.length + ' FALHAS' : '\nTUDO OK');
  process.exit(falhas.length ? 1 : 0);
})().catch(async e => { console.error('ERRO NO TESTE', e); console.error(log.slice(-15).join('\n')); process.exit(2); });
