# GPP Dashboard

Web app pessoal para iPhone: finanças, divisão proporcional de despesas partilhadas, registo automático de gastos Apple Pay e despesas fixas.

- **Frontend:** HTML + JavaScript num só ficheiro, instalável no ecrã principal do iPhone.
- **Backend:** Supabase (projeto *GPP Dashboard*). Os dados estão protegidos por RLS: cada linha só é visível ao dono.
- **Alojamento:** Netlify, ligado a este repositório, publica a pasta `dist/`.

## Estrutura

| Pasta / ficheiro | O que é |
|---|---|
| `src/index.src.html` | Código-fonte da app (é aqui que se edita) |
| `build.py` | Gera `dist/`: escapa o JS, cria ícones e manifesto |
| `dist/` | O que vai para o Netlify |
| `supabase/migrations/` | Esquema da base de dados (tabelas, funções, segurança) |
| `tests/sql/` | Testes da base de dados (Postgres local) |
| `tests/e2e/` | Teste de ponta a ponta num iPhone simulado (Playwright) |

## Alterar a app

```bash
# editar src/index.src.html
python3 build.py          # precisa de Pillow
git commit -am "..." && git push   # o Netlify publica sozinho
```

## Regras de negócio

- Despesas partilhadas dividem-se na proporção do rendimento líquido de cada um, mês a mês.
- Se faltar um rendimento do mês, usa-se o último mês completo e o acerto fica marcado como provisório.
- Despesas fixas são geradas uma vez por mês; se apagares a do mês, não volta. Dia 31 passa para o último dia do mês.
- Gastos Apple Pay entram via Atalho do iPhone (`rpc/registar_apple_pay`, protegido por token pessoal). Corrigir a categoria/partilha de um comerciante memoriza a regra para os próximos gastos.
