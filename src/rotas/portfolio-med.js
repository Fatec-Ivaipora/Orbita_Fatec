// Portfólio Reflexivo — Medicina / SCIC (23/11/2026)
// Correção dos portfólios que os alunos entregam na Tarefa do AVA, com a MESMA matriz para todos os professores.
//
// Fluxo (MVP, sem integração direta com o AVA e sem IA):
//   1. Coordenação configura cada turma do semestre: objetivos (Critério 3), questão norteadora, instruções e
//      quais professores corrigem. Ponto de partida de 2026.2 vem dos documentos da coordenação
//      (src/utils/portfolio-med-padrao.js).
//   2. Professor (ou coordenação) cria a atividade ("Portfólio 1") e sobe o ZIP de "Baixar todas as submissões"
//      da Tarefa do AVA. O ZIP é aberto NO NAVEGADOR (o PDF não vem pro servidor); só o texto extraído de cada
//      portfólio é gravado — serve pra similaridade e pra consulta.
//   3. Professor corrige: marca os níveis/elementos/objetivos + evidência de cada critério. A nota é CALCULADA
//      pela matriz (medicina/portfolio/matriz.js — fonte única, a mesma da tela), nunca digitada.
//   4. Similaridade entre os portfólios da atividade (src/utils/portfolio-similaridade.js) — só sinaliza.
//   5. Saída: quadro-resumo e a planilha de avaliação do AVA preenchida (feita na tela).
//
// Quem: edita turmas e vê tudo → ADM N1/N2, coordenação de Medicina e a responsável pelas avaliações (CADAM).
// Professor de Medicina → só as turmas em que está como professor corretor.
// LGPD: o texto do portfólio é dado do aluno (e pode citar pacientes) — fica só no Firestore institucional,
// nunca vai pra serviço externo nesta versão.
const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const Matriz = require('../../medicina/portfolio/matriz.js');
const { turmasPadrao } = require('../utils/portfolio-med-padrao');
const { analisar } = require('../utils/portfolio-similaridade');

const checkPermission = verifyToken.requireModulePermission('portfolio-med');
const COL_TURMAS = 'med_portfolio_turmas';
const COL_ATIV = 'med_portfolio_atividades';
const COL_ENT = 'med_portfolio_entregas';
const COL_TXT = 'med_portfolio_textos';
const SEMESTRE = /^\d{4}\.[12]$/;
const TURMA = /^T\d{1,2}$/;
const MAX_TEXTO = 400000;

const podeEditar = (u) => ['adm_l1', 'adm_l2', 'coord_medicina'].includes(u.role) || u.avaliacoesMed === true;
const ehProfessorMed = (u) => u.role === 'professor_medicina' || u.professorMedicina === true;
router.use(verifyToken, (req, res, next) => ((podeEditar(req.user) || ehProfessorMed(req.user)) ? next() : checkPermission(req, res, next)));

const agora = () => new Date().toISOString();
const quem = (req) => req.user.name || req.user.email || 'Usuário';
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const txtLongo = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const lista = (v, n, max) => (Array.isArray(v) ? v : []).map(x => txt(x, n)).filter(Boolean).slice(0, max);
const semestreAtual = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };
const erro = (res, e) => { if (!e.status) console.error('[portfolio-med]', e); res.status(e.status || 500).json({ error: e.message }); };
const falha = (status, msg) => Object.assign(new Error(msg), { status });
const idTurma = (semestre, turma) => `${semestre}__${turma}`;

// ---------- turmas ----------
async function turmasDoSemestre(semestre) {
    const snap = await db.collection(COL_TURMAS).where('semestre', '==', semestre).get();
    const salvas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // o padrão do semestre aparece até a coordenação salvar (aí vale o salvo)
    turmasPadrao(semestre).forEach(p => {
        if (!salvas.some(s => s.turma === p.turma)) salvas.push({ id: idTurma(semestre, p.turma), ...p, padrao: true });
    });
    return salvas.sort((a, b) => (a.periodo || 0) - (b.periodo || 0));
}
async function lerTurma(turmaId) {
    const s = await db.collection(COL_TURMAS).doc(turmaId).get();
    if (s.exists) return { id: s.id, ...s.data() };
    const [semestre, turma] = String(turmaId).split('__');
    const p = turmasPadrao(semestre).find(t => t.turma === turma);
    if (!p) throw falha(404, 'Turma não encontrada.');
    return { id: turmaId, ...p, padrao: true };
}
const acessoTurma = (user, t) => podeEditar(user) || (t.professores || []).some(p => p.uid === user.uid);
function exigeTurma(user, t) { if (!acessoTurma(user, t)) throw falha(403, 'Você não está como professor corretor desta turma.'); }

