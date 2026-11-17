(function () {
'use strict';

// ===================== Configuração =====================
const SUPABASE_URL = 'https://klmjdjhvsxvopctgmhyu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_L3QfJtwa_wYBCsHN4uzgXQ_rcp52nL8';
const VERSAO = 'v2.0 · nov 2026';
const CATEGORIAS = ['Casa', 'Supermercado', 'Restauração', 'Transportes', 'Saúde', 'Lazer', 'Compras', 'Subscrições', 'Outros'];
const TITULOS = { pagar: 'Por pagar', despesas: 'Despesas', comum: 'Em comum', agenda: 'Agenda', fixas: 'Fixas', ajustes: 'Ajustes' };
const TABS = ['pagar', 'despesas', 'comum', 'agenda'];

const app = document.getElementById('app');
if (!window.supabase || !window.supabase.createClient) {
  app.textContent = 'Não foi possível carregar a ligação ao servidor. Verifica a internet e abre outra vez.';
  return;
}
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gpp-dashboard-auth' }
});

const S = {
  user: null, config: null, tab: 'pagar', mes: null, filtro: 'todas', loading: false, seq: 0,
  despesas: [], atrasados: [], fixas: [], eventos: [], acertos: [], casal: null, diaSel: null,
  bloqueado: false, saiuEm: 0, avisoLogin: null
};

// ===================== Utilitários =====================
function h(tag, props) {
  const el = document.createElement(tag);
  if (props) {
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (typeof v === 'boolean' && k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
  if (tag === 'input' && !el.hasAttribute('enterkeyhint')) el.setAttribute('enterkeyhint', 'done');
  return el;
}
function append(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(k => append(el, k)); return; }
  el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  pagar: ['M9 11l3 3 8-8', 'M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9'],
  comum: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1', 'M16 3.13a4 4 0 0 1 0 7.75', 'M22 21v-1a6 6 0 0 0-4-5.65'],
  visto: ['M5 12.5l4.5 4.5L19 7.5'],
  despesas: ['M12 21V9', 'M7 14l5-5 5 5', 'M5 3h14'],
  agenda: ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 2v4', 'M16 2v4', 'M3 10h18', 'M8 14h.01', 'M12 14h.01', 'M16 14h.01', 'M8 18h.01', 'M12 18h.01'],
  fixas: ['M17 2l4 4-4 4', 'M3 11V9a3 3 0 0 1 3-3h15', 'M7 22l-4-4 4-4', 'M21 13v2a3 3 0 0 1-3 3H3'],
  ajustes: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6']
};
function icon(paths) {
  const s = document.createElementNS(SVGNS, 'svg');
  const at = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  Object.keys(at).forEach(k => s.setAttribute(k, at[k]));
  paths.forEach(d => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); });
  return s;
}

const EUR = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const fmt = v => EUR.format(Number(v) || 0);
const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const ok = n => typeof n === 'number' && isFinite(n);
const soma = (arr, f) => r2(arr.reduce((a, x) => a + (Number(f(x)) || 0), 0));
const pctTxt = n => String(Math.round(n * 10) / 10).replace('.', ',') + '%';
// Números à portuguesa: 1234,56 · 1.234,56 · 1234.56 · 12.500 (= doze mil e quinhentos)
function parseNum(s) {
  if (s == null) return null;
  let t = String(s).replace(/[^0-9,.\-]/g, '');
  if (!t) return null;
  const neg = t.charAt(0) === '-';
  t = t.replace(/-/g, '');
  if (!t) return null;
  const v = t.indexOf(',') >= 0, p = t.indexOf('.') >= 0;
  if (v && p) {                       // o último separador é o decimal; o outro é de milhares
    const dec = t.lastIndexOf(',') > t.lastIndexOf('.') ? ',' : '.';
    t = t.split(dec === ',' ? '.' : ',').join('');
    if (t.split(dec).length > 2) return NaN;
    t = t.replace(dec, '.');
  } else if (v) {
    t = t.split(',').length === 2 ? t.replace(',', '.') : t.replace(/,/g, '');
  } else if (p && /^[1-9]\d{0,2}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, '');          // ponto com grupos de 3 = milhares
  }
  const n = Number(t);
  return ok(n) ? r2(neg ? -n : n) : NaN;
}
const toInput = v => (v == null || v === '') ? '' : Number(v).toFixed(2).replace('.', ',');
const pad2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const hojeISO = () => iso(new Date());
const mesAtual = () => hojeISO().slice(0, 8) + '01';
function addMes(m, n) { const [y, mo] = m.split('-').map(Number); return iso(new Date(y, mo - 1 + n, 1)); }
function ultimoDia(m) { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); }
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function diasEntre(a, b) { const [y1, m1, d1] = a.split('-').map(Number), [y2, m2, d2] = b.split('-').map(Number); return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000); }
function somaDias(d, n) { const [y, m, da] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, da + n)).toISOString().slice(0, 10); }
const fmtC = v => fmt(v).replace(/,00(?=\s*€)/, '');   // 1500 € em vez de 1500,00 €
function nomeMes(m) {
  const [y, mo] = m.split('-').map(Number);
  return cap(new Intl.DateTimeFormat('pt-PT', { month: 'long' }).format(new Date(y, mo - 1, 1))) + ' ' + y;
}
const mesMin = m => nomeMes(m).replace(/^./, c => c.toLowerCase());
function diaLongo(d) {
  const [y, mo, da] = d.split('-').map(Number);
  const t = new Intl.DateTimeFormat('pt-PT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(y, mo - 1, da));
  return (d === hojeISO() ? 'Hoje · ' : '') + t;
}
function diaCurto(d) {
  if (d === hojeISO()) return 'Hoje';
  const [y, mo, da] = d.split('-').map(Number);
  return da + ' ' + new Intl.DateTimeFormat('pt-PT', { month: 'short' }).format(new Date(y, mo - 1, da)).replace('.', '');
}
const nomeEla = () => ((S.casal && S.casal.outro && S.casal.outro.nome) || (S.config && S.config.nome_ela) || '').trim();
const ELA = () => nomeEla() || 'Bia';
const DA = () => 'da ' + ELA();

// Despesas em comum: a minha parte e quem pagou
const comum = x => x.casal_id != null;
const pctEu = x => (!comum(x) || x.pct_m1 == null || !S.casal ? 100 : S.casal.eu.ordem === 1 ? Number(x.pct_m1) : 100 - Number(x.pct_m1));
const minhaParte = x => r2(Number(x.valor) * pctEu(x) / 100);
const pagouEu = x => !!(S.casal && x.pago_por_membro === S.casal.eu.membro_id);
const fonteTxt = x => (x.fonte === 'notificacao' ? 'Notificação do banco' : x.fonte === 'ambas' ? 'Apple Pay + banco' : 'Apple Pay');
const porRever = x => x.origem === 'apple_pay' && !x.categoria;

let toastT;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = ''; }, 2800);
}
function traduzErro(e) {
  const m = (e && (e.message || e.error_description || e.msg)) || String(e);
  if (/invalid login credentials/i.test(m)) return 'Email ou palavra-passe errados.';
  if (/email not confirmed/i.test(m)) return 'Ainda não confirmaste o email. Abre o email que te enviámos e volta a entrar.';
  if (/already registered|already exists/i.test(m)) return 'Já existe uma conta com este email. Entra com ela.';
  if (/password should be|weak password/i.test(m)) return 'Palavra-passe fraca: usa pelo menos 8 caracteres, com letras e números.';
  if (/signups not allowed|signup is disabled/i.test(m)) return 'Criar contas está desligado no servidor. Pede ao Gonçalo para o ligar.';
  if (/^(Já tens|Código inválido|A conta em comum|Ainda não tens|A percentagem)/.test(m)) return m;
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(m)) return 'Sem ligação. Tenta outra vez.';
  if (/jwt|session|refresh token/i.test(m)) return 'A sessão expirou. Entra outra vez.';
  if (/parte_dela_ck/.test(m)) return 'A parte ' + DA() + ' não pode ser maior que o total.';
  return 'Erro: ' + m;
}
function erro(e) { console.error(e); toast(traduzErro(e), true); }
async function q(p) { const r = await p; if (r.error) throw r.error; return r.data; }

