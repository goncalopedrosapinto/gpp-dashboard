\set ON_ERROR_STOP on
\pset footer off

-- ===== Utilizador A (Gonçalo) =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';

\echo '--- T0: garantir_config cria 1x e devolve sempre o mesmo token ---'
select (garantir_config()).token_atalho as tk1 \gset
select (garantir_config()).token_atalho as tk2 \gset
do $$ begin if (select count(*) from config) <> 1 then raise exception 'T0 falhou'; end if; end $$;
select :'tk1' = :'tk2' as mesmo_token;

\echo '--- T1: definir_rendimento (inserir, corrigir, apagar) + dividir 30 euros ---'
select definir_rendimento('2026-10-20', 'eu', 1400);
select definir_rendimento('2026-10-01', 'eu', 1500);   -- corrige
select definir_rendimento('2026-10-01', 'ela', 1000);
select definir_rendimento('2026-09-01', 'eu', 999);
select definir_rendimento('2026-09-01', 'eu', null);   -- apaga
do $$ begin
  if (select count(*) from rendimentos) <> 2 then raise exception 'T1 falhou: % linhas', (select count(*) from rendimentos); end if;
  if (select parte_eu from dividir(30, '2026-10-15')) <> 18 or (select parte_ela from dividir(30, '2026-10-15')) <> 12 then
    raise exception 'T1 falhou: divisao'; end if; end $$;
select * from dividir(30, '2026-10-15');

\echo '--- T2: calculadora pura, soma bate sempre certo (10 euros, 1 vs 2) ---'
select * from calcular_divisao(10, 1, 2);
do $$ declare a numeric; b numeric; begin
  select parte_eu, parte_ela into a, b from calcular_divisao(10, 1, 2);
  if a + b <> 10 then raise exception 'T2 falhou'; end if; end $$;

\echo '--- T3: fixas geradas 2x nao duplicam; dia 31 -> 30 nov; meses futuros nao geram ---'
insert into despesas_recorrentes (nome, valor, dia_vencimento, categoria, partilhada, pago_por, inicio) values
  ('Crédito habitação', 511, 5,  'Casa',  true,  'eu',  '2026-10-01'),
  ('Água',               40, 31, 'Casa',  true,  'ela', '2026-10-01'),
  ('Ginásio',            35, 28, 'Saúde', false, 'eu',  '2026-10-01');
select gerar_recorrentes('2026-11-15') as geradas_1a_vez;
select gerar_recorrentes('2026-11-15') as geradas_2a_vez;
select gerar_recorrentes('2027-02-10') as futuro;
do $$ begin
  if (select count(*) from despesas where mes = '2026-11-01') <> 3 then raise exception 'T3 falhou: duplicou'; end if;
  if (select data from despesas where descricao = 'Água' and mes = '2026-11-01') <> '2026-11-30' then raise exception 'T3 falhou: dia 31'; end if;
  if (select count(*) from despesas where mes = '2027-02-01') <> 0 then raise exception 'T3 falhou: gerou futuro'; end if;
end $$;

\echo '--- T3b: apagar uma fixa gerada nao a faz voltar ---'
delete from despesas where descricao = 'Ginásio' and mes = '2026-11-01';
select gerar_recorrentes('2026-11-01') as regeneradas;
do $$ begin
  if exists (select 1 from despesas where descricao = 'Ginásio' and mes = '2026-11-01') then raise exception 'T3b falhou'; end if; end $$;

\echo '--- T4: despesa manual partilhada paga por mim ---'
insert into despesas (data, valor, descricao, partilhada, pago_por) values ('2026-11-08', 30, 'Jantar', true, 'eu');

\echo '--- T5: fecho de novembro sem rendimentos de novembro -> usa outubro, provisorio ---'
select mes, pct_eu, pct_ela, mes_base, provisoria, total_partilhadas, quota_eu, quota_ela, pago_eu, pago_ela, saldo
from divisao_mensal where mes = '2026-11-01';
do $$ declare r record; begin
  select * into r from divisao_mensal where mes = '2026-11-01';
  -- partilhadas: credito 511 (eu) + agua 40 (ela) + jantar 30 (eu) = 581; 60% = 348,60
  if r.total_partilhadas <> 581 or r.quota_eu <> 348.60 or r.saldo <> 192.40 or not r.provisoria then
    raise exception 'T5 falhou: %', r; end if;
end $$;

