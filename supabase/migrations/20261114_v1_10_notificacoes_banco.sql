-- =====================================================================
-- FINANÇAS GPP · v1.10 · Notificações do banco + Wallet sem duplicados
-- - despesas.fonte: de onde veio a captura automática
--     'wallet' (Atalho da Wallet) · 'notificacao' (notificação da app do banco) · 'ambas'
-- - ganhos.fonte: 'notificacao' quando o recebimento veio da app do banco
-- - registar_apple_pay (Wallet): se o banco já avisou da mesma compra (mesmo valor,
--   últimos 20 min), junta-se a ela em vez de criar outra; os dados da Wallet ganham
-- - registar_notificacao (banco): compra · debito · recebimento
--     compra      → junta-se à compra da Wallet ou cria uma "por rever"
--     debito      → confirma a fixa desse mês (valor real); se não houver, fica "por rever"
--     recebimento → ganho na conta desse banco
--   a mesma notificação repetida em menos de 2 min é ignorada
-- Sem DROP (idempotente).
-- =====================================================================

alter table public.despesas add column if not exists fonte text;
alter table public.ganhos   add column if not exists fonte text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'despesas_fonte_ck') then
    alter table public.despesas add constraint despesas_fonte_ck check (fonte is null or fonte in ('wallet', 'notificacao', 'ambas'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ganhos_fonte_ck') then
    alter table public.ganhos add constraint ganhos_fonte_ck check (fonte is null or fonte = 'notificacao');
  end if;
end $$;
create index if not exists despesas_captura_idx on public.despesas (owner, criado_em) where fonte is not null;

-- Valor escrito de qualquer forma: €12.50 · 1,250.00 · 1.250,00 · 12,5 · 12.500 (milhares)
create or replace function public.ler_valor(t text)
returns numeric language plpgsql immutable set search_path = '' as $$
declare s text := regexp_replace(coalesce(t, ''), '[^0-9,.]', '', 'g'); dec text;
begin
  if s !~ '[0-9]' then return null; end if;
  if s ~ ',' and s ~ '\.' then
    dec := case when strpos(reverse(s), ',') < strpos(reverse(s), '.') then ',' else '.' end;
    s := replace(s, case when dec = ',' then '.' else ',' end, '');
    s := replace(s, dec, '.');
  elsif s ~ ',' then
    s := case when length(s) - length(replace(s, ',', '')) = 1 then replace(s, ',', '.') else replace(s, ',', '') end;
  elsif s ~ '^[1-9][0-9]{0,2}(\.[0-9]{3})+$' then
    s := replace(s, '.', '');
  end if;
  if s !~ '^[0-9]*\.?[0-9]+$' then return null; end if;
  return round(s::numeric, 2);
end $$;

-- Conta pelo nome que o Atalho envia (ex.: "MOEY", ou o nome do cartão na Wallet que contém o nome da conta)
create or replace function public.conta_por_nome(p_owner uuid, p_nome text)
returns bigint language sql stable set search_path = '' as $$
  select c.id from public.contas c
  where c.owner = p_owner and c.ativa and nullif(trim(p_nome), '') is not null
    and (lower(c.nome) = lower(trim(p_nome)) or strpos(lower(p_nome), lower(c.nome)) > 0)
  order by (lower(c.nome) = lower(trim(p_nome))) desc, length(c.nome) desc
  limit 1
$$;

-- ---------- Wallet ----------
create or replace function public.registar_apple_pay(
  token text, valor text, comerciante text default null, cartao text default null
)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_part  boolean;
  v_cat   text;
  v_rpart boolean;
  v_valor numeric := public.ler_valor(registar_apple_pay.valor);
  v_com   text := nullif(trim(registar_apple_pay.comerciante), '');
  v_cart  text := nullif(trim(registar_apple_pay.cartao), '');
  v_id    bigint;
begin
  select c.owner, c.apple_pay_partilhada_default into v_owner, v_part
  from public.config c where c.token_atalho = registar_apple_pay.token;
  if v_owner is null then
    raise exception 'token inválido' using errcode = '28000';
  end if;
  if v_valor is null or v_valor <= 0 then
    raise exception 'valor inválido: %', registar_apple_pay.valor;
  end if;

  select rc.categoria, rc.partilhada into v_cat, v_rpart
  from public.regras_comerciante rc
  where rc.owner = v_owner and rc.chave = public.chave_comerciante(v_com);

  -- O banco já avisou desta compra? Fica uma só, com os dados da Wallet
  select d.id into v_id from public.despesas d
  where d.owner = v_owner and d.origem = 'apple_pay' and d.fonte = 'notificacao'
    and d.valor = v_valor and d.criado_em > now() - interval '20 minutes'
  order by d.criado_em limit 1 for update;
  if v_id is not null then
    update public.despesas d
       set fonte = 'ambas',
           comerciante = coalesce(v_com, d.comerciante),
           descricao = coalesce(v_com, d.descricao),
           cartao = coalesce(v_cart, d.cartao),
           categoria = coalesce(d.categoria, v_cat),
           partilhada = coalesce(v_rpart, d.partilhada)
     where d.id = v_id;
    return v_id;
  end if;

  insert into public.despesas (owner, valor, comerciante, descricao, categoria, origem, cartao, partilhada, fonte, conta_id)
  values (v_owner, v_valor, v_com, v_com, v_cat, 'apple_pay', v_cart, coalesce(v_rpart, v_part), 'wallet',
          public.conta_por_nome(v_owner, v_cart))
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.registar_apple_pay(text, text, text, text) from public, authenticated;
grant  execute on function public.registar_apple_pay(text, text, text, text) to anon;

-- ---------- Notificações da app do banco ----------
create or replace function public.registar_notificacao(
  token text, tipo text, valor text, entidade text default null, conta text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
  v_part  boolean;
  v_cat   text;
  v_rpart boolean;
  v_tipo  text := lower(trim(coalesce(registar_notificacao.tipo, '')));
  v_valor numeric := public.ler_valor(registar_notificacao.valor);
  v_ent   text := nullif(trim(registar_notificacao.entidade), '');
  v_conta bigint;
  v_princ bigint;
  v_hoje  date := public.hoje_lisboa();
  v_id    bigint;
begin
  select c.owner, c.apple_pay_partilhada_default into v_owner, v_part
  from public.config c where c.token_atalho = registar_notificacao.token;
  if v_owner is null then
    raise exception 'token inválido' using errcode = '28000';
  end if;
  if v_tipo not in ('compra', 'debito', 'recebimento') or v_valor is null or v_valor <= 0 then
    return 'ignorado';                       -- promoções, avisos, notificações sem valor
  end if;
  v_conta := public.conta_por_nome(v_owner, registar_notificacao.conta);
  select c.id into v_princ from public.contas c where c.owner = v_owner and c.principal;

  if v_tipo = 'recebimento' then
    if exists (select 1 from public.ganhos g where g.owner = v_owner and g.fonte = 'notificacao' and g.valor = v_valor
                 and g.conta_id is not distinct from v_conta and g.criado_em > now() - interval '2 minutes') then
      return 'repetida';
    end if;
    insert into public.ganhos (owner, valor, descricao, conta_id, fonte)
    values (v_owner, v_valor, coalesce('Recebido · ' || v_ent, 'Recebido'), v_conta, 'notificacao');
    return 'ganho';
  end if;

  if v_tipo = 'debito' then
    -- fixa deste período (±5 dias) na mesma conta: a notificação traz o valor real
    select d.id into v_id from public.despesas d
    where d.owner = v_owner and d.recorrente_id is not null and d.fonte is null
      and coalesce(d.conta_id, v_princ) is not distinct from coalesce(v_conta, v_princ)
      and d.data between v_hoje - 5 and v_hoje + 5
      and (d.estimado or d.valor = v_valor)
    order by (d.valor = v_valor) desc, abs(d.data - v_hoje)
    limit 1 for update;
    if v_id is not null then
      update public.despesas set valor = v_valor, estimado = false, fonte = 'notificacao', data = v_hoje where id = v_id;
      return 'fixa confirmada';
    end if;
    -- pagamento de cartão / transferência fixa já lançada
    if exists (select 1 from public.transferencias t where t.owner = v_owner and t.recorrente_id is not null
                 and t.de_conta = coalesce(v_conta, v_princ) and t.valor = v_valor and t.data between v_hoje - 5 and v_hoje + 5) then
      return 'transferencia fixa';
    end if;
  end if;

  -- compra (ou débito que não é de nenhuma fixa)
  if v_tipo = 'compra' then
    select d.id into v_id from public.despesas d
    where d.owner = v_owner and d.origem = 'apple_pay' and d.fonte = 'wallet'
      and d.valor = v_valor and d.criado_em > now() - interval '20 minutes'
    order by d.criado_em limit 1 for update;
    if v_id is not null then
      update public.despesas set fonte = 'ambas', conta_id = coalesce(v_conta, conta_id) where id = v_id;
      return 'duplicado';
    end if;
  end if;
  if exists (select 1 from public.despesas d where d.owner = v_owner and d.fonte in ('notificacao', 'ambas') and d.valor = v_valor
               and d.conta_id is not distinct from v_conta and d.criado_em > now() - interval '2 minutes') then
    return 'repetida';
  end if;

  select rc.categoria, rc.partilhada into v_cat, v_rpart
  from public.regras_comerciante rc
  where rc.owner = v_owner and rc.chave = public.chave_comerciante(v_ent);
  insert into public.despesas (owner, valor, comerciante, descricao, categoria, origem, cartao, partilhada, fonte, conta_id)
  values (v_owner, v_valor, v_ent, v_ent, v_cat, 'apple_pay', nullif(trim(registar_notificacao.conta), ''),
          coalesce(v_rpart, v_part), 'notificacao', v_conta);
  return case when v_tipo = 'debito' then 'debito por rever' else 'compra' end;
end $$;
revoke execute on function public.registar_notificacao(text, text, text, text, text) from public, authenticated;
grant  execute on function public.registar_notificacao(text, text, text, text, text) to anon;
revoke execute on function public.ler_valor(text), public.conta_por_nome(uuid, text) from public, anon;
grant  execute on function public.ler_valor(text), public.conta_por_nome(uuid, text) to authenticated;
