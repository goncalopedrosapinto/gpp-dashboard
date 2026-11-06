\set ON_ERROR_STOP on
\pset footer off
-- Corre depois de aplicar todas as migrações por ordem.

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- T0: garantir_config cria 1x, nome por defeito Bia ---'
select (garantir_config()).token_atalho as tk1 \gset
select (garantir_config()).token_atalho as tk2 \gset
do $$ begin
  if (select count(*) from config) <> 1 then raise exception 'T0 falhou: config duplicada'; end if;
  if (select nome_ela from config) <> 'Bia' then raise exception 'T0 falhou: nome %', (select nome_ela from config); end if;
end $$;
select :'tk1' = :'tk2' as mesmo_token;

\echo '--- T1: modelo antigo removido; calculadora pura mantem-se ---'
do $$ begin
  if to_regclass('public.rendimentos') is not null then raise exception 'T1 falhou: rendimentos existe'; end if;
  if to_regclass('public.divisao_mensal') is not null then raise exception 'T1 falhou: divisao_mensal existe'; end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and column_name='pago_por') then raise exception 'T1 falhou: pago_por existe'; end if;
  if (select parte_eu from calcular_divisao(30, 1500, 1000)) <> 18 then raise exception 'T1 falhou: calculadora'; end if;
end $$;

\echo '--- T2: ganhos ---'
insert into ganhos (data, valor, descricao, categoria) values
  ('2026-11-03', 1250, 'Salário', 'Salário'), ('2026-11-20', 340.50, 'Comissões outubro', 'Comissões');
do $$ begin
  if (select sum(valor) from ganhos where mes = '2026-11-01') <> 1590.50 then raise exception 'T2 falhou'; end if;
  begin insert into ganhos (valor) values (0); raise exception 'T2 falhou: aceitou 0';
  exception when check_violation then null; end;
end $$;

\echo '--- T3: fixas geram com parte_dela, sem duplicar, dia 31 -> 30, sem futuro, apagada nao volta ---'
insert into despesas_recorrentes (nome, valor, dia_vencimento, categoria, partilhada, parte_dela, inicio) values
  ('Renda', 600, 1,  'Casa',  true,  300, '2026-10-01'),
  ('Água',   40, 31, 'Casa',  true,  null, '2026-10-01'),
  ('Ginásio', 35, 28, 'Saúde', false, null, '2026-10-01');
select gerar_recorrentes('2026-11-15') as geradas_1;
select gerar_recorrentes('2026-11-15') as geradas_2;
select gerar_recorrentes('2027-02-10') as futuro;
do $$ declare r record; begin
  if (select count(*) from despesas where mes = '2026-11-01') <> 3 then raise exception 'T3 falhou: contagem'; end if;
  select * into r from despesas where descricao = 'Renda';
  if r.parte_dela <> 300 or r.recebido or not r.partilhada then raise exception 'T3 falhou: renda %', r; end if;
  if (select data from despesas where descricao = 'Água') <> '2026-11-30' then raise exception 'T3 falhou: dia 31'; end if;
  if (select count(*) from despesas where mes = '2027-02-01') <> 0 then raise exception 'T3 falhou: futuro'; end if;
end $$;
delete from despesas where descricao = 'Ginásio';
select gerar_recorrentes('2026-11-01') as regeneradas;
do $$ begin if exists (select 1 from despesas where descricao = 'Ginásio') then raise exception 'T3 falhou: voltou'; end if; end $$;

\echo '--- T4: parte dela nao pode passar o total ---'
do $$ begin
  insert into despesas (valor, partilhada, parte_dela) values (50, true, 60);
  raise exception 'T4 falhou';
exception when check_violation then raise notice 'parte maior que o total recusada: OK'; end $$;
insert into despesas (data, valor, descricao, partilhada, parte_dela, recebido) values ('2026-11-08', 50, 'Jantar', true, 25, true);

\echo '--- T5: contas do mes (o que a app mostra) ---'
select sum(valor) as gastos,
       sum(case when partilhada and recebido then coalesce(parte_dela,0) else 0 end) as recebido,
       sum(case when partilhada and not recebido then coalesce(parte_dela,0) else 0 end) as a_receber
from despesas where mes = '2026-11-01';
do $$ declare g numeric; rc numeric; ar numeric; begin
  select sum(valor), sum(case when partilhada and recebido then coalesce(parte_dela,0) else 0 end),
         sum(case when partilhada and not recebido then coalesce(parte_dela,0) else 0 end)
  into g, rc, ar from despesas where mes = '2026-11-01';
  -- renda 600 + agua 40 + jantar 50 = 690; recebido 25; a receber 300
  if g <> 690 or rc <> 25 or ar <> 300 then raise exception 'T5 falhou: % % %', g, rc, ar; end if;
end $$;

-- ===== Atalho (anonimo) =====
reset role; set role anon; reset request.jwt.claim.sub;
\echo '--- T6: Apple Pay ---'
select registar_apple_pay(:'tk1', '12,50 €', 'Continente', 'Visa') as id_1;
select registar_apple_pay(:'tk1', '1.234,56', 'Worten') as id_2;
do $$ begin
  perform registar_apple_pay('token-falso', '10');
  raise exception 'T6 falhou: token falso';
exception when sqlstate '28000' then raise notice 'token falso recusado: OK'; end $$;
do $$ begin
  begin perform 1 from despesas limit 1; raise exception 'T6 falhou: anon le despesas';
  exception when insufficient_privilege then raise notice 'anon sem despesas: OK'; end;
  begin perform 1 from ganhos limit 1; raise exception 'T6 falhou: anon le ganhos';
  exception when insufficient_privilege then raise notice 'anon sem ganhos: OK'; end;
  begin perform gerar_recorrentes(); raise exception 'T6 falhou: anon gera';
  exception when insufficient_privilege then raise notice 'anon sem gerar_recorrentes: OK'; end;
end $$;

-- ===== Outro utilizador =====
reset role; set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
\echo '--- T7: utilizador B nao ve nada ---'
do $$ begin
  if (select count(*) from despesas) + (select count(*) from ganhos) + (select count(*) from config)
     + (select count(*) from despesas_recorrentes) <> 0 then raise exception 'T7 falhou'; end if;
  raise notice 'utilizador B ve 0 linhas: OK';
end $$;

-- ===== Aprendizagem por comerciante =====
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\echo '--- T8: corrigir Continente memoriza categoria e partilha ---'
update despesas set categoria = 'Supermercado', partilhada = true where comerciante = 'Continente';
reset role; set role anon; reset request.jwt.claim.sub;
select registar_apple_pay(:'tk1', '20,00', '  CONTINENTE ') as id_novo \gset
reset role; set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ declare r record; begin
  select * into r from despesas where comerciante = 'CONTINENTE';
  if r.categoria <> 'Supermercado' or not r.partilhada or r.recebido then raise exception 'T8 falhou: %', r; end if;
end $$;

\echo 'TODOS OS TESTES PASSARAM'
