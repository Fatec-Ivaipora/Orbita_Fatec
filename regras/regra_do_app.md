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

### [2026-10-21] Banco de Provas liberado pro setor EAD: vê tudo dos cursos, edita só o que criou
- Autor: Claude Code (a pedido do usuário)
- Branch: feature/ead-banco-provas
- Arquivos alterados: `core/permissions.js` (ead ganha `banco-provas`), `src/middlewares/auth.js` (padrão ead 3), `src/rotas/banco-provas.js` (`cursosDoCoordenador` com escopo do EAD; `erroDeDono` em editar/excluir disciplina, questão, gabarito, lote importado e prova; fila de revisão só com os lotes do próprio perfil), `src/rotas/correcao-provas.js` (EAD puxa gabarito do Banco de Provas de todos os cursos, menos Medicina), `docencia/banco-provas/app.js` (`podeAlterar`: esconde Editar/Excluir e trava o gabarito na pré-visualização do que não é dele).
- Tipo: Permissão / Melhoria
- Motivo: O EAD precisa montar provas no Banco de Questões. Pedido: "eles precisam ver tudo dos cursos eles podem ver e editar, porém o editar só do que eles mesmos fizeram pelos seus perfis".
- Impacto: Cargo ead vê disciplinas, questões e provas de todos os cursos da graduação (Medicina fora, mesmo escopo da CPA) e pode criar disciplina, questão, importar Word e montar prova. Editar/excluir só o que tem `createdBy` = o próprio uid (o servidor recusa com 403; a tela nem mostra os botões). Questões de Conhecimentos Gerais seguem só ADM editando. Coordenadores e ADM sem mudança. Depende de `config/permissions` → ead `banco-provas` = 3 no Firestore.
- Como testar: entrar com um tutor do EAD → Docência → Banco de Provas → escolher um curso → vê tudo, sem Editar/Excluir no que é dos outros → cadastrar uma disciplina/questão → nela aparecem Editar/Excluir.
- Como reverter: reverter o commit e voltar `config/permissions` ead `banco-provas` pra 1.

### [2026-10-20] Trilha EAD: livro de notas com outro formato de cabeçalho das UAs importava sem nenhuma unidade
- Autor: Claude Code (a pedido do usuário)
- Branch: fix/trilha-ead-cabecalho-ua
- Arquivos alterados: `src/utils/livroNotasAva.js` (`numeroDaUnidade`/`tituloDaUnidade`; montagem da lista de unidades; recusa a importação sem unidade).
- Tipo: Correção
- Motivo: Caso real do coordenador do EAD (FIS.APLI.AGRO. - 7551): importou 55 alunos e nenhuma unidade, então nada aparecia como feito. O leitor usava uma regra tolerante pra achar a linha do cabeçalho e outra rígida (só "Ferramenta externa: UA 01") pra montar as unidades.
- Impacto: Uma regra só pras duas coisas, aceitando "UA 01", "UA-01", "UA.01", "UA01", "Unidade de Aprendizagem 01", com ou sem "Ferramenta externa:"/"Ferramenta externa -" na frente. Se a mesma UA vier em mais de uma coluna (Real, Porcentagem, Letra), usa uma só e nunca a de letra. Arquivo sem nenhuma coluna de unidade agora é recusado com mensagem clara, em vez de salvar a turma vazia. O formato que já funcionava continua igual. Turma já salva vazia se corrige reimportando o mesmo arquivo.
- Como testar: Trilha EAD → Importar livro de notas → arquivo do AVA → a prévia mostra as 12 unidades; um arquivo sem colunas de UA mostra o erro.
- Como reverter: reverter o commit.

### [2026-10-20] Novo módulo Trilha EAD (Docência): participação nas UAs do AVA, ranking e arquivo pro Edubox
- Autor: Claude Code (a pedido do usuário)
- Branch: feature/trilha-ead
- Arquivos alterados: novos `docencia/trilha-ead/` (index.html, app.js, trilha.css), `src/rotas/trilha-ead.js` (`/api/trilha-ead`), `src/utils/livroNotasAva.js` (leitura do livro de notas do Open LMS), `src/utils/trilhaDiarios.js` (casa a turma do AVA com os diários do Edubox pelos dados do CADD); `api/index.js` (rota montada); `core/permissions.js` (módulo `trilha-ead` na categoria Docência; nas listas de adm_l1, adm_l2, coordenador e ead); `src/middlewares/auth.js` (níveis padrão: adm_l2 3, coordenador 2, ead 3).
- Tipo: Novo módulo
- Motivo: O EAD digitava no Edubox, aluno por aluno, a nota das unidades de aprendizagem (SAGAH) feitas no AVA — e precisava lembrar de pôr 0 em quem não fez. Também não havia ranking de participação por curso.
- Impacto: O tutor importa o livro de notas exportado do AVA (um arquivo por disciplina/turma; reimportar atualiza). Regra da nota: cada unidade com 100% de participação vale 0,5; abaixo disso ou "-" vale 0; UA 01–06 = 1º bimestre, UA 07–12 = 2º; nota do bimestre de 0 a 3,0 (item "TRILHA EAD" do diário). O sistema casa a turma com o(s) diário(s) do Edubox (cad_turmas do CADD): turmas que estudam juntas no AVA saem num arquivo por diário; aluno do AVA fora do diário é classificado (DP/adaptação → onde lançar; saiu → consulta Matrículas; nome social → casamento pelos dois últimos sobrenomes, só se a pessoa for única); a conta "Professor Fatec" é ignorada. Gera CSV `Nome;Nota` (com ponto) por diário e bimestre — **não grava nada no Edubox**. Participação e ranking contam só os alunos ativos do diário; curso = média das disciplinas; geral = média dos cursos; filtro de bimestre no topo; comparativo 1º × 2º (subiu/caiu). Impressão no padrão FATEC (modelo do relatório de desempenho antigo; um bimestre ou os dois juntos; ranking de alunos com aviso LGPD). O tutor pode marcar uma unidade como concluída à mão (fica em `manuais` e é reaplicada a cada reimportação). Acesso: tutor do EAD vê e mexe só nas turmas que importou; o coordenador do EAD (ead + `users.chefeDeSetor`) vê e mexe em todas; coordenador de curso só vê os cursos de `users.cursos`, sem os arquivos do Edubox; ADM tudo. Coleção nova `trilha_ead_disciplinas`; lê `cad_turmas`, `matriculas_alunos` (só os nomes que faltaram) e `users`.
- Como testar: Docência → Trilha EAD → "Importar livro de notas" → arquivo do AVA (ex.: "TEO HIST ARQ URB III - 7602 Notas.xlsx") → confere a prévia (diário encontrado, curso sugerido) → Importar → abrir a turma, baixar o arquivo do Edubox do bimestre, aba Ranking, imprimir.
- Como reverter: reverter o commit e apagar a coleção `trilha_ead_disciplinas` (e as chaves `trilha-ead` de `config/permissions`, se gravadas).

### [2026-10-16] Contratos: ordenar pela data de assinatura
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `comercial/contratos/index.html` (campo "Assinatura a partir de" na barra de filtros; versões do CSS/JS), `comercial/contratos/app.js` (`ordenarPorAssinatura` e separador por dia em `renderTabela`; o campo entra em "Limpar filtros", no resumo do filtro e na impressão), `comercial/contratos/contratos.css` (estilo do campo e do separador).
- Tipo: Melhoria
- Motivo: Pedido da equipe do Comercial — achar rápido quem assinou num dia.
- Impacto: Com uma data escolhida, ninguém some da lista: ela é reordenada — primeiro o dia escolhido, depois os dias seguintes, depois os dias anteriores (do mais recente ao mais antigo) e, por último, quem não tem data de assinatura —, com uma linha separadora por dia ("Assinados em 14/10/2026 · 12 alunos"). Sem data escolhida, a tela fica exatamente como antes. Nada muda no backend nem nos dados.
- Como testar: Comercial → Contratos → aba Assinado → "Assinatura a partir de" = um dia → os daquele dia aparecem no topo.
- Como reverter: reverter o commit.

### [2026-10-16] Remoção do menu Recursos Humanos (Carga Horária e Funcionários)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: removidos `rh/carga-horaria/`, `rh/funcionarios/` e `src/rotas/carga-horaria.js` (`/api/carga-horaria`, usada pelos dois módulos); `api/index.js` (rota desmontada); `core/permissions.js` (módulos `carga-horaria` e `funcionarios` e a categoria "Recursos Humanos" fora do menu e das listas de cargo); `src/middlewares/auth.js` (níveis padrão de `carga-horaria` removidos).
- Tipo: Remoção
- Motivo: Módulos não são mais usados.
- Impacto: O menu "Recursos Humanos" deixa de existir. O cargo **RH continua** (com Matrizes e Agenda Interna). As coleções `funcionarios_rh`, `registros_carga_horaria` e `recessos_rh` do Firestore NÃO foram apagadas.
- Como testar: nenhum cargo mostra "Recursos Humanos" no menu; `/rh/...` e `/api/carga-horaria` dão 404; usuário com cargo RH entra normalmente e vê Matrizes e Agenda Interna.
- Como reverter: reverter o commit.

### [2026-10-16] Remoção do módulo Agenda (Gestão de T.I.)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: removidos `agenda/` (tela interna da T.I.), `agendar/` (página pública de solicitação de agendamento), `src/rotas/agenda.js` e `src/rotas/locais.js` (`/api/agenda` e `/api/locais`, usadas só por esse módulo); `api/index.js` (rotas desmontadas); `core/permissions.js` (módulo `agenda` fora do menu e das listas de cargo).
- Tipo: Remoção
- Motivo: Módulo não é mais usado. (Não confundir com a "Agenda Interna Fatec IVP" da Secretaria — `agenda-espacos` — nem com a agenda do Meu Espaço, que continuam.)
- Impacto: "Agenda" some do menu Gestão de T.I.; `/agenda`, `/agendar`, `/api/agenda` e `/api/locais` deixam de existir. As coleções `agenda` e `locais` do Firestore NÃO foram apagadas (histórico preservado).
- Como testar: menu Gestão de T.I. mostra só Empréstimos e Acessos; Agenda Interna (Secretaria) e Meu Espaço seguem funcionando.
- Como reverter: reverter o commit.

### [2026-10-16] Banco de Provas: importar do Word questões numeradas "1 - 2 - 3" e por lista automática
- Autor: Claude Code (a pedido do usuário)
- Branch: fix/importar-word-questoes-numeradas
- Arquivos alterados:
  - `src/utils/parseProvaDocx.js`:
    - Número com traço ou travessão ("1 - Texto", "2- Texto", "3 – Texto") passa a valer como início de questão. Também aceita aspas/parêntese logo depois ("1 - (ENEM) ...").
    - Lista numerada automática do Word: o número não vinha no texto, e nenhuma questão era encontrada. Agora o .docx é lido antes (numbering.xml) e o número de cada item de lista decimal é escrito no começo do parágrafo.
    - Lista de vários níveis (questão no nível 1, alternativas a/b/c no nível 2): a questão não é mais juntada com a 1ª alternativa.
- Tipo: Correção
- Motivo: os professores mandam a prova numerada "1 - 2 - 3 - 4", sem escrever "Questão"; a importação não achava nenhuma questão.
- Como testar: importar um .docx com questões "1 - ..." e outro com a numeração automática do Word. As questões e alternativas devem aparecer na revisão. Os formatos "Questão N" e "1.Texto" continuam iguais.
- Limitação: no .doc antigo (Word 97-2003) a numeração automática continua sem chegar ao texto; salvar como .docx resolve.
- Como reverter: reverter o commit.

### [2026-10-16] Usuário do robô da ODTech: só Matrículas, de 2027.1 em diante
- Autor: Claude Code (a pedido do usuário)
- Branch: feature/usuario-robo-odtech
- Arquivos alterados:
  - `core/permissions.js`: cargo `robo` ("Robô (ODTech)") com Meu Espaço + Matrículas.
  - `core/layout.js`: `robo` entra em CARGOS_SEM_CARTAO (sem Cartão FATEC).
  - `src/middlewares/auth.js`: lê `users.matriculasSemestreMinimo` para `req.user` (com cache) e define os níveis padrão do cargo `robo` (matrículas 3, todo o resto 1).
  - `src/rotas/matriculas.js`: `travaSemestre` entra junto do `checkPermission` em todas as rotas. Barra (403) semestre pedido/gravado abaixo do mínimo (query, body, origem/destino da virada) e aluno de semestre anterior nas rotas `/alunos/:id`. O seletor de semestres, o comparativo e a lista de indicados só trazem semestres liberados. Usuário sem o campo não muda nada.
- Firestore: `roles/robo` ({ name: "Robô (ODTech)" }), `config/permissions.robo` = { matriculas: 3 }.
- Usuário: `roboodtech@orbita.com.br`, `role: 'robo'`, `matriculasSemestreMinimo: '2027.1'`, senha inicial com troca obrigatória.
- Tipo: Novo cargo / permissões
- Como testar: entrar com o robô — menu mostra só Meu Espaço e Matrículas; o seletor de semestre só lista 2027.1 em diante; chamar `/api/matriculas/alunos?modulo=fatec&semestre=2026.2` responde 403.
- Como reverter: reverter o commit e apagar `roles/robo`, `config/permissions.robo` e o usuário.

### [2026-10-15] Novo setor EAD (cargo `ead`), com Correção de Provas de todos os cursos
- Autor: Claude Code (a pedido do usuário)
- Branch: feature/setor-ead
- Arquivos alterados:
  - `core/permissions.js`: setor `ead` ("EAD") em CATEGORIES (Painel do Setor do Meu Espaço) e cargo `ead` em ROLE_PERMISSIONS: só a Correção de Provas (Docência), sem nada da Secretaria; Meu Espaço continua, como em todo cargo.
  - `src/middlewares/auth.js`: níveis padrão do cargo `ead` (correção de provas 3, todo o resto 1).
  - `src/rotas/cpa.js` (`escopoDe`): o cargo `ead` vê todos os cursos da graduação (sem Medicina), porque as disciplinas a distância passam por todos. Vale para a Correção de Provas, que usa o mesmo escopo.
