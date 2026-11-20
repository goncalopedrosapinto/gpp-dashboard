-- =====================================================================
-- GPP DASHBOARD · v3.0 · Life Management System — semana 1: captura e logs
-- - tarefas: caixa de entrada (sem data) e tarefas com data
-- - registos: o log de cada departamento (escrito sobretudo pela app)
-- - ler_data_pt: "amanhã", "sexta", "dia 12", "em 3 dias", "12/12"… → data
-- - nova_tarefa(texto): captura dentro da app
-- - capturar(token, texto): captura pelo Atalho (botão Action), protegido pelo token_atalho
-- - config.google_ics: endereço secreto iCal do Google Calendar (só leitura)
-- Sem DROP.
-- =====================================================================

create table if not exists public.tarefas (
  id        bigint generated always as identity primary key,
  owner     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  texto     text not null check (char_length(trim(texto)) between 1 and 300),
  data      date,
  feita     boolean not null default false,
  feita_em  timestamptz,
  origem    text not null default 'app' check (origem in ('app', 'atalho')),
  criada_em timestamptz not null default now()
);
create index if not exists tarefas_owner_idx on public.tarefas (owner, feita, data);

create table if not exists public.registos (
  id           bigint generated always as identity primary key,
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  em           timestamptz not null default now(),
  departamento text not null check (departamento in ('operacoes', 'financas', 'carreira', 'saude', 'casa', 'claude')),
  tipo         text not null default 'evento' check (tipo in ('evento', 'decisao', 'feedback', 'revisao', 'alerta')),
  texto        text not null check (char_length(trim(texto)) between 1 and 500),
  origem       text not null default 'tu' check (origem in ('app', 'tu', 'claude'))
);
create index if not exists registos_owner_idx on public.registos (owner, departamento, em desc);

do $$
declare t text;
begin
  foreach t in array array['tarefas', 'registos'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'dono') then
      execute format('create policy dono on public.%I for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()))', t);
    end if;
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

alter table public.config add column if not exists google_ics text
  check (google_ics is null or (char_length(google_ics) <= 500 and google_ics ~ '^https://calendar\.google\.com/calendar/ical/[^\s]+\.ics$'));

