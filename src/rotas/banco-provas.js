const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { parseProvaDocx } = require('../utils/parseProvaDocx');
const { gerarProvaDocx, gerarGabaritoDocx, gerarPreviewHtml } = require('../utils/gerarProvaDocx');

const checkPermission = verifyToken.requireModulePermission('banco-provas');

const COL_DISCIPLINAS = 'docencia_bp_disciplinas';
const COL_QUESTOES = 'docencia_bp_questoes';
const COL_PROVAS = 'docencia_bp_provas';

// Mesma lista de cursos da FATEC IVP usada em Avaliação Docente/Usuários —
// duplicada aqui de propósito (mesmo padrão já adotado nesses dois arquivos),
// pra não fazer este módulo depender da permissão de Avaliação Docente só
// pra listar cursos. Se um curso for adicionado/renomeado, atualizar nos
// três lugares (aqui, src/rotas/avaliacao-docente.js, usuarios/app.js).
const CURSOS = [
    { id: 'agronegocio', name: 'Agronegócio' },
    { id: 'agronomia', name: 'Agronomia' },
    { id: 'arquitetura-urbanismo', name: 'Arquitetura e Urbanismo' },
    { id: 'biomedicina', name: 'Biomedicina' },
    { id: 'contabeis', name: 'Ciências Contábeis' },
    { id: 'direito', name: 'Direito' },
    { id: 'rh', name: 'Recursos Humanos' },
    { id: 'enfermagem', name: 'Enfermagem' },
    { id: 'engenharia-civil', name: 'Engenharia Civil' },
    { id: 'fisioterapia', name: 'Fisioterapia' },
    { id: 'gestao-comercial', name: 'Gestão Comercial' },
    { id: 'gestao-financeira', name: 'Gestão Financeira' },
    { id: 'logistica', name: 'Logística' },
    { id: 'medicina', name: 'Medicina' },
    { id: 'medicina-veterinaria', name: 'Medicina Veterinária' },
    { id: 'pedagogia', name: 'Pedagogia' },
    { id: 'psicologia', name: 'Psicologia' }
];

// "Conhecimentos Gerais" não é uma disciplina de curso nenhum — é um pool de
// questões compartilhado entre TODOS os cursos, usado só nos Simulados (as
// questões "de cultura geral" que entram misturadas com as de disciplina).
// Representado por um id fixo em vez de um doc em COL_DISCIPLINAS.
const DISCIPLINA_GERAL_ID = 'geral';

const TIPOS_VALIDOS = ['objetiva', 'dissertativa'];
const LETRAS_VALIDAS = ['A', 'B', 'C', 'D', 'E'];
const DIFICULDADES_VALIDAS = ['facil', 'media', 'intermediaria', 'dificil'];

function normalizarTexto(v) {
    return (v || '').toString().trim();
}

function ordinal(n) { return `${n}º`; }

// Chamada da questão: 1/2 (Bimestral) OU 'exame' (pedido explícito 18/09:
// "não tem exame lá na tela do banco de importação" — sem isso, questão de
// Exame tinha que ser marcada como 1ª/2ª chamada por falta de opção certa,
// o que não faz sentido pro Exame).
function normalizarChamada(v) {
    if (!v) return null;
    if (v === 'exame') return 'exame';
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? null : n;
}

// Bloco de revisão: null e "" são o mesmo "sem seção"
const mesmaSecao = (a, b) => (a || '') === (b || '');

function validarTexto(v, max = 150) {
    return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

// Coordenador pode estar vinculado a mais de um curso (users.cursos) — mesmo
// modelo já usado em Avaliação Docente. ADM N1/N2 não têm essa restrição
// (enxergam/mexem em qualquer curso).
async function cursosDoCoordenador(uid, role) {
    // EAD (21/10/2026): as disciplinas a distância passam por todos os cursos
    // da graduação — vê tudo deles, Medicina fica de fora (mesmo escopo da CPA).
    if (role === 'ead') return CURSOS.filter(c => c.id !== 'medicina').map(c => c.id);
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return [];
    const data = snap.data();
    const ids = Array.isArray(data.cursos) && data.cursos.length
        ? data.cursos
        : (data.curso ? [data.curso] : []);
    return ids.filter(id => CURSOS.some(c => c.id === id));
}

function ehAdmin(role) {
    return role === 'adm_l1' || role === 'adm_l2';
}

// EAD (21/10/2026): vê tudo dos cursos, mas só edita/exclui o que foi criado
// pelo próprio perfil (createdBy). Os outros cargos seguem só pelo curso.
function erroDeDono(req, doc) {
    if (req.user.role !== 'ead') return null;
    return doc && doc.createdBy === req.user.uid ? null : 'Você só pode alterar o que foi criado pelo seu perfil.';
}

// Confere se o usuário pode operar no curso informado — ADM sempre pode;
// coordenador só nos cursos vinculados a ele. Retorna null se pode, ou uma
// mensagem de erro pra responder 403.
async function checarAcessoCurso(req, cursoId) {
    if (ehAdmin(req.user.role)) return null;
    const meus = await cursosDoCoordenador(req.user.uid, req.user.role);
    if (!meus.includes(cursoId)) return 'Você não tem vínculo com esse curso.';
    return null;
}

// GET /cursos — lista fixa completa (front filtra quais o coordenador pode
// escolher via /meus-cursos; ADM edita livremente).
router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    res.json(CURSOS);
});

// GET /meus-cursos — só os cursos vinculados ao usuário logado (ADM recebe a
// lista inteira, já que não tem restrição).
router.get('/meus-cursos', verifyToken, checkPermission, async (req, res) => {
    if (ehAdmin(req.user.role)) return res.json(CURSOS);
    const ids = await cursosDoCoordenador(req.user.uid, req.user.role);
    res.json(CURSOS.filter(c => ids.includes(c.id)));
});

// ==========================================
// DISCIPLINAS — grade do curso (disciplina + período/série em que é
// ministrada). Igual ao Banco MED-FATEC, só que por curso em vez de fixo
// pra Medicina.
// ==========================================

