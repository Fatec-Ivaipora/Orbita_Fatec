// Aplicação de Provas — Medicina (16/11/2026)
// 1ª parte: calendário de provas das turmas (T1, T2, T3) + professores aplicadores, laboratórios, apoio e NAPA
// (alunos com laudo fazem a prova em sala separada, com notebooks). Uma fonte só: as duas artes (calendário dos
// alunos e aplicadores dos professores) saem daqui. Status do calendário do semestre: "em montagem" → "validado".
//
// Quem edita: coordenação de Medicina (inclui a secretaria acadêmica), a responsável pelas avaliações (CADAM,
// users.avaliacoesMed) e ADM. Professor de Medicina: só lê, com as aplicações dele destacadas; não recebe os nomes
// dos alunos do NAPA (dado de saúde / LGPD) — só sala, responsável e quantos notebooks.
const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const checkPermission = verifyToken.requireModulePermission('aplicacao-provas-med');
const COL_PROVAS = 'med_aplicacao_provas';
const COL_CONF = 'med_aplicacao_config';
const SEMESTRE = /^\d{4}\.[12]$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;
const TURNOS = ['manha', 'tarde', 'noite'];
const TIPOS = ['prova', 'pratica', 'osce', 'outra'];
const ETAPAS = ['b1', 'b2', 'sub', 'exame']; // 1º bimestre, 2º bimestre, substitutiva, exame

function podeEditar(user) {
    return ['adm_l1', 'adm_l2', 'coord_medicina'].includes(user.role) || user.avaliacoesMed === true;
}
function exigeEditor(req, res, next) {
    if (!podeEditar(req.user)) return res.status(403).json({ error: 'Só a coordenação de Medicina, a secretaria acadêmica e a responsável pelas avaliações alteram o calendário.' });
    next();
}
// quem edita (coordenação, secretaria, responsável CADAM, ADM) entra pela regra do módulo — a Ana Beatriz tem cargo de
// professora (nível de leitura), mas edita pela marca de responsável pelas avaliações
router.use(verifyToken, (req, res, next) => (podeEditar(req.user) ? next() : checkPermission(req, res, next)));

const agora = () => new Date().toISOString();
const quem = (req) => req.user.name || req.user.email || 'Usuário';
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const lista = (v, n, max) => (Array.isArray(v) ? v : []).map(x => txt(x, n)).filter(Boolean).slice(0, max);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const semestreAtual = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };

// as turmas da Medicina no semestre (T1/T2/T3 ↔ período). Padrão de 2026.2, ajustável na tela.
const TURMAS_PADRAO = [
    { id: 'T1', periodo: 5, napa: true },
    { id: 'T2', periodo: 4, napa: true },
    { id: 'T3', periodo: 2, napa: false }
];
const CONF_PADRAO = (semestre) => ({
    semestre, turmas: TURMAS_PADRAO, apoio: [], napa: { responsavelManha: '', responsavelTarde: '', sala: '' },
    napaAlunos: {}, status: 'montagem', validadoEm: null, validadoPor: null
});

async function lerConfig(semestre) {
    const s = await db.collection(COL_CONF).doc(semestre).get();
    return s.exists ? { ...CONF_PADRAO(semestre), ...s.data() } : CONF_PADRAO(semestre);
}
// o professor nunca recebe os nomes dos alunos do NAPA — só quantos são (pra saber dos notebooks)
function configPara(conf, editor) {
    if (editor) return conf;
    const { napaAlunos, ...resto } = conf;
    const napaQtd = {};
    Object.entries(napaAlunos || {}).forEach(([t, l]) => { napaQtd[t] = (l || []).length; });
    return { ...resto, napaQtd };
}

