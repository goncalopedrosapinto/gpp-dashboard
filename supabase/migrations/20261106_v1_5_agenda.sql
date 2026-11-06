-- =====================================================================
-- FINANÇAS GPP · v1.5 · Agenda própria
-- - Eventos com agenda (pessoal, trabalho, Bia, outro), hora, repetição e alerta
-- - calendario_dados(token, agenda): o que o feed .ics do iPhone publica
--   (eventos + pagamentos das despesas fixas nos próximos 12 meses)
-- Idempotente.
-- =====================================================================

create table if not exists public.eventos (
  id            bigint generated always as identity primary key,
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  titulo        text not null check (char_length(titulo) between 1 and 120),
  agenda        text not null default 'pessoal' check (agenda in ('pessoal', 'trabalho', 'bia', 'outro')),
  data          date not null default public.hoje_lisboa(),
  dia_inteiro   boolean not null default false,
  hora_inicio   time,
  hora_fim      time,
  repete        text not null default 'nunca' check (repete in ('nunca', 'semanal', 'mensal', 'anual')),
  alerta_min    integer check (alerta_min is null or alerta_min between 0 and 10080),
  local         text check (local is null or char_length(local) <= 200),
  notas         text check (notas is null or char_length(notas) <= 2000),
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  check (dia_inteiro or hora_inicio is not null),
  check (hora_fim is null or hora_inicio is null or hora_fim > hora_inicio)
);
create index if not exists eventos_owner_data_idx on public.eventos (owner, data);
create index if not exists eventos_owner_repete_idx on public.eventos (owner) where repete <> 'nunca';

create or replace function public.tocar_atualizado_em()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.atualizado_em := now();
  if new.dia_inteiro then new.hora_inicio := null; new.hora_fim := null; end if;
  return new;
end $$;
drop trigger if exists tocar_atualizado_em on public.eventos;
create trigger tocar_atualizado_em before insert or update on public.eventos
  for each row execute function public.tocar_atualizado_em();

alter table public.eventos enable row level security;
drop policy if exists dono on public.eventos;
create policy dono on public.eventos for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
revoke all on public.eventos from anon;
grant select, insert, update, delete on public.eventos to authenticated;

-- ---------- Dados do feed (anónimo, protegido pelo token_calendario) ----------
-- p_agenda: null = tudo; 'pessoal' | 'trabalho' | 'bia' | 'outro' | 'pagamentos'
create or replace function public.calendario_dados(token text, p_agenda text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_nome  text;
  v_ev    jsonb := '[]'::jsonb;
  v_pag   jsonb := '[]'::jsonb;
begin
  select c.owner, coalesce(nullif(trim(c.nome_ela), ''), 'Bia') into v_owner, v_nome
  from public.config c where c.token_calendario = calendario_dados.token;
  if v_owner is null then
    raise exception 'token inválido' using errcode = '28000';
  end if;
  if p_agenda is not null and p_agenda not in ('pessoal', 'trabalho', 'bia', 'outro', 'pagamentos') then
    raise exception 'agenda inválida';
  end if;

  if p_agenda is distinct from 'pagamentos' then
    select coalesce(jsonb_agg(to_jsonb(e) - 'owner' order by e.data, e.hora_inicio), '[]'::jsonb) into v_ev
    from public.eventos e
    where e.owner = v_owner
      and (p_agenda is null or e.agenda = p_agenda)
      and (e.repete <> 'nunca' or e.data >= public.hoje_lisboa() - 90);
  end if;

  if p_agenda is null or p_agenda = 'pagamentos' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', r.id, 'nome', r.nome, 'valor', r.valor, 'partilhada', r.partilhada,
             'parte_dela', r.parte_dela, 'data', x.data) order by x.data), '[]'::jsonb) into v_pag
    from public.despesas_recorrentes r
    cross join lateral (
      select (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date as data
      from (select generate_series(date_trunc('month', public.hoje_lisboa()::timestamp),
                                   date_trunc('month', public.hoje_lisboa()::timestamp) + interval '11 months',
                                   interval '1 month')::date as mes) m
    ) x
    where r.owner = v_owner and r.ativa
      and x.data >= r.inicio and (r.fim is null or x.data <= r.fim);
  end if;

  return jsonb_build_object('nome_ela', v_nome, 'eventos', v_ev, 'pagamentos', v_pag);
end $$;

revoke execute on function public.calendario_dados(text, text) from public, authenticated;
grant execute on function public.calendario_dados(text, text) to anon;
revoke execute on function public.tocar_atualizado_em() from public, anon;

-- Gerar um token novo (ex.: se o link do calendário for partilhado sem querer)
create or replace function public.renovar_token_calendario()
returns text language plpgsql security invoker set search_path = '' as $$
declare v text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
begin
  update public.config set token_calendario = v where owner = auth.uid();
  return v;
end $$;
revoke execute on function public.renovar_token_calendario() from public, anon;
grant execute on function public.renovar_token_calendario() to authenticated;