-- ---------- Datas em português ----------
create or replace function public.ler_data_pt(p_texto text, p_hoje date)
returns date language plpgsql immutable set search_path = '' as $$
declare
  t text := lower(coalesce(p_texto, ''));
  m text[];
  meses text[] := array['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  dias  text[] := array['segunda','terca','quarta','quinta','sexta','sabado','domingo'];
  d int; mes int; ano int; alvo int; r date;
begin
  t := translate(t, 'áàâãçéêíóôõú', 'aaaaceeiooou');
  if t ~ 'depois de amanha' then return p_hoje + 2; end if;
  if t ~ '\mamanha\M' then return p_hoje + 1; end if;
  if t ~ '\mhoje\M' then return p_hoje; end if;
  m := regexp_match(t, '\mem (\d{1,3}) dias?\M');
  if m is not null then return p_hoje + m[1]::int; end if;
  m := regexp_match(t, '\mdia (\d{1,2})(?: de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro))?\M');
  if m is null then
    m := regexp_match(t, '\m(\d{1,2})/(\d{1,2})\M');
    if m is not null then
      m := case when m[2]::int between 1 and 12 then array[m[1], meses[m[2]::int]] end;
    end if;
  end if;
  if m is not null then
    d := m[1]::int;
    if d between 1 and 31 then
      ano := extract(year from p_hoje)::int;
      if m[2] is not null then
        mes := array_position(meses, m[2]);
        if mes is null then return null; end if;
      else
        mes := extract(month from p_hoje)::int;
      end if;
      r := make_date(ano, mes, 1);
      r := r + (least(d, extract(day from (r + interval '1 month' - interval '1 day'))::int) - 1);
      if r < p_hoje then
        r := make_date(ano, mes, 1) + (case when m[2] is not null then interval '1 year' else interval '1 month' end);
        r := r + (least(d, extract(day from (r + interval '1 month' - interval '1 day'))::int) - 1);
      end if;
      return r;
    end if;
  end if;
  if t ~ '\mproxima semana\M' then return p_hoje + (8 - extract(isodow from p_hoje)::int); end if;
  m := regexp_match(t, '\m(segunda|terca|quarta|quinta|sexta|sabado|domingo)\M');
  if m is not null then
    alvo := array_position(dias, m[1]);
    d := (alvo - extract(isodow from p_hoje)::int + 7) % 7;
    return p_hoje + (case when d = 0 then 7 else d end);
  end if;
  return null;
end $$;

-- ---------- Log automático das tarefas ----------
create or replace function public.tarefas_antes()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.feita and (tg_op = 'INSERT' or not old.feita) then new.feita_em := now(); end if;
  if not new.feita then new.feita_em := null; end if;
  return new;
end $$;
create or replace trigger tarefas_antes before insert or update on public.tarefas
  for each row execute function public.tarefas_antes();

create or replace function public.tarefas_registo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.registos (owner, departamento, tipo, texto, origem)
    values (new.owner, 'operacoes', 'evento', left((case when new.origem = 'atalho' then 'Capturada pelo Atalho: ' else 'Capturada: ' end) || new.texto, 500), 'app');
  elsif new.feita and not old.feita then
    insert into public.registos (owner, departamento, tipo, texto, origem)
    values (new.owner, 'operacoes', 'evento', left('Feita: ' || new.texto, 500), 'app');
  end if;
  return null;
end $$;
create or replace trigger tarefas_registo after insert or update of feita on public.tarefas
  for each row execute function public.tarefas_registo();
revoke execute on function public.tarefas_registo() from public, anon, authenticated;

-- ---------- Captura ----------
-- Dentro da app (sessão iniciada)
create or replace function public.nova_tarefa(p_texto text)
returns public.tarefas language plpgsql set search_path = '' as $$
declare r public.tarefas;
begin
  if char_length(trim(coalesce(p_texto, ''))) = 0 then raise exception 'Escreve a tarefa.' using errcode = '22023'; end if;
  insert into public.tarefas (texto, data, origem)
  values (left(trim(p_texto), 300), public.ler_data_pt(p_texto, public.hoje_lisboa()), 'app')
  returning * into r;
  return r;
end $$;
revoke execute on function public.nova_tarefa(text) from public, anon;
grant  execute on function public.nova_tarefa(text) to authenticated;

-- Atalho do iPhone (botão Action): POST /rest/v1/rpc/capturar {"token": "...", "texto": "Ligar ao seguro amanhã"}
create or replace function public.capturar(token text, texto text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_data date; v_hoje date := public.hoje_lisboa(); v_txt text := trim(coalesce(capturar.texto, ''));
begin
  select c.owner into v_owner from public.config c where c.token_atalho = capturar.token;
  if v_owner is null then raise exception 'token inválido' using errcode = '28000'; end if;
  if char_length(v_txt) = 0 then return 'Nada para guardar'; end if;
  v_data := public.ler_data_pt(v_txt, v_hoje);
  insert into public.tarefas (owner, texto, data, origem) values (v_owner, left(v_txt, 300), v_data, 'atalho');
  return case
    when v_data is null then 'Guardado na caixa de entrada'
    when v_data = v_hoje then 'Guardado para hoje'
    when v_data = v_hoje + 1 then 'Guardado para amanhã'
    else 'Guardado para ' || to_char(v_data, 'DD/MM') end;
end $$;
revoke execute on function public.capturar(text, text) from public, authenticated;
grant  execute on function public.capturar(text, text) to anon;

revoke execute on function public.ler_data_pt(text, date) from public, anon;
grant  execute on function public.ler_data_pt(text, date) to authenticated;
