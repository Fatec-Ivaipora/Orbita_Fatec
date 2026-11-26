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
const { db, admin } = require('../firebase');
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
        // quantas questões tem a prova (25/11/2026; aparece na arte das adaptações). 0 = não informado
        questoes: Math.max(0, Math.min(300, parseInt(b.questoes, 10) || 0)),
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
            if (!podeImprimir(req.user)) delete p.salaAdp; // nome do aluno de ADP/DP: só quem imprime
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
// Provas de ADAPTAÇÃO (ADP) e DEPENDÊNCIA (DP) — 25/11/2026: não são uma turma do calendário (T1/T2/T3). Quem faz
// é quem está matriculado na disciplina fora da turma dela (no Edubox, aluno x disciplina de outra turma). Os alunos
// vêm do CADD (cad_turmas, sincronizado do Edubox) pela disciplina da prova; RA e CPF, do relay, como nas turmas.
const TURMAS_ESPECIAIS = { ADP: 'Adaptação', DP: 'Dependência' };
const PARTIC = new Set(['de', 'da', 'do', 'dos', 'das', 'e', 'em', 'teorica', 'pratica']);
// "Medicina Baseada em Evidências II" ~ "MEDICINA BASEADAS EM EVIDÊNCIAS II": sem acento, sem partícula, sem plural
const toksDisc = (s) => norm(s).split(' ').filter(w => w && !PARTIC.has(w)).map(w => (w.length > 3 ? w.replace(/s$/, '') : w));
function parecidaDisc(a, b) {
    const x = new Set(toksDisc(a)), y = new Set(toksDisc(b));
    if (!x.size || !y.size) return 0;
    const comum = [...x].filter(w => y.has(w)).length;
    // número romano / ordinal diferente (I x II) não é a mesma disciplina
    const rom = (s) => [...s].filter(w => /^(i{1,3}|iv|v|vi{0,3}|ix|x)$/.test(w)).join(',');
    if (rom(x) !== rom(y)) return 0;
    return comum / Math.max(x.size, y.size);
}
// { 'NOME DA DISCIPLINA': [{ ra, nome, turmaAluno }] } — só matrícula de disciplina FORA da turma (adaptação/dependência)
async function foraDaTurma(semestre) {
    const sem = semestre.replace('.', '-');
    const snap = await db.collection('cad_turmas').where('semestre', '==', sem).get();
    const porDisc = {};
    let atualizadoEm = '';
    snap.docs.forEach(d => {
        const t = d.data();
        if (t.segmento && t.segmento !== 'MED') return;
        if (t.atualizadoEm > atualizadoEm) atualizadoEm = t.atualizadoEm;
        const disc = new Map((t.disciplinas || []).map(x => [x.id, x]));
        (t.alunos || []).forEach(a => (a.d || []).forEach(x => {
            const di = disc.get(x.id);
            if (!di || !di.dp || !a.alu) return;
            (porDisc[di.nome] = porDisc[di.nome] || []).push({ ra: String(a.alu), nome: txt(a.nome, 160).toUpperCase(), turmaAluno: txt(t.turma, 60) });
        }));
    });
    return { porDisc, atualizadoEm };
}

const podeImprimir = (user) => ['adm_l1', 'adm_l2', 'coord_medicina'].includes(user.role);
function exigeImpressao(req, res, next) {
    if (!podeImprimir(req.user)) return res.status(403).json({ error: 'A impressão das provas (logins dos alunos) é só da coordenação e da secretaria acadêmica de Medicina.' });
    next();
}
function salasDaConfig(conf) {
    const out = {};
    [...(conf.turmas || []).map(t => t.id), ...Object.keys(TURMAS_ESPECIAIS)].forEach(id => { out[id] = { ...(SALAS_PADRAO[id] || { modo: 'unica', primeira: 'LAB12', ate: '', segunda: '' }), ...((conf.salas || {})[id] || {}) }; });
    return out;
}
async function cpfsDoRelay(semestre) {
    const r = await relay(`/med-provas/alunos?semestre=${encodeURIComponent(semestre.replace('.', '-'))}`, { timeoutMs: 30000 });
    if (!r || !r.ok) throw Object.assign(new Error(`O Edubox não respondeu (${(r && r.erro) || 'relay'}). Tente de novo em instantes.`), { status: 502 });
    return r.alunos || [];
}
const senhaDe = (cpf) => (/^\d{11}$/.test(cpf || '') ? `F${cpf}` : '');