function turmaDoBody(b, semestre, turma) {
    const t = {
        semestre, turma,
        periodo: Math.max(1, Math.min(12, parseInt(b.periodo, 10) || 0)) || null,
        componente: txt(b.componente, 200),
        tema: txt(b.tema, 300),
        cenarios: txt(b.cenarios, 600),
        objetivoGeral: txt(b.objetivoGeral, 1500),
        questaoNorteadora: txt(b.questaoNorteadora, 500),
        objetivos: lista(b.objetivos, 600, 30),
        instrucoes: lista(b.instrucoes, 3000, 15),
        professores: (Array.isArray(b.professores) ? b.professores : [])
            .filter(p => p && typeof p.uid === 'string' && p.uid)
            .slice(0, 40).map(p => ({ uid: txt(p.uid, 128), nome: txt(p.nome, 120) }))
    };
    if (!t.objetivos.length) throw falha(400, 'Cadastre os objetivos específicos da turma (eles são o Critério 3).');
    return t;
}

router.get('/semestres', async (req, res) => {
    try {
        const snap = await db.collection(COL_TURMAS).select('semestre').get();
        const s = new Set(snap.docs.map(d => d.data().semestre).filter(Boolean));
        s.add('2026.2'); s.add(semestreAtual());
        res.json([...s].sort().reverse());
    } catch (e) { erro(res, e); }
});

router.get('/', async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '2026.2';
        const editor = podeEditar(req.user);
        const [turmas, snapAt] = await Promise.all([
            turmasDoSemestre(semestre),
            db.collection(COL_ATIV).where('semestre', '==', semestre).get()
        ]);
        const visiveis = turmas.filter(t => acessoTurma(req.user, t));
        const ids = new Set(visiveis.map(t => t.id));
        const atividades = snapAt.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => ids.has(a.turmaId))
            .sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)));
        res.json({ semestre, editor, eu: { uid: req.user.uid, nome: quem(req) }, turmas: visiveis, atividades, matrizVersao: Matriz.VERSAO });
    } catch (e) { erro(res, e); }
});

// professores que podem ser corretores (cargo de Medicina ou marca de professor de Medicina)
router.get('/professores', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação define os professores corretores.');
        const [a, b] = await Promise.all([
            db.collection('users').where('role', 'in', ['professor_medicina', 'coord_medicina']).get(),
            db.collection('users').where('professorMedicina', '==', true).get()
        ]);
        const mapa = new Map();
        [...a.docs, ...b.docs].forEach(d => {
            const u = d.data();
            if (u.ativo === false) return;
            mapa.set(d.id, { uid: d.id, nome: u.name || u.nome || u.email || d.id });
        });
        res.json([...mapa.values()].sort((x, y) => x.nome.localeCompare(y.nome)));
    } catch (e) { erro(res, e); }
});

router.put('/turmas/:semestre/:turma', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação configura as turmas.');
        const { semestre, turma } = req.params;
        if (!SEMESTRE.test(semestre) || !TURMA.test(turma)) throw falha(400, 'Semestre ou turma inválidos.');
        const t = turmaDoBody(req.body || {}, semestre, turma);
        await db.collection(COL_TURMAS).doc(idTurma(semestre, turma)).set({ ...t, atualizadoEm: agora(), atualizadoPor: quem(req) });
        res.json({ id: idTurma(semestre, turma), ...t });
    } catch (e) { erro(res, e); }
});

// copia a configuração das turmas de outro semestre (sem professores e sem atividades)
router.post('/turmas/:semestre/copiar', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação configura as turmas.');
        const { semestre } = req.params;
        const de = String((req.body || {}).de || '');
        if (!SEMESTRE.test(semestre) || !SEMESTRE.test(de) || de === semestre) throw falha(400, 'Semestre inválido.');
        const [origem, destino] = await Promise.all([turmasDoSemestre(de), turmasDoSemestre(semestre)]);
        let n = 0;
        const batch = db.batch();
        origem.forEach(t => {
            if (destino.some(d => d.turma === t.turma && !d.padrao)) return;
            const { id, padrao, atualizadoEm, atualizadoPor, ...resto } = t;
            batch.set(db.collection(COL_TURMAS).doc(idTurma(semestre, t.turma)), { ...resto, semestre, professores: [], atualizadoEm: agora(), atualizadoPor: quem(req) });
            n++;
        });
        await batch.commit();
        res.json({ copiadas: n });
    } catch (e) { erro(res, e); }
});

