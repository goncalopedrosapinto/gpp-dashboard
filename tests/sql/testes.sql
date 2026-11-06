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


-- ===== v1.4: contas e saldos (utilizador limpo C) =====
reset role;
insert into auth.users values ('33333333-3333-3333-3333-333333333333') on conflict do nothing;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
\echo '--- T9: contas, ajustes, transferencias ---'
select criar_conta('CGD', 'corrente', 1000, false) as cgd \gset
select criar_conta('Poupança', 'poupanca', 5000, false) as poup \gset
select set_config('t.cgd', :'cgd', false) \gset
select set_config('t.poup', :'poup', false) \gset
do $$
declare cgd bigint := current_setting('t.cgd')::bigint; poup bigint := current_setting('t.poup')::bigint;
  function_saldo numeric;
begin
  if not (select principal from contas where id = cgd) then raise exception 'T9 falhou: primeira conta devia ser principal'; end if;
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1000 then raise exception 'T9 falhou: saldo inicial CGD'; end if;
  if (select saldo_atual from saldos_contas where conta_id = poup) <> 5000 then raise exception 'T9 falhou: saldo inicial poupanca'; end if;

  insert into ganhos (valor, descricao) values (200, 'Salário');                       -- hoje, depois do ajuste
  insert into despesas (valor, descricao) values (50, 'Jantar');                       -- hoje
  insert into despesas (data, valor, descricao) values (hoje_lisboa() - 1, 30, 'Ontem'); -- antes do ajuste: ignorado
  insert into despesas (data, valor, descricao) values (hoje_lisboa() + 10, 40, 'Fixa a vencer');
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1150 then raise exception 'T9 falhou: atual %', (select saldo_atual from saldos_contas where conta_id = cgd); end if;
  if (select saldo_previsto from saldos_contas where conta_id = cgd) <> 1110 then raise exception 'T9 falhou: previsto'; end if;

  insert into despesas (valor, descricao, partilhada, parte_dela) values (60, 'Compras', true, 30);
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1090 then raise exception 'T9 falhou: partilhada por receber'; end if;
  update despesas set recebido = true where descricao = 'Compras';
  if (select recebido_em from despesas where descricao = 'Compras') is null then raise exception 'T9 falhou: recebido_em'; end if;
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1120 then raise exception 'T9 falhou: recebido da Bia'; end if;
  update despesas set recebido = false where descricao = 'Compras';
  if (select recebido_em from despesas where descricao = 'Compras') is not null then raise exception 'T9 falhou: desmarcar recebido'; end if;
  update despesas set recebido = true where descricao = 'Compras';

  insert into transferencias (de_conta, para_conta, valor) values (cgd, poup, 100);
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1020
     or (select saldo_atual from saldos_contas where conta_id = poup) <> 5100 then raise exception 'T9 falhou: transferencia'; end if;

  if ajustar_saldo(cgd, 1000) <> -20 then raise exception 'T9 falhou: diferenca do ajuste'; end if;
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1000 then raise exception 'T9 falhou: depois do ajuste'; end if;
  if (select saldo_previsto from saldos_contas where conta_id = cgd) <> 960 then raise exception 'T9 falhou: previsto depois do ajuste'; end if;

  insert into despesas (valor, descricao, conta_id) values (10, 'Da poupança', poup);
  if (select saldo_atual from saldos_contas where conta_id = poup) <> 5090 then raise exception 'T9 falhou: gasto noutra conta'; end if;
  if (select saldo_atual from saldos_contas where conta_id = cgd) <> 1000 then raise exception 'T9 falhou: gasto noutra conta mexeu na principal'; end if;

  perform criar_conta('Revolut', 'outra', 50, true);
  if (select count(*) from contas where principal) <> 1 or not (select principal from contas where nome = 'Revolut') then raise exception 'T9 falhou: nova principal'; end if;
  perform definir_principal(cgd);
  if not (select principal from contas where id = cgd) or (select count(*) from contas where principal) <> 1 then raise exception 'T9 falhou: definir_principal'; end if;
  raise notice 'contas e saldos: OK';
end $$;

