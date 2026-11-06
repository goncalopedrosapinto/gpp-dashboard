(function () {
'use strict';

// ===================== Configuração =====================
const SUPABASE_URL = 'https://klmjdjhvsxvopctgmhyu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_L3QfJtwa_wYBCsHN4uzgXQ_rcp52nL8';
const VERSAO = 'v1.5 · nov 2026';
const CATEGORIAS = ['Casa', 'Supermercado', 'Restauração', 'Transportes', 'Saúde', 'Lazer', 'Compras', 'Subscrições', 'Outros'];
const CAT_GANHOS = ['Salário', 'Comissões', 'Prémios', 'Outros'];
const TITULOS = { mes: 'Resumo', despesas: 'Gastos', ganhos: 'Ganhos', agenda: 'Agenda', calcular: 'Calcular', fixas: 'Fixas', ajustes: 'Ajustes' };
const TABS = ['mes', 'despesas', 'ganhos', 'agenda', 'calcular'];

const app = document.getElementById('app');
if (!window.supabase || !window.supabase.createClient) {
  app.textContent = 'Não foi possível carregar a ligação ao servidor. Verifica a internet e abre outra vez.';
  return;
}
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'gpp-dashboard-auth' }
});

const S = {
  user: null, config: null, tab: 'mes', mes: null, filtro: 'todas', loading: false, seq: 0,
  despesas: [], ganhos: [], aReceber: [], proximos: [], fixas: [], contas: [], eventos: [], diaSel: null,
  calc: { init: false, eu: '', ela: '', valor: '' }
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
  return el;
}
function append(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) { kid.forEach(k => append(el, k)); return; }
  el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
}
const SVGNS = 'http://www.w3.org/2000/svg';
const ICONS = {
  mes: ['M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z'],
  despesas: ['M12 21V9', 'M7 14l5-5 5 5', 'M5 3h14'],
  ganhos: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  agenda: ['M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 2v4', 'M16 2v4', 'M3 10h18', 'M8 14h.01', 'M12 14h.01', 'M16 14h.01', 'M8 18h.01', 'M12 18h.01'],
  calcular: ['M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M8.5 7.5h7', 'M9 12h.01', 'M12 12h.01', 'M15 12h.01', 'M9 16h.01', 'M12 16h.01', 'M15 16h.01'],
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
function parseNum(s) {
  if (s == null) return null;
  let t = String(s).replace(/[^0-9,.\-]/g, '');
  if (!t) return null;
  if (/,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return ok(n) ? r2(n) : NaN;
}
const toInput = v => (v == null || v === '') ? '' : Number(v).toFixed(2).replace('.', ',');
const pad2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const hojeISO = () => iso(new Date());
const mesAtual = () => hojeISO().slice(0, 8) + '01';
function addMes(m, n) { const [y, mo] = m.split('-').map(Number); return iso(new Date(y, mo - 1 + n, 1)); }
function ultimoDia(m) { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); }
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
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
function dividirLocal(v, a, b) {
  const t = a + b;
  if (!(t > 0) || !(v > 0)) return null;
  const eu = r2(v * a / t);
  return { eu: eu, ela: r2(v - eu) };
}
const nomeEla = () => ((S.config && S.config.nome_ela) || '').trim();
const ELA = () => nomeEla() || 'Ela';
const DA = () => nomeEla() ? 'da ' + nomeEla() : 'dela';

// Conta partilhada: quanto te custa e em que estado está
const parte = x => (x.partilhada && x.parte_dela != null) ? Number(x.parte_dela) : 0;
const recebidoDe = x => (x.partilhada && x.recebido) ? parte(x) : 0;
const custo = x => r2(Number(x.valor) - recebidoDe(x));
const porReceber = x => x.partilhada && !x.recebido;
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
  if (/email not confirmed/i.test(m)) return 'Conta por confirmar. Confirma o utilizador no Supabase.';
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
      h('button', { class: 'link', type: 'button', text: 'Cancelar', onclick: () => fechar() }),
      h('h2', { class: 'stitle', id: id + '-t', text: titulo }),
      h('div', { class: 'r' }, guardar)),
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
  const m = S.mes, seq = ++S.seq;
  S.loading = true;
  try {
    if (m <= mesAtual()) await q(sb.rpc('gerar_recorrentes', { p_mes: m }));
    const res = await Promise.all([
      q(sb.from('despesas').select('*').eq('mes', m).order('data', { ascending: false }).order('id', { ascending: false })),
      q(sb.from('ganhos').select('*').eq('mes', m).order('data', { ascending: false }).order('id', { ascending: false })),
      q(sb.from('despesas').select('*').eq('partilhada', true).eq('recebido', false).order('data', { ascending: false }).order('id', { ascending: false })),
      q(sb.from('proximos_pagamentos').select('*').order('data_vencimento').limit(5)),
      q(sb.from('saldos_contas').select('*').order('ordem').order('conta_id')),
      q(sb.from('eventos').select('*').eq('repete', 'nunca').gte('data', m).lte('data', m.slice(0, 8) + pad2(ultimoDia(m)))),
      q(sb.from('eventos').select('*').neq('repete', 'nunca').lte('data', m.slice(0, 8) + pad2(ultimoDia(m))))
    ]);
    if (seq !== S.seq) return;
    S.despesas = res[0] || [];
    S.ganhos = res[1] || [];
    S.aReceber = res[2] || [];
    S.proximos = res[3] || [];
    S.contas = res[4] || [];
    S.eventos = (res[5] || []).concat(res[6] || []);
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
async function marcarRecebido(x) {
  if (x.parte_dela == null) { abrirDespesa(x); return; }
  try {
    await q(sb.from('despesas').update({ recebido: true }).eq('id', x.id));
    await recarregar();
    toast('Recebido: ' + fmt(x.parte_dela));
  } catch (e) { erro(e); }
}

// ===================== Ecrãs =====================
function tagsPartilha(x) {
  if (!x.partilhada) return null;
  if (x.parte_dela == null) return 'Partilhada · parte ' + DA() + ' por definir';
  return x.recebido ? ELA() + ' pagou ' + fmt(x.parte_dela) : ELA() + ' deve ' + fmt(x.parte_dela);
}

function viewMes() {
  if (S.loading && !S.despesas.length && !S.ganhos.length) return carregando();
  const out = [];
  const ganhos = soma(S.ganhos, x => x.valor);
  const gastos = soma(S.despesas, x => x.valor);
  const recebido = soma(S.despesas, recebidoDe);
  const custoLiq = r2(gastos - recebido);
  const saldo = r2(ganhos - custoLiq);
  const aVencer = S.despesas.some(x => x.data > hojeISO());

  out.push(...blocoDinheiro());

  out.push(glabel('Balanço de ' + mesMin(S.mes)), group(
    h('div', { class: 'hero' },
      h('div', { class: 'k', text: S.ganhos.length ? 'Ganhos menos custo líquido' : 'Ainda sem ganhos registados este mês' }),
      h('div', { class: 'big ' + (saldo >= 0 ? 'pos' : 'neg'), text: fmt(saldo) })),
    kv('Ganhos', fmt(ganhos)),
    kv('Gastos (total pago)', fmt(gastos)),
    recebido > 0 ? kv('Recebido ' + DA(), '− ' + fmt(recebido), 'pos') : null,
    kv('Custo líquido', fmt(custoLiq), 'strong')
  ), aVencer ? hint('Inclui despesas fixas que ainda vencem este mês.') : null);

  // A receber (todos os meses)
  if (S.aReceber.length) {
    const total = soma(S.aReceber, parte);
    const semParte = S.aReceber.filter(x => x.parte_dela == null).length;
    out.push(glabel('A receber ' + DA()), group(
      h('div', { class: 'hero' },
        h('div', { class: 'k', text: S.aReceber.length + (S.aReceber.length === 1 ? ' conta partilhada' : ' contas partilhadas') }),
        h('div', { class: 'big', text: fmt(total) }))),
      h('div', { style: 'height:8px' }),
      lista(S.aReceber.map(x => {
        const t = x.descricao || x.comerciante || 'Sem descrição';
        return h('div', { class: 'lrow' },
          h('button', { type: 'button', class: 'rmain linkrow', onclick: () => abrirDespesa(x) },
            h('div', { class: 'rtitle', text: t }),
            h('div', { class: 'rsub', text: diaCurto(x.data) + ' · total ' + fmt(x.valor) })),
          h('div', { class: 'rval', text: x.parte_dela != null ? fmt(x.parte_dela) : '—' }),
          h('button', {
            type: 'button', class: 'mini', text: x.parte_dela != null ? 'Recebi' : 'Definir',
            'aria-label': x.parte_dela != null ? 'Recebi: ' + t + ', ' + fmt(x.parte_dela) : 'Definir: parte ' + DA() + ' em ' + t,
            onclick: () => marcarRecebido(x)
          }));
      })),
      semParte ? hint(semParte + (semParte === 1 ? ' conta sem' : ' contas sem') + ' a parte ' + DA() + ' definida.', 'warn') : null);
  }

  // Por categoria (custo líquido)
  const cats = {};
  S.despesas.forEach(x => { const c = x.categoria || 'Sem categoria'; cats[c] = (cats[c] || 0) + custo(x); });
  const porCat = Object.keys(cats).map(c => [c, r2(cats[c])]).filter(c => c[1] > 0).sort((a, b) => b[1] - a[1]);
  if (porCat.length) {
    const max = porCat[0][1] || 1;
    out.push(glabel('Para onde foi o teu dinheiro'), lista(porCat.map(([c, v]) => h('div', { class: 'catrow' },
      h('div', { class: 'cattop' }, h('span', { text: c }), h('span', { class: 'num gval', text: fmt(v) })),
      h('div', { class: 'bar', 'aria-hidden': 'true', style: 'width:' + Math.max(2, Math.round(v / max * 100)) + '%' })))));
  }

  out.push(glabel('Próximos pagamentos'));
  if (S.proximos.length) {
    out.push(lista(S.proximos.map(x => h('div', { class: 'lrow' },
      h('div', { class: 'rmain' }, h('div', { class: 'rtitle', text: x.nome }),
        h('div', { class: 'rsub', text: diaCurto(x.data_vencimento) + (x.partilhada ? ' · Partilhada' : '') })),
      h('div', { class: 'rval', text: fmt(x.valor) })))));
    out.push(h('div', { class: 'linha-acoes' }, h('button', { type: 'button', class: 'link b', text: 'Gerir despesas fixas', onclick: () => irPara('fixas') })));
  } else out.push(vazio('Sem despesas fixas.', 'Adicionar despesa fixa', () => { irPara('fixas'); abrirFixa(); }));
  return out;
}

const FILTROS = { todas: () => true, rever: porRever, partilhadas: x => x.partilhada, receber: porReceber };
function linhaDespesa(x) {
  const tags = [];
  if (x.categoria) tags.push(x.categoria); else if (x.origem === 'apple_pay') tags.push('Por rever');
  if (x.origem === 'apple_pay') tags.push('Apple Pay');
  if (x.origem === 'recorrente') tags.push('Fixa');
  const tp = tagsPartilha(x); if (tp) tags.push(tp);
  if (x.data > hojeISO()) tags.push('a vencer');
  return h('button', { type: 'button', class: 'lrow', onclick: () => abrirDespesa(x) },
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: x.descricao || x.comerciante || 'Sem descrição' }),
      h('div', { class: 'rsub' + (porRever(x) ? ' warn' : ''), text: tags.join(' · ') })),
    h('div', { class: 'rval', text: fmt(x.valor) }),
    h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
}
function viewDespesas() {
  const nRever = S.despesas.filter(porRever).length, nRec = S.despesas.filter(porReceber).length;
  const filtros = [['todas', 'Todos'], ['rever', 'Por rever' + (nRever ? ' (' + nRever + ')' : '')], ['partilhadas', 'Partilhados'], ['receber', 'A receber' + (nRec ? ' (' + nRec + ')' : '')]];
  const out = [h('div', { class: 'chips scroll', role: 'group', 'aria-label': 'Filtrar gastos' }, filtros.map(([k, l]) => h('button', {
    type: 'button', class: 'chip', text: l, 'aria-pressed': String(S.filtro === k),
    onclick: () => { S.filtro = k; render(); const f = document.querySelector('.chips.scroll [aria-pressed="true"]'); if (f) f.focus(); }
  })))];
  if (S.loading && !S.despesas.length) { out.push(...carregando()); return out; }
  const sel = S.despesas.filter(FILTROS[S.filtro]);
  if (!sel.length) {
    if (S.filtro !== 'todas' && S.despesas.length) out.push(vazio(S.filtro === 'rever' ? 'Nada por rever.' : 'Nada neste filtro.', 'Ver todos', () => { S.filtro = 'todas'; render(); }));
    else out.push(vazio('Sem gastos em ' + mesMin(S.mes) + '.', 'Registar gasto', () => abrirDespesa()));
    return out;
  }
  out.push(hint(sel.length + (sel.length === 1 ? ' gasto · ' : ' gastos · ') + fmt(soma(sel, x => x.valor)) + ' · custo líquido ' + fmt(soma(sel, custo))));
  const porDia = [];
  sel.forEach(x => { const u = porDia[porDia.length - 1]; if (u && u.data === x.data) u.itens.push(x); else porDia.push({ data: x.data, itens: [x] }); });
  porDia.forEach(d => out.push(glabel(diaLongo(d.data)), lista(d.itens.map(linhaDespesa))));
  return out;
}

