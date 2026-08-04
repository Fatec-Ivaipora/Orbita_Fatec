const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewares/auth');
const edubox = require('../db-edubox');

const checkPermission = verifyToken.requireModulePermission('cpa');

// Todas as queries abaixo passam SEMPRE por um INNER JOIN até `tac_curso`
// (que só contém cursos da Fatec) — o banco do Edubox é compartilhado com
// ~32 outras instituições da região, e essa junção é o que garante que
// nenhuma resposta de aluno de outra instituição entre no relatório, mesmo
// quando nenhum curso específico é pedido.
const JOIN_MATRICULA_CURSO = `
    JOIN tac_matricula m ON m.codmat = %ALIAS%
    JOIN tac_turma t ON t.codtur = m.turmat
    JOIN tac_curso c ON c.codcur = t.curtur
`;

function joinMatriculaCurso(aliasColuna) {
    return JOIN_MATRICULA_CURSO.replace('%ALIAS%', aliasColuna);
}

// Classificação de comentário por palavra-chave (heurística, não é NLP de
// verdade) — critério definido com o usuário:
//   bom     = elogio
//   neutro  = não elogia, mas também não sugere melhoria/crítica
//   atencao = sugestão de melhoria ou crítica/algo negativo
// "atencao" é checado primeiro: um comentário com elogio E crítica junto
// ("está bom, mas podia ter mais X") cai em atenção, que é a categoria
// acionável pro coordenador. Case-insensitive, sem acento (normaliza antes).
const PALAVRAS_ATENCAO = [
    'poderia', 'poderiam', 'deveria', 'deveriam', 'falta', 'faltam', 'faltou',
    'precisa melhorar', 'precisaria', 'precisa de mais', 'precisam de mais',
    'melhorar', 'melhoria', 'melhorias',
    'ruim', 'ruins', 'pessimo', 'pessima', 'horrivel', 'nao gostei',
    'insatisfeit', 'insatisfat', 'problema', 'reclama', 'infelizmente',
    'lamentav', 'demora', 'demorado', 'demorada', 'atraso', 'dificuldade',
    'nao funciona', 'descaso', 'pouco caso', 'sugiro', 'sugestao',
    'gostaria que', 'gostaria de mais', 'deixa a desejar', 'a desejar',
    'carente', 'carencia', 'sem estrutura', 'nunca teve',
    'escasso', 'escassez', 'deficiente', 'defasado',
];
const PALAVRAS_BOM = [
    'otimo', 'otima', 'excelente', 'excelentes', 'muito bom', 'muito boa',
    'adorei', 'adoro', 'gostei muito', 'gostei', 'parabens', 'maravilhos',
    'incrivel', 'sensacional', 'perfeito', 'perfeita', 'satisfeit',
    'satisfatori', 'agradec', 'muito feliz', 'orgulho', 'amei',
    'nota 10', 'esta bom', 'esta boa', 'gosto muito',
    'bom trabalho', 'excelente trabalho', 'sempre atencioso', 'sempre atenciosa',
];
// Frases que NEGAM queixa/crítica/sugestão ("nada a reclamar", "não há
// críticas") batem por substring nas palavras de atenção acima ("reclama",
// "sugestao" etc) e invertem o sentido — checadas ANTES da lista de atenção
// pra não virar falso positivo. Só suprimem a checagem de atenção pra essa
// frase específica; se o comentário também tiver elogio explícito ("muito
// bom, nada a reclamar"), ainda cai em "bom" normalmente.
const NEGACAO_SEM_QUEIXA = [
    'nada a reclamar', 'nada para reclamar', 'sem nada a reclamar', 'nada reclamar',
    'nao tenho reclamacoes', 'nao tenho o que reclamar', 'nao ha o que reclamar',
    'sem reclamacoes', 'nada de reclamacao', 'nada de reclamar',
    'nao ha criticas', 'nao ha critica', 'nenhuma critica', 'nenhuma sugestao',
    'nada de sugestao', 'nada de critica', 'sem sugestao', 'sem critica',
    'nao tem sugestao', 'nao tem critica', 'nao tem reclamacao',
    'sem sugestoes', 'nao tenho sugestoes', 'nao ha sugestao', 'nao ha sugestoes',
    'nada a acrescentar', 'nada a apontar', 'sem nada a apontar',
    'nenhuma queixa', 'sem queixas', 'nao tenho queixas', 'nada de queixa',
    'nao tive problema', 'nao tive nenhum problema', 'nao tive problemas',
    'sem problemas', 'nenhum problema', 'sem nenhum problema',
];
// "Não tem" sozinho, no contexto de comentário de CPA, quase sempre quer
// dizer "não tem [reclamação/crítica]" — bem mais perto de satisfação do
// que de crítica. Ao contrário das negações acima (que caem em "neutro"),
// essa vira direto "bom", a pedido do usuário.
const NEGACAO_POSITIVA = ['nao tem', 'nada tem'];

