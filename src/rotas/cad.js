const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================================================
// CADD — Conselho Acadêmico de Desempenho Discente (13/10/2026).
// Lê do Firestore o que scripts/cad-edubox-sync.js grava a partir do Edubox (nota, composição e
// faltas de cada aluno ativo por disciplina e bimestre; desempenho do aluno ao longo dos semestres)
// e guarda o que é do Órbita: o HISTÓRICO DE ATENDIMENTO de cada aluno (registros com observação e
// intervenção, editáveis), que acompanha o aluno de um semestre pro outro (chave = código do aluno).
//
// Quem vê o quê (mesma regra do Relatório CPA): ADM N1/N2 veem todas as turmas; coordenador só os
// cursos do próprio cadastro; Coordenação Medicina só Medicina. Editar/excluir um registro: quem
// escreveu ou ADM. Contém nome de aluno: nada disso sai do sistema sem login.
// ==========================================================================
const checkPermission = verifyToken.requireModulePermission('cad');
const { escopoDe, podeVer } = require('./cpa')._interno;
const COL_ATEND = 'cad_atendimentos';
const ADM = ['adm_l1', 'adm_l2'];

const texto = (v, max) => String(v || '').trim().slice(0, max);

// GET /api/cad/ciclos — semestres, bimestres e as turmas que a pessoa pode ver
router.get('/ciclos', verifyToken, checkPermission, async (req, res) => {
    try {
        const escopo = await escopoDe(req);
        const snap = await db.collection('cad_ciclos').get();
        const ciclos = snap.docs.map(d => d.data())
            .map(c => ({ ...c, turmas: (c.turmas || []).filter(t => podeVer(escopo, t.codcur)) }))
            .filter(c => c.turmas.length)
            .sort((a, b) => String(b.semestre).localeCompare(String(a.semestre)));
        const cfg = await db.collection('config').doc('cad_sync').get();
        res.json({ ciclos, escopo: escopo === null ? 'todos' : 'cursos', atualizadoEm: cfg.exists ? cfg.data().ultimaAtualizacao : null, status: cfg.exists ? cfg.data() : {}, uid: req.user.uid, adm: ADM.includes(req.user.role) });
    } catch (err) {
        console.error('[cad] ciclos:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cad/turma/:id — alunos x disciplinas da turma + quantos atendimentos cada aluno tem no semestre
router.get('/turma/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection('cad_turmas').doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Turma não encontrada. Rode a sincronização do CADD.' });
        const t = snap.data();
        const escopo = await escopoDe(req);
        if (!podeVer(escopo, t.codcur)) return res.status(403).json({ error: 'Você não tem acesso a esta turma.' });
        const at = await db.collection(COL_ATEND).where('turmaId', '==', t.id).get();
        const atendimentosLista = at.docs.map(d => ({ id: d.id, ...d.data() }));
        const atendimentos = {};   // alu -> { n }
        atendimentosLista.forEach(a => { const k = String(a.alu); atendimentos[k] = { n: ((atendimentos[k] || {}).n || 0) + 1 }; });
        res.json({ ...t, atendimentos, atendimentosLista });
    } catch (err) {
        console.error('[cad] turma:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cad/aluno/:alu — desempenho do aluno nos semestres (gráfico) + histórico de atendimento
router.get('/aluno/:alu', verifyToken, checkPermission, async (req, res) => {
    try {
        const alu = String(req.params.alu);
        const [h, at] = await Promise.all([
            db.collection('cad_alunos').doc(alu).get(),
            db.collection(COL_ATEND).where('alu', '==', alu).get()
        ]);
        const escopo = await escopoDe(req);
        const hist = h.exists ? h.data() : null;
        if (hist && !podeVer(escopo, hist.codcur)) return res.status(403).json({ error: 'Você não tem acesso a este aluno.' });
        const atendimentos = at.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(a => podeVer(escopo, a.codcur))
            .sort((a, b) => String(b.data || b.em).localeCompare(String(a.data || a.em)));
        res.json({ historico: hist, atendimentos });
    } catch (err) {
        console.error('[cad] aluno:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/cad/status — de quando são os dados e se o PC do agente está ligado
router.get('/status', verifyToken, checkPermission, async (req, res) => {
    try {
        const d = await db.collection('config').doc('cad_sync').get();
        res.json(d.exists ? d.data() : {});
    } catch (err) {
        console.error('[cad] status:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/cad/atualizar — "Atualizar agora": o agente (scripts/cad-edubox-agente.js) escuta e atualiza
router.post('/atualizar', verifyToken, checkPermission, async (req, res) => {
    try {
        const pedidoEm = new Date().toISOString();
        await db.collection('config').doc('cad_sync').set({ pedidoEm, pedidoPor: req.user.uid, pedidoPorNome: req.user.name || req.user.email || '' }, { merge: true });
        res.json({ pedidoEm });
    } catch (err) {
        console.error('[cad] atualizar:', err);
        res.status(500).json({ error: err.message });
    }
});

async function turmaComAcesso(req, turmaId) {
    const tSnap = await db.collection('cad_turmas').doc(String(turmaId)).get();
    if (!tSnap.exists) return { erro: [404, 'Turma não encontrada.'] };
    const t = tSnap.data();
    if (!podeVer(await escopoDe(req), t.codcur)) return { erro: [403, 'Você não tem acesso a esta turma.'] };
    return { t };
}

// POST /api/cad/atendimento — novo registro { turmaId, fase, alunoId(matrícula), data, observacao, intervencao }
router.post('/atendimento', verifyToken, checkPermission, async (req, res) => {
    try {
        const { turmaId, fase, alunoId } = req.body;
        const { t, erro } = await turmaComAcesso(req, turmaId);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const aluno = (t.alunos || []).find(a => String(a.id) === String(alunoId));
        if (!aluno) return res.status(404).json({ error: 'Aluno não está nesta turma.' });
        const observacao = texto(req.body.observacao, 3000), intervencao = texto(req.body.intervencao, 1000);
        if (!observacao && !intervencao) return res.status(400).json({ error: 'Escreva a observação ou a intervenção.' });
        const data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '') ? req.body.data : new Date().toISOString().slice(0, 10);
        const dado = {
            alu: String(aluno.alu || aluno.id), matricula: String(aluno.id), aluno: aluno.nome, codcur: t.codcur, curso: t.curso,
            turmaId: t.id, turma: t.turma, semestre: t.semestre, fase: Number(fase) || null,
            data, observacao, intervencao,
            por: req.user.name || req.user.email || '', porUid: req.user.uid, em: new Date().toISOString()
        };
        const ref = await db.collection(COL_ATEND).add(dado);
        res.json({ message: 'Atendimento registrado.', atendimento: { id: ref.id, ...dado } });
    } catch (err) {
        console.error('[cad] novo atendimento:', err);
        res.status(500).json({ error: err.message });
    }
});

async function atendimentoEditavel(req, id) {
    const ref = db.collection(COL_ATEND).doc(String(id));
    const s = await ref.get();
    if (!s.exists) return { erro: [404, 'Registro não encontrado.'] };
    const a = s.data();
    if (!podeVer(await escopoDe(req), a.codcur)) return { erro: [403, 'Você não tem acesso a este aluno.'] };
    if (a.porUid !== req.user.uid && !ADM.includes(req.user.role)) return { erro: [403, 'Só quem registrou (ou a direção) pode alterar este atendimento.'] };
    return { ref, a };
}

// PUT /api/cad/atendimento/:id — editar (guarda quem editou e quando)
router.put('/atendimento/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { ref, a, erro } = await atendimentoEditavel(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const observacao = texto(req.body.observacao, 3000), intervencao = texto(req.body.intervencao, 1000);
        if (!observacao && !intervencao) return res.status(400).json({ error: 'Escreva a observação ou a intervenção.' });
        const mudanca = {
            observacao, intervencao,
            data: /^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '') ? req.body.data : a.data,
            editadoPor: req.user.name || req.user.email || '', editadoEm: new Date().toISOString()
        };
        await ref.update(mudanca);
        res.json({ message: 'Atendimento atualizado.', atendimento: { id: ref.id, ...a, ...mudanca } });
    } catch (err) {
        console.error('[cad] editar atendimento:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/cad/atendimento/:id
router.delete('/atendimento/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { ref, erro } = await atendimentoEditavel(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        await ref.delete();
        res.json({ message: 'Atendimento excluído.' });
    } catch (err) {
        console.error('[cad] excluir atendimento:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