function copiar(txt) {
  const fallback = () => {
    const ta = h('textarea', { style: 'position:fixed;top:-100px;opacity:0' });
    ta.value = txt; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Copiado'); } catch (e) { toast('Não deu para copiar', true); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('Copiado'), fallback);
  else fallback();
}

// Blocos de interface
let uid = 0;
const group = (...rows) => h('div', { class: 'group' }, rows);
const lista = items => h('ul', { class: 'group', role: 'list' }, items.map(it => h('li', null, it)));
const grow = (label, control) => h('div', { class: 'grow' }, typeof label === 'string' ? h('span', { class: 'glab', text: label }) : label, control);
const kv = (k, v, cls) => grow(k, h('span', { class: 'gval num' + (cls ? ' ' + cls : ''), text: v }));
const glabel = (t, nivel) => h(nivel || 'h2', { class: 'glabel', text: t });
const hint = (t, cls) => h('p', { class: 'hint' + (cls ? ' ' + cls : ''), text: t });
// Estado vazio: sempre com uma ação clara
const vazio = (t, rotulo, acao) => h('div', { class: 'empty' }, h('p', { text: t }),
  acao ? h('button', { type: 'button', class: 'btn primary', text: rotulo, onclick: acao }) : null);
// Carregamento: esqueleto estático + texto para leitores de ecrã
const carregando = () => [
  h('p', { class: 'sr-only', role: 'status', text: 'A carregar…' }),
  h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', { class: 'w40' }), h('i', { class: 'big' }), h('i'), h('i', { class: 'w60' })),
  h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i'), h('i', { class: 'w60' }), h('i'), h('i', { class: 'w40' }))
];

function campoValor(valor, label, extra) {
  return h('input', Object.assign({ class: 'ginput num', type: 'text', inputmode: 'decimal', placeholder: '0,00', value: toInput(valor), 'aria-label': label }, extra || {}));
}
function chips(lista, st, rotulo) {
  const box = h('div', { class: 'chips', role: 'group', 'aria-label': rotulo || 'Categoria' });
  const btns = lista.map(c => h('button', {
    type: 'button', class: 'chip', text: c, 'aria-pressed': String(st.categoria === c),
    onclick: () => {
      st.categoria = st.categoria === c ? null : c;
      btns.forEach((b, i) => b.setAttribute('aria-pressed', String(st.categoria === lista[i])));
    }
  }));
  box.append(...btns);
  return box;
}
// Confirmação para ações destrutivas (alertdialog nativo)
function confirmar(titulo, texto, acaoTxt) {
  return new Promise(resolve => {
    const id = 'al' + (++uid), antes = document.activeElement;
    const cancelar = h('button', { type: 'button', text: 'Cancelar' });
    const sim = h('button', { type: 'button', class: 'danger', text: acaoTxt });
    const dlg = h('dialog', { class: 'alert', role: 'alertdialog', 'aria-labelledby': id + '-t', 'aria-describedby': id + '-d' },
      h('h2', { id: id + '-t', text: titulo }), h('p', { id: id + '-d', text: texto }), h('div', { class: 'acts2' }, cancelar, sim));
    let res = false;
    cancelar.addEventListener('click', () => dlg.close());
    sim.addEventListener('click', () => { res = true; dlg.close(); });
    dlg.addEventListener('close', () => { dlg.remove(); if (antes && antes.isConnected && antes.focus) antes.focus(); resolve(res); });
    document.body.append(dlg);
    dlg.showModal();
    cancelar.focus();
  });
}
function botaoApagar(rotulo, pergunta, texto, acao, folha) {
  const b = h('button', { type: 'button', class: 'btn danger', text: rotulo });
  b.addEventListener('click', async () => {
    if (!(await confirmar(pergunta, texto, 'Apagar'))) return;
    b.disabled = true;
    try { await acao(); } catch (e) { console.error(e); folha().erro(traduzErro(e)); b.disabled = false; }
  });
  return b;
}
// Folha de edição: <dialog> nativo. Erros aparecem junto ao botão Guardar e no campo.
function sheet(titulo, conteudo, onSave) {
  const id = 'sh' + (++uid), antes = document.activeElement;
  const err = h('p', { class: 'ferr', id: id + '-err', role: 'alert', hidden: true });
  const guardar = h('button', { class: 'link b', type: 'button', text: 'Guardar' });
  const dlg = h('dialog', { class: 'sheet', 'aria-labelledby': id + '-t' });
  const inner = h('div', { class: 'sheet-in' },
    h('div', { class: 'grab', 'aria-hidden': 'true' }),
    h('div', { class: 'snav' },
      h('button', { class: 'link', type: 'button', text: onSave ? 'Cancelar' : 'Fechar', onclick: () => fechar() }),
      h('h2', { class: 'stitle', id: id + '-t', text: titulo }),
      h('div', { class: 'r' }, onSave ? guardar : null)),
    err, conteudo);
  dlg.append(inner);
  let campoErr = null;
  function limpar() {
    err.hidden = true; err.textContent = '';
    if (campoErr) { campoErr.removeAttribute('aria-invalid'); campoErr.removeAttribute('aria-describedby'); campoErr = null; }
  }
  function mostrarErro(msg, campo) {
    limpar();
    err.textContent = msg; err.hidden = false;
    if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.setAttribute('aria-describedby', err.id); campoErr = campo; campo.focus(); }
    return false;
  }
  function fechar() { if (dlg.open) dlg.close(); }
  inner.addEventListener('input', () => { if (!err.hidden) limpar(); });
  dlg.addEventListener('click', e => { if (e.target === dlg) fechar(); }); // toque fora da folha
  dlg.addEventListener('close', () => {
    dlg.remove();
    if (!document.querySelector('dialog.sheet')) document.body.classList.remove('noscroll');
    if (antes && antes.isConnected && antes.focus) antes.focus();
  });
  guardar.addEventListener('click', async () => {
    guardar.disabled = true; limpar();
    try { const r = await onSave(); if (r !== false) fechar(); }
    catch (e) { console.error(e); mostrarErro(traduzErro(e)); }
    finally { guardar.disabled = false; }
  });
  document.body.append(dlg);
  document.body.classList.add('noscroll');
  dlg.showModal();
  return { fechar: fechar, erro: mostrarErro };
}

// ===================== Dados =====================
async function carregarMes() {
  const m = S.mes, seq = ++S.seq, fim = m.slice(0, 8) + pad2(ultimoDia(m));
  S.loading = true;
  try {
    if (m <= mesAtual()) await q(sb.rpc('gerar_recorrentes', { p_mes: m }));
    const res = await Promise.all([
      q(sb.from('despesas').select('*').eq('mes', m).order('data', { ascending: false }).order('id', { ascending: false })),
      q(sb.from('despesas').select('*').eq('pago', false).lt('data', m).order('data')),
      q(sb.from('casal_saldos').select('*').order('ordem')),
      q(sb.from('acertos').select('*').order('data', { ascending: false }).order('id', { ascending: false }).limit(30)),
      q(sb.from('eventos').select('*').eq('repete', 'nunca').lte('data', fim).gte('data_fim', m)),
      q(sb.from('eventos').select('*').neq('repete', 'nunca').lte('data', fim))
    ]);
    if (seq !== S.seq) return;
    S.despesas = res[0] || [];
    S.atrasados = res[1] || [];
    const mem = res[2] || [];
    const eu = S.user ? mem.find(x => x.user_id === S.user.id) : null;
    S.casal = eu ? { id: eu.casal_id, eu: eu, outro: mem.find(x => x.membro_id !== eu.membro_id) || null } : null;
    S.acertos = res[3] || [];
    S.eventos = (res[4] || []).concat(res[5] || []);
  } catch (e) { if (seq === S.seq) erro(e); }
  finally { if (seq === S.seq) S.loading = false; }
}
async function carregarFixas() {
  try {
    S.fixas = await q(sb.from('despesas_recorrentes').select('*').order('ativa', { ascending: false }).order('dia_vencimento').order('nome'));
  } catch (e) { erro(e); }
}
async function recarregar() { await carregarMes(); render(); }
async function guardarConfig(campos, silencioso) {
  try {
    await q(sb.from('config').update(campos).eq('owner', S.user.id));
    Object.assign(S.config, campos);
    if (!silencioso) { render(); toast('Guardado'); }
  } catch (e) { erro(e); }
}
// Visto: marcar como paga (uma fatura estimada pede primeiro o valor real)
async function alternarPago(x) {
  if (!x.pago && x.estimado) { abrirDespesa(x, { marcarPaga: true }); return; }
  try {
    await q(sb.from('despesas').update({ pago: !x.pago }).eq('id', x.id));
    await recarregar();
    toast(x.pago ? 'Voltou a «por pagar»' : 'Paga · ' + (x.descricao || fmt(x.valor)));
  } catch (e) { erro(e); }
}

// ===================== Ecrãs =====================
function linhaPagar(x) {
  const t = x.descricao || x.comerciante || 'Sem descrição', hoje = hojeISO();
  const atraso = !x.pago && x.data < hoje;
  const quando = d => (d === hoje ? 'hoje' : diaCurto(d));
  const sub = [x.pago ? 'Paga ' + quando(x.pago_em || x.data) : (atraso ? 'Venceu ' : 'Vence ') + quando(x.data),
    comum(x) ? 'Comum · tua parte ' + fmt(minhaParte(x)) : null, x.estimado ? 'estimativa' : null];
  return h('div', { class: 'lrow' },
    h('button', { type: 'button', class: 'visto' + (x.pago ? ' on' : ''), role: 'checkbox', 'aria-checked': String(!!x.pago),
      'aria-label': (x.pago ? 'Paga: ' : 'Marcar como paga: ') + t, onclick: () => alternarPago(x) }, x.pago ? icon(ICONS.visto) : null),
    h('button', { type: 'button', class: 'rmain linkrow', onclick: () => abrirDespesa(x) },
      h('div', { class: 'rtitle', text: t }),
      h('div', { class: 'rsub' + (atraso ? ' warn' : ''), text: sub.filter(Boolean).join(' · ') })),
    h('div', { class: 'rval' + (atraso ? ' neg' : ''), text: (x.estimado ? '≈ ' : '') + fmt(x.valor) }));
}

function viewPagar() {
  if (S.loading && !S.despesas.length) return carregando();
  const hoje = hojeISO(), semana = somaDias(hoje, 7), atual = S.mes === mesAtual();
  const porPagar = (atual ? S.atrasados : []).concat(S.despesas.filter(x => !x.pago)).sort((a, b) => (a.data < b.data ? -1 : 1));
  const atraso = porPagar.filter(x => x.data < hoje), estaSemana = porPagar.filter(x => x.data >= hoje && x.data <= semana), depois = porPagar.filter(x => x.data > semana);
  const out = [group(h('div', { class: 'hero' },
    h('div', { class: 'k', text: 'Por pagar' + (atual ? '' : ' em ' + mesMin(S.mes)) }),
    h('div', { class: 'big' + (atraso.length ? ' neg' : ''), text: fmt(soma(porPagar, x => x.valor)) }),
    h('div', { class: 'k', text: porPagar.length ? porPagar.length + (porPagar.length === 1 ? ' pagamento' : ' pagamentos') + (atraso.length ? ' · ' + atraso.length + ' em atraso' : '') : 'Está tudo pago.' })))];
  if (!porPagar.length && !S.fixas.length) out.push(vazio('Ainda não tens pagamentos fixos (renda, água, luz, ginásio…).', 'Adicionar despesa fixa', () => { irPara('fixas'); abrirFixa(); }));
  if (atraso.length) out.push(glabel('Em atraso'), lista(atraso.map(linhaPagar)));
  if (estaSemana.length) out.push(glabel('Próximos 7 dias'), lista(estaSemana.map(linhaPagar)));
  if (depois.length) out.push(glabel(atual ? 'Mais tarde este mês' : 'Por pagar'), lista(depois.map(linhaPagar)));
  const pagosFixas = S.despesas.filter(x => x.pago && x.recorrente_id);
  if (pagosFixas.length) out.push(glabel('Já pagos'), lista(pagosFixas.map(linhaPagar)));
  if (porPagar.length) out.push(hint('Toca no círculo para marcar como paga. Se te enganares, toca outra vez.'));

  // Quanto gastaste: as tuas despesas + a tua parte das despesas em comum
  const pessoais = S.despesas.filter(x => !comum(x)), comuns = S.despesas.filter(comum);
  out.push(glabel('Gastos de ' + mesMin(S.mes)), group(
    h('div', { class: 'hero' }, h('div', { class: 'k', text: 'A tua parte' }), h('div', { class: 'big', text: fmt(soma(S.despesas, minhaParte)) })),
    kv('Só teus', fmt(soma(pessoais, x => x.valor))),
    S.casal || comuns.length ? kv('A tua parte em comum', fmt(soma(comuns, minhaParte))) : null));
  const cats = {};
  S.despesas.forEach(x => { const c = x.categoria || 'Sem categoria'; cats[c] = (cats[c] || 0) + minhaParte(x); });
  const porCat = Object.keys(cats).map(c => [c, r2(cats[c])]).filter(c => c[1] > 0).sort((a, b) => b[1] - a[1]);
  if (porCat.length) {
    const max = porCat[0][1] || 1;
    out.push(glabel('Para onde foi'), lista(porCat.map(([c, v]) => h('div', { class: 'catrow' },
      h('div', { class: 'cattop' }, h('span', { text: c }), h('span', { class: 'num gval', text: fmt(v) })),
      h('div', { class: 'bar', 'aria-hidden': 'true', style: 'width:' + Math.max(2, Math.round(v / max * 100)) + '%' })))));
  }
  if (S.casal) {
    const v = Number(S.casal.eu.saldo);
    out.push(glabel('Com ' + ELA()), lista([h('button', { type: 'button', class: 'lrow', onclick: () => irPara('comum') },
      h('div', { class: 'rmain' }, h('div', { class: 'rtitle', text: textoSaldo(v) })),
      h('div', { class: 'rval' + (v < -0.005 ? ' neg' : v > 0.005 ? ' pos' : ''), text: fmt(Math.abs(v)) }),
      h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }))]));
  }
  return out;
}