\echo '--- T10: isolamento das contas ---'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  if (select count(*) from contas) + (select count(*) from saldos_contas) + (select count(*) from transferencias) <> 0 then raise exception 'T10 falhou: B ve contas'; end if;
  begin
    insert into transferencias (de_conta, para_conta, valor) values (current_setting('t.cgd')::bigint, current_setting('t.poup')::bigint, 1);
    raise exception 'T10 falhou: B transferiu de contas de C';
  exception when raise_exception then
    if sqlerrm not like 'contas inválidas%' then raise; end if;
    raise notice 'transferencia com contas alheias recusada: OK';
  end;
end $$;
reset role; set role anon; reset request.jwt.claim.sub;
do $$ begin
  begin perform 1 from saldos_contas; raise exception 'T10 falhou: anon le saldos';
  exception when insufficient_privilege then raise notice 'anon sem saldos: OK'; end;
end $$;
reset role;


-- ===== v1.5: agenda =====
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
\echo '--- T11: eventos e regras ---'
select (garantir_config()).token_calendario as tkcal \gset
insert into eventos (titulo, agenda, data, hora_inicio, hora_fim, alerta_min, local) values ('Jantar com a Bia', 'bia', hoje_lisboa(), '20:00', '22:00', 30, 'Aveiro');
insert into eventos (titulo, agenda, data, dia_inteiro, repete, alerta_min) values ('Aniversário da Bia', 'bia', '2026-03-14', true, 'anual', 1440);
insert into eventos (titulo, agenda, data, hora_inicio, repete, alerta_min) values ('Reunião de vendas', 'trabalho', hoje_lisboa() + 1, '09:30', 'semanal', 15);
insert into eventos (titulo, agenda, data, dia_inteiro) values ('Antigo', 'pessoal', hoje_lisboa() - 200, true);
insert into eventos (titulo, data, dia_inteiro, hora_inicio, hora_fim) values ('Dia inteiro com horas', hoje_lisboa(), true, '10:00', '11:00');
insert into despesas_recorrentes (nome, valor, dia_vencimento, partilhada, parte_dela, inicio) values ('Renda', 600, 1, true, 300, '2026-01-01');
do $$ begin
  begin insert into eventos (titulo, data) values ('Sem hora', hoje_lisboa()); raise exception 'T11 falhou: evento sem hora nem dia inteiro';
  exception when check_violation then null; end;
  begin insert into eventos (titulo, data, hora_inicio, hora_fim) values ('Ao contrário', hoje_lisboa(), '10:00', '09:00'); raise exception 'T11 falhou: fim antes do início';
  exception when check_violation then null; end;
  begin insert into eventos (titulo, agenda, data, dia_inteiro) values ('X', 'ginasio', hoje_lisboa(), true); raise exception 'T11 falhou: agenda inválida';
  exception when check_violation then null; end;
  if (select hora_inicio from eventos where titulo = 'Dia inteiro com horas') is not null then raise exception 'T11 falhou: dia inteiro devia limpar horas'; end if;
  begin perform calendario_dados('x'); raise exception 'T11 falhou: autenticado chama calendario_dados';
  exception when insufficient_privilege then null; end;
  raise notice 'regras dos eventos: OK';
end $$;

reset role; set role anon; reset request.jwt.claim.sub;
\echo '--- T12: dados do feed por token ---'
select set_config('t.tkcal', :'tkcal', false) \gset
do $$ declare j jsonb; tk text := current_setting('t.tkcal'); begin
  j := calendario_dados(tk);
  if jsonb_array_length(j->'eventos') <> 4 then raise exception 'T12 falhou: eventos %', jsonb_array_length(j->'eventos'); end if;  -- Antigo fica de fora
  if jsonb_array_length(j->'pagamentos') <> 12 then raise exception 'T12 falhou: pagamentos %', jsonb_array_length(j->'pagamentos'); end if;
  if (j->'eventos'->0) ? 'owner' then raise exception 'T12 falhou: expõe owner'; end if;
  j := calendario_dados(tk, 'bia');
  if jsonb_array_length(j->'eventos') <> 2 or jsonb_array_length(j->'pagamentos') <> 0 then raise exception 'T12 falhou: filtro bia'; end if;
  j := calendario_dados(tk, 'pagamentos');
  if jsonb_array_length(j->'eventos') <> 0 or jsonb_array_length(j->'pagamentos') <> 12 then raise exception 'T12 falhou: filtro pagamentos'; end if;
  begin perform calendario_dados(repeat('0', 64)); raise exception 'T12 falhou: token falso';
  exception when sqlstate '28000' then null; end;
  begin perform calendario_dados(tk, 'tudo'); raise exception 'T12 falhou: agenda invalida';
  exception when raise_exception then if sqlerrm not like 'agenda inválida%' then raise; end if; end;
  begin perform 1 from eventos; raise exception 'T12 falhou: anon le eventos';
  exception when insufficient_privilege then null; end;
  raise notice 'feed por token: OK';
