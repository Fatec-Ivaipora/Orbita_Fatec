// OSCE — Medicina (25/11/2026)
// Pedido do Suporte AVA, a partir da conversa com a equipe da OSCE: hoje são 6 estações; o professor fica fixo na
// estação do início ao fim e o aluno roda por todas; a nota ia em papel e agora numa planilha do Drive, somada à mão.
//
// Fluxo:
//   1. Estações: o professor monta (ou importa o Word no modelo da Fatec) — tema, objetivo do plano de ensino,
//      tempo, cenário, tarefas, checklist (item, quando vale parcial, peso), erros críticos, papel do avaliador,
//      materiais e gabarito. A conferência (medicina/osce/conferencia.js — a mesma da tela) mostra o que já tem e o
//      que pode melhorar, por quê e como. Quem decide é o professor; a validação final é da coordenação do curso.
//   2. OSCE: a coordenação escolhe a turma, a data (da Aplicação de Provas), o total (padrão 40) e as estações,
//      com o valor e o(s) avaliador(es) de cada uma.
//   3. No dia: o avaliador abre a SUA estação, escolhe o aluno e marca fez / parcial / não fez. A nota é calculada
//      pelos itens (nunca digitada). Erros críticos e impressão geral ficam registrados para a coordenação.
//   4. Resultado: aluno × estação + total, para baixar e lançar.
//
// Quem: ADM N1/N2, coordenação de Medicina (inclui a secretária acadêmica) e a responsável CADAM veem e editam tudo.
// Professor de Medicina: monta as próprias estações e avalia só nas estações em que está como avaliador.
// LGPD: alunos (nome e RA) vêm do Edubox na hora (relay /med-provas/alunos) — CPF nunca sai daqui.
const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const Conf = require('../../medicina/osce/conferencia.js');
const RevisaoPt = require('../../banco-med-fatec/revisao-pt.js');
const { relay } = require('../utils/edubox-relay');

const checkPermission = verifyToken.requireModulePermission('osce-med');
const COL_EST = 'med_osce_estacoes';
const COL_OSCE = 'med_osce_provas';
const COL_NOTA = 'med_osce_notas';
const SEMESTRE = /^\d{4}\.[12]$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

const podeEditar = (u) => ['adm_l1', 'adm_l2', 'coord_medicina'].includes(u.role) || u.avaliacoesMed === true;
const ehProfessorMed = (u) => u.role === 'professor_medicina' || u.professorMedicina === true;
router.use(verifyToken, (req, res, next) => (podeEditar(req.user) || ehProfessorMed(req.user) ? next() : checkPermission(req, res, next)));

const agora = () => new Date().toISOString();
const quem = (req) => req.user.name || req.user.email || 'Usuário';
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const txtLongo = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const lista = (v, n, max) => (Array.isArray(v) ? v : []).map(x => txt(x, n)).filter(Boolean).slice(0, max);
const semestreAtual = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };
const falha = (status, msg) => Object.assign(new Error(msg), { status });
const erro = (res, e) => { if (!e.status) console.error('[osce-med]', e); res.status(e.status || 500).json({ error: e.message }); };

// ---------- estações ----------
function estacaoDoBody(b) {
    const itens = (Array.isArray(b.itens) ? b.itens : []).slice(0, 40).map(it => ({
        texto: txt(it && it.texto, 400), parcial: txt(it && it.parcial, 300), semParcial: !!(it && it.semParcial),
        peso: Math.max(0.5, Math.min(10, Number(it && it.peso) || 1))
    })).filter(it => it.texto);
    const e = {
        semestre: SEMESTRE.test(b.semestre || '') ? b.semestre : semestreAtual(),
        disciplina: txt(b.disciplina, 160), tema: txt(b.tema, 160), objetivo: txt(b.objetivo, 600),
        tempoMin: Math.max(0, Math.min(60, parseInt(b.tempoMin, 10) || 0)),
        cenario: txtLongo(b.cenario, 3000), tarefas: lista(b.tarefas, 400, 20), itens,
        criticos: lista(b.criticos, 300, 10), escalaGlobal: b.escalaGlobal !== false,
        papelAvaliador: txtLongo(b.papelAvaliador, 1500), materiais: lista(b.materiais, 200, 40), gabarito: txtLongo(b.gabarito, 5000)
    };
    if (!e.tema) throw falha(400, 'Informe o tema da estação.');
    if (!e.disciplina) throw falha(400, 'Escolha a disciplina.');
    return e;
}
const resumoConf = (e) => { const c = Conf.conferir(e, RevisaoPt); return { importantes: c.importantes, sugestoes: c.sugestoes.length, portugues: c.portugues.length }; };

