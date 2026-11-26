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

// Conta já é (ou vai virar) ADM N1 — esse cargo só pode ser concedido,
// alterado, desativado ou excluído por quem já é ADM N1. Sem essa trava, um
// ADM N2 se promovia pela própria tela/API (achado do relatório de
// segurança de 17/11).
const alvoEhAdmL1 = async (uid) => {
    const snap = await db.collection('users').doc(uid).get();
    return snap.exists && snap.data().role === 'adm_l1';
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

        // Fora do primeiro acesso, exige login recente (reautenticação) —
        // senão basta um token roubado/de sessão aberta pra trocar a senha
        // de outra pessoa (achado do relatório de segurança de 17/11). No
        // primeiro acesso o login acabou de acontecer, então não bloqueia.
        if (!req.user.primeiroAcesso) {
            const authTime = (req.user.auth_time || 0) * 1000;
            if (!authTime || (Date.now() - authTime) > 10 * 60 * 1000) {
                return res.status(401).json({ error: 'Faça login novamente antes de trocar a senha.', loginRecente: true });
            }
        }

        // Atualiza a senha no Firebase Auth utilizando o Admin SDK
        await auth.updateUser(req.user.uid, { password: novaSenha.trim() });

        // Atualiza o Firestore para remover a flag de primeiro acesso
        await db.collection('users').doc(req.user.uid).update({ primeiroAcesso: false });
        // libera na hora (sem esperar o cache de 1 min do middleware)
        if (verifyToken.limparCacheUsuario) verifyToken.limparCacheUsuario(req.user.uid);

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
        const { nome, email, senha, role, cursos } = req.body;

        if (role === 'adm_l1' && req.user.role !== 'adm_l1') {
            return res.status(403).json({ error: 'Apenas o Administrador N1 pode criar uma conta com esse cargo.' });
        }

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
            // Cursos vinculados só fazem sentido pro Coordenador — são os
            // que restringem em quais cursos ele cria avaliações docentes.
            // Um coordenador pode responder por mais de um curso, por isso
            // é sempre array (mesmo com um único item).
            cursos: role === 'coordenador' && Array.isArray(cursos) ? cursos.filter(Boolean) : [],
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
        const { role, cursos } = req.body;

        if (req.params.uid === req.user.uid) {
            return res.status(403).json({ error: 'Você não pode alterar o próprio cargo.' });
        }
        if (role === 'adm_l1' && req.user.role !== 'adm_l1') {
            return res.status(403).json({ error: 'Apenas o Administrador N1 pode conceder esse cargo.' });
        }
        if (req.user.role !== 'adm_l1' && await alvoEhAdmL1(req.params.uid)) {
            return res.status(403).json({ error: 'Apenas o Administrador N1 pode alterar uma conta ADM N1.' });
        }

        // Cursos vinculados só fazem sentido pro Coordenador — limpa o campo
        // ao trocar pra qualquer outro cargo, senão um vínculo antigo
        // poderia vazar caso a pessoa volte a ser Coordenador depois.
        await db.collection('users').doc(req.params.uid).update({
            role,
            cursos: role === 'coordenador' && Array.isArray(cursos) ? cursos.filter(Boolean) : [],
            // Campo antigo (uma era só 1 curso por coordenador) — remove pra
            // não deixar um valor desatualizado competindo com `cursos`.
            curso: admin.firestore.FieldValue.delete(),
            // Registro de quem trocou o cargo e quando (achado do relatório
            // de segurança de 17/11 — a troca não deixava rastro nenhum).
            roleAlteradoPor: req.user.uid,
            roleAlteradoEm: new Date().toISOString()
        });
        if (verifyToken.limparCacheUsuario) verifyToken.limparCacheUsuario(req.params.uid);
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
// PUT /api/usuarios/:uid/email { email } — troca o e-mail de login (26/11/2026). Só ADM (N1 e N2); conta ADM N1 só
// o ADM N1 troca. Muda no Firebase Auth (o login) e no cadastro (users), guardando o e-mail anterior. Serve para
// quem perdeu o acesso ao e-mail antigo: depois de trocar, o "Redefinir Senha" manda o link para o e-mail novo.
router.put('/:uid/email', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        if (!['adm_l1', 'adm_l2'].includes(req.user.role)) return res.status(403).json({ error: 'Só o Administrador troca o e-mail de um usuário.' });
        if (req.user.role !== 'adm_l1' && await alvoEhAdmL1(req.params.uid)) {
            return res.status(403).json({ error: 'Apenas o Administrador N1 pode alterar uma conta ADM N1.' });
        }
        const email = String((req.body || {}).email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return res.status(400).json({ error: 'Informe um e-mail válido.' });
        const ref = db.collection('users').doc(req.params.uid);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Usuário não encontrado.' });
        const atual = await auth.getUser(req.params.uid);
        if ((atual.email || '').toLowerCase() === email) return res.status(400).json({ error: 'Esse já é o e-mail do usuário.' });
        const dono = await auth.getUserByEmail(email).catch(() => null);
        if (dono && dono.uid !== req.params.uid) return res.status(409).json({ error: 'Esse e-mail já é usado por outra conta do Órbita.' });

        await auth.updateUser(req.params.uid, { email, emailVerified: false });
        await ref.update({
            email, emailAnterior: atual.email || snap.data().email || null,
            emailAlteradoEm: new Date().toISOString(), emailAlteradoPor: req.user.name || req.user.email || req.user.uid
        });
        if (verifyToken.limparCacheUsuario) verifyToken.limparCacheUsuario(req.params.uid);
        res.json({ message: `E-mail alterado para ${email}. O login passa a ser com ele.`, email });
    } catch (err) {
        res.status(err.code === 'auth/email-already-exists' ? 409 : 500).json({ error: err.code === 'auth/email-already-exists' ? 'Esse e-mail já é usado por outra conta do Órbita.' : err.message });
    }
});

