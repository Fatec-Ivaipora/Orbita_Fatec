// Portfólio Reflexivo — Medicina / SCIC (23/11/2026)
// "PARTE 2 — BLOCO ESPECÍFICO" de cada turma em 2026.2, transcrito dos documentos da coordenação
// (Prompt_Correcao_Portfolio_{2,4,5}o_Periodo.docx). É só o ponto de partida: a coordenação ajusta na tela
// (Configurar turma) e, a partir daí, vale o que está no Firestore (med_portfolio_turmas).
// Semestres novos começam vazios — a coordenação cadastra (ou copia do semestre anterior).

const PADRAO_2026_2 = [
    {
        turma: 'T3', periodo: 2,
        componente: 'Saúde, Comunidade e Integralidade do Cuidado (SCIC)',
        tema: 'Vigilância em Saúde e Doenças Infectocontagiosas',
        cenarios: 'Unidades Básicas de Saúde (UBS) e atividades integradas/comunitárias',
        objetivoGeral: 'Proporcionar ao estudante o desenvolvimento de competências e habilidades técnico-científicas, humanas e práticas para a formação profissional, relacionadas à integralidade da saúde e comunidade, com base nas diretrizes do SUS e com ênfase no Sistema Nacional de Vigilância em Saúde.',
        questaoNorteadora: 'Como a vigilância em saúde transforma informações sobre indivíduos em ações capazes de proteger toda a comunidade?',
        objetivos: [
            'Dominar o conceito de integralidade em saúde, reconhecendo a importância de uma visão holística do indivíduo, sua família, comunidade e território;',
            'Entender as políticas, diretrizes e propostas do Sistema Único de Saúde (SUS), incluindo a estrutura e funcionamento das Unidades Básicas de Saúde (UBS) e Unidades de Saúde da Família (USF);',
            'Identificar e analisar os fluxos de referência e contrarreferência dentro do SUS, promovendo a continuidade do cuidado;',
            'Compreender as atividades da Estratégia Saúde da Família (ESF), incluindo o trabalho em equipe, planejamento de ações e atendimento à população;',
            'Reconhecer a saúde como um direito fundamental e discutir as implicações dos direitos humanos nas práticas de saúde;',
            'Integrar conceitos, habilidades e teorias que compõem a Atenção Básica, como gestão, educação em saúde e promoção do cuidado integral;',
            'Participar ativamente de atividades extensionistas que atendam às necessidades de saúde da população, aplicando conhecimentos em situações reais;',
            'Desenvolver habilidades para trabalhar em equipes multidisciplinares, promovendo a colaboração e a comunicação eficaz no atendimento à saúde;',
            'Elaborar e avaliar planos de ação para promover a saúde e o bem-estar da comunidade, utilizando uma abordagem centrada na integralidade;',
            'Refletir criticamente sobre as práticas de saúde em contextos comunitários, propondo melhorias que considerem as especificidades locais e as necessidades da população.'
        ],
        instrucoes: [
            'Articulação com a Questão Norteadora: verifique se as narrativas e análises do estudante convergem para a compreensão de como o dado individual (notificação compulsória, teste rápido, busca ativa, vacinação) se converte em intervenção coletiva e proteção comunitária.',
            'Tópicos e vivências esperadas (UBS e discussões temáticas): papel e escopo da Vigilância em Saúde na APS; agravos de notificação compulsória vs. doenças comuns (impacto de subnotificações e quebra de cadeias de transmissão); indicadores territoriais e sistemas de informação em saúde (confronto entre dados numéricos e a realidade observada); estratégias de imunização e desafios de cobertura vacinal; testes rápidos e manejo ético/comunicacional de ISTs e doenças transmissíveis; busca ativa de sintomáticos respiratórios e comunicantes (tuberculose, hanseníase); educação permanente em saúde e planejamento contínuo da equipe.',
            'Foco reflexivo vs. relatório burocrático: desestimule relatórios meramente descritivos de atividades; valorize registros subjetivos, problematizações, dilemas éticos e propostas de intervenção fundamentadas na realidade da UBS.'
        ]
    },
    {
        turma: 'T2', periodo: 4,
        componente: 'Saúde, Comunidade e Integralidade do Cuidado (SCIC)',
        tema: 'Saúde do Idoso e Princípios da Prescrição Segura',
        cenarios: 'Unidades Básicas de Saúde (UBS) e Ambulatório Multidisciplinar de Especialidades (AME — Linha de Cuidado do Idoso)',
        objetivoGeral: 'Proporcionar ao estudante o desenvolvimento de competências e habilidades técnico-científicas, humanas e práticas para a formação profissional, relacionadas à integralidade da saúde e comunidade, com base nas diretrizes do SUS; expor o estudante de Medicina ao cuidado integral, longitudinal e humanizado da pessoa idosa, com atuação qualificada nos diferentes pontos de atenção à saúde, conforme os princípios e diretrizes do SUS.',
        questaoNorteadora: 'Como cuidar de alguém considerando sua história, sua funcionalidade e sua autonomia, e não apenas suas doenças?',
        objetivos: [
            'Compreender o envelhecimento como processo natural e heterogêneo;',
            'Realizar abordagem clínica integral da pessoa idosa;',
            'Aplicar instrumentos da Avaliação Geriátrica Ampla (AGA) e rastreios funcionais/cognitivos (como MEEM, Teste do Relógio, Mini-Cog, IVCF-20);',
            'Identificar e manejar síndromes geriátricas (Gigantes da Geriatria / 7 i\'s);',
            'Planejar ações de promoção, prevenção e reabilitação;',
            'Atuar em equipe multiprofissional;',
            'Reconhecer situações de vulnerabilidade social e violência contra a pessoa idosa;',
            'Exercer comunicação ética, empática e centrada na pessoa.'
        ],
        instrucoes: [
            'Articulação com a Questão Norteadora: avalie se o estudante transcende o modelo biomédico tradicional centrado em doenças crônicas isoladas, demonstrando capacidade de enxergar a história de vida, a manutenção da independência funcional e a preservação da autonomia da pessoa idosa.',
            'Grandes Síndromes Geriátricas (os 7 i\'s) — o portfólio deve refletir criticamente: Incapacidade Comunicativa (barreiras sensoriais, letramento em saúde, próteses e adaptações na consulta); Incapacidade Cognitiva (demência x delirium, instrumentos de rastreio, impacto na família); Instabilidade Postural e Quedas (riscos ambientais/domiciliares, sarcopenia e fragilidade); Imobilidade (pacientes restritos ao leito, lesões por pressão, dispositivos, suporte aos cuidadores); Incontinência Urinária e Fecal (causas reversíveis vs. prescrição automática de fraldas, dignidade e higiene); Iatrogenia e Polifarmácia (desprescrição, medicamentos potencialmente inapropriados — Beers/STOPP-START, racionalidade terapêutica); Insuficiência Familiar (sobrecarga do cuidador, assistência social e rede de apoio).',
            'Passagem pelo AME (Linha de Cuidado do Idoso): o estudante deve descrever e refletir sobre a articulação e comunicação entre a Atenção Primária à Saúde e a Atenção Especializada Ambulatorial (fluxos da Rede de Atenção à Saúde).'
        ]
    },
    {
        turma: 'T1', periodo: 5,
        componente: 'Saúde, Comunidade e Integralidade do Cuidado (SCIC)',
        tema: 'Atenção Psicossocial e Procedimentos',
        cenarios: 'Rede diversificada de estágios — UBS, CAPS, UPA, Hospital Bom Jesus (ISBJ), Ambulatório de Saúde da Criança e Ambulatório de Pequenas Cirurgias',
        objetivoGeral: 'Desenvolver competências para o manejo inicial e o acompanhamento de pessoas com demandas em saúde mental e necessidade de procedimentos ambulatoriais, compreendendo o papel da Atenção Primária na coordenação do cuidado e na articulação entre profissionais, serviços e políticas públicas.',
        questaoNorteadora: 'Como oferecer um cuidado integral diante de problemas complexos que exigem conhecimento técnico, comunicação e trabalho em equipe?',
        objetivos: [
            'Compreender os conceitos de interdisciplinaridade, interprofissionalidade, apoio matricial, Projeto Terapêutico Singular (PTS) e intersetorialidade;',
            'Reconhecer o papel da Atenção Primária à Saúde na coordenação do cuidado e na articulação da Rede de Atenção à Saúde (RAS);',
            'Identificar pontos de integração entre os serviços de saúde e a rede de assistência social, educação, justiça e demais políticas públicas;',
            'Reconhecer as atribuições dos diferentes profissionais envolvidos no cuidado de pessoas com necessidades complexas;',
            'Desenvolver habilidades de comunicação clínica para o acolhimento, avaliação e acompanhamento de pessoas com sofrimento psíquico;',
            'Reconhecer os principais transtornos mentais acompanhados na APS e compreender estratégias de cuidado longitudinal, matriciamento e encaminhamento quando necessário;',
            'Compreender os princípios de biossegurança, segurança do paciente e indicação dos principais procedimentos ambulatoriais realizados na APS;',
            'Participar, de forma supervisionada, da realização e do acompanhamento de pequenos procedimentos ambulatoriais;',
            'Reconhecer situações que exigem encaminhamento para outros pontos da rede e compreender os fluxos de referência e contrarreferência;',
            'Refletir criticamente sobre o trabalho em equipe, a tomada de decisão compartilhada e a construção de um cuidado centrado na pessoa.'
        ],
        instrucoes: [
            'Articulação com a Questão Norteadora: verificar se o estudante discute a integração indissociável entre a técnica médica (procedimentos cirúrgicos/ambulatoriais, raciocínio diagnóstico de urgência, psicofarmacologia) e as habilidades relacionais (escuta qualificada em saúde mental, acolhimento, trabalho interprofissional e matriciamento).',
            'Diversidade de cenários da RAS e longitudinalidade — como a APS coordena o percurso do usuário entre: UBS (saúde mental na APS, estratificação de risco, acompanhamento longitudinal, pequenos procedimentos); CAPS (dispositivos de atenção psicossocial, grupos terapêuticos, reabilitação psicossocial e redução de danos, contrastando com o modelo manicomial/hospitalocêntrico); UPA e Hospital Bom Jesus (raciocínio clínico na urgência/emergência, "o que poderia ter sido prevenido pela APS antes do internamento" e "qual o plano de cuidado pós-alta na APS"); Ambulatório de Saúde da Criança (AIDPI, vulnerabilidades biopsicossociais, puericultura, cuidado compartilhado); Ambulatório de Pequenas Cirurgias (segurança do paciente, técnica asséptica, indicação precisa, consentimento e orientações pós-procedimento).',
            'Cuidado centrado na pessoa e decisão compartilhada: valorize relatos que demonstrem escuta ativa, elaboração de Projetos Terapêuticos Singulares (PTS) e pactuação de condutas com usuários e equipes interdisciplinares.'
        ]
    }
];

function turmasPadrao(semestre) {
    if (semestre !== '2026.2') return [];
    return PADRAO_2026_2.map(t => ({ ...t, semestre, objetivos: [...t.objetivos], instrucoes: [...t.instrucoes], professores: [] }));
}

module.exports = { turmasPadrao };