// ---------- atividades ----------
router.post('/atividades', async (req, res) => {
    try {
        const b = req.body || {};
        const turma = await lerTurma(txt(b.turmaId, 40));
        exigeTurma(req.user, turma);
        const titulo = txt(b.titulo, 120);
        if (!titulo) throw falha(400, 'Dê um nome à atividade (ex.: Portfólio 1).');
        const doc = {
            semestre: turma.semestre, turmaId: turma.id, turma: turma.turma, titulo,
            prazo: /^\d{4}-\d{2}-\d{2}$/.test(b.prazo || '') ? b.prazo : '',
            criadoEm: agora(), criadoPor: quem(req), criadoPorUid: req.user.uid
        };
        const ref = await db.collection(COL_ATIV).add(doc);
        res.json({ id: ref.id, ...doc });
    } catch (e) { erro(res, e); }
});

async function lerAtividade(req, id) {
    const s = await db.collection(COL_ATIV).doc(String(id)).get();
    if (!s.exists) throw falha(404, 'Atividade não encontrada.');
    const atividade = { id: s.id, ...s.data() };
    const turma = await lerTurma(atividade.turmaId);
    exigeTurma(req.user, turma);
    return { atividade, turma };
}

router.delete('/atividades/:id', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação exclui atividades.');
        const { atividade } = await lerAtividade(req, req.params.id);
        const ents = await db.collection(COL_ENT).where('atividadeId', '==', atividade.id).get();
        const refs = [db.collection(COL_ATIV).doc(atividade.id)];
        ents.docs.forEach(d => { refs.push(d.ref); refs.push(db.collection(COL_TXT).doc(d.id)); });
        for (let i = 0; i < refs.length; i += 400) {
            const batch = db.batch();
            refs.slice(i, i + 400).forEach(r => batch.delete(r));
            await batch.commit();
        }
        res.json({ ok: true, excluidas: ents.size });
    } catch (e) { erro(res, e); }
});

router.get('/atividades/:id', async (req, res) => {
    try {
        const { atividade, turma } = await lerAtividade(req, req.params.id);
        const snap = await db.collection(COL_ENT).where('atividadeId', '==', atividade.id).get();
        const entregas = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.nome.localeCompare(b.nome));
        res.json({ atividade, turma, entregas, editor: podeEditar(req.user) });
    } catch (e) { erro(res, e); }
});

// uma entrega por chamada (o texto de um portfólio pode ter centenas de KB)
router.post('/atividades/:id/entregas', async (req, res) => {
    try {
        const { atividade } = await lerAtividade(req, req.params.id);
        const b = req.body || {};
        const participante = txt(b.participante, 20);
        if (!/^\d+$/.test(participante)) throw falha(400, 'Arquivo sem o número do participante do AVA — use o ZIP de "Baixar todas as submissões".');
        const id = `${atividade.id}__${participante}`;
        const texto = txtLongo(b.texto, MAX_TEXTO);
        const ref = db.collection(COL_ENT).doc(id);
        const atual = await ref.get();
        const meta = {
            atividadeId: atividade.id, turmaId: atividade.turmaId, semestre: atividade.semestre,
            participante, nome: txt(b.nome, 160) || `Participante ${participante}`,
            arquivos: lista(b.arquivos, 255, 20),
            paginas: Math.max(0, parseInt(b.paginas, 10) || 0),
            palavras: Math.max(0, parseInt(b.palavras, 10) || 0),
            semTexto: texto.split(/\s+/).filter(Boolean).length < 50,
            naoPdf: lista(b.naoPdf, 255, 20),
            importadoEm: agora(), importadoPor: quem(req)
        };
        if (atual.exists) {
            const a = atual.data();
            meta.reimportado = true;
            // reenvio depois de finalizada: avisa o professor (a correção não é apagada)
            if (a.status === 'finalizada' && (a.palavras || 0) !== meta.palavras) meta.alteradoAposCorrecao = true;
            await ref.set(meta, { merge: true });
        } else {
            await ref.set({ ...meta, status: 'pendente', avaliacao: null, resultado: null });
        }
        await db.collection(COL_TXT).doc(id).set({ texto, atividadeId: atividade.id });
        res.json({ id, novo: !atual.exists });
    } catch (e) { erro(res, e); }
});

async function lerEntrega(req, id) {
    const s = await db.collection(COL_ENT).doc(String(id)).get();
    if (!s.exists) throw falha(404, 'Entrega não encontrada.');
    const entrega = { id: s.id, ...s.data() };
    const turma = await lerTurma(entrega.turmaId);
    exigeTurma(req.user, turma);
    return { entrega, turma };
}

