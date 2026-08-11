# Regra do App — Órbita FATEC

## 1. Visão geral
O Órbita FATEC é um ecossistema de gestão institucional desenvolvido para a FATEC. O objetivo do sistema é centralizar o controle de ativos (empréstimos de equipamentos), gestão de usuários e permissões, ensalamento de salas de aula e controle de carga horária para eventos do RH. O sistema utiliza uma arquitetura baseada em módulos independentes que compartilham uma identidade visual e um núcleo de autenticação/autorização centralizado.

## 2. Estrutura de pastas
- `/` (Raiz): Contém o front-end, configuração do Vercel e núcleo do layout compartilhado.
  - `vercel.json`: Arquivo que gerencia o roteamento "Zero Config" para o Vercel.
  - `firestore.rules`: Regras de segurança rigorosas trancando todo o acesso client-side.
- `/api`: Servidor Backend em Node.js (Express) hospedado no Vercel. Contém a lógica de autenticação via Firebase Admin SDK (`firebase.js`) e as rotas para os módulos (`/rotas`).
- `/auth`: Tela de login e fluxo de redefinição de senha institucional.
- `/core`: Arquivos compartilhados da arquitetura do Front-end (Firebase Auth, layout, segurança, permissões).
- `/emprestimo`, `/usuarios`, `/planejamento-academico`, `/rh` (Carga Horária / Funcionários), `/empresas`, `/valida`, `/meu-espaco`, `/fidelidade`: Módulos independentes do sistema consumindo a API REST através da função `apiFetch` (ou endpoint público).
- `/regras`: Documentação técnica e logs de alteração.

## 3. Fluxo de autenticação e Arquitetura REST
O sistema utiliza uma arquitetura híbrida segura:
1. **Login Client-side**: A autenticação inicial é feita via Firebase Auth (Identity Platform).
2. **REST API**: Qualquer leitura/gravação de dados no Firestore deve ser solicitada à `/api`. O Frontend anexa o Token JWT (gerado no passo 1) via cabeçalho `Authorization: Bearer`.
3. **Validação Server-side (RBAC)**: O `auth.js` do backend valida o token JWT usando o Firebase Admin SDK, consulta o banco para conferir o cargo do usuário e bloqueia/permite a requisição (Erro 403 Forbidden).
4. **Segurança do Firestore**: O `firestore.rules` possui a regra suprema `allow read, write: if false;`. Como o Vercel usa o Admin SDK (root), apenas ele consegue interagir com os dados, anulando 100% dos ataques do lado do cliente.

## 4. Cargos e permissões
O sistema utiliza Role-Based Access Control (RBAC). Os cargos base definidos em `permissions.js` são:

- **ADM N1 (Super Admin)**: Acesso total a todos os módulos (Meu Espaço, Cartão FATEC, Empréstimos, Usuários, Planejamento Acadêmico, Carga Horária, Funcionários, Parceiros).
- **ADM N2 (Setor/Chefia)**: Acesso gerencial a todos os módulos do sistema (com restrições de escrita dependendo de cada caso).
- **TI (Suporte)**: Acesso a Meu Espaço, Cartão FATEC, Empréstimos e Usuários.
- **RH (Recursos Humanos)**: Acesso a Meu Espaço, Cartão FATEC, Carga Horária e Funcionários.
- **Visitante**: Acesso restrito a Meu Espaço e Cartão FATEC (módulos básicos institucionais).

*Nota: No módulo de Usuários, o ADM N1 pode ajustar granularmente as permissões de "Ver" e "Executar" para cada cargo nos diferentes módulos.*

### Nomenclatura: "Setor" na interface = cargo/role no código
Na interface do módulo Usuários, os cargos são apresentados como **"Setor"** (cadastro de usuário, aba Setores, modo "Por Setor" da gerência de acessos). Internamente nada mudou: o campo continua sendo `role` no doc `users/{uid}`, as permissões continuam em `config/permissions` por role, e os ids (`adm_l1`, `adm_l2`, `ti`, `rh`, `visitante`, ...) permanecem. Não confundir com os **setores de funcionários** (`setores_rh`, módulo Funcionários), que são apenas organizacionais e não concedem acesso.

### Permissões por usuário (override individual)
Além das permissões por cargo, o ADM N1 pode conceder **acessos personalizados por usuário** (tela Usuários → Gerenciar Acessos → "Por Usuário"). O override é salvo no campo `permissoes` do doc `users/{uid}` (`{ modulo: nivel }`) e **sempre vence o cargo** — tanto para ampliar quanto para restringir. Módulos sem override herdam o nível do cargo. Níveis: 1 = Sem Acesso, 2 = Apenas Leitura, 3 = Acesso Total. Convenção visual: acesso herdado do cargo aparece em **azul**; acesso personalizado, em **laranja**. A gerência de acessos (globais e individuais) é exclusiva do `adm_l1` (imposto no backend).

### ⚠️ REGRA OBRIGATÓRIA — Registro de módulos e tópicos novos
`core/permissions.js` é a **fonte única** de módulos (`MODULES`) e tópicos/categorias (`CATEGORIES`). **Todo módulo novo criado DEVE ser registrado em `MODULES`** (com `id`, `category`, `title`, `icon`, `url`) e, se o tópico não existir, **registrado em `CATEGORIES`**. É esse registro que faz o módulo aparecer automaticamente no menu lateral E na tela de Gerência de Acessos (grade por cargo, por usuário e filtro por tópico) — não há mais listas paralelas hardcoded. Um módulo não registrado ali fica invisível para o sistema de permissões.

## 5. Módulos do sistema

### Meu Espaço (Antigo Dashboard)
- **Finalidade**: Área de produtividade do usuário com post-its e mural de avisos.
- **Backend API**: `/api/rotas/meu-espaco.js` (Lida com coleções `users/{uid}/notes` e `notices`).

### Empréstimos
- **Finalidade**: Controle de retirada e devolução de equipamentos.
- **Backend API**: `/api/rotas/emprestimos.js` (Lida com coleção `items` e lógica de timeout).

### Usuários
- **Finalidade**: Gestão de contas e permissões (RBAC).
- **Backend API**: `/api/rotas/usuarios.js` (Usa Auth do Firebase Admin para criar usuários e gerencia coleção `users` e `config`).

### Planejamento Acadêmico (antigo Ensalamento)
- **Finalidade**: Gestão inteligente de cursos, turmas com controle de lotes/períodos letivos (ex: 2026.2), salas de aula com tipo de equipamentos, calendário semanal de ensalamento e simulador de encaixe de aulas com I.A. A pasta foi renomeada de `/ensalamento` para `/planejamento-academico`.
- **Backend API**: `/api/rotas/ensalamento.js` (o ID interno da rota permanece `ensalamento` para compatibilidade com o sistema de permissões RBAC).
- **Coleções Firestore**: `courses`, `classes`, `rooms`, `calendarEntries`, `simulations`.
- **Regras de Salas**: Cada sala agora possui um campo `equipmentType` com os valores `UNI` (Universitária), `CCM` (Carteira e Cadeira Medicina) ou `CC` (Carteira e Cadeira), para controle interno.
- **Regras de Turmas**: Turmas são importadas e organizadas por **lote/período letivo** (ex: `2026.2`). A cada novo semestre, um novo lote é criado, mantendo o histórico separado.
- **Simulador**: Simplificado — cada aula configurável tem apenas o campo **Tipo** (Presencial / EAD / Carga Reservada). O período é fixo (Noite Inteira P1+P2) e o modo é sempre Automático (I.A.).

### Carga Horária
- **Finalidade**: Registro de entrada/saída em eventos (RH).
- **Frontend Adapter**: O Front-end não reescreveu a lógica pesada de datas. Usou-se um "Mock Adapter" que intercepta comandos do Firestore local e os transforma em chamadas REST para `/api/carga-horaria`.
- **Backend API**: `/api/rotas/carga-horaria.js`.

### Funcionários
- **Finalidade**: Gestão de cadastro, status ativo/inativo e turnos/horários de colaboradores (RH).
- **Backend API**: `/api/rotas/carga-horaria.js` (Lida com coleção `funcionarios_rh`).

### Parceiros (Empresas)
- **Finalidade**: Cadastro e manutenção das empresas parceiras do Clube de Vantagens e descontos concedidos aos funcionários.
- **Backend API**: `/api/rotas/empresas.js` (Lida com coleção `empresas`).

### Validação do Cartão (Valida)
- **Finalidade**: Interface pública para validação de cartões de identificação / QR Code de funcionários.
- **Backend API**: `/api/rotas/validacao.js` (Lida com rota pública `/api/validacao/:uid`).

### FATEC Fidelidade (PWA)
- **Finalidade**: Módulo mobile-first (PWA) que disponibiliza a carteirinha digital do funcionário (FATEC Card) com QR Code auto-regenerativo a cada 30 segundos e acesso rápido às empresas parceiras conveniadas no Clube de Vantagens.
- **Estrutura**: Localizado em `/fidelidade`, inclui a página do usuário (`index.html`) e a interface de validação (`validar.html`) para lojistas verificarem o status e vigência em tempo real.

## 6. Padrão visual
O sistema segue uma identidade visual institucional "Light Theme" moderna:
- **Cores Principais**:
  - Azul Marinho (`#031426`): Sidebar.
  - Azul Primário (`#0F4EB8`): Botões e destaques.
  - Laranja (`#F97316` / `#EB7025`): Acentos e alertas.
  - Fundo (`#F4F7FB`): Cor de fundo das páginas.
- **Componentes Globais**:
  - **Sidebar**: Itens principais (como Meu Espaço) ficam no topo. Outros módulos são organizados por categorias retráteis (Accordion) que iniciam recolhidas.
  - **Header**: Título do módulo, nível de acesso, avatar e botão de logout.
  - **Cards**: Fundo branco, bordas suaves (`12px` a `22px`), sombras sutis.
  - **Classes Globais**: `.btn-primary`, `.layout-wrapper`, `.layout-main`, `.layout-content`, `.layout-nav-category`.

## 7. Regras de alteração
Sempre que um arquivo for criado, alterado ou removido, registrar aqui seguindo o modelo abaixo:

### [AAAA-MM-DD] Título da alteração
- Autor:
- Branch:
- Arquivos alterados:
- Tipo:
- Motivo:
- Impacto:
- Como testar:
- Como reverter:

## 8. Histórico de alterações

### [2026-08-10] Otimizações de performance para mobile (compressão, cache, assets)
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/package.json` (nova dependência `compression`)
  - `/api/index.js` (adicionado `app.use(compression())` — gzip nas respostas da API e dos estáticos servidos localmente)
  - `/firebase.json` (headers de `Cache-Control` diferenciados por tipo de arquivo: JS/CSS com `max-age=3600`, imagens/fontes com `max-age=604800, immutable`, HTML continua `no-cache` para refletir permissões/menu na hora; removido `https://cdn.rawgit.com` do CSP, não é mais usado)
  - `/emprestimo/index.html`, `/emprestimo/movimentar.html` (removidos os `<script>` bloqueantes de QRCode/scanner do `<head>`)
  - `/emprestimo/app.js` (`abrirQR`/`abrirScanner` agora carregam as libs de QR sob demanda via `loadScriptOnce`, só quando o usuário realmente abre o QR ou o scanner)
  - `/fidelidade/index.html` (`width`/`height` explícitos na tag do logo, evita layout shift)
  - `/img/logoFatec.png` (redimensionado de 8001×3639px para 900×409px, mantendo transparência — era decodificado como ~116MB de bitmap em memória para ser exibido a 38px de altura)
- Tipo: Otimização / Performance
- Motivo: Relatos de usuários de que o app "trava" no celular. Auditoria (2 agentes, front-end e back-end) identificou: ausência de compressão gzip nas respostas, cache zerado em produção forçando redownload de tudo a cada navegação, um script de QR carregado via `cdn.rawgit.com` (domínio desativado desde 2018, que redireciona via hop extra até o jsDelivr) bloqueando o carregamento da tela de Empréstimo, e um logo de 29 milhões de pixels sendo decodificado só para aparecer em 38px no cartão do Fidelidade (o módulo PWA voltado justamente para celular).
- Impacto: `emprestimo/app.js` cai de 56KB para ~14,5KB transferidos (gzip); `logoFatec.png` cai de 207KB/8001×3639px para ~15KB/900×409px; tela de Empréstimo não depende mais de um domínio fora do ar. Nenhuma mudança de comportamento visível para o usuário — mesma UI, mesmas funcionalidades.
- Como testar: Abrir `/emprestimo/index.html` e confirmar que "Ver QR" e "Escanear" ainda funcionam normalmente (agora carregando a lib na hora do clique); conferir no DevTools (aba Network) que respostas JS/CSS vêm com `Content-Encoding: gzip`; conferir que `/img/logoFatec.png` carrega em ~15KB.
- Como reverter: `git revert` deste commit restaura os arquivos e o `firebase.json`/CSP originais (a imagem original de maior resolução precisa ser recuperada do histórico do git, já que foi sobrescrita no lugar).
- Pendências para uma próxima rodada (não implementadas agora): paralelizar escritas em lote no `financeiro.js` (hoje seriais, uma de cada vez); reduzir o limite de `express.json`/`urlencoded` de 50mb (uso real é ~2mb); paginar coleções sem `.limit()` (pacientes, fornecedores, usuários); dar ao módulo Fidelidade um manifest.json/service worker de verdade.

### [2026-08-10] Remoção do módulo CPA e da categoria "Docência"
- Autor: Claude Code
- Branch: main
- Arquivos removidos:
  - `/cpa/` (`index.html`, `app.js`, `cpa.css`)
  - `/src/rotas/cpa.js`
  - `/src/db-edubox.js`
- Arquivos alterados:
  - `/core/permissions.js` (remove categoria `docencia` e módulo `cpa` de `CATEGORIES`/`MODULES`, e `"cpa"` dos `modules` de `adm_l1`, `adm_l2`, `ti`, `coordenador`)
  - `/src/middlewares/auth.js` (remove a chave `cpa` do `defaultPermissions` de todos os cargos)
  - `/api/index.js` (remove `require`/`app.use` da rota `/api/cpa`)
  - `/package.json` (remove dependência `pg`, exclusiva do `db-edubox.js`)
  - `.env`, `.env_exemplo` (remove `EDUBOX_HOST`/`PORT`/`DATABASE`/`USER`/`PASSWORD`, usadas só pelo CPA)
  - `/regras/regra_do_app.md` (remove seção "CPA" e `/cpa` da lista de módulos em Estrutura de pastas)
- Tipo: Remoção / Limpeza
- Motivo: Pedido do usuário (TI) — módulo CPA não será mais usado. Como a categoria "Docência" só continha o CPA (os módulos anteriores, Turmas/Avaliações, já haviam sido removidos em 2026-08-03), a categoria inteira foi removida junto.
- Impacto: Usuários com os cargos `adm_l1`, `adm_l2`, `ti` e `coordenador` deixam de ver "CPA" e a categoria "Docência" no menu lateral. `GET /api/cpa/*` retorna 404. Nenhum dado do Edubox foi apagado (é um banco externo, somente leitura, não gerenciado por este projeto).
- Como testar: Confirmar que nenhum cargo mostra a categoria "Docência" no menu; confirmar que `GET /api/cpa/campanhas` retorna 404; conferir que o servidor local sobe normalmente sem a dependência `pg`.
- Como reverter: `git revert` deste commit restaura os arquivos e registros removidos (as credenciais do Edubox precisariam ser re-adicionadas manualmente ao `.env`, já que não ficam versionadas).

### [2026-08-03] Novo módulo: CPA (Comissão Própria de Avaliação)
- Autor: Claude Code
- Branch: feature/cpa-relatorio
- Arquivos criados:
  - `/src/db-edubox.js` (primeiro cliente Postgres do projeto — `Pool` somente leitura pro banco externo do Edubox, `search_path=ivp,public` e `default_transaction_read_only=on` fixados na conexão; credenciais via `EDUBOX_HOST`/`EDUBOX_PORT`/`EDUBOX_DATABASE`/`EDUBOX_USER`/`EDUBOX_PASSWORD` no `.env`)
  - `/src/rotas/cpa.js` (`GET /campanhas` lista as avaliações do segmento Alunos; `GET /cursos?codava=` lista só cursos com resposta na campanha; `GET /relatorio/:codava?curso=` agrega por dimensão: média por pergunta — parseando o número que abre `tav_resp_grupo_aluno.desres` —, nota geral da dimensão (`tav_nota_grupo_aluno.notnot`) e comentários (`obsnot`) filtrados removendo vazios e respostas com menos de 2 palavras)
  - `/cpa/index.html`, `/cpa/app.js`, `/cpa/cpa.css` (segue o padrão visual de `financeiro/licitacao/relatorio.html`: um gráfico Chart.js de barras por dimensão — uma barra por pergunta —, botão Imprimir com `window.print()`)
