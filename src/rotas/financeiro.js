const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('licitacao');

const COL_FORNECEDORES = 'financeiro_fornecedores';
const COL_ITENS = 'financeiro_itens';

// ==========================================
// CURSOS (proxy somente-leitura de `courses`, já usada pelo Planejamento Acadêmico)
// ==========================================
router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    try {
        // Coleção pequena (dezenas de cursos) — filtra/ordena em memória em vez de
        // exigir índice composto do Firestore para where+orderBy em campos diferentes.
        const snap = await db.collection('courses').get();
        const cursos = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(c => c.active)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        res.json(cursos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// FORNECEDORES
// ==========================================
router.get('/fornecedores', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_FORNECEDORES).orderBy('nome').get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/fornecedores', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });

        const docRef = await db.collection(COL_FORNECEDORES).add({
            nome,
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid
        });
        res.status(201).json({ id: docRef.id, message: 'Fornecedor cadastrado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/fornecedores/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do fornecedor.' });

        await db.collection(COL_FORNECEDORES).doc(req.params.id).update({ nome });
        res.json({ message: 'Fornecedor atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/fornecedores/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_FORNECEDORES).doc(req.params.id).delete();
        res.json({ message: 'Fornecedor excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ITENS (licitação/cotações)
// ==========================================

function calcularCotacoes(cotacoesInput, quantidade, fornecedoresPorId) {
    if (!Array.isArray(cotacoesInput)) return [];
    return cotacoesInput
        .filter(c => c && c.fornecedorId && c.valorUnitario !== null && c.valorUnitario !== undefined && c.valorUnitario !== '')
        .map(c => {
            const valorUnitario = parseFloat(c.valorUnitario);
            const fornecedor = fornecedoresPorId[c.fornecedorId];
            return {
                fornecedorId: c.fornecedorId,
                fornecedorNome: fornecedor ? fornecedor.nome : (c.fornecedorNome || ''),
                valorUnitario,
                valorTotal: Math.round(valorUnitario * quantidade * 100) / 100
            };
        })
        .filter(c => !isNaN(c.valorUnitario) && c.valorUnitario >= 0);
}

router.get('/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cursoId } = req.query;
        if (!cursoId) return res.status(400).json({ error: 'Informe o cursoId.' });

        // Ordena em memória em vez de exigir índice composto do Firestore
        // (where + orderBy em campos diferentes) — volume por curso é modesto.
        const snap = await db.collection(COL_ITENS).where('cursoId', '==', cursoId).get();
        const itens = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.produto || '').localeCompare(b.produto || ''));
        res.json(itens);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/itens', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cursoId, curso, produto, quantidade, unidade, periodicidade, professor, linkReferencia } = req.body;
        if (!cursoId || !curso) return res.status(400).json({ error: 'Informe o curso.' });
        if (!produto || !produto.trim()) return res.status(400).json({ error: 'Informe o produto.' });

        const qtd = parseFloat(quantidade);
        const docRef = await db.collection(COL_ITENS).add({
            cursoId,
            curso,
            produto: produto.trim(),
            quantidade: !isNaN(qtd) && qtd > 0 ? qtd : 1,
            unidade: (unidade || '').trim(),
            periodicidade: (periodicidade || '').trim(),
            professor: (professor || '').trim(),
            linkReferencia: (linkReferencia || '').trim(),
            status: 'pendente',
            cotacoes: [],
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid,
            updatedAt: new Date().toISOString()
        });
        res.status(201).json({ id: docRef.id, message: 'Item cadastrado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { produto, quantidade, unidade, periodicidade, professor, linkReferencia, status } = req.body;
        const dados = { updatedAt: new Date().toISOString() };

        if (produto !== undefined) {
            if (!produto.trim()) return res.status(400).json({ error: 'Informe o produto.' });
            dados.produto = produto.trim();
        }
        if (quantidade !== undefined) {
            const qtd = parseFloat(quantidade);
            dados.quantidade = !isNaN(qtd) && qtd > 0 ? qtd : 1;
        }
        if (unidade !== undefined) dados.unidade = (unidade || '').trim();
        if (periodicidade !== undefined) dados.periodicidade = (periodicidade || '').trim();
        if (professor !== undefined) dados.professor = (professor || '').trim();
        if (linkReferencia !== undefined) dados.linkReferencia = (linkReferencia || '').trim();
        if (status !== undefined) {
            if (!['pendente', 'chegou'].includes(status)) return res.status(400).json({ error: 'Status inválido.' });
            dados.status = status;
        }

        // Se a quantidade mudou, recalcula o valorTotal das cotações já lançadas
        if (dados.quantidade !== undefined) {
            const doc = await db.collection(COL_ITENS).doc(req.params.id).get();
            if (!doc.exists) return res.status(404).json({ error: 'Item não encontrado.' });
            const cotacoesAtuais = doc.data().cotacoes || [];
            dados.cotacoes = cotacoesAtuais.map(c => ({
                ...c,
                valorTotal: Math.round(c.valorUnitario * dados.quantidade * 100) / 100
            }));
        }

        await db.collection(COL_ITENS).doc(req.params.id).update(dados);
        res.json({ message: 'Item atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/itens/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL_ITENS).doc(req.params.id).delete();
        res.json({ message: 'Item excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /itens/:id/cotacoes — substitui o array de cotações inteiro de uma vez
// (a tela edita todos os fornecedores num modal só e salva junto). valorTotal
// é sempre recalculado aqui, nunca confiado do cliente.
router.put('/itens/:id/cotacoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const itemDoc = await db.collection(COL_ITENS).doc(req.params.id).get();
        if (!itemDoc.exists) return res.status(404).json({ error: 'Item não encontrado.' });
        const item = itemDoc.data();

        const fornecedoresSnap = await db.collection(COL_FORNECEDORES).get();
        const fornecedoresPorId = {};
        fornecedoresSnap.forEach(d => { fornecedoresPorId[d.id] = { id: d.id, ...d.data() }; });

        const cotacoes = calcularCotacoes(req.body.cotacoes, item.quantidade, fornecedoresPorId);
        await db.collection(COL_ITENS).doc(req.params.id).update({
            cotacoes,
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Cotações salvas.', cotacoes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// RELATÓRIO
// ==========================================
router.get('/relatorio', verifyToken, checkPermission, async (req, res) => {
    try {
        const { cursoId } = req.query;
        let query = db.collection(COL_ITENS);
        if (cursoId) query = query.where('cursoId', '==', cursoId);
        const snap = await query.get();

        const porCurso = {}; // cursoId -> { curso, gastoTotal, economia, pendente, chegou }
        const rankingFornecedores = {}; // fornecedorNome -> vitórias
        let gastoTotalGeral = 0, economiaTotalGeral = 0, pendenteGeral = 0, chegouGeral = 0;

        snap.forEach(doc => {
            const item = doc.data();
            const cotacoes = item.cotacoes || [];

            if (!porCurso[item.cursoId]) {
                porCurso[item.cursoId] = { cursoId: item.cursoId, curso: item.curso, gastoTotal: 0, economia: 0, pendente: 0, chegou: 0 };
            }
            const c = porCurso[item.cursoId];

            if (item.status === 'chegou') { c.chegou++; chegouGeral++; }
            else { c.pendente++; pendenteGeral++; }

            if (cotacoes.length) {
                const valores = cotacoes.map(cot => cot.valorTotal);
                const menor = Math.min(...valores);
                const maior = Math.max(...valores);
                c.gastoTotal += menor;
                c.economia += (maior - menor);
                gastoTotalGeral += menor;
                economiaTotalGeral += (maior - menor);

                const vencedor = cotacoes.find(cot => cot.valorTotal === menor);
                if (vencedor) {
                    rankingFornecedores[vencedor.fornecedorNome] = (rankingFornecedores[vencedor.fornecedorNome] || 0) + 1;
                }
            }
        });

        res.json({
            porCurso: Object.values(porCurso).map(c => ({
                ...c,
                gastoTotal: Math.round(c.gastoTotal * 100) / 100,
                economia: Math.round(c.economia * 100) / 100
            })),
            rankingFornecedores: Object.entries(rankingFornecedores)
                .map(([nome, vitorias]) => ({ nome, vitorias }))
                .sort((a, b) => b.vitorias - a.vitorias),
            geral: {
                gastoTotal: Math.round(gastoTotalGeral * 100) / 100,
                economia: Math.round(economiaTotalGeral * 100) / 100,
                pendente: pendenteGeral,
                chegou: chegouGeral
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
