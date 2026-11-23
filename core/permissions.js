export const CATEGORIES = {
  ti: "Gestão de T.I.",
  admin: "Administrativo",
  docencia: "Docência",
  saude: "Gestão Saúde",
  secretaria: "Secretaria",
  financeiro: "Financeiro",
  medicina: "Medicina",
  comercial: "Comercial",
  ead: "EAD"
};

export const MODULES = {
  dashboard: {
    id: "dashboard",
    title: "Meu Espaço",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    url: "/meu-espaco/index.html"
  },
  fidelidade: {
    id: "fidelidade",
    title: "Cartão FATEC",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2" ry="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>`,
    url: "/fidelidade/index.html"
  },
  emprestimo: {
    id: "emprestimo",
    category: "ti",
    title: "Empréstimos",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    url: "/emprestimo/index.html"
  },
  // Automação AVA (26/10/2026) — disciplinas EAD do semestre (Edubox), criação das novas (etapas,
  // professor, titulação/pagamento, avaliações) e, depois, os arquivos do Conduit (auth/course/enroll).
  "automacao-ava": {
    id: "automacao-ava",
    category: "ti",
    title: "Automação AVA",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><path d="M8 10l2.5 2.5L16 7"/></svg>`,
    url: "/ti/automacao-ava/index.html"
  },
  // Aulas EAD (18/11/2026) — salas Zoom, disciplinas EAD do semestre (dia/horário/professor), grade da semana
  // (mesmo link pro mesmo professor) e controle das gravações das UAs (gravou/baixou/YouTube/AVA).
  "ead-aulas": {
    id: "ead-aulas",
    category: "ti",
    title: "Aulas EAD",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3"/></svg>`,
    url: "/ti/ead-aulas/index.html"
  },
  // Financeiro Medicina (18/11/2026) — rematrícula da Medicina: contrato mãe, mensal do acordo, saldos e reajuste
  // por turma. SÓ os usuários de somenteUsuarios veem (Lisa e Fábio Costa) — nem outros ADM N1. A rota
  // (src/rotas/financeiro-medicina.js, USUARIOS_PERMITIDOS) barra os outros. Incluir alguém só quando pedirem.
  // Calendário Acadêmico (23/11/2026) — o diretor acadêmico (Roni) e a ajudante (Thalia) montam o calendário do
  // semestre (copiam um anterior do Edubox e ajustam); publicado, vai pra Agenda Interna e pro site novo.
  // SÓ os usuários de somenteUsuarios veem (nem outros ADM N1). A rota (src/rotas/calendario-academico.js,
  // USUARIOS_PERMITIDOS) barra os outros. Incluir alguém só quando pedirem.
  "calendario-academico": {
    id: "calendario-academico",
    category: "docencia",
    title: "Calendário Acadêmico",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>`,
    url: "/docencia/calendario-academico/index.html",
    somenteUsuarios: ["M5GxyogXA9d6aAIBOaKmU9Pjkwk1", "WmDuym3nSRemrNVMZFrNvd8232I2", "rhQ6fe4HQfMOCCejry1sPx0hA1v1", "rSw36LAa8fPI94aYFoVv7JggB6w2"] // Roni, Thalia, Paulo henrique e Administrador
  },
  "financeiro-medicina": {
    id: "financeiro-medicina",
    category: "financeiro",
    title: "Financeiro Medicina",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
    url: "/financeiro/medicina/index.html",
    somenteUsuarios: ["A6gsjqRTwdeAy29KVxcHJg2jYNy2", "EtrSfFo1FCYD6ZZOFQ6AL25axWX2", "rhQ6fe4HQfMOCCejry1sPx0hA1v1", "rSw36LAa8fPI94aYFoVv7JggB6w2"] // Lisa, Fábio, Paulo henrique e Administrador — todos editam
  },
  acessos: {
    id: "acessos",
    category: "ti",
    title: "Acessos",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    url: "/ti/acessos/index.html"
  },
  usuarios: {
    id: "usuarios",
    category: "admin",
    title: "Usuários",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    url: "/usuarios/index.html"
  },

  empresas: {
    id: "empresas",
    category: "admin",
    title: "Parceiros",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M3 7v14M21 7v14M6 21V7M18 21V7M9 7h6M9 11h6M9 15h6M9 19h6"/></svg>`,
    url: "/empresas/index.html"
  },
  ferida: {
    id: "ferida",
    category: "saude",
    title: "Ferida",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.42 4.58a5.4 5.4 0 0 0-7.65 0l-.77.78-.77-.78a5.4 5.4 0 0 0-7.65 0C1.46 6.7 1.33 10.28 4 13l8 8 8-8c2.67-2.72 2.54-6.3.42-8.42z"/><polyline points="7 12 9.5 12 11 9.5 13 14.5 14.5 12 17 12"/></svg>`,
    url: "/saude/ferida/index.html"
  },
  "almoxarifado-feridas": {
    id: "almoxarifado-feridas",
    category: "saude",
    title: "Almoxarifado Feridas",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8L12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>`,
    url: "/saude/almoxarifado-feridas/index.html"
  },
  "almoxarifado-saude": {
    id: "almoxarifado-saude",
    category: "saude",
    title: "Almoxarifado Saúde",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 22V12h6v10"/><path d="M14 2H8a2 2 0 0 0-2 2v6l-3 3v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7l-3-3V4a2 2 0 0 0-2-2z"/></svg>`,
    url: "/saude/almoxarifado-saude/index.html"
  },
  "relatorio-dp": {
    id: "relatorio-dp",
    category: "secretaria",
    title: "Relatório DP",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>`,
    url: "/secretaria/relatorio-dp/index.html"
  },
  licitacao: {
    id: "licitacao",
    category: "financeiro",
    title: "Licitação",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
    url: "/financeiro/licitacao/index.html"
  },
  matriculas: {
    id: "matriculas",
    category: "financeiro",
    title: "Relatório Matrículas",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c0 2 2 3 6 3s6-1 6-3v-5"/></svg>`,
    url: "/financeiro/matriculas/index.html"
  },
  orcamento: {
    id: "orcamento",
    category: "financeiro",
    title: "Orçamento",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`,
    url: "/financeiro/orcamento/index.html"
  },
  "avaliacao-docente": {
    id: "avaliacao-docente",
    category: "docencia",
    title: "Avaliação Docente",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
    url: "/avaliacao-docente/index.html"
  },
  cobranca: {
    id: "cobranca",
    category: "financeiro",
    title: "Cobrança",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/><line x1="4.9" y1="4.9" x2="7" y2="7"/></svg>`,
    url: "/financeiro/cobranca/edubox.html"
  },
  "banco-med-fatec": {
    id: "banco-med-fatec",
    category: "medicina",
    title: "Banco de Questões",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/></svg>`,
    url: "/banco-med-fatec/index.html"
  },
  // Aplicação de provas da Medicina (16/11/2026): calendário de provas das turmas, professores aplicadores,
  // laboratórios, apoio e NAPA. Edita: coordenação de Medicina (inclui a secretaria acadêmica), a responsável
  // pelas avaliações (CADAM) e ADM; professor de Medicina só lê, com as aplicações dele destacadas.
  "aplicacao-provas-med": {
    id: "aplicacao-provas-med",
    category: "medicina",
    title: "Aplicação de Provas",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M9 16l2 2 4-4"/></svg>`,
    url: "/medicina/aplicacao-provas/index.html"
  },
  // Análise psicométrica das provas do AVA (Open LMS): o docente sobe o
  // export de "Estatísticas do questionário" e recebe o relatório de
  // facilidade/discriminação por questão, pronto pra imprimir.
  "relatorio-desempenho": {
    id: "relatorio-desempenho",
    category: "medicina",
    title: "Relatório Desempenho",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>`,
    url: "/medicina/relatorio-desempenho/index.html"
  },
  // Matrizes dos cursos (vêm do Edubox) + horário de aula por curso: o
  // coordenador define professor/dia/hora das disciplinas do próprio curso;
  // ADM (N1/N2) e RH veem e editam todos os cursos. Escopo imposto no backend
  // (src/rotas/matrizes.js).
  matrizes: {
    id: "matrizes",
    category: "docencia",
    title: "Matrizes e Horários",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`,
    url: "/matrizes/index.html"
  },

  // Relatório da CPA (Comissão Própria de Avaliação): resultado da avaliação de alunos, docentes e
  // administrativo aplicada no Edubox, por curso/dimensão/disciplina. Direção (adm_l1/adm_l2) vê tudo
  // (inclusive administrativo); coordenador/coord_medicina só os próprios cursos (alunos e docentes).
  // Dados ao vivo via relay (EDUBOX_RELAY_URL/TOKEN no .env) — sem cache/sync no Firestore desde
  // 2026-10-14 (substituiu o módulo anterior, que usava scripts/cpa-edubox-sync.js). Ver regra_do_app.md.
  cpa: {
    id: "cpa",
    category: "docencia",
    title: "Relatório CPA",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6"/><rect x="12" y="8" width="3" height="10"/><rect x="17" y="5" width="3" height="13"/></svg>`,
    url: "/cpa/index.html"
  },
  // CADD — Conselho Acadêmico de Desempenho Discente: nota e faltas por bimestre de cada aluno (Edubox),
  // filtros de alunos em atenção, observação do coordenador e ata. Mesmo acesso do Relatório CPA.
  // Dados vêm de scripts/cad-edubox-sync.js (Firestore cad_*).
  cad: {
    id: "cad",
    category: "docencia",
    title: "CADD — Desempenho Discente",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>`,
    url: "/cad/index.html"
  },
  // Correção de Provas — folha de respostas por aluno e leitura pela câmera do celular (como o Evalbee).
  // Turmas e alunos vêm do CADD; gabarito digitado ou do Banco de Provas / Banco MED-FATEC.
  // Só coordenador e direção (aluno e professor não usam).
  "correcao-provas": {
    id: "correcao-provas",
    category: "docencia",
    title: "Correção de Provas",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9" cy="9" r="1.6"/><circle cx="9" cy="14.5" r="1.6"/><path d="M13 9h4M13 14.5h4"/></svg>`,
    url: "/correcao-provas/index.html"
  },
  // Trilha EAD (19/10/2026) — livro de notas do AVA (unidades SAGAH): participação, ranking por curso
  // e arquivo Nome;Nota da Trilha EAD (0 a 3.0) pro EAD lançar no Edubox. EAD importa; coordenador só vê o curso dele.
  "trilha-ead": {
    id: "trilha-ead",
    category: "docencia",
    title: "Trilha EAD",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16"/><path d="M6 15l4-4 3 3 5-6"/><circle cx="18" cy="8" r="1.4"/></svg>`,
    url: "/docencia/trilha-ead/index.html"
  },
  // Levantamento EaD (23/11/2026) — disciplinas EAD do semestre (dia, horário, professor) editadas pelo EAD na
  // MESMA lista da Aulas EAD do T.I (aviso pro T.I a cada mudança), tutor de cada curso, relatório por curso/professor
  // com a sala Zoom do professor e mensagem pronta, e o Cronograma EaD de cada disciplina.
  "levantamento-ead": {
    id: "levantamento-ead",
    category: "docencia",
    title: "Levantamento EaD",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/><path d="M7 13h4M7 17h7"/></svg>`,
    url: "/docencia/levantamento-ead/index.html"
  },
  // Plano de Ação dos Coordenadores (21/10/2026) — atividades diárias/semanais/mensais/semestrais do
  // coordenador, com datas do calendário acadêmico do Edubox; Direção (ADM) acompanha por coordenação.
  "plano-acao": {
    id: "plano-acao",
    category: "docencia",
    title: "Plano de Ação",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8l1.5 1.5L12 7"/><path d="M8 14l1.5 1.5L12 13"/><path d="M14.5 8.5H17M14.5 14.5H17"/></svg>`,
    url: "/docencia/plano-acao/index.html"
  },
  // Formulários (12/11/2026): a Direção cria e manda o link; o aluno responde sem login (/formulario/?t=)
  "formularios": {
    id: "formularios",
    category: "docencia",
    title: "Formulários",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>`,
    url: "/docencia/formularios/index.html"
  },
  "banco-provas": {
    id: "banco-provas",
    category: "docencia",
    title: "Banco de Provas",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
    url: "/docencia/banco-provas/index.html"
  },
  // Controle de assinatura de contrato dos matriculados (planilha "MATRÍCULAS
  // FATEC - CONTROLE DE ASSINATURA" do Comercial) — todo o setor vê e edita.
  contratos: {
    id: "contratos",
    category: "comercial",
    title: "Contratos",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M8 17c1.5-2 2.5-2 3.5 0s2 2 4.5-1"/></svg>`,
    url: "/comercial/contratos/index.html"
  },
  // Agenda de aula experimental (quem vem conhecer o curso antes de se
  // matricular) — com mensagens prontas pro professor e pro aluno.
  "aula-experimental": {
    id: "aula-experimental",
    category: "comercial",
    title: "Aula Experimental",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><polyline points="9 16 11 18 15 14"/></svg>`,
    url: "/comercial/aula-experimental/index.html"
  },
  // Agenda única de aulões/redações e palestras (04/11/2026 — antes eram dois
  // módulos). A tela junta comercial_auloes e comercial_palestras.
  auloes: {
    id: "auloes",
    category: "comercial",
    title: "Aulões - Palestras",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    url: "/comercial/auloes/index.html"
  },
  // Palestras: desde 04/11/2026 ficam na tela "Aulões - Palestras". O módulo
  // continua existindo pra permissão da rota /api/palestras, mas não aparece no
  // menu (menu: false) e o endereço antigo redireciona.
  palestras: {
    id: "palestras",
    category: "comercial",
    menu: false,
    title: "Palestras (na agenda Aulões - Palestras)",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    url: "/comercial/palestras/index.html"
  },
  // Agenda de espaços (auditório e salas) — Secretaria e ADM editam, todo
  // mundo consulta e pode pedir reserva.
  "agenda-espacos": {
    id: "agenda-espacos",
    category: "secretaria",
    title: "Agenda Interna Fatec IVP",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><path d="M8 14h3v3H8z"/></svg>`,
    url: "/secretaria/agenda-espacos/index.html"
  },
  "confirmacao-evento": {
    id: "confirmacao-evento",
    category: "docencia",
    title: "Confirmação de Presença",
    icon: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/></svg>`,
    url: "/docencia/confirmacao-evento/index.html"
  }
};

export const ROLE_PERMISSIONS = {
  // "Cobrança" (inadimplência) é exclusivo do cargo Financeiro — não entra
  // aqui nem no ADM N2, a pedido do usuário (31/08). Fica de fora do menu
  // lateral e da grade padrão de Gerência de Acessos pra esses cargos;
  // ADM N1 continua com bypass total no backend (`requireModulePermission`
  // sempre libera `adm_l1`, é assim pra todo módulo do sistema, não dá pra
  // restringir só pra este) — se algum dia isso mudar, revisar aqui também.
  adm_l1: {
    label: "ADM N1",
    modules: ["dashboard", "fidelidade", "emprestimo", "usuarios", "empresas", "ferida", "almoxarifado-feridas", "almoxarifado-saude", "relatorio-dp", "acessos", "licitacao", "matriculas", "orcamento", "avaliacao-docente", "banco-med-fatec", "relatorio-desempenho", "banco-provas", "confirmacao-evento", "contratos", "aula-experimental", "auloes", "palestras", "agenda-espacos", "matrizes", "cpa", "cad", "correcao-provas", "trilha-ead", "plano-acao", "automacao-ava", "ead-aulas", "levantamento-ead", "formularios"]
  },
  adm_l2: {
    label: "ADM N2",
    modules: ["dashboard", "fidelidade", "emprestimo", "usuarios", "empresas", "ferida", "almoxarifado-feridas", "almoxarifado-saude", "relatorio-dp", "licitacao", "matriculas", "orcamento", "avaliacao-docente", "banco-med-fatec", "relatorio-desempenho", "banco-provas", "confirmacao-evento", "contratos", "aula-experimental", "auloes", "palestras", "agenda-espacos", "matrizes", "cpa", "cad", "correcao-provas", "trilha-ead", "plano-acao", "automacao-ava", "ead-aulas", "levantamento-ead", "formularios"]
  },
  ti: {
    label: "T.I.",
    modules: ["dashboard", "fidelidade", "emprestimo", "usuarios", "acessos", "agenda-espacos", "automacao-ava", "ead-aulas", "levantamento-ead"]
  },
  rh: {
    label: "RH",
    modules: ["dashboard", "fidelidade", "agenda-espacos", "matrizes"]
  },
  financeiro: {
    label: "Financeiro",
    modules: ["dashboard", "fidelidade", "licitacao", "matriculas", "orcamento", "cobranca", "agenda-espacos"]
  },
  // Coordenador perdeu acesso à Licitação (18/08) — passou a ser tarefa
  // exclusiva do Financeiro, pra não misturar semestre ativo entre uma
  // licitação em andamento e uma nova sendo montada.
  coordenador: {
    label: "Coordenador",
    modules: ["dashboard", "fidelidade", "avaliacao-docente", "banco-provas", "confirmacao-evento", "agenda-espacos", "matrizes", "cpa", "cad", "correcao-provas", "trilha-ead", "plano-acao", "automacao-ava"]
  },
  // O cargo "Secretaria" foi cadastrado na tela de Usuários com id `sec`
  // (não `secretaria`) — a chave aqui precisa bater com o id real da
  // coleção `roles`, senão o guard de 1º acesso (sem cache ainda no
  // navegador) cai no fallback de "visitante" e bloqueia sem nunca chegar
  // a ler a permissão real do Firestore.
  sec: {
    label: "Secretaria",
    modules: ["dashboard", "fidelidade", "matriculas", "relatorio-dp", "agenda-espacos"]
  },
  // Coordenação da Medicina — só enxerga o Banco de Questões (MED FATEC),
  // nenhum outro módulo administrativo. Cargo dedicado (em vez de dar
  // banco-med-fatec pro cargo "coordenador" geral) pra não vazar acesso
  // pra coordenadores de outros cursos.
  // Tem o Meu Espaço (30/09/2026, pedido da direção); o Cartão FATEC não
  // (ver CARGOS_SEM_CARTAO em core/layout.js).
  coord_medicina: {
    label: "Coordenação Medicina",
    modules: ["dashboard", "banco-med-fatec", "relatorio-desempenho", "aplicacao-provas-med", "agenda-espacos", "cpa", "cad", "correcao-provas"]
  },
  // Professor da Medicina — mesmo acesso do coord_medicina (Meu Espaço +
  // Banco de Questões), cargo separado só pra aparecer com rótulo próprio na
  // tela de Usuários (não misturar professor com coordenador na listagem).
  professor_medicina: {
    label: "Professor Medicina",
    modules: ["dashboard", "banco-med-fatec", "agenda-espacos"] // 16/11/2026: menu Medicina só com o Banco
  },
  // Setor Comercial — por enquanto só o Meu Espaço (Painel do Setor, Quadro
  // de Avisos, atividades). Módulo próprio do comercial ainda vai ser criado;
  // quando existir, entra aqui e no defaultPermissions de auth.js.
  comercial: {
    label: "Comercial",
    modules: ["dashboard", "fidelidade", "contratos", "aula-experimental", "auloes", "palestras", "agenda-espacos"]
  },
  // Setor EAD (15/10/2026) — líder: Carlos Durlo. Correção de Provas, Trilha EAD e (21/10) Banco de Provas, de todos os
  // cursos da graduação (escopo em src/rotas/cpa.js escopoDe). Sem nada da Secretaria.
  ead: {
    label: "EAD",
    modules: ["dashboard", "fidelidade", "correcao-provas", "trilha-ead", "banco-provas", "automacao-ava", "levantamento-ead"]
  },
  // Robô da ODTech (16/10/2026) — faz processos de matrícula pra ajudar a
  // Secretaria. Só Matrículas, e só de 2027.1 em diante (trava no backend
  // por users.matriculasSemestreMinimo, src/rotas/matriculas.js).
  robo: {
    label: "Robô (ODTech)",
    modules: ["dashboard", "matriculas"]
  },
  visitante: {
    label: "Visitante",
    modules: ["dashboard", "fidelidade", "agenda-espacos"]
  }
};

export function hasPermission(role, moduleId) {
  const roleConfig = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS["visitante"];
  return roleConfig.modules.includes(moduleId);
}

export function getRoleConfig(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS["visitante"];
}

// Nível de acesso normalizado com retrocompatibilidade:
// inteiro (1/2/3) ou formato legado { view, execute }
export function getAccessLevel(perm) {
  if (perm === undefined || perm === null) return 1;
  if (typeof perm === "object") {
    if (perm.execute) return 3;
    if (perm.view) return 2;
    return 1;
  }
  return parseInt(perm) || 1;
}

// Nível efetivo: o override individual do usuário (users/{uid}.permissoes)
// sempre vence o nível do cargo quando definido para o módulo.
export function getEffectiveLevel(rolePerms, userOverrides, moduleId) {
  if (userOverrides && userOverrides[moduleId] !== undefined) {
    return getAccessLevel(userOverrides[moduleId]);
  }
  return getAccessLevel(rolePerms ? rolePerms[moduleId] : undefined);
}
