-- =====================================================================
-- FINANÇAS GPP · v2.0 · Despesas do casal e visto de pago
-- A app deixa de seguir saldos bancários e receitas: regista despesas
-- (minhas e em comum), mostra o que falta pagar e quem deve a quem.
-- - casais / casal_membros: a conta em comum (2 membros; o 2.º pode ainda não ter login)
-- - casal_convites: código para a Bia entrar
-- - despesas / despesas_recorrentes: casal_id, pago_por_membro, pct_m1 (parte do membro 1)
-- - despesas.pago / pago_em: o "visto" (fixas entram por pagar)
-- - acertos: pagamentos entre os dois para acertar contas
-- - casal_saldos: quanto cada um tem a haver (+) ou a dever (−)
-- Sem DROP: as tabelas antigas (contas, ganhos, transferências…) ficam, só saem do ecrã.
-- =====================================================================

create table if not exists public.casais (
  id          bigint generated always as identity primary key,
  criado_por  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  criado_em   timestamptz not null default now()
);
create table if not exists public.casal_membros (
  id        bigint generated always as identity primary key,
  casal_id  bigint not null references public.casais(id) on delete cascade,
  ordem     smallint not null check (ordem in (1, 2)),
  user_id   uuid references auth.users(id) on delete set null,
  nome      text not null check (char_length(nome) between 1 and 40),
  pct       numeric(5,2) not null check (pct between 0 and 100),
  unique (casal_id, ordem)
);
create unique index if not exists casal_membros_user_uk on public.casal_membros (user_id) where user_id is not null;
create table if not exists public.casal_convites (
  codigo     text primary key,
  casal_id   bigint not null references public.casais(id) on delete cascade,
  criado_por uuid not null references auth.users(id) on delete cascade,
  expira_em  timestamptz not null default now() + interval '7 days',
  usado_por  uuid references auth.users(id) on delete set null,
  usado_em   timestamptz
);
create table if not exists public.acertos (
  id          bigint generated always as identity primary key,
  owner       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  casal_id    bigint not null references public.casais(id) on delete cascade,
  de_membro   bigint not null references public.casal_membros(id) on delete cascade,
  para_membro bigint not null references public.casal_membros(id) on delete cascade,
  valor       numeric(10,2) not null check (valor > 0),
  data        date not null default public.hoje_lisboa(),
  nota        text check (nota is null or char_length(nota) <= 120),
  criado_em   timestamptz not null default now(),
  check (de_membro <> para_membro)
);
create index if not exists acertos_casal_idx on public.acertos (casal_id);

alter table public.despesas
  add column if not exists casal_id        bigint references public.casais(id) on delete set null,
  add column if not exists pago_por_membro bigint references public.casal_membros(id) on delete set null,
  add column if not exists pct_m1          numeric(5,2),
  add column if not exists pago            boolean not null default true,
  add column if not exists pago_em         date;
alter table public.despesas_recorrentes
  add column if not exists casal_id        bigint references public.casais(id) on delete set null,
  add column if not exists pago_por_membro bigint references public.casal_membros(id) on delete set null,
  add column if not exists pct_m1          numeric(5,2);
create index if not exists despesas_casal_idx on public.despesas (casal_id, mes) where casal_id is not null;
create index if not exists despesas_por_pagar_idx on public.despesas (owner, data) where not pago;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'despesas_pct_ck') then
    alter table public.despesas add constraint despesas_pct_ck check (pct_m1 is null or pct_m1 between 0 and 100);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'recorrentes_pct_ck') then
    alter table public.despesas_recorrentes add constraint recorrentes_pct_ck check (pct_m1 is null or pct_m1 between 0 and 100);
  end if;
end $$;
update public.despesas set pago_em = data where pago and pago_em is null;

-- O visto: ao marcar como paga fica a data; ao desmarcar limpa
create or replace function public.marcar_pago_em()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.pago and new.pago_em is null then new.pago_em := least(new.data, public.hoje_lisboa()); end if;
  if new.pago and tg_op = 'UPDATE' and not old.pago then new.pago_em := public.hoje_lisboa(); end if;
  if not new.pago then new.pago_em := null; end if;
  return new;
