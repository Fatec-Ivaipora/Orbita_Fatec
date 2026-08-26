const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const GESTOR_ROLES = ['chefe_setor', 'adm_l1', 'adm_l2'];

// ==========================================
// HELPERS DE ACESSO POR SETOR
// ==========================================

// Resolve o setorId em que o usuário logado pode atuar como gestor
// (chefe: o próprio setor; adm: precisa informar ?setorId=).
function resolveSetorGestor(req) {
    const { role, setorId } = req.user;
    if (role === 'adm_l1' || role === 'adm_l2') {
        const alvo = req.query.setorId;
        if (!alvo) {
            const err = new Error('Informe ?setorId= para consultar como administrador.');
            err.status = 400;
            throw err;
        }
        return alvo;
    }
    if (role === 'chefe_setor') {
        if (!setorId) {
            const err = new Error('Chefe de Setor sem setor de atuação definido — contate o ADM.');
            err.status = 400;
            throw err;
        }
        return setorId;
    }
    const err = new Error('Apenas Chefe de Setor ou Administrador podem acessar este recurso.');
    err.status = 403;
    throw err;
}

function requireGestor(req, res, next) {
    if (!GESTOR_ROLES.includes(req.user.role)) {
        return res.status(403).json({ error: 'Apenas Chefe de Setor ou Administrador podem gerenciar processos.' });
    }
    next();
}

// Dono da atividade, quem criou, ou o gestor (chefe do mesmo setor / ADM) —
// regra geral pra editar título/descrição/andamento, mudar status ou
// reagendar (drag-and-drop). Exclusão e adiar prazo têm regra própria, mais
// restrita — ver podeExcluirAtividade() e a checagem de prazo no PUT.
function podeGerenciarAtividade(req, atividade) {
    const souDono = atividade.uid === req.user.uid;
    const souCriador = atividade.criadoPor === req.user.uid;
    const souGestorDoSetor = GESTOR_ROLES.includes(req.user.role) &&
        (req.user.role === 'adm_l1' || req.user.role === 'adm_l2' || atividade.setorId === req.user.setorId);
    return souDono || souCriador || souGestorDoSetor;
}

// Excluir é mais restrito que editar: quem só é dono (a atividade foi
// atribuída por outra pessoa) NÃO pode excluir — precisa pedir pra quem
// atribuiu (criador) ou pro gestor do setor. Só pode excluir direto quem
// criou a própria atividade (criadoPor === uid, iniciativa própria) ou é
// gestor.
function podeExcluirAtividade(req, atividade) {
    const souCriador = atividade.criadoPor === req.user.uid;
    const souGestorDoSetor = GESTOR_ROLES.includes(req.user.role) &&
        (req.user.role === 'adm_l1' || req.user.role === 'adm_l2' || atividade.setorId === req.user.setorId);
    return souCriador || souGestorDoSetor;
}