- Firestore: `roles/ead` ({ name: "EAD" }) e `config/permissions.ead` = { correcao-provas: 3, agenda-espacos: 1 }. Os 4 usuários também têm `cursos` com os 16 cursos da graduação.
- Usuários: líder Carlos Durlo (`chefeDeSetor: true`) + Daiane, Nadia e Rodrigo, `role: 'ead'`, `setorId: 'ead'`, senha inicial com troca obrigatória.
- Tipo: Novo setor / permissões
- Como testar: entrar com um usuário EAD — o menu mostra só Meu Espaço e Docência → Correção de Provas; na Correção aparecem as turmas de todos os cursos menos Medicina.
- Como reverter: reverter o commit e apagar `roles/ead` e `config/permissions.ead`.

### [2026-10-15] CPA: "Relatório da Direção" (visão executiva da campanha)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `cpa/relatorio-direcao.js` (novo — PDF vetorial), `cpa/temas-cpa.js` (novo — temas dos comentários), `cpa/app.js` e `cpa/index.html` (botão "Relatório da Direção" nas abas Alunos, Docentes e Administrativo), `src/rotas/cpa.js` (rota `GET /api/cpa/relatorio-direcao?codava=&tipo=A|P|O`, só ADM N1/N2, e `montarRelatorioDirecao`). Relay (droplet, fora do Git): função nova `cpaDirecao` e rota nova `GET /cpa/direcao` — só acréscimo, nenhuma rota existente (nem do SIGMA) mudou; backup em `server.mjs.bak-pre-cpa-direcao`.
- Tipo: Nova funcionalidade
- Motivo: A direção não usa o PDF por professor (que vai para os coordenadores); quer o relatório executivo que a CPA fazia antes do Órbita, com resumo, temas dos comentários, consolidado por dimensão e análise por dimensão.
- Impacto: PDF por campanha (alunos = todos os cursos juntos, numa consulta só ao relay; docentes; administrativo) com: resumo executivo (respondentes, média geral 0–10, satisfação Ótimo+Bom, dimensões, destaques e oportunidades), temas mais mencionados nos comentários (lista fixa de 16 temas com elogios/críticas), temas emergentes (expressões de 2 palavras que se repetem em comentários de crítica e não estão na lista), consolidado por dimensão com conceito e classificação (Ponto forte / Estável / Atenção / Prioridade, pela distância da média geral), matriz de prioridades, recomendações tiradas dos números, e uma página por dimensão (perguntas com % Ótimo/Bom/Regular/Ruim, pontos positivos, oportunidades, sugestões e comentários reais). Conferido com o PDF antigo de Docentes 2026/1: mesmas médias por dimensão (9,3 · 9,2 · 8,7 · 9,4 · 8,9 · 9,5 · 9,2 · 9,1) e mesmas porcentagens por pergunta. Alunos 2026/2: 1.401 respondentes, 6.107 comentários, PDF de 21 páginas em ~2 s.
- Como testar: CPA → aba Alunos, Docentes ou Administrativo → escolher a campanha → "Relatório da Direção".
- Como reverter: reverter o commit; a rota `/cpa/direcao` do relay fica sem uso (ou restaurar `server.mjs.bak-pre-cpa-direcao`).

### [2026-10-15] Avaliação Docente: "Relatório Geral" + "Relatório do Curso"
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `avaliacao-docente/relatorio-pdf.js` (modo de um curso: tabela por professor), `avaliacao-docente/app.js` (`gerarRelatorioPdf`, botão do curso), `avaliacao-docente/index.html` (botão de cima renomeado para "Relatório Geral"; botão "Relatório do Curso" na barra de filtros do Painel do Diretor), `avaliacao-docente/avaliacao-docente.css` (estado desativado do botão).
- Tipo: Nova funcionalidade
- Motivo: O Diretor Acadêmico também precisa do relatório de um curso só.
- Impacto: "Relatório do Curso" usa o curso e o ciclo escolhidos nos filtros do painel (só libera com os dois escolhidos). Mesmo visual do geral, com: nome do curso no topo; avaliações, média do curso (com a média da instituição ao lado), professores avaliados x professores do curso no Edubox e quantos faltam; tabela por professor em ordem alfabética (avaliações, períodos avaliados, média, barra 0–5 com a média do curso marcada, classificação; quem não foi avaliado aparece como "Não avaliado"); página 2 com critérios e distribuição só do curso.
- Como testar: Painel do Diretor → escolher um curso (e o ciclo) → "Relatório do Curso".
- Como reverter: reverter o commit.

### [2026-10-15] Avaliação Docente: Painel do Diretor obedece aos filtros de curso e ciclo
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `avaliacao-docente/app.js` (`renderResumoDiretor`), `avaliacao-docente/index.html` (versão do script).
- Tipo: Correção
- Motivo: Ao escolher curso/ciclo, só a lista "Avaliações por Curso" filtrava; os cards (Total, Média geral, Cursos avaliados) e a tabela "Média por Curso" continuavam mostrando todos os cursos.
- Impacto: Cards e "Média por Curso" agora são calculados da mesma lista filtrada (mesma conta de antes). O painel deixou de chamar `GET /api/avaliacao-docente/dashboard` (a rota continua existindo).
- Como testar: Painel do Diretor → escolher um curso e/ou ciclo → a tabela "Média por Curso" mostra só o curso escolhido e os cards mudam junto.
- Como reverter: reverter o commit.

### [2026-10-15] Avaliação Docente: botão "Gerar Relatório" (PDF para o Diretor Acadêmico)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `avaliacao-docente/relatorio-pdf.js` (novo — monta o PDF vetorial com jsPDF e confere nome digitado x nome do Edubox), `avaliacao-docente/app.js` (modal e geração), `avaliacao-docente/index.html` (botão ao lado de "Gerenciar Ciclos", modal de escolha do ciclo, carrega jsPDF 2.5.1), `src/rotas/avaliacao-docente.js` (nova rota `GET /professores-edubox`, via relay `/confirmacao/professores-ativos`, que já existia; Medicina sai da lista de cursos do módulo).
- Tipo: Nova funcionalidade
- Motivo: O Diretor Acadêmico precisa levar o resultado da avaliação docente para reunião; o Painel do Diretor só mostrava na tela.
- Impacto: Relatório por ciclo (ou todos os ciclos). Página 1: avaliações realizadas, média geral (0 a 5), professores avaliados x professores com aula no semestre (Edubox) e quantos faltam; tabela com TODOS os cursos em ordem alfabética, inclusive os sem avaliação (professores, avaliados, faltam, avaliações, média, barra 0–5 com a média geral marcada) e total geral (professor de mais de um curso conta uma vez). Página 2: média de cada um dos 10 critérios, 3 pontos fortes e 3 a desenvolver, distribuição por faixa. Anexo: nomes de quem falta avaliar por curso e avaliações cujo nome digitado não bateu com o Edubox. A conferência de nomes é tolerante (primeiro nome + sobrenomes, aceita 1 letra de diferença e 1 sobrenome a mais): no ciclo 2026.2, 166 de 167 avaliações foram reconhecidas. Só avaliações concluídas e com nota entram na média (mesma regra do Painel do Diretor). Se o Edubox não responder, o relatório sai sem as colunas de professores. Medicina não participa desta avaliação: saiu da lista de cursos do módulo e da contagem do Edubox. Botão visível para quem vê o Painel do Diretor (não aparece para coordenador).
- Como testar: Docência → Avaliação Docente → "Gerar Relatório" → escolher o ciclo → "Baixar PDF".
- Como reverter: reverter o commit.

### [2026-10-15] Menu lateral: barra de rolagem discreta
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `core/layout.css` (`.layout-nav`).
- Tipo: Ajuste visual
- Motivo: Ao abrir um submenu, aparecia a barra de rolagem padrão do navegador (clara e larga), destoando do menu escuro e empurrando os itens para o lado.
- Impacto: Barra fina e translúcida, que só aparece com o mouse sobre o menu; espaço reservado (`scrollbar-gutter: stable`), então os itens não se mexem quando ela surge. Vale para todas as páginas.
- Como testar: abrir um menu com submenu longo e rolar; Ctrl+F5 se o CSS antigo estiver em cache.
- Como reverter: reverter o commit.

### [2026-10-15] CPA: relatório dos professores em um PDF por professor + classificação de comentários corrigida
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `cpa/pdf-professor.js` (novo — monta o PDF vetorial com jsPDF), `cpa/app.js` (botão "Gerar Relatório" passa a gerar um PDF por professor; saiu o PDF por disciplina feito com html2pdf), `cpa/index.html` (carrega jsPDF 2.5.1), `src/utils/cpa-comentarios.js` (classificador).
- Tipo: Melhoria / Correção
- Motivo: O relatório era um PDF por disciplina (46 em Agronomia), feito a partir de "foto" da tela: lento, pesado e com conteúdo cortado. No classificador, trechos como "não tem" ou "nenhum problema" encerravam a análise e escondiam a crítica que vinha depois ("...não tem muita paciência... debochou" saía como elogio), e críticas de postura/didática ("perdido", "confuso", "grosseiro") não estavam na lista.
- Impacto: Agronomia passa a 13 PDFs (um por professor, com todas as disciplinas dele), gerados em ~1 s, ~0,5 MB no total, sem pergunta ou comentário partido entre páginas. Disciplina com dois professores sai no PDF de cada um. Os PDFs de participação por turma não mudaram. Classificador: agora as frases de negação ("nada a reclamar", "nenhuma crítica ou sugestão") são retiradas do texto e a análise continua no resto; "não tem" só vale como elogio no comentário curto (até 4 palavras); elogio escrito com palavra de crítica ("deveria ser mais valorizada", "poderia ser ela em todas as matérias", "entende as dificuldades dos alunos") conta como elogio quando o comentário já elogia; novas palavras de crítica e de elogio ("top", "amo ela", "atenciosa", "a melhor"). Em 3.984 comentários reais, 525 mudaram de grupo (elogios 1.175 → 1.350, atenção 871 → 1.071, neutros 1.938 → 1.563).
- Como testar: CPA → aba Alunos → campanha + curso → "Gerar Relatório" (só ADM N1/N2) → abrir o .zip e conferir os PDFs; conferir os comentários de Hidráulica e Irrigação (Agronomia, ALUNOS 2026/2).
- Como reverter: reverter o commit.

### [2026-10-15] Documentação: pendências conhecidas do relay (seção 8)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados: `regras/regra_do_app.md` — nova subseção "Pendências conhecidas do relay" na seção 8 (HTTPS, backup, atualizações do Ubuntu, versionamento do relay, capacidade).
- Tipo: Documentação
- Motivo: Pedido do usuário — deixar registrado para a equipe o que ainda precisa ser feito no servidor do relay.

### [2026-10-15] Matrizes ao vivo pelo relay + agentes do CADD e da Cobrança saem do PC da Fatec para o servidor
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- **Matrizes** (consulta ao vivo):
  - Relay (`/opt/edubox-relay/server.mjs`): novas rotas `GET /matrizes/semestres?formatos=` e `GET /matrizes/dados?formatos=&curso=` (token `ORBITA_TOKEN`), com as mesmas consultas que o script fazia. Backup: `server.mjs.bak-pre-matrizes`.
  - `src/utils/matrizes-montar.js` (novo): a montagem por curso que estava em `scripts/matrizes-edubox-sync.js`.
  - `src/rotas/matrizes.js`: monta a matriz na hora pelo relay em vez de ler `matrizes_edubox`/`config/matrizes_sync`. Os semestres oferecidos são o atual e os 2 próximos que existem no Edubox, como antes. Turmas do mesmo período agora saem ordenadas por nome (antes a ordem variava). `matrizes_grade` (horário dos coordenadores) continua igual.
  - Conferido contra a última cópia do script (07/10): 16 cursos em 2026.2 e 16 em 2027.1, conteúdo idêntico campo a campo. Os horários já preenchidos continuam aparecendo (111 professores, 46 salas, 15 cursos).
  - `matrizes/app.js`: textos "última carga do Edubox" → "consultado no Edubox"; mensagem de semestre vazio.
  - Removido `scripts/matrizes-edubox-sync.js`. A coleção `matrizes_edubox` fica no Firestore (histórico), sem uso.
- **CADD e Cobrança** (continuam gravando no Firestore; telas sem mudança de dado):
  - Os agentes `scripts/cad-edubox-agente.js` e `scripts/cobranca-edubox-agente.js` passam a rodar no droplet do relay como serviços systemd `orbita-cad-agente` e `orbita-cobranca-agente` (pasta `/opt/orbita-sync`, clone do repositório, usuário `orbita`, `TZ=America/Sao_Paulo`). Detalhes e como atualizar: seção 8, "Agentes que rodam no servidor".
  - Testados no servidor pelo botão "Atualizar agora": Cobrança OK em 17s (18.414 parcelas em aberto), CADD OK em 101s (8 semestres).
  - No PC da Fatec (`C:OrbitaAgente`), os atalhos "Orbita - CAD Edubox" e "Orbita - Cobranca Edubox" foram removidos da pasta Inicializar e os processos encerrados, antes de ligar os do servidor (confirmado pelo `agenteVivoEm` parado).
  - Removidos `scripts/cad-edubox-agente.vbs` e `scripts/cobranca-edubox-agente.vbs` (só serviam pro PC). Comentários dos agentes e textos das telas ("PC de atualização desligado" → "Atualização automática fora do ar") atualizados em `cad/app.js`, `financeiro/cobranca/edubox.js`, `src/rotas/cobranca-edubox.js`.
- **Acesso ao servidor**: criada chave SSH (`~/.ssh/orbita_droplet` no computador do TI, comentário `orbita-droplet-FatecTi` no `authorized_keys` do root) pra copiar a credencial do Firebase sem digitá-la em navegador. Revogar = apagar essa linha do `/root/.ssh/authorized_keys`.
- Tipo: Migração (script no PC → relay/servidor)
- Como testar: abrir Matrizes (lista de semestres e cursos, horários salvos); no CADD e na Cobrança, conferir que não aparece "Atualização automática fora do ar" e que "Atualizar agora" funciona.
- Como reverter: `git revert` deste commit (volta a Matrizes a ler o Firestore, que só seria atualizado rodando o script de novo). Para os agentes: `systemctl disable --now orbita-cad-agente orbita-cobranca-agente` no servidor.

### [2026-10-15] Confirmação de Presença: lista de professores do Edubox passa a vir do relay
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos criados:
  - `src/utils/edubox-relay.js`: cliente compartilhado do relay (`relay(caminho)`), tirado de dentro do `src/rotas/cpa.js` pra todos os módulos usarem o mesmo.
