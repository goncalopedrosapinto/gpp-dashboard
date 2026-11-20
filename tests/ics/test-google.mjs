// Teste da leitura do Google Calendar (supabase/functions/google/google.mjs) com o ical.js real
import { createRequire } from 'node:module';
import { expandir } from '../../supabase/functions/google/google.mjs';
const require = createRequire(new URL('../e2e/', import.meta.url));
const ICAL = require('ical.js');

const ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-TIMEZONE:Europe/Lisbon',
  'BEGIN:VTIMEZONE', 'TZID:Europe/Lisbon',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0000', 'TZNAME:WET', 'DTSTART:19701025T020000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0100', 'TZNAME:WEST', 'DTSTART:19700329T010000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'END:VTIMEZONE',
  // 1. evento com hora (fuso de Lisboa)
  'BEGIN:VEVENT', 'UID:a1', 'DTSTART;TZID=Europe/Lisbon:20261121T140000', 'DTEND;TZID=Europe/Lisbon:20261121T153000', 'SUMMARY:Almoço com o Rui', 'LOCATION:Aveiro', 'END:VEVENT',
  // 2. evento em UTC
  'BEGIN:VEVENT', 'UID:a2', 'DTSTART:20261123T100000Z', 'DTEND:20261123T110000Z', 'SUMMARY:Dentista', 'END:VEVENT',
  // 3. aniversário anual (dia inteiro)
  'BEGIN:VEVENT', 'UID:a3', 'DTSTART;VALUE=DATE:19901125', 'DTEND;VALUE=DATE:19901126', 'RRULE:FREQ=YEARLY', 'SUMMARY:Aniversário da mãe', 'END:VEVENT',
  // 4. semanal à terça com uma exceção apagada e uma mudada de hora
  'BEGIN:VEVENT', 'UID:a4', 'DTSTART;TZID=Europe/Lisbon:20261103T190000', 'DTEND;TZID=Europe/Lisbon:20261103T200000', 'RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=Europe/Lisbon:20261124T190000', 'SUMMARY:Padel', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:a4', 'RECURRENCE-ID;TZID=Europe/Lisbon:20261201T190000', 'DTSTART;TZID=Europe/Lisbon:20261201T210000', 'DTEND;TZID=Europe/Lisbon:20261201T220000', 'SUMMARY:Padel (mais tarde)', 'END:VEVENT',
  // 5. cancelado
  'BEGIN:VEVENT', 'UID:a5', 'DTSTART;TZID=Europe/Lisbon:20261122T100000', 'DTEND;TZID=Europe/Lisbon:20261122T110000', 'STATUS:CANCELLED', 'SUMMARY:Cancelado', 'END:VEVENT',
  // 6. vários dias (28 a 30)
  'BEGIN:VEVENT', 'UID:a6', 'DTSTART;VALUE=DATE:20261128', 'DTEND;VALUE=DATE:20261201', 'SUMMARY:Fim de semana no Gerês', 'END:VEVENT',
  // 7. fora do intervalo
  'BEGIN:VEVENT', 'UID:a7', 'DTSTART;TZID=Europe/Lisbon:20270110T100000', 'DTEND;TZID=Europe/Lisbon:20270110T110000', 'SUMMARY:Longe', 'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

const falhas = [];
const check = (c, m) => { console.log((c ? '  OK  ' : '  FALHA ') + m); if (!c) falhas.push(m); };
const ev = expandir(ICAL, ICS, '2026-11-20', '2026-12-05');
const t = x => ev.filter(e => e.titulo === x);

check(t('Almoço com o Rui').length === 1 && t('Almoço com o Rui')[0].hora_inicio === '14:00' && t('Almoço com o Rui')[0].hora_fim === '15:30' && t('Almoço com o Rui')[0].local === 'Aveiro', 'evento com hora no fuso de Lisboa');
check(t('Dentista')[0] && t('Dentista')[0].data === '2026-11-23' && t('Dentista')[0].hora_inicio === '10:00', 'evento em UTC convertido para Lisboa (inverno)');
check(t('Aniversário da mãe').length === 1 && t('Aniversário da mãe')[0].data === '2026-11-25' && t('Aniversário da mãe')[0].dia_inteiro, 'aniversário anual aparece em 2026');
const padel = ev.filter(e => e.titulo.startsWith('Padel')).map(e => e.data + ' ' + e.hora_inicio);
check(JSON.stringify(padel) === JSON.stringify(['2026-12-01 21:00']), 'semanal: 24/11 apagado, 1/12 mudado para as 21:00 (' + padel.join(', ') + ')');
check(!t('Cancelado').length, 'evento cancelado não aparece');
const g = t('Fim de semana no Gerês')[0];
check(g && g.data === '2026-11-28' && g.data_fim === '2026-11-30', 'vários dias: 28 a 30 (DTEND exclusivo)');
check(!t('Longe').length, 'fora do intervalo não aparece');
check(ev.every((e, i) => !i || ev[i - 1].data <= e.data), 'ordenado por data');
const verao = expandir(ICAL, ICS.replace('20261123T100000Z', '20260701T100000Z').replace('20261123T110000Z', '20260701T110000Z'), '2026-07-01', '2026-07-01');
check(verao.find(e => e.titulo === 'Dentista').hora_inicio === '11:00', 'UTC no verão: 10:00Z = 11:00 em Lisboa');

if (falhas.length) { console.log('FALHAS: ' + falhas.length); process.exit(1); }
console.log('GOOGLE OK');