- Arquivos alterados:
  - `/package.json` (nova dependência `pg`)
  - `/core/permissions.js`, `/src/middlewares/auth.js`, `/api/index.js` (registro do módulo `cpa`, categoria "Docência", liberado pros cargos `adm_l1`, `adm_l2`, `ti` e `coordenador`)
- Tipo: Nova Funcionalidade
- Motivo: Pedido do usuário (TI) — hoje o relatório da CPA sai só do sistema acadêmico (Edubox) como um PDF de dezenas de páginas, sem filtro, um gráfico genérico só, e é sempre a TI quem precisa gerar isso pros coordenadores de curso a cada semestre. O módulo dá ao coordenador um relatório direto, limpo, focado no curso dele.
- Impacto/riscos a observar:
  - **Banco compartilhado entre instituições**: o Postgres do Edubox (banco `edubox_old`) é usado por ~32 outras instituições da região (colégios estaduais, IFPR, etc.), não só a Fatec. Toda query em `cpa.js` faz `INNER JOIN` até `tac_curso` (que só lista cursos da Fatec) — isso é o que garante que nenhuma resposta de aluno de outra instituição apareça no relatório, mesmo sem curso selecionado. Não remover esse join achando que é redundante.
  - **Escala das perguntas varia por pergunta**: `tav_questao.resque` tem casos com "1=Péssimo...5=Ótimo" e outros invertidos "1=Ótimo...5=Não sei" — o backend expõe `opcoes` e um heurístico `escalaInvertida` por pergunta; o frontend usa isso pra colorir as barras (verde/amarelo/vermelho) na direção certa. Não assumir uma escala fixa.
  - **Filtro de comentários é client-agnostic**: comentário "vazio ou com menos de 2 palavras" é decidido em `cpa.js` (contagem de palavras via split por espaço), não no Postgres — mais fácil de ajustar o limiar depois.
  - **Sem trava de curso por usuário**: seguindo o mesmo padrão já existente em `financeiro/licitacao` (cargo `coordenador` só tem uma dropdown de curso, sem amarração usuário↔curso no backend) — qualquer coordenador logado tecnicamente pode escolher outro curso na dropdown. Se decidirem endurecer isso, fazer nos dois módulos juntos (adicionar `cursoId` ao cadastro do usuário).
- Como testar: Logar como `coordenador`, `ti` ou `adm_l1`; abrir "CPA" na categoria Docência; escolher uma campanha "Alunos" e um curso; conferir um gráfico por dimensão (uma barra por pergunta) e a lista de comentários (sem vazios/genéricos de 1 palavra); testar "Imprimir".
- Como reverter: `git revert` deste commit remove os arquivos criados e desfaz os registros em `permissions.js`/`auth.js`/`api/index.js`; remover a dependência `pg` do `package.json` se não for mais usada em nenhum outro módulo.

### [2026-08-03] Remoção dos módulos Turmas e Avaliações (sem uso) — abre espaço para o CPA
- Autor: Claude Code
- Branch: feature/cpa-relatorio
- Arquivos removidos:
  - `/turmas/` (`index.html`, `app.js`, `turmas.css`)
  - `/avaliacoes/` (`index.html`, `app.js`, `avaliacoes.css`)
  - `/src/rotas/turmas.js`, `/src/rotas/avaliacoes.js`
- Arquivos alterados:
  - `/api/index.js` (remove import/registro das rotas `/api/turmas` e `/api/avaliacoes`)
  - `/core/permissions.js` (remove `MODULES.turmas` e `MODULES.avaliacoes`; remove `"turmas"`/`"avaliacoes"` dos arrays de módulos de `adm_l1` e `adm_l2`)
  - `/src/middlewares/auth.js` (remove as chaves `turmas`/`avaliacoes` do `defaultPermissions` de todos os cargos)
- Tipo: Remoção / Limpeza
- Motivo: Confirmado com o usuário (dono/dev do Órbita) que os dois módulos da categoria "Docência" não têm uso real — nenhuma coleção do Firestore fora desses próprios arquivos referenciava `turmas`/`avaliacoes`, e nenhum dos dois tinha entrada no changelog original de criação (avaliações nunca chegou a ser documentada). A categoria "Docência" foi esvaziada de propósito para receber o módulo CPA no lugar.
- Impacto: Usuários com os cargos `adm_l1`/`adm_l2` deixam de ver "Turmas" e "Avaliações" no menu lateral. Nenhum dado do Firestore foi apagado (as coleções `turmas`/`avaliacoes`, se existirem, ficam órfãs no banco, sem UI/API pra acessá-las).
- Como testar: Logar como `adm_l1`; confirmar que a categoria "Docência" não mostra mais "Turmas"/"Avaliações"; confirmar que `GET /api/turmas` e `GET /api/avaliacoes` retornam 404 (rota não existe mais).
- Como reverter: `git revert` deste commit restaura os arquivos e registros removidos.

### [2026-07-22] Almoxarifado Saúde: relatórios de estoque e movimentações
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/saude/almoxarifado-saude/relatorio-estoque.html` (Snapshot completo de uma categoria — Consumível ou Permanente, via `?categoria=` — agrupado por localização/sala, igual ao levantamento físico original. Mesmo padrão visual/`.print-page` do Almoxarifado Feridas)
  - `/saude/almoxarifado-saude/relatorio-movimentacoes.html` (Extrato de entradas/saídas de Consumíveis num período escolhido, com totais e saldo — nada é buscado até clicar em "Gerar")
- Arquivos alterados:
  - `/src/rotas/almoxarifado-saude.js` (Novo endpoint `GET /relatorio-estoque?categoria=` — ao contrário de `GET /itens` (paginado), aqui traz a categoria inteira de propósito, já que gerar relatório é uma ação explícita e ocasional, não algo disparado a cada abertura de tela)
  - `/saude/almoxarifado-saude/app.js` (Detecção das páginas de relatório reaproveitando o mesmo `app.js`, igual ao Almoxarifado Feridas; o botão "Relatório de estoque" no cabeçalho troca de link conforme a aba ativa)
  - `/saude/almoxarifado-saude/almoxarifado-saude.css` (Estilos `.print-page`/`.rel-*` e regras de impressão, copiados do Almoxarifado Feridas)
- Tipo: Nova Funcionalidade
- Motivo: Pedido do usuário — replicar os relatórios que já existem no Almoxarifado Feridas.
- Impacto: Nenhuma mudança de schema/endpoint existente.
- Como testar: Em cada aba, clicar em "Relatório de estoque" e conferir que abre já filtrado pra categoria certa, agrupado por sala; na aba Consumíveis, clicar em "Relatório de movimentações", escolher um período e gerar; testar impressão/PDF dos dois.
- Como reverter: Remover os 2 arquivos `.html`, o endpoint `/relatorio-estoque` em `almoxarifado-saude.js`, as funções de relatório e a checagem de página em `app.js`, e o bloco `.print-page`/`.rel-*`/`@media print` do CSS.

### [2026-07-22] Almoxarifado Saúde: paginação pra reduzir leituras do Firestore
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/almoxarifado-saude.js` (`GET /itens` deixou de trazer a categoria inteira — 575 Consumíveis ou 945 Permanente — de uma vez, e virou paginado: `?categoria=&localizacao=&busca=&limit=&cursor=`, respondendo `{itens, hasMore, proximoCursor}`. Busca por nome e filtro por localização agora rodam no servidor, via consulta paginada, em vez de carregar tudo pro navegador filtrar. Novo endpoint `GET /itens/alertas?categoria=&tipo=baixo|vencimento` cobre os filtros "só estoque baixo" e "só vencendo/vencido" — como poucos itens têm estoqueMinimo ou validade definidos, essas consultas já saem pequenas por natureza, sem precisar paginar)
  - `/saude/almoxarifado-saude/app.js` (Troca do carregamento único + filtro client-side por paginação real: busca com debounce dispara nova 1ª página no servidor; botão "Carregar mais" busca a próxima página pelo cursor; os checkboxes de estoque baixo/vencimento chaveiam pro endpoint de alertas dedicado)
  - `/saude/almoxarifado-saude/almoxarifado-saude.css` (Estilo do botão "Carregar mais")
  - `/firestore.indexes.json` (3 índices compostos novos, já publicados: `almoxarifado_itens` por categoria+localizacao+nome e por categoria+estoqueMinimo; `almoxarifado_lotes` por itemId+validade)
- Tipo: Correção de Performance/Custo
- Motivo: Usuário reportou consumo alto do banco — a tela original buscava a categoria inteira (centenas de itens) a cada abertura de página e a cada troca de aba, gastando 500-950 leituras do Firestore por carregamento.
- Impacto: Nenhuma mudança de schema. Carregamento passa a custar ~40 leituras (tamanho da página) em vez de 500-950. Limitação aceita: a busca por nome é case-sensitive (prefixo), então cadastros novos devem manter o padrão em CAIXA ALTA já usado nos dados importados pra busca funcionar bem.
- Como testar: Abrir Almoxarifado Saúde, confirmar que a lista carrega só uma leva de itens (com "Carregar mais" no fim), buscar por nome, filtrar por localização, e alternar "só estoque baixo"/"só vencendo" e ver a lista trocar pro modo de alerta.
- Como reverter: Voltar `GET /itens` pra buscar a categoria inteira sem paginação, e `app.js` pro carregamento único com filtro em memória (versão anterior a este commit).

### [2026-07-21] Novo módulo: Almoxarifado Saúde (Gestão Saúde)
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/src/rotas/almoxarifado-saude.js` (API sobre as coleções `almoxarifado_itens`, `almoxarifado_lotes` e `almoxarifado_movimentacoes` — já existentes no Firestore, importadas previamente de um levantamento físico de patrimônio e consumíveis de ~21 salas/laboratórios do setor de Saúde, mas sem nenhum módulo até então. CRUD de itens; para `categoria: "Consumível"`, entrada/saída transacional por lote com validade opcional (FEFO) e alerta de vencendo/vencido; para `categoria: "Permanente"` (patrimônio), ajuste direto de quantidade via conferência, sem lote/motivo. Endpoint de stats com contagens agregadas via `count()` do Firestore, evitando varrer os 1500+ itens a cada carregamento)
  - `/saude/almoxarifado-saude/index.html`, `app.js`, `almoxarifado-saude.css` (Duas abas — Consumíveis e Patrimônio — com resumo, busca, filtro por localização/estoque baixo/vencimento; modal de novo/editar item; modal de movimentação com lotes e histórico para Consumível; modal de conferência simples para Patrimônio)
- Arquivos alterados:
  - `/core/permissions.js` (Módulo `almoxarifado-saude` na categoria Gestão Saúde, atribuído a ADM N1/N2)
  - `/src/middlewares/auth.js` (Permissões padrão: ADM N2 = 3; TI, RH e Visitante = 1, mesmo padrão do Almoxarifado Feridas)
  - `/api/index.js` (Registro da rota)
  - `/firestore.indexes.json` (2 índices compostos novos — `almoxarifado_itens` por `categoria`+`nome` e `almoxarifado_movimentacoes` por `itemId`+`realizadoEm` — já publicados em produção via `firebase deploy --only firestore:indexes`)
  - Nota: `/usuarios/app.js` já deriva a lista de módulos gerenciáveis direto de `core/permissions.js` — nenhuma alteração necessária ali.
- Tipo: Novo Módulo
- Motivo: Os dados de patrimônio (equipamentos por laboratório) e consumíveis (materiais por sala, com conferência periódica) do setor de Saúde já haviam sido importados para o Firestore a partir de uma planilha/documento de levantamento físico, mas não existia tela nem API para gerenciá-los.
- Impacto: Nenhuma coleção nova — o módulo passa a operar sobre dados já existentes (`almoxarifado_itens`: 1520 itens; `almoxarifado_lotes`: 1434 lotes, todos sem validade definida até aqui). A lista de localizações é fixa no backend (`LOCALIZACOES`), batendo com os valores já usados nos dados importados. Limite de "vencendo" fixado em 60 dias (constante `DIAS_VENCENDO`, ajustável só no código por ora).
- Como testar: Acessar Almoxarifado Saúde → aba Consumíveis, cadastrar item novo com quantidade inicial e validade, dar entrada (lote novo e lote existente) e saída (escolhendo o lote), conferir que o resumo (estoque baixo/vencendo/vencidos) atualiza; na aba Patrimônio, cadastrar item e usar "Conferir" para ajustar a quantidade contada; excluir um item de teste em cada aba e confirmar que lotes/movimentações somem junto.
- Como reverter: Remover a pasta `/saude/almoxarifado-saude`, a rota `/src/rotas/almoxarifado-saude.js`, o registro em `/api/index.js`, as referências em `/core/permissions.js` e `/src/middlewares/auth.js`, e os 2 índices compostos em `/firestore.indexes.json` (também removê-los do console do Firebase, já que índices publicados não são revertidos automaticamente).
### [2026-07-17] Novo módulo: Acessos (Gestão de T.I.) — cofre de credenciais
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/src/rotas/acessos.js` (CRUD de credenciais em `acessos_credenciais`. Senhas são CRIPTOGRAFADAS com AES-256-GCM antes de salvar — nunca em texto puro no banco. A listagem NUNCA devolve a senha, só metadados; revelar a senha é uma rota separada (`POST /:id/revelar`) que decifra sob demanda e registra a visualização — quem e quando — em `acessos_credenciais/{id}/visualizacoes`)
  - `/ti/acessos/index.html`, `app.js`, `acessos.css` (Lista de credenciais por categoria com busca; botão "Mostrar/Ocultar" que busca a senha decifrada só quando clicado; modal de cadastro/edição — senha opcional na edição, mantém a atual se deixada em branco; modal de histórico de quem já viu cada senha)
- Arquivos alterados:
  - `/core/permissions.js` (Módulo `acessos` na categoria "Gestão de T.I."; adicionado aos `modules` de ADM N1 e T.I. — NÃO adicionado a ADM N2, RH ou Visitante, por decisão explícita do usuário)
  - `/src/middlewares/auth.js` (Permissões padrão: T.I. = 3 (acesso total, é o dono do módulo); ADM N2, RH e Visitante = 1 (sem acesso). ADM N1 sempre tem acesso total via bypass já existente no middleware)
  - `/api/index.js` (Registro das rotas)
  - `/.env_exemplo` (Nova variável `ACESSOS_ENCRYPTION_KEY`, com instrução de como gerar)
- Tipo: Novo Módulo (dado sensível — nível de segurança acima do padrão)
- Motivo: Centralizar as senhas de sistemas do setor, credenciais criadas para funcionários (servidor, e-mails) e os acessos do próprio Órbita de cada usuária, hoje provavelmente espalhados em anotações soltas. Por serem literalmente "a chave de tudo", o módulo foi construído com cuidado extra em relação aos demais: criptografia em repouso e auditoria de toda revelação de senha — indo além do padrão RBAC+autoria já usado no resto do sistema.
- Impacto: Requer `ACESSOS_ENCRYPTION_KEY` configurada no `.env` (local, já gerada e aplicada nesta máquina) e nas variáveis de ambiente do Vercel em produção. **Sem essa chave, o módulo responde 503 com instrução clara, sem afetar o restante do sistema.** Se a chave for perdida ou trocada, as senhas já cadastradas não podem mais ser recuperadas — deve ser guardada com segurança (ex.: no próprio cofre institucional, fora do repositório).
- Como testar: Logar como ADM N1 ou T.I., ir em Gestão de T.I. → Acessos, cadastrar uma credencial, clicar em "Mostrar" (a senha aparece) e depois em "Histórico" (deve mostrar quem revelou e quando). Editar deixando a senha em branco deve manter a senha anterior. Logar com RH/Visitante/ADM N2 não deve nem mostrar o módulo no menu.
- Como reverter: Remover a pasta `/ti/acessos`, a rota `/src/rotas/acessos.js`, o registro em `/api/index.js` e as referências em `/core/permissions.js` e `/src/middlewares/auth.js`.