- Arquivos alterados:
  - Relay (`/opt/edubox-relay/server.mjs`, droplet): nova função `confirmacaoProfessoresAtivos()` e rota `GET /confirmacao/professores-ativos` (token `ORBITA_TOKEN`). Mesma consulta que o Órbita fazia direto, trocando o `LEFT JOIN tac_curso` por `JOIN` (regra da seção 8; conferido no banco real: 134 professores nos dois casos, nada muda). Backup antes da mudança: `server.mjs.bak-pre-confirmacao`.
  - `src/rotas/confirmacao-evento.js`: `buscarProfessoresAtivosEdubox()` chama o relay em vez de `db-edubox` (as 3 rotas que usam essa função não mudam).
  - `src/rotas/cpa.js`: passa a usar o cliente compartilhado.
  - `regras/regra_do_app.md` (seção 8) e `AGENTS.md`: Confirmação de Presença saiu da lista de legado; modelo de cliente agora é `src/utils/edubox-relay.js`.
- Tipo: Migração (conexão direta → relay)
- Motivo: no Vercel essa tela não conseguia falar com o Edubox (IP não autorizado).
- Como testar: em produção, abrir Confirmação de Presença e carregar a lista de professores do Edubox (deve trazer ~134 do semestre ativo, GRA e MED).
- Como reverter: `git revert` deste commit; a rota nova no relay fica inofensiva.

### [2026-10-14] Documentação: integração com o Edubox só pelo relay (seção 8) + instruções para IA
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos criados:
  - `AGENTS.md` (raiz): resumo das regras que mais dão problema, principalmente "Edubox só pelo relay". É o arquivo que Codex, Cursor, Copilot e Gemini leem automaticamente.
  - `CLAUDE.md` (raiz): importa o `AGENTS.md`, pro Claude Code ler a mesma coisa.
- Arquivos alterados:
  - `regras/regra_do_app.md`: nova seção **8. Integração com o Edubox — SEMPRE pelo relay** (onde fica o relay, como chamar, como adicionar rota sem mexer no SIGMA, cuidados nas consultas, achados de schema, o que ainda é legado).
- Tipo: Documentação
- Motivo: Pedido do usuário — garantir que colegas (e as IAs deles) não voltem a criar script/agente rodando no PC da Fatec pra buscar dado do Edubox.

### [2026-10-14] Relatório CPA: corrige corte de pergunta/gráfico no meio da quebra de página do PDF
- Autor: Claude Code (a pedido do usuário, que baixou o `.zip` de verdade e achou o problema)
- Branch: main
- Arquivos alterados:
  - `cpa/app.js` — `pagebreak.avoid` do `html2pdf` (dentro de `gerarZipDePdfs`) ganha `.cpa-perg` (bloco inteiro de uma pergunta: texto + barra + contagem) e `.cpa-ficha`/`.cpa-cab`, além de `h4` — faltava justamente `.cpa-perg`, que é por isso que a barra de distribuição e o texto da pergunta apareciam cortados bem na borda da página. O módulo CPA anterior (já aprovado) usava exatamente essa lista (`['.cpa-perg', '.cpa-coment', 'tr', 'h3', 'h4']`) — ficou faltando `.cpa-perg` na reconstrução.
  - `cpa/cpa.css` — `break-inside: avoid` / `page-break-inside: avoid` também direto no CSS de `.cpa-perg`, `.cpa-coment`, `.cpa-ficha`, `.cpa-cab` (reforça o modo `css` do html2pdf, que lê essa propriedade).
- Tipo: Correção de bug
- Motivo: Usuário baixou o `.zip` real (gerado fora da automação, então fora do alcance pra eu inspecionar o PDF binário direto) e relatou corte no gráfico/texto de uma disciplina.
- Como testar: ADM N1/N2, Alunos, "Gerar Relatório" — abrir qualquer PDF gerado e conferir que nenhuma pergunta (texto + barra + contagem) fica partida entre duas páginas.
- Como reverter: `git revert` deste commit.

### [2026-10-14] Relatório CPA: troca o gráfico de barra do PDF de disciplina por distribuição estática (sem precisar de mouse)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - Relay (`/opt/edubox-relay/server.mjs`, droplet) — `perguntasD` (dentro de `cpaRelatorioAluno`) para de devolver média pré-calculada e passa a devolver a distribuição completa (uma linha por opção de resposta: `op` 1–5 + `n` = contagem), agrupando também por disciplina. Sem isso não tinha como montar uma barra de distribuição por disciplina — só a média do curso inteiro.
  - `src/rotas/cpa.js` — `montarPerguntasPorGrupo` (visão do curso inteiro, tela normal) e `montarPerguntasPorDisciplina` (visão de uma disciplina, PDF) reconstroem a distribuição a partir dessas linhas cruas; a visão do curso inteiro soma a distribuição de todas as disciplinas da dimensão, continua idêntica ao que já era mostrado antes.
  - `cpa/app.js`, `cpa/cpa.css` — o gráfico de barra do Chart.js dentro do PDF por disciplina (que virava imagem estática sem valor nenhum escrito, sem como passar o mouse) foi trocado por uma **barra de distribuição empilhada** com o percentual já escrito dentro de cada faixa, legenda de cores e contagem exata por opção (Ótimo/Bom/Regular/Ruim/Não sei) + satisfação — mesmo padrão visual (`.cpa-pilha`/`.cpa-leg`/`.cpa-contagem`) do módulo CPA anterior, que já tinha sido validado visualmente. Pergunta mostrada em frase normal (`frase()`), não mais em CAIXA ALTA. Nome do professor aumentado pra 1.5rem.
- Tipo: Melhoria de UX / correção de usabilidade
- Motivo: Pedido do usuário — o gráfico de barra ficou "muito ruim" no papel, sem como entender os valores sem passar o mouse (que não existe em PDF impresso).
- Impacto/riscos a observar:
  - A visão "do curso inteiro" (tela normal, gráfico Chart.js, inalterada) agora é alimentada pela distribuição reconstruída em vez da média que o Postgres já mandava pronta — matematicamente equivalente (mesma soma de contagens), testado comparando o nº de dimensões/gráficos renderizados antes e depois (9 em ambos, sem erro no console).
- Como testar: ADM N1 ou N2, aba Alunos, "Gerar Relatório" — abrir um PDF e conferir que cada pergunta mostra uma barra com % escrito dentro, legenda e contagem exata embaixo (sem precisar de interação).
- Como reverter: `git revert` deste commit.

### [2026-10-14] Relatório CPA: gráfico por pergunta no PDF de disciplina + comentários separados + remove "Imprimir" de todas as telas
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - Relay (`/opt/edubox-relay/server.mjs`, droplet) — a consulta `perguntasD` de `cpaRelatorioAluno` passa a trazer `trim(d.nomdis) AS disciplina` e agrupar por ela também (antes agregava só por pergunta, cruzando todas as disciplinas da dimensão) — agora dá pra saber a nota de cada pergunta **dentro de uma disciplina específica**, não só do curso inteiro.
  - `src/rotas/cpa.js` — `montarPerguntasPorGrupo` reaproveita essas linhas (agora por disciplina) somando de volta com média ponderada pelo nº de respostas, pra manter a visão "curso inteiro" igual a antes; função nova `montarPerguntasPorDisciplina` monta a visão por disciplina, anexada em `disciplinas[].perguntas`.
  - `cpa/app.js` — `folhaDisciplinaHtml`: nome do professor grande e em negrito (`1.4rem`/800), gráfico de barras por pergunta (mesmo Chart.js do resto do app, com `animation:false` pra renderizar a tempo do html2canvas capturar), comentários agora em três seções separadas — Elogios / Neutros / Pontos de atenção (antes vinham todos misturados numa lista só). Nova função `frase()` (texto "COMO VOCÊ AVALIA..." do Edubox vem em maiúsculas; agora mostra em frase normal) usada no rótulo das perguntas do gráfico (on-screen e no PDF).
  - `cpa/app.js`, `cpa/index.html` — botão "Imprimir" removido de **todas** as abas (Docentes e Administrativo também, não só Alunos — tinha ficado faltando da vez passada); função `imprimirAba` removida.
  - `cpa/app.js` — "Gerar Relatório" volta a aparecer pra ADM N1 **e** N2 (`souAdmin`, não mais só `souAdmL1` — o usuário pediu N1-só numa mensagem e corrigiu pra N1+N2 logo em seguida).
- Tipo: Melhoria de UX
- Motivo: Pedido do usuário — queria o gráfico de pergunta (tipo "como você avalia metodologias ativas...") dentro do PDF por disciplina, nome do professor em destaque, comentários organizados por categoria, e tirar o "Imprimir" de vez (substituído pelo "Gerar Relatório").
- Impacto/riscos a observar:
  - A nota "do curso inteiro" por pergunta (mostrada na tela normal da dimensão) é recalculada como média ponderada a partir das linhas por disciplina — matematicamente equivalente à agregação direta de antes (mesma soma/contagem), só que montada em duas etapas.
- Como testar: ADM N1 ou N2, aba Alunos, Gerar Relatório — abrir um PDF e conferir: nome do professor em destaque, gráfico "Resultado por pergunta", comentários em Elogios/Neutros/Pontos de atenção; conferir que nenhuma aba tem mais botão "Imprimir".
- Como reverter: `git revert` deste commit.

### [2026-10-14] Relatório CPA: "Gerar Relatório" (PDF por disciplina) vira exclusivo do ADM N1; remove "Imprimir" dos Alunos
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - `cpa/app.js` — nova flag `souAdmL1` (`role === 'adm_l1'`, diferente de `souAdmin` que inclui N2); o botão de gerar PDFs por disciplina é removido do DOM pra quem não é `adm_l1` (nem N2, nem coordenador).
  - `cpa/index.html` — botão renomeado de "Gerar PDFs por disciplina (.zip)" pra "Gerar Relatório"; botão "Imprimir" removido da aba Alunos (continua existindo em Docentes/Administrativo).
- Tipo: Ajuste de UX e de permissão
- Motivo: Pedido do usuário — nome do botão antigo "muito ruim"; o PDF por disciplina deve ser exclusivo do ADM N1 (nem N2); "Imprimir" não fazia mais sentido ao lado do "Gerar Relatório".
- Como testar: logar como ADM N1, conferir botão "Gerar Relatório" (sem "Imprimir") na aba Alunos; logar como ADM N2 ou coordenador e conferir que nenhum dos dois aparece.
- Como reverter: `git revert` deste commit.

### [2026-10-14] Relatório CPA: PDF por disciplina (Alunos) — nota, professor e comentários
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - `cpa/app.js` — generalizado o gerador de zip de PDFs (`gerarZipDePdfs`, usado tanto pela Participação quanto por este) pra aceitar qualquer lista de itens; novo botão "Gerar PDFs por disciplina (.zip)" na aba Alunos gera, pra cada disciplina do curso selecionado (já carregadas na tela, sem nova consulta), um PDF com cabeçalho (logo + disciplina + curso), professor(es), nota geral (0–10), total de avaliações e a lista completa de comentários classificados (bom/neutro/atenção) — tudo empacotado num `.zip`, um arquivo por disciplina, nome do arquivo = nome da disciplina.
  - `cpa/index.html`, `cpa/cpa.css` — botão novo; `.cpa-ficha` (ficha técnica professor/nota/avaliações) trazida de volta do antigo módulo CPA.
- Tipo: Nova funcionalidade
- Motivo: Pedido do usuário (pensando em ADM N1/N2) — relatório por disciplina/professor em PDFs separados, igual ao de participação por turma.
- Como testar: ADM N1, aba Alunos, escolher campanha+curso, clicar "Gerar PDFs por disciplina (.zip)", conferir o `.zip` com um PDF por disciplina (nome do arquivo = nome da disciplina), cada um com professor, nota e comentários.
- Como reverter: `git revert` deste commit remove o botão e a função.

### [2026-10-14] Relatório CPA: PDF de participação vira um arquivo por turma (zip) + layout
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - `cpa/app.js` — troca o `window.print()` (uma lista só, misturando turmas, "muito ruim"/"alinhado à esquerda" segundo o usuário) por geração de **um PDF por turma**, usando `html2pdf.js` + `JSZip` (mesma técnica já usada no PDF de professores do antigo módulo CPA): monta cada folha num palco invisível (794px, fundo branco), gera o PDF, empacota tudo num `.zip` e baixa. Cada folha agora tem cabeçalho com logo da Fatec + curso + turma, e tabela só com "#" e "Aluno" (a coluna Turma virou redundante, já que o PDF é por turma).
  - `cpa/index.html` — scripts `html2pdf.js@0.10.2` e `jszip@3.10.1` (CDN).
  - `cpa/cpa.css` — `.cpa-cab` (cabeçalho com logo, igual ao antigo módulo); removido o `#imp-lista`/`.cpa-imprimindo` da tentativa anterior (não serve mais, era pro `window.print()` que foi substituído).
- Tipo: Melhoria de UX
- Motivo: Pedido do usuário — o PDF único (todas as turmas juntas, alinhado à esquerda) ficou ruim de ler; queria um PDF por turma.
- Como testar: aba Participação, expandir um curso, clicar "Gerar PDF", conferir que baixa um `.zip` com um PDF por turma, cada um com cabeçalho (logo + curso + turma) e as duas listas (responderam/faltam).
- Como reverter: `git revert` deste commit volta ao `window.print()` de lista única.

### [2026-10-14] Relatório CPA: PDF de "quem já respondeu / falta responder" na Participação
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - Relay (`/opt/edubox-relay/server.mjs`, droplet) — nova função `cpaParticipacaoDetalhe(codava, curso)` e rota `GET /cpa/participacao-detalhe?codava=&curso=`: lista nominal de quem está matriculado naquele curso/campanha, com nome (`tac_matricula.climat → tfi_cliente.codcli → nomcli`, mesmo caminho usado pra achar nome de aluno em outros módulos do Órbita) e se concluiu a CPA ou não (`tav_participacao`). Não expõe conteúdo de resposta nenhuma, só se respondeu — mesma informação que o relatório nativo de participação do Edubox já mostra em PDF.
  - `src/rotas/cpa.js` — rota `/participacao-detalhe`, mesmo escopo por curso (`podeVer`) de todo o resto do módulo.
  - `cpa/app.js`, `cpa/index.html`, `cpa/cpa.css` — botão "Gerar PDF" dentro do card expandido de cada curso na aba Participação; busca a lista, monta duas seções ("Já responderam" / "Ainda não responderam", cada uma com nome + turma) num container de impressão dedicado (`#imp-lista`) e aciona o `window.print()` do navegador (salvar como PDF é o próprio navegador quem oferece, sem lib nova).