function viewGanhos() {
  if (S.loading && !S.ganhos.length) return carregando();
  if (!S.ganhos.length) return [vazio('Sem ganhos em ' + mesMin(S.mes) + '.', 'Registar ganho', () => abrirGanho())];
  const out = [glabel('Total de ' + mesMin(S.mes)), group(h('div', { class: 'hero' }, h('div', { class: 'big pos', text: fmt(soma(S.ganhos, x => x.valor)) })))];
  out.push(glabel('Lançamentos'), lista(S.ganhos.map(x => h('button', { type: 'button', class: 'lrow', onclick: () => abrirGanho(x) },
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: x.descricao || x.categoria || 'Ganho' }),
      h('div', { class: 'rsub', text: [diaCurto(x.data), x.categoria].filter(Boolean).join(' · ') })),
    h('div', { class: 'rval pos', text: fmt(x.valor) }),
    h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' })))));
  return out;
}

function resetCalc() {
  const c = S.config || {};
  const ganhosMes = soma(S.ganhos, x => x.valor);
  S.calc.eu = c.calc_eu != null ? toInput(c.calc_eu) : (ganhosMes > 0 ? toInput(ganhosMes) : '');
  S.calc.ela = c.calc_ela != null ? toInput(c.calc_ela) : '';
  S.calc.init = true;
}
function viewCalcular() {
  if (!S.calc.init) resetCalc();
  const inV = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', value: S.calc.valor, 'aria-label': 'Valor a dividir' });
  const inEu = h('input', { class: 'ginput num', type: 'text', inputmode: 'decimal', placeholder: '0,00', value: S.calc.eu, 'aria-label': 'O meu rendimento' });
  const inEla = h('input', { class: 'ginput num', type: 'text', inputmode: 'decimal', placeholder: '0,00', value: S.calc.ela, 'aria-label': 'Rendimento ' + DA() });
  const kEu = h('div', { class: 'k' }), kEla = h('div', { class: 'k' });
  const rEu = h('div', { class: 'big', 'data-r': 'eu' }), rEla = h('div', { class: 'big', 'data-r': 'ela' });
  const porque = h('p', { class: 'hint', id: 'calc-porque' });
  const reg = h('button', { class: 'btn primary', type: 'button', text: 'Registar como gasto partilhado', 'aria-describedby': 'calc-porque' });
  let s = null;
  function upd() {
    S.calc.valor = inV.value; S.calc.eu = inEu.value; S.calc.ela = inEla.value;
    const a = parseNum(inEu.value), b = parseNum(inEla.value), v = parseNum(inV.value);
    s = ok(a) && ok(b) && a >= 0 && b >= 0 ? dividirLocal(ok(v) ? v : 0, a, b) : null;
    const pa = ok(a) && ok(b) && a + b > 0 ? a / (a + b) * 100 : null;
    kEu.textContent = 'Tu' + (pa != null ? ' · ' + pctTxt(pa) : '');
    kEla.textContent = ELA() + (pa != null ? ' · ' + pctTxt(100 - pa) : '');
    rEu.textContent = s ? fmt(s.eu) : '—';
    rEla.textContent = s ? fmt(s.ela) : '—';
    reg.disabled = !s;
    // botão desativado explica porquê
    porque.textContent = s ? 'Ao registar, o gasto entra pelo total e a parte ' + DA() + ' fica a receber.'
      : 'Indica o valor da conta e os dois rendimentos para poder registar.';
  }
  [inV, inEu, inEla].forEach(i => i.addEventListener('input', upd));
  inEu.addEventListener('change', () => { const v = parseNum(inEu.value); if (v === null || (ok(v) && v >= 0)) guardarConfig({ calc_eu: v }, true); });
  inEla.addEventListener('change', () => { const v = parseNum(inEla.value); if (v === null || (ok(v) && v >= 0)) guardarConfig({ calc_ela: v }, true); });
  reg.addEventListener('click', () => { if (s) abrirDespesa(null, { valor: parseNum(inV.value), partilhada: true, parte_dela: s.ela }); });
  upd();
  return [
    glabel('Valor da conta'),
    group(h('div', { class: 'pad' }, inV)),
    h('div', { class: 'duo' }, group(h('div', { class: 'hero' }, kEu, rEu)), group(h('div', { class: 'hero' }, kEla, rEla))),
    glabel('Rendimentos líquidos'),
    group(grow('Eu', inEu), grow(ELA(), inEla)),
    hint('A divisão é proporcional ao que cada um ganha. Os rendimentos ficam guardados para a próxima vez.'),
    reg,
    porque
  ];
}

function viewFixas() {
  const ativas = S.fixas.filter(x => x.ativa);
  const total = soma(ativas, x => x.valor);
  const partesDela = soma(ativas, parte);
  const out = [glabel('Por mês'), group(
    kv('Total das fixas ativas', fmt(total), 'strong'),
    partesDela > 0 ? kv('Parte ' + DA(), '− ' + fmt(partesDela), 'pos') : null,
    partesDela > 0 ? kv('O teu custo fixo', fmt(r2(total - partesDela))) : null
  )];
  out.push(glabel('Despesas fixas'));
  if (!S.fixas.length) { out.push(vazio('Ainda não tens despesas fixas: crédito, água, ginásio…', 'Adicionar despesa fixa', () => abrirFixa())); return out; }
  out.push(lista(S.fixas.map(x => h('button', { type: 'button', class: 'lrow' + (x.ativa ? '' : ' off'), onclick: () => abrirFixa(x) },
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: x.nome }),
      h('div', { class: 'rsub', text: ['Dia ' + x.dia_vencimento, x.categoria,
        x.partilhada ? (x.parte_dela != null ? ELA() + ' paga ' + fmt(x.parte_dela) : 'Partilhada') : null,
        x.ativa ? null : 'Pausada'].filter(Boolean).join(' · ') })),
    h('div', { class: 'rval', text: fmt(x.valor) }),
    h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' })))));
  out.push(hint('Cada fixa entra sozinha em Gastos todos os meses. Se apagares a deste mês, não volta a aparecer.'));
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
  const nome = h('input', { class: 'ginput', type: 'text', placeholder: 'Bia', maxlength: '40', value: c.nome_ela || '', autocapitalize: 'words', 'aria-label': 'Nome dela' });
  nome.addEventListener('keydown', e => { if (e.key === 'Enter') nome.blur(); });
  nome.addEventListener('change', () => guardarConfig({ nome_ela: nome.value.trim() || null }));
  const sw = h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: !!c.apple_pay_partilhada_default, 'aria-label': 'Novos gastos Apple Pay são partilhados' });
  sw.addEventListener('change', () => guardarConfig({ apple_pay_partilhada_default: sw.checked }));
  const url = SUPABASE_URL + '/rest/v1/rpc/registar_apple_pay';
  const tk = c.token_atalho || '';
  return [
    glabel('Contas partilhadas com'),
    group(grow('Nome', nome)),

    glabel('Apple Pay'),
    group(grow('Novos gastos são partilhados', sw)),
    hint('Quando corriges um gasto Apple Pay, o comerciante fica memorizado e os próximos já entram certos.'),

    glabel('Atalho do iPhone · registo automático'),
    group(
      linhaCopiar('URL', url, url.replace('https://', '')),
      linhaCopiar('Chave', SUPABASE_KEY, SUPABASE_KEY.slice(0, 18) + '…'),
      linhaCopiar('Token', tk, tk ? tk.slice(0, 8) + '…' + tk.slice(-4) : '—')
    ),
    group(h('ol', { class: 'steps' },
      h('li', null, 'Atalhos › ', h('b', { text: 'Automação' }), ' › + › ', h('b', { text: 'Carteira' }), '. Escolhe os teus cartões e ativa ', h('b', { text: 'Executar imediatamente' }), '.'),
      h('li', null, 'Nova automação vazia › ação ', h('b', { text: 'Obter conteúdo do URL' }), '. Cola o URL.'),
      h('li', null, 'Método ', h('b', { text: 'POST' }), '. Cabeçalhos: ', h('b', { text: 'apikey' }), ' = Chave; ', h('b', { text: 'Content-Type' }), ' = application/json.'),
      h('li', null, 'Corpo do pedido ', h('b', { text: 'JSON' }), ', 4 campos de texto: ', h('b', { text: 'token' }), ' = Token; ', h('b', { text: 'valor' }), ' = Entrada do atalho › Montante; ', h('b', { text: 'comerciante' }), ' = › Comerciante; ', h('b', { text: 'cartao' }), ' = › Nome.'),
      h('li', null, 'Paga algo pequeno e confirma em Gastos › Por rever.')
    )),
    hint('O token é a tua chave pessoal: não o partilhes. Quem o tiver só consegue adicionar gastos, não ler os teus dados.'),

    ...blocoFeeds(),

    glabel('Conta'),
    group(kv('Sessão', S.user ? S.user.email : '—')),
    h('button', { type: 'button', class: 'btn danger', text: 'Terminar sessão', onclick: async () => { await sb.auth.signOut(); } }),
    hint('GPP Dashboard ' + VERSAO)
  ];
}