### [2026-07-17] Novo módulo: Almoxarifado Feridas (Gestão Saúde)
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/src/rotas/almoxarifado-feridas.js` (CRUD de materiais em `almoxarifado_feridas_itens` + subcoleção `movimentacoes`; entrada/saída de estoque em transação Firestore para evitar corrida entre usuárias simultâneas, bloqueando saída maior que o disponível; autoria obrigatória em cada movimentação)
  - `/saude/almoxarifado-feridas/index.html`, `app.js`, `almoxarifado.css` (Grid de materiais com destaque visual de estoque baixo, busca e filtro "só estoque baixo"; modal de cadastro/edição; modal de movimentação com toggle entrada/saída e histórico)
- Arquivos alterados:
  - `/core/permissions.js` (Módulo `almoxarifado-feridas` na categoria Gestão Saúde, atribuído a ADM N1/N2)
  - `/src/middlewares/auth.js` (Permissões padrão: ADM N2 = 3; TI, RH e Visitante = 1)
  - `/api/index.js` (Registro das rotas)
  - Nota: `/usuarios/app.js` já deriva a lista de módulos gerenciáveis direto de `core/permissions.js` — nenhuma alteração necessária ali.
- Tipo: Novo Módulo
- Motivo: Controlar o estoque de materiais de curativo do ambulatório (hidrogel, espuma, gaze etc.), com histórico de entradas/saídas e alerta de estoque baixo, seguindo o mesmo padrão RBAC/autoria do módulo Ferida.
- Impacto: Novas coleções Firestore `almoxarifado_feridas_itens` e subcoleção `movimentacoes`. Nenhuma integração automática com o módulo Ferida (a baixa de estoque é manual, por decisão explícita ao escopo).
- Como testar: Gestão Saúde → Almoxarifado Feridas → cadastrar material com estoque mínimo, registrar entrada e saída, verificar o card ficar vermelho quando a quantidade cai abaixo do mínimo, e que uma saída maior que o disponível é bloqueada com aviso.
- Como reverter: Remover a pasta `/saude/almoxarifado-feridas`, a rota `/src/rotas/almoxarifado-feridas.js`, o registro em `/api/index.js` e as referências em `/core/permissions.js` e `/src/middlewares/auth.js`.

### [2026-07-17] Ferida: impressão do relatório encostava na borda física do papel
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/ferida.css` (`.print-page` ganhou padding próprio (8mm/10mm) dentro do `@media print`, em vez de depender só da margem do `@page` — o diálogo de impressão do navegador pode ignorar/zerar essa margem conforme a configuração de quem imprime, e sem uma margem garantida no próprio conteúdo, a informação das colunas da direita (data de emissão, autor, campos do grid de 2 colunas) encostava e cortava na borda do papel, como mostrado no print enviado pelo usuário. Também reduzido o `@page margin` de 12mm pra 10mm pra não dobrar demais a margem total, e adicionado `box-sizing: border-box` no `.print-page` — tanto na versão de tela quanto na de impressão — pra padding não somar por cima do `max-width`)
- Tipo: Correção de Bug
- Motivo: Usuário mandou print mostrando texto cortado na borda direita do relatório impresso.
- Impacto: Nenhuma mudança de schema/endpoint. Efeito só visual na impressão/PDF dos relatórios.
- Como testar: Imprimir/salvar PDF do relatório individual e do geral e conferir que nenhuma informação (datas, nomes, colunas da direita) encosta ou corta na borda do papel.
- Como reverter: Devolver `.print-page` no `@media print` pra `padding: 0` e o `@page margin` pra 12mm.

### [2026-07-17] Ferida: corrige o painel de opções "escondido" nas telas de relatório
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/ferida.css` (Achada a causa real do painel "O que incluir" não aparecer: o shell do app é flexbox com altura travada — `.layout-main` tem `overflow:hidden` e `.layout-content` é `flex:1; overflow-y:auto`. Como o card do relatório (`.print-page`) é alto e fica *fora* de `.layout-content`, como irmão dela dentro de `.layout-main`, o flexbox espremia `.layout-content` — com o cabeçalho, botões e o painel de opções dentro — numa caixinha de rolagem minúscula, exigindo rolar *dentro* dela pra ver o painel. Agora, só nas telas de relatório (`body.pagina-relatorio`), `.layout-main` rola a página inteira e `.layout-content` para de competir por espaço com o card do relatório)
- Tipo: Correção de Bug
- Motivo: Usuário reportou que o painel de checkboxes não aparecia; com um print da tela e testando em aba anônima (descartando cache/extensão), ele mesmo percebeu que a área existia mas estava dentro de uma divisão com barra de rolagem própria, cortada da vista.
- Impacto: Nenhuma mudança de schema/endpoint. Só afeta a rolagem visual das telas de relatório — `body.pagina-relatorio` não se aplica a `index.html`/`pacientes.html`.
- Como testar: Abrir o Relatório Geral e conferir que o painel "Escolha o que vai sair no relatório" aparece normalmente entre o cabeçalho e o card do relatório, sem precisar rolar dentro de uma caixinha separada; a página deve rolar inteira, de um jeito só.
- Como reverter: Remover o bloco `body.pagina-relatorio .layout-main`/`.layout-content` (fora do `@media print`) em `ferida.css`.

### [2026-07-17] Ferida: corrige possível falha silenciosa no relatório geral (token de sessão)
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/app.js`:
    - `apiFetch` agora espera a confirmação real do Firebase (`onAuthStateChanged`) antes da primeira chamada à API — o caminho rápido de auth (`getCachedAuth`) usa um token salvo em `localStorage` que não se autorrenova (diferente do objeto real do Firebase), então uma sessão parada há mais de 1h podia fazer a primeira chamada da tela falhar com 401 sem aviso nenhum, se o teste começou logo depois de o relatório carregar dados a partir do cache.
    - `initPaginaRelatorioGeral`: se o painel de opções não existir na página (`#relatorio-opcoes`), agora lança um erro explícito em vez de travar silenciosamente; erros nessa função voltaram a aparecer visíveis em `#relatorio-msg` (antes podiam ficar escondidos atrás da classe `hidden` já aplicada).
- Tipo: Correção de Bug
- Motivo: Usuário reportou que o painel "O que incluir" não aparecia no Relatório Geral, sem erro nenhum visível, mesmo após recarregar a página — sintoma clássico de uma chamada à API falhando em silêncio por token vencido.
- Impacto: Nenhuma mudança de schema/endpoint. Todas as chamadas de API do módulo Ferida (ficha, pacientes, relatórios) ganham essa proteção, não só o relatório geral.
- Como testar: Deixar a sessão aberta por mais de 1h sem uso e depois abrir o Relatório Geral direto — deve carregar normalmente (ou, se falhar por outro motivo, mostrar um erro visível em vez de nada). Em uso normal, testar o painel "O que incluir" como antes.
- Como reverter: Remover `authConfirmado`/`authConfirmadoPromise` e o `await` correspondente no início de `apiFetch`.

### [2026-07-17] Ferida: relatório geral com seções opcionais
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/relatorio-geral.html` (Novo painel "O que incluir", com uma checkbox por seção — Resumo, Distribuição por tipo de ferida, Distribuição por município, Lista de pacientes — todas marcadas por padrão)
  - `/saude/ferida/app.js` (Cada seção do relatório geral agora nasce marcada com `data-secao`; desmarcar uma checkbox aplica a classe `.rel-oculto`, escondendo a seção tanto na prévia quanto na impressão)
  - `/saude/ferida/ferida.css` (Estilo da lista de checkboxes e a classe `.rel-oculto`)
- Tipo: Evolução de Funcionalidade
- Motivo: Pedido do usuário — o relatório geral saía sempre completo; a pessoa que emite precisa poder escolher o que vai no documento final, não tudo de uma vez.
- Impacto: Nenhuma mudança de schema/endpoint. Por padrão, com tudo marcado, o relatório sai igual a antes.
- Como testar: Abrir o relatório geral, desmarcar por exemplo "Lista de pacientes" e conferir que ela some da prévia e da impressão, mantendo as demais seções.
- Como reverter: Remover o painel `#relatorio-opcoes` do HTML, os atributos `data-secao` e o listener de checkboxes no `app.js`, e a classe `.rel-oculto` no CSS.

### [2026-07-17] Ferida: relatório geral, correção da impressão e exclusão simplificada
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/saude/ferida/relatorio-geral.html` (Nova tela: relatório imprimível com todos os pacientes — total cadastrado, distribuição por tipo de ferida e por município (contagem + %), e a lista completa (nome, tipo de ferida, município, cadastro). Mesma identidade visual/logo do relatório por paciente. Acessível pelo botão "Relatório geral" na tela "Pacientes")
- Arquivos alterados:
  - `/saude/ferida/ferida.css`:
    - **Correção de impressão:** o shell do app (`body`, `.layout-wrapper`, `.layout-main`, `.layout-content`, em `core/layout.css`) trava a altura em `100vh` e esconde o excedente pra rolar na tela — isso cortava o relatório fora da primeira página ao imprimir. O `@media print` agora reseta `height`/`overflow`/`margin`/`padding` dessa cadeia inteira (escopado por `body.pagina-relatorio`, sem afetar impressão de outras telas do módulo).
    - Estilos novos do relatório geral (`.rel-resumo`, `.rel-resumo-card`, `.rel-tabela`).
  - `/saude/ferida/app.js`: `excluirPaciente()` não pede mais pra digitar o nome do paciente — só um `confirm()` único com o resumo do que será apagado. Novas funções `initPaginaRelatorioGeral`/`renderRelatorioGeral` (reaproveitam `initApp`, detectando `#relatorio-geral-conteudo`).
  - `/saude/ferida/pacientes.html`: novo botão "Relatório geral" no cabeçalho, ao lado de "Voltar para a ficha".
- Tipo: Nova Funcionalidade / Correção de Bug / Simplificação de UX
- Motivo: Pedido do usuário — faltava uma visão agregada de todos os pacientes pra tirar num relatório só; a impressão do relatório por paciente estava cortando informação nas bordas; e a confirmação dupla (digitar o nome) na exclusão de paciente foi considerada excessiva — um aviso único já basta.
- Impacto: Nenhuma mudança de schema ou endpoint novo — o relatório geral só lê `GET /pacientes` (a mesma rota que a tela "Pacientes" já usa, sem `busca`). Excluir paciente continua irreversível, só que agora com um clique de confirmação em vez de dois.
- Como testar: Na tela "Pacientes", clicar em "Relatório geral" e conferir os totais/distribuições e a lista; imprimir (Ctrl+P) tanto o relatório geral quanto o de um paciente com vários atendimentos e confirmar que nada fica cortado nas bordas, mesmo em relatórios longos com mais de uma página; excluir um paciente de teste e confirmar que só aparece um aviso (sem pedir pra digitar o nome).
- Como reverter: Remover `/saude/ferida/relatorio-geral.html` e o botão em `pacientes.html`; devolver o `prompt()` de confirmação em `excluirPaciente()`; reverter o bloco de reset de altura/overflow do `@media print` em `ferida.css` (mantendo só o que já existia antes).

### [2026-07-17] Ferida: tipo de ferida vai pro cadastro do paciente + tela de relatório imprimível
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/saude/ferida/relatorio.html` (Nova tela: relatório de avaliação e evolução do paciente, pronto pra imprimir/salvar como PDF pelo navegador — `?paciente=ID`. Cabeçalho com a logo da Fatec (reaproveita `/img/fateclogoazul.png`, já usada no módulo Fidelidade — não foi preciso subir arquivo novo), identificação do paciente (nome, idade, município, tipo de ferida) e a evolução completa: um bloco por atendimento com todos os campos clínicos e a conduta, nas cores do módulo (petróleo/turquesa). Usa o mesmo padrão `.print-page` + `@media print` já usado em `avaliacoes.css`, escopado por `body.pagina-relatorio` pra não afetar a impressão das outras telas do módulo, que compartilham o mesmo `ferida.css`)
- Arquivos alterados:
  - `/saude/ferida/index.html`:
    - "Tipo de ferida" deixou de ser campo do atendimento e virou select no cadastro/edição do paciente (Neuropatia Diabética, Úlcera Venosa, Úlcera Arterial, Úlcera Mista, com opção "Não especificado"); passou a aparecer na barra do paciente, junto do município.
    - Novo botão "Relatório" na barra do paciente, ao lado de Editar/Excluir — disponível pra leitura e escrita (não é `action-execute`, já que gerar relatório não é uma ação de escrita) — abre `relatorio.html?paciente=ID` em nova aba.
  - `/saude/ferida/pacientes.html`: nova coluna "Tipo de ferida" na tabela; a linha deixou de ser clicável por inteiro — agora tem uma coluna "Ações" com dois ícones por paciente (abrir ficha / gerar relatório).
  - `/saude/ferida/app.js`: `tipoFerida` saiu do payload do atendimento e do modal de detalhe do histórico, entrou no modal de paciente e em `selecionarPaciente`/`renderTabelaPacientes`; novas funções `initPaginaRelatorio` e `renderRelatorio` (reaproveitam `initApp` como as outras telas, detectando `#relatorio-conteudo`).
  - `/saude/ferida/ferida.css`: estilos do relatório (`.rel-*`), regras de impressão (`@media print`, escopadas por `body.pagina-relatorio`) e da nova coluna de ações em `pacientes.html`.
  - `/src/rotas/ferida.js`: `tipoFerida` saiu da validação/gravação de `POST /pacientes/:id/atendimentos` e entrou em `POST /pacientes` e `PUT /pacientes/:id` (contra a mesma lista fechada de 4 tipos).
- Tipo: Nova Funcionalidade / Correção de Modelagem
- Motivo: Pedido do usuário — tipo de ferida é uma característica do paciente/diagnóstico, não algo que se redefine a cada atendimento, então devia estar no cadastro; e faltava uma forma de gerar um relatório imprimível e com a identidade visual da Fatec pra levar pra fora do sistema (referência, prontuário físico, etc.).
- Impacto: Atendimentos não têm mais `tipoFerida` (quem já tinha ficou órfão do campo — não é lido em lugar nenhum, sem efeito). Pacientes ganham `tipoFerida` (string de uma lista fechada, ou null). Nenhum endpoint novo — o relatório só lê `GET /pacientes/:id` e `GET /pacientes/:id/atendimentos`, que já existiam.
- Como testar: Cadastrar/editar um paciente escolhendo o tipo de ferida e ver aparecer na barra e na tabela de "Pacientes"; clicar em "Relatório" (na ficha ou na lista) e conferir a logo, os dados do paciente e a evolução completa; usar Ctrl+P / "Imprimir / Salvar PDF" e confirmar que só o relatório aparece (sem menu/sidebar) e que as outras telas do módulo continuam imprimindo normalmente.
- Como reverter: Remover `/saude/ferida/relatorio.html`, o botão/coluna de ações relacionados, `tipoFerida` de `POST/PUT /pacientes` e devolver o campo ao formulário de atendimento (se necessário).

### [2026-07-17] Ferida: remove nascimento e data redundante, adiciona tipo de ferida, cobertura e município por lista
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/index.html`:
    - Removido "Data" da barra do paciente (`#meta-data`) — já é capturada automaticamente em cada atendimento (`createdAt`), era redundante.
    - Removido o campo "Data de nascimento" do cadastro/edição de paciente (`#pac-nascimento`) e da revisão do OCR (`#rev-nascimento`).
    - Novo campo "Tipo de ferida" (Neuropatia Diabética, Úlcera Venosa, Úlcera Arterial, Úlcera Mista), single-select, no topo dos campos clínicos.
    - Novo campo "Cobertura(s) utilizada(s)" (ALEVYN, AQUACEL AG+, AQUASEPT, BACTIGRASS, BOTA DE UNNA, CREME BARREIRA, GAZE KERLIX, HIDROCOLOIDE, PIELSANA, SOLOSITE — em ordem alfabética pt-BR), multi-select, imediatamente antes do relatório final (conduta).
    - `#pac-municipio` e `#rev-municipio` deixaram de ser texto livre e viraram `<select>` com os 16 municípios do consórcio CIS de Ivaiporã (lista fixa, a pedido do usuário — sem tela de gerenciamento por ora).
  - `/saude/ferida/app.js`:
    - Removidas as leituras/escritas de `pac-nascimento`/`rev-nascimento` (modal de paciente, revisão do OCR, `aplicarFichaIA`).
    - Nova função `selecionarMunicipio(selectId, valor)`: preenche o select preservando qualquer município fora da lista fixa (cadastro antigo ou lido por OCR) — injeta uma opção extra em vez de perder o dado.
    - `salvarAtendimento` envia `tipoFerida` e `cobertura`; `abrirDetalheAtendimento` exibe os dois no modal de detalhe do histórico.
  - `/src/rotas/ferida.js`:
    - `PUT /pacientes/:id` só grava `dataNascimento` se o campo vier explícito no corpo da requisição — evita apagar o nascimento de pacientes antigos agora que o formulário não o envia mais.
    - `POST /pacientes/:id/atendimentos` valida e grava `tipoFerida` (contra lista fechada) e `cobertura` (array).
