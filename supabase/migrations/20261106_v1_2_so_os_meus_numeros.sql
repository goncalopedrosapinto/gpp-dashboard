-- =====================================================================
-- FINANÇAS GPP · v1.2 · "Só os meus números"
-- - Sai a divisão proporcional da base de dados (fica só na Calculadora)
-- - Ganhos passam a lançamentos (salário, comissões, prémios, outros)
-- - Conta partilhada = total que pagaste + parte dela + se já recebeste
-- Idempotente.
-- =====================================================================

-- ---------- Remover o modelo antigo (só se estiver vazio) ----------
do $$ begin
  if to_regclass('public.rendimentos') is not null and exists (select 1 from public.rendimentos) then
    raise exception 'rendimentos tem dados: migração cancelada';
  end if;
end $$;

drop view if exists public.divisao_mensal;
drop function if exists public.dividir(numeric, date);
drop function if exists public.proporcao_do_mes(date);
do $$ begin
  if to_regtype('public.pessoa') is not null then
    execute 'drop function if exists public.definir_rendimento(date, public.pessoa, numeric)';
  end if;
end $$;
drop table if exists public.rendimentos;
alter table public.despesas             drop column if exists pago_por;
alter table public.despesas_recorrentes drop column if exists pago_por;
drop type if exists public.pessoa;

-- ---------- Contas partilhadas ----------
alter table public.despesas
  add column if not exists parte_dela numeric(10,2),
  add column if not exists recebido   boolean not null default false;
alter table public.despesas_recorrentes
  add column if not exists parte_dela numeric(10,2);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'despesas_parte_dela_ck') then
    alter table public.despesas add constraint despesas_parte_dela_ck
      check (parte_dela is null or (parte_dela >= 0 and parte_dela <= valor));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recorrentes_parte_dela_ck') then
    alter table public.despesas_recorrentes add constraint recorrentes_parte_dela_ck
      check (parte_dela is null or (parte_dela >= 0 and parte_dela <= valor));
  end if;
end $$;

create index if not exists despesas_a_receber_idx on public.despesas (owner) where partilhada and not recebido;

-- ---------- Ganhos ----------
create table if not exists public.ganhos (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data       date not null default public.hoje_lisboa(),
  mes        date generated always as (date_trunc('month', data::timestamp)::date) stored,
  valor      numeric(10,2) not null check (valor > 0),
  descricao  text,
  categoria  text,
  criado_em  timestamptz not null default now()
);
create index if not exists ganhos_owner_mes_idx on public.ganhos (owner, mes);

alter table public.ganhos enable row level security;
drop policy if exists dono on public.ganhos;
create policy dono on public.ganhos for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
revoke all on public.ganhos from anon;
grant select, insert, update, delete on public.ganhos to authenticated;

-- ---------- Configuração ----------
alter table public.config
  add column if not exists calc_eu  numeric(10,2) check (calc_eu  is null or calc_eu  >= 0),
  add column if not exists calc_ela numeric(10,2) check (calc_ela is null or calc_ela >= 0);
alter table public.config alter column nome_ela set default 'Bia';
update public.config set nome_ela = 'Bia' where nome_ela is null;

-- ---------- Funções que usavam pago_por ----------
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
    where r.owner = auth.uid()
      and r.ativa
      and r.inicio <= (m + interval '1 month - 1 day')::date
      and (r.fim is null or r.fim >= m)
    on conflict do nothing
    returning recorrente_id
  )
  insert into public.despesas (owner, data, valor, descricao, categoria, partilhada, parte_dela, recebido, origem, recorrente_id)
  select r.owner, m + (least(r.dia_vencimento, ud) - 1), r.valor, r.nome, r.categoria,
         r.partilhada, case when r.partilhada then r.parte_dela end, false, 'recorrente', r.id
  from public.despesas_recorrentes r
  join novos n on n.recorrente_id = r.id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.registar_apple_pay(
  token text, valor text, comerciante text default null, cartao text default null
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_part  boolean;
  v_cat   text;
  v_rpart boolean;
  v_txt   text;
  v_valor numeric;
  v_com   text := nullif(trim(registar_apple_pay.comerciante), '');
  v_id    bigint;
begin
  select c.owner, c.apple_pay_partilhada_default into v_owner, v_part
  from public.config c where c.token_atalho = registar_apple_pay.token;
  if v_owner is null then
    raise exception 'token inválido' using errcode = '28000';
  end if;

  v_txt := regexp_replace(coalesce(registar_apple_pay.valor, ''), '[^0-9,.]', '', 'g');
  if v_txt !~ '[0-9]' then
    raise exception 'valor inválido: %', registar_apple_pay.valor;
  end if;
  if v_txt ~ ',[0-9]{1,2}$' then
    v_txt := replace(replace(v_txt, '.', ''), ',', '.');
  else
    v_txt := replace(v_txt, ',', '');
  end if;
  v_valor := round(v_txt::numeric, 2);
  if v_valor <= 0 then
    raise exception 'valor inválido: %', registar_apple_pay.valor;
  end if;

  select rc.categoria, rc.partilhada into v_cat, v_rpart
  from public.regras_comerciante rc
  where rc.owner = v_owner and rc.chave = public.chave_comerciante(v_com);

  insert into public.despesas (owner, valor, comerciante, descricao, categoria, origem, cartao, partilhada)
  values (v_owner, v_valor, v_com, v_com, v_cat, 'apple_pay',
          nullif(trim(registar_apple_pay.cartao), ''), coalesce(v_rpart, v_part))
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.gerar_recorrentes(date) from public, anon;
grant  execute on function public.gerar_recorrentes(date) to authenticated;
revoke execute on function public.registar_apple_pay(text, text, text, text) from public, anon, authenticated;
grant  execute on function public.registar_apple_pay(text, text, text, text) to anon;