// ===================== Folhas de edição =====================
const interruptor = (checked, label) => h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked: !!checked, 'aria-label': label });

function blocoPartilha(st, valorInput, comRecebido) {
  // Liga/desliga partilha + parte dela (+ já recebi)
  const sw = interruptor(st.partilhada, 'Partilhada');
  const inParte = campoValor(st.parte_dela, 'Parte ' + DA(), { placeholder: 'quanto paga' });
  const metade = h('button', { type: 'button', class: 'link small2', text: 'Metade', 'aria-label': 'Metade do valor como parte ' + DA() });
  const swRec = interruptor(st.recebido, 'Já recebi');
  const rowParte = grow('Parte ' + DA(), h('div', { class: 'inline' }, inParte, metade));
  const rowRec = comRecebido ? grow('Já recebi', swRec) : null;
  const info = h('div', { class: 'split', 'aria-live': 'polite' });
  function draw() {
    rowParte.hidden = !st.partilhada;
    if (rowRec) rowRec.hidden = !st.partilhada;
    const v = parseNum(valorInput.value), p = parseNum(inParte.value);
    const mostra = st.partilhada && ok(v) && v > 0 && ok(p) && p > 0;
    info.hidden = !mostra;
    if (mostra) info.textContent = 'Custa-te ' + fmt(r2(v - p)) + ' · ' + ELA() + ' paga ' + fmt(p);
  }
  sw.addEventListener('change', () => { st.partilhada = sw.checked; draw(); });
  swRec.addEventListener('change', () => { st.recebido = swRec.checked; });
  inParte.addEventListener('input', draw);
  valorInput.addEventListener('input', draw);
  metade.addEventListener('click', () => { const v = parseNum(valorInput.value); if (ok(v) && v > 0) { inParte.value = toInput(r2(v / 2)); draw(); } });
  draw();
  return {
    info: info,
    campo: inParte,
    group: group(grow('Partilhada com ' + ELA(), sw), rowParte, rowRec),
    ler: () => {
      if (!st.partilhada) return { partilhada: false, parte_dela: null, recebido: false };
      const p = parseNum(inParte.value);
      return { partilhada: true, parte_dela: ok(p) ? p : null, recebido: comRecebido ? !!st.recebido : false, invalido: p !== null && (!ok(p) || p < 0) };
    }
  };
}
// Validações comuns: devolvem a mensagem de erro (ou null)
function validarValor(s, campo) {
  const v = parseNum(campo.value);
  if (!ok(v) || v <= 0) { s.erro('Indica um valor maior que zero.', campo); return null; }
  return v;
}
function validarPartilha(s, part, v) {
  const p = part.ler();
  if (p.invalido) { s.erro('A parte ' + DA() + ' tem de ser um valor válido.', part.campo); return null; }
  if (p.parte_dela != null && p.parte_dela > v) { s.erro('A parte ' + DA() + ' não pode ser maior que o total.', part.campo); return null; }
  return p;
}

