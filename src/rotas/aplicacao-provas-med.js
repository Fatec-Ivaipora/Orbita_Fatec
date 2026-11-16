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
        turno: TURNOS.includes(b.turno) ? b.turno : 'manha',
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
        res.json({ semestre, editor, meuNome: nome, config: configPara(conf, editor), provas });
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

router._interno = { ehMinha, podeEditar, norm };
module.exports = router;