// é aplicação desta pessoa? ("Paulo Goes" ⊂ "Paulo Roberto Nunes de Goes"; "Milene" = primeiro nome)
function ehMinha(aplicador, meuNome) {
    const a = norm(aplicador).split(' ').filter(w => w.length > 1 && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(w));
    const eu = norm(meuNome).split(' ');
    if (!a.length || !eu.length) return false;
    if (a.length === 1) return a[0] === eu[0];
    return a[0] === eu[0] && a.slice(1).every(w => eu.includes(w));
}
const perfilCache = new Map();
async function meuNome(user) {
    const c = perfilCache.get(user.uid);
    if (c && Date.now() - c.em < 5 * 60000) return c.nome;
    const s = await db.collection('users').doc(user.uid).get();
    const nome = (s.exists && (s.data().name || s.data().nome)) || user.name || '';
    perfilCache.set(user.uid, { em: Date.now(), nome });
    return nome;
}

function provaDoBody(b) {
    const p = {
        turma: txt(b.turma, 10).toUpperCase(),
        data: txt(b.data, 10),
        turno: TURNOS.includes(b.turno) ? b.turno : (b.turno === '' ? '' : 'manha'), // '' = turno a definir
        horario: HORA.test(b.horario || '') ? b.horario : '',
        disciplina: txt(b.disciplina, 160),
        tipo: TIPOS.includes(b.tipo) ? b.tipo : 'prova',
        etapa: ETAPAS.includes(b.etapa) ? b.etapa : 'b2',
        aplicadores: lista(b.aplicadores, 120, 12),
        laboratorios: txt(b.laboratorios, 200),
        observacao: txt(b.observacao, 500),
        napa: b.napa && typeof b.napa === 'object' ? {
            sala: txt(b.napa.sala, 120), responsavel: txt(b.napa.responsavel, 120),
            notebooks: Math.max(0, Math.min(99, parseInt(b.napa.notebooks, 10) || 0))
        } : null
    };
    if (!p.turma) throw Object.assign(new Error('Escolha a turma.'), { status: 400 });
    if (!DATA.test(p.data)) throw Object.assign(new Error('Informe a data da prova.'), { status: 400 });
    if (!p.disciplina) throw Object.assign(new Error('Informe a disciplina.'), { status: 400 });
    return p;
}
const erro = (res, e) => res.status(e.status || 500).json({ error: e.message });

// ---------- leitura (todos com acesso ao módulo) ----------
router.get('/', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : semestreAtual();
        const editor = podeEditar(req.user);
        const [conf, snap, nome] = await Promise.all([
            lerConfig(semestre),
            db.collection(COL_PROVAS).where('semestre', '==', semestre).get(),
            meuNome(req.user)
        ]);
        const provas = snap.docs.map(d => {
            const p = { id: d.id, ...d.data() };
            p.minha = (p.aplicadores || []).some(a => ehMinha(a, nome));
            return p;
        }).sort((a, b) => a.data.localeCompare(b.data) || (a.horario || '').localeCompare(b.horario || '') || a.turma.localeCompare(b.turma));
        res.json({ semestre, editor, podeImprimir: podeImprimir(req.user), meuNome: nome, config: configPara(conf, editor), provas });
    } catch (e) { erro(res, e); }
});

// semestres que já têm calendário (lista curta, pra escolher)
router.get('/semestres', async (req, res) => {
    try {
        const snap = await db.collection(COL_CONF).get();
        const s = new Set(snap.docs.map(d => d.id));
        s.add(semestreAtual());
        res.json([...s].filter(x => SEMESTRE.test(x)).sort().reverse());
    } catch (e) { erro(res, e); }
});

// disciplinas e professores da Medicina no semestre (Edubox, via relay) — pra escolher em vez de digitar
router.get('/edubox', exigeEditor, async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : semestreAtual();
        const { listaDisciplinas } = require('./banco-med-avaliacoes')._interno;
        const { fonte, disciplinas } = await listaDisciplinas(semestre);
        const professores = [...new Set(disciplinas.flatMap(d => d.professores))].sort((a, b) => a.localeCompare(b));
        res.json({ fonte, disciplinas: disciplinas.map(d => ({ nome: d.nome, periodo: d.periodo, professores: d.professores })), professores });
    } catch (e) { erro(res, e); }
});

