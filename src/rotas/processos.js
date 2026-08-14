const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const RECORRENCIAS = ['diaria', 'semanal', 'mensal', 'bimestral', 'semestral', 'anual', 'conforme_demanda'];
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

// ==========================================
// PROCESSOS (o "manual"/checklist fixo do setor)
// ==========================================

router.get('/', verifyToken, requireGestor, async (req, res) => {
    try {
        const setorId = resolveSetorGestor(req);
        const snap = await db.collection('processos')
            .where('setorId', '==', setorId)
            .where('ativo', '==', true)
            .get();
        const processos = [];
        snap.forEach(doc => processos.push({ id: doc.id, ...doc.data() }));
        processos.sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''));
        res.json(processos);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/', verifyToken, requireGestor, async (req, res) => {
    try {
        const { titulo, descricao, passos, recorrencia, atribuidos, setorId: setorIdBody } = req.body;

        if (!titulo || !titulo.trim()) return res.status(400).json({ error: 'Informe o título do processo.' });
        if (!RECORRENCIAS.includes(recorrencia)) return res.status(400).json({ error: 'Recorrência inválida.' });
        if (!Array.isArray(atribuidos) || atribuidos.length === 0) return res.status(400).json({ error: 'Atribua o processo a pelo menos 1 funcionário.' });

        // Chefe só cadastra no próprio setor; admin precisa informar setorId no body.
        let setorId;
        if (req.user.role === 'chefe_setor') {
            setorId = req.user.setorId;
        } else {
            setorId = setorIdBody;
            if (!setorId) return res.status(400).json({ error: 'Informe o setorId do processo.' });
        }

        const funcionariosSnap = await db.collection('users').where('setorId', '==', setorId).get();
        const uidsDoSetor = new Set(funcionariosSnap.docs.map(d => d.id));
        const invalido = atribuidos.find(uid => !uidsDoSetor.has(uid));
        if (invalido) return res.status(400).json({ error: 'Todos os atribuídos precisam pertencer ao mesmo setor do processo.' });

        const passosNormalizados = Array.isArray(passos)
            ? passos.map((p, i) => ({ ordem: i + 1, texto: String(p.texto || '').trim() })).filter(p => p.texto)
            : [];

        const now = new Date().toISOString();
        const data = {
            setorId,
            titulo: titulo.trim(),
            descricao: (descricao || '').trim(),
            passos: passosNormalizados,
            recorrencia,
            atribuidos,
            ativo: true,
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || '',
            createdAt: now,
            updatedAt: now
        };
        const docRef = await db.collection('processos').add(data);
        res.status(201).json({ id: docRef.id, ...data });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/:id', verifyToken, requireGestor, async (req, res) => {
    try {
        const docRef = db.collection('processos').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Processo não encontrado.' });
        const atual = snap.data();

        if (req.user.role === 'chefe_setor' && atual.setorId !== req.user.setorId) {
            return res.status(403).json({ error: 'Este processo não pertence ao seu setor.' });
        }

        const { titulo, descricao, passos, recorrencia, atribuidos } = req.body;
        const data = { updatedAt: new Date().toISOString() };

        if (titulo !== undefined) {
            if (!titulo.trim()) return res.status(400).json({ error: 'Título não pode ser vazio.' });
            data.titulo = titulo.trim();
        }
        if (descricao !== undefined) data.descricao = (descricao || '').trim();
        if (recorrencia !== undefined) {
            if (!RECORRENCIAS.includes(recorrencia)) return res.status(400).json({ error: 'Recorrência inválida.' });
            data.recorrencia = recorrencia;
        }
        if (passos !== undefined) {
            data.passos = Array.isArray(passos)
                ? passos.map((p, i) => ({ ordem: i + 1, texto: String(p.texto || '').trim() })).filter(p => p.texto)
                : [];
        }
        if (atribuidos !== undefined) {
            if (!Array.isArray(atribuidos) || atribuidos.length === 0) return res.status(400).json({ error: 'Atribua o processo a pelo menos 1 funcionário.' });
            const funcionariosSnap = await db.collection('users').where('setorId', '==', atual.setorId).get();
            const uidsDoSetor = new Set(funcionariosSnap.docs.map(d => d.id));
            const invalido = atribuidos.find(uid => !uidsDoSetor.has(uid));
            if (invalido) return res.status(400).json({ error: 'Todos os atribuídos precisam pertencer ao mesmo setor do processo.' });
            data.atribuidos = atribuidos;
        }

        await docRef.update(data);
        res.json({ message: 'Processo atualizado com sucesso!' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, requireGestor, async (req, res) => {
    try {
        const docRef = db.collection('processos').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Processo não encontrado.' });

        if (req.user.role === 'chefe_setor' && snap.data().setorId !== req.user.setorId) {
            return res.status(403).json({ error: 'Este processo não pertence ao seu setor.' });
        }

        // Soft delete — preserva o histórico de atividades já geradas/arquivadas.
        await docRef.update({ ativo: false, updatedAt: new Date().toISOString() });
        res.json({ message: 'Processo removido.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Qualquer funcionário: seus próprios processos (o "norte" de cada rotina),
// independente de ser gestor — referência somente leitura, sem CRUD.
// Gestor pode passar ?uid=<outro> para ver "como" aquele funcionário vê a
// própria tela, sem precisar logar/deslogar (chefe só dentro do próprio setor).
router.get('/meus', verifyToken, async (req, res) => {
    try {
        let uid = req.user.uid;
        const uidAlvo = req.query.uid;

        if (uidAlvo && uidAlvo !== req.user.uid) {
            if (!GESTOR_ROLES.includes(req.user.role)) {
                return res.status(403).json({ error: 'Apenas Chefe de Setor ou Administrador podem visualizar os processos de outro funcionário.' });
            }
            if (req.user.role === 'chefe_setor') {
                const alvoSnap = await db.collection('users').doc(uidAlvo).get();
                if (!alvoSnap.exists || alvoSnap.data().setorId !== req.user.setorId) {
                    return res.status(403).json({ error: 'Você só pode visualizar funcionários do seu próprio setor.' });
                }
            }
            uid = uidAlvo;
        }

        const snap = await db.collection('processos')
            .where('atribuidos', 'array-contains', uid)
            .where('ativo', '==', true)
            .get();
        const processos = [];
        snap.forEach(doc => processos.push({ id: doc.id, ...doc.data() }));
        processos.sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''));
        res.json(processos);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/setor/funcionarios', verifyToken, requireGestor, async (req, res) => {
    try {
        const setorId = resolveSetorGestor(req);
        const snap = await db.collection('users').where('setorId', '==', setorId).get();
        const funcionarios = [];
        snap.forEach(doc => {
            const d = doc.data();
            if (d.ativo === false) return;
            funcionarios.push({ uid: doc.id, name: d.name, email: d.email, role: d.role });
        });
        funcionarios.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        res.json(funcionarios);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ==========================================
// ATIVIDADES (tarefas avulsas do funcionário — o quadro Kanban)
// ==========================================

router.get('/atividades', verifyToken, async (req, res) => {
    try {
        const snap = await db.collection('atividades')
            .where('uid', '==', req.user.uid)
            .get();
        const atividades = [];
        snap.forEach(doc => atividades.push({ id: doc.id, ...doc.data() }));
        res.json(atividades);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Cria uma tarefa avulsa. Sem `uid` no body: cria pra si mesmo. Com `uid`
// de outra pessoa: só gestor pode, e só dentro do próprio setor (chefe) —
// admin também precisa ser gestor do setor de quem vai receber a tarefa.
router.post('/atividades', verifyToken, async (req, res) => {
    try {
        const { titulo, descricao, prazo } = req.body;
        if (!titulo || !titulo.trim()) return res.status(400).json({ error: 'Informe o título da atividade.' });

        let uidAlvo = req.user.uid;
        let setorIdAlvo = req.user.setorId || null;

        if (req.body.uid && req.body.uid !== req.user.uid) {
            if (!GESTOR_ROLES.includes(req.user.role)) {
                return res.status(403).json({ error: 'Apenas Chefe de Setor ou Administrador podem criar atividade para outra pessoa.' });
            }
            const alvoSnap = await db.collection('users').doc(req.body.uid).get();
            if (!alvoSnap.exists) return res.status(404).json({ error: 'Funcionário não encontrado.' });
            const alvo = alvoSnap.data();
            if (req.user.role === 'chefe_setor' && alvo.setorId !== req.user.setorId) {
                return res.status(403).json({ error: 'Você só pode atribuir atividades a funcionários do seu setor.' });
            }
            uidAlvo = req.body.uid;
            setorIdAlvo = alvo.setorId || null;
        }

        const abertasSnap = await db.collection('atividades')
            .where('uid', '==', uidAlvo)
            .where('status', '==', 'a_fazer')
            .get();

        const now = new Date().toISOString();
        const data = {
            uid: uidAlvo,
            setorId: setorIdAlvo,
            titulo: titulo.trim(),
            descricao: (descricao || '').trim(),
            prazo: prazo || null,
            status: 'a_fazer',
            ordem: abertasSnap.size,
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || '',
            concluidoEm: null,
            createdAt: now,
            updatedAt: now
        };
        const docRef = await db.collection('atividades').add(data);
        res.status(201).json({ id: docRef.id, ...data });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Exclui uma tarefa avulsa: o dono, quem criou, ou o gestor do setor dela.
router.delete('/atividades/:id', verifyToken, async (req, res) => {
    try {
        const docRef = db.collection('atividades').doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Atividade não encontrada.' });
        const atividade = snap.data();

        const souDono = atividade.uid === req.user.uid;
        const souCriador = atividade.criadoPor === req.user.uid;
        const souGestorDoSetor = GESTOR_ROLES.includes(req.user.role) &&
            (req.user.role === 'adm_l1' || req.user.role === 'adm_l2' || atividade.setorId === req.user.setorId);

        if (!souDono && !souCriador && !souGestorDoSetor) {
            return res.status(403).json({ error: 'Você não pode excluir essa atividade.' });
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
            if (atividade.uid !== req.user.uid) {
                const err = new Error('Você só pode mover suas próprias atividades.');
                err.status = 403;
                throw err;
            }

            const data = {
                status,
                concluidoEm: status === 'concluido' ? (atividade.concluidoEm || new Date().toISOString()) : null,
                updatedAt: new Date().toISOString()
            };

            // Trocou de coluna — entra ao final da coluna de destino
            if (status !== atividade.status) {
                const destinoSnap = await db.collection('atividades')
                    .where('uid', '==', req.user.uid)
                    .where('status', '==', status)
                    .get();
                data.ordem = destinoSnap.size;
            }

            t.update(docRef, data);
        });

        res.json({ message: 'Atividade atualizada com sucesso!' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Reordena as atividades dentro de uma mesma coluna (sequência de execução,
// sem afetar o status) — recebe a lista de ids já na ordem desejada.
router.put('/atividades/reordenar', verifyToken, async (req, res) => {
    try {
        const { status, ordenadas } = req.body;
        if (!['a_fazer', 'fazendo', 'concluido'].includes(status)) {
            return res.status(400).json({ error: 'Status inválido.' });
        }
        if (!Array.isArray(ordenadas) || !ordenadas.length) {
            return res.status(400).json({ error: 'Informe a lista de atividades ordenadas.' });
        }

        const batch = db.batch();
        for (let i = 0; i < ordenadas.length; i++) {
            const docRef = db.collection('atividades').doc(ordenadas[i]);
            const snap = await docRef.get();
            if (!snap.exists || snap.data().uid !== req.user.uid || snap.data().status !== status) {
                return res.status(403).json({ error: 'Uma ou mais atividades não pertencem a você ou não estão nesta coluna.' });
            }
            batch.update(docRef, { ordem: i, updatedAt: new Date().toISOString() });
        }
        await batch.commit();

        res.json({ message: 'Ordem atualizada com sucesso!' });
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
