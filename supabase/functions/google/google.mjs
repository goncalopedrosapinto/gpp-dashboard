// Lê um calendário iCal (endereço secreto do Google Calendar) e devolve as ocorrências
// entre duas datas (inclusive), já no fuso de Lisboa. Recebe o ICAL (ical.js) por parâmetro
// para o mesmo código correr no Deno (Edge Function) e no Node (testes).
const TZ = 'Europe/Lisbon';
const MAX_ITER = 20000;   // ex.: um evento diário desde 2010

function partesLisboa(js) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(js).map(x => [x.type, x.value]));
  return { data: p.year + '-' + p.month + '-' + p.day, hora: p.hour + ':' + p.minute };
}
function menosUmDia(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}
const limpa = s => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, 200) || null);

function ocorrencia(ev, ini, fim, chave) {
  const titulo = limpa(ev.summary) || '(sem título)';
  const local = limpa(ev.location);
  if (ini.isDate) {
    const d0 = ini.toString().slice(0, 10);
    const d1 = fim ? menosUmDia(fim.toString().slice(0, 10)) : d0;
    return { id: chave, titulo, local, dia_inteiro: true, data: d0, data_fim: d1 < d0 ? d0 : d1, hora_inicio: null, hora_fim: null };
  }
  const a = partesLisboa(ini.toJSDate()), b = fim ? partesLisboa(fim.toJSDate()) : a;
  return { id: chave, titulo, local, dia_inteiro: false, data: a.data, data_fim: b.data < a.data ? a.data : b.data, hora_inicio: a.hora, hora_fim: fim ? b.hora : null };
}

export function expandir(ICAL, texto, de, ate) {
  const comp = new ICAL.Component(ICAL.parse(texto));
  for (const tz of comp.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch (e) { /* fuso repetido ou inválido */ }
  }
  const mestres = new Map(), excecoes = [];
  for (const v of comp.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) excecoes.push(ev);
    else mestres.set(ev.uid, ev);
  }
  for (const ex of excecoes) {
    const m = mestres.get(ex.uid);
    if (m) m.relateException(ex); else mestres.set(ex.uid + '#' + ex.recurrenceId, ex);
  }

  const out = [];
  const dentro = o => o.data <= ate && o.data_fim >= de;
  const cancelado = comp => String(comp.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
  for (const [uid, ev] of mestres) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      if (cancelado(ev.component)) continue;
      const o = ocorrencia(ev, ev.startDate, ev.endDate, uid);
      if (dentro(o)) out.push(o);
      continue;
    }
    const it = ev.iterator();
    for (let i = 0, t; i < MAX_ITER && (t = it.next()); i++) {
      const det = ev.getOccurrenceDetails(t);
      const o = ocorrencia(det.item, det.startDate, det.endDate, uid + '@' + t.toString());
      if (o.data > ate) break;
      if (dentro(o) && !cancelado(det.item.component)) out.push(o);
    }
  }
  out.sort((x, y) => (x.data + (x.hora_inicio || '') < y.data + (y.hora_inicio || '') ? -1 : 1));
  return out;
}
