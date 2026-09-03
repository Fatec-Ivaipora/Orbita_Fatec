const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const edubox = require('../db-edubox');

const checkPermission = verifyToken.requireModulePermission('cobranca');

const COL_ACOES = 'financeiro_cobranca_acoes';

// O Postgres do Edubox é compartilhado com ~32 outras instituições da
// região (mesmo banco usado antes pelo módulo CPA, removido em 2026-08-03)
// — `tfi_ctreceber`/`tfi_cliente` NÃO são exclusivos da Fatec. Este INNER
// JOIN até `tac_curso` (que só lista cursos da Fatec) é o que garante que
// nenhuma dívida de aluno de outra instituição apareça aqui. Não remover
// achando redundante, e não trocar por LEFT JOIN.
const JOIN_CURSO = `
    JOIN tac_matricula m ON m.codmat = p.matctr
    JOIN tac_turma t ON t.codtur = m.turmat
    JOIN tac_curso c ON c.codcur = t.curtur
`;

const FAIXAS = {
    '1-30': [1, 30],
    '31-60': [31, 60],
    '61-90': [61, 90],
    '90+': [91, null]
};

const PAGE_SIZE = 25; // <= limite de 30 itens do operador "in" do Firestore, usado pra buscar ações por página

// Filtro de faixa em /parcelas é sobre o AGREGADO por aluno (pior parcela
// dele), não por parcela individual — por isso HAVING sobre max(), não
// WHERE. Um aluno com faixa "90+" selecionada aparece se tiver ALGUMA
// parcela vencida há mais de 90 dias, mesmo que também tenha outras mais
// recentes.
function condicaoFaixaHaving(faixa, params) {
    const range = FAIXAS[faixa];
    if (!range) return '';
    const [min, max] = range;
    params.push(min);
    const minClause = `max(current_date - p.venctr) >= $${params.length}`;
    if (max === null) return `HAVING ${minClause}`;
    params.push(max);
    return `HAVING ${minClause} AND max(current_date - p.venctr) <= $${params.length}`;
}

function normalizarCpf(v) {
    const digitos = (v || '').toString().replace(/\D/g, '');
    return digitos.length >= 11 ? digitos : null;
}

// `semctr` tem os mesmos semestres gravados ora como "2026/2", ora como
// "2026-2" (inconsistência de digitação no Edubox, confirmado em consulta —
// os dois formatos aparecem lado a lado em /semestres pro mesmo período).
// Compara normalizando a barra pra traço dos dois lados, senão escolher
// "2026/2" no filtro esconde metade das parcelas daquele semestre.
function condicaoSemestre(semestre, params) {
    params.push(semestre);
    return `AND replace(p.semctr, '/', '-') = replace($${params.length}, '/', '-')`;
}

// ==========================================
// RESUMO — cards do topo (total de alunos, valor, distribuição por faixa)
// ==========================================
router.get('/resumo', verifyToken, checkPermission, async (req, res) => {
    const { curso, semestre } = req.query;
    try {
        const params = [];
        let where = `WHERE p.stactr = 'Aberto' AND p.venctr < current_date`;
        if (curso) { params.push(curso); where += ` AND c.codcur = $${params.length}`; }
        if (semestre) { where += ` ${condicaoSemestre(semestre, params)}`; }

        const { rows } = await edubox.query(`
            SELECT
                count(DISTINCT p.clictr) AS alunos,
                count(p.codctr) AS parcelas,
                coalesce(sum(p.valctr), 0) AS valor_total,
                count(DISTINCT p.clictr) FILTER (WHERE (current_date - p.venctr) BETWEEN 1 AND 30) AS alunos_1_30,
                count(DISTINCT p.clictr) FILTER (WHERE (current_date - p.venctr) BETWEEN 31 AND 60) AS alunos_31_60,
                count(DISTINCT p.clictr) FILTER (WHERE (current_date - p.venctr) BETWEEN 61 AND 90) AS alunos_61_90,
                count(DISTINCT p.clictr) FILTER (WHERE (current_date - p.venctr) > 90) AS alunos_90_mais,
                coalesce(sum(p.valctr) FILTER (WHERE (current_date - p.venctr) BETWEEN 1 AND 30), 0) AS valor_1_30,
                coalesce(sum(p.valctr) FILTER (WHERE (current_date - p.venctr) BETWEEN 31 AND 60), 0) AS valor_31_60,
                coalesce(sum(p.valctr) FILTER (WHERE (current_date - p.venctr) BETWEEN 61 AND 90), 0) AS valor_61_90,
                coalesce(sum(p.valctr) FILTER (WHERE (current_date - p.venctr) > 90), 0) AS valor_90_mais
            FROM tfi_ctreceber p
            ${JOIN_CURSO}
            ${where}
        `, params);
        res.json(rows[0]);
    } catch (err) {
        console.error('[cobranca] Erro ao buscar resumo:', err);
        res.status(500).json({ error: 'Não foi possível carregar o resumo de inadimplência.' });
    }
});