// ---------- edição ----------
router.post('/provas', exigeEditor, async (req, res) => {
    try {
        const semestre = req.body.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Informe o semestre.' });
        const p = provaDoBody(req.body);
        const ref = db.collection(COL_PROVAS).doc();
        await ref.set({ ...p, semestre, criadoPor: req.user.uid, criadoPorNome: quem(req), criadoEm: agora(), atualizadoEm: agora(), atualizadoPor: quem(req) });
        await marcarAlterado(semestre, req);
        res.status(201).json({ id: ref.id, message: 'Prova incluída no calendário.' });
    } catch (e) { erro(res, e); }
});
router.put('/provas/:id', exigeEditor, async (req, res) => {
    try {
        const ref = db.collection(COL_PROVAS).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        const p = provaDoBody(req.body);
        await ref.update({ ...p, atualizadoEm: agora(), atualizadoPor: quem(req) });
        await marcarAlterado(s.data().semestre, req);
        res.json({ message: 'Prova atualizada.' });
    } catch (e) { erro(res, e); }
});
router.delete('/provas/:id', exigeEditor, async (req, res) => {
    try {
        const ref = db.collection(COL_PROVAS).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        await ref.delete();
        await marcarAlterado(s.data().semestre, req);
        res.json({ message: 'Prova retirada do calendário.' });
    } catch (e) { erro(res, e); }
});

// alterou depois de validado → volta pra "em montagem" (precisa validar de novo antes de mandar aos setores)
async function marcarAlterado(semestre, req) {
    const ref = db.collection(COL_CONF).doc(semestre);
    const s = await ref.get();
    if (s.exists && s.data().status === 'validado') {
        await ref.update({ status: 'montagem', reabertoEm: agora(), reabertoPor: quem(req), motivoReabertura: 'alteração depois de validado' });
    }
}

router.put('/config/:semestre', exigeEditor, async (req, res) => {
    try {
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const b = req.body || {};
        const turmas = (Array.isArray(b.turmas) ? b.turmas : []).slice(0, 8).map(t => ({
            id: txt(t.id, 10).toUpperCase(), periodo: Math.max(1, Math.min(12, parseInt(t.periodo, 10) || 1)), napa: t.napa === true
        })).filter(t => t.id);
        const napaAlunos = {};
        Object.entries(b.napaAlunos || {}).forEach(([t, l]) => { napaAlunos[txt(t, 10).toUpperCase()] = lista(l, 120, 60); });
        const dados = {
            semestre, turmas: turmas.length ? turmas : TURMAS_PADRAO,
            apoio: lista(b.apoio, 80, 20),
            napa: { responsavelManha: txt(b.napa && b.napa.responsavelManha, 80), responsavelTarde: txt(b.napa && b.napa.responsavelTarde, 80), sala: txt(b.napa && b.napa.sala, 120) },
            napaAlunos, atualizadoEm: agora(), atualizadoPor: quem(req)
        };
        const ref = db.collection(COL_CONF).doc(semestre);
        const s = await ref.get();
        if (s.exists && s.data().status === 'validado') Object.assign(dados, { status: 'montagem', reabertoEm: agora(), reabertoPor: quem(req), motivoReabertura: 'configuração alterada depois de validado' });
        await ref.set(dados, { merge: true });
        res.json({ message: 'Configuração salva.' });
    } catch (e) { erro(res, e); }
});

router.post('/config/:semestre/validar', exigeEditor, async (req, res) => {
    try {
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const snap = await db.collection(COL_PROVAS).where('semestre', '==', semestre).limit(1).get();
        if (snap.empty) return res.status(400).json({ error: 'O calendário ainda não tem provas.' });
        await db.collection(COL_CONF).doc(semestre).set({ semestre, status: 'validado', validadoEm: agora(), validadoPor: quem(req) }, { merge: true });
        res.json({ message: 'Calendário validado. Já pode imprimir e mandar aos setores.' });
    } catch (e) { erro(res, e); }
});
router.post('/config/:semestre/reabrir', exigeEditor, async (req, res) => {
    try {
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        await db.collection(COL_CONF).doc(semestre).set({ status: 'montagem', reabertoEm: agora(), reabertoPor: quem(req), motivoReabertura: 'reaberto' }, { merge: true });
        res.json({ message: 'Calendário reaberto para alteração.' });
    } catch (e) { erro(res, e); }
});