// "Tem como melhorar", "a melhorar" — sugestão de melhoria genérica demais
// pra ser útil pro coordenador (não diz o quê). Só vira "neutro" quando é
// basicamente o comentário inteiro (ver limite de palavras abaixo); dentro
// de um comentário maior e mais específico, "melhorar" continua contando
// pra "atenção" normalmente.
const MELHORIA_VAGA = [
    'tem como melhorar', 'a melhorar', 'pode melhorar', 'poderia melhorar',
    'precisa melhorar', 'deveria melhorar', 'tem que melhorar',
];

function normalizar(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, ''); // remove acentos (ex: "não" -> "nao")
}

// "nada ... a reclamar" com palavras no meio ("nada especificamente a
// reclamar", "nada em especial a reclamar") — mais tolerante que checar
// frases fixas uma a uma.
const REGEX_NADA_RECLAMAR = /\bnada\b[a-z ]{0,25}\breclamar\b/;

function classificarComentario(texto) {
    const t = normalizar(texto);
    const numPalavras = t.split(/\s+/).filter(Boolean).length;
    if (NEGACAO_POSITIVA.some(p => t.includes(p))) return 'bom';
    if (NEGACAO_SEM_QUEIXA.some(p => t.includes(p)) || REGEX_NADA_RECLAMAR.test(t)) {
        return PALAVRAS_BOM.some(p => t.includes(p)) ? 'bom' : 'neutro';
    }
    if (numPalavras <= 4 && MELHORIA_VAGA.some(p => t.includes(p))) return 'neutro';
    if (PALAVRAS_ATENCAO.some(p => t.includes(p))) return 'atencao';
    if (PALAVRAS_BOM.some(p => t.includes(p))) return 'bom';
    return 'neutro';
}

// ==========================================
// CAMPANHAS (avaliações do segmento Alunos)
// ==========================================
router.get('/campanhas', verifyToken, checkPermission, async (req, res) => {
    try {
        const { rows } = await edubox.query(`
            SELECT codava, trim(desava) AS descricao, semava
            FROM tav_avaliacao
            WHERE tipava = 'A'
            ORDER BY codava DESC
            LIMIT 12
        `);
        res.json(rows);
    } catch (err) {
        console.error('[cpa] Erro ao listar campanhas:', err);
        res.status(500).json({ error: 'Não foi possível carregar as campanhas da CPA.' });
    }
});

