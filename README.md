# GPP Dashboard

Web app pessoal para iPhone: os meus gastos e ganhos, contas partilhadas com a Bia, registo automático de gastos Apple Pay e despesas fixas.

- **Frontend:** HTML + JavaScript, instalável no ecrã principal do iPhone.
- **Backend:** Supabase (projeto *GPP Dashboard*). Os dados estão protegidos por RLS: cada linha só é visível ao dono.
- **Alojamento:** GitHub Pages (ramo `main`, pasta `/docs`) em https://goncalopedrosapinto.github.io/gpp-dashboard/

## Estrutura

| Pasta / ficheiro | O que é |
|---|---|
| `src/index.src.html` | Página e estilos |
| `src/app.js` | Lógica da app (é aqui que se edita quase tudo) |
| `build.py` | Gera `docs/`: junta o JS, escapa caracteres, cria ícones e manifesto |
| `docs/` | O que o GitHub Pages publica (não editar à mão) |
| `supabase/migrations/` | Esquema da base de dados, aplicado por ordem |
| `tests/sql/` | Testes da base de dados (Postgres local) |
| `tests/e2e/` | Teste de ponta a ponta num iPhone simulado (Playwright) |

## Alterar a app

```bash
# editar src/app.js ou src/index.src.html
python3 build.py          # precisa de Pillow
git commit -am "..." && git push   # o GitHub Pages publica sozinho (1-2 min)
```

## Regras de negócio

- **Resumo:** só os meus números. Saldo = ganhos − custo líquido; custo líquido = gastos (total pago) − o que a Bia já devolveu.
- **Conta partilhada:** entra pelo total que paguei, com a parte da Bia. Fica *a receber* até marcar que recebi. O reembolso reduz o custo; não conta como ganho.
- **Calculadora:** o único sítio com divisão proporcional ao rendimento líquido de cada um. Registar a partir dela preenche a parte da Bia.
- **Despesas fixas:** geradas uma vez por mês, com a parte da Bia se for partilhada. Se apagar a do mês, não volta. Dia 31 passa para o último dia do mês.
- **Apple Pay:** entra via Atalho do iPhone (`rpc/registar_apple_pay`, protegido por token pessoal). Corrigir a categoria/partilha de um comerciante memoriza a regra para os próximos gastos.

## Segurança

Este repositório é público. Nunca pôr aqui a chave `service_role` nem tokens: a chave publicável no `index.html` é pública por natureza e os dados estão protegidos por RLS no Supabase.
