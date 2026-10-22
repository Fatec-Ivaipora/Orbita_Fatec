// Modelos dos documentos da Direção Acadêmica (Plano de Ação — Parte 2,
// 21/10/2026), transcritos dos arquivos Word da pasta "PLANO ORBITA":
//   - Plano de Ação da Equipe Multidisciplinar / da Coordenação de Curso /
//     do Colegiado de Curso: atividade + periodicidade + indicadores de
//     desempenho (cada indicador = pergunta + opções)
//   - Avaliação de Desempenho da Coordenação de Curso: 4 blocos de critérios
//     com nota 1–5, médias, RDG/RDI/RDO e resultado final
// Correções do Word: no plano da Coordenação, "atendimento discente" dizia
// "ao docente" (cópia) e as opções do indicador da CPA estavam embaralhadas.
// Mudar um modelo NÃO altera documento já assinado (ele guarda a cópia do
// conteúdo e o hash).

const PLANOS = {
    "equipe_multidisciplinar": {
        "titulo": "PLANO DE AÇÃO DA EQUIPE MULTIDISCIPLINAR",
        "itens": [
            {
                "atividade": "Acompanhar as diretrizes de regulação referente à educação a distância.",
                "periodicidade": "Semanal",
                "indicadores": [
                    {
                        "pergunta": "As diretrizes utilizadas pela IES estão atualizadas",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a01_1"
                    }
                ],
                "id": "a01"
            },
            {
                "atividade": "Desenvolver e atualizar as Políticas Institucionais.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "As políticas institucionais estão adequadas",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a02_1"
                    }
                ],
                "id": "a02"
            },
            {
                "atividade": "Desenvolver os requisitos para contratação de pessoas relacionadas a EAD.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "Os requisitos de contratação estão adequados",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a03_1"
                    }
                ],
                "id": "a03"
            },
            {
                "atividade": "Realizar capacitações de treinamento relacionado as operações do EaD para professores, tutores e alunos.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "Está no calendário o treinamento de EAD",
                        "opcoes": [
                            "Sim",
                            "Não"
                        ],
                        "id": "a04_1"
                    },
                    {
                        "pergunta": "As capacitações do EAD para o colegiado estão adequadas",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a04_2"
                    },
                    {
                        "pergunta": "As capacitações do EAD para os alunos estão adequadas",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a04_3"
                    }
                ],
                "id": "a04"
            },
            {
                "atividade": "Planejar e organizar com os coordenadores as disciplinas vinculadas ao EAD.",
                "periodicidade": "Bimestral",
                "indicadores": [
                    {
                        "pergunta": "O processo de planejamento e organização aconteceu de forma adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a05_1"
                    }
                ],
                "id": "a05"
            },
            {
                "atividade": "Definir, validar e divulgar o modelo de avaliação de aprendizagem.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O modelo de avaliação de aprendizagem está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a06_1"
                    }
                ],
                "id": "a06"
            },
            {
                "atividade": "Analisar e aprovar os materiais didáticos que serão disponibilizados aos alunos.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo de validação foi adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a07_1"
                    },
                    {
                        "pergunta": "Os materiais didáticos apresentados seguem padrões de qualidade adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a07_2"
                    }
                ],
                "id": "a07"
            },
            {
                "atividade": "Viabilizar as atividades da CPA dos cursos EaD, inclusive de avaliação definidas pela comissão.",
                "periodicidade": "Bimestral",
                "indicadores": [
                    {
                        "pergunta": "O processo foi adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a08_1"
                    }
                ],
                "id": "a08"
            }
        ]
    },
    "coordenacao": {
        "titulo": "PLANO DE AÇÃO DA COORDENAÇÃO DE CURSO",
        "itens": [
            {
                "atividade": "Acompanhar e-mail institucional da coordenação.",
                "periodicidade": "Diário",
                "indicadores": [
                    {
                        "pergunta": "O acompanhamento e as providências da gestão da informação por e-mail são adequados",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a01_1"
                    }
                ],
                "id": "a01"
            },
            {
                "atividade": "Realizar atendimento docente.",
                "periodicidade": "Semanal",
                "indicadores": [
                    {
                        "pergunta": "O atendimento ao docente está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a02_1"
                    }
                ],
                "id": "a02"
            },
            {
                "atividade": "Realizar atendimento discente.",
                "periodicidade": "Semanal",
                "indicadores": [
                    {
                        "pergunta": "O atendimento ao discente está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a03_1"
                    },
                    {
                        "pergunta": "A documentação do atendimento é efetiva e adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a03_2"
                    }
                ],
                "id": "a03"
            },
            {
                "atividade": "Participação de reuniões com a equipe gestora.",
                "periodicidade": "Semanal",
                "indicadores": [
                    {
                        "pergunta": "As reuniões são produtivas e adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a04_1"
                    }
                ],
                "id": "a04"
            },
            {
                "atividade": "Acompanhamento de acadêmicos para evitar a evasão.",
                "periodicidade": "Semanal",
                "indicadores": [
                    {
                        "pergunta": "O acompanhamento é eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a05_1"
                    },
                    {
                        "pergunta": "Está ocorrendo muitas evasões",
                        "opcoes": [
                            "Não",
                            "Eventualmente",
                            "Muitas evasões"
                        ],
                        "id": "a05_2"
                    }
                ],
                "id": "a05"
            },
            {
                "atividade": "Acompanhar e conferir a utilização da infraestrutura física e virtual, conforme regras aprovadas em resolução.",
                "periodicidade": "Semanal",
                "indicadores": [
                    {
                        "pergunta": "A infraestrutura física está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a06_1"
                    },
                    {
                        "pergunta": "A infraestrutura virtual está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a06_2"
                    }
                ],
                "id": "a06"
            },
            {
                "atividade": "Reunião de Avaliação Projeto – Conforme planejamento dos eventos.",
                "periodicidade": "Mensal",
                "indicadores": [
                    {
                        "pergunta": "O processo de avaliação está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a07_1"
                    }
                ],
                "id": "a07"
            },
            {
                "atividade": "Organização dos eventos – Conforme planejamento dos eventos.",
                "periodicidade": "Mensal",
                "indicadores": [
                    {
                        "pergunta": "O processo de organização de eventos está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a08_1"
                    }
                ],
                "id": "a08"
            },
            {
                "atividade": "Realizar reuniões periódicas do colegiado de curso e repassar os resultados conforme Fluxo de Decisões do Colegiado.",
                "periodicidade": "Mensal",
                "indicadores": [
                    {
                        "pergunta": "As reuniões são produtivas e adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a09_1"
                    }
                ],
                "id": "a09"
            },
            {
                "atividade": "Verificação e cobrança dos prazos de entrega dos materiais dos professores estipulados pelo NAPA e já orientados pelo mesmo: provas e simulados adaptados, materiais didáticos adaptados, etc.",
                "periodicidade": "Mensal",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a10_1"
                    }
                ],
                "id": "a10"
            },
            {
                "atividade": "Acompanhamento do progresso do aluno e monitorar alunos com progresso comprometido.",
                "periodicidade": "Mensal",
                "indicadores": [
                    {
                        "pergunta": "O acompanhamento é eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a11_1"
                    },
                    {
                        "pergunta": "Está ocorrendo muitos atrasos",
                        "opcoes": [
                            "Não",
                            "Poucos",
                            "Mais de 30% dos alunos"
                        ],
                        "id": "a11_2"
                    }
                ],
                "id": "a11"
            },
            {
                "atividade": "Desempenho bimestral de discente: fazer levantamento de alunos que tiveram desempenho bimestral abaixo de média e propor ações de intervenção junto com o NAPA.",
                "periodicidade": "Mensal",
                "indicadores": [
                    {
                        "pergunta": "A avaliação está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a12_1"
                    }
                ],
                "id": "a12"
            },
            {
                "atividade": "Distribuição de aula para o semestre letivo.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado e eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a13_1"
                    }
                ],
                "id": "a13"
            },
            {
                "atividade": "Análise dos pedidos de dispensa de disciplinas para dos acadêmicos ingressos e egressos.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado e eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a14_1"
                    }
                ],
                "id": "a14"
            },
            {
                "atividade": "Análise dos Planos de Ensino: verificação da ementa, análise dos conteúdos propostos, conferência da bibliografia (básica e complementar) na biblioteca.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado e eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a15_1"
                    }
                ],
                "id": "a15"
            },
            {
                "atividade": "Analisar os resultados das avaliações Institucionais (CPA).",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado e eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a16_1"
                    },
                    {
                        "pergunta": "A comunicação entre os envolvidos está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a16_2"
                    }
                ],
                "id": "a16"
            },
            {
                "atividade": "Propor convênios para o desenvolvimento dos projetos do curso.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado e eficaz",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequado"
                        ],
                        "id": "a17_1"
                    }
                ],
                "id": "a17"
            }
        ]
    },
    "colegiado": {
        "titulo": "PLANO DE AÇÃO DO COLEGIADO DE CURSO",
        "itens": [
            {
                "atividade": "Participar de capacitações durante a semana pedagógica",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "As capacitações estão programadas no calendário",
                        "opcoes": [
                            "Sim",
                            "Não"
                        ],
                        "id": "a01_1"
                    },
                    {
                        "pergunta": "As capacitações estão adequadas",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a01_2"
                    }
                ],
                "id": "a01"
            },
            {
                "atividade": "Analisar o projeto pedagógico do curso (propor alteração se necessário)",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo de análise do projeto está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a02_1"
                    }
                ],
                "id": "a02"
            },
            {
                "atividade": "Definir o perfil profissional do curso, definindo as linhas básicas e diretrizes (propor alteração se necessário)",
                "periodicidade": "Contínuo",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a03_1"
                    }
                ],
                "id": "a03"
            },
            {
                "atividade": "Avaliar os plano de trabalho, inclusive das atividades de iniciação científica e extensão.",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "As atividades de iniciação científica e extensão estão adequadas",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a04_1"
                    }
                ],
                "id": "a04"
            },
            {
                "atividade": "Sugerir providências de ordem didática, científica e administrativa, consideradas indispensáveis ao desenvolvimento das atividades do curso",
                "periodicidade": "Contínuo",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a05_1"
                    }
                ],
                "id": "a05"
            },
            {
                "atividade": "Coordenar a elaboração e recomendar a aquisição de lista de títulos bibliográficos e outros materiais necessários ao curso",
                "periodicidade": "Semestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a06_1"
                    },
                    {
                        "pergunta": "A plataforma virtual Minha Biblioteca está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a06_2"
                    }
                ],
                "id": "a06"
            },
            {
                "atividade": "Estruturar os conteúdos das salas virtuais (Alinhamento tutor e professor)",
                "periodicidade": "Bimestral",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a07_1"
                    },
                    {
                        "pergunta": "A plataforma está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a07_2"
                    }
                ],
                "id": "a07"
            },
            {
                "atividade": "Tutorar as salas virtuais e monitorar as atividades (tutor), repassar avisos e informações para os discentes",
                "periodicidade": "Contínuo",
                "indicadores": [
                    {
                        "pergunta": "O processo está adequado",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a08_1"
                    },
                    {
                        "pergunta": "A comunicação entre os envolvidos  está adequada",
                        "opcoes": [
                            "Ótimo",
                            "Adequação pontual",
                            "Não está adequada"
                        ],
                        "id": "a08_2"
                    }
                ],
                "id": "a08"
            }
        ]
    }
};