// ==========================================
// CURSOS (só os que têm resposta na campanha pedida, se informada)
// ==========================================
router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { codava } = req.query;
        if (codava) {
            // Dimensões "gerais" (tipgru='G') respondem via tav_resp_grupo_aluno;
            // dimensões "por disciplina" (tipgru='D', ex.: Disciplinas
            // Presenciais/Estágio) respondem via tav_resp_historico_aluno
            // (ligada à matrícula por tac_historico, não direto). Um curso
            // pode só ter resposta numa das duas — por isso o UNION.
            const { rows } = await edubox.query(`
                SELECT DISTINCT c.codcur, trim(c.descur) AS nome
                FROM tav_resp_grupo_aluno r
                JOIN tav_questao q ON q.codque = r.queres
                JOIN tav_grupo g ON g.codgru = q.gruque
                ${joinMatriculaCurso('r.matres')}
                WHERE g.avagru = $1
                UNION
                SELECT DISTINCT c.codcur, trim(c.descur) AS nome
                FROM tav_resp_historico_aluno r
                JOIN tav_questao q ON q.codque = r.queres
                JOIN tav_grupo g ON g.codgru = q.gruque
                JOIN tac_historico h ON h.codhis = r.hisres
                ${joinMatriculaCurso('h.mathis')}
                WHERE g.avagru = $1
                ORDER BY nome
            `, [codava]);
            return res.json(rows);
        }

        const { rows } = await edubox.query(`
            SELECT codcur, trim(descur) AS nome FROM tac_curso ORDER BY nome
        `);
        res.json(rows);
    } catch (err) {
        console.error('[cpa] Erro ao listar cursos:', err);
        res.status(500).json({ error: 'Não foi possível carregar os cursos.' });
    }
});

