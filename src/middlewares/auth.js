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

// Rotas que continuam acessíveis mesmo com primeiroAcesso pendente — só o
// necessário para a pessoa ver quem é ela (GET /me) e trocar a própria senha
// (PUT /me/senha, que já é quem zera a flag). Tudo mais fica bloqueado até a
// troca ser feita, para não depender só do modal do frontend.
const ROTAS_LIBERADAS_PRIMEIRO_ACESSO = [
    { method: 'GET', path: '/api/usuarios/me' },
    { method: 'PUT', path: '/api/usuarios/me/senha' }
];

const rotaLiberadaPrimeiroAcesso = (req) => {
    const caminho = req.originalUrl.split('?')[0];
    return ROTAS_LIBERADAS_PRIMEIRO_ACESSO.some(r => r.method === req.method && r.path === caminho);
};

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
            req.user.setorId = cached.setorId;
            req.user.chefeDeSetor = cached.chefeDeSetor;
            req.user.primeiroAcesso = cached.primeiroAcesso;
        } else {
            const { db } = require('../firebase');
            const userDoc = await db.collection('users').doc(req.user.uid).get();
            const userData = userDoc.exists ? userDoc.data() : {};
            req.user.role = userData.role || 'visitante';
            // Permissões específicas do usuário (override por módulo) — sempre
            // vencem as do cargo quando definidas
            req.user.permissoes = userData.permissoes || null;
            // setorId/chefeDeSetor nunca eram lidos aqui — toda rota que
            // dependia de req.user.setorId (Painel do Setor, Quadro de
            // Avisos) recebia sempre undefined. `chefeDeSetor` é uma
            // permissão à parte do cargo normal — dá o poder de "gestor do
            // setor" (Painel do Setor/Avisos) sem trocar o cargo/permissões
            // de módulo que a pessoa já tem (ex.: Secretaria continua com
            // acesso a Matrículas e ainda vira chefe do setor Secretaria).
            req.user.setorId = userData.setorId || null;
            req.user.chefeDeSetor = userData.chefeDeSetor === true;
            req.user.primeiroAcesso = userData.primeiroAcesso === true;
            userRoleCache.set(req.user.uid, {
                role: req.user.role,
                permissoes: req.user.permissoes,
                setorId: req.user.setorId,
                chefeDeSetor: req.user.chefeDeSetor,
                primeiroAcesso: req.user.primeiroAcesso,
                lastFetched: now
            });
        }

        // Troca de senha obrigatória no primeiro acesso: antes só o frontend
        // checava isso (modal), então chamar a API direto com o token válido
        // ignorava a exigência por completo. Agora o backend também barra,
        // liberando só o suficiente pra pessoa ver quem é e trocar a senha.
        if (req.user.primeiroAcesso === true && !rotaLiberadaPrimeiroAcesso(req)) {
            return res.status(403).json({
                error: 'Troca de senha obrigatória no primeiro acesso.',
                primeiroAcesso: true
            });
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
                ferida: 3,
                'almoxarifado-feridas': 3,
                'almoxarifado-saude': 3,
                'relatorio-dp': 3,
                acessos: 1,
                licitacao: 3,
                matriculas: 3,
                orcamento: 3,
                'avaliacao-docente': 3,
                cobranca: 1, // "Cobrança" é exclusivo do Financeiro, nem ADM N2 vê (31/08)
                'banco-med-fatec': 3,
                'relatorio-desempenho': 3,
                'banco-provas': 3,
                'confirmacao-evento': 3,
                contratos: 3,
                'aula-experimental': 3,
                auloes: 3,
                palestras: 3
            },
            ti: {
                emprestimo: 3,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 3,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            rh: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 3,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            financeiro: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 3,
                matriculas: 3,
                orcamento: 3,
                'avaliacao-docente': 1,
                cobranca: 3,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            // Coordenador perdeu acesso à Licitação (18/08) — passou a ser
            // tarefa exclusiva do Financeiro. Orçamento e Cobrança seguem a
            // mesma regra. Avaliação Docente é o módulo exclusivo do
            // coordenador pra avaliar seus próprios professores (nível 3 =
            // pode criar/editar, mas a rota só deixa ele enxergar/mexer nas
            // avaliações que ele mesmo criou — ver `apenasProprias` em
            // src/rotas/avaliacao-docente.js).
            coordenador: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 3,
                cobranca: 1,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                // Coordenador de qualquer curso pode montar prova - a rota
                // filtra pra só os cursos vinculados a ele (users.cursos),
                // mesma regra de Avaliação Docente.
                'banco-provas': 3,
                // Confirmação de Presença em Evento é institucional (todos os
                // professores ativos, não só do próprio curso) — nível 3 pra
                // qualquer coordenador poder marcar presença/ausência.
                'confirmacao-evento': 3,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            // Cargo "Secretaria" foi criado na tela de Usuários com id `sec`
            // (não `secretaria`) — chave aqui tem que bater com o id real.
            sec: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 3,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            // Coordenação da Medicina — só o Banco de Questões (nível 3, pode
            // criar/editar questões e provas); nenhum outro módulo.
            coord_medicina: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 3,
                'relatorio-desempenho': 3,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            // Professor da Medicina — mesmo nível de acesso do coord_medicina.
            professor_medicina: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 3,
                'relatorio-desempenho': 3,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
            },
            // Setor Comercial — por enquanto só Meu Espaço, nenhum módulo.
            comercial: {
                emprestimo: 1,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 3,
                'aula-experimental': 3,
                auloes: 3,
                palestras: 3
            },
            visitante: {
                emprestimo: 2,
                usuarios: 1,
                'carga-horaria': 1,
                ferida: 1,
                'almoxarifado-feridas': 1,
                'almoxarifado-saude': 1,
                'relatorio-dp': 1,
                acessos: 1,
                licitacao: 1,
                matriculas: 1,
                orcamento: 1,
                'avaliacao-docente': 1,
                cobranca: 1,
                'banco-med-fatec': 1,
                'relatorio-desempenho': 1,
                'banco-provas': 1,
                'confirmacao-evento': 1,
                contratos: 1,
                'aula-experimental': 1,
                auloes: 1,
                palestras: 1
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

