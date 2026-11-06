-- =====================================================================
-- FINANÇAS GPP · Base de dados v1.1 (Supabase / Postgres 15+)
-- Rendimentos, despesas, despesas fixas, divisão proporcional, Apple Pay
-- Pode ser corrido mais do que uma vez (idempotente).
-- =====================================================================

-- ---------- Tipos e utilitários ----------
do $$ begin
  create type public.pessoa as enum ('eu', 'ela');
exception when duplicate_object then null; end $$;

-- Data "de hoje" em Lisboa (o servidor corre em UTC)
create or replace function public.hoje_lisboa()
returns date language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/Lisbon')::date
$$;

-- Normaliza o nome do comerciante: "  CONTINENTE   Aveiro " -> "continente aveiro"
create or replace function public.chave_comerciante(t text)
returns text language sql immutable set search_path = '' as $$
  select nullif(lower(regexp_replace(trim(coalesce(t, '')), '\s+', ' ', 'g')), '')
$$;

-- ---------- Tabelas ----------

-- Rendimento líquido de cada pessoa, por mês (1 linha por pessoa por mês)
create table if not exists public.rendimentos (
  id            bigint generated always as identity primary key,
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  mes           date not null check (mes = date_trunc('month', mes::timestamp)::date),
  pessoa        public.pessoa not null,
  valor_liquido numeric(10,2) not null check (valor_liquido >= 0),
  nota          text,
  criado_em     timestamptz not null default now(),
  unique (owner, mes, pessoa)
);

-- Despesas fixas: crédito, água, ginásio... Inseridas uma vez, geradas todos os meses.
create table if not exists public.despesas_recorrentes (
  id              bigint generated always as identity primary key,
  owner           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome            text not null,
  valor           numeric(10,2) not null check (valor > 0),
  dia_vencimento  smallint not null check (dia_vencimento between 1 and 31),
  categoria       text,
  partilhada      boolean not null default false,
  pago_por        public.pessoa not null default 'eu',
  ativa           boolean not null default true,
  inicio          date not null default public.hoje_lisboa(),
  fim             date,
  criado_em       timestamptz not null default now(),
  check (fim is null or fim >= inicio)
);

-- Todas as despesas: manuais, Apple Pay e as geradas a partir das fixas
create table if not exists public.despesas (
  id             bigint generated always as identity primary key,
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data           date not null default public.hoje_lisboa(),
  mes            date generated always as (date_trunc('month', data::timestamp)::date) stored,
  valor          numeric(10,2) not null check (valor > 0),
  descricao      text,
  comerciante    text,
  categoria      text,
  partilhada     boolean not null default false,
  pago_por       public.pessoa not null default 'eu',
  origem         text not null default 'manual' check (origem in ('manual', 'apple_pay', 'recorrente')),
  cartao         text,
  recorrente_id  bigint references public.despesas_recorrentes(id) on delete set null,
  criado_em      timestamptz not null default now()
);
create index if not exists despesas_owner_mes_idx on public.despesas (owner, mes);

-- Registo de que fixas já foram geradas em que mês.
-- Se apagares a despesa gerada, ela NÃO volta a aparecer nesse mês.
create table if not exists public.recorrentes_geradas (
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recorrente_id  bigint not null references public.despesas_recorrentes(id) on delete cascade,
  mes            date not null,
  primary key (recorrente_id, mes)
);

-- Regras aprendidas: quando corriges categoria/partilhada de um gasto Apple Pay,
-- os próximos gastos no mesmo comerciante já entram assim.
create table if not exists public.regras_comerciante (
  owner          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  chave          text not null,
  categoria      text,
  partilhada     boolean not null,
  atualizado_em  timestamptz not null default now(),
  primary key (owner, chave)
);

-- Configuração pessoal: tokens secretos do Atalho do iPhone e do calendário
create table if not exists public.config (
  owner                         uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  token_atalho                  text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  token_calendario              text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  apple_pay_partilhada_default  boolean not null default false
);
alter table public.config add column if not exists nome_ela text check (char_length(nome_ela) <= 40);
create index if not exists despesas_recorrente_idx on public.despesas (recorrente_id);
create index if not exists recorrentes_geradas_owner_idx on public.recorrentes_geradas (owner);
create index if not exists despesas_recorrentes_owner_idx on public.despesas_recorrentes (owner);

-- ---------- Divisão proporcional ----------

-- Calculadora pura: a parte dela é o resto, para a soma bater sempre certo ao cêntimo.
create or replace function public.calcular_divisao(valor numeric, rend_eu numeric, rend_ela numeric)
returns table (parte_eu numeric, parte_ela numeric, pct_eu numeric, pct_ela numeric)
language sql immutable set search_path = '' as $$
  select round(valor * rend_eu / nullif(rend_eu + rend_ela, 0), 2),
         valor - round(valor * rend_eu / nullif(rend_eu + rend_ela, 0), 2),
         round(100 * rend_eu / nullif(rend_eu + rend_ela, 0), 1),
         round(100 - 100 * rend_eu / nullif(rend_eu + rend_ela, 0), 1)