// ==========================================
// RELATÓRIO — por dimensão (tópico), médias por pergunta e comentários filtrados
// ==========================================
router.get('/relatorio/:codava', verifyToken, checkPermission, async (req, res) => {
    const { codava } = req.params;
    const { curso } = req.query;

    if (!curso) {
        return res.status(400).json({ error: 'Informe o curso (parâmetro ?curso=<codcur>).' });
    }

    try {
        const avaliacaoResult = await edubox.query(
            `SELECT codava, trim(desava) AS descricao, semava FROM tav_avaliacao WHERE codava = $1`,
            [codava]
        );
        if (avaliacaoResult.rows.length === 0) {
            return res.status(404).json({ error: 'Campanha não encontrada.' });
        }
        const avaliacao = avaliacaoResult.rows[0];

        // Dimensões (grupos), ordenadas pelo número que abre o título
        // ("1. Missão...", "2. Política...") — a ordem de criação (codgru)
        // não corresponde a essa numeração.
        const gruposResult = await edubox.query(`
            SELECT codgru, trim(desgru) AS nome, tipgru
            FROM tav_grupo
            WHERE avagru = $1
            ORDER BY
                COALESCE((regexp_match(trim(desgru), '^([0-9]+)'))[1]::int, 999),
                trim(desgru)
        `, [codava]);
        const grupos = gruposResult.rows;

        if (grupos.length === 0) {
            return res.json({ avaliacao, curso, dimensoes: [] });
        }

        // Dimensões "gerais" (tipgru='G') guardam nota/resposta por
        // aluno/dimensão em tav_*_grupo_aluno. Dimensões "por disciplina"
        // (tipgru='D', ex.: Disciplinas Presenciais, Estágio Supervisionado)
        // guardam em tav_*_historico_aluno — um registro por aluno POR
        // DISCIPLINA cursada (ligado via tac_historico), não por dimensão.
        // Sem essa distinção, essas dimensões voltam sempre com 0 respostas.
        const codgrusG = grupos.filter(g => g.tipgru !== 'D').map(g => g.codgru);
        const codgrusD = grupos.filter(g => g.tipgru === 'D').map(g => g.codgru);

        // Média por pergunta, parseando o número que abre a resposta
        // ("3. Regular" -> 3). A escala (`resque`) varia de pergunta pra
        // pergunta — algumas vão "1=Péssimo...5=Ótimo", outras "1=Ótimo...
        // 5=Não sei" (invertida!) — por isso ela vai junto pro frontend
        // decidir a legenda, em vez de a gente supor uma direção fixa.
        const perguntasG = codgrusG.length ? await edubox.query(`
            SELECT
                q.gruque AS codgru, q.codque, q.desque AS pergunta, q.resque AS opcoes,
                count(r.desres) AS respostas,
                round(avg((regexp_match(r.desres, '^([0-9]+)'))[1]::numeric), 2) AS media
            FROM tav_questao q
            JOIN tav_resp_grupo_aluno r ON r.queres = q.codque
            ${joinMatriculaCurso('r.matres')}
            WHERE q.gruque = ANY($1::int[]) AND c.codcur = $2
              AND r.desres ~ '^[0-9]+'
            GROUP BY q.gruque, q.codque, q.desque, q.resque
        `, [codgrusG, curso]) : { rows: [] };

        const perguntasD = codgrusD.length ? await edubox.query(`
            SELECT
                q.gruque AS codgru, q.codque, q.desque AS pergunta, q.resque AS opcoes,
                count(r.desres) AS respostas,
                round(avg((regexp_match(r.desres, '^([0-9]+)'))[1]::numeric), 2) AS media
            FROM tav_questao q
            JOIN tav_resp_historico_aluno r ON r.queres = q.codque
            JOIN tac_historico h ON h.codhis = r.hisres
            ${joinMatriculaCurso('h.mathis')}
            WHERE q.gruque = ANY($1::int[]) AND c.codcur = $2
              AND r.desres ~ '^[0-9]+'
            GROUP BY q.gruque, q.codque, q.desque, q.resque
        `, [codgrusD, curso]) : { rows: [] };

        const perguntasResult = { rows: [...perguntasG.rows, ...perguntasD.rows] };

        // Nota geral da dimensão (0-10) + comentário (obsnot), 1 linha por
        // aluno/dimensão (ou por aluno/disciplina, nas dimensões tipo 'D') —
        // traz notnot junto de cada comentário (em vez de só a média) pra
        // classificar "bom/neutro/atenção" pela nota que o próprio aluno deu.
        const dimensaoG = codgrusG.length ? await edubox.query(`
            SELECT n.grunot AS codgru, n.notnot, n.obsnot
            FROM tav_nota_grupo_aluno n
            ${joinMatriculaCurso('n.matnot')}
            WHERE n.grunot = ANY($1::int[]) AND c.codcur = $2
        `, [codgrusG, curso]) : { rows: [] };

        // Nas dimensões 'D', cada linha também carrega a disciplina cursada
        // (via tac_historico -> tac_disciplina_turma) e, quando cadastrado,
        // o professor daquela disciplina/turma — usado pra montar o
        // detalhamento por disciplina abaixo do card da dimensão. O vínculo
        // professor (`prodtu`) só existe pra parte dos cursos (nulo pra
        // outros, ex.: Medicina) — por isso o LEFT JOIN, a disciplina sozinha
        // já é suficiente pra mostrar o detalhamento mesmo sem o professor.
        const dimensaoD = codgrusD.length ? await edubox.query(`
            SELECT n.grunot AS codgru, n.notnot, n.obsnot,
                   trim(d.nomdis) AS disciplina, trim(f.nomfun) AS professor
            FROM tav_nota_historico_aluno n
            JOIN tac_historico h ON h.codhis = n.hisnot
            JOIN tac_disciplina_turma dt ON dt.coddtu = h.dtuhis
            JOIN tac_disciplina d ON d.coddis = dt.disdtu
            LEFT JOIN tac_professor p ON p.codpro = dt.prodtu
            LEFT JOIN trh_funcionario f ON f.codfun = p.funpro
            ${joinMatriculaCurso('h.mathis')}
            WHERE n.grunot = ANY($1::int[]) AND c.codcur = $2
        `, [codgrusD, curso]) : { rows: [] };

        const dimensaoResult = { rows: [...dimensaoG.rows, ...dimensaoD.rows] };

        const perguntasPorGrupo = new Map();
        for (const p of perguntasResult.rows) {
            if (!perguntasPorGrupo.has(p.codgru)) perguntasPorGrupo.set(p.codgru, []);
            const opcoes = (p.opcoes || '').split('|').map(o => o.trim()).filter(Boolean);
            perguntasPorGrupo.get(p.codgru).push({
                codque: p.codque,
                pergunta: p.pergunta,
                opcoes,
                escalaInvertida: opcoes.length > 0 && /ótimo|excelente|bom/i.test(opcoes[0]) && !/ótimo|excelente|bom/i.test(opcoes[opcoes.length - 1]),
                respostas: Number(p.respostas),
                media: p.media === null ? null : Number(p.media),
            });
        }

        const dimensaoInfo = new Map();
        // Detalhamento por disciplina dentro de cada dimensão 'D' — chave
        // "codgru|disciplina|professor" pra separar a mesma disciplina
        // ensinada por professores diferentes (quando o vínculo existe).
        const disciplinaInfo = new Map();
        for (const row of dimensaoResult.rows) {
            if (!dimensaoInfo.has(row.codgru)) {
                dimensaoInfo.set(row.codgru, { somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [] });
            }
            const info = dimensaoInfo.get(row.codgru);
            // notnot é 0-10, mas o dado no Edubox tem erro de digitação
            // ocasional (ex.: um caso real de "100" em vez de "10") — fora
            // dessa faixa é tratado como nota ausente (não entra na média),
            // sem descartar o comentário nem a contagem de participação.
            const notaBruta = row.notnot === null ? null : Number(row.notnot);
            const nota = (notaBruta !== null && notaBruta >= 0 && notaBruta <= 10) ? notaBruta : null;
            info.totalAvaliacoes += 1;
            if (nota !== null) { info.somaNotas += nota; info.countNotas += 1; }

            const texto = (row.obsnot || '').trim();
            const comentario = texto.split(/\s+/).filter(Boolean).length >= 2
                ? { texto, classificacao: classificarComentario(texto) }
                : null;
            if (comentario) info.comentarios.push(comentario);

            if (row.disciplina) {
                const chave = `${row.codgru}|${row.disciplina}|${row.professor || ''}`;
                if (!disciplinaInfo.has(chave)) {
                    disciplinaInfo.set(chave, {
                        codgru: row.codgru, disciplina: row.disciplina, professor: row.professor || null,
                        somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [],
                    });
                }
                const dInfo = disciplinaInfo.get(chave);
                dInfo.totalAvaliacoes += 1;
                if (nota !== null) { dInfo.somaNotas += nota; dInfo.countNotas += 1; }
                if (comentario) dInfo.comentarios.push(comentario);
            }
        }

        const disciplinasPorGrupo = new Map();
        for (const d of disciplinaInfo.values()) {
            if (!disciplinasPorGrupo.has(d.codgru)) disciplinasPorGrupo.set(d.codgru, []);
            disciplinasPorGrupo.get(d.codgru).push({
                disciplina: d.disciplina,
                professor: d.professor,
                mediaGeral: d.countNotas > 0 ? Math.round((d.somaNotas / d.countNotas) * 100) / 100 : null,
                totalAvaliacoes: d.totalAvaliacoes,
                comentarios: d.comentarios,
            });
        }
        for (const lista of disciplinasPorGrupo.values()) {
            lista.sort((a, b) => b.totalAvaliacoes - a.totalAvaliacoes);
        }

        const dimensoes = grupos.map(g => {
            const info = dimensaoInfo.get(g.codgru) || { somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [] };
            const mediaGeral = info.countNotas > 0 ? Math.round((info.somaNotas / info.countNotas) * 100) / 100 : null;
            return {
                codgru: g.codgru,
                nome: g.nome,
                mediaGeral,
                totalAvaliacoes: info.totalAvaliacoes,
                perguntas: perguntasPorGrupo.get(g.codgru) || [],
                comentarios: info.comentarios,
                disciplinas: disciplinasPorGrupo.get(g.codgru) || [],
            };
        });

        res.json({ avaliacao, curso, dimensoes });
    } catch (err) {
        console.error('[cpa] Erro ao gerar relatório:', err);
        res.status(500).json({ error: 'Não foi possível gerar o relatório da CPA.' });
    }
});

module.exports = router;
