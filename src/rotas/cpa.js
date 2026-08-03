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
            const { rows } = await edubox.query(`
                SELECT DISTINCT c.codcur, trim(c.descur) AS nome
                FROM tav_resp_grupo_aluno r
                JOIN tav_questao q ON q.codque = r.queres
                JOIN tav_grupo g ON g.codgru = q.gruque
                ${joinMatriculaCurso('r.matres')}
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
            SELECT codgru, trim(desgru) AS nome
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

        const codgrus = grupos.map(g => g.codgru);

        // Média por pergunta, parseando o número que abre a resposta
        // ("3. Regular" -> 3). A escala (`resque`) varia de pergunta pra
        // pergunta — algumas vão "1=Péssimo...5=Ótimo", outras "1=Ótimo...
        // 5=Não sei" (invertida!) — por isso ela vai junto pro frontend
        // decidir a legenda, em vez de a gente supor uma direção fixa.
        const perguntasResult = await edubox.query(`
            SELECT
                q.gruque AS codgru,
                q.codque,
                q.desque AS pergunta,
                q.resque AS opcoes,
                count(r.desres) AS respostas,
                round(avg((regexp_match(r.desres, '^([0-9]+)'))[1]::numeric), 2) AS media
            FROM tav_questao q
            JOIN tav_resp_grupo_aluno r ON r.queres = q.codque
            ${joinMatriculaCurso('r.matres')}
            WHERE q.gruque = ANY($1::int[]) AND c.codcur = $2
              AND r.desres ~ '^[0-9]+'
            GROUP BY q.gruque, q.codque, q.desque, q.resque
            ORDER BY q.codque
        `, [codgrus, curso]);

        // Nota geral da dimensão (0-10) + comentários (obsnot), 1 por aluno/dimensão
        const dimensaoResult = await edubox.query(`
            SELECT
                n.grunot AS codgru,
                round(avg(n.notnot), 2) AS media_geral,
                count(*) AS total_avaliacoes,
                array_agg(n.obsnot) FILTER (WHERE n.obsnot IS NOT NULL AND trim(n.obsnot) <> '') AS comentarios_brutos
            FROM tav_nota_grupo_aluno n
            ${joinMatriculaCurso('n.matnot')}
            WHERE n.grunot = ANY($1::int[]) AND c.codcur = $2
            GROUP BY n.grunot
        `, [codgrus, curso]);

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
        for (const d of dimensaoResult.rows) {
            const comentarios = (d.comentarios_brutos || [])
                .map(c => c.trim())
                .filter(c => c.split(/\s+/).filter(Boolean).length >= 2);
            dimensaoInfo.set(d.codgru, {
                mediaGeral: d.media_geral === null ? null : Number(d.media_geral),
                totalAvaliacoes: Number(d.total_avaliacoes),
                comentarios,
            });
        }

        const dimensoes = grupos.map(g => {
            const info = dimensaoInfo.get(g.codgru) || { mediaGeral: null, totalAvaliacoes: 0, comentarios: [] };
            return {
                codgru: g.codgru,
                nome: g.nome,
                mediaGeral: info.mediaGeral,
                totalAvaliacoes: info.totalAvaliacoes,
                perguntas: perguntasPorGrupo.get(g.codgru) || [],
                comentarios: info.comentarios,
            };
        });

        res.json({ avaliacao, curso, dimensoes });
    } catch (err) {
        console.error('[cpa] Erro ao gerar relatório:', err);
        res.status(500).json({ error: 'Não foi possível gerar o relatório da CPA.' });
    }
});

module.exports = router;
