-- =====================================================================
-- FINANÇAS GPP · v1.9 · Fixas de valor variável (água, luz, gás…)
-- - despesas_recorrentes.variavel: o valor é uma estimativa
-- - despesas.estimado: gasto gerado com a estimativa, "por confirmar" até
--   escreveres o valor da fatura
-- - ao confirmar, a estimativa da fixa passa a ser a média das últimas 3 faturas
-- Idempotente.
-- =====================================================================

alter table public.despesas_recorrentes add column if not exists variavel boolean not null default false;
alter table public.despesas add column if not exists estimado boolean not null default false;
create index if not exists despesas_estimado_idx on public.despesas (owner) where estimado;

-- Igual à v1.7, mas o gasto de uma fixa variável entra como estimado
create or replace function public.gerar_recorrentes(p_mes date default public.hoje_lisboa())
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  m  date := date_trunc('month', p_mes::timestamp)::date;
  ud int  := extract(day from (m + interval '1 month - 1 day'))::int;
  n  int;
begin
  if m > date_trunc('month', public.hoje_lisboa()::timestamp)::date then
    return 0;
  end if;
  with novos as (
    insert into public.recorrentes_geradas (owner, recorrente_id, mes)
    select r.owner, r.id, m
    from public.despesas_recorrentes r
    left join public.contas p on p.owner = r.owner and p.principal
    where r.owner = auth.uid()
      and r.ativa
      and r.inicio <= (m + interval '1 month - 1 day')::date
      and (r.fim is null or r.fim >= m)
      and (r.para_conta_id is null or coalesce(r.conta_id, p.id) is distinct from r.para_conta_id)
      and (r.para_conta_id is null or coalesce(r.conta_id, p.id) is not null)
    on conflict do nothing
    returning recorrente_id
  ),
  gastos as (
    insert into public.despesas (owner, data, valor, descricao, categoria, partilhada, parte_dela, recebido, origem, recorrente_id, conta_id, estimado)
    select r.owner, m + (least(r.dia_vencimento, ud) - 1), r.valor, r.nome, r.categoria,
           r.partilhada, case when r.partilhada then r.parte_dela end, false, 'recorrente', r.id, r.conta_id, r.variavel
    from public.despesas_recorrentes r
    join novos n on n.recorrente_id = r.id
    where r.para_conta_id is null
    returning 1
  ),
  transf as (
    insert into public.transferencias (owner, de_conta, para_conta, valor, data, nota, recorrente_id)
    select r.owner, coalesce(r.conta_id, p.id), r.para_conta_id, r.valor, m + (least(r.dia_vencimento, ud) - 1), r.nome, r.id
    from public.despesas_recorrentes r
    join novos n on n.recorrente_id = r.id
    left join public.contas p on p.owner = r.owner and p.principal
    where r.para_conta_id is not null
    returning 1
  )
  select (select count(*) from gastos) + (select count(*) from transf) into n;
  return n;
end $$;
revoke execute on function public.gerar_recorrentes(date) from public, anon;
grant  execute on function public.gerar_recorrentes(date) to authenticated;

-- Valor confirmado de uma fixa variável → nova estimativa = média das últimas 3 faturas
create or replace function public.atualizar_estimativa()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  update public.despesas_recorrentes r
     set valor = (select round(avg(x.valor), 2)
                  from (select d.valor from public.despesas d
                        where d.recorrente_id = r.id and not d.estimado
                        order by d.data desc, d.id desc limit 3) x)
   where r.id = new.recorrente_id and r.variavel;
  return null;
end $$;
create or replace trigger atualizar_estimativa after insert or update of valor, estimado on public.despesas
  for each row when (new.recorrente_id is not null and not new.estimado)
  execute function public.atualizar_estimativa();
revoke execute on function public.atualizar_estimativa() from public, anon;

-- Próximos pagamentos: mesmas colunas + variavel no fim
create or replace view public.proximos_pagamentos with (security_invoker = true) as
select r.id as recorrente_id, r.nome, r.valor, r.partilhada, r.categoria, r.debito_direto,
       coalesce(r.conta_id, p.id) as conta_id, r.para_conta_id,
       (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date as data_vencimento,
       r.variavel
from public.despesas_recorrentes r
left join public.contas p on p.owner = r.owner and p.principal
cross join lateral (
  select generate_series(date_trunc('month', public.hoje_lisboa()::timestamp),
                         date_trunc('month', public.hoje_lisboa()::timestamp) + interval '2 months',
                         interval '1 month')::date as mes
) m
where r.owner = auth.uid()
  and r.ativa
  and (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date
      between greatest(public.hoje_lisboa(), r.inicio) and coalesce(r.fim, 'infinity'::date);
revoke all on public.proximos_pagamentos from anon;
grant select on public.proximos_pagamentos to authenticated;

-- Feed: pagamentos levam "variavel" (o .ics mostra ≈ antes do valor)
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
             'parte_dela', r.parte_dela, 'debito_direto', r.debito_direto, 'variavel', r.variavel,
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
