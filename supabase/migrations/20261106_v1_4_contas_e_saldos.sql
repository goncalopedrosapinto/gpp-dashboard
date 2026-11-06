-- =====================================================================
-- FINANÇAS GPP · v1.4 · Contas e saldos
-- - Contas (à ordem, poupança, outra), uma principal
-- - Saldo = último ajuste ao valor real + movimentos posteriores
-- - Movimentos: ganhos (+), gastos (−), o que a Bia devolve (+), transferências
-- - Gastos/ganhos sem conta vão para a conta principal
-- Idempotente.
-- =====================================================================

-- ---------- Tabelas ----------
create table if not exists public.contas (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome       text not null check (char_length(nome) between 1 and 40),
  tipo       text not null default 'corrente' check (tipo in ('corrente', 'poupanca', 'outra')),
  principal  boolean not null default false,
  ordem      smallint not null default 0,
  ativa      boolean not null default true,
  criado_em  timestamptz not null default now()
);
create unique index if not exists contas_uma_principal on public.contas (owner) where principal;
create index if not exists contas_owner_idx on public.contas (owner);

-- O saldo real numa data. O mais recente manda.
create table if not exists public.ajustes_saldo (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  conta_id   bigint not null references public.contas(id) on delete cascade,
  data       date not null default public.hoje_lisboa(),
  saldo      numeric(12,2) not null,
  nota       text,
  criado_em  timestamptz not null default now()
);
create index if not exists ajustes_conta_idx on public.ajustes_saldo (conta_id, data desc, criado_em desc);
create index if not exists ajustes_owner_idx on public.ajustes_saldo (owner);

create table if not exists public.transferencias (
  id         bigint generated always as identity primary key,
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  de_conta   bigint not null references public.contas(id) on delete cascade,
  para_conta bigint not null references public.contas(id) on delete cascade,
  valor      numeric(12,2) not null check (valor > 0),
  data       date not null default public.hoje_lisboa(),
  nota       text,
  criado_em  timestamptz not null default now(),
  check (de_conta <> para_conta)
);
create index if not exists transf_owner_idx on public.transferencias (owner);
create index if not exists transf_de_idx on public.transferencias (de_conta);
create index if not exists transf_para_idx on public.transferencias (para_conta);

alter table public.despesas
  add column if not exists conta_id    bigint references public.contas(id) on delete set null,
  add column if not exists recebido_em timestamptz;
alter table public.ganhos
  add column if not exists conta_id    bigint references public.contas(id) on delete set null;
create index if not exists despesas_conta_idx on public.despesas (conta_id);
create index if not exists ganhos_conta_idx on public.ganhos (conta_id);

-- Quando a Bia paga, o dinheiro entra nesse momento
create or replace function public.marcar_recebido_em()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.partilhada and new.recebido then
    if tg_op = 'INSERT' or not coalesce(old.recebido, false) or not coalesce(old.partilhada, false) then
      new.recebido_em := coalesce(new.recebido_em, now());
    end if;
  else
    new.recebido_em := null;
  end if;
  return new;
end $$;
drop trigger if exists marcar_recebido_em on public.despesas;
create trigger marcar_recebido_em before insert or update on public.despesas
  for each row execute function public.marcar_recebido_em();

update public.despesas set recebido_em = data::timestamptz
where partilhada and recebido and recebido_em is null;

-- ---------- Movimentos e saldos ----------
create or replace view public.movimentos with (security_invoker = true) as
with p as (select owner, id from public.contas where principal)
select g.owner, coalesce(g.conta_id, p.id) as conta_id, g.data, g.criado_em as marca,
       g.valor::numeric as valor, 'ganho'::text as tipo, g.descricao
from public.ganhos g left join p on p.owner = g.owner
union all
select d.owner, coalesce(d.conta_id, p.id), d.data, d.criado_em,
       -d.valor, 'gasto', coalesce(d.descricao, d.comerciante)
from public.despesas d left join p on p.owner = d.owner
union all
select d.owner, coalesce(d.conta_id, p.id), (d.recebido_em at time zone 'Europe/Lisbon')::date, d.recebido_em,
       d.parte_dela, 'recebido', coalesce(d.descricao, d.comerciante)
from public.despesas d left join p on p.owner = d.owner
where d.partilhada and d.recebido and d.parte_dela is not null and d.recebido_em is not null
union all
select t.owner, t.de_conta, t.data, t.criado_em, -t.valor, 'transferencia', t.nota from public.transferencias t
union all
select t.owner, t.para_conta, t.data, t.criado_em, t.valor, 'transferencia', t.nota from public.transferencias t;