router.get('/entregas/:id/texto', async (req, res) => {
    try {
        await lerEntrega(req, req.params.id);
        const s = await db.collection(COL_TXT).doc(String(req.params.id)).get();
        res.json({ texto: s.exists ? s.data().texto || '' : '' });
    } catch (e) { erro(res, e); }
});

function avaliacaoDoBody(b, totalObj) {
    const nivel = (v) => (Matriz.NIVEIS.includes(v) ? v : null);
    const just = (c) => txtLongo(c && c.justificativa, 3000);
    const c2 = b.c2 || {};
    const c3 = b.c3 || {};
    return {
        c1: { nivel: nivel(b.c1 && b.c1.nivel), justificativa: just(b.c1) },
        c2: {
            analise: ['consistente', 'superficial', 'ausente'].includes(c2.analise) ? c2.analise : null,
            necessidades: c2.necessidades === true, acoes: c2.acoes === true,
            nivelManual: nivel(c2.nivelManual), justificativa: just(c2)
        },
        c3: { objetivos: Array.from({ length: totalObj }, (_, i) => !!(Array.isArray(c3.objetivos) && c3.objetivos[i] === true)), justificativa: just(c3) },
        c4: { nivel: nivel(b.c4 && b.c4.nivel), justificativa: just(b.c4) },
        feedback: {
            fortes: txtLongo(b.feedback && b.feedback.fortes, 2000),
            desenvolver: txtLongo(b.feedback && b.feedback.desenvolver, 2000),
            recomendacao: txtLongo(b.feedback && b.feedback.recomendacao, 2000)
        },
        conformidade: {
            capa: ['completa', 'incompleta', 'ausente'].includes(b.conformidade && b.conformidade.capa) ? b.conformidade.capa : '',
            capaFaltando: lista(b.conformidade && b.conformidade.capaFaltando, 60, 6).filter(x => Matriz.ITENS_CAPA.includes(x)),
            formatacao: txtLongo(b.conformidade && b.conformidade.formatacao, 800),
            foraAva: !!(b.conformidade && b.conformidade.foraAva),
            obs: txtLongo(b.conformidade && b.conformidade.obs, 1500)
        },
        penalidade: Matriz.PENALIDADES[b.penalidade] ? b.penalidade : 'nenhuma'
    };
}

router.put('/entregas/:id/avaliacao', async (req, res) => {
    try {
        const { entrega, turma } = await lerEntrega(req, req.params.id);
        const b = req.body || {};
        const totalObj = (turma.objetivos || []).length;
        const av = avaliacaoDoBody(b.avaliacao || {}, totalObj);
        const r = Matriz.calcular(av, totalObj);
        const finalizar = b.finalizar === true;
        if (finalizar) {
            const falta = [...r.faltando];
            const fb = av.feedback;
            if (!fb.fortes || !fb.desenvolver || !fb.recomendacao) falta.push('Feedback ao estudante: preencha pontos fortes, a desenvolver e recomendação');
            if (r.criterios.c2.manual && !r.criterios.c2.nivel) falta.push('Critério 2: escolha o nível (combinação não prevista na matriz)');
            if (falta.length) return res.status(400).json({ error: 'Faltam itens para finalizar.', faltando: falta });
        }
        const status = finalizar ? 'finalizada' : 'rascunho';
        const evento = { em: agora(), por: quem(req), acao: finalizar ? 'finalizou' : (entrega.status === 'finalizada' ? 'reabriu' : 'salvou'), nota: r.nota };
        await db.collection(COL_ENT).doc(entrega.id).update({
            avaliacao: av, resultado: r, status, matrizVersao: Matriz.VERSAO,
            corrigidoPor: quem(req), corrigidoPorUid: req.user.uid, corrigidoEm: agora(),
            alteradoAposCorrecao: false,
            historico: admin.firestore.FieldValue.arrayUnion(evento)
        });
        res.json({ id: entrega.id, status, resultado: r });
    } catch (e) { erro(res, e); }
});

router.get('/atividades/:id/similaridade', async (req, res) => {
    try {
        const { atividade } = await lerAtividade(req, req.params.id);
        const [ents, txts] = await Promise.all([
            db.collection(COL_ENT).where('atividadeId', '==', atividade.id).get(),
            db.collection(COL_TXT).where('atividadeId', '==', atividade.id).get()
        ]);
        const nomes = new Map(ents.docs.map(d => [d.id, d.data().nome]));
        const docs = txts.docs.filter(d => nomes.has(d.id)).map(d => ({ id: d.id, nome: nomes.get(d.id), texto: d.data().texto || '' }));
        res.json({ total: ents.size, ...analisar(docs) });
    } catch (e) { erro(res, e); }
});

module.exports = router;