- Tipo: Nova funcionalidade
- Motivo: Pedido do usuário — coordenador precisa de uma lista de nomes pra cobrar quem ainda não respondeu a CPA.
- Impacto/riscos a observar:
  - **Novo dado sensível exposto no módulo**: nome de aluno. Até aqui o CPA só mostrava números agregados; esta lista nominal é deliberada (pedido explícito) e seguiu o mesmo escopo por curso já existente (coordenador só vê os próprios cursos).
- Como testar: aba Participação, expandir um curso, clicar "Gerar PDF", conferir as duas listas (responderam/faltam) com nome e turma, confirmar no diálogo de impressão do navegador.
- Como reverter: `git revert` deste commit remove o botão e a rota; as rotas novas no relay do droplet não são desfeitas pelo revert (inofensivas, sem nada no Órbita chamando-as).

### [2026-10-14] Relatório CPA: nome do professor por disciplina (Alunos) + Docentes restrito à direção
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos alterados:
  - Relay (`/opt/edubox-relay/server.mjs`, droplet) — `cpaRelatorioAluno`: a consulta de notas por disciplina passa a selecionar `n.pronot AS codpro`, e uma consulta nova resolve esses códigos em nome (`tac_professor` join `trh_funcionario`), devolvidos em `professores`. Achado importante: o vínculo direto professor↔disciplina do aluno está em `tav_nota_historico_aluno.pronot`/`tav_resp_historico_aluno.prores` (100% preenchido, testado com dado real) — **não** em `tac_disciplina_turma.prodtu`, que o app `cpa-fatec` original já tinha encontrado zerado e por isso nunca mostrou professor nenhum. O módulo CPA anterior do Órbita (antes de ser substituído) já usava essa coluna corretamente.
  - `src/rotas/cpa.js` — `montarRelatorioAluno` resolve `codpro` → nome via o novo campo `professores` do relay e anexa uma lista de professores (pode ter mais de um, se a disciplina teve turmas diferentes com professores diferentes na mesma campanha) a cada item de `disciplinas`.
  - `cpa/app.js` — tabela "Por disciplina" mostra o(s) nome(s) do professor embaixo do nome da disciplina; cabeçalho da coluna virou "Disciplina / Professor".
  - `src/rotas/cpa.js` — `/campanhas` e `/relatorio-staff`: bloqueiam `tipo=P` (Docentes) pra qualquer cargo com escopo restrito (antes só bloqueava `tipo=O`/Administrativo) — pedido do usuário após testar com conta real de coordenador.
  - `cpa/app.js`, `cpa/index.html` — aba "Docentes" só é montada/visível pra quem vê tudo (`adm_l1`/`adm_l2`); coordenador fica só com Participação e Alunos.
  - `core/permissions.js`: sem mudança de código, mas a config `config/permissions` (Firestore) ganhou `coordenador.cpa=2`, `coord_medicina.cpa=2`, `adm_l2.cpa=3` — faltava essa entrada (nunca passou pela tela de Gerência de Acessos), o que fazia o item "Relatório CPA" não aparecer no menu desses cargos depois do primeiro login (o menu lê `config/permissions`, não a lista estática do cargo, assim que o cache local é preenchido).
- Tipo: Melhoria + correção de acesso
- Motivo: Pedido do usuário, testando com conta real de coordenador — queria ver o nome do professor na quebra por disciplina (recurso que o módulo anterior tinha) e decidiu que coordenador não deve ver Docentes de jeito nenhum (só Alunos).
- Impacto/riscos a observar:
  - Um `codpro` é por vínculo/turma, não por pessoa — o mesmo professor pode aparecer com códigos diferentes em disciplinas diferentes; isso já é tratado (resolve por nome, não por código).
  - Igual antes: sem cache, cada abertura de relatório busca o Edubox na hora.
- Como testar: logar como coordenador, abrir Relatório CPA → Alunos, conferir que a tabela de disciplinas mostra o nome do professor embaixo de cada disciplina; conferir que não existe mais aba "Docentes"; logar como ADM N1 e conferir que Docentes continua lá.
- Como reverter: `git revert` deste commit. A entrada em `config/permissions` no Firestore não é desfeita pelo revert (precisaria remover manualmente se for voltar ao estado "módulo invisível pro coordenador").

### [2026-10-14] Relatório CPA: módulo reconstruído do zero (substitui o anterior) + relay HTTP próprio pro Edubox (fim do PC da Fatec)
- Autor: Claude Code (a pedido do usuário)
- Branch: main
- Arquivos criados:
  - `src/utils/cpa-turma-labels.js` — rótulos T1/T2/T3 por coorte de ingresso (mesma lógica do app `cpa-fatec`, mas persistida em `config/cpa_rotulos_turma` no Firestore em vez de um JSON local — o Vercel não tem disco persistente entre invocações).
- Arquivos reescritos:
  - `src/rotas/cpa.js` — troca completa: antes lia `cpa_ciclos`/`cpa_relatorios`/`cpa_professores` (pré-agregados por `scripts/cpa-edubox-sync.js`); agora busca dado quase-cru do relay (`EDUBOX_RELAY_URL`/`EDUBOX_RELAY_TOKEN`) a cada requisição e agrega na hora (sem cache/sync, sempre ao vivo). Endpoints: `/campanhas`, `/cursos`, `/relatorio-aluno`, `/relatorio-staff` (docentes/administrativo), `/participacao`. RBAC: `adm_l1`/`adm_l2` veem tudo, inclusive administrativo; `coordenador`/`coord_medicina` só os próprios cursos (`users.cursos` → `CODCUR`), alunos e docentes, nunca administrativo.
  - `src/utils/cpa-comentarios.js` — heurística de classificação (bom/neutro/atenção) trocada pela versão mais refinada do app `cpa-fatec` (trata "elogio ao processo de melhoria da própria CPA" como bom, não mais como crítica).
  - `cpa/index.html`, `cpa/app.js`, `cpa/cpa.css` — UI nova com 4 abas (Participação, Alunos, Docentes, Administrativo — essa última só aparece pra quem vê tudo), gráfico de barras por pergunta (Chart.js), modal de comentários filtrável, participação por turma em cartão retrátil. Sem capa institucional/exportação em lote — não fazia parte do app aprovado.
- Arquivos alterados:
  - `core/permissions.js` — comentário acima do módulo `cpa` atualizado (não depende mais de `scripts/cpa-edubox-sync.js` nem de Firestore pré-agregado).
- Arquivos removidos:
  - `scripts/cpa-edubox-sync.js` — não tem mais o que sincronizar; os dados são buscados ao vivo a cada requisição.
- Infra (fora deste repositório, documentado aqui porque não há outro lugar):
  - Droplet DigitalOcean (`162.243.68.10`, mesmo servidor do relay do SIGMA, `/opt/edubox-relay/server.mjs`) ganhou 5 rotas novas (`/cpa/campanhas`, `/cpa/cursos`, `/cpa/relatorio-aluno`, `/cpa/relatorio-staff`, `/cpa/participacao`), autenticadas por um token próprio (`ORBITA_TOKEN` no `.env` do relay) — isolado do `RELAY_TOKEN` do SIGMA e do `PARCEIRO_TOKEN`, revogável sem afetar nenhum dos dois. Backup do `server.mjs`/`.env` de antes da mudança ficou em `server.mjs.bak-pre-orbita`/`.env.bak-pre-orbita` no próprio droplet.
  - `.env` do Órbita ganhou `EDUBOX_RELAY_URL`/`EDUBOX_RELAY_TOKEN` (mesmo padrão de nome já usado pelo SIGMA, valores próprios do Órbita).
- Tipo: Reconstrução de módulo + mudança de arquitetura (elimina dependência de PC da Fatec ligado)
- Motivo: Pedido do usuário — o CPA anterior (dimensões por eixo SINAES, ranking de professor, capa institucional) não foi aprovado pela direção; a direção aprovou em vez dele um app standalone (`cpa-fatec`) que o usuário já tinha construído, então este módulo foi reconstruído pra reproduzir esse app dentro do Órbita (login/RBAC do Órbita, dado vindo do relay em vez de rodar só localmente). De quebra, resolve o problema mais antigo: os scripts que buscavam dado do Edubox (CPA, CADD, Matrizes, Cobrança histórica) dependiam de um PC físico da Fatec ligado o tempo todo (via VBS no Startup do Windows) porque o Postgres do Edubox só aceita conexão do IP da instituição — inseguro (credencial de banco de terceiro numa máquina de usuário comum) e frágil (para se o PC for desligado). O CPA é o primeiro módulo migrado pro relay; CADD/Matrizes/Confirmação de Presença continuam no modelo antigo por enquanto.
- Impacto/riscos a observar:
  - **Sem cache**: cada abertura de relatório consulta o Edubox na hora (como o app `cpa-fatec` original já fazia) — mais lento que ler Firestore, mas sempre atual e sem depender de ninguém rodar sincronização.
  - **Novo recurso que o `cpa-fatec` original não tinha**: filtro de Docentes por curso (`tav_resp_curso_prof`), criado especificamente pra permitir coordenador ver só os professores do próprio curso — não existia no app standalone (lá não tinha login nem RBAC).
  - **Gap conhecido, não implementado agora**: o relatório de Docentes não traz nome do professor nem quebra por professor individual (só o agregado do curso/instituição) — dava pra juntar com `tac_professor`/`trh_funcionario` (como o CPA anterior fazia) se um dia for pedido.
  - **`cpa_ciclos`/`cpa_relatorios`/`cpa_professores` no Firestore não foram apagados** (dado histórico, inofensivo) — só não são mais lidos nem escritos por nada.
  - **Dependência nova**: módulo CPA agora depende do relay estar no ar (`162.243.68.10:8443`) — se o droplet cair, o módulo inteiro para (antes dependia do PC da Fatec estar ligado, que era ainda menos confiável).
- Como testar: logar como `adm_l1`, abrir "Relatório CPA", testar as 4 abas (Participação, Alunos, Docentes, Administrativo) com uma campanha e curso reais; conferir que os gráficos, chips de comentário e o modal de comentários funcionam; logar como `coordenador` e conferir que só vê os próprios cursos em Alunos/Docentes e que a aba Administrativo nem aparece.
- Como reverter: `git revert` deste commit restaura o módulo anterior (volta a depender de `cpa_ciclos`/`cpa_relatorios`/`cpa_professores` no Firestore, que não foram apagados) — mas as rotas novas no relay do droplet (`/cpa/*`) e o `ORBITA_TOKEN` no `.env` dele não são desfeitos pelo revert (ficam inofensivos, sem nada no Órbita chamando-os).

### [2026-09-11] Matrículas: busca de "Aluno Indica" corrigida — não achava veterano de semestre anterior
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/financeiro/matriculas/app.js` — `buscarVeteranosParaIndicacao` agora busca o nome em TODOS os semestres já cadastrados no sistema (`GET /matriculas/config/semestres`, cacheado em memória), em paralelo, e junta os resultados (mais recente primeiro) — antes só buscava no semestre do calouro sendo cadastrado. Cada resultado da busca agora mostra também o semestre, pra diferenciar quando o mesmo nome aparece em mais de um.
  - `/financeiro/matriculas/index.html` — texto de ajuda embaixo do campo atualizado ("...em qualquer semestre").
- Tipo: Correção de bug
- Motivo: Bug real relatado pelo usuário — cadastrando calouro no semestre 2027.1 (recém-aberto), o veterano que indicou ainda só existia em 2026.2 (não passou pelo "Virar Semestre" ainda) e não aparecia na busca. Confirmado com dado real (aluna existia em 2026.1/2026.2, ausente em 2027.1 — não aparecia antes da correção, aparece agora).
- Impacto/riscos a observar:
  - Cada semestre é uma requisição própria (paralelas) — com poucos semestres cadastrados (hoje: 2026.1, 2026.2, 2027.1) o custo é baixo; se a lista de semestres crescer muito ao longo dos anos, reconsiderar limitar a busca aos últimos N semestres.
- Como testar: cadastrar um calouro no semestre mais recente e buscar por um veterano que só existe num semestre anterior (ainda não migrado) — deve aparecer normalmente agora, com o semestre dele ao lado do nome.
- Como reverter: `git revert` deste commit volta a buscar só no semestre do calouro sendo cadastrado (reintroduz o bug relatado).

### [2026-09-11] Licitação: ajusta o link por cotação (só mostra o mais barato na lista, link clicável no modal)
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/financeiro/licitacao/app.js` — a lista de itens agora mostra o 🔗 da cotação MAIS BARATA (ao lado do nome da empresa, não do badge "Fechado" — antes era o link de quem fechou, não mais); pra ver o link de qualquer outra empresa (inclusive a que fechou, se for diferente da mais barata), abre o modal de Cotações (💰), onde todas aparecem. Nesse modal, cada linha ganhou um botãozinho 🔗 do lado do campo de link que abre a URL direto numa aba nova (sem precisar copiar/colar) — fica desabilitado enquanto o campo está vazio.
  - `/financeiro/licitacao/licitacao.css` — estilo do botão de abrir link dentro do modal de cotações.
- Tipo: Ajuste de UX (refinamento do que foi feito nesta mesma sessão)
- Motivo: Pedido do usuário — só queria ver o link da cotação mais barata na lista principal; o link das outras empresas (inclusive a que fechou, se pagou mais caro) fica dentro do modal de cotações mesmo, só que agora clicável.
- Impacto/riscos a observar:
  - Não mexeu no cadastro de item em si — o campo de link do item (`linkReferencia`, referência geral/observação) é outra funcionalidade, já existia antes desta sessão e continua do jeito que estava, a pedido do usuário.
- Como testar: abrir Licitação, item com 2+ cotações e links diferentes — conferir que só o 🔗 da mais barata aparece na lista; abrir "Cotações" (💰) e clicar no botão ao lado do campo de link de qualquer empresa pra abrir a página numa aba nova.
- Como reverter: `git revert` deste commit volta pro comportamento do commit anterior (link do fornecedor fechado, sem botão de abrir no modal).