// ---------- alunos da turma (Edubox, na hora; só nome e RA) ----------
const SAIU = /^(cancel|tranc|desist|transf|evad|abandon)/i;
const cacheAlunos = new Map();
async function alunosDaTurma(semestre, turmaId) {
    const k = `${semestre}|${turmaId}`;
    const c = cacheAlunos.get(k);
    if (c && Date.now() - c.em < 10 * 60000) return c.lista;
    const conf = await db.collection('med_aplicacao_config').doc(semestre).get();
    const turmas = (conf.exists && conf.data().turmas) || [{ id: 'T1', periodo: 5 }, { id: 'T2', periodo: 4 }, { id: 'T3', periodo: 2 }];
    const t = turmas.find(x => x.id === turmaId);
    if (!t) throw falha(400, 'Turma não encontrada na Aplicação de Provas.');
    let r;
    try { r = await relay(`/med-provas/alunos?semestre=${encodeURIComponent(semestre.replace('.', '-'))}`, { timeoutMs: 30000 }); }
    catch (e) { throw falha(502, `O Edubox não respondeu (${e.message}). Tente de novo em instantes.`); }
    if (!r || !r.ok) throw falha(502, 'O Edubox não respondeu. Tente de novo em instantes.');
    const vistos = new Set();
    const lista2 = (r.alunos || [])
        .filter(a => Number(a.periodo) === Number(t.periodo) && !SAIU.test(a.situacao || '') && a.ra && !/^\s*DP\b/i.test(a.turma || ''))
        .filter(a => { if (vistos.has(a.ra)) return false; vistos.add(a.ra); return true; })
        .map(a => ({ nome: txt(a.nome, 160).toUpperCase(), ra: txt(a.ra, 20) }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    cacheAlunos.set(k, { em: Date.now(), lista: lista2 });
    return lista2;
}

// ---------- leitura ----------
router.get('/', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '2026.2';
        const editor = podeEditar(req.user);
        const [snapE, snapO, snapP] = await Promise.all([
            db.collection(COL_EST).where('semestre', '==', semestre).get(),
            db.collection(COL_OSCE).where('semestre', '==', semestre).get(),
            db.collection('med_aplicacao_provas').where('semestre', '==', semestre).get()
        ]);
        const osces = snapO.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(o => editor || (o.estacoes || []).some(x => (x.avaliadores || []).some(a => a.uid === req.user.uid)))
            .sort((a, b) => String(a.data).localeCompare(String(b.data)));
        const usadas = new Set(osces.flatMap(o => (o.estacoes || []).map(x => x.estacaoId)));
        const estacoes = snapE.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(e => editor || e.autorUid === req.user.uid || usadas.has(e.id))
            .map(e => ({ ...e, conf: resumoConf(e) }))
            .sort((a, b) => a.disciplina.localeCompare(b.disciplina) || a.tema.localeCompare(b.tema));
        const provasOsce = snapP.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.tipo === 'osce')
            .map(p => ({ id: p.id, data: p.data, turma: p.turma, etapa: p.etapa, horario: p.horario, disciplina: p.disciplina }))
            .sort((a, b) => a.data.localeCompare(b.data));
        res.json({ semestre, editor, eu: { uid: req.user.uid, nome: quem(req) }, estacoes, osces, provasOsce });
    } catch (e) { erro(res, e); }
});

// disciplinas da Medicina e objetivos do plano de ensino (Edubox) — reaproveita o Banco MED
router.get('/disciplinas', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '2026.2';
        const { listaDisciplinas } = require('./banco-med-avaliacoes')._interno;
        const { disciplinas } = await listaDisciplinas(semestre);
        res.json(disciplinas.map(d => ({ nome: d.nome, periodo: d.periodo })).sort((a, b) => (a.periodo || 0) - (b.periodo || 0) || a.nome.localeCompare(b.nome)));
    } catch (e) { erro(res, e); }
});
router.get('/plano', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '2026.2';
        const { planoDaDisciplina } = require('./banco-med-avaliacoes')._interno;
        const p = await planoDaDisciplina(semestre, String(req.query.disciplina || ''));
        res.json({ encontrado: p.encontrado, objetivos: p.objetivos || [], unidades: (p.unidades || []).map(u => u.titulo), semestreFonte: p.semestreFonte });
    } catch (e) { erro(res, e); }
});

router.get('/professores', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação define os avaliadores.');
        const [a, b] = await Promise.all([
            db.collection('users').where('role', 'in', ['professor_medicina', 'coord_medicina']).get(),
            db.collection('users').where('professorMedicina', '==', true).get()
        ]);
        const mapa = new Map();
        [...a.docs, ...b.docs].forEach(d => { const u = d.data(); if (u.ativo !== false) mapa.set(d.id, { uid: d.id, nome: u.name || u.nome || u.email || d.id }); });
        res.json([...mapa.values()].sort((x, y) => x.nome.localeCompare(y.nome)));
    } catch (e) { erro(res, e); }
});

