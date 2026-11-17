-- =====================================================================
-- FINANÇAS GPP · v2.7 · Despesas a cargo do inquilino
-- O inquilino é uma conta corrente: deve a renda de cada mês (desde o início)
-- e as despesas que lhe são atribuídas (água, luz…). Os recebimentos pagam-nas.
-- Sem DROP.
-- =====================================================================
alter table public.despesas add column if not exists inquilino_id bigint references public.inquilinos(id) on delete set null;
create index if not exists despesas_inquilino_idx on public.despesas (inquilino_id) where inquilino_id is not null;