// GET /impressao/alunos?semestre=2026.2&turma=T1 → { turma, periodo, alunos: [{ nome, ra, senha }], semCpf, salas }
router.get('/impressao/alunos', exigeImpressao, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Semestre inválido.' });
        const conf = await lerConfig(semestre);
        const pedida = String(req.query.turma || '').toUpperCase();
        if (TURMAS_ESPECIAIS[pedida]) return res.json(await alunosEspeciais(semestre, conf, pedida, req.query));
        const turma = (conf.turmas || []).find(t => t.id === pedida);
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

// ADP/DP: alunos matriculados na disciplina fora da turma dela. ?disciplina=<nome na prova> escolhe a disciplina do
// Edubox mais parecida; ?edubox=<nome exato> força a escolha (a tela deixa trocar).
async function alunosEspeciais(semestre, conf, turmaId, q) {
    const { porDisc, atualizadoEm } = await foraDaTurma(semestre);
    const opcoes = Object.keys(porDisc).sort((a, b) => a.localeCompare(b, 'pt-BR')).map(nome => ({ nome, n: new Set(porDisc[nome].map(a => a.ra)).size }));
    let escolhida = porDisc[q.edubox] ? q.edubox : '';
    if (!escolhida) {
        const melhor = opcoes.map(o => ({ nome: o.nome, s: parecidaDisc(q.disciplina, o.nome) })).sort((a, b) => b.s - a.s)[0];
        if (melhor && melhor.s >= 0.6) escolhida = melhor.nome;
    }
    const base = { turma: turmaId, rotuloTurma: TURMAS_ESPECIAIS[turmaId], periodo: null, especial: true, disciplinaEdubox: escolhida, opcoes, atualizadoEm, salas: salasDaConfig(conf)[turmaId], capacidade: SALAS_LAB };
    if (!escolhida) return { ...base, alunos: [], semCpf: 0 };
    let doRelay;
    try { doRelay = await cpfsDoRelay(semestre); }
    catch (e) {
        if (e.status === 401 || e.status === 404) throw Object.assign(new Error('A busca dos alunos no Edubox para a impressão ainda não foi instalada no servidor do relay. Avise o Suporte AVA.'), { status: 503 });
        throw Object.assign(new Error(e.status === 502 ? e.message : `O Edubox não respondeu (${e.message}). Tente de novo em instantes.`), { status: 502 });
    }
    const cpf = new Map(doRelay.filter(a => a.ra && !SAIU_MATRICULA.test(a.situacao || '')).map(a => [String(a.ra).trim(), a.cpf]));
    const vistos = new Set();
    const alunos = porDisc[escolhida]
        .filter(a => { if (vistos.has(a.ra)) return false; vistos.add(a.ra); return true; })
        .map(a => ({ nome: a.nome, ra: a.ra, senha: senhaDe(cpf.get(a.ra)), turmaAluno: a.turmaAluno }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return { ...base, alunos, semCpf: alunos.filter(a => !a.senha).length };
}

// PUT /impressao/prova/:id/sala { sala: 'LAB12'|'LAB20'|'OUTRA', salaNome, pcs: { 'NOME DO ALUNO': 7 } }
// ADP/DP (25/11/2026): a Joyce escolhe a sala e o computador de cada aluno — às vezes fazem junto com outra turma no
// mesmo laboratório, nos computadores que sobram. Fica na própria prova (salaAdp); não reabre o calendário validado.
// Chave = nome do aluno (como o NAPA), nunca RA/CPF.
router.put('/impressao/prova/:id/sala', exigeImpressao, async (req, res) => {
    try {
        const ref = db.collection(COL_PROVAS).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        if (!TURMAS_ESPECIAIS[s.data().turma]) return res.status(400).json({ error: 'Sala por aluno é só para as provas de adaptação e DP.' });
        const b = req.body || {};
        const sala = ['LAB12', 'LAB20', 'OUTRA'].includes(b.sala) ? b.sala : 'LAB12';
        const max = SALAS_LAB[sala] || 999;
        const pcs = {};
        Object.entries(b.pcs || {}).slice(0, 80).forEach(([nome, n]) => {
            const v = parseInt(n, 10);
            if (Number.isInteger(v) && v >= 1 && v <= max) pcs[txt(nome, 160).toUpperCase()] = v;
        });
        const salaAdp = { sala, salaNome: sala === 'OUTRA' ? txt(b.salaNome, 60) : '', pcs, em: agora(), por: quem(req) };
        await ref.update({ salaAdp });
        res.json({ message: 'Sala e computadores salvos.', salaAdp });
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
            if (!((conf.turmas || []).some(x => x.id === id) || TURMAS_ESPECIAIS[id]) || !s) return;
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
// ---------- Resultados do AVA (25/11/2026) ----------
// O agente do droplet (scripts/ava-banco-med-agente.js) lê o relatório de cada questionário que já fechou e grava
// em med_resultados_ava/<id da prova>: quem fez (com a nota), quem não fez (lista da 2ª chamada) e a média.
// Notas de aluno: só coordenação de Medicina e ADM (os mesmos da Impressão). O RA vem do Edubox, casando pelo nome.
const COL_RES = 'med_resultados_ava';
// Questão anulada (26/11/2026): a coordenação anula no Órbita e as notas são recontadas — quem fez a prova ganha o
// valor cheio da questão (mesma regra da Correção de Provas). Fica em coleção própria porque o agente regrava
// med_resultados_ava/<id> inteiro a cada leitura. Precisa da nota de cada questão (colunas "Q. n" do AVA).
const COL_ANUL = 'med_resultados_anuladas';
const normNomeAluno = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const arred = (n, c = 2) => Math.round(n * 10 ** c) / 10 ** c;
function aplicarAnulacao(r, anul) {
    const questoes = Array.isArray(r.questoes) ? r.questoes : [];
    const anuladas = ((anul && anul.questoes) || []).filter(n => questoes.some(q => q.n === n));
    const fez = (r.alunos || []).filter(a => a.situacao === 'finalizada');
    const comQ = fez.filter(a => Array.isArray(a.q) && a.q.length === questoes.length);
    const somaMax = questoes.reduce((s, q) => s + (q.max || 0), 0);
    // desempenho de cada questão: média obtida ÷ valor (com a nota original do AVA)
    const porQuestao = questoes.map((q, i) => {
        const obtidas = comQ.map(a => a.q[i]).filter(v => v !== null && v !== undefined);
        const acerto = obtidas.length && q.max ? obtidas.reduce((s, v) => s + v, 0) / (obtidas.length * q.max) : null;
        return { n: q.n, max: q.max, acerto: acerto === null ? null : arred(acerto, 3), respostas: obtidas.length, anulada: anuladas.includes(q.n) };
    });
    // leituras antigas guardaram a linha "Média geral" do relatório como se fosse aluno
    let alunos = (r.alunos || []).filter(a => !/^MEDIA GERAL\b/.test(normNomeAluno(a.nome)));
    let media = r.media;
    if (anuladas.length && somaMax && r.notaMax) {
        alunos = alunos.map(a => {
            if (a.situacao !== 'finalizada' || !Array.isArray(a.q) || a.q.length !== questoes.length) return a;
            const soma = questoes.reduce((s, q, i) => s + (anuladas.includes(q.n) ? q.max : (a.q[i] || 0)), 0);
            return { ...a, notaAva: a.nota, nota: arred(soma / somaMax * r.notaMax) };
        });
        const notas = alunos.filter(a => a.situacao === 'finalizada' && a.nota !== null && a.nota !== undefined).map(a => a.nota);
        media = notas.length ? arred(notas.reduce((s, n) => s + n, 0) / notas.length) : null;
    }
    // Dispensado (26/11/2026): aluno sem nota que não precisa fazer a prova (dispensa da disciplina etc.). A
    // coordenação marca na aba 2ª chamada; sai da lista da 2ª chamada e da contagem "não fizeram". Guardado
    // pelo nome normalizado em med_resultados_anuladas/<prova>.dispensados (o agente não mexe nessa coleção).
    const dispensados = new Set((anul && anul.dispensados) || []);
    const semLinhaMedia = (r.alunos || []).length - alunos.length;
    alunos = alunos.map(a => (a.situacao !== 'finalizada' && dispensados.has(normNomeAluno(a.nome)) ? { ...a, dispensado: true } : a));
    const contagem = r.contagem ? {
        ...r.contagem, inscritos: (r.contagem.inscritos || 0) - semLinhaMedia,
        naoFizeram: alunos.filter(a => a.situacao === 'nao_fez' && !a.dispensado).length,
        outros: alunos.filter(a => a.situacao !== 'finalizada' && a.situacao !== 'nao_fez' && !a.dispensado).length,
        dispensados: alunos.filter(a => a.dispensado).length
    } : r.contagem;
    return {
        ...r, alunos, media, mediaAva: r.media, porQuestao, anuladas, contagem,
        anulacao: anuladas.length ? { por: anul.por || '', em: anul.em || '' } : null,
        podeAnular: questoes.length > 0 && comQ.length === fez.length
    };
}
router._interno.aplicarAnulacao = aplicarAnulacao;
router.get('/resultados', exigeImpressao, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : semestreAtual();
        const [snap, cfg, anSnap] = await Promise.all([db.collection(COL_RES).where('semestre', '==', semestre).get(), db.collection('config').doc('ava_banco_sync').get(),
            db.collection(COL_ANUL).where('semestre', '==', semestre).get()]);
        const anulPor = new Map(anSnap.docs.map(d => [d.id, d.data()]));
        const resultados = snap.docs.map(d => {
            const { alunos, porQuestao, ...r } = aplicarAnulacao({ id: d.id, ...d.data() }, anulPor.get(d.id));
            const notas = (alunos || []).filter(a => a.situacao === 'finalizada' && a.nota !== null && a.nota !== undefined).map(a => a.nota);
            return { ...r, maior: notas.length ? Math.max(...notas) : null, menor: notas.length ? Math.min(...notas) : null, questoes: undefined };
        });
        const c = cfg.exists ? cfg.data() : {};
        res.json({ semestre, resultados, agente: { vivoEm: c.agenteVivoEm || null, pedidoEm: c.pedidoEm || null, ultimaRodada: c.ultimaRodada || null, rodandoDesde: c.rodandoDesde || null } });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.get('/resultados/:id', exigeImpressao, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const [snap, an] = await Promise.all([db.collection(COL_RES).doc(req.params.id).get(), db.collection(COL_ANUL).doc(req.params.id).get()]);
        if (!snap.exists) return res.status(404).json({ error: 'Ainda não há resultado do AVA para esta prova.' });
        const r = aplicarAnulacao({ id: snap.id, ...snap.data() }, an.exists ? an.data() : null);
        // RA pelo nome (Edubox via relay). Sem o Edubox, a lista sai só com o nome.
        let semRa = null;
        try {
            const doEdubox = await cpfsDoRelay(r.semestre);
            const porNome = new Map();
            doEdubox.forEach(a => { const k = normNomeAluno(a.nome); if (k && a.ra) porNome.set(k, porNome.has(k) && porNome.get(k) !== a.ra ? 'duplicado' : String(a.ra)); });
            r.alunos = (r.alunos || []).map(a => { const ra = porNome.get(normNomeAluno(a.nome)); return { ...a, ra: ra && ra !== 'duplicado' ? ra : '' }; });
        } catch (e) { semRa = `Não consegui buscar o RA no Edubox (${e.message}).`; }
        res.json({ ...r, semRa });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// PUT /resultados/:id/anuladas { questoes: [3, 17] } — anula (ou desfaz, com lista vazia) e reconta as notas
router.put('/resultados/:id/anuladas', exigeImpressao, async (req, res) => {
    try {
        const snap = await db.collection(COL_RES).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Ainda não há resultado do AVA para esta prova.' });
        const r = snap.data();
        const validas = new Set((r.questoes || []).map(q => q.n));
        if (!validas.size) return res.status(400).json({ error: 'Esta leitura do AVA não trouxe a nota de cada questão. Clique em "Ler agora no AVA" e tente de novo.' });
        const questoes = [...new Set((Array.isArray(req.body.questoes) ? req.body.questoes : []).map(Number))].filter(n => validas.has(n)).sort((a, b) => a - b);
        if (questoes.length >= validas.size) return res.status(400).json({ error: 'Não dá para anular todas as questões.' });
        const quemFoi = req.user.name || req.user.email || 'Coordenação';
        // merge: não apaga os dispensados guardados no mesmo documento
        await db.collection(COL_ANUL).doc(req.params.id).set({ semestre: r.semestre, provaId: req.params.id, questoes, por: quemFoi, em: new Date().toISOString() }, { merge: true });
        res.json({ message: questoes.length ? `Questão${questoes.length > 1 ? 'ões' : ''} ${questoes.join(', ')} anulada${questoes.length > 1 ? 's' : ''}: notas recontadas.` : 'Anulação desfeita: valem as notas do AVA.', questoes });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// PUT /resultados/:id/dispensado { nome, dispensado: true|false } — aluno sem nota que não faz 2ª chamada
router.put('/resultados/:id/dispensado', exigeImpressao, async (req, res) => {
    try {
        const snap = await db.collection(COL_RES).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Ainda não há resultado do AVA para esta prova.' });
        const r = snap.data();
        const chave = normNomeAluno(req.body.nome);
        const aluno = (r.alunos || []).find(a => normNomeAluno(a.nome) === chave);
        if (!aluno) return res.status(404).json({ error: 'Aluno não encontrado nesta prova.' });
        if (aluno.situacao === 'finalizada') return res.status(400).json({ error: 'Esse aluno fez a prova: não dá para marcar como dispensado.' });
        const ref = db.collection(COL_ANUL).doc(req.params.id);
        const marca = !!req.body.dispensado;
        const quemFoi = req.user.name || req.user.email || 'Coordenação';
        await ref.set({
            semestre: r.semestre, provaId: req.params.id,
            dispensados: marca ? admin.firestore.FieldValue.arrayUnion(chave) : admin.firestore.FieldValue.arrayRemove(chave),
            dispensadosPor: quemFoi, dispensadosEm: new Date().toISOString()
        }, { merge: true });
        res.json({ message: marca ? `${aluno.nome} marcado(a) como dispensado(a): sai da 2ª chamada.` : `${aluno.nome} voltou para a lista da 2ª chamada.` });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/resultados/agora', exigeImpressao, async (req, res) => {
    try {
        // 26/11/2026: com { provaId } lê só aquela prova ("Ler de novo no AVA"); sem, todas as já aplicadas
        const { pedirAoAgente } = require('../utils/ava-pedidos');
        const provaId = req.body && req.body.provaId ? String(req.body.provaId) : null;
        const p = await pedirAoAgente({ tipo: 'resultados', alvo: provaId, por: req.user.name || req.user.email || 'Coordenação' });
        res.json({ ...p, message: provaId ? 'Pedido enviado: o Órbita lê esta prova no AVA em instantes.' : 'Pedido enviado: o Órbita lê no AVA todas as provas já aplicadas. Pode levar alguns minutos.' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// liga a prova a um questionário do AVA à mão (DP/adaptação, ou quando a busca automática não acha): cmid do questionário
router.put('/provas/:id/ava', exigeImpressao, async (req, res) => {
    try {
        const cmid = String(req.body.cmid || '').match(/(?:id=)?(\d{3,})\s*$/);
        const ref = db.collection('med_aplicacao_provas').doc(req.params.id);
        if (!(await ref.get()).exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        await ref.update({ avaCmid: cmid ? Number(cmid[1]) : null, atualizadoEm: new Date().toISOString(), atualizadoPor: req.user.name || req.user.email || '' });
        res.json({ message: cmid ? `Prova ligada ao questionário ${cmid[1]} do AVA.` : 'Ligação com o AVA removida: volta a procurar sozinho.' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

module.exports = router;
