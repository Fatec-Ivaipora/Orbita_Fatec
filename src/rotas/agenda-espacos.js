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

// ---------- Agenda do coordenador (Meu Espaço) ----------
// Reserva de coordenador vira compromisso pontual na agenda dele (coleção
// `atividades`, a mesma do Meu Espaço), no dia/horário da reserva. Vale quando
// o próprio coordenador pede, ou quando a Secretaria lança e o "Responsável"
// bate com o nome de UM coordenador cadastrado (sem chute: nome ambíguo ou
// que não bate não vai pra agenda de ninguém). A atividade acompanha a
// reserva: editar atualiza; recusar/cancelar/excluir remove. A reserva guarda
// `atividadeId`/`coordenadorUid`; a atividade guarda `origem`.
const CARGOS_COORDENADOR = ['coordenador', 'coord_medicina'];
const PALAVRAS_IGNORADAS = new Set(['prof', 'profa', 'professor', 'professora', 'coord', 'coordenador', 'coordenadora',
    'coordenacao', 'dr', 'dra', 'de', 'da', 'do', 'das', 'dos', 'e', 'curso']);

function tokensNome(nome) {
    return (nome || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !PALAVRAS_IGNORADAS.has(t));
}

async function listaCoordenadores() {
    const snap = await db.collection('users').where('role', 'in', CARGOS_COORDENADOR).get();
    return snap.docs.filter(d => d.data().ativo !== false)
        .map(d => ({ uid: d.id, nome: d.data().name || d.data().email || '' }))
        .sort((a, b) => a.nome.localeCompare(b.nome));
}

// "SILVANA ZURLO", "Prof. Silvana Zurlo", "Coordenação de Enfermagem"...
// Aceita quando é o mesmo nome, quando 2+ palavras digitadas estão todas no
// nome do coordenador, ou (cadastro com 2+ palavras) todas as do cadastro
// estão no que foi digitado — e só UM coordenador bate.
function acharCoordenador(texto, coordenadores) {
    const t = tokensNome(texto);
    if (!t.length) return null;
    const candidatos = coordenadores.filter(c => {
        const n = tokensNome(c.nome);
        if (!n.length) return false;
        // Só o primeiro nome não basta ("Paulo", "Vanessa" existem em outros
        // setores) — precisa de nome + sobrenome, a não ser que o cadastro
        // seja de uma palavra só ("Patricia", "Coord Enfermagem").
        const mesmoNome = t.join(' ') === n.join(' ');
        return mesmoNome || (t.length >= 2 && t.every(x => n.includes(x))) || (n.length >= 2 && n.every(x => t.includes(x)));
    });
    return candidatos.length === 1 ? candidatos[0] : null;
}

function coordenadorDaReserva(r, coordenadores) {
    if (r.pedidoPor && r.pedidoPor.uid) {
        const c = coordenadores.find(x => x.uid === r.pedidoPor.uid);
        if (c) return c;
    }
    return acharCoordenador(r.responsavel, coordenadores);
}

async function sincronizarAgendaCoordenador(id, r, req, coordenadores) {
    coordenadores = coordenadores || await listaCoordenadores();
    const coord = ['confirmada', 'pendente'].includes(r.status) ? coordenadorDaReserva(r, coordenadores) : null;
    const col = db.collection('atividades');
    let ref = r.atividadeId ? col.doc(r.atividadeId) : null;
    let existe = ref ? (await ref.get()).exists : false;

    // saiu da agenda (recusada/cancelada/sem coordenador) ou trocou de coordenador
    if (existe && (!coord || r.coordenadorUid !== coord.uid)) {
        await ref.delete();
        existe = false;
        ref = null;
    }
    if (!coord) {
        if (r.atividadeId || r.coordenadorUid) await db.collection(COL).doc(id).update({ atividadeId: null, coordenadorUid: null });
        return null;
    }

    const agora = new Date().toISOString();
    const dados = {
        titulo: `${r.espaco} — ${r.evento}${r.status === 'pendente' ? ' (aguardando aprovação)' : ''}`,
        descricao: `Reserva na Agenda Interna · ${r.inicio}–${r.fim}${r.pessoas ? ` · ${r.pessoas} pessoas` : ''}${r.equipamentos ? ` · ${r.equipamentos}` : ''}`,
        prazo: new Date(`${r.data}T${r.inicio}:00-03:00`).toISOString(),
        tipo: 'pontual',
        uid: coord.uid,
        atribuidos: null,
        doSetor: false,
        origem: { modulo: 'agenda-espacos', id },
        updatedAt: agora
    };
    let atividadeId;
    if (existe) {
        await ref.update(dados); // status/histórico ficam como o coordenador deixou
        atividadeId = ref.id;
    } else {
        const novo = await col.add({
            ...dados, status: 'a_fazer', concluidoEm: null, historico: [],
            criadoPor: req.user.uid, criadoPorNome: quemFez(req), createdAt: agora
        });
        atividadeId = novo.id;
    }
    if (atividadeId !== r.atividadeId || coord.uid !== r.coordenadorUid) {
        await db.collection(COL).doc(id).update({ atividadeId, coordenadorUid: coord.uid });
    }
    return coord;
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

// Coordenadores (sugestão no campo "Responsável" — só quem lança pra outros).
router.get('/coordenadores', verifyToken, checkPermission, async (req, res) => {
    try { res.json(ehEditor(req) ? await listaCoordenadores() : []); } catch (err) { res.status(500).json({ error: err.message }); }
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

    const coordenadores = await listaCoordenadores();
    let coordenador = null;
    for (const r of criadas) {
        const c = await sincronizarAgendaCoordenador(r.id, r, req, coordenadores);
        if (c) coordenador = c.nome;
    }
    res.status(201).json({ criadas, avisos: descreverConflitos(avisos), coordenador });
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
        await sincronizarAgendaCoordenador(ref.id, { ...r, status: 'cancelada' }, req);
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
        const coord = await sincronizarAgendaCoordenador(ref.id, { ...snap.data(), ...upd }, req);
        res.json({ id: ref.id, ...snap.data(), ...upd, coordenador: coord ? coord.nome : null });
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
        await sincronizarAgendaCoordenador(ref.id, { ...r, ...upd }, req);
        res.json({ id: ref.id, ...r, ...upd });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const snap = await ref.get();
        if (snap.exists && snap.data().atividadeId) {
            const at = db.collection('atividades').doc(snap.data().atividadeId);
            if ((await at.get()).exists) await at.delete();
        }
        await ref.delete();
        res.json({ message: 'Reserva excluída.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.ESPACOS_INICIAIS = ESPACOS_INICIAIS;
module.exports.sincronizarAgendaCoordenador = sincronizarAgendaCoordenador;
module.exports.acharCoordenador = acharCoordenador;
module.exports.listaCoordenadores = listaCoordenadores;
