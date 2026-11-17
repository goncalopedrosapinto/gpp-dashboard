-- =====================================================================
-- FINANÇAS GPP · v2.2 · Categorias próprias
-- - categorias: lista de cada pessoa (começa com as de sempre)
-- - renomear_categoria: muda o nome e acompanha as tuas despesas e fixas
-- Apagar uma categoria não mexe nas despesas (guardam o nome como texto).
-- Sem DROP.
-- =====================================================================

create table if not exists public.categorias (
  id        bigint generated always as identity primary key,
  owner     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome      text not null check (char_length(trim(nome)) between 1 and 30),
  ordem     integer not null default 0,
  criado_em timestamptz not null default now()
);
create unique index if not exists categorias_owner_nome_uk on public.categorias (owner, lower(trim(nome)));
alter table public.categorias enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'categorias' and policyname = 'dono') then
    create policy dono on public.categorias for all to authenticated
      using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
  end if;
end $$;
revoke all on public.categorias from anon;
grant select, insert, update, delete on public.categorias to authenticated;

-- Na primeira vez, a lista começa com as categorias de sempre
create or replace function public.garantir_categorias()
returns setof public.categorias language plpgsql security invoker set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sem sessão' using errcode = '28000'; end if;
  if not exists (select 1 from public.categorias where owner = auth.uid()) then
    insert into public.categorias (owner, nome, ordem)
    select auth.uid(), n, o from unnest(array['Casa', 'Supermercado', 'Restauração', 'Transportes', 'Saúde', 'Lazer', 'Compras', 'Subscrições', 'Outros'])
      with ordinality as t(n, o);
  end if;
  return query select * from public.categorias where owner = auth.uid() order by ordem, nome;
end $$;

create or replace function public.renomear_categoria(p_id bigint, p_nome text)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_antigo text; v_novo text := trim(p_nome);
begin
  if v_novo is null or char_length(v_novo) not between 1 and 30 then raise exception 'O nome tem de ter entre 1 e 30 caracteres.'; end if;
  select nome into v_antigo from public.categorias where id = p_id and owner = auth.uid();
  if v_antigo is null then raise exception 'Categoria inexistente.'; end if;
  if exists (select 1 from public.categorias where owner = auth.uid() and id <> p_id and lower(trim(nome)) = lower(v_novo)) then
    raise exception 'Já existe uma categoria com esse nome.';
  end if;
  update public.categorias set nome = v_novo where id = p_id;
  update public.despesas set categoria = v_novo where owner = auth.uid() and categoria = v_antigo;
  update public.despesas_recorrentes set categoria = v_novo where owner = auth.uid() and categoria = v_antigo;
end $$;
revoke execute on function public.garantir_categorias(), public.renomear_categoria(bigint, text) from public, anon;
grant execute on function public.garantir_categorias(), public.renomear_categoria(bigint, text) to authenticated;