// ==========================================
// FILTROS — cursos e semestres com pelo menos 1 parcela vencida em aberto
// ==========================================
router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { rows } = await edubox.query(`
            SELECT DISTINCT c.codcur, trim(c.descur) AS nome
            FROM tfi_ctreceber p
            ${JOIN_CURSO}
            WHERE p.stactr = 'Aberto' AND p.venctr < current_date
            ORDER BY nome
        `);
        res.json(rows);
    } catch (err) {
        console.error('[cobranca] Erro ao listar cursos:', err);
        res.status(500).json({ error: 'Não foi possível carregar os cursos.' });
    }
});

router.get('/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        // replace('-','/') aqui pra casar com a normalização de condicaoSemestre()
        // e não mostrar "2026/2" e "2026-2" como duas opções diferentes no filtro.
        const { rows } = await edubox.query(`
            SELECT DISTINCT replace(p.semctr, '-', '/') AS semestre
            FROM tfi_ctreceber p
            ${JOIN_CURSO}
            WHERE p.stactr = 'Aberto' AND p.venctr < current_date AND p.semctr IS NOT NULL
            ORDER BY semestre DESC
        `);
        res.json(rows.map(r => r.semestre));
    } catch (err) {
        console.error('[cobranca] Erro ao listar semestres:', err);
        res.status(500).json({ error: 'Não foi possível carregar os semestres.' });
    }
});

// ==========================================
// PARCELAS — lista de alunos inadimplentes (agrupado por aluno+curso),
// com a ação de cobrança mais recente já registrada no Firestore.
// Exige pelo menos curso OU semestre selecionado (o botão de gerar
// relatório no frontend não libera sem isso) — evita martelar o pool de 5
// conexões do Edubox com todo mundo abrindo a tela ao mesmo tempo sem
// nenhum filtro, igual já feito no módulo Matrículas.
// ==========================================
router.get('/parcelas', verifyToken, checkPermission, async (req, res) => {
    const { curso, semestre, faixa, busca, pagina } = req.query;
    if (!curso && !semestre) {
        return res.status(400).json({ error: 'Selecione ao menos um curso ou semestre para gerar a lista.' });
    }
    try {
        const params = [];
        let where = `WHERE p.stactr = 'Aberto' AND p.venctr < current_date`;
        if (curso) { params.push(curso); where += ` AND c.codcur = $${params.length}`; }
        if (semestre) { where += ` ${condicaoSemestre(semestre, params)}`; }
        if (busca) { params.push(`%${busca}%`); where += ` AND cli.nomcli ILIKE $${params.length}`; }

        const having = condicaoFaixaHaving(faixa, params);
        const pageNum = Math.max(1, parseInt(pagina, 10) || 1);
        const offset = (pageNum - 1) * PAGE_SIZE;

        const { rows } = await edubox.query(`
            SELECT
                cli.codcli,
                trim(cli.nomcli) AS nome,
                cli.cpfcli AS cpf,
                coalesce(cli.celcli, cli.foncli) AS contato,
                c.codcur,
                trim(c.descur) AS curso,
                count(p.codctr) AS parcelas,
                sum(p.valctr) AS valor_total,
                to_char(min(p.venctr), 'YYYY-MM-DD') AS vencimento_mais_antigo,
                max(current_date - p.venctr) AS dias_atraso
            FROM tfi_ctreceber p
            JOIN tfi_cliente cli ON cli.codcli = p.clictr
            ${JOIN_CURSO}
            ${where}
            GROUP BY cli.codcli, cli.nomcli, cli.cpfcli, cli.celcli, cli.foncli, c.codcur, c.descur
            ${having}
            ORDER BY dias_atraso DESC
            LIMIT ${PAGE_SIZE} OFFSET ${offset}
        `, params);

        // Ação mais recente por aluno (Firestore), só para os alunos desta
        // página — nunca lê a coleção inteira. Sem orderBy aqui de propósito
        // (evita depender de índice composto novo pra "in" + orderBy em
        // campo diferente) — a mais recente é escolhida em memória, sobre
        // no máximo PAGE_SIZE alunos por vez.
        const codclis = rows.map(r => r.codcli);
        const acoesPorCliente = new Map();
        if (codclis.length) {
            const snap = await db.collection(COL_ACOES)
                .where('codcli', 'in', codclis)
                .get();
            snap.forEach(doc => {
                const dados = doc.data();
                const atual = acoesPorCliente.get(dados.codcli);
                const criadoEmMs = dados.criadoEm && dados.criadoEm.toMillis ? dados.criadoEm.toMillis() : 0;
                const atualMs = atual && atual.criadoEm && atual.criadoEm.toMillis ? atual.criadoEm.toMillis() : -1;
                if (!atual || criadoEmMs > atualMs) acoesPorCliente.set(dados.codcli, dados);
            });
        }

        res.json(rows.map(r => ({ ...r, ultimaAcao: acoesPorCliente.get(r.codcli) || null })));
    } catch (err) {
        console.error('[cobranca] Erro ao listar parcelas:', err);
        res.status(500).json({ error: 'Não foi possível carregar a lista de inadimplência.' });
    }
});