### [2026-09-11] Licitação: link do produto por cotação (conferir se fechou com a mais cara)
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/financeiro.js` — `calcularCotacoes` passa a aceitar/gravar `link` por cotação (junto com `fornecedorId`/`valorUnitario`/`valorTotal`), usado por `PUT /itens/:id/cotacoes`. As 3 rotas que RECONSTROEM a cotação do fornecedor na hora de fechar (`POST /fechamento/confirmar`, `POST /fechamento/confirmar-com-desconto`, `PUT /fechamento/:id/valor`) agora preservam o `link` que já existia naquela cotação — sem isso, fechar apagava a referência do produto.
  - `/financeiro/licitacao/app.js` — modal de cotações ganha um campo "Link do produto" por fornecedor (opcional); na tabela de itens, quando um item fechado tem link registrado na cotação vencedora, mostra um 🔗 clicável ao lado do badge "Fechado — Empresa" — e se a empresa fechada NÃO for a mais barata cotada, o ícone vem com ⚠️ e o título deixa isso explícito.
  - `/financeiro/licitacao/licitacao.css` — grid da linha de cotação passa de 3 pra 4 colunas (nome / valor / link / total).
- Tipo: Nova funcionalidade
- Motivo: Pedido do usuário — quando um item tem mais de uma cotação e o "patrão" decide fechar com a mais cara, precisava dar pra ver o link do produto dela pra conferir/justificar a escolha.
- Impacto/riscos a observar:
  - **Campo opcional** — cotação sem link continua funcionando normal, só não mostra o ícone.
  - **Só aparece o link da empresa que FECHOU**, não de todas as concorrentes ao mesmo tempo na tabela principal (ficam salvas em `item.cotacoes[].link`, visíveis reabrindo o modal de cotações desse item).
- Como testar: abrir Licitação, cadastrar um item, abrir "Cotações", preencher valor + link de 2+ fornecedores, fechar (na tela de Fechamento) com o fornecedor que NÃO é o mais barato, e conferir que aparece 🔗⚠️ ao lado do "Fechado" na lista de itens, com o link certo.
- Como reverter: `git revert` deste commit — cotações que já tinham link gravado ficam com o campo no Firestore, só não é mais lido/exibido em lugar nenhum (inofensivo).

### [2026-09-11] Novo módulo: Banco MED-FATEC (banco de questões da Medicina)
- Autor: trabalho já estava em andamento no diretório quando esta sessão começou (não foi escrito por este agente) — commitado/subido a pedido do usuário.
- Branch: main
- Arquivos criados:
  - `/banco-med-fatec/` (`index.html`, `app.js`, `banco-med-fatec.css`) — tela de categorias/disciplinas, cadastro de questões (múltipla escolha única/múltipla, verdadeiro/falso) e montagem de provas.
  - `/src/rotas/banco-med-fatec.js` — CRUD de categorias, questões e provas (coleções `banco_med_categorias`, `banco_med_questoes`, `banco_med_provas`); `GET /provas/:id/exportar` gera XML no formato Moodle pra importar a prova como questionário no AVA.
  - `/src/utils/moodleXml.js` — gerador do XML Moodle reaproveitado pelo endpoint de exportação.
  - `/img/medfatec-logo.png` — logo do módulo.
- Arquivos alterados:
  - `/api/index.js` — `require`/`app.use` da rota `/api/banco-med-fatec`.
  - `/core/permissions.js` — nova categoria "Medicina", módulo `banco-med-fatec` no menu, liberado pra `adm_l1`/`adm_l2`.
  - `/src/middlewares/auth.js` — nível padrão de `banco-med-fatec` por cargo (3 pra quem é de Medicina/Admin, 1 pros demais).
- Tipo: Nova funcionalidade
- Motivo: Pedido do usuário — subir esse trabalho que já estava pronto no diretório.
- Impacto/riscos a observar:
  - **Não revisado a fundo por este agente** — o código foi escrito por outra sessão/pessoa antes desta conversa; só foi conferido sintaticamente (todos os arquivos passam `node -c`/check de módulo ES) antes de commitar, sem revisão funcional linha a linha.
  - **Limite de 950KB por imagem em base64** (`MAX_IMG_BASE64`), mesmo padrão já usado no módulo Ferida pra não estourar o limite de 1 MiB por documento do Firestore.
- Como testar: logar como `adm_l1`/`adm_l2`, abrir "BANCO MED-FATEC" no menu (categoria Medicina), cadastrar uma categoria, uma questão e montar uma prova; exportar a prova e conferir o XML gerado.
- Como reverter: `git revert` deste commit remove o módulo inteiro (arquivos + rotas + permissões).

### [2026-09-11] Matrículas: lista de Situações — remove "Retorno", adiciona 4 novas (pedido da Lisa/Financeiro)
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/matriculas.js` — `SITUACOES` perde `'Retorno'` e ganha `'Matrícula Nova - Retorno'`, `'Matrícula Nova - Retorno Assinada'`, `'Matrícula Nova - Transferência'`, `'Matrícula Nova - Transferência Assinada'` (mesmo padrão do par já existente `'Matrícula Nova'`/`'Matrícula Nova - Assinada'`). `'Transferência'` (sozinho) foi mantido — só "Retorno" foi removido, a pedido explícito do usuário.
  - `/financeiro/matriculas/app.js` — `SITUACAO_GRUPO` (cor do badge) atualizado: as duas variantes "Assinada" entram no grupo `ok` (verde), as duas sem "Assinada" entram no grupo `alerta` (amarelo), removida a entrada de `'Retorno'`.
- Tipo: Mudança de dado/vocabulário controlado
- Motivo: Pedido do usuário (conversa com a Lisa, Financeiro) — "Retorno" não vinha da planilha original; a partir de 2026 querem separar se o retorno ou a transferência já foi assinado ou não, mesma lógica já usada pra "Matrícula Nova".
- Impacto/riscos a observar:
  - **19 alunos com situação "Retorno" não foram migrados** (todos de `fatec`/semestre `2026.1`) — ficam como estão, é histórico de antes dessa mudança; "Retorno" só não aparece mais como opção pra escolher num cadastro NOVO ou editado. Se algum dia abrir um desses 19 pra editar, o campo de situação vai aparecer vazio até escolher uma das opções válidas atuais.
  - **`'Transferência'` (sozinho) continua na lista** — não foi pedido remover, só "Retorno".
- Como testar: abrir Matrículas, cadastrar/editar um aluno e conferir que "Retorno" sumiu do select e as 4 novas opções aparecem; escolher uma delas e conferir a cor do badge (Assinada = verde, sem Assinada = amarelo) na lista.
- Como reverter: `git revert` deste commit volta a lista de situações ao estado anterior — não mexe nos 19 registros antigos (não foram tocados por essa mudança).

### [2026-09-11] Matrículas: filtro de Situação também vira multi-seleção tipo Excel
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/financeiro/matriculas/index.html` + `app.js` — mesmo tratamento dado ao filtro de Período (ver entrada anterior) aplicado agora ao filtro de Situação: checkbox por situação, "Marcar todos"/"Desmarcar todos", contador no botão. Lista de opções vem de `opcoes.situacoes` (carregada do servidor), não é fixa como a de período.
  - `/src/rotas/matriculas.js` — `GET /alunos` e `GET /alunos/contagem` aceitam `situacoes` (plural, separado por vírgula) além do `situacao` (singular) existente. Como o Firestore só aceita UM operador `in` por consulta, quando período E situação vêm marcados ao mesmo tempo a rota de contagem lê os documentos (já filtrados por módulo/semestre/curso/plano) e conta em memória, em vez de usar `count()` puro nos dois — único jeito de combinar dois filtros "tipo Excel" na mesma contagem.
- Tipo: Melhoria de UX
- Motivo: Pedido do usuário — mesmo comportamento do filtro de Período, agora pro de Situação.
- Impacto/riscos a observar:
  - **Contagem com período + situação marcados ao mesmo tempo** deixa de ser uma leitura de agregação pura e passa a ler os documentos do módulo/semestre (a coleção é da ordem de 1500-1800 por semestre) — mais caro que antes, mas só acontece quando os dois filtros tipo Excel estão ativos ao mesmo tempo.
  - Só a tela principal de Matrículas foi alterada — o filtro de situação da tela "Virar Semestre" (`vs-situacao-filtro`) continua um `<select>` normal.
- Como testar: abrir Matrículas, desmarcar algumas situações no filtro, conferir lista e contador; combinar com filtro de período marcado também e conferir que os dois se aplicam juntos.
- Como reverter: `git revert` deste commit volta ao `<select>` de escolha única.

### [2026-09-11] Matrículas: filtro de Período vira multi-seleção tipo Excel
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/financeiro/matriculas/index.html` + `app.js` + `matriculas.css` — o `<select>` de Período (só deixava escolher um por vez) virou um dropdown com checkbox por período (1º-12º + DP), "Marcar todos"/"Desmarcar todos" e botão mostrando quantos estão marcados — mesmo comportamento do filtro de coluna do Excel. Guarda só quem foi DESMARCADO (`periodosDesmarcados`), não quem está marcado, então a lista nunca fica "traduzida errado" se mudar de módulo.
  - `/src/rotas/matriculas.js` — `GET /alunos` e `GET /alunos/contagem` aceitam `periodos` (plural, separado por vírgula) além do `periodo` (singular) que já existia; contagem usa `where('periodo','in',[...])` do Firestore.
- Tipo: Melhoria de UX
- Motivo: Pedido do usuário — queria selecionar todos os períodos de uma vez e ir desmarcando os que não quer ver, em vez de escolher um por vez.
- Impacto/riscos a observar:
  - **Só a tela principal de Matrículas** (`index.html`) foi alterada — o filtro de período da tela "Virar Semestre" (`vs-periodo-filtro`) continua sendo um `<select>` normal, não fazia parte do pedido.
  - **Quando tudo está marcado, o filtro não é aplicado** (equivalente a "Todos os períodos" de antes) — isso inclui aluno com período em branco. Assim que a pessoa desmarca QUALQUER período, só quem está marcado aparece — aluno com período em branco some da lista nesse caso (não existe uma opção "(em branco)" no filtro, mesma limitação que o Excel teria sem essa opção).
- Como testar: abrir Matrículas, clicar no filtro de Período, desmarcar alguns períodos e conferir que a lista e o contador de registros atualizam sozinhos; clicar "Marcar todos"/"Desmarcar todos" e conferir o texto do botão ("Todos os períodos" / "N período(s) selecionado(s)" / "Nenhum período").
- Como reverter: `git revert` deste commit volta ao `<select>` de escolha única.

### [2026-09-04] Secretaria Acadêmica: "Relatório DP" some do menu do cargo `sec` (bug) + novos logins
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/core/permissions.js` — `sec.modules` estava sem `"relatorio-dp"`, mesmo o cargo já tendo nível 3 pra esse módulo configurado no documento `config/permissions` do Firestore (usado pela tela "Gerência de Acessos") — o link "Relatório DP" nunca aparecia no menu de ninguém com cargo Secretaria, mesmo quem já tinha acesso liberado. Mesma classe de bug já corrigida antes pro cargo `financeiro` (matrículas/cobrança em 2026-09-04) — aqui a causa é a lista estática do menu, não o documento de permissões (que já estava certo).
- Tipo: Correção de bug (menu escondendo módulo já liberado)
- Motivo: Pedido do usuário — Ediane, Brenda, Hemilly (já tinham login), Dyenyffer e Maria Eduarda (logins novos) precisavam ver Relatório de Matrículas e Relatório DP.
- Impacto/riscos a observar:
  - **Não fica registrado em código quem tem qual acesso individual** — os dois usuários novos (Dyenyffer, Maria Eduarda) e o ajuste de nível "leitor" (Hemilly, Dyenyffer) foram feitos direto no Firestore (`users/{uid}` e `users/{uid}.permissoes`), não há arquivo/commit que documente isso — só esta entrada do changelog.
  - **E-mails fictícios**: a pedido do usuário, Dyenyffer e Maria Eduarda foram cadastradas com e-mail fictício `@orbita.com.br` (não é domínio institucional real) e senha temporária `primeironome@26` — force login e troca de senha no 1º acesso já é o padrão do sistema (`primeiroAcesso: true`).
- Como testar: logar como Ediane/Brenda (cargo `sec`, sem override) e conferir que "Relatório DP" aparece no menu; logar como Hemilly/Dyenyffer e confirmar que Matrículas abre em modo leitura (sem botão de cadastrar/editar) mas Relatório DP abre completo.
- Como reverter: `git revert` deste commit volta a esconder "Relatório DP" do menu de todo o cargo Secretaria (não só dessas 5 pessoas) — os logins/permissões criados no Firestore não são desfeitos pelo revert (teria que desativar as contas manualmente se for o caso).

### [2026-09-04] Orçamento: cada colaboradora vê só o próprio, Chefe de Setor (Lisa) vê de todo mundo
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/orcamento.js` — `GET /orcamentos` e `GET /orcamentos/setores` filtram por `createdBy === uid` da requisição, exceto pra quem é `adm_l1`/`adm_l2` ou tem `chefeDeSetor: true` (mesmo flag já usado pra restringir exclusão — Lisa, do Financeiro, já tinha essa flag). `PUT /orcamentos/:id`, `GET/POST /orcamentos/:id/lancamentos` e `PUT/DELETE /lancamentos/:id` agora checam que quem está mexendo é a dona do orçamento (ou chefe/admin) antes de aplicar — antes dava pra editar/lançar gasto em orçamento de qualquer colega só sabendo o id, mesmo sem aparecer na lista dela. `POST /orcamentos` grava `createdByNome` (nome de quem criou), pra quem vê "de todo mundo" saber de quem é cada um.
  - `/financeiro/orcamento/app.js` — mostra o nome de quem cadastrou como uma tag no card do orçamento (só aparece quando o campo existe — orçamentos antigos, criados antes desta mudança, não têm essa tag).
- Tipo: Mudança de permissão/escopo de dados
- Motivo: Pedido do usuário — "a página de orçamento precisa ser individual pra cada colaboradora e a Lisa como responsável vê de todo mundo".
- Impacto/riscos a observar:
  - **Orçamentos já existentes**: só 2 no banco no momento desta mudança, ambos criados pela própria Lisa — não precisou de backfill de `createdByNome` (fica em branco nos 2 antigos, sem problema porque quem vê "todo mundo" já sabe que são dela).
  - **Chave de "vê tudo" é o mesmo flag `chefeDeSetor`** usado no módulo inteiro do sistema (Painel do Setor, Quadro de Avisos, exclusão de orçamento) — não é exclusivo de Orçamento; se um dia outra pessoa virar Chefe de Setor do Financeiro, ela também passa a ver o orçamento de todo mundo automaticamente, o que é o comportamento esperado.
  - **Catálogo de itens continua compartilhado** (`financeiro_orcamento_catalogo_itens`) — não faz parte do escopo individual, é intencional (autocomplete de nome de item vale pra todo mundo do setor).