$$;

-- Proporção de um mês: rendimentos desse mês; se faltar algum,
-- usa o último mês completo anterior e marca como provisória.
create or replace function public.proporcao_do_mes(p_mes date)
returns table (mes_base date, rendimento_eu numeric, rendimento_ela numeric, fracao_eu numeric, provisoria boolean)
language sql stable security invoker set search_path = '' as $$
  with r as (
    select mes,
           sum(valor_liquido) filter (where pessoa = 'eu')  as eu,
           sum(valor_liquido) filter (where pessoa = 'ela') as ela
    from public.rendimentos
    where owner = auth.uid()
      and mes <= date_trunc('month', p_mes::timestamp)::date
    group by mes
  )
  select mes, eu, ela, eu / nullif(eu + ela, 0),
         mes <> date_trunc('month', p_mes::timestamp)::date
  from r
  where eu is not null and ela is not null and eu + ela > 0
  order by mes desc
  limit 1
$$;

-- Calculadora com os rendimentos guardados: dividir(30) -> quanto pago eu e quanto paga ela
create or replace function public.dividir(valor numeric, p_mes date default public.hoje_lisboa())
returns table (parte_eu numeric, parte_ela numeric, pct_eu numeric, mes_base date, provisoria boolean)
language sql stable security invoker set search_path = '' as $$
  select round(valor * p.fracao_eu, 2),
         valor - round(valor * p.fracao_eu, 2),
         round(100 * p.fracao_eu, 1),
         p.mes_base,
         p.provisoria
  from public.proporcao_do_mes(p_mes) p
$$;

-- Fecho do mês. saldo > 0 -> ela deve-te; saldo < 0 -> deves-lhe.
create or replace view public.divisao_mensal with (security_invoker = true) as
with partilhadas as (
  select mes,
         sum(valor)                                   as total,
         sum(valor) filter (where pago_por = 'eu')    as pago_eu,
         sum(valor) filter (where pago_por = 'ela')   as pago_ela
  from public.despesas
  where partilhada and owner = auth.uid()
  group by mes
)
select d.mes,
       p.rendimento_eu,
       p.rendimento_ela,
       round(100 * p.fracao_eu, 1)                              as pct_eu,
       round(100 - 100 * p.fracao_eu, 1)                        as pct_ela,
       p.mes_base,
       p.provisoria,
       d.total                                                  as total_partilhadas,
       round(d.total * p.fracao_eu, 2)                          as quota_eu,
       d.total - round(d.total * p.fracao_eu, 2)                as quota_ela,
       coalesce(d.pago_eu, 0)                                   as pago_eu,
       coalesce(d.pago_ela, 0)                                  as pago_ela,
       coalesce(d.pago_eu, 0) - round(d.total * p.fracao_eu, 2) as saldo
from partilhadas d
left join lateral public.proporcao_do_mes(d.mes) p on true;

-- ---------- Ações chamadas pela app ----------

-- Cria a configuração na primeira entrada e devolve-a
create or replace function public.garantir_config()
returns public.config language plpgsql security invoker set search_path = '' as $$
declare c public.config;
begin
  insert into public.config (owner) values (auth.uid()) on conflict (owner) do nothing;
  select * into c from public.config where owner = auth.uid();
  return c;
end $$;

-- Grava (ou apaga, com valor nulo) o rendimento líquido de uma pessoa num mês
create or replace function public.definir_rendimento(p_mes date, p_pessoa public.pessoa, p_valor numeric)
returns void language plpgsql security invoker set search_path = '' as $$
declare m date := date_trunc('month', p_mes::timestamp)::date;
begin
  if p_valor is null then
    delete from public.rendimentos where owner = auth.uid() and mes = m and pessoa = p_pessoa;
  else
    insert into public.rendimentos (owner, mes, pessoa, valor_liquido)
    values (auth.uid(), m, p_pessoa, p_valor)
    on conflict (owner, mes, pessoa) do update set valor_liquido = excluded.valor_liquido;
  end if;
end $$;

-- Gera as despesas fixas de um mês (atual ou passado). Pode ser chamada sempre: não duplica
-- e não recria as que apagaste. Dia 31 em meses curtos passa para o último dia.
create or replace function public.gerar_recorrentes(p_mes date default public.hoje_lisboa())
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  m  date := date_trunc('month', p_mes::timestamp)::date;
  ud int  := extract(day from (m + interval '1 month - 1 day'))::int;
  n  int;