const AVALIACAO = {
    titulo: 'AVALIAÇÃO DE DESEMPENHO DE COORDENAÇÃO DE CURSO',
    blocos: [
        { id: 'b1', titulo: 'Bloco I – Habilidades comportamentais', criterios: [
            { id: 'b1_1', nome: 'Proatividade', descricao: 'Capacidade de buscar soluções e se adaptar a novas demandas.' },
            { id: 'b1_2', nome: 'Comprometimento', descricao: 'Envolvimento com as funções atribuídas e com os resultados do curso.' },
            { id: 'b1_3', nome: 'Liderança', descricao: 'Capacidade de assumir responsabilidades, de se voluntariar para a execução das atividades propostas e de influenciar positivamente a equipe docente e discente.' },
            { id: 'b1_4', nome: 'Trabalho em equipe', descricao: 'Colaboração com diferentes setores e perfis profissionais.' },
            { id: 'b1_5', nome: 'Relacionamento interpessoal', descricao: 'Comunicação eficaz e empática com a comunidade acadêmica.' }
        ] },
        { id: 'b2', titulo: 'Bloco II – Gestão acadêmico-administrativa', criterios: [
            { id: 'b2_1', nome: 'Conformidade com normas institucionais', descricao: 'Cumprimento de diretrizes e documentos institucionais.' },
            { id: 'b2_2', nome: 'Acompanhamento dos alunos e egressos', descricao: 'Registro, atenção e apoio à trajetória discente.' },
            { id: 'b2_3', nome: 'Promoção de eventos do curso', descricao: 'Organização de eventos científicos, culturais e integradores.' },
            { id: 'b2_4', nome: 'Planejamento para o ENADE', descricao: 'Ações voltadas ao desempenho do curso no ENADE.' },
            { id: 'b2_5', nome: 'Ações contra evasão e retenção', descricao: 'Propostas de melhoria na permanência dos alunos.' }
        ] },
        { id: 'b3', titulo: 'Bloco III – Gestão acadêmico-administrativa', criterios: [
            { id: 'b3_1', nome: 'Ações extensionistas e sociais', descricao: 'Incentivo e realização de atividades de extensão e responsabilidade social.' },
            { id: 'b3_2', nome: 'Monitoramento do ensino', descricao: 'Avaliação do trabalho docente e práticas pedagógicas.' },
            { id: 'b3_3', nome: 'Respostas à CPA', descricao: 'Propostas com base nas avaliações institucionais.' },
            { id: 'b3_4', nome: 'Atualização do PPC com o NDE', descricao: 'Acompanhamento ativo e técnico do Projeto Pedagógico.' }
        ] },
        { id: 'b4', titulo: 'Bloco IV – Apoio à pesquisa, planejamento e gestão institucional', criterios: [
            { id: 'b4_1', nome: 'Capacitação docente e técnica', descricao: 'Apresentação e promoção de estratégias de formações e atualizações para a equipe.' },
            { id: 'b4_2', nome: 'Cumprimento de prazos', descricao: 'Entregas institucionais no prazo.' },
            { id: 'b4_3', nome: 'Incentivo à pesquisa', descricao: 'Apoio à produção científica do curso.' },
            { id: 'b4_4', nome: 'Relatórios e planos de ação', descricao: 'Elaboração e envio regular à CPA e Colegiado.' }
        ] }
    ]
};