- Como testar: Logar como uma colaboradora sem `chefeDeSetor` (ex.: Vanessa ou Maria Juliete) e conferir que só aparece o que ela mesma cadastrou; logar como Lisa e conferir que aparece tudo, com o nome de quem cadastrou em cada card; tentar editar/lançar gasto num orçamento de outra pessoa direto pela URL/API e confirmar erro 403.
- Como reverter: `git revert` deste commit volta a mostrar todo mundo pra todo mundo (comportamento antigo). O campo `createdByNome` gravado nos orçamentos criados enquanto essa mudança estava ativa não é apagado pelo revert (inofensivo, só não é mais lido em lugar nenhum).

### [2026-09-04] Matrículas: novo campo "Aluno Indica" (veterano indica calouro) + relatório de ranking
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/financeiro/matriculas/aluno-indica.html` — tela própria de relatório (mesmo padrão de `relatorio.html`: filtro módulo/semestre/curso, KPIs, tabela, impressão), com link no menu de `index.html` e `relatorio.html`.
- Arquivos alterados:
  - `/src/rotas/matriculas.js` — `POST/PUT /alunos` aceitam `indicadoPorAlunoId`/`indicadoPorNome` (aluno não pode indicar a si mesmo, checado no front); `GET /alunos/:id/indicados` (quem esse veterano específico já indicou); `GET /aluno-indica` (ranking agregado por módulo/semestre: quantos indicaram, quantas indicações, e por veterano a lista de quem ele indicou) — mesmo padrão de agregação em memória do `/relatorio` já existente, sem índice composto novo.
  - `/financeiro/matriculas/index.html` + `app.js` — campo "Aluno Indica" no formulário de aluno (autocomplete por nome, busca só dentro do módulo/semestre do calouro sendo cadastrado via a mesma rota `GET /alunos?busca=`); ao editar um aluno que já é veterano de outros, mostra inline quantos/quem ele indicou.
  - `/financeiro/matriculas/matriculas.css` — estilos do autocomplete e do chip do veterano selecionado; adicionada `.linha-hint` (não existia neste CSS).
- Tipo: Nova funcionalidade
- Motivo: Pedido do usuário — a secretaria quer registrar, na hora de matricular um calouro, qual veterano já matriculado indicou ele, e depois conseguir ver quantos e quem cada veterano indicou.
- Impacto/riscos a observar:
  - **Identidade do aluno é só por nome + documento por semestre**: não existe CPF nem id global de pessoa em `matriculas_alunos` — cada semestre é um documento novo (ligado ao anterior só via `origemAlunoId` quando passa pelo "Virar Semestre"). "Aluno Indica" referencia o **documento específico** do veterano escolhido na busca, não a pessoa em abstrato — se o mesmo veterano tiver documentos em semestres diferentes, indicações registradas em momentos diferentes podem acabar ligadas a documentos diferentes dele.
  - **Busca de veterano restrita ao módulo/semestre do calouro**: não busca em semestres anteriores. Cobre o caso comum (veterano já rematriculado no semestre atual antes de abrir matrícula de calouro), mas não acha um veterano que só esteja em semestre mais antigo.
  - **`indicadoPorNome` é denormalizado**: se o nome do veterano for corrigido depois (edição de cadastro), o nome mostrado nas indicações antigas não atualiza sozinho — mostra o nome de quando a indicação foi registrada.
- Como testar: Abrir Matrículas, cadastrar um calouro e usar "Aluno Indica" pra buscar e escolher um veterano já matriculado; salvar; abrir esse mesmo calouro editando de novo e conferir que o veterano continua selecionado; editar o veterano e conferir que aparece "Alunos que este aluno indicou" com o calouro na lista; abrir "Aluno Indica" no menu e conferir o ranking.
- Como reverter: `git revert` deste commit remove os arquivos novos e a UI; os campos `indicadoPorAlunoId`/`indicadoPorNome` gravados nos documentos de `matriculas_alunos` não são apagados pelo revert (ficam órfãos, inofensivos — não são lidos por nenhuma outra rota).

### [2026-09-04] Cobrança: filtro jurídico/modelo, comparativo em tela própria, editar aluno, excluir ação, correção de cursos truncados, "carregar mais"
- Autor: Claude Code
- Branch: main
- Arquivos alterados:
  - `/src/rotas/cobranca.js` — filtro `juridico` (advogado/judicial, derivado do campo `plano`) e `modelo` (Bacharelado/Licenciatura/Tecnólogo, derivado do prefixo do `curso`) em `/resumo`, `/filtros` e `/parcelas`; `/parcelas` não pagina mais no servidor (devolve a lista inteira filtrada de uma vez — o "Carregar mais" do front só revela mais linhas já trazidas, sem nova leitura no Firestore); `PUT /alunos/:cpf` novo (edita nome/CPF/celular/situação em **todas** as parcelas daquele CPF de uma vez — antes só dava pra editar por parcela — e registra sozinho um evento `mudanca_situacao` no histórico quando a situação muda, migrando o histórico de ações pro CPF novo se o CPF for corrigido); `DELETE /acoes/:id` novo.
  - `/scripts/importar-cobranca-planilha.js` — reconstrói o campo `curso` usando o campo `plano` da planilha: "SUPERIOR DE TECNOLOGIA EM GEST..." (truncado a 30 caracteres na fonte) escondia 4 tecnólogos diferentes (Gestão Financeira, Gestão Comercial, Gestão de Recursos Humanos, Agronegócio) — resolvido por aluno (cpf), caindo em "não identificado" quando nenhuma parcela do aluno tem um plano que revele o curso (9 de 21 alunos nesse caso); outros 5 cursos truncados sem ambiguidade também corrigidos. Script agora é seguro de rodar de novo (`--confirmar` apaga a carga anterior de parcelas + ações com `origem=planilha` antes de regravar, nunca toca em caso/ação manual).
  - `/financeiro/cobranca/index.html` + `relatorio.html` + `app.js` + `cobranca.css` — filtros novos (situação jurídica, modelo), coluna "Jurídico" na tabela, nome do curso e modelo separados em tag (`BACHARELADO EM X` → nome "X" + tag "Bacharelado"), botão "Editar aluno" (nome/CPF/celular/situação, separado do "Editar parcela"), botão de excluir + data/hora/autor em cada item do histórico de ações, "Carregar mais" no lugar da paginação por página.
  - `/financeiro/cobranca/comparativo.html` (novo) — o histórico mensal (jan-ago/2026) saiu de dentro do índice/relatório (não reagia a filtro nenhum, ficava confuso do lado de filtros que não o afetavam) e virou tela própria, com cards + barra proporcional por mês em vez de tabela crua.
  - `/firestore.indexes.json` — sem mudança nesta rodada (índice `cpf`+`criadoEm` já tratado no commit anterior).
- Tipo: Correção de dado (cursos truncados) + melhorias de UX/performance
- Motivo: Feedback do usuário testando a tela: nomes de curso cortados, tecnólogos de Gestão misturados, comparativo confuso fora de contexto, tela "travando" ao editar aluno com várias parcelas (bug real: botão Cancelar ficava escondido dentro do formulário), falta de opção de editar aluno/excluir ação/registrar data e autor, paginação relendo a coleção inteira a cada página.
- Impacto/riscos a observar:
  - **Bug corrigido**: o modal de "escolher qual parcela editar" não tinha como cancelar (botão Cancelar estava dentro do `<form>` que ficava escondido junto) — usuária ficava presa até escolher uma parcela. Corrigido com um botão de cancelar próprio nessa tela.
  - **9 alunos do tecnólogo de Gestão continuam com curso "não identificado"**: não há informação na planilha (nenhuma parcela deles tem plano que revele qual Gestão é) — só dá pra corrigir com cadastro manual se alguém souber o curso certo.
- Como testar: abrir Cobrança, testar filtro "jurídico" e "modelo" separadamente; abrir "Editar aluno" num aluno com várias parcelas e confirmar que dá pra cancelar sem escolher nada; mudar a situação de um aluno e conferir que vira registro automático no histórico; excluir um registro do histórico; clicar "Carregar mais" na lista; abrir a tela "Comparativo mensal" pelo menu.
- Como reverter: `git revert` deste commit. Os dados já reimportados com curso corrigido no Firestore não voltam sozinhos ao estado truncado (não é destrutivo reverter só o código).

### [2026-09-03] Cobrança: troca a fonte de dados do Edubox (Postgres) por planilha importada + cadastro manual
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/scripts/importar-cobranca-planilha.js` — importação ÚNICA da planilha `COBRANÇA GRADUAÇÃO.xlsx` (fonte: financeiro) pro Firestore. Lê a aba "Todos graduação " (mestra — as abas "Advogado"/"Trancados, cancelado..."/"Ativos" são só recortes filtrados dela, mesmo schema, conferido linha a linha) e a aba "Comparativo Valores em Aberto " (histórico jan-ago/2026). A planilha tem 3 linhas de rodapé (subtotal/cabeçalho repetido/"Qtd.") misturadas nos dados — filtradas por Sta.Mat fora do conjunto válido; conferido que a soma bate exato com o rodapé da própria planilha (1119 linhas válidas, R$ 737.586,48 "A Pagar", R$ 7.799,03 "V, Pago"). 14 linhas duplicadas exatas foram ignoradas na gravação (1105 parcelas gravadas). Roda com `--confirmar`; sem essa flag só mostra prévia.
- Arquivos removidos:
  - `/src/db-edubox.js` (conexão Postgres com o Edubox — não usada por mais nada no sistema)
- Arquivos reescritos:
  - `/src/rotas/cobranca.js` — trocou consulta ao vivo no Postgres do Edubox por leitura no Firestore (coleção nova `financeiro_cobranca_parcelas`). Sem `codcli` (id numérico do Edubox) — a chave agora é `cpf`. Coleção pequena (~1100 docs): lê tudo (ou filtra por um único campo de igualdade — curso OU semestre) e agrupa/pagina em memória, mesmo padrão de `orcamento.js`, evita índice composto novo. Endpoints novos: `GET /filtros` (cursos+semestres+situações, substitui `/cursos` e `/semestres`), `GET /parcelas/detalhe?ids=` (detalhe de parcelas específicas, usado na edição), `POST/PUT/DELETE /parcelas` (cadastro manual — a partir de agora o financeiro cadastra/edita direto pela tela, sem reimportar planilha), `GET /historico-mensal` (série jan-ago/2026 importada, não recalculável a partir das parcelas atuais). `/acoes/:cpf` (era `/acoes/:codcli`) e `/acoes/importar-csv` (agora casa CPF contra `financeiro_cobranca_parcelas` em vez do Edubox).
  - `/financeiro/cobranca/index.html` + `app.js` + `cobranca.css` — filtro novo de situação de matrícula (badge colorido na tabela), botão "Novo caso" + modal de cadastro/edição manual (com escolha de qual parcela editar quando o aluno tem mais de uma no mesmo curso), textos que mencionavam Edubox atualizados.
  - `/financeiro/cobranca/relatorio.html` + `app.js` — card novo com o histórico mensal (jan-ago/2026) importado da planilha, acima da tabela de inadimplência filtrada; coluna de situação adicionada na tabela do relatório.
  - `/firestore.indexes.json` — índice `financeiro_cobranca_acoes` trocou o campo `codcli` por `cpf` (mesmo formato `ASC + criadoEm DESC`) — **deployado** via `firebase deploy --only firestore:indexes` (não apagou os índices que já existiam fora do arquivo, rodado sem `--force`).
  - `/package.json`, `package-lock.json` — removida a dependência `pg` (`npm uninstall pg`)
  - `.env_exemplo` — removidas as chaves `EDUBOX_*` (sem uso)
- Seed automático na importação: parcelas com `Plano = "ADVOGADO FATEC"` viram uma ação `enviado_advocacia` e `Plano = "DÉBITO JUDICIAL"` viram `acordo_judicial` em `financeiro_cobranca_acoes` (uma ação por aluno, não por parcela — 55 ações seedadas: 39 advocacia + 16 acordo judicial).
- Regra de semestre: Janeiro-Junho = `AAAA/1`, Julho-Dezembro = `AAAA/2`, calculada a partir do vencimento — vale pra qualquer ano presente nos dados (dívida antiga inclusive), a pedido do usuário. Campo fica editável por caso, porque negociação pode mudar em qual período uma dívida é cobrada.
- Tipo: Mudança de arquitetura (troca de fonte de dados) + nova funcionalidade (cadastro manual)
- Motivo: Pedido do usuário — a planilha da financeiro (`COBRANÇA GRADUAÇÃO.xlsx`) passou a ser a fonte oficial dos casos de cobrança; o financeiro vai cadastrar/atualizar os casos manualmente pela tela a partir de agora, não há mais reimportação de planilha prevista nem consulta ao vivo no Edubox.
- Impacto/riscos a observar:
  - **Dado agora é estático até ser editado manualmente**: ao contrário da versão anterior (consulta ao vivo), pagamentos feitos depois de 2026-09-03 só refletem no sistema quando alguém marcar manualmente (`valorPago`) ou editar/excluir o caso. Não existe mais reconciliação automática com nenhum sistema externo.
  - **Escopo temporal mais curto**: a planilha só cobre jan-ago/2026 (dívida mais antiga tinha ido até 2010 na versão com Edubox) — dívidas anteriores a 2026 não estão neste módulo a menos que alguém as cadastre manualmente.
  - **CPF agora é a chave de tudo**: sem CPF, um caso cadastrado manualmente não aparece automaticamente ligado a nenhuma ação/histórico anterior (mesma limitação que já existia na importação CSV antes).
  - **Índice do Firestore precisa estar deployado**: sem o índice `cpf ASC + criadoEm DESC` em `financeiro_cobranca_acoes`, `GET /acoes/:cpf` quebra com `FAILED_PRECONDITION` — já deployado nesta mudança, mas se o índice for removido/recriado do zero em outro projeto, rodar `firebase deploy --only firestore:indexes` de novo.
- Como testar: Logar como `financeiro`; abrir "Cobrança"; escolher um curso ou semestre e clicar em "Buscar"; conferir a coluna de situação e os dias de atraso; clicar em "Novo caso" e cadastrar um caso de teste; editar um caso existente que tenha mais de uma parcela (ex.: escolher qual parcela editar aparece antes do formulário); abrir o relatório e conferir a tabela de histórico mensal (jan-ago/2026) e o botão de imprimir.
- Como reverter: `git revert` deste commit volta o código pro estado com Edubox — mas os dados gravados em `financeiro_cobranca_parcelas`/`financeiro_cobranca_historico_mensal` no Firestore não são apagados pelo revert (teriam que ser removidos manualmente se for realmente voltar atrás), e o índice antigo (`codcli`) precisaria ser redeployado.