function abrirDespesa(x, preset) {
  const novo = !x; preset = preset || {};
  const st = {
    categoria: x ? x.categoria : null,
    partilhada: x ? !!x.partilhada : !!preset.partilhada,
    parte_dela: x ? x.parte_dela : (ok(preset.parte_dela) ? preset.parte_dela : null),
    recebido: x ? !!x.recebido : false
  };
  const dataDefault = S.mes === mesAtual() ? hojeISO() : S.mes;
  const valor = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor', 'aria-required': 'true',
    value: x ? toInput(x.valor) : (ok(preset.valor) ? toInput(preset.valor) : '') });
  const desc = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', 'aria-label': 'Descrição',
    placeholder: x && x.comerciante ? x.comerciante : 'Ex.: Jantar', value: x ? (x.descricao || '') : '' });
  const data = h('input', { class: 'ginput', type: 'date', value: x ? x.data : dataDefault, 'aria-label': 'Data', 'aria-required': 'true' });
  const part = blocoPartilha(st, valor, true);
  const contaSel = seletorConta(x ? x.conta_id : null);

  let origem = null;
  if (x && x.origem === 'apple_pay') origem = ['Apple Pay', x.cartao, x.comerciante].filter(Boolean).join(' · ');
  if (x && x.origem === 'recorrente') origem = 'Lançado a partir de uma despesa fixa';
  const titulo = x ? (x.descricao || x.comerciante || 'Sem descrição') : '';

  let s;
  const conteudo = [
    valor, part.info,
    origem ? hint(origem, 'center') : null,
    group(grow('Descrição', desc), grow('Data', data), contaSel ? contaSel.row : null),
    glabel('Categoria', 'h3'),
    group(h('div', { class: 'pad' }, chips(CATEGORIAS, st))),
    part.group,
    x && x.origem === 'apple_pay' && x.comerciante ? h('p', { class: 'hint', style: 'margin-top:-10px', text: 'A categoria e a partilha ficam memorizadas para «' + x.comerciante + '».' }) : null,
    novo ? null : botaoApagar('Apagar gasto', 'Apagar este gasto?', '«' + titulo + '» · ' + fmt(x.valor) + '. Não dá para desfazer.', async () => {
      await q(sb.from('despesas').delete().eq('id', x.id));
      s.fechar(); await recarregar(); toast('Gasto apagado');
    }, () => s)
  ];
  s = sheet(novo ? 'Novo gasto' : 'Editar gasto', conteudo, async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    if (!data.value) return s.erro('Indica a data.', data);
    const p = validarPartilha(s, part, v); if (!p) return false;
    const payload = { valor: v, descricao: desc.value.trim() || null, data: data.value, categoria: st.categoria,
      partilhada: p.partilhada, parte_dela: p.parte_dela, recebido: p.recebido };
    if (contaSel) payload.conta_id = contaSel.ler();
    if (novo) await q(sb.from('despesas').insert(payload));
    else await q(sb.from('despesas').update(payload).eq('id', x.id));
    const mesD = payload.data.slice(0, 8) + '01';
    await recarregar();
    toast(mesD === S.mes ? 'Guardado' : 'Guardado em ' + nomeMes(mesD));
  });
  if (novo && !ok(preset.valor)) valor.focus();
}