// ==========================================
// AÇÕES DE COBRANÇA (Firestore) — contato, negociação, envio à advocacia,
// acordo judicial. O Edubox não tem NENHUM campo/tabela de controle
// jurídico (conferido em information_schema) — esse controle é só nosso.
// ==========================================
router.get('/acoes/:codcli', verifyToken, checkPermission, async (req, res) => {
    try {
        const codcli = parseInt(req.params.codcli, 10);
        if (!codcli) return res.status(400).json({ error: 'codcli inválido.' });
        const snap = await db.collection(COL_ACOES)
            .where('codcli', '==', codcli)
            .orderBy('criadoEm', 'desc')
            .get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        console.error('[cobranca] Erro ao buscar histórico de ações:', err);
        res.status(500).json({ error: err.message });
    }
});

const TIPOS_VALIDOS = ['contato', 'negociacao', 'enviado_advocacia', 'acordo_judicial', 'quitado_manual', 'outro'];

router.post('/acoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const { codcli, nomeAluno, tipo, escritorio, observacoes } = req.body;
        const codcliNum = parseInt(codcli, 10);
        if (!codcliNum) return res.status(400).json({ error: 'Informe o aluno (codcli).' });
        if (!TIPOS_VALIDOS.includes(tipo)) return res.status(400).json({ error: 'Tipo de ação inválido.' });

        const doc = {
            codcli: codcliNum,
            nomeAluno: (nomeAluno || '').toString().trim(),
            tipo,
            escritorio: (escritorio || '').toString().trim(),
            observacoes: (observacoes || '').toString().trim(),
            origem: 'manual',
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || '',
            criadoEm: admin.firestore.FieldValue.serverTimestamp()
        };
        const ref = await db.collection(COL_ACOES).add(doc);
        res.status(201).json({ id: ref.id, ...doc, criadoEm: new Date().toISOString() });
    } catch (err) {
        console.error('[cobranca] Erro ao registrar ação:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// IMPORTAR CSV — lista própria do financeiro de alunos já encaminhados à
// advocacia/em acordo judicial (não existe no Edubox, ver nota acima).
// Colunas esperadas: nome, cpf (opcional, usado pra achar o codcli no
// Edubox), escritorio, tipo (opcional, default enviado_advocacia),
// observacoes. Segue o mesmo padrão de dedup/batch write do importador de
// DP (`src/rotas/secretaria-dp.js`).
// ==========================================
router.post('/acoes/importar-csv', verifyToken, checkPermission, async (req, res) => {
    try {
        const { records } = req.body;
        if (!Array.isArray(records) || !records.length) {
            return res.status(400).json({ error: 'Nenhum registro para importar.' });
        }

        const cpfs = [...new Set(records.map(r => normalizarCpf(r.cpf)).filter(Boolean))];
        const clientesPorCpf = new Map();
        if (cpfs.length) {
            const { rows } = await edubox.query(`
                SELECT DISTINCT cli.codcli, cli.cpfcli, trim(cli.nomcli) AS nome
                FROM tfi_cliente cli
                JOIN tfi_ctreceber p ON p.clictr = cli.codcli
                ${JOIN_CURSO}
                WHERE regexp_replace(cli.cpfcli, '\\D', '', 'g') = ANY($1::text[])
            `, [cpfs]);
            rows.forEach(r => clientesPorCpf.set(r.cpfcli.replace(/\D/g, ''), r));
        }

        const paraGravar = [];
        const naoEncontrados = [];
        for (const rec of records) {
            const nome = (rec.nome || '').toString().trim();
            if (!nome) continue;
            const cpfNorm = normalizarCpf(rec.cpf);
            const cliente = cpfNorm ? clientesPorCpf.get(cpfNorm) : null;
            if (!cliente) naoEncontrados.push(nome);
            const tipo = ['enviado_advocacia', 'acordo_judicial'].includes(rec.tipo) ? rec.tipo : 'enviado_advocacia';
            paraGravar.push({
                codcli: cliente ? cliente.codcli : null,
                nomeAluno: cliente ? cliente.nome : nome,
                tipo,
                escritorio: (rec.escritorio || '').toString().trim(),
                observacoes: (rec.observacoes || '').toString().trim(),
                origem: 'csv',
                criadoPor: req.user.uid,
                criadoPorNome: req.user.name || req.user.email || '',
                criadoEm: admin.firestore.FieldValue.serverTimestamp()
            });
        }

        const chunks = [];
        for (let i = 0; i < paraGravar.length; i += 400) chunks.push(paraGravar.slice(i, i + 400));
        for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(dados => batch.set(db.collection(COL_ACOES).doc(), dados));
            await batch.commit();
        }

        res.status(201).json({
            message: 'Importação concluída!',
            gravados: paraGravar.length,
            semCpfEncontrado: naoEncontrados
        });
    } catch (err) {
        console.error('[cobranca] Erro ao importar CSV:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
