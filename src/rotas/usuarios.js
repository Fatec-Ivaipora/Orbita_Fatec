const express = require('express');
const router = express.Router();
const { admin, db, auth } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// Gerência de acessos (permissões globais e por usuário) é exclusiva do ADM N1
const requireAdmL1 = (req, res, next) => {
    if (req.user?.role !== 'adm_l1') {
        return res.status(403).json({ error: 'Apenas o Administrador N1 pode gerenciar acessos.' });
    }
    next();
};

// ==========================================
// USUÁRIOS (users)
// ==========================================

// GET /api/usuarios/me - Retorna apenas os dados do usuário atual (seguro para não admins)
router.get('/me', verifyToken, async (req, res) => {
    try {
        const snap = await db.collection('users').doc(req.user.uid).get();
        res.json(snap.exists ? { uid: snap.id, ...snap.data() } : { 
            uid: req.user.uid,
            name: req.user.name || 'Visitante',
            email: req.user.email || '',
            role: 'visitante',
            ativo: true,
            nascimento: ''
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/usuarios/me/senha - Permite ao próprio usuário redefinir sua senha no Firebase Auth
router.put('/me/senha', verifyToken, async (req, res) => {
    try {
        const { senha, password } = req.body;
        const novaSenha = senha || password;

        if (!novaSenha || novaSenha.trim().length < 6) {
            return res.status(400).json({ error: 'A senha deve conter pelo menos 6 caracteres.' });
        }

        // Atualiza a senha no Firebase Auth utilizando o Admin SDK
        await auth.updateUser(req.user.uid, { password: novaSenha.trim() });

        // Atualiza o Firestore para remover a flag de primeiro acesso
        await db.collection('users').doc(req.user.uid).update({ primeiroAcesso: false });

        res.json({ success: true, message: 'Senha atualizada com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/usuarios
router.get('/', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const snap = await db.collection('users').get();
        const users = [];
        snap.forEach(doc => users.push({ uid: doc.id, ...doc.data() }));
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/usuarios - Cria no Firebase Auth e no Firestore
router.post('/', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const { nome, email, senha, role, curso } = req.body;

        // 1. Cria usuário no Firebase Authentication via Admin SDK
        const userRecord = await auth.createUser({
            email,
            password: senha,
            displayName: nome
        });

        // 2. Salva o documento no Firestore
        const userData = {
            uid: userRecord.uid,
            name: nome,
            email,
            role,
            // Curso vinculado só faz sentido pro Coordenador — é o que
            // restringe quais avaliações docentes ele cria/enxerga.
            curso: role === 'coordenador' ? (curso || null) : null,
            ativo: true,
            primeiroAcesso: true, // Força a troca de senha no primeiro acesso
            createdAt: new Date().toISOString(),
            createdBy: req.user.uid // req.user vem do verifyToken
        };
        await db.collection('users').doc(userRecord.uid).set(userData);
        
        res.status(201).json({ message: 'Usuário criado com sucesso!', user: userData });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// PUT /api/usuarios/:uid/role
router.put('/:uid/role', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const { role, curso } = req.body;
        // Curso vinculado só faz sentido pro Coordenador — limpa o campo ao
        // trocar pra qualquer outro cargo, senão um vínculo antigo poderia
        // vazar caso a pessoa volte a ser Coordenador depois.
        await db.collection('users').doc(req.params.uid).update({
            role,
            curso: role === 'coordenador' ? (curso || null) : null
        });
        res.json({ message: 'Nível atualizado com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/usuarios/:uid/permissoes - Permissões específicas do usuário
// (override por módulo; sempre vencem as do cargo). Só ADM N1.
router.put('/:uid/permissoes', verifyToken, requireAdmL1, async (req, res) => {
    try {
        const { permissoes } = req.body;
        if (permissoes === undefined || permissoes === null || typeof permissoes !== 'object' || Array.isArray(permissoes)) {
            return res.status(400).json({ error: 'permissoes deve ser um objeto { modulo: nivel }.' });
        }

        const entradas = Object.entries(permissoes);
        for (const [mod, nivel] of entradas) {
            if (typeof mod !== 'string' || !mod.trim()) {
                return res.status(400).json({ error: 'Nome de módulo inválido.' });
            }
            if (![1, 2, 3].includes(Number(nivel))) {
                return res.status(400).json({ error: `Nível inválido para "${mod}" — use 1 (Nenhum), 2 (Visualizar) ou 3 (Executar).` });
            }
        }

        const docRef = db.collection('users').doc(req.params.uid);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Usuário não encontrado.' });

        if (!entradas.length) {
            // Objeto vazio = restaurar padrão do cargo (remove o campo)
            await docRef.update({ permissoes: admin.firestore.FieldValue.delete() });
        } else {
            const normalizado = {};
            entradas.forEach(([mod, nivel]) => { normalizado[mod] = Number(nivel); });
            await docRef.update({ permissoes: normalizado });
        }

        res.json({ message: 'Permissões do usuário atualizadas com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/usuarios/:uid/status
router.put('/:uid/status', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const { ativo } = req.body;
        await db.collection('users').doc(req.params.uid).update({ ativo });
        res.json({ message: `Status atualizado com sucesso!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/usuarios/:uid
router.delete('/:uid', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        // Deleta do Firestore
        await db.collection('users').doc(req.params.uid).delete();
        // Opcional: Pode deletar do Auth também se quiser
        // await auth.deleteUser(req.params.uid);
        res.json({ message: 'Usuário removido do sistema.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// CARGOS (roles)
// ==========================================

router.get('/roles', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const snap = await db.collection('roles').get();
        const roles = [];
        snap.forEach(doc => roles.push({ id: doc.id, ...doc.data() }));
        res.json(roles);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/roles', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const { id, name } = req.body;
        const docRef = db.collection('roles').doc(id);
        const snap = await docRef.get();
        if (snap.exists) return res.status(400).json({ error: 'Este ID de cargo já existe.' });
        await docRef.set({ name });
        res.json({ message: 'Cargo criado com sucesso!' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/roles/:id', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        await db.collection('roles').doc(req.params.id).delete();
        res.json({ message: 'Cargo removido.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// PERMISSÕES GLOBAIS (config/permissions)
// ==========================================

router.get('/config/permissions', verifyToken, async (req, res) => {
    try {
        const snap = await db.collection('config').doc('permissions').get();
        res.json(snap.exists ? snap.data() : {});
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/config/permissions', verifyToken, requireAdmL1, async (req, res) => {
    try {
        await db.collection('config').doc('permissions').set(req.body);
        res.json({ message: 'Permissões atualizadas com sucesso!' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