function abrirGanho(x) {
  const novo = !x;
  const st = { categoria: x ? x.categoria : 'Salário' };
  const valor = h('input', { class: 'valorin pos', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor do ganho', 'aria-required': 'true', value: x ? toInput(x.valor) : '' });
  const desc = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', placeholder: 'Ex.: Salário de novembro', 'aria-label': 'Descrição', value: x ? (x.descricao || '') : '' });
  const data = h('input', { class: 'ginput', type: 'date', value: x ? x.data : (S.mes === mesAtual() ? hojeISO() : S.mes), 'aria-label': 'Data', 'aria-required': 'true' });
  const contaSel = seletorConta(x ? x.conta_id : null);
  let s;
  s = sheet(novo ? 'Novo ganho' : 'Editar ganho', [
    valor, h('div', { class: 'split', text: 'líquido' }),
    group(grow('Descrição', desc), grow('Data', data), contaSel ? contaSel.row : null),
    glabel('Tipo', 'h3'),
    group(h('div', { class: 'pad' }, chips(CAT_GANHOS, st, 'Tipo de ganho'))),
    novo ? null : botaoApagar('Apagar ganho', 'Apagar este ganho?', '«' + (x.descricao || x.categoria || 'Ganho') + '» · ' + fmt(x.valor) + '. Não dá para desfazer.', async () => {
      await q(sb.from('ganhos').delete().eq('id', x.id));
      s.fechar(); await recarregar(); toast('Ganho apagado');
    }, () => s)
  ], async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    if (!data.value) return s.erro('Indica a data.', data);
    const payload = { valor: v, descricao: desc.value.trim() || null, data: data.value, categoria: st.categoria };
    if (contaSel) payload.conta_id = contaSel.ler();
    if (novo) await q(sb.from('ganhos').insert(payload));
    else await q(sb.from('ganhos').update(payload).eq('id', x.id));
    S.calc.init = false;
    const mesG = payload.data.slice(0, 8) + '01';
    await recarregar();
    toast(mesG === S.mes ? 'Ganho guardado' : 'Guardado em ' + nomeMes(mesG));
  });
  if (novo) valor.focus();
}

function abrirFixa(x) {
  const novo = !x;
  const st = { categoria: x ? x.categoria : null, partilhada: x ? !!x.partilhada : false, parte_dela: x ? x.parte_dela : null, ativa: x ? !!x.ativa : true };
  const valor = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor mensal', 'aria-required': 'true', value: x ? toInput(x.valor) : '' });
  const nome = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', placeholder: 'Ex.: Ginásio', 'aria-label': 'Nome', 'aria-required': 'true', value: x ? x.nome : '' });
  const dia = h('input', { class: 'ginput num', type: 'text', inputmode: 'numeric', placeholder: '1 a 31', 'aria-label': 'Dia do pagamento', 'aria-required': 'true', value: x ? String(x.dia_vencimento) : '' });
  const part = blocoPartilha(st, valor, false);
  const swAtiva = interruptor(st.ativa, 'Ativa');
  swAtiva.addEventListener('change', () => { st.ativa = swAtiva.checked; });
  let s;
  const conteudo = [
    valor, part.info, h('div', { class: 'split', text: 'por mês' }),
    group(grow('Nome', nome), grow('Dia do pagamento', dia)),
    glabel('Categoria', 'h3'),
    group(h('div', { class: 'pad' }, chips(CATEGORIAS, st))),
    part.group,
    novo ? null : group(grow('Ativa', swAtiva)),
    h('p', { class: 'hint', style: 'margin-top:-10px', text: 'Entra sozinha em Gastos todos os meses. Se for partilhada, a parte ' + DA() + ' fica a receber até marcares que recebeste.' }),
    novo ? null : botaoApagar('Apagar despesa fixa', 'Apagar «' + x.nome + '»?', 'Deixa de entrar nos próximos meses. Os meses já lançados mantêm-se.', async () => {
      await q(sb.from('despesas_recorrentes').delete().eq('id', x.id));
      s.fechar(); await carregarFixas(); await recarregar(); toast('Fixa apagada');
    }, () => s)
  ];
  s = sheet(novo ? 'Nova despesa fixa' : 'Editar despesa fixa', conteudo, async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    const n = nome.value.trim();
    if (!n) return s.erro('Dá um nome à despesa.', nome);
    const d = parseInt(dia.value, 10);
    if (!(d >= 1 && d <= 31)) return s.erro('O dia tem de ser entre 1 e 31.', dia);
    const p = validarPartilha(s, part, v); if (!p) return false;
    const payload = { nome: n, valor: v, dia_vencimento: d, categoria: st.categoria, partilhada: p.partilhada, parte_dela: p.parte_dela, ativa: st.ativa };
    const m = mesAtual();
    if (novo) await q(sb.from('despesas_recorrentes').insert(payload));
    else {
      await q(sb.from('despesas_recorrentes').update(payload).eq('id', x.id));
      // atualiza o lançamento deste mês, se já existir (mantém o "recebido")
      await q(sb.from('despesas').update({
        valor: v, descricao: n, categoria: st.categoria, partilhada: p.partilhada, parte_dela: p.parte_dela,
        data: m.slice(0, 8) + pad2(Math.min(d, ultimoDia(m)))
      }).eq('recorrente_id', x.id).eq('mes', m));
    }
    await q(sb.rpc('gerar_recorrentes', { p_mes: m }));
    await carregarFixas();
    await recarregar();
    toast(novo ? 'Fixa criada · já entrou em ' + mesMin(m) : 'Fixa atualizada');
  });
  if (novo) valor.focus();
}

