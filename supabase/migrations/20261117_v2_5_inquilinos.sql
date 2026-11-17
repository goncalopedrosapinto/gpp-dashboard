-- =====================================================================
-- FINANÇAS GPP · v2.5 · Imóveis arrendados e inquilinos
-- - imoveis: um imóvel liga-se à categoria das suas despesas (ex.: "T1 Esmoriz")
-- - inquilinos: renda mensal e dia de pagamento
-- - recebimentos: o que o inquilino pagou e a que se refere
--     renda (mes_ref) · despesa (despesa_id: ex. água que o inquilino devolve) · outro
-- Balanço (na app) = recebimentos − despesas da categoria do imóvel. Antes de impostos.
-- Sem DROP.
-- =====================================================================

create table if not exists public.imoveis (
  id        bigint generated always as identity primary key,
  owner     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome      text not null check (char_length(trim(nome)) between 1 and 40),
  categoria text not null check (char_length(trim(categoria)) between 1 and 30),
  criado_em timestamptz not null default now()
);
create table if not exists public.inquilinos (
  id            bigint generated always as identity primary key,
  owner         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  imovel_id     bigint not null references public.imoveis(id) on delete cascade,
  nome          text not null check (char_length(trim(nome)) between 1 and 60),
  renda         numeric(10,2) not null check (renda > 0),
  dia_pagamento smallint not null default 1 check (dia_pagamento between 1 and 31),
  inicio        date not null default public.hoje_lisboa(),
  fim           date,
  criado_em     timestamptz not null default now(),
  check (fim is null or fim >= inicio)
);
create table if not exists public.recebimentos (
  id           bigint generated always as identity primary key,
  owner        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  imovel_id    bigint not null references public.imoveis(id) on delete cascade,
  inquilino_id bigint references public.inquilinos(id) on delete set null,
  data         date not null default public.hoje_lisboa(),
  valor        numeric(10,2) not null check (valor > 0),
  tipo         text not null default 'renda' check (tipo in ('renda', 'despesa', 'outro')),
  mes_ref      date,
  despesa_id   bigint references public.despesas(id) on delete set null,
  nota         text check (nota is null or char_length(nota) <= 120),
  criado_em    timestamptz not null default now(),
  check (tipo <> 'renda' or mes_ref is not null)
);
create index if not exists inquilinos_imovel_idx on public.inquilinos (imovel_id);
create index if not exists recebimentos_imovel_idx on public.recebimentos (imovel_id, data);

do $$
declare t text;
begin
  foreach t in array array['imoveis', 'inquilinos', 'recebimentos'] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where tablename = t and policyname = 'dono') then
      execute format('create policy dono on public.%I for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()))', t);
    end if;
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
