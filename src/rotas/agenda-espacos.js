const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================
// AGENDA DE ESPAÇOS (Secretaria) — auditório e salas para eventos internos e
// externos. Substitui o documento "AGENDA INTERNA FATEC - 2026" (Word) que a
// Secretaria mantinha e todo mundo precisava pedir pra consultar.
//  - Secretaria + ADM (nível 3): criam, editam, cancelam, aprovam pedidos.
//  - Demais cargos (nível 2): consultam e podem SOLICITAR uma reserva, que
//    fica "pendente" até a Secretaria aprovar ou recusar.
// Choque de horário: mesmo espaço, mesmo dia, horários que se cruzam — uma
// reserva confirmada bloqueia; pendente só avisa. "Todas as salas" cruza
// com qualquer espaço. Busca sempre por intervalo no campo `data` (sem
// índice composto).
// ==========================================
const checkPermission = verifyToken.requireModulePermission('agenda-espacos');
// Quem só consulta (nível 2) também pode pedir reserva: roda a checagem de
// permissão como se fosse leitura (GET exige 2, POST exigiria 3).
function podeVer(req, res, next) {
    const metodo = req.method;
    req.method = 'GET';
    checkPermission(req, res, (err) => { req.method = metodo; next(err); });
}

const COL = 'agenda_espacos_reservas';
const DOC_ESPACOS = db.collection('config').doc('agenda_espacos');
const TODAS = 'Todas as salas';
const TIPOS = ['interno', 'externo'];
const STATUS = ['confirmada', 'pendente', 'recusada', 'cancelada'];
const ESPACOS_INICIAIS = [
    'Auditório',
    ...['01', '02', '03', '04', '05', '06', '07', '09', '10', '13', ...Array.from({ length: 17 }, (_, i) => String(21 + i))].map(n => `Sala ${n}`),
    'Lab. Informática 12', 'Lab. Informática 20', 'Laboratório de Arquitetura', 'Lab. Semio', 'Lab. Morfo', 'LF-MED',
    'M.A. 1', 'M.A. 2',
    ...Array.from({ length: 6 }, (_, i) => `Tutoria ${i + 1}`),
    TODAS
];

const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const dataOk = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const horaOk = (v) => (/^\d{2}:\d{2}$/.test(v || '') ? v : null);
const quemFez = (req) => req.user.name || req.user.email || '';
const ehEditor = (req) => ['adm_l1', 'adm_l2', 'sec'].includes(req.user.role) ||
    !!(req.user.permissoes && Number(req.user.permissoes['agenda-espacos']) >= 3);

async function listaEspacos() {
    const snap = await DOC_ESPACOS.get();
    return snap.exists && Array.isArray(snap.data().espacos) ? snap.data().espacos : ESPACOS_INICIAIS;
}

function camposDoBody(body) {
    const pessoas = Number(body.pessoas);
    return {
        espaco: texto(body.espaco, 80),
        inicio: horaOk(body.inicio),
        fim: horaOk(body.fim),
        evento: texto(body.evento, 150),
        tipo: TIPOS.includes(body.tipo) ? body.tipo : 'interno',
        responsavel: texto(body.responsavel, 120),
        setor: texto(body.setor, 120),
        pessoas: Number.isFinite(pessoas) && body.pessoas !== '' && body.pessoas !== null ? Math.max(0, Math.round(pessoas)) : null,
        limpeza: texto(body.limpeza, 80),
        equipamentos: texto(body.equipamentos, 300),
        observacoes: texto(body.observacoes, 2000),
        // Órgão externo: nº do ofício e contato de quem pediu (e-mail ou
        // WhatsApp) — usados na "Resposta ao ofício" gerada pela tela.
        oficio: texto(body.oficio, 40),
        contatoExterno: texto(body.contatoExterno, 120)
    };
}

function validar(c, datas, espacos) {
    if (!c.evento) return 'Informe o nome do evento.';
    if (!c.espaco || !espacos.includes(c.espaco)) return 'Escolha um espaço da lista.';
    if (!c.inicio || !c.fim) return 'Informe o horário de início e de fim.';
    if (c.fim <= c.inicio) return 'O horário de fim precisa ser depois do início.';
    if (!datas.length) return 'Informe a data.';
    if (datas.length > 120) return 'No máximo 120 datas de uma vez.';
    return null;
}