// ===================== Contas e saldos =====================
const TIPOS_CONTA = { corrente: 'À ordem', poupanca: 'Poupança', outra: 'Outra' };
const contaPrincipal = () => S.contas.find(c => c.principal) || null;

function selectConta(selecionada, label) {
  return h('select', { class: 'ginput', 'aria-label': label },
    S.contas.map(c => h('option', { value: String(c.conta_id), text: c.nome, selected: c.conta_id === selecionada })));
}
// Só aparece com 2+ contas; a principal grava-se como "sem conta" (segue a principal)
function seletorConta(atual) {
  if (S.contas.length < 2) return null;
  const p = contaPrincipal();
  const sel = selectConta(atual != null ? atual : (p ? p.conta_id : null), 'Conta');
  return { row: grow('Conta', sel), ler: () => { const id = Number(sel.value); return p && id === p.conta_id ? null : id; } };
}

function blocoDinheiro() {
  const out = [glabel('O meu dinheiro')];
  if (!S.contas.length) {
    out.push(group(h('div', { class: 'hero' },
      h('p', { class: 'k', style: 'margin:0', text: 'Indica quanto tens hoje em cada conta. A partir daí, ganhos e gastos atualizam o saldo sozinhos.' }),
      h('button', { type: 'button', class: 'btn primary', text: 'Indicar o saldo da conta principal', onclick: () => abrirConta(null) }))));
    return out;
  }
  const total = soma(S.contas, c => c.saldo_atual), previsto = soma(S.contas, c => c.saldo_previsto);
  out.push(group(h('div', { class: 'hero' },
    h('div', { class: 'k', text: 'Total em ' + S.contas.length + (S.contas.length === 1 ? ' conta' : ' contas') }),
    h('div', { class: 'big' + (total < 0 ? ' neg' : ''), text: fmt(total) }),
    previsto !== total ? h('div', { class: 'k', text: 'Depois das fixas a vencer: ' + fmt(previsto) }) : null)));
  out.push(h('div', { style: 'height:8px' }), lista(S.contas.map(c => h('div', { class: 'lrow' },
    h('button', { type: 'button', class: 'rmain linkrow', onclick: () => abrirConta(c) },
      h('div', { class: 'rtitle', text: c.nome }),
      h('div', { class: 'rsub', text: c.principal ? 'Principal' : TIPOS_CONTA[c.tipo] })),
    h('div', { class: 'rval' + (Number(c.saldo_atual) < 0 ? ' neg' : ''), text: fmt(c.saldo_atual) }),
    h('button', { type: 'button', class: 'mini', text: 'Ajustar', 'aria-label': 'Ajustar: ' + c.nome, onclick: () => abrirAjuste(c) })))));
  out.push(h('div', { class: 'linha-acoes' },
    S.contas.length >= 2 ? h('button', { type: 'button', class: 'link b', text: 'Transferir', onclick: () => abrirTransferencia() }) : null,
    h('button', { type: 'button', class: 'link b', text: 'Nova conta', onclick: () => abrirConta(null) })));
  return out;
}

function abrirConta(x) {
  const novo = !x, primeira = !S.contas.length;
  const stT = { categoria: TIPOS_CONTA[x ? x.tipo : 'corrente'] };
  const nome = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', maxlength: '40', 'aria-label': 'Nome da conta', 'aria-required': 'true',
    placeholder: primeira ? 'Ex.: CGD à ordem' : 'Ex.: Poupança', value: x ? x.nome : '' });
  const saldo = novo ? h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Saldo hoje', 'aria-required': 'true' }) : null;
  const swP = interruptor(x ? x.principal : primeira, 'Conta principal');
  if ((x && x.principal) || primeira) swP.disabled = true;
  let s;
  const conteudo = [
    novo ? [saldo, h('div', { class: 'split', text: 'quanto tens hoje nesta conta' })]
      : group(kv('Saldo atual', fmt(x.saldo_atual), 'strong'),
          x.data_ajuste ? kv('Último ajuste', diaCurto(x.data_ajuste) + ' · ' + fmt(x.saldo_ajuste)) : null,
          grow('', h('button', { type: 'button', class: 'link b', text: 'Ajustar ao valor real', onclick: () => abrirAjuste(x) }))),
    group(grow('Nome', nome)),
    glabel('Tipo', 'h3'),
    group(h('div', { class: 'pad' }, chips(Object.values(TIPOS_CONTA), stT, 'Tipo de conta'))),
    group(grow('Conta principal', swP)),
    hint('Os gastos e ganhos entram na conta principal, a não ser que escolhas outra no próprio lançamento.'),
    !novo && !x.principal ? botaoApagar('Apagar conta', 'Apagar «' + x.nome + '»?', 'Os ajustes e transferências desta conta são apagados. Os gastos e ganhos mantêm-se e passam para a conta principal.', async () => {
      await q(sb.from('contas').delete().eq('id', x.conta_id));
      s.fechar(); await recarregar(); toast('Conta apagada');
    }, () => s) : null,
    !novo && x.principal && S.contas.length > 1 ? hint('Para apagar esta conta, escolhe primeiro outra como principal.') : null
  ];
  s = sheet(novo ? 'Nova conta' : 'Editar conta', conteudo, async () => {
    if (novo) {
      const v = parseNum(saldo.value);
      if (!ok(v)) return s.erro('Indica quanto tens hoje nesta conta (pode ser 0).', saldo);
    }
    const n = nome.value.trim();
    if (!n) return s.erro('Dá um nome à conta.', nome);
    const tipo = Object.keys(TIPOS_CONTA).find(k => TIPOS_CONTA[k] === stT.categoria) || 'corrente';
    if (novo) await q(sb.rpc('criar_conta', { p_nome: n, p_tipo: tipo, p_saldo: parseNum(saldo.value), p_principal: swP.checked }));
    else {
      await q(sb.from('contas').update({ nome: n, tipo: tipo }).eq('id', x.conta_id));
      if (swP.checked && !x.principal) await q(sb.rpc('definir_principal', { p_conta: x.conta_id }));
    }
    await recarregar();
    toast(novo ? 'Conta criada' : 'Conta atualizada');
  });
  if (novo) saldo.focus();
}

