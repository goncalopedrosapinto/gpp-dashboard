// Testa o gerador .ics da Edge Function (mesmo código, corrido no Node)
// e valida o resultado com a biblioteca Python icalendar.
import { construirICS } from '../../supabase/functions/calendario/ics.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dados = {
  nome_ela: 'Bia',
  eventos: [
    { id: 1, titulo: 'Jantar com a Bia', agenda: 'bia', data: '2026-11-06', dia_inteiro: false, hora_inicio: '20:00:00', hora_fim: '22:00:00', repete: 'nunca', alerta_min: 30, local: 'Aveiro, Rua Direita; 2.º', notas: 'Linha 1\nLinha 2', atualizado_em: '2026-11-06T10:00:00Z' },
    { id: 2, titulo: 'Aniversário da Bia', agenda: 'bia', data: '2026-03-14', dia_inteiro: true, hora_inicio: null, hora_fim: null, repete: 'anual', alerta_min: 1440 },
    { id: 3, titulo: 'Reunião de vendas — revisão semanal do pipeline e das margens de todas as motas usadas em stock', agenda: 'trabalho', data: '2026-11-09', dia_inteiro: false, hora_inicio: '09:30:00', hora_fim: null, repete: 'semanal', alerta_min: 15 },
    { id: 4, titulo: 'Ginásio', agenda: 'pessoal', data: '2026-11-07', dia_inteiro: false, hora_inicio: '07:00:00', hora_fim: '08:00:00', repete: 'nunca', alerta_min: null }
  ],
  pagamentos: [
    { id: 9, nome: 'Renda', valor: 600, partilhada: true, parte_dela: 300, data: '2026-12-01' },
    { id: 10, nome: 'Água', valor: 40, partilhada: false, parte_dela: null, data: '2026-11-30', debito_direto: true, conta: 'CGD à ordem' }
  ]
};

const falhas = [];
const check = (c, m) => { console.log((c ? '  OK  ' : '  FALHA ') + m); if (!c) falhas.push(m); };

const tudo = construirICS(dados, { agora: Date.UTC(2026, 10, 6, 10, 30) });
const bia = construirICS({ ...dados, eventos: dados.eventos.filter(e => e.agenda === 'bia'), pagamentos: [] }, { agenda: 'bia', agora: Date.UTC(2026, 10, 6, 10, 30) });

check(tudo.split('\r\n').every(l => new TextEncoder().encode(l).length <= 75), 'nenhuma linha passa 75 octetos (dobragem RFC 5545)');
check(!/[^\r]\n/.test(tudo), 'todas as quebras de linha são CRLF');
check(tudo.includes('SUMMARY:[Bia] Jantar com a Bia') && bia.includes('SUMMARY:Jantar com a Bia'), 'feed único leva prefixo da agenda; feed por agenda não');
check(bia.includes('X-WR-CALNAME:GPP · Bia'), 'nome do calendário por agenda: "GPP · Bia"');
check(tudo.includes('DTSTART;TZID=Europe/Lisbon:20261106T200000') && tudo.includes('DTEND;TZID=Europe/Lisbon:20261106T220000'), 'evento com hora em Europe/Lisbon');
check(tudo.includes('DTSTART;VALUE=DATE:20260314') && tudo.includes('DTEND;VALUE=DATE:20260315') && tudo.includes('RRULE:FREQ=YEARLY'), 'aniversário: dia inteiro, todos os anos');
check(tudo.includes('LOCATION:Aveiro\\, Rua Direita\\; 2.º') && tudo.includes('DESCRIPTION:Linha 1\\nLinha 2'), 'vírgulas, pontos e vírgulas e quebras escapados');
check(tudo.includes('TRIGGER:-PT30M') && tudo.includes('TRIGGER:-PT1440M'), 'alertas no tempo pedido');
check(tudo.includes('SUMMARY:[Pagamentos] Pagar Renda · 600\\,00 €') && tudo.includes('TRIGGER:-PT15H'), 'pagamentos das fixas com aviso às 9:00 da véspera');
check(tudo.includes('DESCRIPTION:Parte da Bia: 300\\,00 €'), 'pagamento partilhado mostra a parte da Bia');
check(tudo.includes('SUMMARY:[Pagamentos] Débito direto: Água · 40\\,00 €') && tudo.includes('Amanhã sai o débito de Água (40\\,00 €) da CGD à ordem'), 'débito direto: título e aviso dizem de que conta sai');

// Validação independente (parser Python)
const dir = mkdtempSync(join(tmpdir(), 'ics-'));
writeFileSync(join(dir, 'tudo.ics'), tudo);
writeFileSync(join(dir, 'bia.ics'), bia);
const py = `
import sys, icalendar
for f in sys.argv[1:]:
    cal = icalendar.Calendar.from_ical(open(f, 'rb').read())
    evs = [c for c in cal.walk('VEVENT')]
    tz = [c for c in cal.walk('VTIMEZONE')]
    print(f.split('/')[-1], len(evs), len(tz), evs[0].get('summary'), evs[0].decoded('dtstart'))
`;
try {
  const out = execFileSync('python3', ['-I', '-c', py, join(dir, 'tudo.ics'), join(dir, 'bia.ics')]).toString().trim().split('\n');
  console.log('    ' + out.join('\n    '));
  check(out[0].startsWith('tudo.ics 6 1') && out[1].startsWith('bia.ics 2 1'), 'parser icalendar lê os dois feeds (6 e 2 eventos, fuso incluído)');
  check(out[0].includes('2026-11-06 20:00:00+00:00') || out[0].includes('2026-11-06 20:00:00+00'), 'hora interpretada no fuso de Lisboa (inverno = UTC+0)');
} catch (e) { check(false, 'parser icalendar: ' + e.message); }

console.log(falhas.length ? '\n' + falhas.length + ' FALHAS' : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