const FILTROS = { todas: () => true, minhas: x => !comum(x), comum: comum, porpagar: x => !x.pago, rever: x => porRever(x) || !!x.estimado };
function linhaDespesa(x) {
  const tags = [];
  if (x.categoria) tags.push(x.categoria); else if (x.origem === 'apple_pay') tags.push('Por rever');
  if (comum(x)) tags.push('Comum · pagou ' + (pagouEu(x) ? 'eu' : ELA()));
  if (!x.pago) tags.push(x.data < hojeISO() ? 'Em atraso' : 'Por pagar');
  if (x.origem === 'apple_pay') tags.push(fonteTxt(x));
  if (x.origem === 'recorrente') tags.push('Fixa');
  if (x.estimado) tags.push('Por confirmar');
  return h('button', { type: 'button', class: 'lrow', onclick: () => abrirDespesa(x) },
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: x.descricao || x.comerciante || 'Sem descrição' }),
      h('div', { class: 'rsub' + (porRever(x) || x.estimado || (!x.pago && x.data < hojeISO()) ? ' warn' : ''), text: tags.join(' · ') })),
    h('div', { class: 'rvals' },
      h('div', { class: 'rval', text: (x.estimado ? '≈ ' : '') + fmt(x.valor) }),
      comum(x) ? h('div', { class: 'rsub num', text: 'tua ' + fmt(minhaParte(x)) }) : null),
    h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
}
function viewDespesas() {
  const nRever = S.despesas.filter(FILTROS.rever).length, nPagar = S.despesas.filter(FILTROS.porpagar).length;
  const filtros = [['todas', 'Todas'], ['minhas', 'Só minhas'], ['comum', 'Em comum'], ['porpagar', 'Por pagar' + (nPagar ? ' (' + nPagar + ')' : '')], ['rever', 'Por rever' + (nRever ? ' (' + nRever + ')' : '')]];
  const out = [h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Filtrar despesas' }, filtros.map(([k, l]) => h('button', {
    type: 'button', class: 'chip', text: l, 'aria-pressed': String(S.filtro === k),
    onclick: () => { S.filtro = k; render(); const f = document.querySelector('.chips.scroll [aria-pressed="true"]'); if (f) f.focus(); }
  })))];
  if (S.loading && !S.despesas.length) { out.push(...carregando()); return out; }
  const sel = S.despesas.filter(FILTROS[S.filtro] || FILTROS.todas);
  if (!sel.length) {
    if (S.filtro !== 'todas' && S.despesas.length) out.push(vazio('Nada neste filtro.', 'Ver todas', () => { S.filtro = 'todas'; render(); }));
    else out.push(vazio('Sem despesas em ' + mesMin(S.mes) + '.', 'Registar despesa', () => abrirDespesa()));
    return out;
  }
  out.push(hint(sel.length + (sel.length === 1 ? ' despesa · ' : ' despesas · ') + fmt(soma(sel, x => x.valor)) + ' · a tua parte ' + fmt(soma(sel, minhaParte))));
  const grupos = group2(sel, x => x.data);
  Object.keys(grupos).forEach(d => out.push(glabel(cap(diaLongo(d))), lista(grupos[d].map(linhaDespesa))));
  return out;
}
function group2(arr, f) { const g = {}; arr.forEach(x => { (g[f(x)] = g[f(x)] || []).push(x); }); return g; }