// SEMPRE exige `curso` — nunca lê a coleção inteira (mesma economia de
// leitura já adotada em todo módulo Órbita Fatec).
router.get('/disciplinas', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });

        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const snap = await db.collection(COL_DISCIPLINAS).where('curso', '==', curso).get();
        const disciplinas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        disciplinas.sort((a, b) => (a.periodo - b.periodo) || a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json(disciplinas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/disciplinas', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.body.curso);
        const periodo = parseInt(req.body.periodo, 10);
        const nome = normalizarTexto(req.body.nome);
        if (!CURSOS.some(c => c.id === curso)) return res.status(400).json({ error: 'Selecione um curso válido.' });
        if (!Number.isInteger(periodo) || periodo < 1 || periodo > 12) {
            return res.status(400).json({ error: 'Selecione o período/série (1º a 12º) da disciplina.' });
        }
        if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe o nome da disciplina.' });

        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const docRef = await db.collection(COL_DISCIPLINAS).add({
            curso, periodo, nome,
            nomeBreve: req.body.nomeBreve ? normalizarTexto(req.body.nomeBreve) : '',
            createdBy: req.user.uid,
            createdAt: new Date().toISOString()
        });
        res.status(201).json({ id: docRef.id, message: 'Disciplina cadastrada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/disciplinas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_DISCIPLINAS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });

        const erroAcesso = await checarAcessoCurso(req, snap.data().curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const erroDono = erroDeDono(req, snap.data());
        if (erroDono) return res.status(403).json({ error: erroDono });

        const nome = normalizarTexto(req.body.nome);
        const periodo = parseInt(req.body.periodo, 10);
        if (!validarTexto(nome)) return res.status(400).json({ error: 'Informe o nome da disciplina.' });
        if (!Number.isInteger(periodo) || periodo < 1 || periodo > 12) {
            return res.status(400).json({ error: 'Selecione o período/série (1º a 12º) da disciplina.' });
        }

        await ref.update({ nome, periodo, nomeBreve: req.body.nomeBreve ? normalizarTexto(req.body.nomeBreve) : '' });
        res.json({ message: 'Disciplina atualizada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/disciplinas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_DISCIPLINAS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });

        const erroAcesso = await checarAcessoCurso(req, snap.data().curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const erroDono = erroDeDono(req, snap.data());
        if (erroDono) return res.status(403).json({ error: erroDono });

        const temQuestoes = await db.collection(COL_QUESTOES).where('disciplinaId', '==', req.params.id).limit(1).get();
        if (!temQuestoes.empty) return res.status(400).json({ error: 'Essa disciplina já tem questões no banco — exclua as questões primeiro.' });

        await ref.delete();
        res.json({ message: 'Disciplina excluída.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Conhecimentos Gerais (30/10/2026): cada curso cadastra as SUAS — antes (14/10) era um conjunto só por
// semestre pra todos os cursos, e o simulado de um curso saía com as questões de outro (todos importam
// numeradas 1..5, a ordem sequencial misturava os lotes). A questão continua precisando do semestre, e o
// simulado só puxa as do curso e do semestre dele. As antigas sem curso: scripts/conhecimentos-gerais-por-curso.js.
const SEMESTRE_VALIDO = /^\d{4}\.[12]$/;
const erroSemestreGeral = (disciplinaId, semestre) => (disciplinaId === DISCIPLINA_GERAL_ID && !SEMESTRE_VALIDO.test(normalizarTexto(semestre) || '')
    ? 'Questão de Conhecimentos Gerais precisa do semestre (ex.: 2026.2): o simulado usa as do semestre dele.' : null);

function validarQuestao(body) {
    if (!TIPOS_VALIDOS.includes(body.tipo)) return 'Selecione o tipo da questão (objetiva ou dissertativa).';
    if (body.dificuldade && !DIFICULDADES_VALIDAS.includes(body.dificuldade)) return 'Dificuldade inválida.';
    if (!body.enunciadoHtml || !String(body.enunciadoHtml).trim()) return 'Informe o enunciado da questão.';
    if (body.tipo === 'objetiva') {
        if (!Array.isArray(body.alternativas) || body.alternativas.length < 2) {
            return 'Informe pelo menos duas alternativas.';
        }
        if (body.alternativas.length > 5) return 'No máximo 5 alternativas (A a E).';
        if (!body.gabarito || !LETRAS_VALIDAS.slice(0, body.alternativas.length).includes(body.gabarito)) {
            return 'Selecione qual alternativa é a correta (gabarito).';
        }
    }
    return null;
}

// ==========================================
// QUESTÕES — banco compartilhado entre os coordenadores vinculados ao mesmo
// curso (mesmo espírito do Banco MED-FATEC: importação/cadastro fica pra
// próxima etapa; aqui só o cadastro manual + listagem, pra ter a base
// funcionando).
// ==========================================

// SEMPRE exige pelo menos um filtro — nunca lê a coleção inteira.
router.get('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });

        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        let query = db.collection(COL_QUESTOES).where('curso', '==', curso);
        if (req.query.disciplinaId) query = query.where('disciplinaId', '==', req.query.disciplinaId);
        if (req.query.periodo) query = query.where('periodo', '==', parseInt(req.query.periodo, 10));
        if (req.query.bimestre) query = query.where('bimestre', '==', parseInt(req.query.bimestre, 10));
        if (req.query.chamada) query = query.where('chamada', '==', normalizarChamada(req.query.chamada));
        if (req.query.tipo) query = query.where('tipo', '==', req.query.tipo);
        if (req.query.dificuldade) query = query.where('dificuldade', '==', req.query.dificuldade);
        if (req.query.semestre) query = query.where('semestre', '==', normalizarTexto(req.query.semestre));

        const snap = await query.get();
        const questoes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        questoes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(questoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /questoes-gerais?curso=X — Conhecimentos Gerais do curso (cada curso tem as suas, 30/10/2026).
router.get('/questoes-gerais', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        let q = db.collection(COL_QUESTOES)
            .where('disciplinaId', '==', DISCIPLINA_GERAL_ID)
            .where('curso', '==', curso)
            .where('status', '==', 'publicada');
        if (req.query.semestre) q = q.where('semestre', '==', normalizarTexto(req.query.semestre));
        const snap = await q.get();
        const questoes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        questoes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(questoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /questoes/semestres?curso=X — semestres DISTINTOS já usados em
// questões desse curso (inclui as de Conhecimentos Gerais dele), pra popular filtro
// e o campo "Semestre" da prova como select — pedido explícito (18/09):
// "somente o que tem no banco para não ter erros" (texto livre gerava
// "2026.2" vs "2026-2" não batendo no filtro por igualdade exata).
router.get('/questoes/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const doCurso = await db.collection(COL_QUESTOES).where('curso', '==', curso).get();
        const semestres = new Set();
        doCurso.docs.forEach(d => {
            const s = d.data().semestre;
            if (s) semestres.add(s);
        });
        res.json([...semestres].sort().reverse());
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /periodos-juntos?curso=X — períodos que estudam juntos no semestre atual (14/10/2026), pela mesma
// regra da Correção de Provas (scripts/cad-edubox-sync.js marca o "grupo" de cada turma no CADD):
// ex.: [[1,2],[3,4],[5]]. A prova de quem estuda junto é uma só.
router.get('/periodos-juntos', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        const { CODCUR } = require('./cpa')._interno;
        const codcur = CODCUR[curso];
        if (!codcur) return res.json({ grupos: [] });
        const snap = await db.collection('cad_ciclos').get();
        const ciclos = snap.docs.map(d => d.data()).filter(c => (c.turmas || []).some(t => t.codcur === codcur));
        if (!ciclos.length) return res.json({ grupos: [] });
        const atual = ciclos.sort((a, b) => String(b.semestre).localeCompare(String(a.semestre)))[0];
        const turmas = atual.turmas.filter(t => t.codcur === codcur && !/^DP\b/i.test(t.turma) && t.periodo);
        const porGrupo = new Map();
        turmas.forEach(t => { const k = t.grupo || t.id; (porGrupo.get(k) || porGrupo.set(k, new Set()).get(k)).add(Number(t.periodo)); });
        const grupos = [...porGrupo.values()].map(s => [...s].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
        res.json({ semestre: atual.semestre, grupos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function periodoDaDisciplina(disciplinaId) {
    if (!disciplinaId || disciplinaId === DISCIPLINA_GERAL_ID) return null;
    const snap = await db.collection(COL_DISCIPLINAS).doc(disciplinaId).get();
    return snap.exists ? (snap.data().periodo ?? null) : null;
}

router.post('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const erro = validarQuestao(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const disciplinaId = normalizarTexto(req.body.disciplinaId);
        const geral = disciplinaId === DISCIPLINA_GERAL_ID;
        const erroSem = erroSemestreGeral(disciplinaId, req.body.semestre);
        if (erroSem) return res.status(400).json({ error: erroSem });
        const curso = normalizarTexto(req.body.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const periodo = geral ? null : await periodoDaDisciplina(disciplinaId);
        const bimestre = req.body.bimestre ? parseInt(req.body.bimestre, 10) : null;
        const chamada = normalizarChamada(req.body.chamada);

        const { tipo, enunciadoHtml, alternativas, gabarito } = req.body;
        const docRef = await db.collection(COL_QUESTOES).add({
            disciplinaId: disciplinaId || null,
            curso, periodo, bimestre, chamada,
            semestre: normalizarTexto(req.body.semestre) || null,
            tipo, enunciadoHtml,
            alternativas: tipo === 'objetiva' ? alternativas : null,
            gabarito: tipo === 'objetiva' ? gabarito : null,
            dificuldade: req.body.dificuldade || 'media',
            valor: req.body.valor !== undefined && req.body.valor !== '' ? Number(req.body.valor) : null,
            professorNome: normalizarTexto(req.body.professorNome) || null,
            status: 'publicada',
            createdBy: req.user.uid,
            createdPorNome: req.user.name || req.user.email || 'Coordenador',
            createdAt: new Date().toISOString()
        });
        res.status(201).json({ id: docRef.id, message: 'Questão cadastrada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_QUESTOES).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });

        const atual = snap.data();

        { const disc = req.body.disciplinaId !== undefined ? normalizarTexto(req.body.disciplinaId) : atual.disciplinaId; const sem = req.body.semestre !== undefined ? req.body.semestre : atual.semestre; const e2 = erroSemestreGeral(disc, sem); if (e2) return res.status(400).json({ error: e2 }); }
        if (atual.curso) {
            const erroAcesso = await checarAcessoCurso(req, atual.curso);
            if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        } else if (!ehAdmin(req.user.role)) {
            // Conhecimentos Gerais antiga, de antes de cada curso ter as suas
            // (sem curso) — só ADM edita, era o pool usado por todos.
            return res.status(403).json({ error: 'Só o administrador pode editar questões de Conhecimentos Gerais.' });
        }
        const erroDono = erroDeDono(req, atual);
        if (erroDono) return res.status(403).json({ error: erroDono });

        const erro = validarQuestao(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const disciplinaId = req.body.disciplinaId !== undefined ? normalizarTexto(req.body.disciplinaId) : atual.disciplinaId;
        const geral = disciplinaId === DISCIPLINA_GERAL_ID;
        const periodo = geral ? null : await periodoDaDisciplina(disciplinaId);
        const { tipo, enunciadoHtml, alternativas, gabarito } = req.body;

        await ref.update({
            disciplinaId: disciplinaId || null,
            periodo,
            bimestre: req.body.bimestre ? parseInt(req.body.bimestre, 10) : null,
            chamada: normalizarChamada(req.body.chamada),
            semestre: normalizarTexto(req.body.semestre) || null,
            tipo, enunciadoHtml,
            alternativas: tipo === 'objetiva' ? alternativas : null,
            gabarito: tipo === 'objetiva' ? gabarito : null,
            dificuldade: req.body.dificuldade || 'media',
            valor: req.body.valor !== undefined && req.body.valor !== '' ? Number(req.body.valor) : null,
            professorNome: normalizarTexto(req.body.professorNome) || null
        });
        const avs = tipo === 'objetiva' && atual.gabarito !== gabarito ? await require('./correcao-provas')._interno.propagarGabarito(req.params.id, gabarito, req.user.name || req.user.email) : 0;
        res.json({ message: avs ? `Questão atualizada (gabarito novo também em ${avs} avaliação(ões) da Correção de Provas).` : 'Questão atualizada.', avaliacoesAtualizadas: avs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /questoes/:id/gabarito — corrige só o gabarito, direto da tela de
// pré-visualizar/imprimir a prova (pedido explícito 18/09: "editar no
// final seria legal, aí já atualiza no banco também"). Mais leve que o PUT
// completo — não exige reenviar enunciado/alternativas/etc.
router.put('/questoes/:id/gabarito', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_QUESTOES).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });

        const atual = snap.data();
        if (atual.curso) {
            const erroAcesso = await checarAcessoCurso(req, atual.curso);
            if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        } else if (!ehAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Só o administrador pode editar questões de Conhecimentos Gerais.' });
        }
        const erroDono = erroDeDono(req, atual);
        if (erroDono) return res.status(403).json({ error: erroDono });
        if (atual.tipo !== 'objetiva') return res.status(400).json({ error: 'Só questões objetivas têm gabarito.' });

        const letrasValidas = LETRAS_VALIDAS.slice(0, (atual.alternativas || []).length);
        if (!letrasValidas.includes(req.body.gabarito)) return res.status(400).json({ error: 'Selecione uma alternativa válida.' });

        await ref.update({ gabarito: req.body.gabarito });
        const avs = atual.gabarito !== req.body.gabarito ? await require('./correcao-provas')._interno.propagarGabarito(req.params.id, req.body.gabarito, req.user.name || req.user.email) : 0;
        res.json({ message: avs ? `Gabarito atualizado (e em ${avs} avaliação(ões) da Correção de Provas).` : 'Gabarito atualizado.', avaliacoesAtualizadas: avs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_QUESTOES).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });

        const atual = snap.data();
        if (atual.curso) {
            const erroAcesso = await checarAcessoCurso(req, atual.curso);
            if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        } else if (!ehAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Só o administrador pode excluir questões de Conhecimentos Gerais.' });
        }
        const erroDono = erroDeDono(req, atual);
        if (erroDono) return res.status(403).json({ error: erroDono });

        await ref.delete();
        res.json({ message: 'Questão excluída.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// IMPORTAÇÃO DO WORD (.docx) — professor manda o arquivo (formato "prova pro
// aluno", sem gabarito). Em DOIS passos, pra tirar a digitação de "número-
// letra" que antes dava erro de digitação com frequência (pedido explícito
// 17/09: "as vezes a pessoa erra, precisamos facilitar"):
//   1) /questoes/analisar-docx — só LÊ o arquivo e devolve as questões
//      (enunciado + alternativas), sem gravar nada.
//   2) /questoes/importar-docx — recebe essas mesmas questões de volta, já
//      com o gabarito marcado no CLIENTE (clicando na bolinha certa, não
//      digitando) e aí sim grava na fila de revisão.
// ==========================================
router.post('/questoes/analisar-docx', verifyToken, checkPermission, async (req, res) => {
    try {
        const alternativasPorQuestao = parseInt(req.body.alternativasPorQuestao, 10);
        if (![4, 5].includes(alternativasPorQuestao)) {
            return res.status(400).json({ error: 'Informe se a prova tem 4 ou 5 alternativas por questão.' });
        }
        if (!req.body.arquivoBase64) return res.status(400).json({ error: 'Envie o arquivo .docx.' });

        const buffer = Buffer.from(req.body.arquivoBase64, 'base64');
        let brutas;
        try {
            brutas = await parseProvaDocx(buffer, alternativasPorQuestao);
        } catch (err) {
            return res.status(400).json({ error: 'Não consegui ler esse arquivo — confirme que é um documento Word (.docx ou .doc).' });
        }
        if (!brutas.length) return res.status(400).json({ error: 'Não encontrei nenhuma questão nesse arquivo (procurei por "Questão 1", "Questão 2"...).' });

        const comErroDeLeitura = brutas.filter(q => q.erro);
        if (comErroDeLeitura.length) {
            return res.status(400).json({ error: comErroDeLeitura.map(q => q.erro).join(' ') });
        }
        // questão só com o número (sem texto) fica de fora, com aviso
        const questoes = brutas.filter(q => !q.vazia);
        // "Questão 32" escrito duas vezes seguidas no Word não é questão perdida: a 32 veio no 2º marcador
        const numerosLidos = new Set(questoes.map(q => `${q.tipo}:${q.numero}`));
        const vazias = brutas.filter(q => q.vazia && !numerosLidos.has(`${q.tipo}:${q.numero}`));
        if (!questoes.length) return res.status(400).json({ error: 'As questões desse arquivo estão sem texto (só o número).' });
        const aviso = vazias.length ? `${vazias.length} questão(ões) sem texto no arquivo ficaram de fora (nº ${vazias.map(q => q.numero).join(', ')}${vazias[0].categoriaSugeridaTexto ? ` — ${vazias[0].categoriaSugeridaTexto}` : ''}).` : '';

        res.json({ questoes, alternativasPorQuestao, aviso });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/questoes/importar-docx', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.body.curso);
        if (!CURSOS.some(c => c.id === curso)) return res.status(400).json({ error: 'Selecione um curso válido.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const alternativasPorQuestao = parseInt(req.body.alternativasPorQuestao, 10);
        if (![4, 5].includes(alternativasPorQuestao)) {
            return res.status(400).json({ error: 'Informe se a prova tem 4 ou 5 alternativas por questão.' });
        }

        const questoes = Array.isArray(req.body.questoes) ? req.body.questoes : [];
        if (!questoes.length) return res.status(400).json({ error: 'Nenhuma questão pra importar.' });

        const letrasValidas = LETRAS_VALIDAS.slice(0, alternativasPorQuestao);
        // Dissertativa não tem gabarito pra marcar — a etapa de "clicar na
        // alternativa certa" do frontend nem aparece pra elas, então só
        // objetiva entra nessa checagem.
        const semGabarito = questoes.filter(q => q.tipo !== 'dissertativa' && !letrasValidas.includes(q.gabarito)).map(q => q.numero);
        if (semGabarito.length) {
            return res.status(400).json({ error: `Marque o gabarito de todas as questões antes de confirmar — faltou a nº ${semGabarito.join(', ')}.` });
        }

        // Semestre / bimestre / chamada escolhidos UMA vez na importação valem pra todas as questões do
        // arquivo (pedido 29/10/2026: "fica muito repetitivo ... o certo seria mandar o arquivo já com as
        // configurações"). Ficam nas questões em revisão e a tela de revisão já vem preenchida com eles.
        const padrao = req.body.padrao || {};
        const padraoChamada = normalizarChamada(padrao.chamada);
        const padraoBimestre = padraoChamada === 'exame' ? null : ([1, 2].includes(parseInt(padrao.bimestre, 10)) ? parseInt(padrao.bimestre, 10) : null);
        const padraoSemestre = /^\d{4}\.[12]$/.test(normalizarTexto(padrao.semestre) || '') ? normalizarTexto(padrao.semestre) : null;

        const loteId = db.collection(COL_QUESTOES).doc().id;
        const batch = db.batch();
        questoes.forEach(q => {
            const dissertativa = q.tipo === 'dissertativa';
            const ref = db.collection(COL_QUESTOES).doc();
            batch.set(ref, {
                curso, disciplinaId: null, periodo: null, bimestre: padraoBimestre, chamada: padraoChamada, semestre: padraoSemestre,
                tipo: dissertativa ? 'dissertativa' : 'objetiva',
                enunciadoHtml: q.enunciado,
                alternativas: dissertativa ? null : (q.alternativas || []).map((texto, i) => ({ letra: LETRAS_VALIDAS[i], texto })),
                gabarito: dissertativa ? null : q.gabarito,
                dificuldade: 'media',
                valor: null,
                professorNome: normalizarTexto(req.body.professorNome) || null,
                categoriaSugeridaTexto: q.categoriaSugeridaTexto,
                numeroOriginal: q.numero,
                loteId,
                status: 'revisao_importacao',
                createdBy: req.user.uid,
                createdPorNome: req.user.name || req.user.email || 'Coordenador',
                createdAt: new Date().toISOString()
            });
        });
        await batch.commit();

        res.status(201).json({ message: `${questoes.length} questão(ões) importada(s), aguardando revisão.`, loteId, total: questoes.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /questoes/revisao?curso=X — fila de revisão agrupada por lote.
router.get('/questoes/revisao', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const snap = await db.collection(COL_QUESTOES)
            .where('curso', '==', curso)
            .where('status', '==', 'revisao_importacao')
            .get();
        const questoes = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => !erroDeDono(req, q));
        questoes.sort((a, b) => (a.numeroOriginal || 0) - (b.numeroOriginal || 0));
        res.json(questoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /questoes/lote/:loteId/resolver — confirma a disciplina/período/
// bimestre/semestre. Um arquivo pode ter mais de uma disciplina junto (ex.:
// um Simulado com várias seções) — se vier `categoriaSugeridaTexto` no
// corpo, resolve só o GRUPO daquela categoria dentro do lote; sem isso,
// resolve o lote inteiro de uma vez (caso comum: arquivo de uma disciplina só).
router.put('/questoes/lote/:loteId/resolver', verifyToken, checkPermission, async (req, res) => {
    try {
        const disciplinaId = normalizarTexto(req.body.disciplinaId);
        if (!disciplinaId) return res.status(400).json({ error: 'Selecione a disciplina antes de confirmar.' });
        if (!req.body.chamada) return res.status(400).json({ error: 'Selecione a chamada antes de confirmar.' });
        // Obrigatório (18/09): sem bimestre a questão fica invisível na hora
        // de montar prova bimestral filtrando por bimestre. Exame não tem
        // bimestre (só acontece depois do 2º bimestre), então não exige.
        if (req.body.chamada !== 'exame' && !req.body.bimestre) return res.status(400).json({ error: 'Selecione o bimestre antes de confirmar.' });

        const geral = disciplinaId === DISCIPLINA_GERAL_ID;
        const erroSem = erroSemestreGeral(disciplinaId, req.body.semestre);
        if (erroSem) return res.status(400).json({ error: erroSem });
        const periodo = geral ? null : await periodoDaDisciplina(disciplinaId);
        if (!geral && periodo === null) return res.status(404).json({ error: 'Disciplina não encontrada.' });

        let query = db.collection(COL_QUESTOES)
            .where('loteId', '==', req.params.loteId)
            .where('status', '==', 'revisao_importacao');
        const categoriaSugeridaTexto = req.body.categoriaSugeridaTexto;

        let snap = await query.get();
        // "sem seção" pode estar gravado como null OU "" (questão movida pro bloco sem seção virava ""):
        // filtra em memória tratando os dois como o mesmo bloco (11/11/2026 — revisão da Fisio travada)
        if (categoriaSugeridaTexto !== undefined) {
            const docsDoBloco = snap.docs.filter(d => mesmaSecao(d.data().categoriaSugeridaTexto, categoriaSugeridaTexto));
            snap = { docs: docsDoBloco, size: docsDoBloco.length, empty: !docsDoBloco.length };
        }
        if (snap.empty) return res.status(404).json({ error: 'Grupo de importação não encontrado (ou já resolvido).' });
        // Bloco sem disciplina identificada (05/11/2026): o professor confirma uma disciplina de cada vez,
        // escolhendo as questões dela (ids) — o resto continua na revisão. Antes, confirmar o bloco levava
        // o arquivo inteiro (um simulado de 40 questões foi todo pra Conhecimentos Gerais).
        if (Array.isArray(req.body.ids) && req.body.ids.length) {
            const escolhidas = new Set(req.body.ids.filter(x => typeof x === 'string'));
            const docs = snap.docs.filter(d => escolhidas.has(d.id));
            if (docs.length !== escolhidas.size) return res.status(400).json({ error: 'Algumas questões escolhidas não estão mais neste bloco da revisão. Atualize a página.' });
            snap = { docs, size: docs.length };
        }
        const alheia = snap.docs.find(doc => erroDeDono(req, doc.data()));
        if (alheia) return res.status(403).json({ error: erroDeDono(req, alheia.data()) });

        const bimestre = req.body.bimestre ? parseInt(req.body.bimestre, 10) : null;
        const chamada = normalizarChamada(req.body.chamada);
        const semestre = normalizarTexto(req.body.semestre) || null;

        const batch = db.batch();
        snap.docs.forEach(doc => batch.update(doc.ref, {
            disciplinaId, periodo, bimestre, chamada, semestre,
            status: 'publicada', updatedAt: new Date().toISOString()
        }));
        await batch.commit();

        res.json({ message: 'Disciplina confirmada!', atualizadas: snap.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /questoes/revisao/mover-bloco — passa questões ainda em revisão pra outro bloco do mesmo
// lote (03/11/2026): quando o título da disciplina no Word ficou no lugar errado e uma questão
// entrou no bloco de cima/de baixo, o professor corrige antes de confirmar.
router.put('/questoes/revisao/mover-bloco', verifyToken, checkPermission, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(x => typeof x === 'string').slice(0, 200) : [];
        // destino "" ou null = bloco "sem seção": grava sempre null (igual ao que a importação grava)
        const destino = typeof req.body.categoriaSugeridaTexto === 'string' && req.body.categoriaSugeridaTexto.trim() ? req.body.categoriaSugeridaTexto : null;
        if (!ids.length || (req.body.categoriaSugeridaTexto !== null && typeof req.body.categoriaSugeridaTexto !== 'string')) return res.status(400).json({ error: 'Informe as questões e o bloco de destino.' });
        const docs = await Promise.all(ids.map(id => db.collection(COL_QUESTOES).doc(id).get()));
        const lotes = new Set();
        for (const d of docs) {
            if (!d.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
            const q = d.data();
            if (q.status !== 'revisao_importacao') return res.status(400).json({ error: 'Só dá pra mover questão que ainda está na revisão.' });
            const erro = erroDeDono(req, q);
            if (erro) return res.status(403).json({ error: erro });
            lotes.add(q.loteId);
        }
        if (lotes.size !== 1) return res.status(400).json({ error: 'As questões precisam ser do mesmo arquivo importado.' });
        const batch = db.batch();
        docs.forEach(d => batch.update(d.ref, { categoriaSugeridaTexto: destino, updatedAt: new Date().toISOString() }));
        await batch.commit();
        res.json({ message: 'Questões movidas.', movidas: docs.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /questoes/lote/:loteId — descarta o lote (ou só um grupo/categoria
// dele, se vier ?categoriaSugeridaTexto= na query — importou errado).
router.delete('/questoes/lote/:loteId', verifyToken, checkPermission, async (req, res) => {
    try {
        let query = db.collection(COL_QUESTOES)
            .where('loteId', '==', req.params.loteId)
            .where('status', '==', 'revisao_importacao');
        let snap = await query.get();
        if (req.query.categoriaSugeridaTexto !== undefined) {
            const docsDoBloco = snap.docs.filter(d => mesmaSecao(d.data().categoriaSugeridaTexto, req.query.categoriaSugeridaTexto));
            snap = { docs: docsDoBloco, size: docsDoBloco.length };
        }
        const alheia = snap.docs.find(doc => erroDeDono(req, doc.data()));
        if (alheia) return res.status(403).json({ error: erroDeDono(req, alheia.data()) });
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        res.json({ message: 'Lote descartado.', removidas: snap.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// PROVAS — Simulado (mistura Conhecimentos Gerais + disciplinas, quantidade
// escolhida pelo coordenador por disciplina) e Prova Bimestral/Exame (uma
// disciplina só, seleção manual, objetiva+dissertativa).
//
// Pedido explícito (17/09): "não precisam ser sorteadas, vão seguir uma
// sequência" — as questões de cada disciplina entram na ordem em que foram
// escritas/importadas (número original da importação, ou ordem de cadastro
// pra quem foi criada na mão), nunca embaralhadas.
// ==========================================

function ordenarSequencial(lista) {
    return [...lista].sort((a, b) => {
        if (a.numeroOriginal != null && b.numeroOriginal != null) return a.numeroOriginal - b.numeroOriginal;
        if (a.numeroOriginal != null) return -1;
        if (b.numeroOriginal != null) return 1;
        return (a.createdAt || '').localeCompare(b.createdAt || '');
    });
}

router.get('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const snap = await db.collection(COL_PROVAS).where('curso', '==', curso).get();
        const provas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        provas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(provas);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /provas/simular — pré-visualização: pega as questões de cada
// disciplina EM SEQUÊNCIA (não sorteio) conforme as quantidades pedidas,
// sem salvar nada ainda (o coordenador confere antes de confirmar).
router.post('/provas/simular', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.body.curso);
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const bimestre = req.body.bimestre ? parseInt(req.body.bimestre, 10) : null;
        const chamada = normalizarChamada(req.body.chamada);
        const semestre = normalizarTexto(req.body.semestre) || null;

        const cotas = Array.isArray(req.body.cotas) ? req.body.cotas : [];
        if (cotas.some(c => c.disciplinaId === DISCIPLINA_GERAL_ID && c.quantidade > 0) && !semestre) {
            return res.status(400).json({ error: 'Escolha o semestre do simulado: as questões de Conhecimentos Gerais são as do semestre.' });
        }
        const resultado = [];
        for (const cota of cotas) {
            const geral = cota.disciplinaId === DISCIPLINA_GERAL_ID;
            let query = db.collection(COL_QUESTOES).where('status', '==', 'publicada').where('disciplinaId', '==', cota.disciplinaId)
                .where('curso', '==', curso);
            if (!geral) {
                // Conhecimentos Gerais não é organizado por bimestre/chamada,
                // só por semestre — só filtra por isso nas disciplinas.
                if (bimestre) query = query.where('bimestre', '==', bimestre);
                if (chamada) query = query.where('chamada', '==', chamada);
            } else {
                query = query.where('semestre', '==', semestre);
            }
            const snap = await query.get();
            const disponiveis = ordenarSequencial(snap.docs.map(d => ({ id: d.id, ...d.data() })));
            const selecionadas = disponiveis.slice(0, cota.quantidade);
            // `disponiveis` vai junto (30/10/2026): o coordenador troca na tela quais entram — as
            // `questoes` (as primeiras N em sequência) são só a sugestão inicial.
            resultado.push({
                disciplinaId: cota.disciplinaId,
                quantidadePedida: cota.quantidade,
                quantidadeDisponivel: disponiveis.length,
                questoes: selecionadas,
                disponiveis: disponiveis.map(q => ({ id: q.id, enunciadoHtml: q.enunciadoHtml, gabarito: q.gabarito, numeroOriginal: q.numeroOriginal ?? null }))
            });
        }
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.body.curso);
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });

        const tipo = ['simulado', 'bimestral', 'exame'].includes(req.body.tipo) ? req.body.tipo : null;
        if (!tipo) return res.status(400).json({ error: 'Selecione o tipo da prova.' });
        const nome = normalizarTexto(req.body.nome);
        if (!validarTexto(nome, 150)) return res.status(400).json({ error: 'Informe o nome/título da prova.' });

        const questoesIds = Array.isArray(req.body.questoesIds) ? req.body.questoesIds : [];
        if (!questoesIds.length) return res.status(400).json({ error: 'A prova precisa ter pelo menos uma questão.' });

        const disciplinaId = tipo !== 'simulado' ? normalizarTexto(req.body.disciplinaId) || null : null;
        // Período da disciplina escolhida — usado no "Período:" do
        // cabeçalho da Bimestral/Exame (ver tabelaCabecalhoBimestral). Sem
        // isso o campo saía sempre em branco na prova impressa (18/09).
        const periodo = disciplinaId ? await periodoDaDisciplina(disciplinaId) : null;

        const docRef = await db.collection(COL_PROVAS).add({
            curso, tipo, nome,
            semestre: normalizarTexto(req.body.semestre) || null,
            bimestre: req.body.bimestre ? parseInt(req.body.bimestre, 10) : null,
            chamada: normalizarChamada(req.body.chamada),
            disciplinaId,
            periodo,
            professorNome: normalizarTexto(req.body.professorNome) || null,
            questoesIds,
            createdBy: req.user.uid,
            createdPorNome: req.user.name || req.user.email || 'Coordenador',
            createdAt: new Date().toISOString()
        });
        res.status(201).json({ id: docRef.id, message: 'Prova criada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/provas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_PROVAS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        const erroAcesso = await checarAcessoCurso(req, snap.data().curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const erroDono = erroDeDono(req, snap.data());
        if (erroDono) return res.status(403).json({ error: erroDono });
        await ref.delete();
        res.json({ message: 'Prova excluída.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Carrega tudo que os dois exports (prova e gabarito) precisam — prova,
// questões e nomes de disciplina — num lugar só, pra não duplicar.
async function carregarDadosDeExportacao(req, res) {
    const snap = await db.collection(COL_PROVAS).doc(req.params.id).get();
    if (!snap.exists) { res.status(404).json({ error: 'Prova não encontrada.' }); return null; }
    const prova = { id: snap.id, ...snap.data() };
    const erroAcesso = await checarAcessoCurso(req, prova.curso);
    if (erroAcesso) { res.status(403).json({ error: erroAcesso }); return null; }

    const [questoesSnaps, disciplinasSnap] = await Promise.all([
        Promise.all(prova.questoesIds.map(id => db.collection(COL_QUESTOES).doc(id).get())),
        db.collection(COL_DISCIPLINAS).where('curso', '==', prova.curso).get()
    ]);
    const questoes = questoesSnaps.filter(s => s.exists).map(s => ({ id: s.id, ...s.data() }));

    const nomesDisciplina = { [DISCIPLINA_GERAL_ID]: 'Conhecimentos Gerais' };
    disciplinasSnap.docs.forEach(d => { nomesDisciplina[d.id] = d.data().nome; });

    const cursoNome = (CURSOS.find(c => c.id === prova.curso) || {}).name || prova.curso;
    const periodoLabel = prova.periodo ? `${ordinal(prova.periodo)} Período` : '';
    const opts = { cursoNome, disciplinaNome: prova.disciplinaId ? (nomesDisciplina[prova.disciplinaId] || null) : null, nomesDisciplina, periodoLabel };
    return { prova, questoes, opts };
}

// GET /provas/:id/preview — pré-visualização em HTML, pra conferir a prova
// ANTES de baixar o .docx final — pedido explícito (18/09): "se precisar
// alterar alguma coisa já sai certo". Mesma montagem/ordenação do .docx
// (ver gerarPreviewHtml), só que renderizada como HTML pra mostrar na tela.
router.get('/provas/:id/preview', verifyToken, checkPermission, async (req, res) => {
    try {
        const dados = await carregarDadosDeExportacao(req, res);
        if (!dados) return;
        const { prova, questoes, opts } = dados;

        const html = await gerarPreviewHtml(prova, questoes, opts);
        res.json({ html, nome: prova.nome });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /provas/:id/exportar-docx — gera o .docx pronto pra secretaria
// imprimir, no formato Simulado (agrupado por disciplina) ou Bimestral/
// Exame (cabeçalho completo + gabarito + dissertativas).
router.get('/provas/:id/exportar-docx', verifyToken, checkPermission, async (req, res) => {
    try {
        const dados = await carregarDadosDeExportacao(req, res);
        if (!dados) return;
        const { prova, questoes, opts } = dados;

        const buffer = await gerarProvaDocx(prova, questoes, opts);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${prova.nome.replace(/[^a-zA-Z0-9 ]/g, '')}.docx"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /provas/:id/exportar-gabarito — arquivo SEPARADO só com a resposta
// certa de cada questão (mesma numeração da prova impressa) — pedido
// explícito: "gera o arquivo final e o arquivo com o gabarito". Nunca vai
// junto do arquivo do aluno.
router.get('/provas/:id/exportar-gabarito', verifyToken, checkPermission, async (req, res) => {
    try {
        const dados = await carregarDadosDeExportacao(req, res);
        if (!dados) return;
        const { prova, questoes, opts } = dados;

        const buffer = await gerarGabaritoDocx(prova, questoes, opts);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="Gabarito - ${prova.nome.replace(/[^a-zA-Z0-9 ]/g, '')}.docx"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /questoes/:id — a questão inteira, pra editar na visualização da prova (14/10/2026)
router.get('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_QUESTOES).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
        const q = snap.data();
        if (q.curso) { const e = await checarAcessoCurso(req, q.curso); if (e) return res.status(403).json({ error: e }); }
        res.json({ id: snap.id, ...q });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// LINK DO PROFESSOR (10/11/2026) — o coordenador gera um link por disciplina e manda pro professor
// (WhatsApp); o professor abre SEM login, cola as questões (ou manda o Word), marca o gabarito na
// prévia e envia. As questões caem na Revisão de Importação do curso, já com a disciplina, o
// bimestre, a chamada e o semestre do link — o coordenador só confere e confirma.
// O token É o id do documento (aleatório, 24 caracteres) e o link para de funcionar depois do prazo
// ou quando o coordenador desativa.
// ==========================================
const crypto = require('crypto');
const COL_LINKS = 'docencia_bp_links';
const MAX_QUESTOES_ENVIO = 150;

const hojeSP = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ROTULO_CHAMADA = { 1: '1ª chamada', 2: '2ª chamada', exame: 'Exame' };

function situacaoLink(l) {
    if (l.ativo === false) return 'desativado';
    if (l.prazo && l.prazo < hojeSP()) return 'vencido';
    return 'aberto';
}

// o que o professor vê (nada de uid/e-mail de quem criou)
function linkPublico(id, l) {
    const curso = CURSOS.find(c => c.id === l.curso);
    return {
        token: id, cursoNome: curso ? curso.name : l.curso, disciplinaNome: l.disciplinaNome, periodo: l.periodo,
        professorNome: l.professorNome || '', semestre: l.semestre, bimestre: l.bimestre, chamada: l.chamada,
        chamadaRotulo: ROTULO_CHAMADA[l.chamada] || '', prazo: l.prazo, situacao: situacaoLink(l),
        questoesEnviadas: l.questoesEnviadas || 0, ultimoEnvioEm: l.ultimoEnvioEm || null,
        coordenadorNome: l.createdPorNome || ''
    };
}

async function carregarLinkAberto(token, res) {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(token || ''))) { res.status(404).json({ error: 'Link inválido. Confira se copiou o endereço inteiro.' }); return null; }
    const snap = await db.collection(COL_LINKS).doc(token).get();
    if (!snap.exists) { res.status(404).json({ error: 'Link não encontrado. Peça um novo ao coordenador.' }); return null; }
    const l = snap.data();
    const sit = situacaoLink(l);
    if (sit !== 'aberto') {
        res.status(410).json({ error: sit === 'vencido' ? 'O prazo deste link terminou. Peça ao coordenador para abrir um novo.' : 'Este link foi desativado pelo coordenador.', link: linkPublico(snap.id, l) });
        return null;
    }
    return { ref: snap.ref, id: snap.id, l };
}

// --- coordenador ---
// POST /links — { curso, disciplinaId, professorNome, semestre, bimestre, chamada, prazo }
router.post('/links', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.body.curso);
        if (!CURSOS.some(c => c.id === curso)) return res.status(400).json({ error: 'Selecione um curso válido.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const disc = await db.collection(COL_DISCIPLINAS).doc(normalizarTexto(req.body.disciplinaId) || '-').get();
        if (!disc.exists || disc.data().curso !== curso) return res.status(400).json({ error: 'Selecione a disciplina.' });
        const semestre = normalizarTexto(req.body.semestre);
        if (!/^\d{4}\.[12]$/.test(semestre)) return res.status(400).json({ error: 'Informe o semestre (ex.: 2027.1).' });
        const chamada = normalizarChamada(req.body.chamada);
        if (!chamada) return res.status(400).json({ error: 'Selecione a chamada.' });
        const bimestre = chamada === 'exame' ? null : parseInt(req.body.bimestre, 10);
        if (chamada !== 'exame' && ![1, 2].includes(bimestre)) return res.status(400).json({ error: 'Selecione o bimestre.' });
        const prazo = normalizarTexto(req.body.prazo);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo) || prazo < hojeSP()) return res.status(400).json({ error: 'Informe um prazo de hoje em diante.' });
        const professorNome = normalizarTexto(req.body.professorNome).slice(0, 120);

        const token = crypto.randomBytes(18).toString('base64url');
        const dados = {
            curso, disciplinaId: disc.id, disciplinaNome: disc.data().nome, periodo: disc.data().periodo ?? null,
            professorNome, semestre, bimestre, chamada, prazo, ativo: true,
            questoesEnviadas: 0, envios: 0, ultimoEnvioEm: null,
            createdBy: req.user.uid, createdPorNome: req.user.name || req.user.email || 'Coordenador',
            createdAt: new Date().toISOString()
        };
        await db.collection(COL_LINKS).doc(token).set(dados);
        res.status(201).json({ id: token, ...dados, situacao: 'aberto', message: 'Link criado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /links?curso=X — links do curso (lê só os do curso)
router.get('/links', verifyToken, checkPermission, async (req, res) => {
    try {
        const curso = normalizarTexto(req.query.curso);
        if (!curso) return res.status(400).json({ error: 'Informe o curso.' });
        const erroAcesso = await checarAcessoCurso(req, curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const snap = await db.collection(COL_LINKS).where('curso', '==', curso).get();
        const links = snap.docs.map(d => ({ id: d.id, ...d.data(), situacao: situacaoLink(d.data()) }))
            .filter(l => !erroDeDono(req, l))
            .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(links);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /links/:id — { ativo } (desativar/reativar) e/ou { prazo } (prorrogar)
router.put('/links/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_LINKS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Link não encontrado.' });
        const erroAcesso = await checarAcessoCurso(req, snap.data().curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const erroDono = erroDeDono(req, snap.data());
        if (erroDono) return res.status(403).json({ error: erroDono });
        const mud = { updatedAt: new Date().toISOString() };
        if (typeof req.body.ativo === 'boolean') mud.ativo = req.body.ativo;
        if (req.body.prazo !== undefined) {
            const prazo = normalizarTexto(req.body.prazo);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(prazo) || prazo < hojeSP()) return res.status(400).json({ error: 'Informe um prazo de hoje em diante.' });
            mud.prazo = prazo;
        }
        await ref.update(mud);
        const novo = { ...snap.data(), ...mud };
        res.json({ id: snap.id, ...novo, situacao: situacaoLink(novo), message: 'Link atualizado.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /links/:id — exclui o link (11/11/2026). As questões já enviadas por ele continuam (na revisão ou no
// banco); o link some e para de funcionar na hora.
router.delete('/links/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_LINKS).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Link não encontrado.' });
        const erroAcesso = await checarAcessoCurso(req, snap.data().curso);
        if (erroAcesso) return res.status(403).json({ error: erroAcesso });
        const erroDono = erroDeDono(req, snap.data());
        if (erroDono) return res.status(403).json({ error: erroDono });
        await ref.delete();
        res.json({ message: 'Link excluído.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- professor (público, sem login: o token do link é a autorização) ---
router.get('/publico/link/:token', async (req, res) => {
    try {
        if (!/^[A-Za-z0-9_-]{20,40}$/.test(req.params.token)) return res.status(404).json({ error: 'Link inválido. Confira se copiou o endereço inteiro.' });
        const snap = await db.collection(COL_LINKS).doc(req.params.token).get();
        if (!snap.exists) return res.status(404).json({ error: 'Link não encontrado. Peça um novo ao coordenador.' });
        res.json(linkPublico(snap.id, snap.data()));
    } catch (err) {
        res.status(500).json({ error: 'Não foi possível abrir o link agora. Tente de novo em instantes.' });
    }
});

// POST /publico/link/:token/analisar-docx — { arquivoBase64, alternativasPorQuestao } → questões (não grava)
router.post('/publico/link/:token/analisar-docx', async (req, res) => {
    try {
        const link = await carregarLinkAberto(req.params.token, res);
        if (!link) return;
        const alternativasPorQuestao = parseInt(req.body.alternativasPorQuestao, 10);
        if (![4, 5].includes(alternativasPorQuestao)) return res.status(400).json({ error: 'Escolha se as questões têm 4 ou 5 alternativas.' });
        const b64 = String(req.body.arquivoBase64 || '');
        if (!b64) return res.status(400).json({ error: 'Envie o arquivo Word.' });
        if (b64.length > 16 * 1024 * 1024) return res.status(400).json({ error: 'Arquivo grande demais (máx. 12 MB). Tente colar o texto das questões.' });
        let brutas;
        try { brutas = await parseProvaDocx(Buffer.from(b64, 'base64'), alternativasPorQuestao); }
        catch (e) { return res.status(400).json({ error: 'Não consegui ler esse arquivo. Confira se é um documento Word (.docx ou .doc) ou cole o texto.' }); }
        res.json({ questoes: brutas.filter(q => !q.vazia), alternativasPorQuestao });
    } catch (err) {
        res.status(500).json({ error: 'Não foi possível ler o arquivo agora. Tente de novo em instantes.' });
    }
});

// POST /publico/link/:token/enviar — { questoes:[{tipo, enunciado, alternativas, gabarito}], alternativasPorQuestao, professorNome }
router.post('/publico/link/:token/enviar', async (req, res) => {
    try {
        const link = await carregarLinkAberto(req.params.token, res);
        if (!link) return;
        const { l } = link;
        const professorNome = normalizarTexto(req.body.professorNome || l.professorNome).slice(0, 120);
        if (!professorNome) return res.status(400).json({ error: 'Informe o seu nome.' });
        const alternativasPorQuestao = parseInt(req.body.alternativasPorQuestao, 10);
        if (![4, 5].includes(alternativasPorQuestao)) return res.status(400).json({ error: 'Escolha se as questões têm 4 ou 5 alternativas.' });
        const questoes = Array.isArray(req.body.questoes) ? req.body.questoes : [];
        if (!questoes.length) return res.status(400).json({ error: 'Nenhuma questão para enviar.' });
        if (questoes.length > MAX_QUESTOES_ENVIO) return res.status(400).json({ error: `Envie no máximo ${MAX_QUESTOES_ENVIO} questões por vez.` });
        const letras = LETRAS_VALIDAS.slice(0, alternativasPorQuestao);
        const problemas = [];
        const limpas = questoes.map((q, i) => {
            const n = i + 1;
            const dissertativa = q.tipo === 'dissertativa';
            const enunciado = String(q.enunciado || '').trim().slice(0, 20000);
            if (!enunciado) problemas.push(`a ${n}ª está sem enunciado`);
            const alts = dissertativa ? null : (Array.isArray(q.alternativas) ? q.alternativas : []).map(a => String(a || '').trim().slice(0, 4000));
            if (!dissertativa && (alts.length !== alternativasPorQuestao || alts.some(a => !a))) problemas.push(`a ${n}ª precisa de ${alternativasPorQuestao} alternativas preenchidas`);
            if (!dissertativa && !letras.includes(q.gabarito)) problemas.push(`a ${n}ª está sem gabarito`);
            return { dissertativa, enunciado, alts, gabarito: dissertativa ? null : q.gabarito };
        });
        if (problemas.length) return res.status(400).json({ error: `Confira antes de enviar: ${problemas.slice(0, 6).join('; ')}${problemas.length > 6 ? '…' : ''}.` });

        const agora = new Date().toISOString();
        const loteId = db.collection(COL_QUESTOES).doc().id;
        const batch = db.batch();
        limpas.forEach((q, i) => {
            batch.set(db.collection(COL_QUESTOES).doc(), {
                curso: l.curso, disciplinaId: null, periodo: null,
                bimestre: l.bimestre ?? null, chamada: l.chamada ?? null, semestre: l.semestre || null,
                tipo: q.dissertativa ? 'dissertativa' : 'objetiva',
                enunciadoHtml: escHtml(q.enunciado),
                alternativas: q.dissertativa ? null : q.alts.map((texto, j) => ({ letra: LETRAS_VALIDAS[j], texto: escHtml(texto) })),
                gabarito: q.gabarito,
                dificuldade: 'media', valor: null,
                professorNome,
                categoriaSugeridaTexto: l.disciplinaNome,   // a Revisão já casa com a disciplina pelo nome
                numeroOriginal: i + 1,
                loteId, linkId: link.id, origem: 'link-professor',
                status: 'revisao_importacao',
                createdBy: l.createdBy,                     // fica com quem gerou o link (regra de dono do EAD)
                createdPorNome: `${professorNome} (link do professor)`,
                createdAt: agora
            });
        });
        batch.update(link.ref, {
            questoesEnviadas: (l.questoesEnviadas || 0) + limpas.length, envios: (l.envios || 0) + 1,
            ultimoEnvioEm: agora, professorNomeEnvio: professorNome
        });
        await batch.commit();
        res.status(201).json({ message: `${limpas.length} questão(ões) enviada(s) ao coordenador.`, total: limpas.length, questoesEnviadas: (l.questoesEnviadas || 0) + limpas.length });
    } catch (err) {
        res.status(500).json({ error: 'Não foi possível enviar agora. Suas questões continuam na tela — tente de novo em instantes.' });
    }
});

module.exports = router;
