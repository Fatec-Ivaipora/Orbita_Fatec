// Atividades do "PLANO DE AÇÃO - COORDENADORES.docx" (Direção Acadêmica,
// 21/10/2026) — carga inicial do módulo Plano de Ação (scripts/plano-acao-
// importar.js). Depois de importado, a Direção edita pela tela; este arquivo
// só vale pra primeira carga.
//
// periodicidade: diario | semanal | mensal | bimestral | semestral | anual |
//   a_definir (veio sem periodicidade no documento — Direção define).
// responsavel: coordenador | administrativo | ambos (colunas do documento).
// calendario: evento do calendário acadêmico do Edubox que dá a data
//   (bimestral/semestral/anual). `quando`: 'inicio' ou 'fim' do evento.
//   Sem regra (ou evento não achado no semestre) = pendência de data.

const CAL = {
    semanaPedagogica: { evento: 'SEMANA\\s+(DE\\s+INTEGRA[ÇC][ÃA]O\\s+)?PEDAG', rotulo: 'Semana Pedagógica' },
    inicioAulas: { evento: 'IN[ÍI]CIO DAS AULAS', rotulo: 'Início das aulas' },
    fimBimestre: { evento: 'T[ÉE]RMINO DO \\d', rotulo: 'Término do bimestre' },
    encontroPedagogico: { evento: 'ENCONTRO PEDAG', rotulo: 'Encontro Pedagógico' },
    nde: { evento: 'REUNI[ÃA]O DO NDE', rotulo: 'Reunião do NDE' },
    trintaDias: { evento: 'AVALIA[ÇC][ÃA]O DOS 30 DIAS', rotulo: 'Avaliação dos 30 dias' },
    rematricula: { evento: 'PER[ÍI]ODO DE REMATR', rotulo: 'Período de rematrícula' },
    colacao: { evento: 'COLA[ÇC][ÃA]O DE GRAU', rotulo: 'Colação de grau' }
};

const A = (titulo, periodicidade, responsavel, extra = {}) => ({ titulo, periodicidade, responsavel, ...extra });