// ===================== Em comum =====================
const textoSaldo = v => (v > 0.005 ? ELA() + ' deve-te' : v < -0.005 ? 'Deves a ' + ELA() : 'Estão acertados');
function viewComum() {
  if (S.loading && !S.casal && !S.despesas.length) return carregando();
  if (!S.casal) return blocoCriarCasal();
  const c = S.casal, v = Number(c.eu.saldo), outro = c.outro;
  const out = [group(h('div', { class: 'hero' },
    h('div', { class: 'k', text: textoSaldo(v) }),
    h('div', { class: 'big' + (v < -0.005 ? ' neg' : v > 0.005 ? ' pos' : ''), text: fmt(Math.abs(v)) }),
    Math.abs(v) > 0.005 ? h('button', { type: 'button', class: 'btn primary', text: 'Acertar contas', onclick: () => abrirAcerto(null, v) }) : null))];
  out.push(hint('Conta só o que já está pago. Cada despesa em comum divide-se pela percentagem que ficou nela.'));
  out.push(glabel('Divisão'), group(
    kv(c.eu.nome + ' (tu)', pctTxt(Number(c.eu.pct))),
    kv(outro ? outro.nome : ELA(), pctTxt(Number(outro ? outro.pct : 100 - c.eu.pct))),
    grow('', h('button', { type: 'button', class: 'link b', text: 'Alterar divisão', onclick: abrirDivisao }))));
  if (outro && !outro.user_id) out.push(glabel(ELA() + ' ainda não entrou na app'), group(
    h('div', { class: 'pad' }, h('p', { class: 'k', style: 'margin:0 0 10px', text: 'Gera um código e manda-o a ' + ELA() + '. Cria conta na app e escreve o código em «Em comum».' }),
      h('button', { type: 'button', class: 'btn', text: 'Gerar código de convite', onclick: convidar }))));
  const comuns = S.despesas.filter(comum);
  out.push(glabel('Em comum em ' + mesMin(S.mes)));
  out.push(comuns.length ? lista(comuns.map(linhaDespesa)) : vazio('Sem despesas em comum este mês.', 'Registar despesa em comum', () => abrirDespesa(null, { comum: true })));
  if (S.acertos.length) {
    out.push(glabel('Acertos'), lista(S.acertos.map(a => {
      const recebi = a.para_membro === c.eu.membro_id;
      return h('button', { type: 'button', class: 'lrow', onclick: () => abrirAcerto(a) },
        h('div', { class: 'rmain' }, h('div', { class: 'rtitle', text: recebi ? ELA() + ' pagou-te' : 'Pagaste a ' + ELA() }),
          h('div', { class: 'rsub', text: [diaCurto(a.data), a.nota].filter(Boolean).join(' · ') })),
        h('div', { class: 'rval' + (recebi ? ' pos' : ''), text: fmt(a.valor) }),
        h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
    })));
  }
  return out;
}
function blocoCriarCasal() {
  const meu = h('input', { class: 'ginput', type: 'text', maxlength: '40', autocapitalize: 'words', 'aria-label': 'O teu nome', placeholder: 'Gonçalo', value: '' });
  const dela = h('input', { class: 'ginput', type: 'text', maxlength: '40', autocapitalize: 'words', 'aria-label': 'Nome dela', placeholder: 'Bia', value: (S.config && S.config.nome_ela) || '' });
  const pct = h('input', { class: 'ginput num', type: 'text', inputmode: 'numeric', maxlength: '3', 'aria-label': 'A tua parte em percentagem', placeholder: '50', value: '50' });
  const cod = h('input', { class: 'ginput', type: 'text', maxlength: '8', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Código de convite', placeholder: 'Ex.: 7KQ2XA' });
  const e1 = h('p', { class: 'lerr', role: 'alert', hidden: true }), e2 = h('p', { class: 'lerr', role: 'alert', hidden: true });
  const falha = (el, campo, m) => { el.textContent = m; el.hidden = false; if (campo) { campo.setAttribute('aria-invalid', 'true'); campo.focus(); } };
  const criar = h('button', { type: 'button', class: 'btn primary', text: 'Criar conta em comum', onclick: async () => {
    e1.hidden = true;
    const p = parseNum(pct.value);
    if (!ok(p) || p < 0 || p > 100) return falha(e1, pct, 'A tua parte tem de ser entre 0 e 100%.');
    criar.disabled = true;
    try { await q(sb.rpc('criar_casal', { p_meu_nome: meu.value.trim() || 'Eu', p_nome_outro: dela.value.trim() || 'Bia', p_meu_pct: p })); await recarregar(); toast('Conta em comum criada'); }
    catch (e) { falha(e1, null, traduzErro(e)); }
    finally { criar.disabled = false; }
  } });
  const entrarC = h('button', { type: 'button', class: 'btn', text: 'Entrar com o código', onclick: async () => {
    e2.hidden = true;
    if (!cod.value.trim()) return falha(e2, cod, 'Escreve o código que recebeste.');
    entrarC.disabled = true;
    try { await q(sb.rpc('aceitar_convite', { p_codigo: cod.value.trim() })); await Promise.all([recarregar(), carregarFixas()]); render(); toast('Entraste na conta em comum'); }
    catch (e) { falha(e2, cod, traduzErro(e)); }
    finally { entrarC.disabled = false; }
  } });
  return [
    group(h('div', { class: 'hero' }, h('p', { class: 'k', style: 'margin:0', text: 'Regista as despesas da casa com a Bia: os dois veem as mesmas, cada uma dividida pela percentagem que combinarem, e a app diz quem deve a quem. As tuas despesas pessoais continuam só tuas.' }))),
    glabel('Criar'), group(grow('O teu nome', meu), grow('Nome dela', dela), grow('A tua parte (%)', pct)), e1,
    h('div', { class: 'pad0' }, criar),
    glabel('Recebeste um código?'), group(grow('Código', cod)), e2,
    h('div', { class: 'pad0' }, entrarC)
  ];
}
async function convidar() {
  try {
    const cod = await q(sb.rpc('gerar_convite'));
    let s;
    s = sheet('Convidar ' + ELA(), [
      h('div', { class: 'codigo', text: cod }),
      h('p', { class: 'split', text: 'válido durante 7 dias' }),
      group(h('ol', { class: 'steps' },
        h('li', null, 'Ela abre ', h('b', { text: 'goncalopedrosapinto.github.io/gpp-dashboard' }), ' no iPhone e toca em «Criar conta».'),
        h('li', null, 'Depois de entrar, vai a ', h('b', { text: 'Em comum' }), ' e escreve este código.'),
        h('li', null, 'A partir daí veem as mesmas despesas em comum. As pessoais continuam privadas.'))),
      h('button', { type: 'button', class: 'btn primary', text: 'Copiar mensagem', onclick: () => copiar('Entra na nossa conta de despesas: abre https://goncalopedrosapinto.github.io/gpp-dashboard/ , cria conta e em «Em comum» escreve o código ' + cod) })
    ], null);
  } catch (e) { erro(e); }
}
function abrirDivisao() {
  const c = S.casal;
  const pct = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', 'aria-label': 'A tua parte em percentagem', value: String(Number(c.eu.pct)).replace('.', ',') });
  const info = h('div', { class: 'split', 'aria-live': 'polite' });
  const upd = () => { const p = parseNum(pct.value); info.textContent = ok(p) && p >= 0 && p <= 100 ? '% tua · ' + ELA() + ' fica com ' + pctTxt(r2(100 - p)) : '% tua'; };
  pct.addEventListener('input', upd); upd();
  const nome = c.outro && !c.outro.user_id ? h('input', { class: 'ginput', type: 'text', maxlength: '40', 'aria-label': 'Nome dela', value: c.outro.nome }) : null;
  let s;
  s = sheet('Divisão', [pct, info, nome ? group(grow('Nome dela', nome)) : null,
    hint('É a divisão por defeito das novas despesas em comum. As que já existem mantêm a percentagem com que foram registadas.')], async () => {
    const p = parseNum(pct.value);
    if (!ok(p) || p < 0 || p > 100) return s.erro('Escreve uma percentagem entre 0 e 100.', pct);
    await q(sb.rpc('definir_divisao', { p_meu_pct: p, p_nome_outro: nome ? nome.value.trim() : null }));
    await recarregar(); toast('Divisão guardada');
  });
  pct.focus(); pct.select();
}
function abrirAcerto(x, saldo) {
  const c = S.casal, novo = !x;
  const recebiIni = x ? x.para_membro === c.eu.membro_id : saldo > 0;
  const valor = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor do acerto', 'aria-required': 'true', value: x ? toInput(x.valor) : (ok(saldo) ? toInput(Math.abs(saldo)) : '') });
  const dir = escolha([[ELA() + ' pagou-me', 'recebi'], ['Paguei a ' + ELA(), 'paguei']], recebiIni ? 'recebi' : 'paguei', 'Quem pagou a quem');
  const data = h('input', { class: 'ginput', type: 'date', value: x ? x.data : hojeISO(), 'aria-label': 'Data', 'aria-required': 'true' });
  const nota = h('input', { class: 'ginput', type: 'text', maxlength: '120', placeholder: 'Opcional (ex.: MB Way)', 'aria-label': 'Nota', value: x ? (x.nota || '') : '' });
  let s;
  s = sheet(novo ? 'Acertar contas' : 'Editar acerto', [valor, h('div', { class: 'split', text: 'transferido entre vocês' }),
    group(h('div', { class: 'pad' }, dir.el)), group(grow('Data', data), grow('Nota', nota)),
    novo ? null : botaoApagar('Apagar acerto', 'Apagar este acerto?', 'O que cada um deve volta a contar com este valor.', async () => {
      await q(sb.from('acertos').delete().eq('id', x.id)); s.fechar(); await recarregar(); toast('Acerto apagado');
    }, () => s)], async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    if (!data.value) return s.erro('Indica a data.', data);
    const recebi = dir.valor() === 'recebi', eu = c.eu.membro_id, ela = c.outro.membro_id;
    const payload = { casal_id: c.id, de_membro: recebi ? ela : eu, para_membro: recebi ? eu : ela, valor: v, data: data.value, nota: nota.value.trim() || null };
    if (novo) await q(sb.from('acertos').insert(payload)); else await q(sb.from('acertos').update(payload).eq('id', x.id));
    await recarregar(); toast(novo ? 'Acerto registado' : 'Acerto atualizado');
  });
  if (novo) valor.focus();
}

// ===================== Fixas =====================
function linhaFixa(x) {
  return h('button', { type: 'button', class: 'lrow' + (x.ativa ? '' : ' off'), onclick: () => abrirFixa(x) },
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: x.nome }),
      h('div', { class: 'rsub', text: ['Dia ' + x.dia_vencimento, comum(x) ? 'Comum · tua parte ' + fmt(minhaParte(x)) : null,
        x.variavel ? 'Variável' : null, x.debito_direto ? 'Débito direto' : null, x.para_conta_id != null ? 'Transferência' : null,
        x.ativa ? null : 'Pausada'].filter(Boolean).join(' · ') })),
    h('div', { class: 'rval', text: (x.variavel ? '≈ ' : '') + fmt(x.valor) }),
    h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
}
function viewFixas() {
  const ativas = S.fixas.filter(x => x.ativa && x.para_conta_id == null);
  if (!S.fixas.length) return [vazio('Ainda não tens despesas fixas: renda, água, luz, ginásio…', 'Adicionar despesa fixa', () => abrirFixa())];
  const temVar = ativas.some(x => x.variavel) ? '≈ ' : '';
  const out = [glabel('Por mês'), group(
    kv('Total', temVar + fmt(soma(ativas, x => x.valor)), 'strong'),
    ativas.some(comum) ? kv('A tua parte', temVar + fmt(soma(ativas, minhaParte))) : null)];
  const minhas = S.fixas.filter(x => !comum(x)), comuns = S.fixas.filter(comum);
  if (comuns.length) out.push(glabel('Em comum'), lista(comuns.map(linhaFixa)));
  if (minhas.length) out.push(glabel(comuns.length ? 'Só minhas' : 'Despesas fixas'), lista(minhas.map(linhaFixa)));
  out.push(hint('Cada fixa entra todos os meses como «por pagar» no dia certo, e a agenda do iPhone avisa-te na véspera. Se apagares a deste mês, não volta a aparecer.'));
  return out;
}

function linhaCopiar(label, valor, mostrar) {
  return grow(h('span', { class: 'glab', text: label }),
    h('div', { style: 'display:flex;align-items:center;gap:10px;min-width:0' },
      h('span', { class: 'mono', text: mostrar || valor }),
      h('button', { type: 'button', class: 'link b', text: 'Copiar', 'aria-label': 'Copiar ' + label, onclick: () => copiar(valor) })));
}
function viewAjustes() {
  const c = S.config || {};
  const url = SUPABASE_URL + '/rest/v1/rpc/registar_apple_pay';
  const tk = c.token_atalho || '';
  return [
    glabel('Atalho do iPhone · registo automático'),
    group(
      linhaCopiar('URL Wallet', url, 'rpc/registar_apple_pay'),
      linhaCopiar('URL banco', SUPABASE_URL + '/rest/v1/rpc/registar_notificacao', 'rpc/registar_notificacao'),
      linhaCopiar('Chave', SUPABASE_KEY, SUPABASE_KEY.slice(0, 18) + '…'),
      linhaCopiar('Token', tk, tk ? tk.slice(0, 8) + '…' + tk.slice(-4) : '—')
    ),
    hint('As compras que chegam pela Wallet ou pelo banco entram como pagas e só tuas, em «Por rever». Abre-as para pôr a categoria ou passá-las para «em comum». O token é a tua chave pessoal: não o partilhes.'),

    ...blocoFeeds(),

    glabel('Segurança'),
    pinPossivel() ? group(grow('PIN de 4 dígitos', h('button', { type: 'button', class: 'link b', text: 'Mudar PIN', onclick: mudarPin }))) : null,
    hint(pinPossivel() ? 'O PIN fica só neste iPhone. A app pede-o ao abrir e quando voltas a ela depois de 1 minuto fora. 5 tentativas erradas terminam a sessão.' : 'Este navegador não deixa guardar o PIN.'),

    glabel('Conta'),
    group(kv('Sessão', S.user ? S.user.email : '—')),
    h('button', { type: 'button', class: 'btn danger', text: 'Terminar sessão', onclick: async () => { await sb.auth.signOut(); } }),
    hint('GPP Dashboard ' + VERSAO)
  ];
}

