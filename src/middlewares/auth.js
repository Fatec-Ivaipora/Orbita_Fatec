const { auth } = require('../firebase');

// Cache em memória para as permissões do banco para evitar custos de leitura repetitiva
let permissionsCache = {
    data: null,
    lastFetched: 0
};
const CACHE_TTL = 60 * 1000; // 1 minuto de TTL

// Cache em memória do cargo/permissões por usuária, para não ler o Firestore
// em toda requisição (evita estourar cota de leituras em uso intenso).
const userRoleCache = new Map(); // uid -> { role, permissoes, lastFetched }
const USER_CACHE_TTL = 60 * 1000; // 1 minuto de TTL

// Nível de acesso normalizado com retrocompatibilidade:
// inteiro (1/2/3) ou formato legado { view, execute }
const getAccessLevel = (perm) => {
    if (perm === undefined || perm === null) return 1;
    if (typeof perm === 'object') {
        if (perm.execute) return 3;
        if (perm.view) return 2;
        return 1;
    }
    return parseInt(perm) || 1;
};

const verifyToken = async (req, res, next) => {
    const bearerHeader = req.headers['authorization'];

    if (!bearerHeader || !bearerHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
    }

    const idToken = bearerHeader.split('Bearer ')[1];

    // 1. Validação do token JWT — falha aqui é realmente "token inválido/expirado"
    let decodedToken;
    try {
        decodedToken = await auth.verifyIdToken(idToken);
    } catch (error) {
        console.error('Erro ao verificar o token:', error);
        return res.status(401).json({ error: 'Token inválido ou expirado.' });
    }
    req.user = decodedToken;

    // 2. Cargo/permissões no Firestore — cacheado por uid (1 min) para reduzir
    // leituras. Falha aqui (ex.: cota excedida) NÃO é problema de token —
    // reportar separadamente para não mandar a usuária relogar à toa.
    try {
        const cached = userRoleCache.get(req.user.uid);
        const now = Date.now();
        if (cached && (now - cached.lastFetched) < USER_CACHE_TTL) {
            req.user.role = cached.role;
            req.user.permissoes = cached.permissoes;
        } else {
            const { db } = require('../firebase');
            const userDoc = await db.collection('users').doc(req.user.uid).get();
            const userData = userDoc.exists ? userDoc.data() : {};
            req.user.role = userData.role || 'visitante';
            // Permissões específicas do usuário (override por módulo) — sempre
            // vencem as do cargo quando definidas
            req.user.permissoes = userData.permissoes || null;
            userRoleCache.set(req.user.uid, { role: req.user.role, permissoes: req.user.permissoes, lastFetched: now });
        }
        next();
    } catch (error) {
        console.error('Erro ao buscar cargo do usuário no Firestore:', error);
        // Cota excedida (Firestore) usa gRPC code 8 = RESOURCE_EXHAUSTED
        if (error.code === 8) {
            return res.status(503).json({ error: 'Limite de acesso ao banco de dados atingido no momento. Tente novamente em alguns minutos.' });
        }
        return res.status(503).json({ error: 'Não foi possível verificar seu cargo agora. Tente novamente em instantes.' });
    }
};

// Middleware para verificar permissões de módulos específicos
const requireModulePermission = (moduleName) => {
    return async (req, res, next) => {
        if (!req.user || !req.user.role) {
            return res.status(401).json({ error: 'Acesso negado. Informações do usuário não encontradas.' });
        }

        const role = req.user.role;

        // ADM N1 sempre possui acesso irrestrito
        if (role === 'adm_l1') {
            return next();
        }

        // GET requer nível >= 2 (visualização), outros métodos requerem nível >= 3 (execução)
        const requiredLevel = req.method === 'GET' ? 2 : 3;

        // Override específico do usuário vence o cargo (para ampliar ou restringir)
        if (req.user.permissoes && req.user.permissoes[moduleName] !== undefined) {
            const userLevel = getAccessLevel(req.user.permissoes[moduleName]);
            if (userLevel >= requiredLevel) {
                return next();
            }
            return res.status(403).json({
                error: `Acesso Negado. Você possui nível de acesso ${userLevel} (permissão individual) para o módulo ${moduleName}, mas o nível mínimo requerido é ${requiredLevel}.`
            });
        }

        // Tentar buscar as permissões do cache ou Firestore
        let perms = null;
        const now = Date.now();
        if (permissionsCache.data && (now - permissionsCache.lastFetched) < CACHE_TTL) {
            perms = permissionsCache.data;
        } else {
            try {
                const { db } = require('../firebase');
                const snap = await db.collection('config').doc('permissions').get();
                if (snap.exists) {
                    perms = snap.data();
                    permissionsCache.data = perms;
                    permissionsCache.lastFetched = now;
                }
            } catch (err) {
                console.error('Erro ao ler permissões dinâmicas do Firestore:', err);
            }
        }

        // Se encontrou as permissões no banco e estão configuradas para o cargo
        if (perms && perms[role] && perms[role][moduleName] !== undefined) {
            const userLevel = getAccessLevel(perms[role][moduleName]);
            if (userLevel >= requiredLevel) {
                return next();
            }
            return res.status(403).json({ 
                error: `Acesso Negado. Seu cargo (${role}) possui nível de acesso ${userLevel} para o módulo ${moduleName}, mas o nível mínimo requerido é ${requiredLevel}.` 
            });
        }

        // Fallback de segurança para permissões padrão
        const defaultPermissions = {
            adm_l2: {
                emprestimo: 3,
                usuarios: 3,
                'carga-horaria': 3,
                cpa: 3,
                ferida: 3,
                'almoxarifado-feridas': 3,
                'almoxarifado-saude': 3,
                'relatorio-dp': 3,
                acessos: 1,
                licitacao: 3,
                matriculas: 3
            },
            ti: {
                emprestimo: 3,
                usuarios: 1,
                'carga-horaria': 1,
                cpa: 3,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 3,
                licitacao: 1,
                matriculas: 1
            },
            rh: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 3,
                cpa: 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1
            },
            financeiro: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                cpa: 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 3,
                matriculas: 3
            },
            coordenador: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                cpa: 3,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 3,
                matriculas: 1
            },
            // Cargo "Secretaria" foi criado na tela de Usuários com id `sec`
            // (não `secretaria`) — chave aqui tem que bater com o id real.
            sec: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                cpa: 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 3
            },
            visitante: {
                emprestimo: 2,
                usuarios: 1,
                'carga-horaria': 1,
                cpa: 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1
            }
        };

        const roleDefault = defaultPermissions[role] || defaultPermissions['visitante'];
        const userLevel = getAccessLevel(roleDefault[moduleName]);

        if (userLevel >= requiredLevel) {
            return next();
        }

        return res.status(403).json({ error: `Acesso Negado. Seu cargo (${role}) não possui nível de acesso suficiente para acessar o módulo ${moduleName}.` });
    };
};

verifyToken.requireModulePermission = requireModulePermission;

module.exports = verifyToken;

