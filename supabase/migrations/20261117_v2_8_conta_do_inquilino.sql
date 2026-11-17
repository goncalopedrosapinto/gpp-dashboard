-- =====================================================================
-- FINANÇAS GPP · v2.8 · Conta do inquilino simplificada
-- - um inquilino por imóvel
-- - despesas.cobrada_em: quando a despesa foi cobrada ao inquilino
--   (pode ser depois de a teres pago: paga em janeiro, cobrada em fevereiro)
-- - o inquilino paga por transferências (recebimentos tipo 'outro'), não por item
-- Saldo do inquilino = rendas vencidas + despesas cobradas − transferências recebidas
-- Sem DROP.
-- =====================================================================
alter table public.despesas add column if not exists cobrada_em date;
update public.despesas set cobrada_em = data where inquilino_id is not null and cobrada_em is null;
create unique index if not exists inquilinos_um_por_imovel on public.inquilinos (imovel_id);