// ===================== Folhas de edição =====================
const interruptor = (checked, label) => h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: !!checked, 'aria-label': label });
function validarValor(s, campo) {
  const v = parseNum(campo.value);
  if (!ok(v) || v <= 0) { s.erro('Indica um valor maior que zero.', campo); return null; }
  return v;
}
// Bloco "em comum": quem pagou e a tua parte (%) — devolve os campos para gravar
function blocoComum(x, valorInput, preset) {
  const c = S.casal;
  if (!c) return null;
  const ligado = x ? comum(x) : !!preset.comum;
  const sw = interruptor(ligado, 'Em comum com ' + ELA());
  const quem = escolha([['Eu', 'eu'], [ELA(), 'outro']], x && comum(x) && !pagouEu(x) ? 'outro' : 'eu', 'Quem pagou');
  const pctIni = x && comum(x) ? pctEu(x) : Number(c.eu.pct);
  const pct = h('input', { class: 'ginput num', type: 'text', inputmode: 'decimal', maxlength: '6', 'aria-label': 'A tua parte em percentagem', value: String(pctIni).replace('.', ',') });
  const info = h('div', { class: 'split', 'aria-live': 'polite' });
  const rQuem = h('div', { class: 'pad' }, h('div', { class: 'glab', style: 'margin-bottom:8px', text: 'Quem pagou' }), quem.el);
  const rPct = grow('A tua parte (%)', pct);
  const draw = () => {
    rQuem.hidden = rPct.hidden = !sw.checked;
    const v = parseNum(valorInput.value), p = parseNum(pct.value);
    info.hidden = !(sw.checked && ok(v) && v > 0 && ok(p) && p >= 0 && p <= 100);
    if (!info.hidden) info.textContent = 'Tu ' + fmt(r2(v * p / 100)) + ' · ' + ELA() + ' ' + fmt(r2(v - r2(v * p / 100)));
  };
  [sw, pct, valorInput].forEach(el => el.addEventListener(el === sw ? 'change' : 'input', draw));
  draw();
  return {
    info: info,
    group: group(grow('Em comum com ' + ELA(), sw), rQuem, rPct),
    ler: s => {
      if (!sw.checked) return { casal_id: null, pago_por_membro: null, pct_m1: null };
      const p = parseNum(pct.value);
      if (!ok(p) || p < 0 || p > 100) { s.erro('A tua parte tem de ser entre 0 e 100%.', pct); return null; }
      const euM1 = c.eu.ordem === 1;
      return { casal_id: c.id, pago_por_membro: quem.valor() === 'eu' ? c.eu.membro_id : c.outro.membro_id, pct_m1: euM1 ? p : r2(100 - p) };
    }
  };
}

function abrirDespesa(x, preset) {
  const novo = !x; preset = preset || {};
  const st = { categoria: x ? x.categoria : null };
  const dataDefault = S.mes === mesAtual() ? hojeISO() : S.mes;
  const valor = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor', 'aria-required': 'true',
    value: x ? toInput(x.valor) : (ok(preset.valor) ? toInput(preset.valor) : '') });
  const desc = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', 'aria-label': 'Descrição',
    placeholder: x && x.comerciante ? x.comerciante : 'Ex.: Jantar', value: x ? (x.descricao || '') : '' });
  const data = h('input', { class: 'ginput', type: 'date', value: x ? x.data : dataDefault, 'aria-label': 'Data', 'aria-required': 'true' });
  const swPago = interruptor(x ? (x.pago || preset.marcarPaga) : true, 'Já está paga');
  let tocouPago = !!x;
  swPago.addEventListener('change', () => { tocouPago = true; });
  data.addEventListener('change', () => { if (!tocouPago && data.value) swPago.checked = data.value <= hojeISO(); });
  const bc = blocoComum(x, valor, preset);

  let origem = null;
  if (x && x.origem === 'apple_pay') origem = [fonteTxt(x), x.cartao, x.comerciante].filter(Boolean).join(' · ');
  if (x && x.origem === 'recorrente') origem = x.estimado ? 'Valor estimado pela média das últimas faturas. Escreve o valor real e guarda.' : 'Lançada a partir de uma despesa fixa';
  if (x && S.user && x.owner !== S.user.id) origem = 'Registada por ' + ELA() + (origem ? ' · ' + origem : '');
  const titulo = x ? (x.descricao || x.comerciante || 'Sem descrição') : '';

  let s;
  const conteudo = [
    valor, bc ? bc.info : null,
    origem ? hint(origem, x && x.estimado ? 'center warn' : 'center') : null,
    group(grow('Descrição', desc), grow('Data', data), grow('Já está paga', swPago)),
    bc ? bc.group : null,
    glabel('Categoria', 'h3'),
    group(h('div', { class: 'pad' }, chips(CATEGORIAS, st))),
    x && x.origem === 'apple_pay' && x.comerciante ? h('p', { class: 'hint', style: 'margin-top:-10px', text: 'A categoria fica memorizada para «' + x.comerciante + '».' }) : null,
    novo ? null : botaoApagar('Apagar despesa', 'Apagar esta despesa?', '«' + titulo + '» · ' + fmt(x.valor) + (comum(x) ? '. Desaparece também para ' + ELA() : '') + '. Não dá para desfazer.', async () => {
      await q(sb.from('despesas').delete().eq('id', x.id));
      s.fechar(); await recarregar(); toast('Despesa apagada');
    }, () => s)
  ];
  const tit = preset.marcarPaga ? 'Confirmar e pagar' : novo ? (preset.comum ? 'Nova despesa em comum' : 'Nova despesa') : x.estimado ? 'Confirmar fatura' : 'Editar despesa';
  s = sheet(tit, conteudo, async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    if (!data.value) return s.erro('Indica a data.', data);
    const cc = bc ? bc.ler(s) : { casal_id: x ? x.casal_id : null }; if (!cc) return false;
    const payload = Object.assign({ valor: v, descricao: desc.value.trim() || null, data: data.value, categoria: st.categoria, pago: swPago.checked, estimado: false }, cc);
    if (novo) await q(sb.from('despesas').insert(payload));
    else await q(sb.from('despesas').update(payload).eq('id', x.id));
    const mesD = payload.data.slice(0, 8) + '01';
    if (x && x.estimado) await carregarFixas();
    await recarregar();
    toast(x && x.estimado ? 'Valor confirmado' + (payload.pago ? ' · paga' : '') : mesD === S.mes ? 'Guardado' : 'Guardado em ' + nomeMes(mesD));
  });
  if (novo && !ok(preset.valor)) valor.focus();
  else if (x && x.estimado) { valor.focus(); valor.select(); }
}

function abrirFixa(x) {
  const novo = !x;
  const st = { categoria: x ? x.categoria : null, ativa: x ? !!x.ativa : true };
  const valor = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor mensal', 'aria-required': 'true', value: x ? toInput(x.valor) : '' });
  const nome = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', placeholder: 'Ex.: Renda', 'aria-label': 'Nome', 'aria-required': 'true', value: x ? x.nome : '' });
  const dia = h('input', { class: 'ginput num', type: 'text', inputmode: 'numeric', placeholder: '1 a 31', 'aria-label': 'Dia do pagamento', 'aria-required': 'true', value: x ? String(x.dia_vencimento) : '' });
  const swDeb = interruptor(x ? x.debito_direto : false, 'Débito direto');
  const swVar = interruptor(x ? x.variavel : false, 'Valor variável');
  const splitMes = h('div', { class: 'split', text: 'por mês' });
  const rDia = grow('Dia do pagamento', dia);
  const drawDeb = () => { const t = swDeb.checked ? 'Dia do débito' : 'Dia do pagamento'; rDia.firstChild.textContent = t; dia.setAttribute('aria-label', t); };
  const drawVar = () => { splitMes.textContent = swVar.checked ? 'estimativa por mês' : 'por mês'; valor.setAttribute('aria-label', swVar.checked ? 'Valor estimado por mês' : 'Valor mensal'); };
  swDeb.addEventListener('change', drawDeb); swVar.addEventListener('change', drawVar); drawDeb(); drawVar();
  const bc = blocoComum(x, valor, {});
  const swAtiva = interruptor(st.ativa, 'Ativa');
  swAtiva.addEventListener('change', () => { st.ativa = swAtiva.checked; });
  let s;
  const conteudo = [
    valor, bc ? bc.info : null, splitMes,
    group(grow('Nome', nome), rDia, grow('Débito direto', swDeb), grow('Valor variável', swVar)),
    hint('Entra todos os meses como «por pagar» e a agenda do iPhone avisa-te na véspera. Com valor variável (água, luz) entra com uma estimativa até escreveres o valor da fatura.'),
    bc ? bc.group : null,
    glabel('Categoria', 'h3'), group(h('div', { class: 'pad' }, chips(CATEGORIAS, st))),
    novo ? null : group(grow('Ativa', swAtiva)),
    novo ? null : botaoApagar('Apagar despesa fixa', 'Apagar «' + x.nome + '»?', 'Deixa de entrar nos próximos meses. Os meses já lançados mantêm-se.', async () => {
      await q(sb.from('despesas_recorrentes').delete().eq('id', x.id));
      s.fechar(); await carregarFixas(); await recarregar(); toast('Fixa apagada');
    }, () => s)
  ];
  s = sheet(novo ? 'Nova fixa' : 'Editar fixa', conteudo, async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    const n = nome.value.trim();
    if (!n) return s.erro('Dá um nome à despesa.', nome);
    const d = parseInt(dia.value, 10);
    if (!(d >= 1 && d <= 31)) return s.erro('O dia tem de ser entre 1 e 31.', dia);
    const cc = bc ? bc.ler(s) : { casal_id: x ? x.casal_id : null }; if (!cc) return false;
    const m = mesAtual(), dataMes = m.slice(0, 8) + pad2(Math.min(d, ultimoDia(m)));
    const payload = Object.assign({ nome: n, valor: v, dia_vencimento: d, categoria: st.categoria, ativa: st.ativa, debito_direto: swDeb.checked, variavel: swVar.checked }, cc);
    if (novo) await q(sb.from('despesas_recorrentes').insert(payload));
    else {
      await q(sb.from('despesas_recorrentes').update(payload).eq('id', x.id));
      // o lançamento deste mês, se ainda estiver por pagar, acompanha a fixa
      const atual = Object.assign({ descricao: n, categoria: st.categoria, data: dataMes }, cc);
      if (!payload.variavel) { atual.valor = v; atual.estimado = false; }
      await q(sb.from('despesas').update(atual).eq('recorrente_id', x.id).eq('mes', m).eq('pago', false));
      if (payload.variavel) await q(sb.from('despesas').update({ valor: v }).eq('recorrente_id', x.id).eq('mes', m).eq('estimado', true).eq('pago', false));
    }
    await q(sb.rpc('gerar_recorrentes', { p_mes: m }));
    await carregarFixas();
    await recarregar();
    toast(novo ? 'Fixa criada · já está em «Por pagar»' : 'Fixa atualizada');
  });
  if (novo) valor.focus();
}

