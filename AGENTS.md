# Instruções para agentes de IA — Órbita Fatec

Leia `regras/regra_do_app.md` antes de mudar qualquer coisa. Os pontos abaixo são os que mais dão problema.

## Edubox: SEMPRE pelo relay, nunca conexão direta

O Postgres do Edubox (sistema acadêmico) só aceita conexão do IP da Fatec. O Vercel não alcança. Para isso existe um **relay HTTP** num servidor de IP fixo, já autorizado pelo fornecedor.

**Não faça:**
- Não importe `src/db-edubox.js` em código novo (é legado, ver lista abaixo).
- Não crie script, "agente", `.vbs` ou tarefa agendada para rodar num PC da Fatec buscando dado do Edubox.
- Não crie sync Edubox → Firestore para "contornar" o IP.
- Não peça nem coloque credencial do Postgres do Edubox no `.env`.

**Faça:**
1. Crie uma rota específica do seu módulo no relay (ver "Como adicionar rota no relay" em `regras/regra_do_app.md`, seção 8).
2. No backend do Órbita, chame o relay com `fetch` usando `EDUBOX_RELAY_URL` + `EDUBOX_RELAY_TOKEN` (Bearer). Modelo pronto: função `relay()` em `src/rotas/cpa.js`.
3. O relay devolve dado quase cru. Agregação, regra de negócio e permissão (RBAC) ficam no backend do Órbita.

Regras do relay:
- O servidor é **compartilhado com o SIGMA**: não altere rotas existentes, `RELAY_TOKEN` nem `PARCEIRO_TOKEN`. Só acrescente.
- Rotas do Órbita usam o token próprio `ORBITA_TOKEN` e um prefixo por módulo (`/cpa/*`, `/cadd/*`...).
- Só leitura. Toda consulta precisa de `JOIN` até `tac_curso`, porque o banco é compartilhado com ~32 instituições.

Ainda usam conexão direta (legado, a migrar pro relay): `scripts/cad-edubox-sync.js` (+ `cad-edubox-agente.vbs`), `scripts/cobranca-edubox-sync.js` / `cobranca-edubox-historico.js` (+ `cobranca-edubox-agente.vbs`), `scripts/matrizes-edubox-sync.js`, `src/rotas/confirmacao-evento.js`. Não use como modelo.

## Outras regras do projeto

- Módulo novo precisa ser registrado em `core/permissions.js` (`MODULES` e `ROLE_PERMISSIONS`). Também precisa de nível de acesso no `config/permissions` do Firestore (tela Usuários → Gerência de Acessos), senão não aparece no menu.
- O navegador nunca fala com o Firestore direto: tudo passa pela API em `api/` + `src/rotas/`.
- Toda alteração entra no changelog em `regras/regra_do_app.md`, seção 7.
- Segredos só no `.env` (ignorado pelo Git). Documente o nome da variável em `.env_exemplo`.
