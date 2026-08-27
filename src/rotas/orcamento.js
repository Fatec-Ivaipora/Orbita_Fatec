const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('orcamento');

const COL_ORCAMENTOS = 'financeiro_orcamentos';
const COL_LANCAMENTOS = 'financeiro_orcamento_lancamentos';

function validarTexto(v, max = 120) {
    return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

function normalizarTexto(v) {
    return (v || '').toString().trim();
}

// ==========================================
// ORÇAMENTOS — verba prevista por setor/projeto (ex.: "Zeladoria 2026.2",
// "Medicina Veterinária - Equipamentos"), com totalGasto/saldo denormalizados
// no próprio doc e recalculados a cada lançamento — lista sem precisar somar
// lançamentos toda hora (mesmo motivo do incidente de cota do Licitação).
// Sem where() combinado com orderBy() de propósito — evita depender de
// índice composto novo no Firestore; filtro de status/setor é em memória
// sobre uma coleção pequena (dezenas de orçamentos por semestre).
// ==========================================
router.get('/orcamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { status, setor } = req.query;
        const snap = await db.collection(COL_ORCAMENTOS).orderBy('createdAt', 'desc').get();
        let orcamentos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (status && status !== 'todos') orcamentos = orcamentos.filter(o => o.status === status);
        if (setor) orcamentos = orcamentos.filter(o => o.setor === setor);
        res.json(orcamentos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/orcamentos/setores', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_ORCAMENTOS).get();
        const set = new Set();
        snap.forEach(doc => {
            const setor = doc.data().setor;
            if (setor) set.add(setor);
        });
        res.json([...set].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/orcamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = normalizarTexto(req.body.nome);
        const setor = normalizarTexto(req.body.setor);
        const semestre = normalizarTexto(req.body.semestre);
        const observacoes = normalizarTexto(req.body.observacoes);
        const valorPrevisto = Number(req.body.valorPrevisto);

        if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe um nome para o orçamento.' });
        if (!validarTexto(setor, 60)) return res.status(400).json({ error: 'Informe o setor/departamento.' });
        if (!Number.isFinite(valorPrevisto) || valorPrevisto <= 0) return res.status(400).json({ error: 'Informe um valor previsto válido, maior que zero.' });

        const docRef = await db.collection(COL_ORCAMENTOS).add({
            nome,
            setor,
            semestre: semestre || null,
            observacoes: observacoes || null,
            valorPrevisto,
            totalGasto: 0,
            saldo: valorPrevisto,
            status: 'aberto',
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid
        });
        res.status(201).json({ id: docRef.id, message: 'Orçamento criado com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/orcamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_ORCAMENTOS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Orçamento não encontrado.' });

        const atual = snap.data();
        const update = {};

        if (req.body.nome !== undefined) {
            const nome = normalizarTexto(req.body.nome);
            if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe um nome válido.' });
            update.nome = nome;
        }
        if (req.body.setor !== undefined) {
            const setor = normalizarTexto(req.body.setor);
            if (!validarTexto(setor, 60)) return res.status(400).json({ error: 'Informe o setor/departamento.' });
            update.setor = setor;
        }
        if (req.body.semestre !== undefined) update.semestre = normalizarTexto(req.body.semestre) || null;
        if (req.body.observacoes !== undefined) update.observacoes = normalizarTexto(req.body.observacoes) || null;
        if (req.body.status !== undefined) {
            if (!['aberto', 'encerrado'].includes(req.body.status)) return res.status(400).json({ error: 'Status inválido.' });
            update.status = req.body.status;
        }
        if (req.body.valorPrevisto !== undefined) {
            const valorPrevisto = Number(req.body.valorPrevisto);
            if (!Number.isFinite(valorPrevisto) || valorPrevisto <= 0) return res.status(400).json({ error: 'Informe um valor previsto válido, maior que zero.' });
            update.valorPrevisto = valorPrevisto;
            update.saldo = valorPrevisto - (atual.totalGasto || 0);
        }

        await ref.update(update);
        res.json({ message: 'Orçamento atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/orcamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const lancSnap = await db.collection(COL_LANCAMENTOS).where('orcamentoId', '==', req.params.id).limit(1).get();
        if (!lancSnap.empty) return res.status(400).json({ error: 'Este orçamento já tem gastos lançados — encerre-o em vez de excluir.' });

        await db.collection(COL_ORCAMENTOS).doc(req.params.id).delete();
        res.json({ message: 'Orçamento excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// LANÇAMENTOS — gastos dentro de um orçamento. Cada criação/edição/remoção
// atualiza totalGasto/saldo do orçamento numa transação. where('orcamentoId')
// sem orderBy combinado — não precisa de índice composto; ordenação por data
// é feita em memória (lista pequena por orçamento).
// ==========================================
router.get('/orcamentos/:id/lancamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_LANCAMENTOS).where('orcamentoId', '==', req.params.id).get();
        const lancamentos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
        res.json(lancamentos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/orcamentos/:id/lancamentos', verifyToken, checkPermission, async (req, res) => {
    try {
        const orcamentoId = req.params.id;
        const descricao = normalizarTexto(req.body.descricao);
        const fornecedor = normalizarTexto(req.body.fornecedor);
        const quantidade = req.body.quantidade !== undefined && req.body.quantidade !== '' ? Number(req.body.quantidade) : 1;
        const valorUnitario = Number(req.body.valorUnitario);
        const data = normalizarTexto(req.body.data) || new Date().toISOString().slice(0, 10);

        if (!validarTexto(descricao, 200)) return res.status(400).json({ error: 'Informe a descrição do gasto.' });
        if (!Number.isFinite(valorUnitario) || valorUnitario < 0) return res.status(400).json({ error: 'Informe um valor unitário válido.' });
        if (!Number.isFinite(quantidade) || quantidade <= 0) return res.status(400).json({ error: 'Quantidade deve ser maior que zero.' });

        const valorTotal = Math.round(quantidade * valorUnitario * 100) / 100;
        const orcamentoRef = db.collection(COL_ORCAMENTOS).doc(orcamentoId);
        const lancamentoRef = db.collection(COL_LANCAMENTOS).doc();

        await db.runTransaction(async (tx) => {
            const orcSnap = await tx.get(orcamentoRef);
            if (!orcSnap.exists) throw new Error('Orçamento não encontrado.');
            const orc = orcSnap.data();
            const novoTotalGasto = (orc.totalGasto || 0) + valorTotal;

            tx.set(lancamentoRef, {
                orcamentoId, descricao, fornecedor: fornecedor || null,
                quantidade, valorUnitario, valorTotal, data,
                createdAt: new Date().toISOString(),
                createdBy: req.user.uid
            });
            tx.update(orcamentoRef, {
                totalGasto: novoTotalGasto,
                saldo: orc.valorPrevisto - novoTotalGasto
            });
        });

        res.status(201).json({ id: lancamentoRef.id, message: 'Gasto lançado com sucesso.' });
    } catch (err) {
        res.status(err.message === 'Orçamento não encontrado.' ? 404 : 500).json({ error: err.message });
    }
});

router.put('/lancamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const lancamentoRef = db.collection(COL_LANCAMENTOS).doc(req.params.id);

        await db.runTransaction(async (tx) => {
            const lancSnap = await tx.get(lancamentoRef);
            if (!lancSnap.exists) throw new Error('Lançamento não encontrado.');
            const lanc = lancSnap.data();

            const orcamentoRef = db.collection(COL_ORCAMENTOS).doc(lanc.orcamentoId);
            const orcSnap = await tx.get(orcamentoRef);
            if (!orcSnap.exists) throw new Error('Orçamento não encontrado.');
            const orc = orcSnap.data();

            const descricao = req.body.descricao !== undefined ? normalizarTexto(req.body.descricao) : lanc.descricao;
            const fornecedor = req.body.fornecedor !== undefined ? normalizarTexto(req.body.fornecedor) : lanc.fornecedor;
            const quantidade = req.body.quantidade !== undefined ? Number(req.body.quantidade) : lanc.quantidade;
            const valorUnitario = req.body.valorUnitario !== undefined ? Number(req.body.valorUnitario) : lanc.valorUnitario;
            const data = req.body.data !== undefined ? normalizarTexto(req.body.data) : lanc.data;

            if (!validarTexto(descricao, 200)) throw new Error('Informe a descrição do gasto.');
            if (!Number.isFinite(valorUnitario) || valorUnitario < 0) throw new Error('Informe um valor unitário válido.');
            if (!Number.isFinite(quantidade) || quantidade <= 0) throw new Error('Quantidade deve ser maior que zero.');

            const valorTotalNovo = Math.round(quantidade * valorUnitario * 100) / 100;
            const novoTotalGasto = (orc.totalGasto || 0) - (lanc.valorTotal || 0) + valorTotalNovo;

            tx.update(lancamentoRef, { descricao, fornecedor: fornecedor || null, quantidade, valorUnitario, valorTotal: valorTotalNovo, data });
            tx.update(orcamentoRef, { totalGasto: novoTotalGasto, saldo: orc.valorPrevisto - novoTotalGasto });
        });

        res.json({ message: 'Lançamento atualizado.' });
    } catch (err) {
        res.status(err.message.includes('não encontrado') ? 404 : 400).json({ error: err.message });
    }
});

router.delete('/lancamentos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const lancamentoRef = db.collection(COL_LANCAMENTOS).doc(req.params.id);

        await db.runTransaction(async (tx) => {
            const lancSnap = await tx.get(lancamentoRef);
            if (!lancSnap.exists) throw new Error('Lançamento não encontrado.');
            const lanc = lancSnap.data();

            const orcamentoRef = db.collection(COL_ORCAMENTOS).doc(lanc.orcamentoId);
            const orcSnap = await tx.get(orcamentoRef);
            if (orcSnap.exists) {
                const orc = orcSnap.data();
                const novoTotalGasto = Math.max(0, (orc.totalGasto || 0) - (lanc.valorTotal || 0));
                tx.update(orcamentoRef, { totalGasto: novoTotalGasto, saldo: orc.valorPrevisto - novoTotalGasto });
            }
            tx.delete(lancamentoRef);
        });

        res.json({ message: 'Lançamento removido.' });
    } catch (err) {
        res.status(err.message.includes('não encontrado') ? 404 : 500).json({ error: err.message });
    }
});

module.exports = router;