### [2026-08-31] Novo módulo: Cobrança (inadimplência + controle de advocacia)
- Autor: Claude Code
- Branch: main
- Arquivos criados:
  - `/src/db-edubox.js` (reconecta ao Postgres do Edubox, mesmo padrão do extinto módulo CPA — ver remoção em 2026-08-10 — mas agora no banco `edubox` **ao vivo**, não `edubox_old`: testado em 2026-08-31, `edubox_old` estava ~3 meses desatualizado, inaceitável para inadimplência)
  - `/src/rotas/cobranca.js` (`GET /resumo`, `GET /cursos`, `GET /semestres`, `GET /parcelas` — lista de alunos com parcela vencida em aberto, agrupada por aluno+curso, dias de atraso calculados como `current_date - venctr` porque o campo `ddvctr` do Edubox não é confiável — testado com parcelas vencidas há 126 a 2785 dias sempre retornando `0`/`null`; `GET/POST /acoes` e `POST /acoes/importar-csv` — histórico de contato/negociação/advocacia, gravado só no Firestore, coleção `financeiro_cobranca_acoes`)
  - `/financeiro/cobranca/` (`index.html`, `app.js`, `cobranca.css`, `relatorio.html`) — segue o padrão visual/estrutural de `financeiro/orcamento`
- Arquivos alterados:
  - `/package.json` (nova dependência `pg`)
  - `.env`, `.env_exemplo` (`EDUBOX_HOST`/`PORT`/`DATABASE`/`USER`/`PASSWORD` — mesmas chaves que existiam antes do CPA, `.env` real não versionado)
  - `/api/index.js` (`require`/`app.use` da rota `/api/cobranca`)
  - `/core/permissions.js` (novo módulo `cobranca`, categoria `financeiro`, **exclusivo do cargo `financeiro`** — a pedido do usuário, nem `adm_l2` vê no menu; `adm_l1` não está na lista mas mantém o bypass de Super Admin do backend, que vale pra todo módulo do sistema, não só este)
  - `/src/middlewares/auth.js` (chave `cobranca` no `defaultPermissions`: `financeiro: 3`, todos os outros cargos `1` — inclusive `adm_l2`, diferente do padrão de `licitacao`/`orcamento` que ele também acessa)
  - `/firestore.indexes.json` (índice composto novo `financeiro_cobranca_acoes` (`codcli` ASC, `criadoEm` DESC), necessário pro histórico de ações por aluno — **precisa rodar `firebase deploy --only firestore:indexes` manualmente**, não foi deployado automaticamente)
- Tipo: Nova Funcionalidade
- Motivo: Pedido do usuário (Financeiro) — inadimplência hoje só é visível "por dentro" do Edubox, sem filtro por curso/semestre, sem histórico de negociação e sem rastro de quais dívidas já foram encaminhadas ao escritório de advocacia (o financeiro às vezes manda um aluno pro jurídico fazer acordo). Situação real em 2026-08-31: 716 alunos com parcela vencida em aberto, R$ 2.832.150,73 total, dívida remontando até 2010.
- Impacto/riscos a observar:
  - **Banco compartilhado entre instituições**: mesmo risco já documentado na criação do CPA — o Postgres do Edubox é usado por ~32 outras instituições. Toda query em `cobranca.js` faz `INNER JOIN` até `tac_curso` (`tfi_ctreceber → tac_matricula → tac_turma → tac_curso`), inclusive em `/semestres` e `/acoes/importar-csv`. Não trocar por `LEFT JOIN` nem remover achando redundante.
  - **`semctr` inconsistente**: o mesmo semestre aparece gravado ora como `"2026/2"`, ora como `"2026-2"` no Edubox. O filtro (`condicaoSemestre` em `cobranca.js`) normaliza barra↔traço dos dois lados antes de comparar, e `/semestres` já devolve só a forma com `/` (deduplicada) — se algum dia trocar essa lógica, testar com um curso que tenha as duas variantes (ex.: qualquer parcela vencida de 2026.2).
  - **Controle jurídico é só do Órbita Fatec**: conferido em `information_schema` — o Edubox não tem nenhuma tabela/coluna de advocacia/processo judicial. Todo o histórico de "enviado à advocacia"/"acordo judicial" fica na coleção Firestore `financeiro_cobranca_acoes`, sem nenhuma tentativa de inferir isso do lado do Edubox.
  - **Importação CSV sem CPF fica sem vínculo automático**: `POST /acoes/importar-csv` só acha o `codcli` no Edubox quando a planilha traz CPF; sem CPF, o registro é salvo mesmo assim (com `codcli: null`, pelo nome digitado), mas não aparece automaticamente ligado a nenhum aluno na lista principal — só via busca manual.
  - **Dado sensível (LGPD)**: nome, CPF, contato e situação financeira de aluno. Mesmo cuidado já registrado no módulo Ferida — não expor CPF completo desnecessariamente, e o acesso já fica restrito aos mesmos cargos financeiros que veem Licitação/Orçamento.
  - **Pool de 5 conexões**: `/parcelas` exige curso ou semestre selecionado antes de rodar (erro 400 sem isso) — evita que a tela sem filtro nenhum martele o pool compartilhado do Edubox.
- Como testar: Logar como `financeiro`; abrir "Cobrança" (categoria Financeiro); escolher um curso ou semestre e clicar em "Buscar"; conferir que os dias de atraso batem com o vencimento mostrado; abrir o histórico de um aluno e registrar uma ação de teste (ex.: "Enviado à advocacia" com um nome de escritório fictício); conferir que vira badge na listagem; testar "Importar advocacia (CSV)" com um arquivo pequeno (`nome,cpf,escritorio` no cabeçalho); logar como `adm_l2`, `ti` ou `coordenador` e confirmar que "Cobrança" não aparece no menu (só `financeiro` — e `adm_l1` via bypass de Super Admin, se acessar a URL direto).
- Como reverter: `git revert` deste commit remove os arquivos e os registros de permissão (as credenciais do Edubox no `.env` real não são tocadas pelo revert, já que não ficam versionadas — remover manualmente se for realmente desligar o módulo).

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

## 8. Integração com o Edubox — SEMPRE pelo relay

### ⚠️ REGRA OBRIGATÓRIA
O Postgres do Edubox (sistema acadêmico, fornecedor terceiro) **só aceita conexão do IP da Fatec**. O Órbita roda no Vercel, que usa IP dinâmico e **nunca** alcança o Edubox. Por isso existe um **relay HTTP** num servidor de IP fixo, já autorizado pelo fornecedor. Todo dado novo do Edubox passa por ele.

**Proibido em código novo** (vale pra gente e pra IA):
- Importar `src/db-edubox.js` ou abrir conexão `pg` direto no Edubox.
- Criar script, "agente", `.vbs` no Startup do Windows ou tarefa agendada pra rodar num PC da Fatec buscando dado do Edubox.
- Criar sync Edubox → Firestore só pra contornar o bloqueio de IP.
- Colocar credencial do Postgres do Edubox no `.env` do Órbita.

### Onde fica
- **Servidor**: droplet DigitalOcean `162.243.68.10`, porta `8443`. Acesso pelo painel da DigitalOcean → droplet → **Web Console**.
- **Código**: `/opt/edubox-relay/server.mjs` (Node puro + `pg`, sem Express), com credenciais em `/opt/edubox-relay/.env`. Serviço systemd `edubox-relay` (roda como usuário `relay`, `Restart=always`).
- **Compartilhado com o SIGMA** (outro sistema da Fatec). As rotas do SIGMA usam `RELAY_TOKEN`; uma ferramenta parceira usa `PARCEIRO_TOKEN`; o Órbita usa o **próprio** `ORBITA_TOKEN`. Cada token é revogável sem afetar os outros. **Nunca altere rota, token ou função existente do SIGMA: só acrescente.**

### Como o Órbita chama o relay
- Variáveis no `.env` local **e** no Vercel: `EDUBOX_RELAY_URL` (`http://162.243.68.10:8443`) e `EDUBOX_RELAY_TOKEN` (= `ORBITA_TOKEN` do relay). Os nomes ficam documentados em `.env_exemplo`; o valor nunca vai pro Git.
- No backend, use `fetch` com `Authorization: Bearer <EDUBOX_RELAY_TOKEN>`. Use o cliente compartilhado `src/utils/edubox-relay.js` (`const { relay } = require('../utils/edubox-relay')`), que já trata tempo-limite e erro. Não crie outro.
- **Divisão de responsabilidade**: o relay só consulta e devolve dado quase cru. Agregação, classificação, escopo por cargo (RBAC) e formatação ficam no backend do Órbita, onde dá pra revisar e mudar sem mexer no servidor compartilhado.

### Como adicionar rota nova no relay
1. Faça backup antes: `cp /opt/edubox-relay/server.mjs /opt/edubox-relay/server.mjs.bak-<motivo>`.
2. Acrescente (não edite o que existe):
   - a **função de consulta**, antes de `const server = http.createServer(...)`, seguindo o padrão das existentes: `novoClient()` → `connect` → `set search_path=ivp,public;` → queries → `end()`, devolvendo `{ ok, ... }` ou `{ ok: false, erro }`;
   - a **rota**, **antes** do gate geral `if (!autenticado(req))` (mesmo lugar das rotas `/cpa/*`), conferindo `autenticadoOrbita(req)` e usando um prefixo do módulo (`/cadd/*`, `/matrizes/*`...).
3. Valide e reinicie: `node --check /opt/edubox-relay/server.mjs && chown relay:relay /opt/edubox-relay/server.mjs && systemctl restart edubox-relay && systemctl is-active edubox-relay`.
4. Teste no próprio servidor: `curl -s "http://localhost:8443/<rota>" -H "Authorization: Bearer <ORBITA_TOKEN>"`.
5. Registre no changelog (seção 7) o que entrou no relay, já que o código dele não fica neste repositório.

### Cuidados nas consultas
- **Só leitura**: o usuário do banco é `consulta`.
- **Sempre faça `JOIN` até `tac_curso`**: o banco é compartilhado com ~32 outras instituições da região, e é esse join que garante que só entra dado da Fatec.
- Achados de schema que já custaram tempo:
  - **Nome do aluno**: `tac_matricula.climat` → `tfi_cliente.codcli` → `nomcli`. `tac_aluno` não tem nome, e `alumat` é o RA, não chave.
  - **Professor da disciplina** (avaliação dos alunos): `tav_nota_historico_aluno.pronot` / `tav_resp_historico_aluno.prores` → `tac_professor.codpro` → `trh_funcionario.nomfun`. **Não** use `tac_disciplina_turma.prodtu`: vem zerado.
  - Um professor tem vários `codpro` (um por vínculo); a pessoa é `tac_professor.funpro`.
  - A participação na CPA fica em `tav_participacao` (`dtipar` = iniciou, `datpar` = concluiu); `tav_aplica` diz quais turmas a campanha atinge.

### O que já usa o relay e o que falta migrar
- ✅ **Relatório CPA**: rotas `/cpa/campanhas`, `/cpa/cursos`, `/cpa/relatorio-aluno`, `/cpa/relatorio-staff`, `/cpa/participacao`, `/cpa/participacao-detalhe`, `/cpa/direcao` (Relatório da Direção: campanha inteira já agregada — distribuição por opção de cada pergunta, nota média por dimensão, comentários e respondentes).
- ✅ **Confirmação de Presença**: rota `/confirmacao/professores-ativos`.
- ✅ **Matrizes**: rotas `/matrizes/semestres` e `/matrizes/dados`, consulta ao vivo. A montagem por curso fica em `src/utils/matrizes-montar.js`. O horário dos coordenadores continua em `matrizes_grade` (Firestore).
- ✅ **CADD** e **Cobrança**: continuam gravando no Firestore (telas leem de lá), mas os agentes rodam no **servidor do relay** como serviços, não mais no PC da Fatec — ver abaixo.

### Agentes que rodam no servidor (CADD e Cobrança)
CADD e Cobrança fazem consultas pesadas com horário fixo de atualização, então não consultam o Edubox a cada tela: um agente atualiza o Firestore. Esse agente é o mesmo código do repositório (`scripts/cad-edubox-agente.js` e `scripts/cobranca-edubox-agente.js`) e roda **no mesmo droplet do relay**, que tem o IP autorizado — por isso pode usar `src/db-edubox.js` (é o único lugar onde isso é permitido).
- **Pasta**: `/opt/orbita-sync` (clone do repositório público `Fatec-Ivaipora/Orbita_Fatec`), com `.env` próprio (só as variáveis `EDUBOX_*`) e `serviceAccountKey.json` do Firebase. Roda como usuário `orbita`.
- **Serviços systemd**: `orbita-cad-agente` (CADD: 9h, 10h, 11h, 16h e botão "Atualizar agora") e `orbita-cobranca-agente` (Cobrança: 7h, 12h, 17h, 22h, botão e histórico semanal de noite). Ambos com `TZ=America/Sao_Paulo` (o servidor fica em UTC; sem isso os horários saem 3h adiantados) e `Restart=always`.
- **Atualizar o código dos agentes** depois de um merge no `main`: `cd /opt/orbita-sync && sudo -u orbita git pull && sudo -u orbita npm ci --omit=dev && systemctl restart orbita-cad-agente orbita-cobranca-agente`.
- **Ver o que estão fazendo**: `journalctl -u orbita-cad-agente -n 50` (ou `orbita-cobranca-agente`); também gravam em `/opt/orbita-sync/scripts/logs/`. A tela de cada módulo mostra "Atualização automática fora do ar" se o agente ficar mais de 15 min sem sinal (`config/cad_sync.agenteVivoEm` / `config/cobranca_sync.agenteVivoEm`).
- **Nunca** rode esses agentes em outro lugar ao mesmo tempo (PC, notebook): dois agentes gravando juntos duplicam o histórico da Cobrança. Os atalhos do PC da Fatec foram removidos em 2026-10-15.