// ---------- IMPRESSÃO DA PROVA (24/11/2026) ----------
// A secretaria acadêmica (Joyce) imprime, para cada prova e por sala: a lista da porta (aluno e nº do computador),
// a folha de login de cada aluno (login = RA, senha = "F" + CPF — padrão da Fatec) e a ata de aplicação.
// Salas: LAB12 (computadores 1–60), LAB20 (1–30) e a sala do NAPA (notebooks, sem número). Os alunos do NAPA não
// entram nas listas dos laboratórios. A divisão de cada turma entre os laboratórios fica na configuração (salas).
// Alunos, RA e CPF vêm do Edubox (relay /med-provas/alunos) na hora; NADA disso é gravado no Órbita.
// Só a coordenação de Medicina (inclui a secretaria acadêmica) e o ADM: a senha sai do CPF (dado pessoal).
const { relay } = require('../utils/edubox-relay');
const SALAS_LAB = { LAB12: 60, LAB20: 30 };
const SAIU_MATRICULA = /^(cancel|tranc|desist|transf|evad|abandon)/i;
const SALAS_PADRAO = {
    T1: { modo: 'unica', primeira: 'LAB12', ate: '', segunda: '' },
    T2: { modo: 'dividida', primeira: 'LAB20', ate: 'EMILY SILVA', segunda: 'LAB12' },
    T3: { modo: 'dividida', primeira: 'LAB12', ate: 'MARIA EDUARDA SILVA', segunda: 'LAB20' }
};
const podeImprimir = (user) => ['adm_l1', 'adm_l2', 'coord_medicina'].includes(user.role);
function exigeImpressao(req, res, next) {
    if (!podeImprimir(req.user)) return res.status(403).json({ error: 'A impressão das provas (logins dos alunos) é só da coordenação e da secretaria acadêmica de Medicina.' });
    next();
}
function salasDaConfig(conf) {
    const out = {};
    (conf.turmas || []).forEach(t => { out[t.id] = { ...(SALAS_PADRAO[t.id] || { modo: 'unica', primeira: 'LAB12', ate: '', segunda: '' }), ...((conf.salas || {})[t.id] || {}) }; });
    return out;
}

// GET /impressao/alunos?semestre=2026.2&turma=T1 → { turma, periodo, alunos: [{ nome, ra, senha }], semCpf, salas }
router.get('/impressao/alunos', exigeImpressao, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Semestre inválido.' });
        const conf = await lerConfig(semestre);
        const turma = (conf.turmas || []).find(t => t.id === String(req.query.turma || '').toUpperCase());
        if (!turma) return res.status(400).json({ error: 'Turma não encontrada na configuração.' });
        let r;
        try { r = await relay(`/med-provas/alunos?semestre=${encodeURIComponent(semestre.replace('.', '-'))}`, { timeoutMs: 30000 }); }
        catch (e) {
            // 401/404: a rota /med-provas ainda não foi instalada no relay (regras/relay/instalar-med-provas.sh)
            if (e.status === 401 || e.status === 404) return res.status(503).json({ error: 'A busca dos alunos no Edubox para a impressão ainda não foi instalada no servidor do relay. Avise o Suporte AVA.' });
            return res.status(502).json({ error: `O Edubox não respondeu (${e.message}). Tente de novo em instantes.` });
        }
        if (!r || !r.ok) return res.status(502).json({ error: `O Edubox não respondeu (${(r && r.erro) || 'relay'}). Tente de novo em instantes.` });
        const vistos = new Set();
        const alunos = (r.alunos || [])
            // aluno da turma de dependência ("DP - MEDICINA") não faz a prova junto com a turma regular: fica de fora
            .filter(a => Number(a.periodo) === Number(turma.periodo) && !SAIU_MATRICULA.test(a.situacao || '') && a.ra && !/^\s*DP\b/i.test(a.turma || ''))
            .filter(a => { if (vistos.has(a.ra)) return false; vistos.add(a.ra); return true; })
            .map(a => ({ nome: txt(a.nome, 160).toUpperCase(), ra: txt(a.ra, 20), senha: /^\d{11}$/.test(a.cpf || '') ? `F${a.cpf}` : '' }))
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ turma: turma.id, periodo: turma.periodo, alunos, semCpf: alunos.filter(a => !a.senha).length, salas: salasDaConfig(conf)[turma.id], capacidade: SALAS_LAB });
    } catch (e) { erro(res, e); }
});

