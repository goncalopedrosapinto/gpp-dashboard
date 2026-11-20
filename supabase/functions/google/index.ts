// Google Calendar só de leitura para o GPP Dashboard.
// GET /functions/v1/google?de=YYYY-MM-DD&ate=YYYY-MM-DD   (Authorization: Bearer <sessão do utilizador>)
// O endereço secreto iCal vem da tabela config do próprio utilizador (RLS); nunca sai para o browser.
import ICAL from 'npm:ical.js@2.2.1';
import { expandir } from './google.mjs';

const BASE = Deno.env.get('SUPABASE_URL') ?? 'https://klmjdjhvsxvopctgmhyu.supabase.co';
const CHAVE = Deno.env.get('SUPABASE_ANON_KEY') ?? 'sb_publishable_L3QfJtwa_wYBCsHN4uzgXQ_rcp52nL8';
const GOOGLE = /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s]+\.ics$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};
const resp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return resp(405, { erro: 'Método não suportado' });
  const u = new URL(req.url);
  const de = u.searchParams.get('de') ?? '', ate = u.searchParams.get('ate') ?? '';
  if (!DATA.test(de) || !DATA.test(ate) || de > ate) return resp(400, { erro: 'Datas inválidas' });
  if ((Date.parse(ate) - Date.parse(de)) / 86400000 > 70) return resp(400, { erro: 'Intervalo demasiado grande' });
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+/.test(auth)) return resp(401, { erro: 'Sessão em falta' });

  const r = await fetch(BASE + '/rest/v1/config?select=google_ics', { headers: { apikey: CHAVE, Authorization: auth } });
  if (r.status === 401 || r.status === 403) return resp(401, { erro: 'Sessão inválida' });
  if (!r.ok) return resp(502, { erro: 'Não foi possível ler os teus ajustes' });
  const linhas = await r.json();
  const url = linhas && linhas[0] && linhas[0].google_ics;
  if (!url) return resp(200, { ligado: false, eventos: [] });
  if (!GOOGLE.test(url)) return resp(400, { erro: 'Endereço do Google Calendar inválido' });

  let texto: string;
  try {
    const g = await fetch(url, { headers: { Accept: 'text/calendar' }, signal: AbortSignal.timeout(10000) });
    if (!g.ok) return resp(502, { erro: g.status === 404 ? 'O Google não reconhece este endereço (foi renovado?)' : 'O Google não respondeu' });
    texto = await g.text();
  } catch (_e) {
    return resp(504, { erro: 'O Google demorou demasiado a responder' });
  }
  try {
    return resp(200, { ligado: true, eventos: expandir(ICAL, texto, de, ate) });
  } catch (_e) {
    return resp(502, { erro: 'Não foi possível ler o calendário do Google' });
  }
});