end $$;
reset role; set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin if (select count(*) from eventos) <> 0 then raise exception 'T12 falhou: B ve eventos'; end if; end $$;
reset role;


-- ===== v1.6: débito direto =====
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
\echo '--- T13: debito direto e conta da fixa ---'
insert into despesas_recorrentes (nome, valor, dia_vencimento, debito_direto, conta_id, inicio)
values ('Seguro', 25, 2, true, current_setting('t.poup')::bigint, date_trunc('month', hoje_lisboa())::date);
select gerar_recorrentes() as geradas;
do $$ declare j jsonb; begin
  if (select conta_id from despesas where descricao = 'Seguro') <> current_setting('t.poup')::bigint then raise exception 'T13 falhou: gasto gerado sem a conta da fixa'; end if;
  if not exists (select 1 from proximos_pagamentos where nome = 'Renda' and conta_id = current_setting('t.cgd')::bigint) then raise exception 'T13 falhou: proximos sem conta principal'; end if;
end $$;
reset role; set role anon; reset request.jwt.claim.sub;
do $$ declare j jsonb; s jsonb; r jsonb; begin
  j := calendario_dados(current_setting('t.tkcal'), 'pagamentos');
  select x into s from jsonb_array_elements(j->'pagamentos') x where x->>'nome' = 'Seguro' limit 1;
  select x into r from jsonb_array_elements(j->'pagamentos') x where x->>'nome' = 'Renda' limit 1;
  if not (s->>'debito_direto')::boolean or s->>'conta' <> 'Poupança' then raise exception 'T13 falhou: feed seguro %', s; end if;
  if (r->>'debito_direto')::boolean or r->>'conta' <> 'CGD' then raise exception 'T13 falhou: feed renda %', r; end if;
  raise notice 'debito direto e conta: OK';
end $$;
reset role;


-- ===== v1.7: crédito e transferências fixas =====
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
\echo '--- T14: cartao de credito e transferencias fixas ---'
select criar_conta('Caetano GO', 'credito', -450, false) as card \gset
select set_config('t.card', :'card', false) \gset
do $$ declare card bigint := current_setting('t.card')::bigint; poup bigint := current_setting('t.poup')::bigint; n int; begin
  if (select saldo_atual from saldos_contas where conta_id = card) <> -450 then raise exception 'T14 falhou: divida inicial'; end if;
  begin perform criar_conta('X', 'cripto', 0, false); raise exception 'T14 falhou: tipo invalido aceite';
  exception when check_violation then null; end;
  insert into despesas_recorrentes (nome, valor, dia_vencimento, conta_id, inicio) values ('Netflix', 13, 10, card, date_trunc('month', hoje_lisboa())::date);
  insert into despesas_recorrentes (nome, valor, dia_vencimento, conta_id, para_conta_id, debito_direto, inicio)
    values ('Pagamento Caetano GO', 127, 8, poup, card, true, date_trunc('month', hoje_lisboa())::date);
  begin insert into despesas_recorrentes (nome, valor, dia_vencimento, conta_id, para_conta_id) values ('Igual', 1, 1, card, card);
    raise exception 'T14 falhou: transferencia para a mesma conta';
  exception when check_violation then null; end;
  n := gerar_recorrentes();
  if n <> 2 then raise exception 'T14 falhou: gerou % (esperava 2)', n; end if;
  if gerar_recorrentes() <> 0 then raise exception 'T14 falhou: duplicou'; end if;
  if (select conta_id from despesas where descricao = 'Netflix') <> card then raise exception 'T14 falhou: netflix fora do cartao'; end if;
  if not exists (select 1 from transferencias where nota = 'Pagamento Caetano GO' and de_conta = poup and para_conta = card and valor = 127 and recorrente_id is not null) then
    raise exception 'T14 falhou: transferencia fixa nao gerada'; end if;
  if exists (select 1 from despesas where descricao = 'Pagamento Caetano GO') then raise exception 'T14 falhou: pagamento do cartao contado como gasto'; end if;
  if not exists (select 1 from proximos_pagamentos where nome = 'Pagamento Caetano GO' and para_conta_id = card) then raise exception 'T14 falhou: proximos sem destino'; end if;
  raise notice 'credito e transferencias fixas: OK';