const ATIVIDADES = [
    A('Deferimento e indeferimentos de documentos encaminhados à coordenação', 'diario', 'coordenador'),
    A('Atendimento ao discente: os atendimentos realizados deverão ser documentados (apenas acolher o estudante e abrir o chamado no CODI para o coordenador dar sequência)', 'diario', 'coordenador'),
    A('Fazer a recepção dos docentes e discentes no início e no final da noite', 'diario', 'coordenador'),
    A('Acompanhar o trabalho docente e verificar dificuldades/problemas/inovação/estratégias diferenciadas (metodologias ativas) e apresentar para a Direção Acadêmica', 'a_definir', 'coordenador'),
    A('Conferir os documentos emitidos pela secretaria para entrega a alunos e professores (certificados, históricos), realizando o registro da entrega', 'diario', 'administrativo'),
    A('Abrir e responder os e-mails da caixa de entrada', 'a_definir', 'ambos'),
    A('Acompanhar alunos e professores na hora do intervalo (área de convivência e sala dos professores): atendimento da cantina, postura dos alunos e necessidades dos professores', 'diario', 'coordenador'),
    A('Acompanhar os registros de trancamento/cancelamento para verificar os motivos, encaminhar para o financeiro e intervir conforme necessidade', 'diario', 'coordenador'),
    A('Realizar atendimento docente', 'diario', 'ambos'),
    A('Receber e analisar atestados médicos de alunos', 'diario', 'administrativo', { detalhe: 'Organizar os documentos é do administrativo; o deferimento, a assinatura e o encaminhamento aos docentes, se necessário, são do coordenador.' }),
    A('Manter contato com os professores do curso (pessoalmente ou por e-mail) para verificar o andamento da disciplina', 'diario', 'coordenador'),
    A('Preencher a planilha de faltas, substituições e deslocamento', 'diario', 'administrativo'),
    A('Atender demanda de professores de solicitação de materiais específicos para as aulas', 'diario', 'administrativo'),
    A('Participação de reuniões com a coordenação pedagógica e direção', 'semanal', 'ambos'),
    A('Matérias dos eventos: produzir texto e fotos para jornal, redes sociais e Marketing', 'semanal', 'administrativo'),
    A('Acompanhamento de acadêmicos para evitar a evasão', 'semanal', 'coordenador'),
    A('Acompanhar e conferir a utilização do laboratório de informática', 'semanal', 'administrativo'),
    A('Acompanhamento semanal do Edubox: pontuar com os docentes o lançamento de frequências e conteúdos, por e-mail com cópia para o NAPA e a Direção', 'semanal', 'administrativo', { detalhe: 'Lançamento é conferido pelo administrativo e o conteúdo pelo coordenador. O administrativo pode cobrar o professor por e-mail, mas o texto da cobrança precisa ser validado pelo coordenador.' }),
    A('Elaboração do Dossiê – conforme planejamento dos eventos', 'mensal', 'administrativo'),
    A('Reunião de Avaliação de Projeto – conforme planejamento dos eventos', 'mensal', 'coordenador'),
    A('Organização dos eventos – conforme planejamento dos eventos', 'mensal', 'ambos'),
    A('Acompanhar o andamento dos Projetos Integradores', 'mensal', 'coordenador'),
    A('Acompanhar o andamento do Nivelamento', 'mensal', 'coordenador'),
    A('Verificação e cobrança dos prazos de entrega dos materiais dos professores estipulados pelo NAPA: provas e simulados, planos de ensino etc.', 'mensal', 'administrativo'),
    A('Propor e participar, junto ao colegiado e acadêmicos, dos Projetos de Extensão propostos pela IES', 'mensal', 'coordenador'),
    A('Acompanhamento das atividades de Dependência e Adaptação', 'mensal', 'coordenador'),
    A('Análise das avaliações bimestrais encaminhadas pelos docentes', 'mensal', 'ambos', { detalhe: 'Adm: confere o recebimento das avaliações e separa em pastas no servidor; Coord: confere as avaliações e sinaliza o envio para a secretaria. Simulado: o administrativo recebe as questões por e-mail e monta as provas; o coordenador confere, valida e autoriza o envio à secretaria.' }),
    A('Organizar e acompanhar do início ao fim os eventos do curso que acontecem aos sábados', 'mensal', 'coordenador'),
    A('Dependência: repassar ao professor responsável quais são os alunos, como será o processo de cumprimento e acompanhar', 'mensal', 'coordenador', { detalhe: 'Coordenador distribui a aula e o administrativo passa o cronograma ao professor.' }),
    A('Desempenho bimestral do discente: levantar alunos com desempenho abaixo da média e propor ações de intervenção junto com o NAPA; verificar semanalmente a planilha do EAD', 'mensal', 'coordenador', { detalhe: 'Adm monta a planilha com os dados e o coordenador faz a intervenção com os alunos.' }),
    A('Acompanhamento do CODI para lançamentos e atendimentos com discentes', 'diario', 'coordenador', { detalhe: 'No documento: "Mensal/diário".' }),
    A('Encontro Pedagógico', 'bimestral', 'coordenador', { calendario: { ...CAL.encontroPedagogico, quando: 'fim' } }),
    A('RIAD – Relatório Individual de Atendimento Docente (somente professores do NDE), supervisionado pelo coordenador', 'bimestral', 'administrativo', { calendario: { ...CAL.fimBimestre, quando: 'fim' } }),
    A('PIT – Plano Individual de Trabalho (todos os docentes), de acordo com a RT parcial e integral', 'semestral', 'coordenador'),
    A('Propor projetos de extensão com participação e envolvimento dos docentes do curso', 'semestral', 'coordenador'),
    A('Elaboração das atas de reuniões do NDE e Colegiados (o coordenador valida as atas construídas pelo administrativo)', 'semestral', 'administrativo', { calendario: { ...CAL.nde, quando: 'fim' } }),
    A('Preenchimento do check list dos eventos', 'semestral', 'administrativo'),
    A('Reunião com o Núcleo Docente Estruturante do curso', 'semestral', 'coordenador', { calendario: { ...CAL.nde, quando: 'fim' } }),
    A('Dar devolutiva do resultado da CPA aos professores', 'semestral', 'coordenador'),
    A('Banca no processo seletivo de contratação de docentes', 'semestral', 'coordenador'),
    A('Distribuição de aulas para o semestre letivo: quadro de professores conforme demanda e necessidades de contratação/desligamento à Direção Acadêmica', 'semestral', 'coordenador'),
    A('Coordenar o processo de seleção de professores conforme diretrizes da IES', 'semestral', 'coordenador'),
    A('Conferir os lattes dos professores, cobrar documentos que faltam e manter as pastas atualizadas', 'semestral', 'administrativo'),
    A('Acompanhar e realizar ações comerciais de vestibular conforme demandas da Direção Geral, Administrativa-Financeira e Acadêmica', 'semestral', 'coordenador'),
    A('Avaliação dos 30 dias: análise feita pelo coordenador', 'semestral', 'coordenador', { calendario: { ...CAL.trintaDias, quando: 'fim' } }),
    A('Elaborar o Relatório de Adequação do Acervo Bibliográfico do NDE e alterá-lo conforme demanda', 'semestral', 'administrativo'),
    A('Lançar os dias previstos de aula nos diários de classe dos professores, inclusive os sábados letivos que faltam para fechar a carga horária', 'semestral', 'administrativo', { calendario: { ...CAL.inicioAulas, quando: 'inicio' } }),
    A('Preencher a planilha de docentes MEC, conforme modelo', 'semestral', 'administrativo'),
    A('Organizar o agendamento dos professores novos para acesso ao Edubox e acolhimento aos demais processos', 'semestral', 'administrativo', { calendario: { ...CAL.semanaPedagogica, quando: 'fim' } }),
    A('Acompanhar o processo de rematrícula dos alunos', 'semestral', 'coordenador', { calendario: { ...CAL.rematricula, quando: 'fim' } }),
    A('Elaboração da pauta e preparação da Reunião Pedagógica com o colegiado de curso', 'semestral', 'coordenador', { calendario: { ...CAL.semanaPedagogica, quando: 'inicio' } }),
    A('Atendimento individual ao docente para informações gerais de início do semestre', 'semestral', 'coordenador', { calendario: { ...CAL.semanaPedagogica, quando: 'fim' } }),
    A('Análise dos Planos de Ensino: ementa, conteúdos propostos e conferência da bibliografia (básica e complementar) na biblioteca', 'semestral', 'coordenador'),
    A('Participação na solenidade de Colação de Grau da IES', 'anual', 'coordenador', { calendario: { ...CAL.colacao, quando: 'inicio' } }),
    A('Intervenção e recados no grupo de WhatsApp', 'diario', 'ambos'),
    A('Feedback com professores', 'semanal', 'coordenador')
];

module.exports = {
    ATIVIDADES: ATIVIDADES.map((a, i) => ({ id: `a${String(i + 1).padStart(2, '0')}`, ordem: i + 1, ...a }))
};