- Tipo: Evolução de Funcionalidade / Simplificação
- Motivo: Propostas de melhoria do usuário — a data da barra era redundante com a autoria de cada atendimento; nascimento não é mais coletado no cadastro; tipo de ferida e cobertura eram informações da rotina clínica que faltavam no digital; município por lista evita erro de digitação e ganha consistência (facilita quem cadastra).
- Impacto: Atendimentos novos ganham `tipoFerida` (string ou null) e `cobertura` (array); registros antigos não têm esses campos (leitura tolera ausência). Pacientes novos não recebem `dataNascimento`; pacientes antigos mantêm o valor que já tinham (não é apagado ao editar). Município deixa de ser texto livre, mas qualquer valor antigo fora da lista continua visível/editável graças à opção extra injetada.
- Como testar: Abrir a ficha — não deve mais aparecer "Data" na barra do paciente nem "Data de nascimento" no cadastro; selecionar Tipo de ferida e Cobertura(s), salvar um atendimento e conferir os dois no detalhe do histórico; cadastrar paciente novo escolhendo o município por lista; editar um paciente antigo que já tinha nascimento e confirmar que o valor não desaparece do banco após salvar (mesmo sem campo na tela).
- Como reverter: Restaurar os campos `pac-nascimento`/`rev-nascimento`/`meta-data` removidos, os `<input type="text">` de município, e remover `tipoFerida`/`cobertura` dos três arquivos.

### [2026-07-16] Ferida: orientações de biofilme (sinais clínicos e indicadores) da ficha de papel
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/index.html` (Bloco expansível "💡 Orientações" sob o campo Sim/Não de Biofilme, no mesmo padrão já usado no exsudato: sinais clínicos — substância viscosa/espessa/brilhante, pigmentação amarelada/esverdeada, material gelatinoso que se reforma em 24–48h — e indicadores indiretos — falha no tratamento com antimicrobianos, atraso na cicatrização, ciclos recorrentes, aumento de exsudato, tecido friável, hipergranulação — copiados do verso da ficha oficial)
- Tipo: Ajuste de UI (apoio ao preenchimento)
- Motivo: Pedido do usuário — a ficha de papel tem sinais clínicos e indicadores pra ajudar a identificar biofilme, do mesmo jeito que tinha a tabela de indicadores de quantidade de exsudato; são orientação pra enfermeira, não um campo a preencher.
- Impacto: Nenhuma mudança de schema — é só texto de apoio, fechado por padrão (`<details>`), não altera o que é salvo no atendimento.
- Como testar: Abrir a ficha, ir até "Biofilme no leito" e clicar em "💡 Orientações para identificar o biofilme" — deve expandir mostrando sinais clínicos e indicadores indiretos.
- Como reverter: Remover o bloco `<details class="orienta">` do campo biofilme em `index.html`.

### [2026-07-16] Ferida: histórico virou modal separado, aberto só quando há retorno
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/index.html` (Removida a seção "Histórico do paciente" do fim da grade da ficha; o conteúdo (`#timeline`) foi pro novo `#modal-historico`, no mesmo padrão visual do modal de fichas antigas. Novo botão "Histórico de evolução (N)" na barra do paciente, ao lado de "Fichas antigas")
  - `/saude/ferida/app.js` (`selecionarPaciente` agora mostra o botão do histórico só quando `atendimentos.length > 0` — ou seja, só se já existe algum retorno registrado; nova função `setupHistoricoModal` abre/fecha o modal)
  - `/saude/ferida/ferida.css` (Removido o estilo da seção antiga `.hist`; `.timeline` ganhou rolagem própria dentro do modal)
- Tipo: Ajuste de UI / Evolução de Funcionalidade
- Motivo: Pedido do usuário — a evolução ficava embutida no fim da ficha, misturada com o formulário do atendimento atual. Separar em um botão que só aparece quando há retorno deixa claro que é uma consulta ao passado, não parte do preenchimento do atendimento de hoje.
- Impacto: Nenhuma mudança de schema ou de endpoint. No primeiro atendimento de um paciente (sem retornos ainda) o botão não aparece, já que não há histórico pra ver.
- Como testar: Selecionar um paciente sem atendimentos salvos — o botão não deve aparecer; salvar um atendimento e reabrir o paciente — o botão "Histórico de evolução (1)" deve aparecer na barra e, ao clicar, abrir o modal com a linha do tempo (que por sua vez continua abrindo o detalhe de cada atendimento ao clicar).
- Como reverter: Devolver a seção `<section class="panel hist">` com `#timeline` pro fim da grade da ficha, remover o botão `#btn-historico` e o `#modal-historico`, e reverter `selecionarPaciente`/`setupHistoricoModal`.

### [2026-07-16] Ferida: histórico ganhou detalhe do atendimento anterior
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/index.html` (Novo modal `#modal-atendimento`, reaproveitando o estilo `.modal-content.wide` já usado nas fichas antigas)
  - `/saude/ferida/app.js` (Cada linha do histórico ficou clicável — `renderTimeline` marca a linha como `.tl-clickable` e escuta o clique; nova função `abrirDetalheAtendimento` monta a visão completa daquele atendimento — dimensões, localização, tecido, bordas, pele adjacente, exsudato, infecção superficial/profunda, biofilme, dor e conduta — e `setupDetalheAtendimento` cuida de abrir/fechar o modal)
  - `/saude/ferida/ferida.css` (Estilo de hover/"Ver detalhes →" nas linhas do histórico e o layout do conteúdo do modal de detalhe)
- Tipo: Evolução de Funcionalidade / Correção de UX
- Motivo: Pedido do usuário — o histórico só mostrava um resumo de uma linha (dimensão, um item de tecido, tendência); não dava pra ver o que de fato foi registrado num atendimento anterior.
- Impacto: Nenhuma mudança de schema nem de endpoint — os dados já vinham no `GET /pacientes/:id/atendimentos`, só não eram exibidos por completo.
- Como testar: Selecionar um paciente com pelo menos um atendimento salvo, clicar numa linha do histórico e confirmar que abre o modal com todos os campos daquele atendimento específico; fechar pelo botão ou clicando fora.
- Como reverter: Remover o modal `#modal-atendimento` do HTML, a classe `.tl-clickable`/listener em `renderTimeline` e as funções `abrirDetalheAtendimento`/`setupDetalheAtendimento` do `app.js`.

### [2026-07-16] Ferida: seletor de paciente da ficha virou busca com sugestões
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/ferida.js` (Novo endpoint `GET /api/ferida/pacientes/:id` — busca um paciente específico, usado pra abrir a ficha direto por link e pelo fluxo de importação por OCR)
  - `/saude/ferida/index.html` (O `<select>` "Paciente" — que carregava todo mundo de uma vez — virou um campo de texto com sugestões: digita o nome e busca no servidor, igual à tela "Pacientes")
  - `/saude/ferida/app.js` (Removida a função `loadPacientes` que pré-carregava todos os pacientes; `selecionarPaciente` agora recebe o objeto do paciente direto, em vez de um id pra procurar numa lista já carregada; novas funções `setupBuscaPacienteFicha`, `buscarSugestoesFicha`, `escolherPacienteFicha`, `abrirPacientePorId`; a busca por paciente existente no fluxo de importação por OCR agora consulta o servidor em vez do array em memória)
  - `/saude/ferida/ferida.css` (Estilo do campo de busca e do menu de sugestões, reaproveitando o mesmo visual da tela "Pacientes")
- Tipo: Evolução de Funcionalidade / Correção de UX
- Motivo: Pedido do usuário — a lista de todos os pacientes aparecia inteira ao abrir a ficha; o certo era só aparecer conforme a pessoa digitasse o nome, como já funciona na tela "Pacientes".
- Impacto: Nenhuma mudança de schema. Passar a ficha (`?paciente=ID`), cadastrar, editar, excluir e importar por OCR continuam funcionando, agora todos selecionando o paciente direto pelo objeto retornado da API, sem depender de uma lista completa carregada de antemão.
- Como testar: Abrir a ficha, digitar ao menos 2 letras de um nome cadastrado e confirmar que só aparecem sugestões compatíveis (não a lista toda); escolher uma e ver a ficha carregar; cadastrar um paciente novo e confirmar que ele é selecionado automaticamente; editar, excluir e importar por OCR e confirmar que cada fluxo ainda seleciona o paciente certo.
- Como reverter: Restaurar o `<select id="sel-paciente">` no HTML e a função `loadPacientes` no `app.js`, revertendo `selecionarPaciente` para receber um id.

### [2026-07-16] Ferida: busca de pacientes também por município e nascimento
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/ferida.js` (`GET /api/ferida/pacientes?busca=` agora compara o termo contra nome + município + data de nascimento — em ISO `aaaa-mm-dd` e em `dd/mm/aaaa` — não só o nome)
  - `/saude/ferida/pacientes.html` (Placeholder e subtítulo da busca atualizados pra deixar claro que também busca por município/nascimento)
- Tipo: Correção/Evolução de Funcionalidade
- Motivo: A busca só considerava o nome; se a pessoa esquecesse o nome do paciente mas lembrasse a cidade ou a data de nascimento, a busca não encontrava nada.
- Impacto: Nenhuma mudança de schema. Buscas por data aceitam tanto `12/05/1990` quanto `1990-05-12` ou só parte (ex.: `1990`).
- Como testar: Na tela "Pacientes", buscar por um município cadastrado e por uma data de nascimento (nos dois formatos) e confirmar que o paciente aparece.
- Como reverter: Trocar `textoBusca(p).includes(busca)` de volta para `normalizar(p.nome).includes(busca)` em `ferida.js`.

### [2026-07-16] Ferida: tela "Pacientes" com busca por nome no servidor
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/saude/ferida/pacientes.html` (Nova tela: tabela com todos os pacientes — nome, nascimento/idade, município, data de cadastro — e campo de busca no topo. Reaproveita o mesmo `app.js` do módulo, só pra auth/layout/RBAC e a chamada à API; clicar numa linha abre a ficha do paciente em `index.html?paciente=ID`)
- Arquivos alterados:
  - `/src/rotas/ferida.js` (`GET /api/ferida/pacientes` ganhou o parâmetro opcional `?busca=`: filtra por nome no servidor, sem acento/caixa — ex.: "joao" encontra "João". A base do ambulatório é pequena, então lê a coleção toda e filtra em memória, sem exigir índice adicional no Firestore)
  - `/saude/ferida/app.js` (`initApp` agora detecta em qual tela está — se achar `#tabela-pacientes`, entra no modo lista/busca em vez do modo ficha; a ficha passou a ler `?paciente=ID` da URL pra abrir direto no paciente vindo da lista; busca com debounce de 300ms)
  - `/saude/ferida/index.html` (Botão "Ver todos os pacientes" no cabeçalho, ao lado de "Importar ficha")
  - `/saude/ferida/ferida.css` (Estilos da tela de lista: busca, tabela e linha clicável)
- Tipo: Nova Funcionalidade
- Motivo: Pedido do usuário — faltava uma tela só de consulta aos cadastros, com busca pelo nome, sem precisar abrir a ficha e catar no seletor.
- Impacto: Nenhuma mudança de schema. A busca é server-side (chama a API a cada digitação, com debounce) — atende ao pedido explícito de buscar "no banco" em vez de filtrar uma lista já carregada no navegador.
- Como testar: Abrir "Ver todos os pacientes", digitar parte do nome de um paciente cadastrado (com e sem acento) e conferir que a lista filtra; limpar a busca e conferir que volta a lista completa; clicar numa linha e confirmar que abre a ficha certa já selecionada.
- Como reverter: Remover `/saude/ferida/pacientes.html`, o parâmetro `busca` em `ferida.js`, o botão em `index.html` e as funções/estilos relacionados em `app.js`/`ferida.css`.

### [2026-07-16] Ferida: editar e excluir pacientes
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/ferida.js` (Novo endpoint `DELETE /api/ferida/pacientes/:id`: exclusão definitiva do paciente com remoção em lote das subcoleções `atendimentos` e `fichas_antigas` — o Firestore não apaga subcoleções automaticamente; log de auditoria com uid/e-mail de quem excluiu. O `PUT` de edição já existia e ganhou tela)
  - `/saude/ferida/index.html` (Botões de editar ✏️ e excluir 🗑️ ao lado do seletor de paciente — aparecem só com paciente selecionado e respeitam RBAC via `action-execute`; modal de paciente reutilizado para edição com campo oculto `pac-id`; upload de fichas antigas oculto no modo edição — a galeria própria já cuida disso)
  - `/saude/ferida/app.js` (Modal em dois modos novo/editar; submit decide POST ou PUT; exclusão com confirmação DUPLA — confirm com resumo do que será perdido + digitar o nome exato do paciente; após excluir, limpa a ficha e recarrega a lista)
  - `/saude/ferida/ferida.css` (Estilo `.pac-act` dos botões de ação do paciente)
- Tipo: Evolução de Funcionalidade
- Motivo: Faltava gerenciamento de pacientes — só era possível cadastrar. Decisão do usuário: editar e excluir (a opção "mover" foi descartada). Exclusão definitiva atende ao direito de eliminação (LGPD), com dupla confirmação por ser dado de saúde irrecuperável.
- Impacto: Nenhuma mudança de schema. Exclusão remove o documento do paciente e todas as subcoleções em lotes de 400.
- Como testar: Selecionar um paciente de teste → ✏️ altera nome/nascimento/município e salva → conferir a lista atualizada. 🗑️ → confirmar o aviso → digitar o nome exato → paciente some da lista e do Firestore (conferir subcoleções apagadas). Digitar nome errado deve cancelar. Com cargo nível 2 (leitura), os botões não aparecem.
- Como reverter: Remover o endpoint DELETE e os botões/handlers nos arquivos do módulo.

### [2026-07-16] Ferida: formulário digital alinhado à ficha de papel + escala de dor + orientações de exsudato
- Autor: Claude Code (a pedido do usuário — alinhamento confirmado)
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/index.html` (Novo campo "Pele adjacente (10 a 20 cm)" com as 5 opções do papel; exsudato Tipo ampliado de 3 para os 6 tipos do papel — Seroso, Serosanguinolento, Sanguinolento, Purulento, Seropurulento, Hemopurulento — e Cor ampliada com Rosado e Esverdeado conforme a tabela "Características"; novo campo "Dor" (Sim/Não) com escala de intensidade 1 a 10; a tabela "Quantidade × Indicadores" do papel virou bloco expansível de ORIENTAÇÕES sob o exsudato — é apoio ao preenchimento, não campo)
  - `/saude/ferida/app.js` (Coleta/aplicação dos novos campos `peleAdjacente` e `dor {presente, escala}`)
  - `/src/rotas/ferida.js` (Atendimentos armazenam `peleAdjacente[]` e `dor {presente, escala 1-10}` com validação)
  - `/saude/ferida/ferida.css` (Estilos do bloco de orientações, escala de dor e chips numéricos)
  - `/leitor-ficha/app.py` (Pele adjacente agora é campo extraído — não mais aviso; os 6 tipos de exsudato mapeiam direto, com cor/consistência derivadas da tabela impressa para todos; dor retorna nula — não existe no papel, preenchimento manual)
- Tipo: Evolução de Funcionalidade (alinhamento clínico)
- Motivo: Decisão do usuário de alinhar o formulário digital a tudo que existe na ficha de papel oficial, adicionar a avaliação de dor (Sim/Não + escala 1–10, novidade do digital) e tratar a tabela de indicadores de quantidade como orientação às enfermeiras, não como campo.
- Impacto: Atendimentos ganham os campos `peleAdjacente` e `dor`. Registros antigos não têm esses campos (leitura tolera ausência). O teste de leitura frente+verso segue 100%: pele adjacente agora chega como campo e preenche os chips automaticamente.
- Como testar: Abrir a ficha e conferir os novos campos e o bloco "💡 Orientações" sob o exsudato; salvar um atendimento com dor Sim + escala 7 e conferir no Firestore; importar a ficha de teste e verificar os chips de pele adjacente marcados.
- Como reverter: Remover os campos/blocos novos nos quatro arquivos e o campo no leitor.