// ===================== Agenda =====================
const AGENDAS = ['pessoal', 'trabalho', 'bia', 'outro'];
const nomeAg = a => (a === 'bia' ? ELA() : a === 'pag' ? 'Pagamentos' : ({ pessoal: 'Pessoal', trabalho: 'Trabalho', outro: 'Outro' })[a] || a);
const REPETE = [['Não repete', 'nunca'], ['Semanal', 'semanal'], ['Mensal', 'mensal'], ['Anual', 'anual']];
const ALERTAS = [['Sem alerta', null], ['Na hora', 0], ['15 min antes', 15], ['1 h antes', 60], ['1 dia antes', 1440]];
const hhmm = t => (t ? String(t).slice(0, 5) : '');
const horario = ev => (ev.dia_inteiro || !ev.hora_inicio ? 'Todo o dia' : hhmm(ev.hora_inicio) + (ev.hora_fim ? '–' + hhmm(ev.hora_fim) : ''));
const FEED = SUPABASE_URL.replace('https://', '') + '/functions/v1/calendario';

// Repetições: as mesmas regras do RRULE do feed (dias que não existem no mês são saltados)
function comecaEm(ev, iso) {
  if (ev.data === iso) return true;
  if (iso < ev.data || ev.repete === 'nunca') return false;
  const [y1, m1, d1] = ev.data.split('-').map(Number), [y2, m2, d2] = iso.split('-').map(Number);
  if (ev.repete === 'semanal') return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) % 7 === 0;
  if (ev.repete === 'mensal') return d1 === d2;
  if (ev.repete === 'anual') return d1 === d2 && m1 === m2;
  return false;
}
const duracao = ev => (ev.data_fim && ev.data_fim > ev.data ? diasEntre(ev.data, ev.data_fim) : 0);
// Dia k (0 = primeiro) da ocorrência do evento que cobre iso, ou -1
function posicaoEm(ev, iso) {
  const dur = duracao(ev);
  for (let k = 0; k <= dur; k++) if (comecaEm(ev, somaDias(iso, -k))) return k;
  return -1;
}
function itensDoMes(m) {
  const res = {}, ud = ultimoDia(m);
  const add = (iso, it) => { (res[iso] = res[iso] || []).push(it); };
  for (let d = 1; d <= ud; d++) {
    const iso = m.slice(0, 8) + pad2(d);
    S.eventos.forEach(ev => { const k = posicaoEm(ev, iso); if (k >= 0) add(iso, { tipo: 'evento', agenda: ev.agenda, ev: ev, k: k, dur: duracao(ev) }); });
  }
  S.fixas.filter(f => f.ativa && f.para_conta_id == null).forEach(f => {
    const iso = m.slice(0, 8) + pad2(Math.min(f.dia_vencimento, ud));
    const lanc = S.despesas.find(d => d.recorrente_id === f.id);
    if (iso >= f.inicio && (!f.fim || iso <= f.fim)) add(iso, { tipo: 'pagamento', agenda: 'pag', f: f, paga: !!(lanc && lanc.pago) });
  });
  return res;
}
const chaveOrdem = it => (it.tipo === 'pagamento' ? '0' : it.ev.dia_inteiro || !it.ev.hora_inicio || it.k > 0 ? '1' : '2' + it.ev.hora_inicio);
// Horário de um evento num dos seus dias (vários dias: começa / dia n de N / termina)
function horarioDia(ev, k, dur) {
  if (!dur) return horario(ev);
  const parte = 'Dia ' + (k + 1) + ' de ' + (dur + 1);
  if (ev.dia_inteiro || !ev.hora_inicio || (k > 0 && k < dur)) return 'Todo o dia · ' + parte;
  if (k === 0) return 'Começa às ' + hhmm(ev.hora_inicio) + ' · ' + parte;
  return (ev.hora_fim ? 'Termina às ' + hhmm(ev.hora_fim) : 'Último dia') + ' · ' + parte;
}

function linhaItemAgenda(it) {
  if (it.tipo === 'pagamento') {
    const f = it.f;
    return h('button', { type: 'button', class: 'lrow', onclick: () => abrirFixa(f) },
      h('span', { class: 'barra ag-pag', 'aria-hidden': 'true' }),
      h('div', { class: 'rmain' },
        h('div', { class: 'rtitle', text: (f.debito_direto ? 'Débito direto: ' : 'Pagar ') + f.nome }),
        h('div', { class: 'rsub', text: [it.paga ? 'Paga ✓' : f.debito_direto ? 'Sai sozinho' : 'Por pagar', comum(f) ? 'Comum · tua parte ' + fmt(minhaParte(f)) : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'rval', text: (f.variavel ? '≈ ' : '') + fmt(f.valor) }),
      h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
  }
  const ev = it.ev;
  return h('button', { type: 'button', class: 'lrow', onclick: () => abrirEvento(ev) },
    h('span', { class: 'barra ag-' + ev.agenda, 'aria-hidden': 'true' }),
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: ev.titulo }),
      h('div', { class: 'rsub', text: [horarioDia(ev, it.k || 0, it.dur || 0), ev.local, nomeAg(ev.agenda), ev.repete !== 'nunca' ? REPETE.find(r => r[1] === ev.repete)[0] : null].filter(Boolean).join(' · ') })),
    h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
}

function viewAgenda() {
  const m = S.mes, [y, mo] = m.split('-').map(Number), ud = ultimoDia(m);
  if (!S.diaSel || S.diaSel.slice(0, 7) !== m.slice(0, 7)) S.diaSel = m === mesAtual() ? hojeISO() : m;
  const porDia = itensDoMes(m);
  const vazios = (new Date(y, mo - 1, 1).getDay() + 6) % 7; // semana começa à segunda
  const grid = h('div', { class: 'cal', role: 'group', 'aria-label': 'Dias de ' + mesMin(m) },
    ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'].map(d => h('div', { class: 'cal-dow', 'aria-hidden': 'true', text: d })),
    Array.from({ length: vazios }, () => h('div', { 'aria-hidden': 'true' })),
    Array.from({ length: ud }, (_, i) => {
      const iso = m.slice(0, 8) + pad2(i + 1), itens = porDia[iso] || [];
      const cores = itens.map(it => it.agenda).filter((a, k, arr) => arr.indexOf(a) === k).slice(0, 3);
      return h('button', {
        type: 'button', class: 'cal-dia' + (iso === hojeISO() ? ' hoje' : ''), 'aria-pressed': String(iso === S.diaSel),
        'aria-label': diaLongo(iso) + (itens.length ? ', ' + itens.length + (itens.length === 1 ? ' item' : ' itens') : ''),
        onclick: () => { S.diaSel = iso; render(); const b = document.querySelector('.cal-dia[aria-pressed="true"]'); if (b) b.focus(); }
      }, h('span', { class: 'cal-num', text: String(i + 1) }),
        h('span', { class: 'cal-pontos', 'aria-hidden': 'true' }, cores.map(c => h('i', { class: 'dot ag-' + c }))));
    }));
  const legenda = h('div', { class: 'legenda', 'aria-hidden': 'true' },
    AGENDAS.concat(['pag']).map(a => h('span', null, h('i', { class: 'dot ag-' + a }), nomeAg(a))));
  const itens = (porDia[S.diaSel] || []).slice().sort((a, b) => (chaveOrdem(a) < chaveOrdem(b) ? -1 : 1));
  const out = [group(h('div', { class: 'cal-wrap' }, grid)), legenda, glabel(diaLongo(S.diaSel))];
  if (S.loading && !S.eventos.length) out.push(...carregando());
  else if (!itens.length) out.push(vazio('Nada marcado para este dia.', 'Novo evento', () => abrirEvento(null, S.diaSel)));
  else out.push(lista(itens.map(linhaItemAgenda)));
  return out;
}

// Escolha única em chips (aria-pressed)
function escolha(opcoes, atual, rotulo, comPonto, aoMudar) {
  let valor = atual;
  const box = h('div', { class: 'chips', role: 'group', 'aria-label': rotulo });
  const btns = opcoes.map(([label, v]) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(v === valor),
    onclick: () => { valor = v; btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opcoes[i][1] === valor))); if (aoMudar) aoMudar(valor); }
  }, comPonto ? h('i', { class: 'dot ag-' + v, 'aria-hidden': 'true' }) : null, label));
  box.append(...btns);
  return { el: box, valor: () => valor };
}