// ---------- estações: criar / editar / apagar ----------
router.post('/estacoes', async (req, res) => {
    try {
        const e = estacaoDoBody(req.body || {});
        const ref = db.collection(COL_EST).doc();
        await ref.set({ ...e, autorUid: req.user.uid, autorNome: quem(req), criadoEm: agora(), atualizadoEm: agora(), atualizadoPor: quem(req) });
        res.status(201).json({ id: ref.id, message: 'Estação salva.' });
    } catch (e) { erro(res, e); }
});
router.put('/estacoes/:id', async (req, res) => {
    try {
        const ref = db.collection(COL_EST).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) throw falha(404, 'Estação não encontrada.');
        if (!podeEditar(req.user) && s.data().autorUid !== req.user.uid) throw falha(403, 'Só quem montou a estação (ou a coordenação) altera.');
        const e = estacaoDoBody(req.body || {});
        // mudar o checklist depois de já ter nota muda a conta — avisa (não bloqueia a coordenação)
        const notas = await db.collection(COL_NOTA).where('estacaoId', '==', req.params.id).limit(1).get();
        if (!notas.empty && (s.data().itens || []).length !== e.itens.length && !podeEditar(req.user)) throw falha(409, 'Esta estação já tem notas lançadas: o número de itens não pode mudar. Fale com a coordenação.');
        await ref.update({ ...e, atualizadoEm: agora(), atualizadoPor: quem(req) });
        res.json({ message: 'Estação salva.' });
    } catch (e) { erro(res, e); }
});
router.delete('/estacoes/:id', async (req, res) => {
    try {
        const ref = db.collection(COL_EST).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) throw falha(404, 'Estação não encontrada.');
        if (!podeEditar(req.user) && s.data().autorUid !== req.user.uid) throw falha(403, 'Só quem montou a estação (ou a coordenação) apaga.');
        const usos = await db.collection(COL_OSCE).where('estacaoIds', 'array-contains', req.params.id).limit(1).get();
        if (!usos.empty) throw falha(409, 'A estação está numa OSCE. Tire da OSCE antes de apagar.');
        await ref.delete();
        res.json({ message: 'Estação apagada.' });
    } catch (e) { erro(res, e); }
});

// ---------- OSCE (coordenação) ----------
function osceDoBody(b) {
    const estacoes = (Array.isArray(b.estacoes) ? b.estacoes : []).slice(0, 15).map((x, i) => ({
        estacaoId: txt(x && x.estacaoId, 60), ordem: i + 1, valor: Math.max(0, Math.min(100, Number(x && x.valor) || 0)),
        avaliadores: (Array.isArray(x && x.avaliadores) ? x.avaliadores : []).slice(0, 4).map(a => ({ uid: txt(a && a.uid, 80), nome: txt(a && a.nome, 120) })).filter(a => a.uid)
    })).filter(x => x.estacaoId);
    const o = {
        semestre: SEMESTRE.test(b.semestre || '') ? b.semestre : semestreAtual(),
        nome: txt(b.nome, 160), turma: txt(b.turma, 10).toUpperCase(), data: DATA.test(b.data || '') ? b.data : '',
        provaId: txt(b.provaId, 60), total: Math.max(1, Math.min(100, Number(b.total) || 40)), estacoes, estacaoIds: estacoes.map(x => x.estacaoId)
    };
    if (!o.turma) throw falha(400, 'Escolha a turma.');
    if (!o.nome) throw falha(400, 'Dê um nome para a OSCE (ex.: OSCE Clínica Cirúrgica · T1).');
    return o;
}
router.post('/osces', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação monta a OSCE.');
        const o = osceDoBody(req.body || {});
        const ref = db.collection(COL_OSCE).doc();
        await ref.set({ ...o, criadoEm: agora(), criadoPor: quem(req), atualizadoEm: agora() });
        res.status(201).json({ id: ref.id, message: 'OSCE salva.' });
    } catch (e) { erro(res, e); }
});
router.put('/osces/:id', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação monta a OSCE.');
        const ref = db.collection(COL_OSCE).doc(req.params.id);
        if (!(await ref.get()).exists) throw falha(404, 'OSCE não encontrada.');
        await ref.update({ ...osceDoBody(req.body || {}), atualizadoEm: agora(), atualizadoPor: quem(req) });
        res.json({ message: 'OSCE salva.' });
    } catch (e) { erro(res, e); }
});
router.delete('/osces/:id', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação apaga a OSCE.');
        const notas = await db.collection(COL_NOTA).where('osceId', '==', req.params.id).limit(1).get();
        if (!notas.empty) throw falha(409, 'Esta OSCE já tem notas lançadas e não pode ser apagada.');
        await db.collection(COL_OSCE).doc(req.params.id).delete();
        res.json({ message: 'OSCE apagada.' });
    } catch (e) { erro(res, e); }
});