const TIPOS = {
    equipe_multidisciplinar: 'Plano de Ação da Equipe Multidisciplinar',
    coordenacao: 'Plano de Ação da Coordenação de Curso',
    colegiado: 'Plano de Ação do Colegiado de Curso',
    avaliacao: 'Avaliação de Desempenho da Coordenação de Curso'
};

// Média com 2 casas (nota 1–5); null se faltar nota.
const media = (lista) => lista.length && lista.every(v => Number.isFinite(v)) ? Math.round(lista.reduce((a, b) => a + b, 0) / lista.length * 100) / 100 : null;

// Resultados da avaliação: média de cada bloco, RDG = média dos 4 blocos;
// RDI/RDO vêm digitados (avaliação discente e docente); Total = RDG + RDI +
// RDO; RF = Total ÷ 3. (Fórmula a confirmar com a Direção.)
function resultadosAvaliacao(notas = {}, rdi, rdo) {
    const blocos = {};
    AVALIACAO.blocos.forEach(b => {
        const ns = b.criterios.map(c => Number(notas[c.id]));
        blocos[b.id] = { soma: ns.every(Number.isFinite) ? ns.reduce((a, x) => a + x, 0) : null, media: media(ns) };
    });
    const rdg = media(AVALIACAO.blocos.map(b => blocos[b.id].media));
    const vals = [rdg, Number(rdi), Number(rdo)];
    const total = vals.every(Number.isFinite) ? Math.round(vals.reduce((a, x) => a + x, 0) * 100) / 100 : null;
    return { blocos, rdg, total, rf: total === null ? null : Math.round(total / 3 * 100) / 100 };
}

module.exports = { PLANOS, AVALIACAO, TIPOS, resultadosAvaliacao };
