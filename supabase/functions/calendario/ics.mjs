// Gera um calendário iCalendar (RFC 5545) a partir de calendario_dados().
// Sem dependências: corre no Deno (Edge Function) e no Node (testes).

const NOMES = { pessoal: 'Pessoal', trabalho: 'Trabalho', outro: 'Outro', pagamentos: 'Pagamentos' };
export const nomeAgenda = (a, nomeEla) => (a === 'bia' ? (nomeEla || 'Bia') : (NOMES[a] || 'GPP'));

const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Lisbon',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:WEST',
  'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:WET',
  'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE'
];
const RRULE = { semanal: 'FREQ=WEEKLY', mensal: 'FREQ=MONTHLY', anual: 'FREQ=YEARLY' };

const esc = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const d8 = iso => String(iso).slice(0, 10).replace(/-/g, '');
const hms = t => String(t).slice(0, 8).replace(/:/g, '').padEnd(6, '0');
const carimbo = ts => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function maisUmDia(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
const EUR = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const eur = v => EUR.format(Number(v)).replace(/\u202f|\u00a0/g, ' ');

// Linhas com mais de 75 octetos dobram-se (RFC 5545 §3.1)
function dobrar(linha) {
  const enc = new TextEncoder();
  const partes = [];
  let cur = '', n = 0;
  for (const ch of linha) {
    const b = enc.encode(ch).length;
    if (n + b > 75) { partes.push(cur); cur = ' ' + ch; n = 1 + b; } else { cur += ch; n += b; }
  }
  partes.push(cur);
  return partes.join('\r\n');
}

export function construirICS(dados, opts) {
  const agenda = (opts && opts.agenda) || null;
  const stamp = carimbo((opts && opts.agora) || Date.now());
  const nomeEla = dados.nome_ela;
  const prefixo = a => (agenda ? '' : '[' + nomeAgenda(a, nomeEla) + '] ');
  const L = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GPP Dashboard//Agenda//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(agenda ? 'GPP · ' + nomeAgenda(agenda, nomeEla) : 'GPP Dashboard'),
    'X-WR-TIMEZONE:Europe/Lisbon', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE
  ];

  for (const e of dados.eventos || []) {
    L.push('BEGIN:VEVENT', 'UID:evento-' + e.id + '@gpp-dashboard', 'DTSTAMP:' + stamp);
    if (e.atualizado_em) L.push('LAST-MODIFIED:' + carimbo(e.atualizado_em));
    if (e.dia_inteiro || !e.hora_inicio) {
      L.push('DTSTART;VALUE=DATE:' + d8(e.data), 'DTEND;VALUE=DATE:' + d8(maisUmDia(e.data)));
    } else {
      L.push('DTSTART;TZID=Europe/Lisbon:' + d8(e.data) + 'T' + hms(e.hora_inicio));
      L.push(e.hora_fim ? 'DTEND;TZID=Europe/Lisbon:' + d8(e.data) + 'T' + hms(e.hora_fim) : 'DURATION:PT1H');
    }
    if (RRULE[e.repete]) L.push('RRULE:' + RRULE[e.repete]);
    L.push('SUMMARY:' + esc(prefixo(e.agenda) + e.titulo));
    if (e.local) L.push('LOCATION:' + esc(e.local));
    if (e.notas) L.push('DESCRIPTION:' + esc(e.notas));
    L.push('CATEGORIES:' + esc(nomeAgenda(e.agenda, nomeEla)));
    if (e.alerta_min != null) {
      L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(e.titulo), 'TRIGGER:-PT' + Number(e.alerta_min) + 'M', 'END:VALARM');
    }
    L.push('END:VEVENT');
  }

  for (const p of dados.pagamentos || []) {
    L.push('BEGIN:VEVENT', 'UID:pagamento-' + p.id + '-' + d8(p.data) + '@gpp-dashboard', 'DTSTAMP:' + stamp,
      'DTSTART;VALUE=DATE:' + d8(p.data), 'DTEND;VALUE=DATE:' + d8(maisUmDia(p.data)),
      'SUMMARY:' + esc(prefixo('pagamentos') + (p.debito_direto ? 'Débito direto: ' : p.transferencia ? 'Transferir: ' : 'Pagar ') + p.nome + ' · ' + eur(p.valor)),
      'TRANSP:TRANSPARENT', 'CATEGORIES:Pagamentos');
    const desc = [
      p.transferencia ? 'De ' + (p.conta || 'conta principal') + ' para ' + p.para + '.' + (p.debito_direto ? ' Sai sozinho: confirma que há saldo.' : '')
        : p.debito_direto ? 'Sai sozinho' + (p.conta ? ' da conta ' + p.conta : '') + '. Confirma que há saldo.' : (p.conta ? 'Conta: ' + p.conta : null),
      p.partilhada && p.parte_dela != null ? 'Parte ' + (nomeEla ? 'da ' + nomeEla : 'dela') + ': ' + eur(p.parte_dela) : null
    ].filter(Boolean).join('\n');
    if (desc) L.push('DESCRIPTION:' + esc(desc));
    // Evento de dia inteiro começa às 00:00: -15 h = 9:00 da véspera
    const aviso = p.transferencia
      ? (p.debito_direto ? 'Amanhã saem ' : 'Amanhã: transferir ') + eur(p.valor) + (p.conta ? ' da ' + p.conta : '') + ' para ' + p.para
      : p.debito_direto
        ? 'Amanhã sai o débito de ' + p.nome + ' (' + eur(p.valor) + ')' + (p.conta ? ' da ' + p.conta : '')
        : 'Amanhã: pagar ' + p.nome;
    L.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + esc(aviso), 'TRIGGER:-PT15H', 'END:VALARM', 'END:VEVENT');
  }

  L.push('END:VCALENDAR');
  return L.map(dobrar).join('\r\n') + '\r\n';
}