### [2026-07-16] Ferida: leitor calibrado para o layout real da ficha + detecção de opções assinaladas
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/leitor-ficha/app.py` (Reescrito com base no PDF oficial "Ficha de Avaliação da Ferida - IMPRIMIR": NOME+DATA na mesma linha, MUNICÍPIO abaixo, dimensões em tabela 2×2 com busca posicional do valor à direita do rótulo, localização, seções delimitadas pelos títulos impressos com separação de colunas — Bordas|Pele adjacente e Infecção superficial|profunda —, conduta = linhas manuscritas após "Enfermeira (o):", e DETECÇÃO DE OPÇÕES ASSINALADAS por dois sinais combinados por linha visual: marca no texto lido ("(X) ...") e análise de tinta na região do checkbox à esquerda do rótulo, com baseline relativa ao próprio grupo e altura de referência mediana — autocalibra por digitalização)
  - `/leitor-ficha/debug_leitura.py` (Novo utilitário: mostra os itens OCR com posição e as taxas de tinta por opção, para calibrar com digitalizações reais)
- Tipo: Calibração / Evolução do OCR
- Motivo: O parser inicial era genérico e falhava no layout real. Com o PDF da ficha oficial, o leitor foi calibrado: em teste com frente+verso simulados (fonte cursiva + marcações X), extraiu 100% dos campos — cabeçalho, dimensões, tecido, bordas, exsudato (tipo com cor/consistência derivadas da tabela impressa + quantidade), sinais de infecção, biofilme (Sim/Não) e conduta. Pele adjacente e os tipos de exsudato sem equivalente digital (Serosanguinolento, Seropurulento, Hemopurulento) vão como avisos nas observações.
- Impacto: Divergências mapeadas entre a ficha de papel e o formulário digital, pendentes de decisão: o papel tem "Pele adjacente" (5 opções) e 6 tipos de exsudato (o digital tem 3); o papel não tem data de nascimento. A calibração final exige uma digitalização REAL preenchida à mão (letra de caneta em papel — o teste usou fonte cursiva).
- Como testar: `python debug_leitura.py <imagem>` mostra o que o OCR viu e as taxas de tinta; o fluxo completo via "Importar ficha (OCR)" no módulo.
- Como reverter: Restaurar a versão anterior de `/leitor-ficha/app.py`.

### [2026-07-16] Ferida: importação de fichas preenchidas com OCR local em Python (frente + verso)
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/leitor-ficha/app.py` (Serviço Flask + EasyOCR na porta 5001: recebe 1–2 imagens da ficha de papel, faz OCR local em português e extrai por heurística os campos manuscritos — nome, nascimento, município, data do atendimento, localização, dimensões em cm e conduta; o texto completo lido vai em "observações" para conferência)
  - `/leitor-ficha/requirements.txt` e `/leitor-ficha/README.md` (dependências e instruções: venv Python 3.13, instalação e execução)
- Arquivos alterados:
  - `/src/rotas/ferida.js` (Endpoint `POST /api/ferida/ler-ficha` agora faz proxy autenticado — token + RBAC — para o serviço Python local, configurável por `LEITOR_FICHA_URL`; atendimentos aceitam `dataAtendimento` opcional, a data original escrita na ficha de papel)
  - `/saude/ferida/index.html` + `app.js` + `ferida.css` (Botão "Importar ficha (OCR)" e modal em 3 etapas: fotos frente/verso → leitura → **conferência lado a lado**: a foto da ficha fica visível ao lado dos campos extraídos, todos EDITÁVEIS — nome, nascimento, município, data do atendimento, localização, dimensões e conduta — para a pessoa comparar com o papel e corrigir manualmente o que o OCR errou ou não identificou, com o texto completo lido disponível para consulta; ao aplicar, usa os valores corrigidos: reusa paciente existente pelo nome ou cadastra, anexa as fotos como fichas antigas, pré-preenche o formulário e mostra a localização como lembrete para marcar no mapa; timeline ordena/exibe pela data clínica `dataAtendimento`)
  - `/.env_exemplo` (Variável opcional `LEITOR_FICHA_URL`) e `/.gitignore` (`leitor-ficha/.venv/`, `__pycache__/`)
- Tipo: Nova Funcionalidade (OCR local)
- Motivo: Digitalizar o acervo de fichas de papel do ambulatório sem enviar dado de saúde para APIs externas (LGPD): o OCR roda localmente em Python. Princípio "leitura prepara, humano confirma": a enfermeira revisa tudo antes de salvar. Limitação registrada: o OCR não detecta quais opções impressas foram assinaladas — tecido/bordas/exsudato/infecção/biofilme voltam vazios para marcação manual, e a precisão em manuscrito é parcial.
- Impacto: Requer o serviço Python rodando (sem ele, o endpoint responde 503 com instrução clara e o restante do módulo funciona normalmente). Em produção (Vercel serverless) o serviço precisa ser hospedado em um servidor próprio/institucional e apontado por `LEITOR_FICHA_URL`. Atendimentos ganham o campo opcional `dataAtendimento`.
- Como testar: Rodar `leitor-ficha` (README), abrir Gestão Saúde → Ferida → "Importar ficha (OCR)", enviar frente e verso de uma ficha preenchida, conferir a revisão (campos extraídos + texto completo em observações) e aplicar. Verificar: paciente criado/reusado, fotos na galeria "Fichas antigas", formulário pré-preenchido, lembrete de localização sobre o mapa e histórico com a data original após salvar. Com o serviço parado, o botão deve retornar o erro 503 orientando a iniciá-lo.
- Como reverter: Remover a pasta `/leitor-ficha`, o endpoint `ler-ficha` e o campo `dataAtendimento` em `/src/rotas/ferida.js` e as seções de importação nos três arquivos de `/saude/ferida/`.

### [2026-07-16] Ferida: silhuetas do mapa do corpo mais realistas
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/saude/ferida/index.html` (Silhuetas anterior/posterior redesenhadas como contorno anatômico contínuo — cabeça, pescoço, ombros, braços com mãos, tronco com cintura, pernas e pés; vista posterior ganhou linhas sutis de referência; pés redesenhados em vista superior com os cinco dedos no contorno e proporção realista; CORREÇÃO: rótulos D/E dos pés estavam invertidos — agora seguem a perspectiva de quem olha os próprios pés: E à esquerda, D à direita, dedões voltados ao centro)
  - `/saude/ferida/ferida.css` (Nova classe `.sil-detalhe` para as linhas de referência do dorso)
- Tipo: Ajuste de UI
- Motivo: As silhuetas anteriores eram formas geométricas (círculo + retângulos) e dificultavam a localização precisa da ferida.
- Impacto: Apenas visual; a lógica de pinos, regiões e dados salvos não muda.
- Como testar: Abrir Gestão Saúde → Ferida e conferir as três figuras; clicar para marcar pinos e verificar que continuam funcionando.
- Como reverter: Restaurar os SVGs anteriores no `/saude/ferida/index.html`.

### [2026-07-15] Ferida: upload das fichas antigas de papel (fotos) anexadas ao paciente
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/ferida.js` (Novos endpoints: listar metadados, ver imagem completa, anexar e excluir em `ferida_pacientes/{id}/fichas_antigas`; validação de tipo/tamanho — data URL de imagem até ~950 mil chars, respeitando o limite de 1 MiB por documento do Firestore; autoria obrigatória em cada anexo)
  - `/saude/ferida/index.html` (Zona de upload com arrastar-e-soltar no modal Novo Paciente com pré-visualização; botão "Fichas antigas (N)" na barra do paciente; modal galeria com lista, visualização da imagem, adicionar e excluir)
  - `/saude/ferida/app.js` (Compressão de imagem no navegador via canvas — reduz resolução/qualidade em etapas até caber no limite do banco; envio das imagens após o cadastro do paciente; galeria de fichas antigas do paciente selecionado)
  - `/saude/ferida/ferida.css` (Estilos da zona de upload, miniaturas, galeria e visualizador)
  - `/regras/regra_do_app.md` (Documentação)
- Tipo: Nova Funcionalidade
- Motivo: O ambulatório tem fichas de papel preenchidas antes da digitalização. Ao cadastrar o paciente no sistema, a enfermeira fotografa/anexa as fichas antigas, preservando o histórico completo do paciente (fichas de papel + atendimentos digitais + retornos) em um único lugar.
- Impacto: Nova subcoleção Firestore `ferida_pacientes/{id}/fichas_antigas` (imagem base64 comprimida + metadados + autoria). A listagem retorna só metadados; a imagem completa é buscada sob demanda ao clicar em "Ver".
- Como testar: Em Gestão Saúde → Ferida, clicar em "Novo Paciente", preencher o nome e adicionar 1+ fotos na zona de upload; cadastrar. Selecionar o paciente e clicar em "Fichas antigas (N)" — ver a imagem, anexar mais uma e excluir uma. Conferir que com cargo nível 2 (leitura) os botões de anexar/excluir ficam ocultos.
- Como reverter: Remover os endpoints de fichas-antigas em `/src/rotas/ferida.js` e as seções correspondentes nos três arquivos de `/saude/ferida/`.

### [2026-07-15] Criação da categoria Gestão Saúde e do módulo Ferida (Ficha de Avaliação da Ferida)
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/saude/ferida/index.html` (Ficha de Avaliação da Ferida — mapa do corpo SVG clicável com pinos numerados, dimensões, tecido do leito, bordas, exsudato, sinais de infecção, biofilme, conduta e histórico de evolução)
  - `/saude/ferida/ferida.css` (Estilos do módulo seguindo o esboço aprovado do ambulatório: paleta petróleo/turquesa e marcador clínico próprio nos pinos)
  - `/saude/ferida/app.js` (Auth guard padrão, seleção/cadastro de paciente, marcação no mapa do corpo, coleta da ficha, salvamento e timeline de evolução com tendência melhora/estável/piora por área)
  - `/src/rotas/ferida.js` (API REST: CRUD de pacientes em `ferida_pacientes` e atendimentos em subcoleção `atendimentos`, com autoria obrigatória — uid, nome e data/hora em cada registro)
- Arquivos alterados:
  - `/core/permissions.js` (Nova categoria `saude` — "Gestão Saúde" — e módulo `ferida` atribuído a ADM N1/N2)
  - `/src/middlewares/auth.js` (Permissões padrão do módulo `ferida`: ADM N2 = 3; TI, RH e Visitante = 1 — dado de saúde é sensível, acesso só para cargos autorizados)
  - `/usuarios/app.js` (Módulo `ferida` no painel de gerenciamento de permissões e nos defaults de novo cargo)
  - `/api/index.js` (Registro das rotas `/api/ferida`)
  - `/regras/regra_do_app.md` (Documentação)
- Tipo: Nova Funcionalidade / Novo Módulo
- Motivo: Substituir a ficha de papel do ambulatório da FATEC Ivaiporã por um mini-prontuário digital de feridas, permitindo que as enfermeiras registrem o atendimento e acompanhem a evolução da ferida do paciente ao longo dos retornos. LGPD: dado de saúde é dado pessoal sensível — todo acesso passa por token JWT + RBAC, todo registro guarda autoria/data e os cargos sem autorização têm nível 1 (sem acesso) por padrão; recomenda-se criar um cargo "Enfermeira" no módulo Usuários com nível 3 apenas em Ferida.
- Impacto: Nova categoria "Gestão Saúde" na sidebar com o módulo "Ferida". Novas coleções Firestore: `ferida_pacientes` e subcoleções `atendimentos`.
- Como testar: Logar como ADM N1, abrir Gestão Saúde → Ferida, cadastrar um paciente de teste, marcar a ferida no mapa do corpo, preencher a ficha e salvar. Verificar se o histórico exibe o registro com autor e a tendência (melhora/estável/piora) a partir do segundo atendimento. Logar com cargo sem permissão e conferir o redirecionamento para o Meu Espaço.
- Como reverter: Remover a pasta `/saude`, a rota `/src/rotas/ferida.js`, o registro em `/api/index.js` e as referências em `/core/permissions.js`, `/src/middlewares/auth.js` e `/usuarios/app.js`.

### [2026-07-16] Reforma da Gestão de Acessos (fonte única de módulos + permissões por usuário)
- Autor: Equipe TI (com Claude Code)
- Branch: main (fork Mtreck)
- Arquivos alterados: `core/permissions.js`, `core/layout.js`, `src/middlewares/auth.js`, `src/rotas/usuarios.js`, `usuarios/app.js`, `usuarios/index.html`, `usuarios/usuarios.css`, guards de `emprestimo/`, `turmas/`, `avaliacoes/`, `empresas/`, `planejamento-academico/`, `rh/carga-horaria/`, `rh/funcionarios/`.
- Tipo: Feature + Refactor + Segurança.
- Motivo: A tela "Gerenciar Acessos" usava listas de módulos hardcoded e divergentes (Agenda e Funcionários nem apareciam) e não havia permissão individual por usuário.
- Impacto:
  - `core/permissions.js` virou a fonte única de módulos/tópicos (ver Regra Obrigatória na seção 4); a grade de acessos deriva dela, agrupada por tópico, com filtro por categoria e 4 módulos por linha.
  - Novo override por usuário (`users/{uid}.permissoes`), aplicado no middleware do backend (vence o cargo) e refletido no menu lateral e nos guards das páginas (nível efetivo). Azul = herdado do cargo; laranja = personalizado.
  - Novo endpoint `PUT /api/usuarios/:uid/permissoes` (só `adm_l1`); `PUT /config/permissions` agora também exige `adm_l1` (antes qualquer nível 3 em usuarios editava — brecha de escalada de privilégio).
  - Cargo novo nasce sem acesso a nenhum módulo.
- Como testar: como adm_l1, Usuários → Gerenciar Acessos → "Por Usuário": dar Acesso Total num módulo fora do cargo de um usuário de teste e conferir menu/página/API; dar "Sem Acesso" num módulo do cargo e conferir o bloqueio.
- Como reverter: `git revert` do commit correspondente; remover campo `permissoes` dos docs `users` afetados.

### [2026-05-27] Criação do módulo de Turmas e Categoria Docência
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/core/permissions.js` (Adicionado categoria 'docencia' e módulo 'turmas' à configuração estática)
  - `/usuarios/app.js` (Módulo 'turmas' adicionado ao painel de gerenciamento de permissões)
  - `/api/middlewares/auth.js` (Configuradas permissões padrão para o módulo 'turmas')
  - `/api/index.js` (Registradas as rotas do backend `/api/turmas`)
  - `/regras/regra_do_app.md` (Documentação do novo módulo e logs de alteração)
- Arquivos criados:
  - `/api/rotas/turmas.js` (Controlador backend para operações CRUD de turmas)
  - `/turmas/index.html` (Interface HTML principal do módulo)
  - `/turmas/app.js` (Lógica frontend do módulo com autenticação e carregamento de turmas)
  - `/turmas/turmas.css` (Estilos específicos do módulo de turmas)
- Tipo: Nova Funcionalidade / Expansão do Sistema
- Motivo: Disponibilizar um módulo de gerenciamento de turmas e disciplinas sob o novo menu "Docência" no menu lateral.
- Impacto: Novos fluxos de dados acadêmicos disponíveis para administradores e cargos autorizados no ecossistema Órbita FATEC.
- Como testar: Logar como ADM N1. Expandir o menu lateral na seção "Docência", clicar em "Turmas" e verificar o carregamento de dados de teste (seeding inicial). Criar uma turma, editar e excluir. Validar que as ações de escrita não são permitidas para cargos com nível < 3.
- Como reverter: Remover a pasta `/turmas`, as rotas em `/api/rotas/turmas.js` e as referências nos arquivos de configuração listados.

### [2026-05-25] Controle de Acesso por Níveis (1, 2 e 3) e Troca de Senha Obrigatória no Primeiro Acesso
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/api/middlewares/auth.js` (Implementada validação de níveis numéricos e normalização de legados)
  - `/api/rotas/usuarios.js` (Adicionada proteção de rota com requireModulePermission e flag de primeiro acesso)
  - `/core/layout.js` (Menu lateral filtrado e guarda de rotas dinâmicos atualizados para níveis; implementado modal de primeiro acesso)
  - `/meu-espaco/meu-espaco.js` (Widget cards filtrados por níveis)
  - `/emprestimo/app.js` (Controles de exibição e bloqueio baseados em níveis)
  - `/ensalamento/ensalamento.js` (Controles de exibição, bloqueio e formulário de visualização baseados em níveis)
  - `/usuarios/index.html` (Classes action-execute aplicadas a botões de ação e criação de cargos)
  - `/usuarios/app.js` (Substituição de checkboxes por selects de nível, controle de botões dinâmicos e nível inicial padrão de cargos)
  - `/usuarios/usuarios.css` (Regra CSS para desabilitar interruptor de status ativo/inativo e selects de permissões em modo leitura)
- Tipo: Evolução de Segurança, RBAC e Usabilidade
- Motivo: Simplificar o gerenciamento de acesso a cada módulo com Níveis de Acesso (1 - Sem Acesso, 2 - Apenas Leitura, 3 - Acesso Total), corrigir o erro de Forbidden 403 que impedia cargos permitidos de consultar a tela de Usuários, e forçar usuários recém-criados a redefinir sua senha inicial por motivos de segurança.
- Impacto: Gerenciamento mais intuitivo e à prova de falhas para os administradores. Segurança aprimorada forçando senhas personalizadas no primeiro login de novos funcionários.
- Como testar: 
  - Criar um novo usuário de teste. Logar com ele e verificar se o modal de Primeiro Acesso bloqueia a tela até que seja definida uma nova senha de 6 caracteres.
  - Logar com administrador e definir acesso do módulo de Usuários para T.I. como Nível 2 (Apenas Leitura). Logar como T.I., conferir que a página abre normalmente, mas todos os botões de ação e seletores de níveis estão bloqueados e esmaecidos.
- Como reverter: Desfazer as alterações nos arquivos listados acima.

### [2026-05-25] Validação e Filtragem Dinâmica de Permissões (RBAC / Sidebar e Ações)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/core/layout.js` (Implementada checagem das permissões dinâmicas no layout, ocultação de itens da sidebar e background refresh periódico)
  - `/core/layout.css` (Adicionada a regra global `.hide-execute .action-execute` para ocultar botões de escrita)
  - `/meu-espaco/meu-espaco.js` (Widget cards filtrados dinamicamente com base nas permissões reais do banco)
