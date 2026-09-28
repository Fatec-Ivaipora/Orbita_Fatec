const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const agenda = require('./comercial-agenda');

// ==========================================
// PALESTRAS (Comercial) — agenda de palestras/ações da Fatec em colégios,
// empresas e secretarias, no formato da planilha "PALESTRAS FATEC" (aba
// 2026.2): instituição, cidade, data, horário, palestrante, tema e QUEM LEVA
// o palestrante (motorista). Quando quem leva é alguém do Comercial, vira
// atividade na agenda do Meu Espaço dessa pessoa (comercial-agenda.js).
// Palestra ainda sem data ("Agosto", "verificar") fica com `data: null` e
// aparece em todo período, no bloco "Data a definir".
// ==========================================
const checkPermission = verifyToken.requireModulePermission('palestras');
const COL = 'comercial_palestras';
const STATUS = ['agendada', 'realizada', 'cancelada'];
// comercial = alguém da equipe (responsaveis) | outro = motorista digitado |
// proprio = palestrante vai por conta | nao_necessario | verificar = a definir
const TRANSPORTE = ['comercial', 'outro', 'proprio', 'nao_necessario', 'verificar'];

const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const hora = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : '');

function quemFez(req) {
    return req.user.name || req.user.email || '';
}

async function camposDoBody(body) {
    const transporte = TRANSPORTE.includes(body.transporte) ? body.transporte : 'verificar';
    const responsaveis = transporte === 'comercial' ? await agenda.validarResponsaveis(body.responsaveisUids) : [];
    // Gente do Comercial envolvida por outro motivo (é quem palestra, apoia,
    // acompanha) — também ganha a palestra na agenda do Meu Espaço.
    const envolvidos = await agenda.validarResponsaveis(body.envolvidosUids);
    const c = {
        envolvidos,
        local: texto(body.local, 150),
        cidade: texto(body.cidade, 80),
        data: data(body.data),
        dataPrevista: texto(body.dataPrevista, 60),
        horario: texto(body.horario, 60),
        horaInicio: hora(body.horaInicio),
        palestrante: texto(body.palestrante, 150),
        tema: texto(body.tema, 250),
        transporte: transporte === 'comercial' && !responsaveis.length ? 'verificar' : transporte,
        responsaveis,
        motorista: transporte === 'comercial' ? responsaveis.map(r => r.nome).join(', ') : (transporte === 'outro' ? texto(body.motorista, 120) : ''),
        pagarDeslocamento: body.pagarDeslocamento === true,
        contatoLocal: texto(body.contatoLocal, 120),
        observacoes: texto(body.observacoes, 2000)
    };
    if (c.data) c.dataPrevista = '';
    return c;
}

function validar(c) {
    if (!c.local) return 'Informe a instituição/local.';
    if (!c.cidade) return 'Informe a cidade.';
    if (!c.data && !c.dataPrevista) return 'Informe a data (ou, se ainda não tiver, a previsão — ex.: "Novembro").';
    return null;
}

// Atividade na agenda (Meu Espaço) de todo mundo do Comercial envolvido:
// quem leva o palestrante + quem participa (palestra, apoia, acompanha).
async function sincronizar(req, id, doc) {
    const levam = doc.transporte === 'comercial' ? (doc.responsaveis || []) : [];
    const envolvidos = doc.envolvidos || [];
    const todos = [...new Map([...levam, ...envolvidos].map(p => [p.uid, p])).values()];
    // Só "levar" quando ninguém do Comercial participa da palestra em si
    // (se a Clevenice palestra E vai de carro, o compromisso dela é a palestra).
    const soLevam = !envolvidos.length;
    const detalhes = [
        doc.horario && `Horário: ${doc.horario}`,
        doc.palestrante && `Palestrante: ${doc.palestrante}`,
        doc.tema && `Tema: ${doc.tema}`,
        `Local: ${doc.local} – ${doc.cidade}`,
        levam.length && `Quem leva: ${levam.map(p => p.nome).join(', ')}`,
        envolvidos.length && `Do Comercial participa: ${envolvidos.map(p => p.nome).join(', ')}`,
        doc.contatoLocal && `Contato no local: ${doc.contatoLocal}`,
        doc.pagarDeslocamento && 'Pagar deslocamento ao palestrante',
        doc.observacoes && `Obs.: ${doc.observacoes}`,
        'Agendado em Comercial › Palestras'
    ].filter(Boolean);
    const atividadeId = await agenda.sincronizarAtividade({
        atividadeId: doc.atividadeId || null,
        responsaveis: todos,
        ativo: doc.status !== 'cancelada',
        concluido: doc.status === 'realizada',
        titulo: levam.length && soLevam
            ? `🚗 Levar ${doc.palestrante || 'palestrante'} → ${doc.local} (${doc.cidade})`
            : `🎤 Palestra: ${doc.tema || doc.palestrante || 'Fatec'} – ${doc.local} (${doc.cidade})`,
        descricao: detalhes.join('\n'),
        data: doc.data,
        hora: doc.horaInicio || '08:00',
        origem: { modulo: 'palestras', id },
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

// ?de=AAAA-MM-DD&ate=AAAA-MM-DD (ate opcional). Sempre inclui as sem data.
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const de = data(req.query.de);
        const ate = data(req.query.ate);
        if (!de) return res.status(400).json({ error: 'Escolha o período.' });
        let q = db.collection(COL).where('data', '>=', de);
        if (ate) q = q.where('data', '<=', ate);
        const [comData, semData] = await Promise.all([q.get(), db.collection(COL).where('data', '==', null).get()]);
        const lista = [...comData.docs, ...semData.docs].map(d => ({ id: d.id, ...d.data() }));
        lista.sort((a, b) => (a.data || '9999').localeCompare(b.data || '9999') || (a.horaInicio || '').localeCompare(b.horaInicio || ''));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const campos = await camposDoBody(req.body);
        const erro = validar(campos);
        if (erro) return res.status(400).json({ error: erro });
        const agora = new Date().toISOString();
        const doc = { ...campos, status: 'agendada', atividadeId: null, createdAt: agora, createdBy: quemFez(req), updatedAt: agora, updatedBy: quemFez(req) };
        const ref = await db.collection(COL).add(doc);
        doc.atividadeId = await sincronizar(req, ref.id, doc);
        res.status(201).json({ id: ref.id, ...doc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Palestra não encontrada.' });
        const campos = await camposDoBody(req.body);
        const erro = validar(campos);
        if (erro) return res.status(400).json({ error: erro });
        const upd = { ...campos, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
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
        if (!snap.exists) return res.status(404).json({ error: 'Palestra não encontrada.' });
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
        res.json({ message: 'Palestra removida.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.sincronizarImportacao = sincronizar;
