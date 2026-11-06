-- =====================================================================
-- FINANÇAS GPP · v1.8 · Eventos de vários dias e plafond dos cartões
-- - eventos.data_fim: último dia do evento (igual a data num evento de um dia)
-- - Com data_fim > data, a hora de fim pode ser "antes" da de início (20:00 sex → 10:00 dom)
-- - Ao mudar só a data de início, o fim acompanha (mantém a duração)
-- Idempotente.
-- =====================================================================

alter table public.eventos add column if not exists data_fim date;
update public.eventos set data_fim = data where data_fim is null;
alter table public.eventos alter column data_fim set not null;

-- A regra antiga (hora_fim > hora_inicio) só vale para eventos de um dia
do $$
declare r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'public.eventos'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%hora_fim > hora_inicio%'
             and conname <> 'eventos_horas_ck'
  loop
    execute format('alter table public.eventos drop constraint %I', r.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'eventos_horas_ck') then
    alter table public.eventos add constraint eventos_horas_ck
      check (hora_fim is null or hora_inicio is null or data_fim > data or hora_fim > hora_inicio);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eventos_data_fim_ck') then
    alter table public.eventos add constraint eventos_data_fim_ck
      check (data_fim >= data and data_fim <= data + 366);
  end if;
end $$;

create index if not exists eventos_owner_fim_idx on public.eventos (owner, data_fim);

create or replace function public.tocar_atualizado_em()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.atualizado_em := now();
  if new.dia_inteiro then new.hora_inicio := null; new.hora_fim := null; end if;
  -- mudar só o início arrasta o fim (mesma duração)
  if tg_op = 'UPDATE' and new.data is distinct from old.data and new.data_fim is not distinct from old.data_fim then
    new.data_fim := old.data_fim + (new.data - old.data);
  end if;
  if new.data_fim is null then new.data_fim := new.data; end if;
  return new;
end $$;

-- Feed: um evento de vários dias sai do feed 90 dias depois de acabar (não de começar)
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
      and (e.repete <> 'nunca' or e.data_fim >= public.hoje_lisboa() - 90);
  end if;

  if p_agenda is null or p_agenda = 'pagamentos' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', r.id, 'nome', r.nome, 'valor', r.valor, 'partilhada', r.partilhada,
             'parte_dela', r.parte_dela, 'debito_direto', r.debito_direto,
             'conta', coalesce(c.nome, p.nome), 'para', d.nome, 'transferencia', r.para_conta_id is not null,
             'data', x.data) order by x.data), '[]'::jsonb) into v_pag
    from public.despesas_recorrentes r
    left join public.contas c on c.id = r.conta_id
    left join public.contas p on p.owner = r.owner and p.principal
    left join public.contas d on d.id = r.para_conta_id
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

-- ---------- Plafond dos cartões de crédito ----------
alter table public.contas add column if not exists plafond numeric(12,2);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contas_plafond_ck') then
    alter table public.contas add constraint contas_plafond_ck check (plafond is null or plafond >= 0);
  end if;
end $$;

-- mesmas colunas de antes + plafond e disponivel no fim (create or replace só acrescenta)
create or replace view public.saldos_contas with (security_invoker = true) as
select c.id as conta_id, c.nome, c.tipo, c.principal, c.ordem,
       a.saldo as saldo_ajuste, a.data as data_ajuste,
       coalesce(a.saldo, 0) + coalesce(sum(m.valor) filter (where m.data <= public.hoje_lisboa()), 0) as saldo_atual,
       coalesce(a.saldo, 0) + coalesce(sum(m.valor), 0) as saldo_previsto,
       c.plafond,
       case when c.tipo = 'credito' and c.plafond is not null
            then c.plafond + coalesce(a.saldo, 0) + coalesce(sum(m.valor) filter (where m.data <= public.hoje_lisboa()), 0) end as disponivel
from public.contas c
left join lateral (
  select x.saldo, x.data, x.criado_em from public.ajustes_saldo x
  where x.conta_id = c.id order by x.data desc, x.criado_em desc limit 1
) a on true
left join public.movimentos m
  on m.conta_id = c.id
 and (a.data is null or m.data > a.data or (m.data = a.data and m.marca > a.criado_em))
where c.owner = auth.uid() and c.ativa
group by c.id, c.nome, c.tipo, c.principal, c.ordem, c.plafond, a.saldo, a.data;
revoke all on public.saldos_contas from anon;
grant select on public.saldos_contas to authenticated;