end $$;
reset role; set role anon; reset request.jwt.claim.sub;
do $$ declare j jsonb; t jsonb; begin
  j := calendario_dados(current_setting('t.tkcal'), 'pagamentos');
  select x into t from jsonb_array_elements(j->'pagamentos') x where x->>'nome' = 'Pagamento Caetano GO' limit 1;
  if not (t->>'transferencia')::boolean or t->>'para' <> 'Caetano GO' or t->>'conta' <> 'Poupança' then raise exception 'T14 falhou: feed %', t; end if;
  raise notice 'feed com transferencias: OK';
end $$;
reset role;

\echo '--- T15: eventos de varios dias e plafond ---'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ declare id1 bigint; id2 bigint; card bigint := current_setting('t.card')::bigint; begin
  -- um dia: data_fim fica igual a data
  insert into eventos (titulo, data, dia_inteiro) values ('Um dia', '2026-11-20', true) returning id into id1;
  if (select data_fim from eventos where id = id1) <> '2026-11-20' then raise exception 'T15 falhou: data_fim por defeito'; end if;
  -- vários dias com hora: 20:00 sex -> 10:00 dom é válido
  insert into eventos (titulo, data, data_fim, hora_inicio, hora_fim) values ('Gerês', '2026-11-20', '2026-11-22', '20:00', '10:00') returning id into id2;
  -- no mesmo dia continua a não poder acabar antes de começar
  begin insert into eventos (titulo, data, hora_inicio, hora_fim) values ('Ao contrario', '2026-11-20', '10:00', '09:00');
    raise exception 'T15 falhou: aceitou fim antes do inicio no mesmo dia';
  exception when check_violation then null; end;
  begin insert into eventos (titulo, data, data_fim, dia_inteiro) values ('Fim antes', '2026-11-20', '2026-11-19', true);
    raise exception 'T15 falhou: aceitou data_fim < data';
  exception when check_violation then null; end;
  -- mudar só o início arrasta o fim
  update eventos set data = '2026-11-27' where id = id2;
  if (select data_fim from eventos where id = id2) <> '2026-11-29' then raise exception 'T15 falhou: fim nao acompanhou (%)', (select data_fim from eventos where id = id2); end if;
  -- mudar os dois respeita o que vem
  update eventos set data = '2026-12-04', data_fim = '2026-12-05' where id = id2;
  if (select data_fim from eventos where id = id2) <> '2026-12-05' then raise exception 'T15 falhou: data_fim explicita'; end if;
  -- plafond
  update contas set plafond = 1500 where id = card;
  if (select disponivel from saldos_contas where conta_id = card) is distinct from 1500 + (select saldo_atual from saldos_contas where conta_id = card) then raise exception 'T15 falhou: disponivel'; end if;
  if exists (select 1 from saldos_contas where tipo <> 'credito' and disponivel is not null) then raise exception 'T15 falhou: disponivel fora do credito'; end if;
  begin update contas set plafond = -1 where id = card; raise exception 'T15 falhou: plafond negativo';
  exception when check_violation then null; end;
  raise notice 'varios dias e plafond: OK';