router.put('/:uid/status', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        const { ativo } = req.body;

        if (req.user.role !== 'adm_l1' && await alvoEhAdmL1(req.params.uid)) {
            return res.status(403).json({ error: 'Apenas o Administrador N1 pode alterar uma conta ADM N1.' });
        }

        await db.collection('users').doc(req.params.uid).update({ ativo });

        // Desativar cortava só a tela — a conta continuava entrando pelo
        // Firebase Auth e lendo o que não exige nível 3 (achado do relatório
        // de segurança de 17/11). Agora desliga o login de verdade e invalida
        // qualquer sessão/token já aberto.
        await auth.updateUser(req.params.uid, { disabled: ativo === false }).catch(() => {});
        if (ativo === false) {
            await auth.revokeRefreshTokens(req.params.uid).catch(() => {});
        }
        if (verifyToken.limparCacheUsuario) verifyToken.limparCacheUsuario(req.params.uid);

        res.json({ message: `Status atualizado com sucesso!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/usuarios/:uid
router.delete('/:uid', verifyToken, verifyToken.requireModulePermission('usuarios'), async (req, res) => {
    try {
        if (req.user.role !== 'adm_l1' && await alvoEhAdmL1(req.params.uid)) {
            return res.status(403).json({ error: 'Apenas o Administrador N1 pode excluir uma conta ADM N1.' });
        }

        // Exclusão de verdade: tira a conta do Firebase Auth (barra login e
        // invalida qualquer sessão aberta), não só o documento do Firestore
        // — achado do relatório de segurança de 17/11 (quem era "excluído"
        // continuava entrando como visitante).
        await auth.deleteUser(req.params.uid).catch(() => {});
        await db.collection('users').doc(req.params.uid).delete();
        if (verifyToken.limparCacheUsuario) verifyToken.limparCacheUsuario(req.params.uid);

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
