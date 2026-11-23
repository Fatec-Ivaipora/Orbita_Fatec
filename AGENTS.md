# Instruções para agentes de IA — Órbita Fatec

Leia `regras/regra_do_app.md` antes de mudar qualquer coisa. Os pontos abaixo são os que mais dão problema.

## ⚠️ REGRA OBRIGATÓRIA — Nunca hardcode segredo ou chave externa no código

Incidente real (17/11/2026): a URL de implantação de um Google Apps Script — que já inclui um token de acesso dentro da própria URL (`https://script.google.com/macros/s/AKfy.../exec?token=...`) — ficou escrita direto no código (`scripts/migrar-secretaria-dp.js`) por quase 2 meses (30/07 a 24/09/2026) antes de alguém perceber e mover pra variável de ambiente. Isso foi um dos achados mais graves de uma revisão de segurança externa, porque o repositório é público.

**Proibido em qualquer arquivo versionado (vale pra código, script de uso único, teste, exemplo, comentário):**
- Token, chave de API, senha, string de conexão de banco, cookie de sessão.
- **URL completa de um serviço de terceiro que já carrega a credencial dentro dela** — é o caso mais fácil de passar batido, porque não parece uma "senha": qualquer link de Google Apps Script Web App, webhook com `?token=`/`?key=`/`?secret=` na query string, URL assinada, etc. **A URL inteira é o segredo, não só o pedaço depois do `=`.**
- Chave de serviço (`serviceAccountKey.json` e qualquer coisa parecida), certificado, chave privada SSH.

**Faça sempre:**
1. A credencial vai pro `.env` (nunca commitado — já está no `.gitignore`).
2. O **nome** da variável (nunca o valor) é documentado em `.env_exemplo`.
3. Código lê com `process.env.NOME_DA_VARIAVEL`. Se for um script de uso único (tipo migração), ele recebe a URL/token por `.env` ou argumento de linha de comando — nunca escrito no próprio arquivo, nem "só por enquanto, depois eu tiro".
4. Antes de commitar, releia o diff procurando por `http`/`https` seguido de `token=`, `key=`, `secret=`, `AKfy`, `github_pat_`, `sk-`, ou qualquer string longa (20+ caracteres) que pareça aleatória dentro de uma URL ou literal de string.
5. O hook `.githooks/pre-commit` (rodar `git config core.hooksPath .githooks` uma vez por clone — ver `regras/regra_do_app.md` seção 7, entrada de 23/11/2026) varre isso automaticamente e recusa o commit se achar. Não use `git commit --no-verify` pra passar por cima dele sem ter certeza absoluta de que é falso positivo.

## Edubox: SEMPRE pelo relay, nunca conexão direta

O Postgres do Edubox (sistema acadêmico) só aceita conexão do IP da Fatec. O Vercel não alcança. Para isso existe um **relay HTTP** num servidor de IP fixo, já autorizado pelo fornecedor.

**Não faça:**
- Não importe `src/db-edubox.js` em código novo (é legado, ver lista abaixo).
- Não crie script, "agente", `.vbs` ou tarefa agendada para rodar num PC da Fatec buscando dado do Edubox.
- Não crie sync Edubox → Firestore para "contornar" o IP.
- Não peça nem coloque credencial do Postgres do Edubox no `.env`.

**Faça:**
1. Crie uma rota específica do seu módulo no relay (ver "Como adicionar rota no relay" em `regras/regra_do_app.md`, seção 8).
2. No backend do Órbita, chame o relay com `fetch` usando `EDUBOX_RELAY_URL` + `EDUBOX_RELAY_TOKEN` (Bearer). Use o cliente compartilhado `src/utils/edubox-relay.js` (`relay(caminho)`); não crie outro.
3. O relay devolve dado quase cru. Agregação, regra de negócio e permissão (RBAC) ficam no backend do Órbita.

Regras do relay:
- O servidor é **compartilhado com o SIGMA**: não altere rotas existentes, `RELAY_TOKEN` nem `PARCEIRO_TOKEN`. Só acrescente.
- Rotas do Órbita usam o token próprio `ORBITA_TOKEN` e um prefixo por módulo (`/cpa/*`, `/cadd/*`...).
- Só leitura. Toda consulta precisa de `JOIN` até `tac_curso`, porque o banco é compartilhado com ~32 instituições.

Exceção: os agentes do CADD e da Cobrança (`scripts/*-edubox-agente.js`) usam `src/db-edubox.js` porque rodam **dentro do servidor do relay**, como serviços (ver seção 8, "Agentes que rodam no servidor"). Não rode esses agentes em outro computador e não copie esse padrão pra código que roda no Vercel.

## Outras regras do projeto

- Módulo novo precisa ser registrado em `core/permissions.js` (`MODULES` e `ROLE_PERMISSIONS`). Também precisa de nível de acesso no `config/permissions` do Firestore (tela Usuários → Gerência de Acessos), senão não aparece no menu.
- O navegador nunca fala com o Firestore direto: tudo passa pela API em `api/` + `src/rotas/`.
- Toda alteração entra no changelog em `regras/regra_do_app.md`, seção 7.
- Segredos só no `.env` (ignorado pelo Git). Documente o nome da variável em `.env_exemplo`.