function abrirEvento(ev, dataPreset) {
  const novo = !ev;
  const titulo = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', maxlength: '120', placeholder: 'Ex.: Jantar com a ' + ELA(), 'aria-label': 'Título', 'aria-required': 'true', value: ev ? ev.titulo : '', style: 'text-align:left' });
  const data = h('input', { class: 'ginput', type: 'date', value: ev ? ev.data : (dataPreset || hojeISO()), 'aria-label': 'Data', 'aria-required': 'true' });
  const dataFim = h('input', { class: 'ginput', type: 'date', value: ev ? (ev.data_fim || ev.data) : data.value, 'aria-label': 'Data de fim', 'aria-required': 'true' });
  // mudar o início arrasta o fim (mantém a duração), como no Calendário do iPhone
  let dataAnt = data.value;
  const arrastar = () => {
    if (data.value && dataAnt && dataFim.value && data.value !== dataAnt) dataFim.value = somaDias(data.value, Math.max(0, diasEntre(dataAnt, dataFim.value)));
    if (data.value) dataAnt = data.value;
  };
  data.addEventListener('input', arrastar); data.addEventListener('change', arrastar);
  const swDia = interruptor(ev ? ev.dia_inteiro : false, 'Todo o dia');
  const ini = h('input', { class: 'ginput', type: 'time', value: ev ? hhmm(ev.hora_inicio) : '', 'aria-label': 'Início' });
  const fim = h('input', { class: 'ginput', type: 'time', value: ev ? hhmm(ev.hora_fim) : '', 'aria-label': 'Fim' });
  const rIni = grow('Começa', h('div', { class: 'inline datahora' }, data, ini)), rFim = grow('Termina', h('div', { class: 'inline datahora' }, dataFim, fim));
  const drawDia = () => { ini.hidden = fim.hidden = swDia.checked; };
  swDia.addEventListener('change', drawDia); drawDia();
  const agenda = escolha(AGENDAS.map(a => [nomeAg(a), a]), ev ? ev.agenda : 'pessoal', 'Agenda', true);
  const repete = escolha(REPETE, ev ? ev.repete : 'nunca', 'Repetição');
  const alerta = escolha(ALERTAS, ev ? ev.alerta_min : 15, 'Alerta');
  const local = h('input', { class: 'ginput', type: 'text', maxlength: '200', placeholder: 'Opcional', 'aria-label': 'Local', value: ev ? (ev.local || '') : '' });
  const notas = h('input', { class: 'ginput', type: 'text', maxlength: '2000', placeholder: 'Opcional', 'aria-label': 'Notas', value: ev ? (ev.notas || '') : '' });
  let s;
  s = sheet(novo ? 'Novo evento' : 'Editar evento', [
    group(h('div', { class: 'pad' }, titulo)),
    glabel('Agenda', 'h3'), group(h('div', { class: 'pad' }, agenda.el)),
    group(grow('Todo o dia', swDia), rIni, rFim),
    glabel('Repetição', 'h3'), group(h('div', { class: 'pad' }, repete.el)),
    glabel('Alerta no iPhone', 'h3'), group(h('div', { class: 'pad' }, alerta.el)),
    group(grow('Local', local), grow('Notas', notas)),
    novo ? null : botaoApagar('Apagar evento', 'Apagar «' + ev.titulo + '»?', ev.repete !== 'nunca' ? 'Apaga todas as repetições. Não dá para desfazer.' : 'Não dá para desfazer.', async () => {
      await q(sb.from('eventos').delete().eq('id', ev.id));
      s.fechar(); await recarregar(); toast('Evento apagado');
    }, () => s)
  ], async () => {
    const t = titulo.value.trim();
    if (!t) return s.erro('Dá um título ao evento.', titulo);
    if (!data.value) return s.erro('Indica a data.', data);
    const df = dataFim.value || data.value;
    if (df < data.value) return s.erro('O fim tem de ser no próprio dia ou depois do início.', dataFim);
    if (diasEntre(data.value, df) > 366) return s.erro('Um evento pode durar no máximo um ano.', dataFim);
    const varios = df > data.value;
    const dia = swDia.checked;
    if (!dia && !ini.value) return s.erro('Indica a hora de início ou marca «Todo o dia».', ini);
    if (!dia && !varios && fim.value && fim.value <= ini.value) return s.erro('O fim tem de ser depois do início.', fim);
    if (!dia && varios && !fim.value) return s.erro('Indica a hora a que termina.', fim);
    const payload = {
      titulo: t, agenda: agenda.valor(), data: data.value, data_fim: df, dia_inteiro: dia,
      hora_inicio: dia ? null : ini.value, hora_fim: dia ? null : (fim.value || null),
      repete: repete.valor(), alerta_min: alerta.valor(),
      local: local.value.trim() || null, notas: notas.value.trim() || null
    };
    if (novo) await q(sb.from('eventos').insert(payload));
    else await q(sb.from('eventos').update(payload).eq('id', ev.id));
    S.diaSel = payload.data;
    const mesE = payload.data.slice(0, 8) + '01';
    if (mesE !== S.mes) S.mes = mesE;
    await recarregar();
    toast('Evento guardado');
  });
  if (novo) titulo.focus();
}

function blocoFeeds() {
  const tk = (S.config && S.config.token_calendario) || '';
  const url = a => FEED + '?t=' + tk + (a ? '&a=' + a : '');
  const linhas = AGENDAS.concat(['pagamentos']).map(a => {
    const nome = nomeAg(a === 'pagamentos' ? 'pag' : a);
    return grow(h('span', { class: 'glab' }, h('i', { class: 'dot ag-' + (a === 'pagamentos' ? 'pag' : a), 'aria-hidden': 'true' }), ' ' + nome),
      h('div', { class: 'inline' },
        h('button', { type: 'button', class: 'link small2', text: 'Copiar', 'aria-label': 'Copiar link ' + nome, onclick: () => copiar('https://' + url(a)) }),
        h('a', { class: 'link b', href: 'webcal://' + url(a), text: 'Subscrever', 'aria-label': 'Subscrever ' + nome + ' no iPhone' })));
  });
  return [
    glabel('Agenda no iPhone'),
    group(linhas),
    hint('Toca em Subscrever em cada agenda que queres ver no Calendário do iPhone e confirma: cada uma fica com a sua cor. Depois, em Definições › Calendário › Contas › Calendários subscritos, abre cada uma e desliga «Remover alertas». O iPhone atualiza estes calendários sozinho (até 1 hora de atraso).'),
    botaoApagar('Gerar links novos', 'Gerar links novos?', 'Os links atuais deixam de funcionar. Tens de voltar a subscrever no iPhone.', async () => {
      const novo = await q(sb.rpc('renovar_token_calendario'));
      S.config.token_calendario = novo;
      render(); toast('Links renovados · volta a subscrever no iPhone');
    }, () => ({ erro: m => toast(m, true) }))
  ];
}

// ===================== Estrutura =====================
function mesNav() {
  const max = addMes(mesAtual(), 1);
  return h('div', { class: 'mesnav' },
    h('button', { class: 'navbtn', type: 'button', 'aria-label': 'Mês anterior', text: '‹', onclick: () => mudarMes(-1) }),
    h('span', { class: 'mesnome', text: nomeMes(S.mes) }),
    h('button', { class: 'navbtn', type: 'button', 'aria-label': 'Mês seguinte', text: '›', disabled: S.mes >= max, onclick: () => mudarMes(1) }),
    S.mes !== mesAtual() ? h('button', { class: 'link small', type: 'button', text: 'Este mês', onclick: () => { S.mes = mesAtual(); S.despesas = []; render(); recarregar(); } }) : null);
}
async function mudarMes(n) {
  S.mes = addMes(S.mes, n);
  S.despesas = [];
  render();
  await recarregar();
}
function irPara(t) {
  if ((t === 'fixas' || t === 'ajustes') && TABS.includes(S.tab)) S.voltar = S.tab;
  S.tab = t;
  window.scrollTo(0, 0);
  render();
  if (t === 'fixas') carregarFixas().then(render);
}
function render() {
  if (!S.user || S.bloqueado) return;
  const views = { pagar: viewPagar, despesas: viewDespesas, comum: viewComum, agenda: viewAgenda, fixas: viewFixas, ajustes: viewAjustes };
  const acoes = { pagar: () => abrirDespesa(), despesas: () => abrirDespesa(), comum: S.casal ? () => abrirDespesa(null, { comum: true }) : null, agenda: () => abrirEvento(null, S.diaSel), fixas: () => abrirFixa() };
  const rotulos = { pagar: 'Nova despesa', despesas: 'Nova despesa', comum: 'Nova despesa em comum', agenda: 'Novo evento', fixas: 'Nova despesa fixa' };
  const botoes = h('div', { class: 'acts' },
    S.tab === 'pagar' ? h('button', { class: 'gearbtn', type: 'button', 'aria-label': 'Ajustes', onclick: () => irPara('ajustes') }, icon(ICONS.ajustes)) : null,
    S.tab === 'despesas' || S.tab === 'pagar' ? h('button', { class: 'gearbtn', type: 'button', 'aria-label': 'Despesas fixas', onclick: () => irPara('fixas') }, icon(ICONS.fixas)) : null,
    S.tab === 'ajustes' ? h('button', { class: 'link b', type: 'button', text: 'Fechar', onclick: () => irPara(S.voltar || 'pagar') }) : null,
    S.tab === 'fixas' ? h('button', { class: 'link b', type: 'button', text: 'Fechar', onclick: () => irPara(S.voltar || 'pagar') }) : null,
    acoes[S.tab] ? h('button', { class: 'addbtn', type: 'button', text: '+', 'aria-label': rotulos[S.tab], onclick: acoes[S.tab] }) : null);
  const header = h('header', { class: 'top' },
    h('div', { class: 'toprow' }, h('h1', { text: TITULOS[S.tab] }), botoes),
    (S.tab === 'pagar' || S.tab === 'despesas' || S.tab === 'comum' || S.tab === 'agenda') ? mesNav() : null);
  const main = h('main', { 'aria-busy': S.loading ? 'true' : 'false' }, views[S.tab]());
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Separadores' }, TABS.map(t => h('button', {
    type: 'button', class: 'tab' + (S.tab === t ? ' on' : ''), 'aria-current': S.tab === t ? 'page' : null, onclick: () => irPara(t)
  }, icon(ICONS[t]), h('span', { text: TITULOS[t] }))));
  app.replaceChildren(header, main, tabbar);
}


// ===================== PIN (bloqueio do ecrã) =====================
// O PIN fica só neste dispositivo (PBKDF2 com sal, nunca sai do iPhone). Não substitui o login:
// 5 tentativas erradas terminam a sessão e obrigam a entrar com email e palavra-passe.
const PIN = { chave: 'gpp.pin.v1', falhas: 'gpp.pin.falhas', max: 5, foraMs: 60000 };
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } };
const lsDel = k => { try { localStorage.removeItem(k); } catch (e) { /* sem armazenamento */ } };
const b64 = buf => btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
async function hashPin(pin, sal) {
  const salt = Uint8Array.from(atob(sal), c => c.charCodeAt(0));
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' }, k, 256));
}
const pinPossivel = () => !!(window.crypto && crypto.subtle && lsSet('gpp.teste', '1'));
function pinDe(uid) { try { const p = JSON.parse(lsGet(PIN.chave) || 'null'); return p && p.user === uid ? p : null; } catch (e) { return null; } }
async function gravarPin(uid, pin) {
  const sal = b64(crypto.getRandomValues(new Uint8Array(16)));
  lsSet(PIN.chave, JSON.stringify({ user: uid, sal: sal, hash: await hashPin(pin, sal) }));
  lsDel(PIN.falhas);
}
const pinObvio = p => /^(\d)\1{3}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p);
let teclasPin = null;