// PUT /impressao/napa/:semestre { turma, nomes: [...] } — nomes completos dos alunos do NAPA da turma (a tela da
// impressão troca o primeiro nome cadastrado pelo nome do Edubox). Não reabre o calendário validado: é só cadastro.
router.put('/impressao/napa/:semestre', exigeImpressao, async (req, res) => {
    try {
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const conf = await lerConfig(semestre);
        const turma = txt((req.body || {}).turma, 10).toUpperCase();
        if (!(conf.turmas || []).some(t => t.id === turma && t.napa)) return res.status(400).json({ error: 'Essa turma não tem NAPA na configuração.' });
        const nomes = lista((req.body || {}).nomes, 120, 60);
        await db.collection(COL_CONF).doc(semestre).set({ semestre, napaAlunos: { ...(conf.napaAlunos || {}), [turma]: nomes }, napaEm: agora(), napaPor: quem(req) }, { merge: true });
        res.json({ message: `Alunos do NAPA da ${turma} salvos.`, nomes });
    } catch (e) { erro(res, e); }
});

// PUT /impressao/salas/:semestre { salas: { T1: { modo, primeira, ate, segunda } } } — como cada turma se divide nos laboratórios
router.put('/impressao/salas/:semestre', exigeImpressao, async (req, res) => {
    try {
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const conf = await lerConfig(semestre);
        const salas = { ...(conf.salas || {}) };
        Object.entries((req.body || {}).salas || {}).forEach(([t, s]) => {
            const id = txt(t, 10).toUpperCase();
            if (!(conf.turmas || []).some(x => x.id === id) || !s) return;
            const lab = (v) => (SALAS_LAB[v] ? v : '');
            const modo = s.modo === 'dividida' ? 'dividida' : 'unica';
            const primeira = lab(s.primeira) || 'LAB12';
            // inicio: em que computador a numeração começa em cada laboratório (a Joyce escolhe; padrão 1)
            const inicio = {};
            Object.keys(SALAS_LAB).forEach(k => { const v = parseInt((s.inicio || {})[k], 10); inicio[k] = Number.isInteger(v) ? Math.max(1, Math.min(SALAS_LAB[k], v)) : 1; });
            salas[id] = { modo, primeira, ate: modo === 'dividida' ? txt(s.ate, 160).toUpperCase() : '', segunda: modo === 'dividida' ? (lab(s.segunda) || (primeira === 'LAB12' ? 'LAB20' : 'LAB12')) : '', inicio };
            if (salas[id].modo === 'dividida' && !salas[id].ate) throw Object.assign(new Error(`Na ${id}, escolha até qual aluno vai para o ${primeira}.`), { status: 400 });
        });
        await db.collection(COL_CONF).doc(semestre).set({ semestre, salas, salasEm: agora(), salasPor: quem(req) }, { merge: true });
        res.json({ message: 'Divisão das salas salva.', salas });
    } catch (e) { erro(res, e); }
});

router._interno = { ehMinha, podeEditar, norm };
module.exports = router;
