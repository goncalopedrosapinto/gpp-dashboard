# GPP Dashboard

Web app para iPhone: registar despesas (minhas e da casa, em comum com a Bia), saber o que falta pagar e quem deve a quem. Não segue saldos bancários nem receitas.

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
| `supabase/functions/calendario/` | Edge Function que publica a agenda em .ics para o iPhone |
| `tests/ics/` | Testes do gerador .ics (validado com o parser `icalendar`) |
| `tests/e2e/` | Teste de ponta a ponta num iPhone simulado (Playwright) |

## Alterar a app

```bash
# editar src/app.js ou src/index.src.html
python3 build.py          # precisa de Pillow
git commit -am "..." && git push   # o GitHub Pages publica sozinho (1-2 min)
```

## Regras de negócio

**v3 · Life Management System (em construção, semana 1 de 4)**

- **Hoje** (ecrã inicial): campo de captura, o que é para hoje (tarefas atrasadas e de hoje, pagamentos que vencem, agenda, Google), próximos 7 dias, caixa de entrada (tarefas sem data) e o registo do departamento Operações.
- **Tarefas** (`tarefas`): `ler_data_pt` lê «hoje», «amanhã», «depois de amanhã», dias da semana (sempre o próximo; no próprio dia, a semana seguinte), «dia 12 [de março]» (já passou → mês/ano seguinte), «12/12», «em 3 dias», «próxima semana» (segunda). Sem data → caixa de entrada. `nova_tarefa(texto)` na app; `capturar(token, texto)` pelo Atalho do botão Action (mesmo `token_atalho`).
- **Registos** (`registos`): o log de cada departamento (operacoes, financas, carreira, saude, casa, claude). Capturar e fazer uma tarefa escrevem uma linha sozinhos (trigger).
- **Google Calendar** (só leitura): o endereço secreto iCal fica em `config.google_ics` (só `https://calendar.google.com/calendar/ical/….ics`); a Edge Function `google` lê-o com a sessão do utilizador (RLS) e devolve as ocorrências (`?de=&ate=`, ≤ 70 dias, fuso de Lisboa, recorrências e exceções pelo ical.js). O endereço nunca vai para o browser.

**v2**

- **Por pagar** (ecrã principal): despesas não pagas, em atraso, dos próximos 7 dias e do resto do mês. O visto (círculo) marca como paga e guarda a data; tocar outra vez desmarca. Uma fatura estimada (fixa variável) pede o valor real antes de ficar paga. O visto é sempre manual.
- **Despesas**: só minhas ou em comum. Uma despesa nova de hoje vem paga; com data futura fica por pagar. Wallet e notificações do banco entram pagas e só minhas, em «Por rever».
- **Em comum**: um casal de 2 membros (o 2.º pode ainda não ter conta). Cada despesa em comum guarda quem pagou e a parte do membro 1 (`pct_m1`); a divisão por defeito é a percentagem de cada um. `casal_saldos` = pagou − a sua parte ± acertos, só com despesas pagas. A Bia entra com um código de convite (7 dias, uso único). As despesas pessoais de cada um são privadas (RLS: dono, ou membro do casal da despesa).
- **Fixas**: entram todos os meses como «por pagar»; podem ser em comum (geradas por quem abrir a app primeiro). O feed do iPhone mostra as fixas em comum aos dois, com a parte de cada um.
- **Saem do ecrã** (as tabelas ficam, sem dados apagados): contas e saldos, ajustes, transferências, plafond, ganhos e a calculadora.

**v1 (histórico)**

