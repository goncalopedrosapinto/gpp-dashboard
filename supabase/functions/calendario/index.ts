// Feed .ics da agenda do GPP Dashboard para o Calendário do iPhone.
// GET /functions/v1/calendario?t=<token_calendario>[&a=pessoal|trabalho|bia|outro|pagamentos]
// Público (o iPhone não envia cabeçalhos); a proteção é o token de 64 caracteres.
import { construirICS } from './ics.mjs';

const BASE = Deno.env.get('SUPABASE_URL') ?? 'https://klmjdjhvsxvopctgmhyu.supabase.co';
const CHAVE = Deno.env.get('SUPABASE_ANON_KEY') ?? 'sb_publishable_L3QfJtwa_wYBCsHN4uzgXQ_rcp52nL8';
const AGENDAS = ['pessoal', 'trabalho', 'bia', 'outro', 'pagamentos'];
const naoEncontrado = () => new Response('Link de calendário inválido.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405 });
  const u = new URL(req.url);
  const token = u.searchParams.get('t') ?? '';
  const agenda = u.searchParams.get('a');
  if (!/^[0-9a-f]{64}$/.test(token)) return naoEncontrado();
  if (agenda && !AGENDAS.includes(agenda)) return naoEncontrado();

  const headers: Record<string, string> = { apikey: CHAVE, 'Content-Type': 'application/json' };
  if (CHAVE.startsWith('eyJ')) headers.Authorization = 'Bearer ' + CHAVE;
  const r = await fetch(BASE + '/rest/v1/rpc/calendario_dados', {
    method: 'POST', headers, body: JSON.stringify({ token, p_agenda: agenda })
  });
  if (!r.ok) return naoEncontrado();
  const dados = await r.json();

  return new Response(construirICS(dados, { agenda, agora: Date.now() }), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="gpp' + (agenda ? '-' + agenda : '') + '.ics"',
      'Cache-Control': 'no-cache, max-age=0'
    }
  });
});