end $$;
create or replace trigger marcar_pago_em before insert or update on public.despesas
  for each row execute function public.marcar_pago_em();

-- Sou membro deste casal? (security definer: evita recursão nas regras de acesso)
create or replace function public.e_membro(p_casal bigint)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_casal is not null and exists (select 1 from public.casal_membros m where m.casal_id = p_casal and m.user_id = auth.uid())
$$;

-- ---------- Regras de acesso (somam-se às regras "dono" que já existem) ----------
alter table public.casais enable row level security;
alter table public.casal_membros enable row level security;
alter table public.casal_convites enable row level security;
alter table public.acertos enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'casais' and policyname = 'casal') then
    create policy casal on public.casais for select to authenticated using (public.e_membro(id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'casal_membros' and policyname = 'casal') then
    create policy casal on public.casal_membros for select to authenticated using (public.e_membro(casal_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'acertos' and policyname = 'casal') then
    create policy casal on public.acertos for all to authenticated
      using (public.e_membro(casal_id)) with check (public.e_membro(casal_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'despesas' and policyname = 'casal') then
    create policy casal on public.despesas for all to authenticated
      using (public.e_membro(casal_id)) with check (public.e_membro(casal_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'despesas_recorrentes' and policyname = 'casal') then
    create policy casal on public.despesas_recorrentes for all to authenticated
      using (public.e_membro(casal_id)) with check (public.e_membro(casal_id));
  end if;
end $$;
revoke all on public.casais, public.casal_membros, public.casal_convites, public.acertos from anon;
grant select on public.casais, public.casal_membros to authenticated;
grant select, insert, update, delete on public.acertos to authenticated;

-- Aprender comerciantes só a partir das tuas próprias correções
create or replace function public.aprender_comerciante()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.origem = 'apple_pay' and new.owner = auth.uid()
     and public.chave_comerciante(new.comerciante) is not null
     and (new.categoria is distinct from old.categoria or new.partilhada is distinct from old.partilhada) then
    insert into public.regras_comerciante (owner, chave, categoria, partilhada)
    values (new.owner, public.chave_comerciante(new.comerciante), new.categoria, new.partilhada)
    on conflict (owner, chave) do update
      set categoria = excluded.categoria, partilhada = excluded.partilhada, atualizado_em = now();
  end if;
  return new;
end $$;

-- ---------- Conta em comum ----------
create or replace function public.criar_casal(p_meu_nome text, p_nome_outro text default 'Bia', p_meu_pct numeric default 50)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  if auth.uid() is null then raise exception 'sem sessão' using errcode = '28000'; end if;
  if exists (select 1 from public.casal_membros where user_id = auth.uid()) then
    raise exception 'Já tens uma conta em comum.';
  end if;
  if p_meu_pct is null or p_meu_pct < 0 or p_meu_pct > 100 then raise exception 'A percentagem tem de ser entre 0 e 100.'; end if;
  insert into public.casais (criado_por) values (auth.uid()) returning id into v_id;
  insert into public.casal_membros (casal_id, ordem, user_id, nome, pct)
  values (v_id, 1, auth.uid(), coalesce(nullif(trim(p_meu_nome), ''), 'Eu'), round(p_meu_pct, 2)),
         (v_id, 2, null, coalesce(nullif(trim(p_nome_outro), ''), 'Bia'), round(100 - p_meu_pct, 2));
  return v_id;
end $$;

create or replace function public.definir_divisao(p_meu_pct numeric, p_nome_outro text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_casal bigint; v_ordem smallint;
begin
  select m.casal_id, m.ordem into v_casal, v_ordem from public.casal_membros m where m.user_id = auth.uid();
  if v_casal is null then raise exception 'Ainda não tens conta em comum.'; end if;
  if p_meu_pct is null or p_meu_pct < 0 or p_meu_pct > 100 then raise exception 'A percentagem tem de ser entre 0 e 100.'; end if;
  update public.casal_membros set pct = round(case when ordem = v_ordem then p_meu_pct else 100 - p_meu_pct end, 2) where casal_id = v_casal;
  if nullif(trim(p_nome_outro), '') is not null then
    update public.casal_membros set nome = trim(p_nome_outro) where casal_id = v_casal and ordem <> v_ordem and user_id is null;
  end if;
end $$;

create or replace function public.gerar_convite()
returns text language plpgsql security definer set search_path = '' as $$
declare v_casal bigint; v_cod text;
begin
  select m.casal_id into v_casal from public.casal_membros m where m.user_id = auth.uid();
  if v_casal is null then raise exception 'Ainda não tens conta em comum.'; end if;
  if not exists (select 1 from public.casal_membros where casal_id = v_casal and user_id is null) then
    raise exception 'A conta em comum já tem as duas pessoas.';
  end if;
  v_cod := upper(translate(substr(md5(random()::text || clock_timestamp()::text), 1, 6), '01', 'XY'));
  insert into public.casal_convites (codigo, casal_id, criado_por) values (v_cod, v_casal, auth.uid());
  return v_cod;
end $$;

create or replace function public.aceitar_convite(p_codigo text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_casal bigint;
begin
  if auth.uid() is null then raise exception 'sem sessão' using errcode = '28000'; end if;
  if exists (select 1 from public.casal_membros where user_id = auth.uid()) then
    raise exception 'Já tens uma conta em comum.';
  end if;
  select c.casal_id into v_casal from public.casal_convites c
  where c.codigo = upper(trim(p_codigo)) and c.usado_por is null and c.expira_em > now() for update;
  if v_casal is null then raise exception 'Código inválido ou expirado.'; end if;
  update public.casal_membros set user_id = auth.uid() where casal_id = v_casal and user_id is null;
  if not found then raise exception 'A conta em comum já tem as duas pessoas.'; end if;
  update public.casal_convites set usado_por = auth.uid(), usado_em = now() where codigo = upper(trim(p_codigo));
  return v_casal;
end $$;

revoke execute on function public.criar_casal(text, text, numeric), public.definir_divisao(numeric, text),
  public.gerar_convite(), public.aceitar_convite(text), public.e_membro(bigint) from public, anon;
grant execute on function public.criar_casal(text, text, numeric), public.definir_divisao(numeric, text),
  public.gerar_convite(), public.aceitar_convite(text), public.e_membro(bigint) to authenticated;

-- Quanto cada um tem a haver (+) ou a dever (−): pagou − a sua parte ± acertos
create or replace view public.casal_saldos with (security_invoker = true) as
select m.id as membro_id, m.casal_id, m.ordem, m.user_id, m.nome, m.pct,
  round(
      coalesce((select sum(d.valor) from public.despesas d where d.casal_id = m.casal_id and d.pago and d.pago_por_membro = m.id), 0)
    - coalesce((select sum(d.valor * (case when m.ordem = 1 then d.pct_m1 else 100 - d.pct_m1 end) / 100)
                from public.despesas d where d.casal_id = m.casal_id and d.pago and d.pct_m1 is not null), 0)
    + coalesce((select sum(a.valor) from public.acertos a where a.de_membro = m.id), 0)
    - coalesce((select sum(a.valor) from public.acertos a where a.para_membro = m.id), 0), 2) as saldo
from public.casal_membros m;
revoke all on public.casal_saldos from anon;
grant select on public.casal_saldos to authenticated;

-- ---------- Fixas: geradas também para o casal, por pagar ----------
create or replace function public.gerar_recorrentes(p_mes date default public.hoje_lisboa())
returns integer language plpgsql security definer set search_path = '' as $$
declare
  m  date := date_trunc('month', p_mes::timestamp)::date;
  ud int  := extract(day from (m + interval '1 month - 1 day'))::int;
  n  int;
begin
  if auth.uid() is null then raise exception 'sem sessão' using errcode = '28000'; end if;
  if m > date_trunc('month', public.hoje_lisboa()::timestamp)::date then
    return 0;
  end if;
  with novos as (
    insert into public.recorrentes_geradas (owner, recorrente_id, mes)
    select r.owner, r.id, m
    from public.despesas_recorrentes r
    left join public.contas p on p.owner = r.owner and p.principal
    where (r.owner = auth.uid() or public.e_membro(r.casal_id))
      and r.ativa
      and r.inicio <= (m + interval '1 month - 1 day')::date
      and (r.fim is null or r.fim >= m)
      and (r.para_conta_id is null or coalesce(r.conta_id, p.id) is distinct from r.para_conta_id)
      and (r.para_conta_id is null or coalesce(r.conta_id, p.id) is not null)
    on conflict do nothing
    returning recorrente_id
  ),
  gastos as (
    insert into public.despesas (owner, data, valor, descricao, categoria, partilhada, parte_dela, recebido, origem, recorrente_id,
                                 conta_id, estimado, casal_id, pago_por_membro, pct_m1, pago)
    select r.owner, m + (least(r.dia_vencimento, ud) - 1), r.valor, r.nome, r.categoria,
           r.partilhada, case when r.partilhada then r.parte_dela end, false, 'recorrente', r.id, r.conta_id, r.variavel,
           r.casal_id, r.pago_por_membro, r.pct_m1, false
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

create or replace view public.proximos_pagamentos with (security_invoker = true) as
select r.id as recorrente_id, r.nome, r.valor, r.partilhada, r.categoria, r.debito_direto,
       coalesce(r.conta_id, p.id) as conta_id, r.para_conta_id,
       (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date as data_vencimento,
       r.variavel, r.casal_id, r.pago_por_membro, r.pct_m1
from public.despesas_recorrentes r
left join public.contas p on p.owner = r.owner and p.principal
cross join lateral (
  select generate_series(date_trunc('month', public.hoje_lisboa()::timestamp),
                         date_trunc('month', public.hoje_lisboa()::timestamp) + interval '2 months',
                         interval '1 month')::date as mes
) m
where (r.owner = auth.uid() or public.e_membro(r.casal_id))
  and r.ativa
  and (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date
      between greatest(public.hoje_lisboa(), r.inicio) and coalesce(r.fim, 'infinity'::date);
revoke all on public.proximos_pagamentos from anon;
grant select on public.proximos_pagamentos to authenticated;

-- Feed do calendário: também as fixas em comum, com a tua parte
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
             'comum', r.casal_id is not null,
             'minha_parte', case when r.casal_id is not null and r.pct_m1 is not null
                                 then round(r.valor * (case when eu.ordem = 1 then r.pct_m1 else 100 - r.pct_m1 end) / 100, 2) end,
             'paga', pg.nome,
             'data', x.data) order by x.data), '[]'::jsonb) into v_pag
    from public.despesas_recorrentes r
    left join public.contas c on c.id = r.conta_id
    left join public.contas p on p.owner = r.owner and p.principal
    left join public.contas d on d.id = r.para_conta_id
    left join public.casal_membros eu on eu.casal_id = r.casal_id and eu.user_id = v_owner
    left join public.casal_membros pg on pg.id = r.pago_por_membro
    cross join lateral (
      select (m.mes + (least(r.dia_vencimento, extract(day from (m.mes + interval '1 month - 1 day'))::int) - 1))::date as data
      from (select generate_series(date_trunc('month', public.hoje_lisboa()::timestamp),
                                   date_trunc('month', public.hoje_lisboa()::timestamp) + interval '11 months',
                                   interval '1 month')::date as mes) m
    ) x
    where (r.owner = v_owner or eu.user_id is not null) and r.ativa
      and x.data >= r.inicio and (r.fim is null or x.data <= r.fim);
  end if;

  return jsonb_build_object('nome_ela', v_nome, 'eventos', v_ev, 'pagamentos', v_pag);
end $$;
revoke execute on function public.calendario_dados(text, text) from public, authenticated;
grant execute on function public.calendario_dados(text, text) to anon;