- **Resumo:** só os meus números. Saldo = ganhos − custo líquido; custo líquido = gastos (total pago) − o que a Bia já devolveu.
- **Conta partilhada:** entra pelo total que paguei, com a parte da Bia. Fica *a receber* até marcar que recebi. O reembolso reduz o custo; não conta como ganho.
- **Calculadora:** o único sítio com divisão proporcional ao rendimento líquido de cada um. Registar a partir dela preenche a parte da Bia.
- **Despesas fixas:** geradas uma vez por mês, na conta escolhida (ou na principal), com a parte da Bia se for partilhada. Com débito direto, a agenda diz «Débito direto: X» e avisa na véspera de que conta sai; o Resumo avisa quando o saldo atual da conta não chega para os próximos pagamentos. Se apagar a do mês, não volta. Dia 31 passa para o último dia do mês.
- **Cartões de crédito:** são contas do tipo *crédito* com saldo negativo = dívida (na app escreve-se a dívida em positivo). Com plafond, a linha do cartão mostra «Livre X € de Y €» e uma barra de uso (vermelha a partir de 80%); o Resumo avisa se uma fixa no cartão passar o plafond. Uma compra com o cartão é um gasto nessa conta; pagar o cartão é uma **transferência** (ex.: MOEY → Caetano GO), nunca um gasto, para não contar a mesma despesa duas vezes. O Resumo mostra Disponível, Dívida nos cartões e Património líquido; os cartões não geram aviso de saldo.
- **Fixas de valor variável** (água, luz): o valor da fixa é uma estimativa. Cada mês o gasto entra com ela e fica *por confirmar* (Resumo › Faturas por confirmar) até escrever o valor da fatura; ao confirmar, a estimativa passa a ser a média das últimas 3 faturas. Na agenda e no feed aparecem com ≈.
- **Transferências fixas:** uma fixa com *Para* preenchido gera todos os meses uma transferência entre contas (ex.: CGD → MOEY, MOEY → cartão). Aparece na agenda como «Transferir: …» com De → Para e não entra no total de gastos fixos. A lista de fixas agrupa-se pela conta de onde sai o dinheiro.
- **Transferências:** «Transferir» no Resumo move dinheiro entre contas (com descrição e data, pode ser futura). As do mês aparecem por baixo das contas; tocar numa edita ou apaga e os dois saldos acertam-se. Não contam como gasto nem como ganho.
- **Contas:** o saldo de cada conta é o último ajuste ao valor real mais os movimentos posteriores (ganhos, gastos, o que a Bia devolve, transferências). Um ajuste no dia D já inclui tudo o que tem data anterior; do próprio dia só conta o que for registado depois. Gastos e ganhos sem conta escolhida vão para a principal.
- **Agenda:** eventos próprios em quatro agendas (pessoal, trabalho, Bia, outro), de um ou vários dias (Começa/Termina, ex.: sex 20:00 → dom 10:00; mudar o início arrasta o fim), com hora ou dia inteiro, repetição (semanal, mensal, anual) e alerta. Os pagamentos das despesas fixas aparecem sozinhos. O iPhone subscreve cada agenda em separado (`webcal://…/functions/v1/calendario?t=TOKEN&a=bia`), com a sua cor e os alertas; os pagamentos avisam às 9:00 da véspera.
- **Notificações do banco** (`rpc/registar_notificacao`, mesmo token): o Atalho lê a notificação com o modelo do iPhone e envia `tipo` (compra · debito · recebimento), `valor`, `entidade` e `conta` (nome da conta na app). Compra igual à da Wallet nos últimos 20 min junta-se a ela (ficam os dados da Wallet, a conta do banco); débito direto confirma a fixa desse mês (±5 dias) com o valor real; recebimento vira ganho nessa conta; a mesma notificação repetida em 2 min é ignorada.
- **Apple Pay:** entra via Atalho do iPhone (`rpc/registar_apple_pay`, protegido por token pessoal). Corrigir a categoria/partilha de um comerciante memoriza a regra para os próximos gastos.

## Segurança no iPhone

- **PIN de 4 dígitos:** pedido depois do primeiro login, ao abrir a app e ao voltar a ela depois de 1 minuto fora (o conteúdo fica escondido no seletor de apps). Fica só no dispositivo, como hash PBKDF2-SHA256 com sal; nunca vai para o servidor.
- 5 tentativas erradas (contadas mesmo que a página seja recarregada) terminam a sessão: volta a ser preciso email e palavra-passe. «Esqueci-me do PIN» faz o mesmo.
- O PIN tranca o ecrã; os dados continuam protegidos pelo login e pelo RLS do Supabase.

## Regras de interface

Segue o [ibelick/ui-skills](https://github.com/ibelick/ui-skills) (`baseline-ui` + `fixing-accessibility`), adaptado a CSS e JavaScript sem frameworks:

- Folhas de edição e confirmações em `<dialog>` nativo (foco preso, Escape fecha, foco volta ao botão de origem).
- Apagar pede sempre confirmação.
- Erros aparecem junto ao botão Guardar e o campo fica marcado (`aria-invalid`); os avisos rápidos só servem para sucesso.
- Carregamento com esqueletos estáticos; estados vazios com uma ação.
- Listas em `ul`/`li`, títulos `h1` → `h2` → `h3`, foco visível, contraste AA (verificado com axe-core no teste de ponta a ponta).
- [mobile-native](https://github.com/emilkowalski/skills) (Emil Kowalski): sem elástico da página, toque imediato (`touch-action: manipulation`), sem seleção de texto nos controlos, feedback ao premir (`scale(0.97)`, 100 ms), inputs ≥16px, `interactive-widget=resizes-content`, `color-scheme`, margens seguras laterais.
- Números à portuguesa: `1234,56`, `1.234,56`, `1234.56` e `12.500` (= doze mil e quinhentos). Ao sair do campo o valor aparece como a app o leu; texto inválido fica marcado e não se grava.
- Alvos de toque ≥ 44×44 px em ecrãs táteis com área invisível (`::after`/`::before`), sem mudar o desenho; medido em todos os ecrãs auditados no teste de ponta a ponta.
- Respeita `prefers-reduced-transparency` (cabeçalho e barra sólidos), `prefers-contrast: more` (linhas e texto secundário mais fortes) e `prefers-reduced-motion` (sem deslocações nem escalas, ficam fades de 120 ms).
- Logo e ícone em laranja (`#ea580c`); a cor de ação continua azul, porque o laranja já é a cor da agenda Trabalho e dos avisos.
- Sem `letter-spacing`, sem gradientes, sem animações além de ≤150 ms em controlos; respeita `prefers-reduced-motion`.

## Segurança

Este repositório é público. Nunca pôr aqui a chave `service_role` nem tokens: a chave publicável no `index.html` é pública por natureza e os dados estão protegidos por RLS no Supabase.