begin
  if m > date_trunc('month', public.hoje_lisboa()::timestamp)::date then
    return 0;   -- meses futuros não se geram
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
  insert into public.despesas (owner, data, valor, descricao, categoria, partilhada, pago_por, origem, recorrente_id)
  select r.owner, m + (least(r.dia_vencimento, ud) - 1), r.valor, r.nome, r.categoria,
         r.partilhada, r.pago_por, 'recorrente', r.id
  from public.despesas_recorrentes r
  join novos n on n.recorrente_id = r.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Próximas datas de pagamento (base do calendário "Pagamentos")
create or replace view public.proximos_pagamentos with (security_invoker = true) as
select r.id as recorrente_id, r.nome, r.valor, r.partilhada, r.categoria,
       (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date as data_vencimento
from public.despesas_recorrentes r
cross join lateral (
  select generate_series(date_trunc('month', public.hoje_lisboa()::timestamp),
                         date_trunc('month', public.hoje_lisboa()::timestamp) + interval '2 months',
                         interval '1 month')::date as mes
) m
where r.owner = auth.uid()
  and r.ativa
  and (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date
      between greatest(public.hoje_lisboa(), r.inicio) and coalesce(r.fim, 'infinity'::date);

-- Aprende com as tuas correções aos gastos Apple Pay
create or replace function public.aprender_comerciante()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.origem = 'apple_pay'
     and public.chave_comerciante(new.comerciante) is not null
     and (new.categoria is distinct from old.categoria or new.partilhada is distinct from old.partilhada) then
    insert into public.regras_comerciante (owner, chave, categoria, partilhada)
    values (new.owner, public.chave_comerciante(new.comerciante), new.categoria, new.partilhada)
    on conflict (owner, chave) do update
      set categoria = excluded.categoria, partilhada = excluded.partilhada, atualizado_em = now();
  end if;
  return new;
end $$;

drop trigger if exists aprender_comerciante on public.despesas;
create trigger aprender_comerciante after update on public.despesas
  for each row execute function public.aprender_comerciante();

-- ---------- Entrada do Atalho Apple Pay ----------
-- POST /rest/v1/rpc/registar_apple_pay  {"token": "...", "valor": "12,50 €", "comerciante": "...", "cartao": "..."}
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
    v_txt := replace(replace(v_txt, '.', ''), ',', '.');   -- 1.234,56 -> 1234.56
  else
    v_txt := replace(v_txt, ',', '');                      -- 1,234.56 -> 1234.56
  end if;
  v_valor := round(v_txt::numeric, 2);
  if v_valor <= 0 then
    raise exception 'valor inválido: %', registar_apple_pay.valor;
  end if;

  select rc.categoria, rc.partilhada into v_cat, v_rpart
  from public.regras_comerciante rc
  where rc.owner = v_owner and rc.chave = public.chave_comerciante(v_com);

  insert into public.despesas (owner, valor, comerciante, descricao, categoria, origem, cartao, partilhada, pago_por)
  values (v_owner, v_valor, v_com, v_com, v_cat, 'apple_pay',
          nullif(trim(registar_apple_pay.cartao), ''), coalesce(v_rpart, v_part), 'eu')
  returning id into v_id;
  return v_id;
end $$;

-- ---------- Segurança ----------
alter table public.rendimentos          enable row level security;
alter table public.despesas_recorrentes enable row level security;
alter table public.despesas             enable row level security;
alter table public.recorrentes_geradas  enable row level security;
alter table public.regras_comerciante   enable row level security;
alter table public.config               enable row level security;

do $$
declare t text;
begin
  foreach t in array array['rendimentos','despesas_recorrentes','despesas','recorrentes_geradas','regras_comerciante','config'] loop
    execute format('drop policy if exists dono on public.%I', t);
    execute format('create policy dono on public.%I for all to authenticated
                    using (owner = (select auth.uid())) with check (owner = (select auth.uid()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

revoke all on public.divisao_mensal, public.proximos_pagamentos from anon;
grant select on public.divisao_mensal, public.proximos_pagamentos to authenticated;

-- Funções: só o utilizador com sessão as pode chamar; o Atalho (anónimo) só chega à registar_apple_pay
revoke execute on function
  public.hoje_lisboa(), public.chave_comerciante(text), public.calcular_divisao(numeric, numeric, numeric),
  public.proporcao_do_mes(date), public.dividir(numeric, date), public.garantir_config(),
  public.definir_rendimento(date, public.pessoa, numeric), public.gerar_recorrentes(date),
  public.aprender_comerciante(), public.registar_apple_pay(text, text, text, text)
from public, anon;

grant execute on function
  public.hoje_lisboa(), public.chave_comerciante(text), public.calcular_divisao(numeric, numeric, numeric),
  public.proporcao_do_mes(date), public.dividir(numeric, date), public.garantir_config(),
  public.definir_rendimento(date, public.pessoa, numeric), public.gerar_recorrentes(date)
to authenticated;

revoke execute on function public.registar_apple_pay(text, text, text, text) from authenticated;
grant execute on function public.registar_apple_pay(text, text, text, text) to anon;