function abrirAjuste(c) {
  const atual = Number(c.saldo_atual);
  const inp = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Saldo real hoje', 'aria-required': 'true', value: toInput(atual) });
  const info = h('div', { class: 'split', 'aria-live': 'polite' });
  const sinal = d => (d > 0 ? '+' : '−') + fmt(Math.abs(d));
  const upd = () => {
    const v = parseNum(inp.value);
    const d = ok(v) ? r2(v - atual) : null;
    info.textContent = 'A app calcula ' + fmt(atual) + (d && Math.abs(d) >= 0.005 ? ' · diferença ' + sinal(d) : '');
  };
  inp.addEventListener('input', upd); upd();
  let s;
  s = sheet('Ajustar ' + c.nome, [inp, info,
    hint('Escreve o saldo que vês hoje no banco. O que tiver data anterior a hoje deixa de mexer neste saldo; o que registares a partir de agora conta.')
  ], async () => {
    const v = parseNum(inp.value);
    if (!ok(v)) return s.erro('Indica o saldo real.', inp);
    const dif = Number(await q(sb.rpc('ajustar_saldo', { p_conta: c.conta_id, p_saldo: v })));
    await recarregar();
    toast(Math.abs(dif) < 0.005 ? 'Saldo confirmado' : 'Saldo ajustado (' + sinal(dif) + ')');
  });
  inp.focus(); inp.select();
}

function abrirTransferencia() {
  const p = contaPrincipal() || S.contas[0];
  const outra = S.contas.find(c => c.conta_id !== p.conta_id) || p;
  const valor = h('input', { class: 'valorin', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'aria-label': 'Valor a transferir', 'aria-required': 'true' });
  const de = selectConta(p.conta_id, 'De'), para = selectConta(outra.conta_id, 'Para');
  const data = h('input', { class: 'ginput', type: 'date', value: hojeISO(), 'aria-label': 'Data', 'aria-required': 'true' });
  let s;
  s = sheet('Transferir', [valor, h('div', { class: 'split', text: 'entre as tuas contas' }),
    group(grow('De', de), grow('Para', para), grow('Data', data))
  ], async () => {
    const v = validarValor(s, valor); if (v === null) return false;
    if (de.value === para.value) return s.erro('Escolhe duas contas diferentes.', para);
    if (!data.value) return s.erro('Indica a data.', data);
    await q(sb.from('transferencias').insert({ de_conta: Number(de.value), para_conta: Number(para.value), valor: v, data: data.value }));
    await recarregar();
    toast('Transferido ' + fmt(v));
  });
  valor.focus();
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
function ocorreEm(ev, iso) {
  if (ev.data === iso) return true;
  if (iso < ev.data || ev.repete === 'nunca') return false;
  const [y1, m1, d1] = ev.data.split('-').map(Number), [y2, m2, d2] = iso.split('-').map(Number);
  if (ev.repete === 'semanal') return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000) % 7 === 0;
  if (ev.repete === 'mensal') return d1 === d2;
  if (ev.repete === 'anual') return d1 === d2 && m1 === m2;
  return false;
}
function itensDoMes(m) {
  const res = {}, ud = ultimoDia(m);
  const add = (iso, it) => { (res[iso] = res[iso] || []).push(it); };
  for (let d = 1; d <= ud; d++) {
    const iso = m.slice(0, 8) + pad2(d);
    S.eventos.forEach(ev => { if (ocorreEm(ev, iso)) add(iso, { tipo: 'evento', agenda: ev.agenda, ev: ev }); });
  }
  S.fixas.filter(f => f.ativa).forEach(f => {
    const iso = m.slice(0, 8) + pad2(Math.min(f.dia_vencimento, ud));
    if (iso >= f.inicio && (!f.fim || iso <= f.fim)) add(iso, { tipo: 'pagamento', agenda: 'pag', f: f });
  });
  return res;
}
const chaveOrdem = it => (it.tipo === 'pagamento' ? '0' : it.ev.dia_inteiro || !it.ev.hora_inicio ? '1' : '2' + it.ev.hora_inicio);