- Tipo: Refatoração de Segurança e Controle de Acesso
- Motivo: Fazer com que o menu lateral (sidebar) e os widgets do painel ocultem imediatamente os módulos para os quais o cargo do usuário não tem permissão de visualização ("ver"). Além disso, corrigir a ocultação de botões de escrita/ação (`action-execute`) caso a permissão "executar" seja falsa.
- Impacto: Interface limpa e totalmente integrada às decisões de permissão dos ADMs N1/N2 em tempo real, sem expor links e telas temporárias não autorizadas.
- Como testar: Logar como ADM N1. Em "Gerenciar Acesso", remover o "ver" de um módulo (ex: Empréstimos) para o cargo T.I. Logar como T.I. e verificar se o menu de Empréstimos e o widget correspondente no Meu Espaço desapareceram. Tentar acessar o link direto da página e verificar o redirecionamento imediato. Alterar "executar" para false e verificar se os botões de ação somem.
- Como reverter: Desfazer as alterações nos arquivos `/core/layout.js`, `/core/layout.css` e `/meu-espaco/meu-espaco.js`.

### [2026-05-25] Ajuste de Nome de Marca e Tempo de Expiração do QR Code (Fidelidade PWA)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/fidelidade/index.html` (Alterado marca do cabeçalho de ÓRBITA Fidelidade para FATEC Fidelidade para manter consistência)
  - `/fidelidade/validar.html` (Reduzido o tempo de expiração do QR Code de 120 segundos para 45 segundos, com tolerância a clock skew)
- Tipo: Ajuste de UI/Branding e Correção de Segurança (QR Code)
- Motivo: Evitar discrepância na marca e garantir que capturas de tela antigas expirem rapidamente, impedindo a validação de códigos defasados ou compartilhados.
- Impacto: Melhora a consistência visual do módulo PWA e aumenta consideravelmente a segurança e eficácia do QR Code auto-regenerativo.
- Como testar: Abrir a carteirinha PWA `/fidelidade/index.html`, verificar se o topo exibe FATEC Fidelidade. Tirar um print do QR Code, esperar passar o tempo de regeneração de 30 segundos mais a tolerância de 15 segundos e tentar validar o print. Deve constar como expirado.
- Como reverter: Reverter a marca do cabeçalho no `/fidelidade/index.html` e restaurar o limite de 120 segundos no `/fidelidade/validar.html`.

### [2026-05-25] Ajustes de Mobile, Filtro de Resumos e Correção de Notas no Meu Espaço
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/meu-espaco/index.html` (Inclusão do seletor dropdown para filtrar resumos de módulos no mobile)
  - `/meu-espaco/meu-espaco.js` (Lógica de filtragem dos widgets-card com base no módulo associado)
  - `/meu-espaco/meu-espaco.css` (Regras de responsividade para ocultar/exibir o filtro, compactar os widgets, reordenar as seções colocando avisos acima do quadro do funcionário, evitar colisões de botões nos cabeçalhos, correção da classe das notas para `.note-text-display` resolvendo o wrap de palavras e posicionamento dos botões, e desativação das posições absolutas de notas no mobile com exibição em flex grid e botões de ação sempre visíveis)
- Tipo: Ajuste de UI/UX Responsivo
- Motivo: Proporcionar uma forma para o ADM N1 filtrar a visualização de resumos no celular, reordenar as seções para dar preferência a avisos, corrigir o botão "Nova Nota" que colidia com o título da seção, corrigir o bug de transbordamento de texto horizontal nas notas (unboxing de classes) e o posicionamento flutuante do rodapé de ações, e contornar a quebra de layout causada por posições absolutas (arrastar) em telas estreitas de celular.
- Impacto: Interface móvel e desktop do Meu Espaço perfeitamente consistentes, com notas adaptáveis ao tamanho de tela e botões de ação (editar/excluir/fixar) utilizáveis em dispositivos móveis.
- Como testar: Acessar a página Meu Espaço em modo móvel e desktop. Escrever uma nota com texto longo contínuo (ex: "testetesteteste") e verificar se ocorre a quebra de linha. No celular, certificar-se de que as notas estão dispostas uma abaixo da outra de forma centralizada e que os botões de ação estão visíveis sem precisar passar o mouse.
- Como reverter: Reverter as alterações nos arquivos `/meu-espaco/index.html`, `/meu-espaco/meu-espaco.js` e `/meu-espaco/meu-espaco.css`.

### [2026-05-25] Ajustes de Layout Mobile e Filtros Interativos no Módulo de Empréstimos
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/emprestimo/index.html` (Inclusão do status "Cedido" no seletor de filtros e atributos `data-filter` nos cards de sumário)
  - `/emprestimo/emprestimo.css` (Ajustes de responsividade mobile e inclusão de `cursor: pointer` nos cards de sumário)
  - `/emprestimo/app.js` (Event listeners nos cards de sumário para atualizar o filtro de status ao serem clicados)
- Tipo: Ajuste de UI/UX Responsivo e Melhoria de Usabilidade
- Motivo: Melhorar a legibilidade dos cards de sumário no celular, evitar o espremimento da barra de busca, colocar o scanner de QR Code em um botão de ação flutuante (FAB), desativar o `backdrop-filter` do container para liberar o contexto do `position: fixed`, adicionar o status "Cedidos" no seletor de filtros de busca e permitir que o clique nos cards de sumário filtre a listagem automaticamente.
- Impacto: Melhora significativa na usabilidade e visual do painel de empréstimos, facilitando a navegação com atalhos de filtros rápidos por cliques diretos nos números do sumário.
- Como testar: Acessar a página de empréstimos. Verificar se há a opção "Cedidos" no select de status. Clicar em qualquer card de sumário superior (ex: clicando em "Disponíveis" ou "Total") e verificar se a listagem e o select de filtros atualizam condizentemente. No celular, verificar o layout compacto e a posição fixa do FAB do scanner no canto inferior direito.
- Como reverter: Desfazer as alterações nos arquivos `/emprestimo/index.html`, `/emprestimo/emprestimo.css` e `/emprestimo/app.js`.

### [2026-05-22] Ajuste de CORS para Desenvolvimento Local (PWA Fidelidade / Multi-porta)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/api/index.js` (Ajustado regex do CORS para aceitar qualquer porta em localhost/127.0.0.1)
- Tipo: Ajuste de Infraestrutura / Desenvolvimento
- Motivo: Evitar bloqueio por CORS ao testar o PWA Fidelidade ou outros módulos locais quando a porta do servidor local varia.
- Impacto: Permite que desenvolvedores façam requisições locais para a API do Vercel a partir de qualquer porta local.
- Como testar: Rodar o PWA localmente e verificar se as chamadas de rede à API ocorrem sem erros de CORS.
- Como reverter: Reverter o regex do CORS no arquivo `/api/index.js`.

### [2026-05-21] Correção de Bloqueio e Fallback de Usuários (PWA Fidelidade)
- Autor: Antigravity
- Branch: main
- Arquivos alterados/criados:
  - `/api/rotas/usuarios.js` (Adicionado fallback no endpoint `GET /me` se o documento no Firestore for inexistente)
  - Banco de Dados Firestore (Atualização em lote para definir `ativo: true` para usuários legados e criação de documento para o e-mail secundário do desenvolvedor)
- Tipo: Correção de Bug e API backend
- Motivo: Resolver o problema em que usuários existentes sem o campo `ativo` (ou novos usuários não sincronizados no Firestore) ficavam bloqueados na tela de login exibindo avisos de inatividade.
- Impacto: Garante que todos os usuários ativos do Firebase Auth consigam fazer login com sucesso, assumindo `ativo: true` por padrão e preenchendo as informações básicas na tela do PWA.
- Como testar: Realizar login no PWA com contas cujos campos `ativo` estavam ausentes ou inexistentes no Firestore.
- Como reverter: Remover o fallback da rota `/me` no backend e desfazer as atualizações de banco de dados.

### [2026-05-21] Rota de Alteração de Senha do Próprio Usuário (PWA Fidelidade)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/api/rotas/usuarios.js` (Criação da rota `PUT /me/senha`)
  - `/api/middlewares/auth.js` (Ajustado middleware para permitir que usuários não adm acessem rotas `/me/*`)
- Tipo: Segurança e API backend
- Motivo: Permitir que os funcionários cadastrados possam redefinir suas próprias senhas de forma segura diretamente através do PWA Fidelidade.
- Impacto: Funcionários não-administradores agora podem atualizar suas senhas via API utilizando seu Token ID do Firebase sem comprometer o isolamento de dados do painel web.
- Como testar: Enviar uma requisição HTTP `PUT /api/usuarios/me/senha` com um token JWT válido de usuário não administrador.
- Como reverter: Excluir a rota `PUT /me/senha` de `/api/rotas/usuarios.js` e desfazer a alteração no middleware `/api/middlewares/auth.js`.

### [2026-05-21] Otimização de Latência e Performance (Auth Caching)
- Autor: Antigravity
- Branch: main
- Arquivos criados/alterados:
  - `/core/layout.js` (Funções de cache e ajuste de setupLayout)
  - `/meu-espaco/meu-espaco.js` (Implementação de cache na inicialização)
  - `/empresas/app.js` (Implementação de cache na inicialização)
  - `/rh/funcionarios/app.js` (Implementação de cache na inicialização e ajuste de apiFetch)
  - `/rh/carga-horaria/carga-horaria.js` (Implementação de cache na inicialização e ajuste de apiFetch)
  - `/emprestimo/app.js` (Implementação de cache na inicialização)
  - `/usuarios/app.js` (Implementação de cache na inicialização)
  - `/ensalamento/ensalamento.js` (Implementação de cache na inicialização)
  - `/ensalamento/firebase-service.js` (Ajuste de apiFetch para suporte a cache)
- Tipo: Otimização de Performance e Latência
- Motivo: Eliminar o atraso e a tela de bloqueio "Autenticando..." nas transições de módulos causadas pelo recarregamento da página (MPA) e inicialização assíncrona do Firebase SDK.
- Impacto: Navegação instantânea e suave entre os módulos administrativos do Órbita.
- Como testar: Clicar nos links da sidebar e verificar se as páginas carregam sem exibir o loader "Autenticando...".
- Como reverter: Remover as chamadas a `getCachedAuth()` e limpar as funções correspondentes no `/core/layout.js`.

### [2026-05-20] Criação do Clube de Vantagens (Parceiros) e Refatoração de RH
- **Autor**: Equipe de Desenvolvimento
- **Branch**: main
- **Arquivos criados/alterados**:
  - `/empresas/index.html`, `/empresas/app.js`, `/empresas/empresas.css` (Módulo de Parceiros)
  - `/rh/funcionarios/index.html`, `/rh/funcionarios/app.js`, `/rh/funcionarios/funcionarios.css` (Módulo de Funcionários)
  - `/rh/carga-horaria/index.html`, `/rh/carga-horaria/carga-horaria.js`, `/rh/carga-horaria/carga-horaria.css` (Módulo de Carga Horária refatorado)
  - `/valida/index.html` (Módulo de validação pública)
  - `/api/rotas/empresas.js`, `/api/rotas/validacao.js`, `/api/index.js` (Novas rotas da API)
- **Tipo**: Criação e Refatoração
- **Motivo**: Lançamento do projeto de Cartão Fidelidade para funcionários via PWA Fidelidade, exigindo cadastro de empresas parceiras, separação da gestão de funcionários/turnos e validação pública de QR Codes.
- **Impacto**: O módulo antigo de Carga Horária do RH foi dividido em 2 submódulos dedicados e a validação pública de status de funcionários por UID foi implementada.
- **Como testar**:
  - Acessar o novo módulo "Parceiros" e criar/editar/excluir lojistas.
  - Acessar o módulo "Funcionários" sob Recursos Humanos e cadastrar turnos para um colaborador.
  - Testar a validação acessando `/valida/index.html?uid=<UID_DO_FUNCIONARIO>` e certificar-se de que exibe o status de ativo/inativo corretamente.
- **Como reverter**: Reverter os novos módulos nos arquivos de rota da API, limpar a lista de módulos no `permissions.js` e excluir as pastas `/empresas`, `/rh/funcionarios` e `/valida`.

### [2026-05-11] Conclusão da Migração Client-Server (REST API)
- **Autor**: Antigravity
- **Arquivos alterados**: Todos os módulos de frontend, pasta `/api`, `firestore.rules`.
- **Motivo**: O projeto amadureceu e o modelo de banco de dados aberto no front-end tornou-se inseguro.
- **Impacto**: Todo o tráfego do Firestore no frontend foi interceptado pela função utilitária `apiFetch` (usando Auth Tokens do Firebase). O Firestore foi trancado com `allow read, write: if false`, garantindo segurança e validação de regras exclusivamente pelo Backend hospedado no Vercel.

### [2026-05-04] Criação da documentação de regras do app
- **Autor**: Antigravity
- Branch: main (standard update)
- Arquivos alterados:
  - `/regras/regra_do_app.md`
- Tipo: criação
- Motivo: criar documentação técnica e registro de alterações do sistema para melhorar a manutenção e padronização.
- Impacto: Facilita a entrada de novos desenvolvedores e o controle de mudanças futuras.
- Como testar: Verificar a existência do arquivo na pasta `/regras` e validar a integridade dos links técnicos citados.
- Como reverter: Remover o diretório `/regras`.

### [2026-05-04] Criação do Meu Espaço
- Autor: Antigravity
- Branch: main (refactor)
- Arquivos criados:
  - `/meu-espaco/index.html`
  - `/meu-espaco/meu-espaco.css`
  - `/meu-espaco/meu-espaco.js`
- Arquivos alterados:
  - `index.html` (adicionado redirecionamento)
  - `login.js` (redirecionamento após login)
  - `permissions.js` (renomeado Dashboard para Meu Espaço)
  - `regras/regra_do_app.md` (documentação)
- Tipo: criação/alteração
- Motivo: substituir dashboard genérico por área personalizada do usuário focada em produtividade e avisos.
- Impacto: Melhora a utilidade da tela inicial e centraliza avisos institucionais de forma controlada.
- Como testar:
  - Logar no sistema e verificar se é levado para `/meu-espaco/index.html`.
  - Criar, editar e fixar uma nota pessoal no Quadro do Funcionário.
  - Logar como ADM N1 e criar um aviso no Quadro de Avisos.
  - Verificar se widgets de módulos aparecem corretamente conforme o cargo.
- Como reverter:
  - Restaurar redirecionamento no `login.js` e `index.html` para o hub original.
  - Reverter alterações de nome no `permissions.js`.

### [2026-05-05] Redesign Premium e Motor de Simulação (Ensalamento)
- Autor: Antigravity
- Branch: main (refactor/feature)
- Arquivos criados:
  - `/ensalamento/simulation-engine.js` (Lógica Heurística)
- Arquivos alterados:
  - `/ensalamento/index.html` (Layout 2 colunas)
  - `/ensalamento/ensalamento.js` (Integração com Motor)
  - `/ensalamento/ensalamento.css` (Premium Light Theme)
  - `regras/regra_do_app.md` (Documentação)
- Tipo: Refatoração de UI/UX e implementação de Inteligência de Dados.
- Motivo: Transformar o mapa de ocupação em uma ferramenta de decisão ativa que respeita as regras da faculdade (3+2, proibição de sábados).
- Impacto: Redução drástica no tempo de planejamento de aulas e eliminação de conflitos manuais de salas.
- Como testar:
  - Acessar o módulo de Ensalamento.
  - Abrir o "Simulador de Encaixe de Aulas".
  - Usar o botão "Padrão Institucional (3+2)" e verificar se a I.A. sugere grades válidas (Score Ideal).
  - Validar se o botão de fechar (X) está visível e vermelho.
- Como reverter:
  - Restaurar backups de `ensalamento.js` e `ensalamento.css` anteriores ao redesign dark-to-light.

### [2026-05-05] Categorização da Sidebar e Organização Administrativa
- Autor: Antigravity
- Branch: main (UI/UX enhancement)
- Arquivos alterados:
  - `permissions.js` (Definição de `CATEGORIES` e agrupamento de Usuários/Ensalamento)
  - `layout.js` (Lógica de agrupamento)
  - `layout.css` (Estilo `.layout-nav-category`)
  - `regras/regra_do_app.md` (Documentação)
- Tipo: Refatoração de Interface para Escala.
- Motivo: Agrupar funções correlatas sob o setor "Administrativo" e simplificar o menu lateral.
- Impacto: Menu mais enxuto e intuitivo para os administradores do sistema.
- Como testar:
  - Logar com diferentes cargos (ex: RH vs T.I.).
  - Verificar se os itens estão agrupados sob títulos como "RECURSOS HUMANOS" ou "GESTÃO DE T.I.".
  - Verificar se categorias vazias não são exibidas.