-- saldo_atual: até hoje · saldo_previsto: inclui o que já está lançado com data futura (ex.: fixas a vencer)
-- Regra: um ajuste no dia D já inclui os movimentos com data anterior a D; do próprio dia D
-- só contam os registados depois do ajuste.
create or replace view public.saldos_contas with (security_invoker = true) as
select c.id as conta_id, c.nome, c.tipo, c.principal, c.ordem,
       a.saldo as saldo_ajuste, a.data as data_ajuste,
       coalesce(a.saldo, 0) + coalesce(sum(m.valor) filter (where m.data <= public.hoje_lisboa()), 0) as saldo_atual,
       coalesce(a.saldo, 0) + coalesce(sum(m.valor), 0) as saldo_previsto
from public.contas c
left join lateral (
  select x.saldo, x.data, x.criado_em from public.ajustes_saldo x
  where x.conta_id = c.id order by x.data desc, x.criado_em desc limit 1
) a on true
left join public.movimentos m
  on m.conta_id = c.id
 and (a.data is null or m.data > a.data or (m.data = a.data and m.marca > a.criado_em))
where c.owner = auth.uid() and c.ativa
group by c.id, c.nome, c.tipo, c.principal, c.ordem, a.saldo, a.data;

-- ---------- Ações ----------
create or replace function public.criar_conta(p_nome text, p_tipo text, p_saldo numeric, p_principal boolean default false)
returns bigint language plpgsql security invoker set search_path = '' as $$
declare v_id bigint; v_principal boolean;
begin
  v_principal := p_principal or not exists (select 1 from public.contas where owner = auth.uid() and principal);
  if v_principal then
    update public.contas set principal = false where owner = auth.uid() and principal;
  end if;
  insert into public.contas (owner, nome, tipo, principal, ordem)
  values (auth.uid(), trim(p_nome), coalesce(p_tipo, 'corrente'), v_principal,
          coalesce((select max(ordem) + 1 from public.contas where owner = auth.uid()), 0))
  returning id into v_id;
  if p_saldo is not null then
    insert into public.ajustes_saldo (owner, conta_id, saldo, nota) values (auth.uid(), v_id, p_saldo, 'Saldo inicial');
  end if;
  return v_id;
end $$;

-- Acerta a conta ao valor real; devolve a diferença face ao que a app calculava
create or replace function public.ajustar_saldo(p_conta bigint, p_saldo numeric)
returns numeric language plpgsql security invoker set search_path = '' as $$
declare v_antes numeric;
begin
  if not exists (select 1 from public.contas where id = p_conta and owner = auth.uid()) then
    raise exception 'conta inexistente';
  end if;
  select saldo_atual into v_antes from public.saldos_contas where conta_id = p_conta;
  insert into public.ajustes_saldo (owner, conta_id, saldo, nota) values (auth.uid(), p_conta, p_saldo, 'Ajuste');
  return p_saldo - coalesce(v_antes, 0);
end $$;

create or replace function public.definir_principal(p_conta bigint)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (select 1 from public.contas where id = p_conta and owner = auth.uid()) then
    raise exception 'conta inexistente';
  end if;
  update public.contas set principal = false where owner = auth.uid() and principal and id <> p_conta;
  update public.contas set principal = true where id = p_conta;
end $$;

-- ---------- Segurança ----------
do $$
declare t text;
begin
  foreach t in array array['contas', 'ajustes_saldo', 'transferencias'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists dono on public.%I', t);
    execute format('create policy dono on public.%I for all to authenticated
                    using (owner = (select auth.uid())) with check (owner = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Transferências só entre contas do próprio
create or replace function public.validar_transferencia()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (select count(*) from public.contas where id in (new.de_conta, new.para_conta) and owner = new.owner) <> 2 then
    raise exception 'contas inválidas';
  end if;
  return new;
end $$;
drop trigger if exists validar_transferencia on public.transferencias;
create trigger validar_transferencia before insert or update on public.transferencias
  for each row execute function public.validar_transferencia();

revoke all on public.movimentos, public.saldos_contas from anon;
grant select on public.movimentos, public.saldos_contas to authenticated;

revoke execute on function
  public.criar_conta(text, text, numeric, boolean), public.ajustar_saldo(bigint, numeric),
  public.definir_principal(bigint), public.marcar_recebido_em(), public.validar_transferencia()
from public, anon;
grant execute on function
  public.criar_conta(text, text, numeric, boolean), public.ajustar_saldo(bigint, numeric), public.definir_principal(bigint)
to authenticated;