end $$;
reset role; set role anon; reset request.jwt.claim.sub;
do $$ declare j jsonb; e jsonb; begin
  j := calendario_dados(current_setting('t.tkcal'), null);
  select x into e from jsonb_array_elements(j->'eventos') x where x->>'titulo' = 'Gerês';
  if e->>'data_fim' <> '2026-12-05' then raise exception 'T15 falhou: feed sem data_fim %', e; end if;
  raise notice 'feed com data_fim: OK';
end $$;
reset role;

\echo '--- T16: fixas de valor variavel ---'
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ declare r_id bigint; f_id bigint; m date := date_trunc('month', hoje_lisboa())::date;
  mes_ date; est numeric;
begin
  insert into despesas_recorrentes (nome, valor, dia_vencimento, categoria, variavel, inicio)
    values ('Luz', 40, 5, 'Casa', true, (m - interval '3 months')::date) returning id into r_id;
  insert into despesas_recorrentes (nome, valor, dia_vencimento, categoria, inicio)
    values ('Ginásio fixo', 27, 2, 'Saúde', (m - interval '3 months')::date) returning id into f_id;
  -- mês -3: entra com a estimativa inicial e fica por confirmar
  mes_ := (m - interval '3 months')::date;
  perform gerar_recorrentes(mes_);
  if not exists (select 1 from despesas where recorrente_id = r_id and mes = mes_ and estimado and valor = 40) then raise exception 'T16 falhou: gasto estimado'; end if;
  if exists (select 1 from despesas where recorrente_id = f_id and estimado) then raise exception 'T16 falhou: fixa normal marcada como estimada'; end if;
  update despesas set valor = 52, estimado = false where recorrente_id = r_id and mes = mes_;
  if (select valor from despesas_recorrentes where id = r_id) <> 52 then raise exception 'T16 falhou: estimativa apos 1 fatura'; end if;
  -- mês -2: entra com 52; fatura 38 -> média 45
  mes_ := (m - interval '2 months')::date;
  perform gerar_recorrentes(mes_);
  if (select valor from despesas where recorrente_id = r_id and mes = mes_) <> 52 then raise exception 'T16 falhou: mes seguinte nao usa a estimativa nova'; end if;
  update despesas set valor = 38, estimado = false where recorrente_id = r_id and mes = mes_;
  if (select valor from despesas_recorrentes where id = r_id) <> 45 then raise exception 'T16 falhou: media de 2'; end if;
  -- mês -1: confirma sem mudar o valor (45) -> média (52+38+45)/3 = 45
  mes_ := (m - interval '1 month')::date;
  perform gerar_recorrentes(mes_);
  update despesas set estimado = false where recorrente_id = r_id and mes = mes_;
  if (select valor from despesas_recorrentes where id = r_id) <> 45 then raise exception 'T16 falhou: confirmar sem mudar valor'; end if;
  -- este mês: fatura 60 -> só as últimas 3 (60, 45, 38) = 47,67
  perform gerar_recorrentes(m);
  update despesas set valor = 60, estimado = false where recorrente_id = r_id and mes = m;
  select valor into est from despesas_recorrentes where id = r_id;
  if est <> 47.67 then raise exception 'T16 falhou: media das ultimas 3 (%)', est; end if;
  -- fixa normal: mudar o gasto não mexe na fixa
  update despesas set valor = 30 where recorrente_id = f_id and mes = m;
  if (select valor from despesas_recorrentes where id = f_id) <> 27 then raise exception 'T16 falhou: fixa normal alterada'; end if;
  if not exists (select 1 from proximos_pagamentos where recorrente_id = r_id and variavel) then raise exception 'T16 falhou: proximos sem variavel'; end if;
  raise notice 'fixas variaveis: OK';
end $$;
reset role; set role anon; reset request.jwt.claim.sub;
do $$ declare j jsonb; l jsonb; begin
  j := calendario_dados(current_setting('t.tkcal'), 'pagamentos');
  select x into l from jsonb_array_elements(j->'pagamentos') x where x->>'nome' = 'Luz' limit 1;
  if l is null or not (l->>'variavel')::boolean then raise exception 'T16 falhou: feed sem variavel %', l; end if;
  raise notice 'feed com variavel: OK';
end $$;
reset role;

\echo 'TODOS OS TESTES PASSARAM'