- Como reverter: Reverter a lógica de loop simples no `layout.js` e remover o objeto `CATEGORIES` de `permissions.js`.

### [2026-05-05] Categorias Retráteis na Sidebar
- Autor: Antigravity
- Branch: main (UX enhancement)
- Arquivos alterados:
  - `layout.js` (Lógica de toggle e ícones)
  - `layout.css` (Animações de chevron e visibilidade de grupos)
  - `regras/regra_do_app.md` (Documentação)
- Tipo: Melhoria de Usabilidade.
- Motivo: Permitir que o usuário organize seu espaço de trabalho recolhendo setores que não está utilizando no momento.
- Impacto: Interface mais limpa e personalizável.
- Como testar:
  - Clicar sobre o nome de uma categoria (ex: "ADMINISTRATIVO").
  - Verificar se os itens abaixo dela desaparecem e o ícone de seta gira.
  - Recarregar a página e verificar se as categorias voltam a aparecer abertas por padrão.

### [2026-05-05] Refinamento da Sidebar (Closed by Default)
- Autor: Antigravity
- Branch: main (UX refinement)
- Arquivos alterados:
  - `layout.js` (Lógica de recolhimento inicial com inteligência de contexto)
  - `layout.css` (Ajuste de contraste das labels e espaçamento)
  - `regras/regra_do_app.md` (Documentação)
- Tipo: Ajuste de Interface e Visibilidade.
- Motivo: Melhorar o foco do usuário ao abrir o sistema e garantir que os títulos das categorias sejam legíveis em qualquer monitor.
- Impacto: Menu inicial mais limpo e títulos com leitura facilitada.
- Como testar:
  - Logar no sistema ou atualizar a página.
  - Verificar se as categorias extras estão fechadas.
  - Verificar se a categoria do módulo atual (ex: Meu Espaço) permanece aberta automaticamente.
  - Observar o novo brilho e destaque dos títulos das categorias.

### [2026-05-05] Localização de E-mails e Correção de Reset de Senha
- Autor: Antigravity
- Branch: main (Bugfix/Localization)
- Arquivos alterados:
  - `usuarios/app.js` (Adicionado `auth.languageCode = 'pt-br'`)
  - `regras/regra_do_app.md` (Documentação)
- Tipo: Ajuste de Comunicação Institucional.
- Motivo: E-mails de redefinição estavam sendo enviados em inglês e caindo em filtros de spam por falta de formatação correta.
- Impacto: Melhora a experiência de recuperação de conta para os funcionários.
- Como testar: No módulo Usuários, selecionar um usuário, clicar em "Redefinir Senha" e verificar se o e-mail chega em Português.

### [2026-05-05] Tela de Redefinição de Senha Personalizada
- Autor: Antigravity
- Branch: main (Feature/Security)
- Arquivos criados:
  - `redefinir-senha.html` (Layout institucional)
  - `redefinir-senha.js` (Lógica de confirmação de senha)
- Tipo: Melhoria de Identidade Visual e Segurança.
- Motivo: Substituir a página padrão e "feia" do Firebase por uma experiência premium que mantém o usuário dentro do ecossistema Órbita.
- Impacto: Aumento da confiança do usuário no processo de recuperação de conta.
- Configuração Necessária: No Console do Firebase, em **Authentication > Settings > User Actions**, alterar a **URL de Ação** para o endereço final desta página.

### [2026-05-05] Refinamento de Hierarquia na Sidebar
- Autor: Antigravity
- Branch: main (UX adjustment)
- Arquivos alterados:
  - `permissions.js` (Removida categoria de Meu Espaço)
  - `layout.js` (Lógica para itens de nível superior)
  - `regras/regra_do_app.md` (Documentação)
- Tipo: Ajuste de Interface.
- Motivo: Destacar o "Meu Espaço" como o ponto de partida central do usuário, deixando-o fora das categorias para acesso imediato.
- Impacto: Navegação mais rápida para a Home do sistema.

### [2026-05-11] Fase 1: Criação da Arquitetura Cliente-Servidor (Backend Vercel)
- Autor: Antigravity
- Branch: main (architecture-refactor)
- Arquivos criados:
  - `api/index.js` (Entry point do Express)
  - `api/firebase.js` (Inicialização do Firebase Admin SDK)
  - `api/middlewares/auth.js` (Middleware de validação de ID Token)
  - `vercel.json` (Configuração de Serverless Functions do Vercel)
- Arquivos alterados:
  - `package.json` (Inclusão de scripts e dependências)
- Tipo: Refatoração de Arquitetura (BaaS para REST API).
- Motivo: Aumentar a segurança e criar um backend verdadeiro rodando em ambiente Serverless Node.js no Vercel, encapsulando as regras de acesso ao Firestore com Firebase Admin.
- Impacto: Desacoplamento do Firebase Firestore do Frontend (em andamento) garantindo que o banco de dados só seja acessado de forma validada pela API.
- Como testar:
  - Rodar `npm start` localmente e acessar `http://localhost:3000/api` para ver a mensagem online.
- Como reverter:
  - Remover o diretório `api/` e `vercel.json`.

### [2026-05-11] Fase 2: Migração do Módulo de Empréstimos para a API REST
- Autor: Antigravity
- Branch: main (api-migration-emprestimos)
- Arquivos criados:
  - `api/rotas/emprestimos.js` (Rotas GET e PUT)
- Arquivos alterados:
  - `api/index.js` (Registro das rotas)
  - `emprestimo/app.js` (Refatorado para usar `apiFetch` via HTTP no lugar de Firebase Client SDK, substituído o `onSnapshot` por polling).
- Tipo: Migração de Backend.
- Motivo: Transferir a lógica de consulta e gravação do banco de dados para a API protegida por Token JWT do Firebase.
- Impacto: Maior segurança. Os dados de `notebooks` não são mais acessíveis diretamente pelo front-end sem passar pelo servidor.
- Como testar:
  - Abra 2 terminais: um rodando o front-end (ex: Live Server) e outro rodando o back-end (`npm run dev`).
  - Acesse a página de empréstimos e faça uma reserva ou altere o status de um equipamento. Verifique na aba *Network* se as requisições estão indo para `http://localhost:3000/api/emprestimos`.

### [2026-05-11] Fase 2.1: Migração do Módulo de Usuários para a API REST
- Autor: Antigravity
- Branch: main (api-migration-usuarios)
- Arquivos criados:
  - `api/rotas/usuarios.js` (Rotas GET, POST, PUT, DELETE para usuários, cargos e permissões globais)
- Arquivos alterados:
  - `api/index.js` (Registro das rotas de usuários)
  - `usuarios/app.js` (Substituição massiva do Firebase Client SDK para `apiFetch`. Remoção completa do *Secondary App* para criação de usuários. Implementação de polling no lugar de `onSnapshot`).
- Tipo: Migração de Backend e Refatoração de Segurança.
- Motivo: A criação de usuários pelo front-end exigia uma "gambiarra" de deslogar/logar ou criar uma instância secundária do Firebase, o que é instável e inseguro. Gerenciar regras de RBAC (cargos e permissões) direto no client side também abria margem para manipulação.
- Impacto: Aumento drástico de estabilidade ao criar contas (agora feito pelo `firebase-admin` via REST API) e fechamento de brechas de segurança no acesso à coleção `users` e `config/permissions`.
- Como testar:
  - Logue como ADM N1.
  - Acesse o módulo Usuários. Crie um novo cargo. Altere as permissões globais. Crie um novo usuário.
  - Verifique se as chamadas de rede vão para `/api/usuarios`.

### [2026-05-22] Fase 3: Criação do Módulo FATEC Fidelidade Web (PWA)
- Autor: Antigravity
- Branch: main (fidelidade-pwa)
- Arquivos criados:
  - `fidelidade/index.html` (Interface PWA, carteirinha e clube de vantagens mobile-first)
  - `fidelidade/fidelidade.css` (Visual premium dark gradient e glassmorphism para a carteirinha)
  - `fidelidade/fidelidade.js` (Autenticação, busca de perfil, QR Code dinâmico, lista de parceiros, busca e banner de atalho PWA)
- Arquivos alterados:
  - `core/permissions.js` (Módulo cadastrado e atribuído a todos os cargos)
  - `auth/login.js` (Redirecionamento automático pós-login via parâmetro `?redirect=`)
  - `regras/regra_do_app.md` (Documentação e histórico de alterações)
- Tipo: Nova Funcionalidade (PWA Mobile-first).
- Motivo: Substituir o aplicativo nativo em Expo por um PWA totalmente responsivo integrado ao Órbita, permitindo que usuários do iOS (iPhone) e Android acessem a carteirinha e parceiros adicionando um atalho na tela inicial do celular, sem precisar de compilação ou download de APKs.
- Impacto: Acesso rápido, seguro e dinâmico ao cartão de fidelidade com QR Code auto-regenerativo a cada 30 segundos, integrado diretamente ao controle de status de usuários do Órbita.
- Como testar:
  - Abra o navegador e acesse `/fidelidade/index.html`.
  - Se deslogado, deve redirecionar para `/auth/login.html?redirect=/fidelidade/index.html`.
  - Após o login, deve exibir a carteirinha digital com QR Code atualizando a cada 30 segundos e a lista de parceiros credenciados na seção "Clube de Vantagens".
  - Simule o acesso em modo PWA standalone ou utilize o banner de instalação no celular para fixar o atalho.

## 9. Diretrizes de Deploy no Vercel (Zero Config)

Para garantir que o front-end estático e a API servida em Node.js (funções serverless) rodem corretamente em harmonia no Vercel, siga estas diretrizes essenciais de deploy:

1. **Evitar Configuração de Builds Legada**:
   - **NÃO** insira a propriedade `"builds": [...]` no arquivo `vercel.json`. 
   - A configuração com `"builds"` anula as definições do projeto no painel da Vercel e impede o Vercel de gerenciar o build automaticamente, resultando frequentemente em erro de compilação ou telas `404 Not Found`.

2. **Roteamento Zero Config**:
   - A API do back-end reside na pasta `/api`. O Vercel detecta automaticamente e compila quaisquer arquivos dentro de `/api` (como `/api/index.js`) em funções serverless de forma transparente.
   - O arquivo `vercel.json` deve conter apenas as regras de redirecionamento (`rewrites`) para direcionar chamadas HTTP sob `/api/*` ao entry point `/api/index.js`, e os cabeçalhos de CORS globais para tráfego seguro.

3. **Deploy por Integração do Git**:
   - O repositório está integrado à Vercel. Qualquer push ou mesclagem à branch `main` disparará um deploy de produção automaticamente.
   - Mudanças nas rotas da API em desenvolvimento local devem ser testadas localmente (`npm run dev`) antes do push para produção.

---
*Fim da documentação.*

---

## 10. Histórico de alterações — Sessão 2026-05-26 (Branch: ensalamento)

### [2026-05-26] Renomeação e Reestruturação do Módulo de Ensalamento para Planejamento Acadêmico
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados/criados:
  - `/planejamento-academico/` (pasta criada, substitui `/ensalamento/`)
  - `/planejamento-academico/index.html` (atualizado título, meta, URL do módulo)
  - `/planejamento-academico/ensalamento.js` (renomeado internamente)
  - `/planejamento-academico/ensalamento.css`
  - `/planejamento-academico/firebase-service.js`
  - `/planejamento-academico/simulation-engine.js`
  - `/core/permissions.js` (URL do módulo atualizada para `/planejamento-academico/index.html`)
  - `/regras/regra_do_app.md` (documentação)
- Tipo: Refatoração de Estrutura e Identidade
- Motivo: O módulo de Ensalamento evoluiu para um sistema completo de Planejamento Acadêmico que vai além do simples ensalamento de salas, passando a incluir controle de matrizes curriculares, turmas por período letivo e simulação de grade semanal. O ID interno (`ensalamento`) foi mantido na API e no sistema de permissões para não quebrar a autenticação RBAC.
- Impacto: A pasta `/ensalamento` foi excluída. O módulo agora reside em `/planejamento-academico`. Nenhuma rota de API foi alterada.
- Como testar: Acessar `/planejamento-academico/index.html` e verificar se o módulo carrega corretamente.
- Como reverter: Restaurar a pasta `/ensalamento` e reverter o `permissions.js`.

### [2026-05-26] Sistema de Importação de Turmas por Lotes/Períodos Letivos
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados:
  - `/planejamento-academico/index.html` (botão e modal de importação com campo de título do lote)
  - `/planejamento-academico/ensalamento.js` (lógica de importação XLSX com campo `academicPeriod`, filtros dinâmicos de período, renderização de turmas filtradas)
  - `/api/rotas/ensalamento.js` (rota `POST /custom/classes/batch` para importação em lote)
- Tipo: Nova Funcionalidade
- Motivo: O administrativo precisava de uma forma de separar as turmas por semestre. Agora ao importar um XLSX de turmas, o usuário define o título do período (ex: `2026.2`). No próximo ano, pode criar um novo lote `2027.1` sem apagar o histórico anterior.
- Impacto: Turmas são exibidas filtradas pelo período letivo selecionado. Os dropdowns de período são populados dinamicamente com base nos valores existentes no banco.
- Como testar: Importar um arquivo XLSX de turmas informando o período `2026.2`. Verificar se o dropdown de período exibe `2026.2` e se as turmas aparecem filtradas corretamente.

### [2026-05-26] Salas: Campo Bloco Substituído por Tipo de Equipamentos (UNI / CCM / CC)
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados:
  - `/planejamento-academico/index.html` (modal de sala e filtro da aba Salas)
  - `/planejamento-academico/ensalamento.js` (funções `openRoomModal`, `handleRoomSubmit`, `renderRooms`)
- Tipo: Evolução de Funcionalidade
- Motivo: O campo "Bloco" não tinha valor prático para o ensalamento. O controle interno do tipo de equipamento disponível em cada sala (universitária, medicina, genérica) é mais relevante para alocação correta.
- Impacto: O campo `block` foi substituído pelo campo `equipmentType` no Firestore. Salas sem o campo exibem `UNI` por padrão (fallback seguro). O filtro da aba Salas agora é por tipo de equipamento.
- Tipos disponíveis:
  - `UNI` — Universitária (padrão)
  - `CCM` — Carteira e Cadeira Medicina
  - `CC` — Carteira e Cadeira
- Como testar: Criar/editar uma sala e verificar se o dropdown de tipo de equipamentos aparece no lugar do campo Bloco.
- Como reverter: Restaurar o campo `room-block` no HTML e `block` no JS.

### [2026-05-26] Simulador Simplificado — Apenas Tipo (Presencial / EAD / Carga Reservada)
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados:
  - `/planejamento-academico/ensalamento.js` (função `renderSimulationLessons`, `updateLesson`, `addLessonToSimulation`, `applyInstitutionalPattern`)
- Tipo: Simplificação de UI/UX
- Motivo: O simulador anterior exibia muitos campos por aula (nome de disciplina, período, modo de sala, sala específica, tipo de sala), causando confusão. Como a instituição opera exclusivamente no turno noturno com período fixo (P1+P2 — Noite Inteira) e usa sempre o modo automático (I.A.), esses campos foram removidos.
- Impacto: Cada aula no simulador exibe apenas um campo: **Tipo** (Presencial / EAD / Carga Reservada). Período é fixado em `[1, 2]` e `roomSelectionMode` é sempre `'auto'`. O padrão Institucional (3+2) funciona como antes.
- Como testar: Abrir o Simulador, clicar em "Padrão (3+2)" e verificar se cada aula exibe apenas o seletor de Tipo. Adicionar uma aula avulsa e confirmar que não há campos extras.
- Como reverter: Restaurar a versão anterior de `renderSimulationLessons` com todos os campos.

### [2026-05-26] Correção: Coleção `simulations` liberada na API
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados:
  - `/api/rotas/ensalamento.js` (adicionado `'simulations'` ao array `ALLOWED_COLS`)
- Tipo: Correção de Bug (403 Forbidden)
- Motivo: Ao tentar salvar o resultado de uma simulação, a API retornava `403 Coleção não permitida` porque a coleção `simulations` não estava na whitelist de coleções autorizadas do CRUD genérico.
- Impacto: O simulador agora consegue salvar e recuperar resultados de simulações no Firestore.
- Como testar: Rodar uma simulação no Simulador e verificar se nenhum erro 403 aparece no console.

### [2026-05-26] Correções de Contraste e Visual no Módulo de Planejamento Acadêmico
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados:
  - `/planejamento-academico/ensalamento.css` (classes `.pill-ead` e `.pill-reservada`)
  - `/planejamento-academico/ensalamento.js` (texto de turmas na tabela de ocupação, botão deletar)
  - `/planejamento-academico/index.html` (botão "Ajustar Necessidades" no simulador)