### ⚠️ Pendências conhecidas do relay (levantadas em 2026-10-15, ainda não feitas)
1. **HTTPS no relay (prioridade).** Hoje `EDUBOX_RELAY_URL` é `http://162.243.68.10:8443`: o token e os dados que o relay devolve (inclusive nomes de alunos e professores) trafegam **sem criptografia** entre o Vercel e o servidor. O SIGMA usa o mesmo endereço. Plano:
   - instalar o **Caddy** no droplet (certificado Let's Encrypt automático), repassando para `localhost:8443`; o código do relay não muda;
   - trocar `EDUBOX_RELAY_URL` no Vercel do Órbita para o endereço `https://`;
   - pedir ao responsável pelo SIGMA que troque o dele;
   - só então fechar a porta `8443` para fora (firewall `ufw`).
   - **Decisão pendente:** o nome do servidor — (a) subdomínio da Fatec, ex. `relay.fatecivaipora.com.br` (registro DNS tipo A → `162.243.68.10`, pedido a quem administra o domínio), ou (b) nome automático `162-243-68-10.sslip.io` (imediato, mas depende de um serviço de terceiros).
2. **Backup automático do droplet** (~US$ 1,20/mês). O servidor é ponto único de falha: se cair, param CPA, Matrizes, Confirmação de Presença, as atualizações do CADD e da Cobrança, e o SIGMA.
3. **Atualizações do Ubuntu** pendentes no droplet. Ele guarda a chave do Firebase (acesso total ao banco do Órbita) e a senha do Edubox.
4. **Versionar o código do relay** (`/opt/edubox-relay`, sem o `.env`) num repositório Git privado. Hoje ele só existe no servidor, com cópias `server.mjs.bak-*`, e não tem revisão do que cada um muda.
5. **Capacidade do servidor** (1 GB de memória, 1 processador): durante a atualização do CADD sobram ~330 MB e ela leva ~100s. Se mais coisa for para lá, avaliar o plano de 2 GB.

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






### [2026-10-06] Novo módulo Matrizes e Horários (Docência)
- **Finalidade**: acompanhar as matrizes curriculares dos cursos (fonte: Edubox) e montar o horário de aula de cada curso. O coordenador define professor, dia e hora das disciplinas do próprio curso; o horário de aula sai em relatório padronizado Fatec IVP (aba "Horário de aula", imprime/PDF).
- **Quem vê o quê**: ADM N1/N2 e RH veem e editam todos os cursos; qualquer outro cargo (coordenador) só vê os cursos do próprio cadastro (`users.cursos`, definidos em Usuários). Escopo imposto no backend (`src/rotas/matrizes.js`), não só na tela.
- **Edubox -> Órbita**: `scripts/matrizes-edubox-sync.js` roda num PC da Fatec (o Edubox só aceita o IP da Fatec), só LÊ o Edubox e grava em `matrizes_edubox/{AAAA.S}__{cursoId}`. Uso: `node scripts/matrizes-edubox-sync.js [AAAA.S] [--dry] [--detalhe]`. Sem argumento sincroniza o semestre atual + 2 próximos.
- **Qual matriz a turma segue**: a que o Edubox vincula à turma (`tac_turma.gratur`). Um curso tem várias matrizes rodando ao mesmo tempo (ex.: Contábeis, 6) e o NOME da matriz não bate com o semestre de ingresso da turma — por isso a tela mostra o vínculo do Edubox e não tenta "adivinhar" a matriz certa pelo nome. A única conferência automática é: disciplinas lançadas na turma x disciplinas do período da matriz da turma (turma marcada "conferir" quando diferem).
- **Coleções Firestore**: `matrizes_edubox` (só o script grava), `matrizes_grade/{AAAA.S}__{cursoId}` (horários definidos na tela: `alocacoes["{codTurma}:{codDisciplina}"] = { aulas: [{professor, dia, inicio, fim}] }`) e `config/matrizes_sync`.
- **Conflito de horário**: o mesmo professor (nome normalizado) com horários que se sobrepõem no mesmo dia, em qualquer curso do semestre, gera aviso ao salvar (não bloqueia).
- **Frontend**: `/matrizes` (abas Semestre por turma, Matrizes em uso com comparação entre duas matrizes, Horário de aula). Registrado em `MODULES` (categoria `docencia`, id `matrizes`).

### [2026-10-06] Matrizes e Horários — regra de horário e carga inicial de 2026.2
- **Horário padrão da Fatec (noturno)**: aula presencial das **19:30 às 22:30** (intervalo incluído). Aula **EAD** são blocos de **1 hora**, até 3 por noite: 19:30–20:30, 20:30–21:30 e 21:30–22:30. O modal de horário tem botões de atalho com esses horários.
- **Carga inicial de 2026.2**: 416 disciplinas receberam professor/dia/hora a partir das grades em PDF/DOC de 5/10 (Agronomia, Agronegócio, Arquitetura, Biomedicina, Contábeis, Direito, Enfermagem, Eng. Civil, Fisioterapia, Gestão Comercial/Financeira, MedVet, Pedagogia, Psicologia, RH). Gravada com `atualizadoPor.uid = "importacao-grades-2026-2"` e sem sobrescrever horários já definidos na tela. Faltou **Medicina** (sem grade) — conferência completa em `Claude outputs/horarios-2026-2-conferencia.md`.
- **Turmas "gêmeas" no Edubox**: turmas de períodos diferentes podem ter exatamente as mesmas disciplinas (Enfermagem 1º=2º, 3º=4º...; Biomedicina 3º=4º). A grade do PDF ("2º período") vale para as duas, então o horário foi gravado nas duas.

### [2026-10-07] Matrizes e Horários — matriz rotativa (grupos de turmas)
- **Matriz rotativa**: quem entra no meio do ano estuda junto com a turma do período seguinte, e no ano seguinte segue a própria matriz. No Edubox são turmas diferentes com as mesmas disciplinas; na Fatec é uma turma só ("Agronomia 1 e 2 – 2026/2"). **Cada turma continua com a própria matriz** (aparece em etiqueta no bloco); só o horário de aula é unificado.
- **Tecnólogos e Agronegócio**: todos os períodos estudam as mesmas disciplinas → um grupo só ("RH 1 ao 4 – 2026/2"). Turmas de dependência (DP/ADP) ficam sozinhas.
- **Como o grupo é definido**: primeiro pelos arquivos de horário (o título lista os períodos juntos; guardado em `matrizes_grade/{AAAA.S}__{cursoId}.grupos = [{ periodos: [1,2] }]`); depois, onde o arquivo não diz (ex.: Enfermagem: o PDF fala do "2º período", o Edubox tem o 1º igual, ou semestres sem PDF), por **pares de períodos vizinhos** com ≥60% das mesmas disciplinas. Cada turma entra em no máximo um par (nunca "1 ao 3"); o par muda de semestre para semestre (2026.2: 1-2, 3-4; 2027.1 em Psicologia/Direito/Pedagogia: 2-3, 4-5, 6-7) e, no empate, prefere 1-2 / 3-4. Os grupos de semestres sem PDF são inferidos e devem ser conferidos.
- **Horário do grupo**: o modal grava o mesmo horário em todas as turmas do grupo (uma chamada por turma). O aviso de conflito ignora a mesma disciplina com o mesmo professor (aula conjunta) e separa "conflito" (sobreposição parcial) de "mesmo horário exato" (provável aula conjunta).

### [2026-10-07] Matrizes e Horários — ensalamento (salas)
- **Fonte das salas**: o documento "Ensalamento FATEC IVP — 2026.2" (sistema de ensalamento da Fatec). Por grupo de turmas e dia: sala (Presencial), EAD, Protegida, Síncrona Mediada ou Estágio. É a fonte oficial dos **grupos de turmas que estudam juntas** (títulos "1 e 2", "3 e 4", "2,3,4,5 e 6") e das salas; prevalece sobre o PDF de horário quando divergem.
- **Dados**: `matrizes_grade/{AAAA.S}__{cursoId}.ensalamento = [{ turma, periodos, alunos, dias: { seg: { tipo, sala }, ... } }]` e `.grupos` (oficiais). Cada aula presencial ganha `sala` (`alocacoes[...].aulas[].sala`); aulas EAD/síncronas/estágio ficam sem sala.
- **Edição**: o modal de horário tem o campo **Sala** (com lista das salas conhecidas); a sala editada na tela nunca é sobrescrita por nova importação.
- **Conflito de sala**: ao salvar, a API avisa quando a mesma sala (comparação sem pontuação/caixa: "M.A.1" = "M.A. 1") já está ocupada no mesmo dia e horário por outra disciplina/professor (`tipo: "sala"`). A mesma disciplina em turmas do mesmo grupo não conta como conflito.

### [2026-10-07] Matrizes e Horários — carga horária por matriz e síncrona mediada
- **Aula síncrona mediada** (ao vivo, mediada por tecnologia) existe no Edubox: coluna `tac_disciplina.chosmedis` (101 disciplinas "A Distância", ~6.280 h). Antes de ler essa coluna essas disciplinas apareciam com todas as modalidades zeradas. Agora `ch.sincrona` vem do sync (`scripts/matrizes-edubox-sync.js`), a tela mostra a etiqueta "Síncrona mediada" e a coluna "Sínc." e o relatório de horário traz a modalidade "Síncrona mediada". No ensalamento aparece como "Síncrona Mediada" (sem sala).
- **Modalidades da carga horária** (por disciplina): `choteodis` = presencial (teórica), `chopradis` = prática, `choeaddis` = EAD, `chosmedis` = síncrona mediada, `choextdis` = extensão; `chtdis` = total. Com as cinco, 5.847 de 5.853 disciplinas fecham com o total.
- **Aba "Carga horária por matriz"**: por matriz em uso, totais por modalidade (horas e % do total das disciplinas), total das disciplinas, e **carga horária total da matriz** (`tac_grade.chogra`), que é onde o total geral fecha. Mostra também a diferença quando existe: "Fora das disciplinas" (CH da matriz − soma das disciplinas; ex.: atividades complementares) e "Sem modalidade definida no Edubox" (disciplinas cuja soma das modalidades ≠ total; ex.: PIE de RH/Gestão Comercial com 60 teórica + 60 extensão = 120 h, mas total 140 h). Tem detalhe por período, impressão (PDF) e CSV (`;`, UTF-8 com BOM).

### [2026-10-07] Novo módulo: Relatório CPA (Docência) — resultado da avaliação por curso e por professor
- **Finalidade**: relatório da CPA 2026/2 (alunos) aplicada no Edubox, em **Graduação** (cursos de graduação, exceto Medicina) e **Medicina**, por curso, visão geral da IES e **por professor** (todos). PDF do relatório institucional (com capa e metodologia), do curso, de cada professor e de todos os professores do curso. Substitui o módulo CPA removido em 08/2026 (reaproveita o classificador de comentários).
- **Princípio**: o relatório **bate com o que foi aplicado** — mesmas dimensões (numeração e nomes do Edubox, agrupadas nos 5 eixos do SINAES), mesmas perguntas e opções (1 Ótimo, 2 Bom, 3 Regular, 4 Ruim, 5 Não sei), com a contagem de cada opção. Nada de índice inventado: "satisfação" = (Ótimo + Bom) ÷ (Ótimo + Bom + Regular + Ruim), "Não sei" fica fora da base; "nota 0–10" é a que o próprio aluno atribuiu (notnot), valores fora de 0–10 são ignorados. (O módulo antigo calculava média incluindo o 5 "Não sei": errado.)
- **Dados**: `scripts/cpa-edubox-sync.js` (roda num PC da Fatec; o Edubox só aceita o IP da Fatec) lê o Edubox e grava **agregado e sem identificação de aluno** no Firestore: `cpa_ciclos/{semestre-segmento}`, `cpa_relatorios/{codava}__{curso|IES}`, `cpa_professores/{codava}__{curso}__{codpro}`. Uso: `node scripts/cpa-edubox-sync.js [codava...] [--dry]` (sem argumentos: último ciclo de GRA e de MED). Campanha de Medicina tem semestre no formato "2026-1" e "MEDICINA" na descrição; **em 07/10 não existia campanha de Medicina 2026/2 no Edubox** (a última é a 74, 2026-1).
- **Reconciliação** (conferida em 07/10): 49/49 perguntas de GRA e 33/33 de MED com distribuição idêntica à contagem direta no Edubox (87.031 e 23.262 respostas); soma dos cursos = total da IES; avaliações por dimensão e respostas por professor idênticas.
- **Professor**: cada nota por disciplina já traz o professor (`tav_nota_historico_aluno.pronot`, `tav_resp_historico_aluno.prores`). "Estudantes que avaliaram" = alunos×disciplina distintos (cada aluno dá uma nota por dimensão, então notas ≠ estudantes). Menos de 5 estudantes = marcado como pouco confiável. A marca preta nas barras é a satisfação (ou nota) do curso, para comparar.
- **Quem vê o quê** (`src/rotas/cpa.js`): adm_l1/adm_l2 veem tudo (inclusive "todos os professores" e comentários da IES) e editam os dados da capa; coordenador só os cursos do próprio cadastro (`users.cursos`); coord_medicina só Medicina; a visão da IES para coordenador vem sem comentários.
- **Comentários**: classificação automática (bom / neutro / atenção) por palavras-chave em `src/utils/cpa-comentarios.js`; só organiza a leitura. Corrigido em 07/10: "não tem" só conta como "sem reclamação" em comentário curto (antes um comentário crítico longo virava elogio).
- **Pendente para o relatório institucional completo ao MEC**: incluir os resultados de **Docentes** (campanha 78, ainda aberta em 07/10) e **Administrativo** (77), e o eixo/dimensão 3 e 10 (responsabilidade social, sustentabilidade financeira), que não estão no questionário de alunos. Composição da CPA e portaria entram em "Dados da capa".

### Relatório CPA — professores unificados, Docentes e Administrativo (2026-10-07)
- Professor = pessoa (`tac_professor.funpro`), unificado dentro de cada curso: um professor com várias disciplinas aparece uma vez, com desempenho e comentários separados por disciplina (cada comentário diz de qual disciplina vem). GRA 2026/2: 109 pessoas, 156 combinações professor×curso.
- `cpa_relatorios` agora tem `publico` (A alunos, P docentes, O funcionários). Docentes/Administrativo e a avaliação de curso/coordenador só para adm_l1/adm_l2 (a rota devolve 403 aos demais).
- Funcionários: o universo não existe no Edubox (63 cadastros sem cargo); mostramos respondentes por cargo cadastrado. Docentes: universo = professores avaliados pelos alunos no ciclo.
- PDF "Relatório institucional completo" = capa + quadro consolidado por dimensão (alunos × docentes × funcionários) + relatório de cada público. Conferido contra o Edubox: 0 divergências (campanhas 75, 77, 78).
- Cuidado: scripts Python no Windows gravam CRLF; converter para LF após patch.
