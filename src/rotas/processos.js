const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
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

// Atividade coletiva (atribuída a várias pessoas de uma vez, ex.: tarefa que
// atravessa turnos) guarda `atribuidos` (array) em vez de `uid` (string) —
// essa função cobre os dois formatos num lugar só.
function souAtribuido(req, atividade) {
    if (atividade.uid === req.user.uid) return true;
    return Array.isArray(atividade.atribuidos) && atividade.atribuidos.includes(req.user.uid);
}

// Dono/atribuído da atividade, quem criou, ou o gestor (chefe do mesmo setor
// / ADM) — regra geral pra editar título/descrição, mudar status ou
// reagendar (drag-and-drop). Exclusão e adiar prazo têm regra própria, mais
// restrita — ver podeExcluirAtividade() e a checagem de prazo no PUT.
function podeGerenciarAtividade(req, atividade) {
    const souCriador = atividade.criadoPor === req.user.uid;
    const souGestorDoSetor = GESTOR_ROLES.includes(req.user.role) &&
        (req.user.role === 'adm_l1' || req.user.role === 'adm_l2' || atividade.setorId === req.user.setorId);
    return souAtribuido(req, atividade) || souCriador || souGestorDoSetor;
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
// QUADRO DE AVISOS (mural do setor, estilo post-it — Chefe de Setor/ADM
// deixam recados pra equipe. Cada setor só vê os próprios avisos.)
// ==========================================
const CORES_AVISO = ['amarelo', 'rosa', 'azul', 'verde', 'laranja'];

// Setor efetivo pra CONSULTAR avisos: gestor pode passar ?setorId= (chefe só
// o próprio, ADM qualquer um); funcionário comum sempre vê o próprio setor,
// sem escolha.
function resolveSetorConsulta(req) {
    const { role, setorId } = req.user;
    const alvo = req.query.setorId;
    if (alvo && GESTOR_ROLES.includes(role)) {
        if (role === 'chefe_setor' && alvo !== setorId) {
            const err = new Error('Você só pode ver avisos do seu próprio setor.');
            err.status = 403;
            throw err;
        }
        return alvo;
    }
    return setorId || null;
}

router.get('/avisos', verifyToken, async (req, res) => {
    try {
        const setorId = resolveSetorConsulta(req);
        if (!setorId) return res.json([]);
        const snap = await db.collection('avisos').where('setorId', '==', setorId).get();
        const avisos = [];
        snap.forEach(doc => avisos.push({ id: doc.id, ...doc.data() }));
        avisos.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(avisos);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/avisos', verifyToken, requireGestor, async (req, res) => {
    try {
        const texto = (req.body.texto || '').trim();
        if (!texto) return res.status(400).json({ error: 'Escreva o aviso antes de publicar.' });
        const cor = CORES_AVISO.includes(req.body.cor) ? req.body.cor : CORES_AVISO[0];
        const setorId = resolveSetorGestor(req);

        const data = {
            setorId,
            texto,
            cor,
            autorUid: req.user.uid,
            autorNome: req.user.name || req.user.email || '',
            createdAt: new Date().toISOString()
        };
        const docRef = await db.collection('avisos').add(data);
        res.status(201).json({ id: docRef.id, ...data });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Só quem publicou ou ADM pode remover — nem o resto da chefia do mesmo
// setor mexe no aviso de quem não é o autor.
router.delete('/avisos/:id', verifyToken, async (req, res) => {
    try {
        const docRef = db.collection('avisos').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Aviso não encontrado.' });
        const aviso = snap.data();
        const souAutor = aviso.autorUid === req.user.uid;
        const souAdmin = req.user.role === 'adm_l1' || req.user.role === 'adm_l2';
        if (!souAutor && !souAdmin) {
            return res.status(403).json({ error: 'Só quem publicou o aviso (ou um ADM) pode remover.' });
        }
        await docRef.delete();
        res.json({ message: 'Aviso removido.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ==========================================
// ATIVIDADES (tarefas avulsas do funcionário — o quadro Kanban)
// ==========================================

// Retorna as atividades da própria pessoa (uid), as coletivas em que ela
// está entre os atribuídos (ex.: tarefa dividida entre turnos — todo mundo
// vê a mesma atividade e o mesmo histórico), MAIS as que ela mesma atribuiu
// a outra pessoa (criadoPor) — assim quem atribui continua vendo o que
// delegou, e o que cada funcionário cria pra si mesmo só aparece pra ele.
router.get('/atividades', verifyToken, async (req, res) => {
    try {
        const [minhasSnap, coletivasSnap, delegadasSnap] = await Promise.all([
            db.collection('atividades').where('uid', '==', req.user.uid).get(),
            db.collection('atividades').where('atribuidos', 'array-contains', req.user.uid).get(),
            db.collection('atividades').where('criadoPor', '==', req.user.uid).get()
        ]);
        const porId = new Map();
        minhasSnap.forEach(doc => porId.set(doc.id, { id: doc.id, ...doc.data() }));
        coletivasSnap.forEach(doc => porId.set(doc.id, { id: doc.id, ...doc.data() }));
        delegadasSnap.forEach(doc => porId.set(doc.id, { id: doc.id, ...doc.data() }));
        res.json([...porId.values()]);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Cria uma tarefa avulsa. Sem `uids`/`uid` no body: cria pra si mesmo. Com
// uma pessoa: documento normal (`uid`). Com VÁRIAS pessoas: um único
// documento COMPARTILHADO (`atribuidos`) — todo mundo vê a mesma atividade,
// o mesmo status e o mesmo histórico de andamento (ex.: tarefa que atravessa
// turnos: o turno da noite precisa ver onde o turno do dia parou). Qualquer
// funcionário pode delegar pra qualquer outro, dentro ou fora do próprio
// setor/hierarquia (ex.: pedir algo direto pro TI ou pra Secretaria).
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
            titulo: titulo.trim(),
            descricao: (descricao || '').trim(),
            prazo,
            status: 'a_fazer',
            historico: [],
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

        const data = { ...base, atribuidos: uidsAlvo, setorId: null };
        const docRef = await db.collection('atividades').add(data);
        res.status(201).json({ id: docRef.id, ...data });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Reagenda uma atividade (muda o dia/horário) — usado pelo drag-and-drop
// entre os dias da agenda.
// Edita uma atividade (título/descrição/prazo) ou só reagenda (drag-and-drop
// manda só o prazo). Dono, criador, ou gestor do setor dela.
router.put('/atividades/:id', verifyToken, async (req, res) => {
    try {
        const { titulo, descricao, prazo } = req.body;

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
            // Quem só é atribuído (não foi quem criou) só pode ANTECIPAR o
            // prazo de uma atividade que outra pessoa colocou pra ela — adiar
            // exige pedir mais prazo pra quem atribuiu, não é decisão unilateral.
            const souApenasAtribuido = souAtribuido(req, atual) && atual.criadoPor !== req.user.uid;
            if (souApenasAtribuido && new Date(prazo) > new Date(atual.prazo)) {
                return res.status(403).json({ error: 'Essa atividade foi atribuída por outra pessoa — você só pode antecipar o prazo, não adiar. Peça mais prazo pra quem atribuiu.' });
            }
            data.prazo = prazo;
        }

        await docRef.update(data);
        res.json({ message: 'Atividade atualizada com sucesso!' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Adiciona uma entrada no histórico de andamento — nunca sobrescreve nem
// apaga entradas anteriores (de si mesmo ou de outra pessoa), só acrescenta.
// É assim que dá pra saber, numa atividade dividida entre turnos, onde cada
// um parou: "Junior: fiz até Agronomia" e depois "Maria: terminei o resto".
// Só quem está entre os atribuídos da atividade pode relatar o progresso
// dela — nem criador nem gestor escrevem em nome de quem executa.
router.post('/atividades/:id/andamento', verifyToken, async (req, res) => {
    try {
        const texto = (req.body.texto || '').trim();
        if (!texto) return res.status(400).json({ error: 'Escreva o andamento antes de salvar.' });

        const docRef = db.collection('atividades').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Atividade não encontrada.' });
        const atual = snap.data();
        if (!souAtribuido(req, atual)) {
            return res.status(403).json({ error: 'Só quem está atribuído à atividade pode relatar o andamento dela.' });
        }

        const entrada = {
            autorUid: req.user.uid,
            autorNome: req.user.name || req.user.email || '',
            texto,
            criadoEm: new Date().toISOString()
        };
        await docRef.update({
            historico: admin.firestore.FieldValue.arrayUnion(entrada),
            updatedAt: new Date().toISOString()
        });
        res.status(201).json(entrada);
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