// Lista todo mundo ativo (não só o próprio setor) — usada só pra popular o
// seletor "Atribuir para" na hora de criar uma atividade pra outra pessoa.
// Qualquer funcionário logado pode consultar (nome/e-mail não é dado sensível
// aqui, já aparece em vários outros lugares do Órbita).
router.get('/pessoas', verifyToken, async (req, res) => {
    try {
        const snap = await db.collection('users').get();
        const pessoas = [];
        snap.forEach(doc => {
            const d = doc.data();
            if (d.ativo === false) return;
            pessoas.push({ uid: doc.id, name: d.name, email: d.email });
        });
        pessoas.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        res.json(pessoas);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ==========================================
// ATIVIDADES (tarefas avulsas do funcionário — o quadro Kanban)
// ==========================================

// Retorna as atividades da própria pessoa (uid) MAIS as que ela mesma
// atribuiu a outra pessoa (criadoPor) — assim quem atribui continua vendo o
// que delegou, e o que cada funcionário cria pra si mesmo só aparece pra ele.
router.get('/atividades', verifyToken, async (req, res) => {
    try {
        const [minhasSnap, delegadasSnap] = await Promise.all([
            db.collection('atividades').where('uid', '==', req.user.uid).get(),
            db.collection('atividades').where('criadoPor', '==', req.user.uid).get()
        ]);
        const porId = new Map();
        minhasSnap.forEach(doc => porId.set(doc.id, { id: doc.id, ...doc.data() }));
        delegadasSnap.forEach(doc => porId.set(doc.id, { id: doc.id, ...doc.data() }));
        res.json([...porId.values()]);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Cria uma tarefa avulsa. Sem `uids`/`uid` no body: cria pra si mesmo. Com
// uma ou mais pessoas: qualquer funcionário pode delegar pra qualquer outro
// — às vezes uma tarefa precisa especificamente de uma pessoa fora do
// próprio setor/hierarquia (ex.: pedir algo direto pro TI ou pra Secretaria),
// não só gestor atribuindo pra quem está abaixo dele. Quando marca mais de
// uma pessoa, cria um documento INDEPENDENTE por pessoa (cada uma só edita/
// exclui/reporta andamento do próprio — nunca do de outra), todos visíveis
// juntos pra quem criou através do `criadoPor` (GET /atividades já traz).
router.post('/atividades', verifyToken, async (req, res) => {
    try {
        const { titulo, descricao, prazo } = req.body;
        if (!titulo || !titulo.trim()) return res.status(400).json({ error: 'Informe o título da atividade.' });
        if (!prazo) return res.status(400).json({ error: 'Informe o dia/horário da atividade.' });

        const uidsBody = Array.isArray(req.body.uids) ? req.body.uids : (req.body.uid ? [req.body.uid] : []);
        const uidsAlvo = [...new Set(uidsBody.length ? uidsBody : [req.user.uid])];
        if (uidsAlvo.length > 50) return res.status(400).json({ error: 'Selecione no máximo 50 pessoas por vez.' });

        const outros = uidsAlvo.filter(uid => uid !== req.user.uid);
        const setorPorUid = { [req.user.uid]: req.user.setorId || null };
        if (outros.length) {
            const snaps = await db.getAll(...outros.map(uid => db.collection('users').doc(uid)));
            for (const snap of snaps) {
                if (!snap.exists || snap.data().ativo === false) {
                    return res.status(404).json({ error: 'Um dos funcionários selecionados não foi encontrado.' });
                }
                setorPorUid[snap.id] = snap.data().setorId || null;
            }
        }

        const now = new Date().toISOString();
        const base = {
            setorId: null,
            titulo: titulo.trim(),
            descricao: (descricao || '').trim(),
            prazo,
            status: 'a_fazer',
            andamento: '',
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || '',
            concluidoEm: null,
            createdAt: now,
            updatedAt: now
        };

        if (uidsAlvo.length === 1) {
            const data = { ...base, uid: uidsAlvo[0], setorId: setorPorUid[uidsAlvo[0]] };
            const docRef = await db.collection('atividades').add(data);
            return res.status(201).json({ id: docRef.id, ...data });
        }

        const batch = db.batch();
        const criadas = [];
        uidsAlvo.forEach(uid => {
            const data = { ...base, uid, setorId: setorPorUid[uid] };
            const ref = db.collection('atividades').doc();
            batch.set(ref, data);
            criadas.push({ id: ref.id, ...data });
        });
        await batch.commit();
        res.status(201).json({ criadas });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Reagenda uma atividade (muda o dia/horário) — usado pelo drag-and-drop
// entre os dias da agenda.
// Edita uma atividade (título/descrição/prazo) ou só reagenda (drag-and-drop
// manda só o prazo). Dono, criador, ou gestor do setor dela.
router.put('/atividades/:id', verifyToken, async (req, res) => {
    try {
        const { titulo, descricao, prazo, andamento } = req.body;

        const docRef = db.collection('atividades').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Atividade não encontrada.' });
        const atual = snap.data();
        if (!podeGerenciarAtividade(req, atual)) {
            return res.status(403).json({ error: 'Você não pode editar essa atividade.' });
        }

        const data = { updatedAt: new Date().toISOString() };
        if (titulo !== undefined) {
            if (!titulo.trim()) return res.status(400).json({ error: 'Título não pode ser vazio.' });
            data.titulo = titulo.trim();
        }
        if (descricao !== undefined) data.descricao = (descricao || '').trim();
        if (prazo !== undefined) {
            if (!prazo) return res.status(400).json({ error: 'Informe o dia/horário da atividade.' });
            // Quem só é dono (não foi quem atribuiu) só pode ANTECIPAR o prazo
            // de uma atividade que outra pessoa colocou pra ela — adiar exige
            // pedir mais prazo pra quem atribuiu, não é decisão unilateral dela.
            const souApenasDono = atual.uid === req.user.uid && atual.criadoPor !== atual.uid;
            if (souApenasDono && new Date(prazo) > new Date(atual.prazo)) {
                return res.status(403).json({ error: 'Essa atividade foi atribuída por outra pessoa — você só pode antecipar o prazo, não adiar. Peça mais prazo pra quem atribuiu.' });
            }
            data.prazo = prazo;
        }
        // Nota de progresso que quem executa a tarefa vai preenchendo — não é
        // a descrição original (o que precisa ser feito), é o "como está indo".
        if (andamento !== undefined) data.andamento = (andamento || '').trim();

        await docRef.update(data);
        res.json({ message: 'Atividade atualizada com sucesso!' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Exclui uma tarefa avulsa: quem criou (seja pra si mesmo ou atribuindo a
// outra pessoa), ou o gestor do setor dela. Quem só é dono de uma atividade
// atribuída por outra pessoa NÃO pode excluir direto — precisa pedir pra
// quem atribuiu (o card já mostra "De: fulano" pra saber pra quem pedir).
router.delete('/atividades/:id', verifyToken, async (req, res) => {
    try {
        const docRef = db.collection('atividades').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Atividade não encontrada.' });
        if (!podeExcluirAtividade(req, snap.data())) {
            return res.status(403).json({ error: 'Essa atividade foi atribuída por outra pessoa — só quem atribuiu ou seu gestor pode excluir. Peça pra ela.' });
        }

        await docRef.delete();
        res.json({ message: 'Atividade excluída.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/atividades/:id/status', verifyToken, async (req, res) => {
    try {
        const { status } = req.body;
        if (!['a_fazer', 'fazendo', 'concluido'].includes(status)) {
            return res.status(400).json({ error: 'Status inválido.' });
        }

        const docRef = db.collection('atividades').doc(req.params.id);
        await db.runTransaction(async (t) => {
            const snap = await t.get(docRef);
            if (!snap.exists) {
                const err = new Error('Atividade não encontrada.');
                err.status = 404;
                throw err;
            }
            const atividade = snap.data();
            if (!podeGerenciarAtividade(req, atividade)) {
                const err = new Error('Você não pode mover essa atividade.');
                err.status = 403;
                throw err;
            }

            const data = {
                status,
                concluidoEm: status === 'concluido' ? (atividade.concluidoEm || new Date().toISOString()) : null,
                updatedAt: new Date().toISOString()
            };

            t.update(docRef, data);
        });

        res.json({ message: 'Atividade atualizada com sucesso!' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/setor/atividades', verifyToken, requireGestor, async (req, res) => {
    try {
        const setorId = resolveSetorGestor(req);
        const funcionariosSnap = await db.collection('users').where('setorId', '==', setorId).get();
        const funcionarios = funcionariosSnap.docs
            .filter(d => d.data().ativo !== false)
            .map(d => ({ uid: d.id, name: d.data().name, email: d.data().email }));

        const snap = await db.collection('atividades')
            .where('setorId', '==', setorId)
            .get();

        const porUid = {};
        snap.forEach(doc => {
            const a = { id: doc.id, ...doc.data() };
            if (!porUid[a.uid]) porUid[a.uid] = [];
            porUid[a.uid].push(a);
        });

        res.json({ funcionarios, atividadesPorUid: porUid });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/setor/progresso', verifyToken, requireGestor, async (req, res) => {
    try {
        const setorId = resolveSetorGestor(req);
        const funcionariosSnap = await db.collection('users').where('setorId', '==', setorId).get();
        const funcionarios = funcionariosSnap.docs
            .filter(d => d.data().ativo !== false)
            .map(d => ({ uid: d.id, name: d.data().name }));

        const progresso = [];
        for (const f of funcionarios) {
            const atuaisSnap = await db.collection('atividades')
                .where('uid', '==', f.uid)
                .get();
            const total = atuaisSnap.size;
            const concluidas = atuaisSnap.docs.filter(d => d.data().status === 'concluido').length;

            progresso.push({ uid: f.uid, nome: f.name, total, concluidas });
        }

        progresso.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));
        res.json(progresso);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