// modo: 'criar' (pede 2x) · 'abrir' · 'atual' (antes de mudar o PIN)
function ecraPin(modo, uid, aoAcabar, aoCancelar) {
  document.querySelectorAll('dialog').forEach(d => d.remove());
  document.body.classList.remove('noscroll');
  if (teclasPin) document.removeEventListener('keydown', teclasPin);
  let digitos = '', primeiro = null, ocupado = false;
  const titulo = h('h1', { id: 'pin-t' });
  const sub = h('p', { class: 'pin-sub' });
  const pontos = h('div', { class: 'pin-pontos', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('i')));
  const estado = h('p', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  const msg = h('p', { class: 'pin-erro', role: 'alert' });
  const sair = fn => () => { document.removeEventListener('keydown', teclasPin); teclasPin = null; fn(); };
  const textos = () => {
    if (modo === 'criar') {
      titulo.textContent = primeiro ? 'Confirma o PIN' : 'Cria um PIN';
      sub.textContent = primeiro ? 'Escreve o mesmo PIN outra vez.' : '4 dígitos para abrir a app neste iPhone. Não uses o PIN do cartão.';
    } else {
      titulo.textContent = modo === 'atual' ? 'PIN atual' : 'GPP Dashboard';
      sub.textContent = modo === 'atual' ? 'Escreve o PIN atual para o mudares.' : 'Escreve o teu PIN.';
    }
  };
  const desenhar = () => {
    [...pontos.children].forEach((p, i) => p.classList.toggle('on', i < digitos.length));
    estado.textContent = digitos.length + ' de 4 dígitos';
  };
  const falhou = t => { msg.textContent = t; pontos.classList.add('erro'); digitos = ''; desenhar(); };
  async function completo() {
    ocupado = true;
    try {
      if (modo === 'criar') {
        if (!primeiro) {
          if (pinObvio(digitos)) return falhou('PIN demasiado óbvio. Escolhe outro.');
          primeiro = digitos; digitos = ''; msg.textContent = ''; pontos.classList.remove('erro'); textos(); desenhar(); return;
        }
        if (digitos !== primeiro) { primeiro = null; textos(); return falhou('Os PINs não coincidem. Começa de novo.'); }
        await gravarPin(uid, digitos);
        return sair(aoAcabar)();
      }
      const p = pinDe(uid);
      if (p && await hashPin(digitos, p.sal) === p.hash) { lsDel(PIN.falhas); return sair(aoAcabar)(); }
      const n = (parseInt(lsGet(PIN.falhas) || '0', 10) || 0) + 1;
      if (!p || n >= PIN.max) {
        lsDel(PIN.falhas); lsDel(PIN.chave);
        S.avisoLogin = 'Demasiadas tentativas erradas. Entra com o email e a palavra-passe e cria um PIN novo.';
        document.removeEventListener('keydown', teclasPin); teclasPin = null;
        await sb.auth.signOut();
        return;
      }
      lsSet(PIN.falhas, String(n));
      const resta = PIN.max - n;
      falhou('PIN errado. ' + (resta === 1 ? 'Última tentativa antes de terminar a sessão.' : 'Faltam ' + resta + ' tentativas.'));
    } finally { ocupado = false; }
  }
  const premir = n => {
    if (ocupado || digitos.length >= 4) return;
    if (!digitos) pontos.classList.remove('erro');
    digitos += n; desenhar();
    if (digitos.length === 4) completo();
  };
  const apagar = () => { if (!ocupado) { digitos = digitos.slice(0, -1); desenhar(); } };
  const tecla = (t, fn, cls, aria) => h('button', { type: 'button', class: 'pin-tecla' + (cls ? ' ' + cls : ''), text: t, 'aria-label': aria || null, onclick: fn });
  const teclado = h('div', { class: 'pin-teclado' },
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(n => tecla(n, () => premir(n))),
    aoCancelar ? tecla('Cancelar', sair(aoCancelar), 'txt') : h('span', { 'aria-hidden': 'true' }),
    tecla('0', () => premir('0')),
    tecla('⌫', apagar, 'txt', 'Apagar dígito'));
  teclasPin = e => {
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); premir(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); apagar(); }
  };
  document.addEventListener('keydown', teclasPin);
  const esqueci = () => {
    lsDel(PIN.chave); lsDel(PIN.falhas);
    S.avisoLogin = 'Entra com o email e a palavra-passe para criares um PIN novo.';
    document.removeEventListener('keydown', teclasPin); teclasPin = null;
    sb.auth.signOut();
  };
  textos(); desenhar();
  app.replaceChildren(h('main', { class: 'pin', 'aria-labelledby': 'pin-t' },
    titulo, sub, pontos, estado, msg, teclado,
    modo !== 'criar' ? h('button', { type: 'button', class: 'link b', text: 'Esqueci-me do PIN', onclick: esqueci }) : null));
}
// Tranca a app (ao abrir ou ao voltar depois de PIN.foraMs fora)
function bloquear() {
  if (!S.user || !pinDe(S.user.id)) return false;
  S.bloqueado = true;
  ecraPin('abrir', S.user.id, () => { S.bloqueado = false; render(); recarregar(); });
  return true;
}
function mudarPin() {
  const uid = S.user.id, voltar = () => { S.bloqueado = false; render(); };
  S.bloqueado = true;   // um carregamento por trás não tapa o ecrã do PIN
  const criar = () => ecraPin('criar', uid, () => { voltar(); toast('PIN alterado'); }, voltar);
  if (pinDe(uid)) ecraPin('atual', uid, criar, voltar); else criar();
}

function renderLogin(criar) {
  document.querySelectorAll('dialog').forEach(d => d.remove());
  document.body.classList.remove('noscroll');
  const email = h('input', { class: 'lfield', type: 'email', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'next', placeholder: 'Email', 'aria-label': 'Email', required: true });
  const pass = h('input', { class: 'lfield', type: 'password', autocomplete: criar ? 'new-password' : 'current-password', enterkeyhint: 'go', placeholder: criar ? 'Palavra-passe (mín. 8)' : 'Palavra-passe', 'aria-label': 'Palavra-passe', required: true });
  const lerr = h('p', { class: 'lerr', id: 'login-erro', role: 'alert', hidden: !S.avisoLogin, text: S.avisoLogin || '' });
  S.avisoLogin = null;
  const btn = h('button', { class: 'btn primary', type: 'submit', text: criar ? 'Criar conta' : 'Entrar' });
  const trocar = h('button', { class: 'link b', type: 'button', text: criar ? 'Já tenho conta · Entrar' : 'Ainda não tens conta? Criar conta', onclick: () => renderLogin(!criar) });
  const form = h('form', { class: 'login', 'aria-labelledby': 'login-t' },
    h('div', { class: 'logo', 'aria-hidden': 'true', text: 'GPP' }), h('h1', { id: 'login-t', text: criar ? 'Criar conta' : 'GPP Dashboard' }),
    h('p', { text: criar ? 'Para registares despesas e partilhares as da casa.' : 'As tuas despesas e as da casa, e o que falta pagar.' }),
    email, pass, lerr, btn, trocar);
  const limpar = () => { lerr.hidden = true; [email, pass].forEach(i => { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }); };
  const falha = (msg, campos) => {
    lerr.textContent = msg; lerr.hidden = false;
    campos.forEach(i => { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'login-erro'); });
    campos[campos.length - 1].focus();
  };
  form.addEventListener('input', limpar);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    limpar();
    if (criar && pass.value.length < 8) return falha('A palavra-passe tem de ter pelo menos 8 caracteres.', [pass]);
    btn.disabled = true; btn.textContent = criar ? 'A criar…' : 'A entrar…';
    const r = criar ? await sb.auth.signUp({ email: email.value.trim(), password: pass.value })
                    : await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    btn.disabled = false; btn.textContent = criar ? 'Criar conta' : 'Entrar';
    if (r.error) { console.error(r.error); return falha(traduzErro(r.error), [email, pass]); }
    if (criar && !(r.data && r.data.session)) {
      S.avisoLogin = 'Conta criada. Abre o email de confirmação que te enviámos e depois entra aqui.';
      return renderLogin(false);
    }
    const u = r.data.user;
    if (pinPossivel() && !pinDe(u.id)) ecraPin('criar', u.id, () => entrar(u));
    else await entrar(u);
  });
  app.replaceChildren(h('main', null, form));
}

async function entrar(user) {
  S.user = user;
  S.mes = mesAtual();
  S.tab = 'pagar';
  S.despesas = []; S.casal = null;
  app.replaceChildren(h('main', { 'aria-busy': 'true' }, carregando()));
  try { S.config = await q(sb.rpc('garantir_config')); }
  catch (e) { erro(e); S.config = {}; }
  render();
  await Promise.all([carregarMes(), carregarFixas()]);
  render();
}

sb.auth.onAuthStateChange(ev => {
  if (ev === 'SIGNED_OUT') {
    S.user = null; S.config = null; S.despesas = []; S.atrasados = []; S.fixas = []; S.eventos = []; S.acertos = []; S.casal = null; S.diaSel = null;
    S.bloqueado = false;
    setTimeout(() => renderLogin(false), 0);
  }
});

// Valores: ao sair do campo mostra o número como a app o leu (12.500 → 12500,00); inválido fica marcado
document.addEventListener('focusout', e => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.inputMode !== 'decimal' || !el.value.trim()) return;
  const n = parseNum(el.value);
  if (ok(n)) { if (el.value !== toInput(n)) el.value = toInput(n); if (el.getAttribute('aria-invalid') === 'true' && !el.hasAttribute('aria-describedby')) el.removeAttribute('aria-invalid'); }
  else el.setAttribute('aria-invalid', 'true');
});

// Ao voltar à app (ex.: depois de pagar com Apple Pay), atualiza
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { S.saiuEm = Date.now(); document.body.classList.add('privado'); return; }
  document.body.classList.remove('privado');
  if (!S.user || S.bloqueado) return;
  if (S.saiuEm && Date.now() - S.saiuEm >= PIN.foraMs && bloquear()) return;
  if (S.mes) recarregar();
});

(async function init() {
  try {
    const r = await sb.auth.getSession();
    const session = r.data && r.data.session;
    if (!session) return renderLogin();
    const u = session.user;
    if (!pinPossivel()) return entrar(u);
    if (pinDe(u.id)) { S.bloqueado = true; ecraPin('abrir', u.id, () => { S.bloqueado = false; entrar(u); }); }
    else ecraPin('criar', u.id, () => entrar(u));
  } catch (e) { erro(e); renderLogin(); }
})();
})();