function linhaItemAgenda(it) {
  if (it.tipo === 'pagamento') {
    const f = it.f;
    return h('button', { type: 'button', class: 'lrow', onclick: () => abrirFixa(f) },
      h('span', { class: 'barra ag-pag', 'aria-hidden': 'true' }),
      h('div', { class: 'rmain' },
        h('div', { class: 'rtitle', text: 'Pagar ' + f.nome }),
        h('div', { class: 'rsub', text: ['Pagamento', f.partilhada && f.parte_dela != null ? ELA() + ' paga ' + fmt(f.parte_dela) : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'rval', text: fmt(f.valor) }),
      h('span', { class: 'chev', text: '›', 'aria-hidden': 'true' }));
  }
  const ev = it.ev;
  return h('button', { type: 'button', class: 'lrow', onclick: () => abrirEvento(ev) },
    h('span', { class: 'barra ag-' + ev.agenda, 'aria-hidden': 'true' }),
    h('div', { class: 'rmain' },
      h('div', { class: 'rtitle', text: ev.titulo }),
      h('div', { class: 'rsub', text: [horario(ev), ev.local, nomeAg(ev.agenda), ev.repete !== 'nunca' ? REPETE.find(r => r[1] === ev.repete)[0] : null].filter(Boolean).join(' · ') })),
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
function escolha(opcoes, atual, rotulo, comPonto) {
  let valor = atual;
  const box = h('div', { class: 'chips', role: 'group', 'aria-label': rotulo });
  const btns = opcoes.map(([label, v]) => h('button', {
    type: 'button', class: 'chip', 'aria-pressed': String(v === valor),
    onclick: () => { valor = v; btns.forEach((b, i) => b.setAttribute('aria-pressed', String(opcoes[i][1] === valor))); }
  }, comPonto ? h('i', { class: 'dot ag-' + v, 'aria-hidden': 'true' }) : null, label));
  box.append(...btns);
  return { el: box, valor: () => valor };
}

function abrirEvento(ev, dataPreset) {
  const novo = !ev;
  const titulo = h('input', { class: 'ginput', type: 'text', autocapitalize: 'sentences', maxlength: '120', placeholder: 'Ex.: Jantar com a ' + ELA(), 'aria-label': 'Título', 'aria-required': 'true', value: ev ? ev.titulo : '', style: 'text-align:left' });
  const data = h('input', { class: 'ginput', type: 'date', value: ev ? ev.data : (dataPreset || hojeISO()), 'aria-label': 'Data', 'aria-required': 'true' });
  const swDia = interruptor(ev ? ev.dia_inteiro : false, 'Todo o dia');
  const ini = h('input', { class: 'ginput', type: 'time', value: ev ? hhmm(ev.hora_inicio) : '', 'aria-label': 'Início' });
  const fim = h('input', { class: 'ginput', type: 'time', value: ev ? hhmm(ev.hora_fim) : '', 'aria-label': 'Fim' });
  const rIni = grow('Início', ini), rFim = grow('Fim', fim);
  const drawDia = () => { rIni.hidden = rFim.hidden = swDia.checked; };
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
    group(grow('Data', data), grow('Todo o dia', swDia), rIni, rFim),
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
    const dia = swDia.checked;
    if (!dia && !ini.value) return s.erro('Indica a hora de início ou marca «Todo o dia».', ini);
    if (!dia && fim.value && fim.value <= ini.value) return s.erro('O fim tem de ser depois do início.', fim);
    const payload = {
      titulo: t, agenda: agenda.valor(), data: data.value, dia_inteiro: dia,
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
    S.mes !== mesAtual() ? h('button', { class: 'link small', type: 'button', text: 'Este mês', onclick: () => { S.mes = mesAtual(); S.despesas = []; S.ganhos = []; render(); recarregar(); } }) : null);
}
async function mudarMes(n) {
  S.mes = addMes(S.mes, n);
  S.despesas = []; S.ganhos = [];
  render();
  await recarregar();
}
function irPara(t) {
  S.tab = t;
  window.scrollTo(0, 0);
  render();
  if (t === 'fixas') carregarFixas().then(render);
}
function render() {
  if (!S.user) return;
  const views = { mes: viewMes, despesas: viewDespesas, ganhos: viewGanhos, agenda: viewAgenda, calcular: viewCalcular, fixas: viewFixas, ajustes: viewAjustes };
  const acoes = { mes: () => abrirDespesa(), despesas: () => abrirDespesa(), ganhos: () => abrirGanho(), agenda: () => abrirEvento(null, S.diaSel), fixas: () => abrirFixa() };
  const rotulos = { mes: 'Novo gasto', despesas: 'Novo gasto', ganhos: 'Novo ganho', agenda: 'Novo evento', fixas: 'Nova despesa fixa' };
  const botoes = h('div', { class: 'acts' },
    S.tab === 'mes' ? h('button', { class: 'gearbtn', type: 'button', 'aria-label': 'Ajustes', onclick: () => irPara('ajustes') }, icon(ICONS.ajustes)) : null,
    S.tab === 'despesas' ? h('button', { class: 'gearbtn', type: 'button', 'aria-label': 'Despesas fixas', onclick: () => irPara('fixas') }, icon(ICONS.fixas)) : null,
    S.tab === 'ajustes' ? h('button', { class: 'link b', type: 'button', text: 'Fechar', onclick: () => irPara('mes') }) : null,
    S.tab === 'fixas' ? h('button', { class: 'link b', type: 'button', text: 'Fechar', onclick: () => irPara('despesas') }) : null,
    acoes[S.tab] ? h('button', { class: 'addbtn', type: 'button', text: '+', 'aria-label': rotulos[S.tab], onclick: acoes[S.tab] }) : null);
  const header = h('header', { class: 'top' },
    h('div', { class: 'toprow' }, h('h1', { text: TITULOS[S.tab] }), botoes),
    (S.tab === 'mes' || S.tab === 'despesas' || S.tab === 'ganhos' || S.tab === 'agenda') ? mesNav() : null);
  const main = h('main', { 'aria-busy': S.loading ? 'true' : 'false' }, views[S.tab]());
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Separadores' }, TABS.map(t => h('button', {
    type: 'button', class: 'tab' + (S.tab === t ? ' on' : ''), 'aria-current': S.tab === t ? 'page' : null, onclick: () => irPara(t)
  }, icon(ICONS[t]), h('span', { text: TITULOS[t] }))));
  app.replaceChildren(header, main, tabbar);
}

function renderLogin() {
  document.querySelectorAll('dialog').forEach(d => d.remove());
  document.body.classList.remove('noscroll');
  const email = h('input', { class: 'lfield', type: 'email', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Email', 'aria-label': 'Email', required: true });
  const pass = h('input', { class: 'lfield', type: 'password', autocomplete: 'current-password', placeholder: 'Palavra-passe', 'aria-label': 'Palavra-passe', required: true });
  const lerr = h('p', { class: 'lerr', id: 'login-erro', role: 'alert', hidden: true });
  const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Entrar' });
  const form = h('form', { class: 'login', 'aria-labelledby': 'login-t' },
    h('div', { class: 'logo', 'aria-hidden': 'true', text: 'GPP' }), h('h1', { id: 'login-t', text: 'GPP Dashboard' }), h('p', { text: 'Os teus gastos e ganhos, num só sítio.' }),
    email, pass, lerr, btn);
  const limpar = () => { lerr.hidden = true; [email, pass].forEach(i => { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }); };
  form.addEventListener('input', limpar);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    limpar();
    btn.disabled = true; btn.textContent = 'A entrar…';
    const r = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    btn.disabled = false; btn.textContent = 'Entrar';
    if (r.error) {
      console.error(r.error);
      lerr.textContent = traduzErro(r.error); lerr.hidden = false;
      [email, pass].forEach(i => { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', 'login-erro'); });
      pass.focus();
      return;
    }
    await entrar(r.data.user);
  });
  app.replaceChildren(h('main', null, form));
}

async function entrar(user) {
  S.user = user;
  S.mes = mesAtual();
  S.tab = 'mes';
  S.despesas = []; S.ganhos = [];
  app.replaceChildren(h('main', { 'aria-busy': 'true' }, carregando()));
  try { S.config = await q(sb.rpc('garantir_config')); }
  catch (e) { erro(e); S.config = {}; }
  render();
  await Promise.all([carregarMes(), carregarFixas()]);
  render();
}

sb.auth.onAuthStateChange(ev => {
  if (ev === 'SIGNED_OUT') {
    S.user = null; S.config = null; S.despesas = []; S.ganhos = []; S.aReceber = []; S.fixas = []; S.contas = []; S.eventos = []; S.diaSel = null;
    S.calc = { init: false, eu: '', ela: '', valor: '' };
    setTimeout(renderLogin, 0);
  }
});

// Ao voltar à app (ex.: depois de pagar com Apple Pay), atualiza
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user && S.mes) recarregar();
});

(async function init() {
  try {
    const r = await sb.auth.getSession();
    const session = r.data && r.data.session;
    if (session) await entrar(session.user); else renderLogin();
  } catch (e) { erro(e); renderLogin(); }
})();
})();
