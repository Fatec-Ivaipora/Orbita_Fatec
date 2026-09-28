const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const agenda = require('./comercial-agenda');

// ==========================================
// AULÕES / REDAÇÕES (Comercial) — agenda de visitas aos colégios (aulão de
// redação, palestra, aulão ENEM...), no formato da aba "AULÕES - REDAÇÃO" da
// planilha CONNECT 2026: data, turno, colégio, cidade. Todo o setor vê e
// edita. Busca sempre por intervalo no MESMO campo `data` (sem índice
// composto) e só depois que a pessoa escolhe o período.
// ==========================================
const checkPermission = verifyToken.requireModulePermission('auloes');
const COL = 'comercial_auloes';
const STATUS = ['agendado', 'realizado', 'cancelado'];
const TURNOS = ['MANHÃ', 'TARDE', 'NOITE', 'MANHÃ E TARDE', 'TARDE E NOITE', 'DIA TODO'];

const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const maiusculo = (v, max = 200) => texto(v, max).toUpperCase();
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const hora = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : '');

function quemFez(req) {
    return req.user.name || req.user.email || '';
}

function camposDoBody(body) {
    const turno = maiusculo(body.turno, 30);
    return {
        data: data(body.data),
        turno: TURNOS.includes(turno) ? turno : '',
        horario: hora(body.horario),
        colegio: maiusculo(body.colegio, 120),
        cidade: texto(body.cidade, 80),
        tipo: texto(body.tipo, 60),
        turma: texto(body.turma, 60),
        palestrante: texto(body.palestrante, 120),
        contatoColegio: texto(body.contatoColegio, 120),
        publicoEstimado: Number.isFinite(Number(body.publicoEstimado)) && body.publicoEstimado !== '' ? Math.max(0, Math.round(Number(body.publicoEstimado))) : null,
        observacoes: texto(body.observacoes, 2000)
    };
}

// Responsáveis = pessoas do Comercial marcadas em "Quem vai". `responsavel`
// (texto) fica como nome(s) pra exibir/filtrar — e cobre registro antigo
// importado sem ninguém marcado.
async function responsaveisDoBody(body) {
    const responsaveis = await agenda.validarResponsaveis(body.responsaveisUids);
    return { responsaveis, responsavel: responsaveis.length ? responsaveis.map(r => r.nome).join(', ') : texto(body.responsavel, 120) };
}

// Mantém a atividade na agenda (Meu Espaço) de quem vai em dia com o aulão.
async function sincronizar(req, id, doc) {
    const detalhes = [
        doc.turno && `Turno: ${doc.turno}${doc.horario ? ` (${doc.horario})` : ''}`,
        doc.turma && `Turma(s): ${doc.turma}`,
        doc.palestrante && `Com: ${doc.palestrante}`,
        doc.contatoColegio && `Contato no colégio: ${doc.contatoColegio}`,
        doc.observacoes && `Obs.: ${doc.observacoes}`,
        'Agendado em Comercial › Aulões - Redações'
    ].filter(Boolean);
    const atividadeId = await agenda.sincronizarAtividade({
        atividadeId: doc.atividadeId || null,
        responsaveis: doc.responsaveis || [],
        ativo: doc.status !== 'cancelado',
        concluido: doc.status === 'realizado',
        titulo: `🎤 ${doc.tipo || 'Aulão'}: ${doc.colegio} – ${doc.cidade}`,
        descricao: detalhes.join('\n'),
        data: doc.data,
        hora: doc.horario || agenda.HORA_POR_TURNO[doc.turno],
        origem: { modulo: 'auloes', id },
        criadoPor: { uid: req.user.uid, nome: quemFez(req) }
    });
    if (atividadeId !== (doc.atividadeId || null)) {
        await db.collection(COL).doc(id).update({ atividadeId });
    }
    return atividadeId;
}

router.get('/equipe', verifyToken, checkPermission, async (req, res) => {
    try { res.json(await agenda.equipeComercial()); } catch (err) { res.status(500).json({ error: err.message }); }
});

function validar(c) {
    if (!c.data) return 'Informe a data.';
    if (!c.colegio) return 'Informe o colégio.';
    if (!c.cidade) return 'Informe a cidade.';
    return null;
}

// ?de=AAAA-MM-DD&ate=AAAA-MM-DD (ate opcional = "daqui pra frente")
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const de = data(req.query.de);
        const ate = data(req.query.ate);
        if (!de) return res.status(400).json({ error: 'Escolha o período.' });
        let q = db.collection(COL).where('data', '>=', de);
        if (ate) q = q.where('data', '<=', ate);
        const snap = await q.get();
        const ordemTurno = (t) => ['MANHÃ', 'MANHÃ E TARDE', 'DIA TODO', 'TARDE', 'TARDE E NOITE', 'NOITE'].indexOf(t);
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        lista.sort((a, b) => (a.data || '').localeCompare(b.data || '') || ordemTurno(a.turno) - ordemTurno(b.turno));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const campos = camposDoBody(req.body);
        const erro = validar(campos);
        if (erro) return res.status(400).json({ error: erro });
        const agora = new Date().toISOString();
        const doc = { ...campos, ...(await responsaveisDoBody(req.body)), status: 'agendado', atividadeId: null, createdAt: agora, createdBy: quemFez(req), updatedAt: agora, updatedBy: quemFez(req) };
        const ref = await db.collection(COL).add(doc);
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Agendamento não encontrado.' });
        const campos = camposDoBody(req.body);
        const erro = validar(campos);
        if (erro) return res.status(400).json({ error: erro });
        const upd = { ...campos, ...(await responsaveisDoBody(req.body)), updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        if (STATUS.includes(req.body.status)) upd.status = req.body.status;
        await ref.update(upd);
        const doc = { ...snap.data(), ...upd };
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id/status', verifyToken, checkPermission, async (req, res) => {
    try {
        const { status } = req.body;
        if (!STATUS.includes(status)) return res.status(400).json({ error: 'Situação inválida.' });
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Agendamento não encontrado.' });
        const upd = { status, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        await ref.update(upd);
        const doc = { ...snap.data(), ...upd };
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (snap.exists) await agenda.removerAtividade(snap.data().atividadeId);
        await ref.delete();
        res.json({ message: 'Agendamento removido.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