// Reservas que cruzam com (espaço, data, início–fim). `somenteConfirmadas`
// = só as que bloqueiam. Ignora a própria reserva (edição).
async function conflitos(espaco, data, inicio, fim, { ignorarId = null, somenteConfirmadas = false } = {}) {
    const snap = await db.collection(COL).where('data', '==', data).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r =>
        r.id !== ignorarId &&
        (somenteConfirmadas ? r.status === 'confirmada' : ['confirmada', 'pendente'].includes(r.status)) &&
        (r.espaco === espaco || r.espaco === TODAS || espaco === TODAS) &&
        r.inicio < fim && inicio < r.fim
    );
}

function descreverConflitos(lista) {
    return lista.map(r => `${r.data.split('-').reverse().join('/')} ${r.inicio}–${r.fim} · ${r.espaco} · ${r.evento}${r.status === 'pendente' ? ' (pedido pendente)' : ''}`);
}

// ---------- Espaços ----------
router.get('/espacos', verifyToken, checkPermission, async (req, res) => {
    try { res.json(await listaEspacos()); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/espacos', verifyToken, checkPermission, async (req, res) => {
    try {
        const lista = [...new Set((Array.isArray(req.body.espacos) ? req.body.espacos : []).map(e => texto(e, 80)).filter(Boolean))];
        if (!lista.length) return res.status(400).json({ error: 'A lista de espaços não pode ficar vazia.' });
        if (!lista.includes(TODAS)) lista.push(TODAS);
        await DOC_ESPACOS.set({ espacos: lista, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) }, { merge: true });
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- Reservas ----------
// ?de=AAAA-MM-DD&ate=AAAA-MM-DD
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const de = dataOk(req.query.de), ate = dataOk(req.query.ate);
        if (!de || !ate) return res.status(400).json({ error: 'Informe o período.' });
        const snap = await db.collection(COL).where('data', '>=', de).where('data', '<=', ate).get();
        const editor = ehEditor(req);
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            // recusado/cancelado só aparece pra quem edita e pra quem pediu
            .filter(r => ['confirmada', 'pendente'].includes(r.status) || editor || (r.pedidoPor && r.pedidoPor.uid === req.user.uid));
        lista.sort((a, b) => a.data.localeCompare(b.data) || a.inicio.localeCompare(b.inicio));
        res.json({ reservas: lista, podeEditar: editor });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pedidos aguardando (qualquer data) — janela "Pedidos" da Secretaria/ADM.
router.get('/pendentes', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehEditor(req)) return res.json([]);
        const snap = await db.collection(COL).where('status', '==', 'pendente').get();
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        lista.sort((a, b) => a.data.localeCompare(b.data) || a.inicio.localeCompare(b.inicio));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Disponibilidade de um dia (usado no formulário pra mostrar o que já tem).
router.get('/dia/:data', verifyToken, checkPermission, async (req, res) => {
    try {
        const data = dataOk(req.params.data);
        if (!data) return res.status(400).json({ error: 'Data inválida.' });
        const snap = await db.collection(COL).where('data', '==', data).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => ['confirmada', 'pendente'].includes(r.status)));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function criar(req, res, status) {
    const espacos = await listaEspacos();
    const campos = camposDoBody(req.body);
    const datas = [...new Set((Array.isArray(req.body.datas) ? req.body.datas : [req.body.data]).map(dataOk).filter(Boolean))].sort();
    const erro = validar(campos, datas, espacos);
    if (erro) return res.status(400).json({ error: erro });

    // Pedido: bloqueia se já tem reserva CONFIRMADA. Secretaria criando
    // direto: bloqueia se cruza com confirmada; pendente cruzando só avisa.
    const bloqueios = [];
    const avisos = [];
    for (const d of datas) {
        const c = await conflitos(campos.espaco, d, campos.inicio, campos.fim);
        c.forEach(r => (r.status === 'confirmada' ? bloqueios : avisos).push(r));
    }
    if (bloqueios.length) {
        return res.status(409).json({ error: 'Esse espaço já está reservado nesse horário.', conflitos: descreverConflitos(bloqueios) });
    }

    const agora = new Date().toISOString();
    const grupo = datas.length > 1 ? db.collection(COL).doc().id : null;
    const batch = db.batch();
    const criadas = [];
    datas.forEach(d => {
        const ref = db.collection(COL).doc();
        const doc = {
            ...campos, data: d, status, grupoId: grupo,
            // e-mail de quem pediu: a resposta de aceite/recusa já sai com destinatário no Gmail
            pedidoPor: status === 'pendente' ? { uid: req.user.uid, nome: quemFez(req), email: req.user.email || '' } : null,
            motivoRecusa: '',
            createdAt: agora, createdBy: quemFez(req), updatedAt: agora, updatedBy: quemFez(req)
        };
        batch.set(ref, doc);
        criadas.push({ id: ref.id, ...doc });
    });
    await batch.commit();
    res.status(201).json({ criadas, avisos: descreverConflitos(avisos) });
}

// Secretaria/ADM cria reserva confirmada (uma ou várias datas).
router.post('/', verifyToken, checkPermission, async (req, res) => {
    try { await criar(req, res, 'confirmada'); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Qualquer um que consulta pode pedir — fica pendente.
router.post('/pedidos', verifyToken, podeVer, async (req, res) => {
    try { await criar(req, res, 'pendente'); } catch (err) { res.status(500).json({ error: err.message }); }
});

// Quem pediu pode cancelar o próprio pedido enquanto está pendente.
router.delete('/pedidos/:id', verifyToken, podeVer, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Pedido não encontrado.' });
        const r = snap.data();
        if (r.status !== 'pendente' || !r.pedidoPor || r.pedidoPor.uid !== req.user.uid) {
            return res.status(403).json({ error: 'Só dá pra cancelar o próprio pedido enquanto ele está pendente.' });
        }
        await ref.update({ status: 'cancelada', updatedAt: new Date().toISOString(), updatedBy: quemFez(req) });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Reserva não encontrada.' });
        const espacos = await listaEspacos();
        const campos = camposDoBody(req.body);
        const data = dataOk(req.body.data) || snap.data().data;
        const erro = validar(campos, [data], espacos);
        if (erro) return res.status(400).json({ error: erro });
        if (snap.data().status === 'confirmada') {
            const c = await conflitos(campos.espaco, data, campos.inicio, campos.fim, { ignorarId: ref.id, somenteConfirmadas: true });
            if (c.length) return res.status(409).json({ error: 'Esse espaço já está reservado nesse horário.', conflitos: descreverConflitos(c) });
        }
        const upd = { ...campos, data, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        await ref.update(upd);
        res.json({ id: ref.id, ...snap.data(), ...upd });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Aprovar (confirmada), recusar (com motivo) ou cancelar.
router.patch('/:id/status', verifyToken, checkPermission, async (req, res) => {
    try {
        const { status } = req.body;
        if (!STATUS.includes(status)) return res.status(400).json({ error: 'Situação inválida.' });
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Reserva não encontrada.' });
        const r = snap.data();
        if (status === 'confirmada') {
            const c = await conflitos(r.espaco, r.data, r.inicio, r.fim, { ignorarId: ref.id, somenteConfirmadas: true });
            if (c.length) return res.status(409).json({ error: 'Não dá pra aprovar: o espaço já está reservado nesse horário.', conflitos: descreverConflitos(c) });
        }
        const upd = { status, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) };
        if (status === 'recusada') upd.motivoRecusa = texto(req.body.motivo, 300);
        if (status === 'confirmada' && r.status === 'pendente') { upd.aprovadoPor = quemFez(req); upd.aprovadoEm = upd.updatedAt; }
        await ref.update(upd);
        res.json({ id: ref.id, ...r, ...upd });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        await db.collection(COL).doc(req.params.id).delete();
        res.json({ message: 'Reserva excluída.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.ESPACOS_INICIAIS = ESPACOS_INICIAIS;