- Tipo: Correção de UI / Acessibilidade
- Problemas corrigidos:
  - **Botão "Ajustar Necessidades"**: Tinha `background: rgba(255,255,255,0.05)` — texto branco em fundo branco/transparente = invisível. Corrigido para `background: #1E293B` (azul marinho escuro).
  - **Pill EAD**: Sem background, texto amarelo em fundo branco = invisível. Corrigido para `background: #FEF9C3; color: #854D0E`.
  - **Pill Reservada**: Background roxo muito transparente. Corrigido para `background: #F3E8FF; color: #7E22CE`.
  - **Nome das turmas na tabela**: Estava `color: rgba(255,255,255,0.4)` (branco em fundo branco). Corrigido para `color: #64748B`.
  - **Botão deletar na tabela**: Opacidade `0.3` aumentada para `0.6` com hover chegando a `1.0`.
- Como testar: Acessar a aba Calendário → Mapa de Ocupação e verificar se os pills de EAD e Reservada são legíveis. Verificar se o botão "Ajustar Necessidades" no Simulador está visível.

### [2026-05-26] Gerenciar Acessos: Renomeação e Adição do Módulo Parceiros
- Autor: Antigravity
- Branch: ensalamento
- Arquivos alterados:
  - `/usuarios/app.js` (array `MODULES` e permissões padrão de novos cargos)
- Tipo: Atualização de Identidade e Cobertura de Permissões
- Motivo: O card de módulo na tela de Gerenciar Acessos ainda exibia "Ensalamento" em vez de "Planejamento Acadêmico". Além disso, o módulo "Parceiros" (empresas) não aparecia nos cards de permissão, impossibilitando o controle granular de acesso a ele.
- Impacto:
  - O card agora exibe `🏫 Planejamento Acadêmico` (ID interno `ensalamento` mantido).
  - Novo card `🤝 Parceiros` (ID `empresas`) adicionado à lista.
  - Novos cargos criados pelo sistema já recebem o campo `empresas: 1` (Sem Acesso) por padrão.
- Como testar: Acessar Usuários → Gerenciar Acessos e verificar se aparecem os cards de "Planejamento Acadêmico" e "Parceiros".

### [2026-05-27] Ajuste na Simulação de Aulas Não Presenciais (EAD/Carga Reservada) e Otimização do Consumo do Firebase
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/api/rotas/ensalamento.js` (Rota `/custom/checkConflict` adaptada para validar conflitos apenas entre aulas presenciais/EAD concorrentes)
  - `/planejamento-academico/firebase-service.js` (Atualização de `checkConflict` para aceitar e passar o `classType`)
  - `/planejamento-academico/ensalamento.js` (Passagem do `classType` nas validações de conflito ao salvar no calendário; implementado fallback na função `loadLessonsFromMatrix` para buscar disciplinas de outros períodos letivos do mesmo ano caso não existam no período letivo atual, resolvendo o problema de matrizes não carregando quando turmas e disciplinas estão cadastradas em períodos alternados, como 2026.1 e 2026.2; implementado lazy loading no `openSimulationModal` para carregar disciplinas apenas quando a ferramenta de simulação for aberta, economizando 501 leituras no Firestore a cada carregamento de página e a cada salvamento)
  - `/planejamento-academico/simulation-engine.js` (Prioridade de ordenação ajustada, motor `areClassesAvailable` adaptado para não bloquear slots por carga reservada, `scoreWeeklyDistribution` e `attemptAllocation` ajustados para não aplicar penalidades ou marcar a simulação como inviável caso a carga reservada fique como "Não Alocada"; corrigido ReferenceError da variável `unallocated` ao substituí-la por `unallocatedBlocking` na verificação de distribuição ideal)
  - `/usuarios/app.js` (Aumento do timer de polling para 2min, verificação de visibilidade da aba via `document.hidden`)
  - `/meu-espaco/meu-espaco.js` (Aumento dos timers de notas e avisos para 2min, verificação de `document.hidden`)
  - `/emprestimo/app.js` (Aumento de timers de polling para 2min, verificação de `document.hidden`)
  - `/rh/funcionarios/app.js` (Aumento do timer de atualização para 2min, verificação de `document.hidden`)
  - `/rh/carga-horaria/carga-horaria.js` (Aumento do timer de atualização para 2min, verificação de `document.hidden`)
- Tipo: Correção de Regras de Negócio e Otimização de Performance/Custos (Firebase)
- Motivo:
  - O simulador de grade gerava pontuações baixas e sugestões "INVIÁVEIS" devido ao limite de 5 dias na semana concorrendo com 6 aulas totais. Como a **Carga Reservada** não ocupa espaço e os alunos não têm aula física, ela deve poder ficar "Não Alocada" (`weekday: null`) sem penalidade, e a aula de **EAD** deve ocupar seu próprio dia de semana sem coexistir com aulas presenciais.
  - O consumo do Firebase atingiu 97% da cota gratuita diária. Identificamos que requisições de segundo plano (`setInterval`) estavam rodando excessivamente de forma desnecessária, mesmo quando as abas do navegador estavam ocultas ou inativas.
- Impacto:
  - Simulações geradas com sucesso com a Carga Reservada alocada de forma adequada (ou não alocada de forma segura) e EAD respeitando o dia útil dedicado, resultando em status "BOA/IDEAL" e scores altos (>150).
  - Redução drástica nas leituras do Firestore (estimada em mais de 90% em abas ociosas e 4x em abas ativas), garantindo a longevidade da cota gratuita do banco de dados.
- Como testar:
  - No simulador, rodar a simulação para uma turma com 6 matérias (ex: 3 presenciais, 2 EAD, 1 Carga Reservada) e verificar se o resultado dá "BOA/IDEAL" e a Carga Reservada vai para "Não Alocada" de forma pacífica.
  - Abrir a aba de Rede (Network) no navegador, alternar de aba (minimizando o Órbita) e verificar que as requisições recorrentes cessam em segundo plano.
- Como reverter: Desfazer as alterações de código e restaurar as versões anteriores dos arquivos listados.

### [2026-05-28] Cadastro de Itens Genéricos e Suporte a Itens sem QR Code (Módulo de Empréstimos)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/emprestimo/index.html` (Adicionado botão "Cadastrar Item", modal de cadastro com datalist de tipos e checkbox de QR Code; placeholders genéricos)
  - `/emprestimo/app.js` (Adicionado lógica de controle do modal, submissão do formulário com validação de ID duplicado e persistência no banco, exibição do tipo do item nos cards, desativação de QR em itens configurados sem ele, e refatoração do scanner para extrair IDs arbitrários)
- Tipo: Nova Funcionalidade e Melhoria de UX
- Motivo: O módulo de empréstimos suportava apenas notebooks de forma estrita. Havia a necessidade de cadastrar e rastrear outros tipos de itens (projetores, adaptadores, etc.) e controlar se o item possui etiqueta física de QR Code ou não. O scanner de QR Code precisava reconhecer os novos códigos genéricos sem ficar restrito à regex antiga.
- Impacto: Maior flexibilidade no controle de inventário. Agora o usuário pode gerenciar qualquer ativo da instituição com ou sem rastreamento de QR.
- Como testar:
  - Acessar o módulo de Empréstimos.
  - Clicar em "Cadastrar Item" e preencher um ID (ex: Proj_01) e tipo (ex: Projetor) com a caixa de QR ativa. Validar se o card renderiza e permite "GERAR QR".
  - Cadastrar outro item desmarcando o QR Code. Confirmar que ele exibe a pill desabilitada "SEM QR".
  - Escanear um QR code de item genérico e verificar se redireciona para a página de movimentação com sucesso.
- Como reverter: Desfazer as alterações nos arquivos listados e restaurar as versões anteriores.

### [2026-05-28] Reformulação do Cartão FATEC, QR Code Fixo e Impressão de PDF Dobrável
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/fidelidade/index.html` (Reposicionado o botão "Voltar ao Painel" para o canto esquerdo da marca; removida a barra de progresso e timer de 30s; adicionado botão "Imprimir / Gerar PDF" abaixo do QR code; incluída a div `#print-area` no final do corpo; removido seletor de cargo do cartão; adicionada a imagem `logoFatec.png` no lugar do logo de texto FATEC)
  - `/fidelidade/fidelidade.css` (Atualizado as variáveis globais `:root` para o "Light Theme" do Órbita; mantido o estilo degradê escuro do cartão físico digital; adicionadas regras `@media print` para renderizar o cartão duplo dobrável com a linha tracejada e QR code compacto no verso; estilizada a imagem do logotipo do FATEC no cartão com filtro de brilho invertido para contraste premium; ajustados botões e categorias para o tema claro)
  - `/fidelidade/fidelidade.js` (Removido o temporizador de QR Code de 30 segundos e sua interface; modificado a URL geradora do QR Code para conter apenas o `uid` estático do usuário; implementado o status checker leve de 2 minutos que respeita a inatividade da aba via `document.hidden`; implementado a função global `window.gerarPDF()` para montagem do layout dobrável com frente e verso e disparo nativo de impressão)
  - `/fidelidade/validar.html` (Removida a validação obrigatória do parâmetro `t` e expiração de 45 segundos; adaptada a interface do validador para aceitar leituras do QR Code estático com validação direta de status de inatividade no banco de dados)
- Tipo: Evolução de UI/UX, Otimização de Performance e Redução de Leitura (Firestore)
- Motivo: Alinhar visualmente o módulo FATEC Fidelidade com a identidade institucional clara do Órbita, melhorar a usabilidade do cartão móvel utilizando a logo oficial `logoFatec.png` sem exibir cargos redundantes, permitir a impressão física de um cartão duplo dobrável com frente e verso (QR Code atrás), e reduzir consideravelmente o consumo de leitura do banco de dados do Firebase.
- Impacto: Identidade visual perfeitamente alinhada e premium. Menor sobrecarga na cota de leitura do banco Firebase. Lojistas e funcionários conseguem imprimir uma carteirinha frente e verso para recortar e dobrar, e a validação do QR Code estático impresso no papel continua 100% segura contra inativações de conta em tempo real.
- Como testar:
  - Acessar `/fidelidade/index.html`. Verificar se a página está sob o Light Theme, se o logo `logoFatec.png` branco e o subtexto "Fidelidade" aparecem na carteirinha e se o cargo não é mais exibido.
  - Verificar que o botão de voltar está na esquerda do cabeçalho.
  - Validar que o QR Code estático é renderizado logo abaixo e não pisca a cada 30s.
  - Clicar em "Imprimir / Gerar PDF" e confirmar se no preview de impressão o cartão duplo (Frente, linha de dobra e Verso com o QR Code) aparece centralizado em folha A4 e sem outros elementos.
- Como reverter: Desfazer as alterações nos arquivos `/fidelidade/index.html`, `/fidelidade/fidelidade.css`, `/fidelidade/fidelidade.js` e `/fidelidade/validar.html`.

### [2026-05-28] Ajustes de Layout e Branding na Tela de Validação (FATEC Fidelidade)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/fidelidade/validar.html` (Substituído a marca interna "FATEC Fidelidade" pela logo oficial azul da FATEC `fateclogoazul.png` ampliada para 84px dentro do card de status de validação, removendo a logo externa; reajustado a sombra e bordas internas da página para o padrão do Light Theme; alterado o estado inicial e cores de "Carregando..." do laranja para o azul institucional)
- Tipo: Evolução de UI/UX e Consistência de Branding
- Motivo: Alinhar a tela pública de validação de cartões com a identidade visual institucional, fornecendo grande visibilidade à logo azul no cabeçalho interno e definindo o carregamento na cor azul padrão da instituição.
- Impacto: Interface de validação limpa, com branding evidente e profissional.
- Como testar: Acessar a rota `/fidelidade/validar.html?u=[uid]` e verificar se a logo azul da FATEC está ampliada no cabeçalho do card de status, se o indicador inicial de "Carregando..." está azul, e se não há textos de marca redundantes fora do card.
- Como reverter: Reverter as edições efetuadas no arquivo `/fidelidade/validar.html`.

### [2026-05-29] Melhorias de Categorização e Estatísticas por Categoria no Módulo de Empréstimos
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/emprestimo/index.html` (Adicionado select de Categoria na barra de filtros superior; alterado o input de texto de tipo do item por um select com botão inline para adicionar novas categorias na hora)
  - `/emprestimo/app.js` (Adicionado controle de persistência de categorias padrão e customizadas em localStorage; implementado carregamento dinâmico que lê o banco Firestore e importa categorias ativas existentes; adicionado suporte a filtragem do grid e dos cards de estatísticas superiores baseada na categoria selecionada; implementado atualizador de label que anexa o nome da categoria selecionada nos títulos dos cards; adicionado renderização dinâmica de listas de categorias internas [breakdowns] em cada card de status, com eventos de clique associados para filtrar por status e tipo simultaneamente)
  - `/emprestimo/emprestimo.css` (Adicionado classes `.stat-breakdown`, `.breakdown-row`, `.breakdown-name` e `.breakdown-count` com transições hover e estilização de badges para visualização das categorias no interior dos cartões de estatísticas)
- Tipo: Evolução de Usabilidade e Análise de Dados
- Motivo: Com o suporte a múltiplos tipos de equipamentos (notebooks, projetores, etc.), o dashboard de empréstimos exibia números totais consolidados, dificultando saber exatamente a quantidade de cada equipamento por status. Havia a necessidade de cadastrar novas categorias sob demanda de forma rápida no modal e poder visualizar estatísticas distintas para cada equipamento na tela inicial, além de atalhos rápidos para listar subgrupos específicos.
- Impacto: Análise distinta e rápida das quantidades de cada tipo de equipamento na tela inicial e facilitação no cadastro padronizado de novos equipamentos com categorias.
- Como testar:
  - Acessar `/emprestimo/index.html`.
  - Clicar em "Cadastrar Item". Verificar se o campo "Tipo" agora é um select com opções: Notebook, Passador, Caixa de Som, Projetor.
  - Clicar no botão "+" ao lado de tipo, digitar uma nova categoria (ex: Câmera), salvar e verificar se ela se torna a selecionada.
  - No filtro de pesquisa, alterar "Categoria" de "Todos" para "Notebook" e verificar se as estatísticas superiores (Total, Disponíveis, etc.) são atualizadas apenas com dados de notebooks, e se as labels mudam para `Total (Notebook)`, `Disponíveis (Notebook)`, etc.
  - Com o filtro geral em "Todos", verifique que cada card superior exibe sua respectiva lista de categorias com quantidades (ex: `Notebook: 10`, `Passador: 3` sob Disponíveis).
  - Clique na linha "Passador" no card de "Disponíveis" e veja se o grid e os seletores de filtros mudam automaticamente para exibir apenas os passadores disponíveis.
- Como reverter: Desfazer as edições nos arquivos `/emprestimo/index.html`, `/emprestimo/app.js` e `/emprestimo/emprestimo.css`.

### [2026-05-29] Correção de Categorias Legadas, Visual Mobile do Toolbar e Cache-Busters (Empréstimos)
- Autor: Antigravity
- Branch: main
- Arquivos alterados:
  - `/emprestimo/index.html` (Adicionados e atualizados parâmetros cache-buster para `?v=3` nos links do CSS e do JS para forçar atualização no navegador)
  - `/emprestimo/app.js` (Lógica de normalização em `loadNotebooks()` convertendo `"Outros"`, `"outro"`, `"notbooks"`, `"notbook"` e nulos para `"Notebook"`; higienizada a lista de categorias em `loadCategories()` excluindo `"Outros"`; simplificada a ativação de abas usando `data-category`)
  - `/emprestimo/emprestimo.css` (Implementado layout empilhado verticalmente para a barra de buscas e o botão de cadastro no celular através de `flex-direction: column` no `.toolbar-top`, com botão "+ Cadastrar Item" ocupando a largura total (100% width) e ícone/texto perfeitamente centralizados)
- Tipo: Ajuste de UI/UX Responsivo, Correção de Dados e Cache-Busting
- Motivo: O usuário informou que o layout estava poluído e questionou a origem da categoria "Outros" (itens legados). Posteriormente, apontou que a barra de busca e o botão "+ Cadastrar Item" estavam sobrepostos e muito espremidos no layout móvel.
- Impacto: Interface móvel e desktop perfeitamente consistentes. O botão de cadastro agora ocupa toda a largura em celulares de forma elegante e centralizada abaixo da barra de busca, sem sobreposições. Os dados legados são auto-corrigidos para "Notebook".
- Como testar:
  - Acessar o módulo de empréstimos em um dispositivo móvel. Confirmar que a barra de busca e o botão "Cadastrar Item" não se sobrepõem e que o botão ocupa toda a largura abaixo da busca.
  - Verificar que a categoria "Outros" não consta mais nos filtros e abas.
- Como reverter: Desfazer as edições nos arquivos `/emprestimo/index.html`, `/emprestimo/app.js` e `/emprestimo/emprestimo.css`.