// OSCE aberta: estações (completas), alunos da turma e notas (o avaliador só as das estações dele)
async function lerOsce(req) {
    const s = await db.collection(COL_OSCE).doc(req.params.id).get();
    if (!s.exists) throw falha(404, 'OSCE não encontrada.');
    const o = { id: s.id, ...s.data() };
    const editor = podeEditar(req.user);
    const minhas = new Set((o.estacoes || []).filter(x => (x.avaliadores || []).some(a => a.uid === req.user.uid)).map(x => x.estacaoId));
    if (!editor && !minhas.size) throw falha(403, 'Você não está como avaliador nesta OSCE.');
    return { o, editor, minhas };
}
router.get('/osces/:id', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { o, editor, minhas } = await lerOsce(req);
        const ids = (o.estacoes || []).map(x => x.estacaoId);
        const snaps = await Promise.all(ids.map(id => db.collection(COL_EST).doc(id).get()));
        const estacoes = snaps.filter(x => x.exists).map(x => ({ id: x.id, ...x.data() }));
        const [alunos, snapN] = await Promise.all([
            alunosDaTurma(o.semestre, o.turma).catch(e => { throw e; }),
            db.collection(COL_NOTA).where('osceId', '==', o.id).get()
        ]);
        const notas = snapN.docs.map(d => ({ id: d.id, ...d.data() })).filter(n => editor || minhas.has(n.estacaoId));
        res.json({ osce: o, editor, minhas: [...minhas], estacoes, alunos, notas });
    } catch (e) { erro(res, e); }
});

// lançar a avaliação de UM aluno numa estação: marcas por item (1 / 0,5 / 0), erros críticos, impressão geral
router.put('/osces/:id/notas', async (req, res) => {
    try {
        const { o, editor, minhas } = await lerOsce(req);
        const b = req.body || {};
        const estacaoId = txt(b.estacaoId, 60), ra = txt(b.ra, 20);
        const cfg = (o.estacoes || []).find(x => x.estacaoId === estacaoId);
        if (!cfg) throw falha(400, 'Estação fora desta OSCE.');
        if (!editor && !minhas.has(estacaoId)) throw falha(403, 'Você não avalia esta estação.');
        const alunos = await alunosDaTurma(o.semestre, o.turma);
        const aluno = alunos.find(a => a.ra === ra);
        if (!aluno) throw falha(400, 'Aluno fora da turma desta OSCE.');
        const est = await db.collection(COL_EST).doc(estacaoId).get();
        if (!est.exists) throw falha(404, 'Estação não encontrada.');
        const e = est.data();
        const ausente = b.ausente === true;
        const marcas = (e.itens || []).map((it, i) => { const m = (b.marcas || [])[i]; return m === 1 || m === 0.5 || m === 0 ? (m === 0.5 && !Conf.temParcial(it) ? null : m) : null; });
        const calc = Conf.calcular(e, ausente ? [] : marcas, cfg.valor);
        const nota = {
            osceId: o.id, estacaoId, ra, nome: aluno.nome, ausente,
            marcas: ausente ? [] : marcas,
            criticos: ausente ? [] : (e.criticos || []).map((_, i) => !!(b.criticos || [])[i]),
            global: ausente ? null : ([1, 2, 3, 4, 5].includes(Number(b.global)) ? Number(b.global) : null),
            comentario: txt(b.comentario, 600),
            pontos: ausente ? 0 : calc.pontos, completo: ausente || calc.completo,
            avaliadorUid: req.user.uid, avaliadorNome: quem(req), em: agora()
        };
        await db.collection(COL_NOTA).doc(`${o.id}__${estacaoId}__${ra}`).set(nota);
        res.json({ message: ausente ? 'Marcado como ausente.' : `Salvo: ${Conf.fmt(nota.pontos)} de ${Conf.fmt(cfg.valor)} pontos.`, nota: { id: `${o.id}__${estacaoId}__${ra}`, ...nota } });
    } catch (e) { erro(res, e); }
});

// conferência no servidor (a tela faz a mesma, ao vivo) — útil para quem só quer o parecer
router.post('/conferir', async (req, res) => {
    try { res.json(Conf.conferir(req.body || {}, RevisaoPt)); } catch (e) { erro(res, e); }
});

router._interno = { estacaoDoBody, osceDoBody, alunosDaTurma };
module.exports = router;