\echo '--- T6: rendimentos de novembro entram -> recalcula, deixa de ser provisorio ---'
select definir_rendimento('2026-11-01', 'eu', 1200);
select definir_rendimento('2026-11-01', 'ela', 1000);
select mes, pct_eu, pct_ela, mes_base, provisoria, quota_eu, quota_ela, saldo from divisao_mensal where mes = '2026-11-01';
do $$ declare r record; begin
  select * into r from divisao_mensal where mes = '2026-11-01';
  if r.provisoria or r.quota_eu <> 316.91 or r.saldo <> 224.09 then raise exception 'T6 falhou: %', r; end if; end $$;

-- ===== Atalho do iPhone (anonimo, so com o token) =====
reset role;
set role anon;
reset request.jwt.claim.sub;

\echo '--- T7: Apple Pay em varios formatos ---'
select registar_apple_pay(:'tk1', '12,50 €', 'Continente', 'Visa') as id_1;
select registar_apple_pay(:'tk1', '1.234,56', 'Worten') as id_2;
select registar_apple_pay(:'tk1', '7.9', 'Padaria') as id_3;
select registar_apple_pay(:'tk1', '€4', ' ') as id_4;

\echo '--- T8: token errado e valor lixo falham ---'
do $$ begin
  perform registar_apple_pay('token-falso', '10');
  raise exception 'T8 falhou: aceitou token falso';
exception when sqlstate '28000' then raise notice 'token falso recusado: OK'; end $$;
select set_config('test.tk', :'tk1', false) \gset
do $$ begin
  perform registar_apple_pay(current_setting('test.tk'), 'abc');
  raise exception 'T8 falhou: aceitou valor lixo';
exception when raise_exception then
  if sqlerrm like 'valor inválido%' then raise notice 'valor lixo recusado: OK'; else raise; end if;
end $$;

\echo '--- T9: anonimo nao le tabelas nem chama funcoes internas ---'
do $$ begin
  begin perform 1 from despesas limit 1; raise exception 'T9 falhou: anon le despesas';
  exception when insufficient_privilege then raise notice 'anon sem acesso a despesas: OK'; end;
  begin perform 1 from divisao_mensal limit 1; raise exception 'T9 falhou: anon le divisao';
  exception when insufficient_privilege then raise notice 'anon sem acesso a divisao_mensal: OK'; end;
  begin perform gerar_recorrentes(); raise exception 'T9 falhou: anon gera';
  exception when insufficient_privilege then raise notice 'anon sem gerar_recorrentes: OK'; end;
  begin perform garantir_config(); raise exception 'T9 falhou: anon config';
  exception when insufficient_privilege then raise notice 'anon sem garantir_config: OK'; end;
end $$;

-- ===== Utilizador B nao ve nada de A =====
reset role;
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
\echo '--- T10: outro utilizador nao ve dados do Goncalo ---'
do $$ begin
  if (select count(*) from despesas) + (select count(*) from rendimentos) + (select count(*) from config)
     + (select count(*) from despesas_recorrentes) + (select count(*) from divisao_mensal) <> 0 then
    raise exception 'T10 falhou'; end if;
  raise notice 'utilizador B ve 0 linhas: OK';
end $$;

-- ===== De volta a A =====
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
\echo '--- T11: gastos Apple Pay registados ---'
select data, valor, comerciante, categoria, partilhada, origem, cartao from despesas where origem = 'apple_pay' order by id;

\echo '--- T12: aprende com a correcao: Continente -> Supermercado + partilhada ---'
update despesas set categoria = 'Supermercado', partilhada = true where comerciante = 'Continente';
reset role; set role anon; reset request.jwt.claim.sub;
select registar_apple_pay(:'tk1', '20,00', '  CONTINENTE ') as id_novo \gset
reset role; set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select valor, comerciante, categoria, partilhada from despesas where id = :id_novo;
do $$ declare r record; begin
  select * into r from despesas where comerciante = 'CONTINENTE';
  if r.categoria <> 'Supermercado' or not r.partilhada then raise exception 'T12 falhou: %', r; end if;
  if (select categoria from despesas where comerciante = 'Worten') is not null then raise exception 'T12 falhou: Worten'; end if;
end $$;

\echo '--- T13: proximos pagamentos ---'
select * from proximos_pagamentos order by data_vencimento limit 6;

\echo 'TODOS OS TESTES PASSARAM'
