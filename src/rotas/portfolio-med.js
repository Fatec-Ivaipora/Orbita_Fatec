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
// NOTA DE REFERÊNCIA (26/11/2026): a mesma regra fixa da sugestão da tela (medicina/portfolio/sugestao.js) calculada
// AQUI, no servidor, a partir do texto do portfólio — o mesmo trabalho tem sempre a mesma referência, seja quem for
// o professor. É a "nota de corte" comum: a nota do professor que se afasta 2 pontos ou mais fica marcada para a
// coordenação, e a "Análise da nota" (recurso do aluno) mostra critério a critério referência × professor.
const Sugestao = require('../../medicina/portfolio/sugestao.js');
const DIVERGENCIA = 2;
function referenciaDe(texto, turma) {
    const objs = turma.objetivos || [];
    const s = Sugestao.sugerir(texto || '', objs);
    const r = Matriz.calcular({ c1: s.c1, c2: s.c2, c3: s.c3, c4: s.c4 }, objs.length);
    const niv = (id) => r.criterios[id].nivel || null;
    return {
        nota: r.soma, versao: Sugestao.VERSAO, matrizVersao: Matriz.VERSAO, em: new Date().toISOString(), semTexto: !!s.semTexto,
        niveis: { c1: niv('c1'), c2: niv('c2'), c3: niv('c3'), c4: niv('c4') },
        pts: { c1: r.criterios.c1.pts, c2: r.criterios.c2.pts, c3: r.criterios.c3.pts, c4: r.criterios.c4.pts },
        c2: { analise: s.c2.analise, necessidades: s.c2.necessidades, acoes: s.c2.acoes }, c3: { objetivos: s.c3.objetivos },
        evidencias: { c1: s.c1.justificativa, c2: s.c2.justificativa, c3: s.c3.justificativa, c4: s.c4.justificativa }
    };
}
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

// 27/11/2026: quem recebe nível 3 no Portfólio pela Gerência de Acessos (users.permissoes['portfolio-med'] = 3) também vê e
// edita como a coordenação — ex.: prof. João Felipe (cargo professor_medicina), além da Joyce e da prof. Ana Beatriz.
const podeEditar = (u) => ['adm_l1', 'adm_l2', 'coord_medicina'].includes(u.role) || u.avaliacoesMed === true
    || Number((u.permissoes || {})['portfolio-med']) >= 3;
const ehProfessorMed = (u) => u.role === 'professor_medicina' || u.professorMedicina === true;
// 23/11/2026 (pedido do Suporte AVA): por enquanto SÓ a coordenação usa (ADM N1/N2, coord_medicina — inclui a
// secretária acadêmica — e a responsável CADAM). Professor fica barrado aqui mesmo que alguém dê nível na Gerência
// de Acessos. Para liberar aos professores corretores: trocar para true e devolver "portfolio-med" ao
// professor_medicina em core/permissions.js e no padrão de src/middlewares/auth.js.
// 26/11/2026: continua FALSE (o usuário pediu para não liberar aos professores ainda). Já está pronto para quando
// liberar: a coordenação importa e DISTRIBUI os portfólios, e cada professor corretor vê e corrige só os que foram
// distribuídos para ele (entrega.corretorUid), com a nota de corte do Órbita como ponto de partida.
const PROFESSOR_LIBERADO = false;
const minhaEntrega = (user, e) => podeEditar(user) || (!!e.corretorUid && e.corretorUid === user.uid);
router.use(verifyToken, (req, res, next) => {
    if (podeEditar(req.user)) return next();
    if (!PROFESSOR_LIBERADO) return res.status(403).json({ error: 'O Portfólio Reflexivo ainda está liberado só para a coordenação de Medicina.' });
    return ehProfessorMed(req.user) ? next() : checkPermission(req, res, next);
});

const agora = () => new Date().toISOString();
const quem = (req) => req.user.name || req.user.email || 'Usuário';
const txt = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const txtLongo = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const lista = (v, n, max) => (Array.isArray(v) ? v : []).map(x => txt(x, n)).filter(Boolean).slice(0, max);
const semestreAtual = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };
const erro = (res, e) => { if (!e.status) console.error('[portfolio-med]', e); res.status(e.status || 500).json({ error: e.message, ...(e.faltando ? { faltando: e.faltando } : {}) }); };
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
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação cria atividades.');
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
        const entregas = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => minhaEntrega(req.user, e)).sort((a, b) => a.nome.localeCompare(b.nome));
        // nota de corte LIDA PELO CLAUDE (referencia.origem = 'claude', gravada por script com autorização da coordenação,
        // 26/11/2026) nunca é recalculada pela regra; só a da regra fixa é atualizada quando a regra muda de versão
        const semRef = entregas.filter(e => !e.referencia || (e.referencia.origem !== 'claude' && e.referencia.versao !== Sugestao.VERSAO));
        for (const e of semRef) {
            const t = await db.collection(COL_TXT).doc(e.id).get();
            e.referencia = referenciaDe(t.exists ? t.data().texto : '', turma);
            await db.collection(COL_ENT).doc(e.id).update({ referencia: e.referencia });
        }
        const totalObj = (turma.objetivos || []).length;
        entregas.forEach(e => { e.referencia = referenciaCobrada(e.referencia, totalObj, atividade.matrizCobrar); });
        res.json({ atividade, turma, entregas, editor: podeEditar(req.user), divergencia: DIVERGENCIA });
    } catch (e) { erro(res, e); }
});

// uma entrega por chamada (o texto de um portfólio pode ter centenas de KB)
router.post('/atividades/:id/entregas', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação importa os portfólios.');
        const { atividade, turma: turmaDaAtividade } = await lerAtividade(req, req.params.id);
        const b = req.body || {};
        const participante = txt(b.participante, 20);
        if (!/^u?\d+$/.test(participante)) throw falha(400, 'Arquivo sem o número do participante do AVA — use o ZIP de "Baixar todas as submissões".');
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
        meta.referencia = referenciaDe(texto, turmaDaAtividade);
        // veio do AVA pela integração (participante "u<id do aluno no AVA>"): guarda o aluno e os arquivos (o PDF abre pelo proxy)
        if (participante.startsWith('u')) {
            meta.avaUserId = parseInt(participante.slice(1), 10);
            meta.avaArquivos = (Array.isArray(b.avaArquivos) ? b.avaArquivos : []).slice(0, 20)
                .map(a => ({ nome: txt(a && a.nome, 255), caminho: String((a && a.caminho) || '').slice(0, 500) }))
                .filter(a => a.nome && /^\/webservice\/pluginfile\.php\//.test(a.caminho));
        }
        if (atual.exists) {
            const a = atual.data();
            meta.reimportado = true;
            // reimportar o mesmo texto não apaga a nota de corte lida pelo Claude; texto novo volta para a regra fixa
            if (a.referencia && a.referencia.origem === 'claude' && (a.palavras || 0) === meta.palavras) delete meta.referencia;
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
    if (!minhaEntrega(req.user, entrega)) throw falha(403, 'Este portfólio não foi distribuído para você.');
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
            recomendacao: txtLongo(b.feedback && b.feedback.recomendacao, 2000),
            // 27/11/2026: análise do professor/coordenação — obrigatória para finalizar com nota diferente da nota de corte
            analise: txtLongo(b.feedback && b.feedback.analise, 3000)
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
        res.json(await gravarCorrecao(entrega, turma, req.body || {}, { nome: quem(req), uid: req.user.uid, via: 'orbita' }));
    } catch (e) { erro(res, e); }
});
// Grava a correção (27/11/2026: virou função para o LINK DO PROFESSOR usar a mesma regra — src/rotas/portfolio-med-publico.js).
// autor = { nome, uid, via: 'orbita' | 'link' }; o nome que fica na correção é o do professor que corrigiu.
async function gravarCorrecao(entrega, turma, b, autor) {
    {
        const totalObj = (turma.objetivos || []).length;
        const sa = await db.collection(COL_ATIV).doc(entrega.atividadeId).get();
        const cobrar = sa.exists ? sa.data().matrizCobrar || null : null;
        const av = avaliacaoDoBody(b.avaliacao || {}, totalObj);
        const r = Matriz.calcular(av, totalObj, cobrar);
        const finalizar = b.finalizar === true;
        let ref = entrega.referencia;
        if (!ref) { const t = await db.collection(COL_TXT).doc(entrega.id).get(); ref = referenciaDe(t.exists ? t.data().texto : '', turma); }
        const refVista = referenciaCobrada(ref, totalObj, cobrar);
        if (finalizar) {
            const falta = [...r.faltando];
            const fb = av.feedback;
            if (!fb.fortes || !fb.desenvolver || !fb.recomendacao) falta.push('Feedback ao estudante: preencha pontos fortes, a desenvolver e recomendação');
            if (r.criterios.c2.manual && !r.criterios.c2.nivel) falta.push('Critério 2: escolha o nível (combinação não prevista na matriz)');
            // a nota de corte é o ponto de partida: mudou, explica (a análise vai para a devolutiva do aluno)
            if (refVista && !refVista.semTexto && refVista.nota != null && Math.abs(r.soma - refVista.nota) >= 0.01 && !fb.analise) falta.push('Análise do professor: a nota ficou diferente da nota de corte — explique o porquê');
            if (falta.length) throw Object.assign(falha(400, 'Faltam itens para finalizar.'), { faltando: falta });
        }
        const status = finalizar ? 'finalizada' : 'rascunho';
        // compara a SOMA dos critérios (antes de atraso/plágio): a referência não sabe de condição especial
        const diverge = !!(refVista && !refVista.semTexto && Math.abs(r.soma - refVista.nota) >= DIVERGENCIA);
        const evento = { em: agora(), por: autor.nome, via: autor.via, acao: finalizar ? 'finalizou' : (entrega.status === 'finalizada' ? 'reabriu' : 'salvou'), nota: r.nota, referencia: refVista ? refVista.nota : null };
        await db.collection(COL_ENT).doc(entrega.id).update({
            avaliacao: av, resultado: r, status, matrizVersao: Matriz.VERSAO, referencia: ref, divergeDaReferencia: diverge,
            corrigidoPor: autor.nome, corrigidoPorUid: autor.uid || null, corrigidoVia: autor.via, corrigidoEm: agora(),
            alteradoAposCorrecao: false,
            historico: admin.firestore.FieldValue.arrayUnion(evento)
        });
        return { id: entrega.id, status, resultado: r, referencia: refVista, divergeDaReferencia: diverge };
    }
}

// Distribuição (26/11/2026): a coordenação (ex.: prof. Ana Beatriz) manda cada portfólio para um professor corretor
// da turma. { modo: 'igual' } divide os que ainda estão sem professor, equilibrando com o que cada um já tem;
// { atribuicoes: { <entregaId>: <uid> | '' } } grava a escolha feita à mão ('' tira o professor).
router.put('/atividades/:id/distribuir', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação distribui os portfólios.');
        const { atividade, turma } = await lerAtividade(req, req.params.id);
        const profs = (turma.professores || []).filter(p => p && p.uid);
        if (!profs.length) throw falha(400, 'Cadastre os professores corretores da turma (Configurar turma) antes de distribuir.');
        const porUid = new Map(profs.map(p => [p.uid, p]));
        const snap = await db.collection(COL_ENT).where('atividadeId', '==', atividade.id).get();
        const ents = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.nome.localeCompare(b.nome));
        const b = req.body || {};
        const novo = new Map();
        if (b.modo === 'igual') {
            const carga = new Map(profs.map(p => [p.uid, ents.filter(e => e.corretorUid === p.uid).length]));
            ents.filter(e => !e.corretorUid || !porUid.has(e.corretorUid)).forEach(e => {
                const uid = [...carga.entries()].sort((x, y) => x[1] - y[1] || porUid.get(x[0]).nome.localeCompare(porUid.get(y[0]).nome))[0][0];
                novo.set(e.id, uid); carga.set(uid, carga.get(uid) + 1);
            });
        } else if (b.atribuicoes && typeof b.atribuicoes === 'object') {
            Object.entries(b.atribuicoes).forEach(([id, uid]) => {
                const e = ents.find(x => x.id === id);
                if (e && (uid === '' || porUid.has(uid)) && (e.corretorUid || '') !== uid) novo.set(id, uid);
            });
        } else throw falha(400, 'Nada para distribuir.');
        const quando = agora(), porQuem = quem(req);
        for (let i = 0; i < novo.size; i += 400) {
            const lote = db.batch();
            [...novo.entries()].slice(i, i + 400).forEach(([id, uid]) => lote.update(db.collection(COL_ENT).doc(id),
                { corretorUid: uid || null, corretorNome: uid ? porUid.get(uid).nome : null, distribuidoEm: quando, distribuidoPor: porQuem }));
            await lote.commit();
        }
        res.json({ message: novo.size ? `${novo.size} portfólio(s) distribuído(s).` : 'Nada mudou: todos já tinham professor.', alterados: novo.size });
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
        const r = analisar(docs);
        if (!podeEditar(req.user)) {
            const meus = new Set(ents.docs.filter(d => d.data().corretorUid === req.user.uid).map(d => d.id));
            r.pares = r.pares.filter(p => meus.has(p.a) || meus.has(p.b));
        }
        res.json({ total: ents.size, ...r });
    } catch (e) { erro(res, e); }
});

// ---------- integração com o AVA por web service (24/11/2026) ----------
// No lugar do ZIP e da planilha offline: a atividade é ligada à Tarefa do AVA (curso + tarefa); "Buscar entregas"
// traz os envios (o navegador lê o PDF pelo proxy abaixo e manda o texto pela rota de entregas, como no ZIP);
// "Lançar notas" grava a nota (nota 0–10 × nota máxima da Tarefa / 10 — ex.: 7,5 → 75 numa Tarefa de 100) e o
// feedback de cada correção FINALIZADA. Só a coordenação (podeEditar). O token fica no servidor (src/utils/ava-ws.js).
const ava = require('../utils/ava-ws');
const exigeEditor = (req) => { if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação usa a integração com o AVA.'); };
const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// mesmo texto do feedback da planilha (medicina/portfolio/app.js › feedbackHtml)
function feedbackHtml(e) {
    const r = e.resultado, av = e.avaliacao, f = Matriz.fmt;
    const nl = Matriz.CRITERIOS.filter(c => !r.criterios[c.id].naoCobrado).map(c => `${c.nome}: ${Matriz.NOME_NIVEL[r.criterios[c.id].nivel]} (${f(r.criterios[c.id].pts)}/${f(r.criterios[c.id].max)})`);
    const partes = [`<b>Portfólio — ${f(r.nota)} / 10,0</b>`, ...nl.map(escHtml)];
    if (r.penalidade !== 'nenhuma') partes.push(escHtml(`${Matriz.PENALIDADES[r.penalidade].rotulo} (soma ${f(r.soma)})`));
    partes.push(`<b>Pontos fortes:</b> ${escHtml(av.feedback.fortes)}`, `<b>Pontos a desenvolver:</b> ${escHtml(av.feedback.desenvolver)}`, `<b>Recomendação:</b> ${escHtml(av.feedback.recomendacao)}`);
    return `<p>${partes.join('<br>')}</p>`;
}
const notaNoAva = (nota, max) => Math.round(Number(nota) * (Number(max) || 10) / 10 * 100) / 100;

// GET /ava/tarefas?curso=3632 — Tarefas do curso (para ligar a atividade)
router.get('/ava/tarefas', async (req, res) => {
    try {
        exigeEditor(req);
        const curso = parseInt(req.query.curso, 10);
        if (!curso) throw falha(400, 'Informe o número do curso no AVA (o "id=" do link da disciplina).');
        const j = await ava.ws('mod_assign_get_assignments', { courseids: [curso], includenotenrolledcourses: 1 });
        const c = (j.courses || [])[0];
        if (!c) throw falha(404, `O AVA não deixou ver o curso ${curso}. Confira o número (o curso precisa estar na categoria MED).`);
        res.json({ curso: { id: c.id, nome: c.fullname, sigla: c.shortname }, tarefas: (c.assignments || []).map(a => ({ id: a.id, nome: a.name, prazo: a.duedate || 0, notaMax: a.grade, anonimo: !!a.blindmarking })) });
    } catch (e) { erro(res, e); }
});

// PUT /atividades/:id/ava { cursoId, tarefaId } — liga a atividade à Tarefa do AVA
// Valor do portfólio na disciplina (26/11/2026): a matriz dá 0 a 10 (e o AVA recebe 0 a 10), mas na nota da
// disciplina o portfólio vale menos — no SCIC 2026.2, 3,0. Nota na disciplina = nota da matriz × valor ÷ 10, com 1 casa.
router.put('/atividades/:id/valor', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação define quanto o portfólio vale.');
        const { atividade } = await lerAtividade(req, req.params.id);
        const valor = Math.round(Number(String((req.body || {}).valor).replace(',', '.')) * 10) / 10;
        if (!(valor > 0) || valor > 10) throw falha(400, 'O valor do portfólio na disciplina vai de 0,1 até 10.');
        await db.collection(COL_ATIV).doc(atividade.id).update({ valorDisciplina: valor, valorDisciplinaPor: quem(req), valorDisciplinaEm: agora() });
        res.json({ valor, message: `O portfólio vale ${String(valor).replace('.', ',')} na disciplina.` });
    } catch (e) { erro(res, e); }
});

// ---------- o que cobrar (27/11/2026, pedido do prof. João Felipe) ----------
// A coordenação escolhe, por atividade, quais critérios (C1–C4) e quais objetivos do C3 são cobrados. O que não for
// cobrado sai da conta e o valor é distribuído entre os demais (medicina/portfolio/matriz.js → calcular). Com tudo
// marcado, nada muda. atividade.matrizCobrar = { criterios: ['c1',…], objetivos: [índices], por, em } (ausente = tudo).
// A nota de corte gravada NÃO é alterada: é recalculada na hora (referenciaCobrada) e a original fica em notaMatrizCheia.
function referenciaCobrada(ref, totalObj, cobrar) {
    if (!ref || !cobrar) return ref;
    const r = Matriz.notaDaReferencia(ref, totalObj, cobrar);
    if (!r) return ref;
    return { ...ref, nota: r.soma, notaMatrizCheia: ref.nota, pts: { c1: r.criterios.c1.pts, c2: r.criterios.c2.pts, c3: r.criterios.c3.pts, c4: r.criterios.c4.pts }, recalculadaPeloQueCobrar: true };
}
router.put('/atividades/:id/cobrar', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação escolhe o que cobrar.');
        const { atividade, turma } = await lerAtividade(req, req.params.id);
        const totalObj = (turma.objetivos || []).length;
        const b = req.body || {};
        const ids = Matriz.CRITERIOS.map(c => c.id);
        const criterios = ids.filter(id => Array.isArray(b.criterios) && b.criterios.includes(id));
        if (!criterios.length) throw falha(400, 'Cobre pelo menos um critério.');
        const objetivos = [...new Set((Array.isArray(b.objetivos) ? b.objetivos : []).map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < totalObj))].sort((x, y) => x - y);
        if (criterios.includes('c3') && !objetivos.length) throw falha(400, 'O Critério 3 está cobrado: marque pelo menos um objetivo (ou desmarque o Critério 3).');
        const tudo = criterios.length === ids.length && objetivos.length === totalObj;
        const matrizCobrar = tudo ? admin.firestore.FieldValue.delete() : { criterios, objetivos, por: quem(req), em: agora() };
        const cobrar = tudo ? null : { criterios, objetivos };
        // correções já salvas passam a valer pela nova escolha (a nota é calculada, não digitada)
        const snap = await db.collection(COL_ENT).where('atividadeId', '==', atividade.id).get();
        const batch = db.batch();
        let recalc = 0;
        snap.docs.forEach(d => {
            const e = d.data();
            if (!e.avaliacao) return;
            const r = Matriz.calcular(e.avaliacao, totalObj, cobrar);
            const refVista = referenciaCobrada(e.referencia, totalObj, cobrar);
            batch.update(d.ref, { resultado: r, divergeDaReferencia: !!(refVista && !refVista.semTexto && refVista.nota != null && Math.abs(r.soma - refVista.nota) >= DIVERGENCIA) });
            recalc++;
        });
        batch.update(db.collection(COL_ATIV).doc(atividade.id), { matrizCobrar });
        await batch.commit();
        res.json({ matrizCobrar: tudo ? null : { criterios, objetivos, por: quem(req), em: agora() },
            message: tudo ? `Tudo cobrado (matriz completa).${recalc ? ` ${recalc} correção(ões) recalculada(s).` : ''}`
                : `Salvo: ${criterios.length} critério(s) e ${objetivos.length} de ${totalObj} objetivo(s) cobrados; o valor do que saiu foi distribuído entre os demais.${recalc ? ` ${recalc} correção(ões) recalculada(s).` : ''}` });
    } catch (e) { erro(res, e); }
});

// ---------- link do professor (27/11/2026) ----------
// Para NÃO liberar o módulo inteiro aos professores: igual aos links das UAs do EAD, cada professor corretor recebe UM link
// por semestre (sem login; o token é a autorização) com TODOS os portfólios distribuídos para ele (entrega.corretorUid),
// de todas as turmas/atividades. Ele corrige pela mesma matriz, salva e envia um de cada vez. Correção enviada fica
// travada para ele (a coordenação reabre no Órbita). Página: /medicina/portfolio-professor/?t=<token>.
// Coleção: med_portfolio_links/{token} = { semestre, uid, nome, ativo, criadoEm, criadoPor }.
const crypto = require('crypto');
const COL_LINKS = 'med_portfolio_links';
async function linksDoSemestre(semestre) {
    const s = await db.collection(COL_LINKS).where('semestre', '==', semestre).get();
    return s.docs.map(d => ({ token: d.id, ...d.data() })).filter(l => l.ativo !== false);
}
// GET /links?semestre= — professores com portfólios distribuídos no semestre, quanto já enviaram e o link (se já gerado)
router.get('/links', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação vê os links dos professores.');
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : semestreAtual();
        const ats = await db.collection(COL_ATIV).where('semestre', '==', semestre).get();
        const ids = ats.docs.map(d => d.id);
        const porUid = new Map();
        for (let i = 0; i < ids.length; i += 10) {
            const s = await db.collection(COL_ENT).where('atividadeId', 'in', ids.slice(i, i + 10)).get();
            s.docs.forEach(d => {
                const e = d.data();
                if (!e.corretorUid) return;
                const x = porUid.get(e.corretorUid) || { uid: e.corretorUid, nome: e.corretorNome || '', total: 0, enviadas: 0, rascunho: 0 };
                x.total++; if (e.status === 'finalizada') x.enviadas++; else if (e.status === 'rascunho') x.rascunho++;
                porUid.set(e.corretorUid, x);
            });
        }
        const links = await linksDoSemestre(semestre);
        const lista = [...porUid.values()].map(x => { const l = links.find(k => k.uid === x.uid); return { ...x, token: l ? l.token : null, geradoEm: l ? l.criadoEm : null }; })
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ semestre, professores: lista });
    } catch (e) { erro(res, e); }
});
// POST /links { semestre, uid, novo? } — devolve o link do professor (ou cria). novo: true desativa o antigo e gera outro.
router.post('/links', async (req, res) => {
    try {
        if (!podeEditar(req.user)) throw falha(403, 'Só a coordenação gera os links dos professores.');
        const b = req.body || {};
        const semestre = String(b.semestre || '');
        const uid = txt(b.uid, 128);
        if (!SEMESTRE.test(semestre) || !uid) throw falha(400, 'Semestre ou professor inválido.');
        const turmas = await turmasDoSemestre(semestre);
        const prof = turmas.flatMap(t => t.professores || []).find(p => p.uid === uid);
        if (!prof) throw falha(400, 'Esse professor não é corretor de nenhuma turma do semestre.');
        const ja = (await linksDoSemestre(semestre)).find(l => l.uid === uid);
        if (ja && !b.novo) return res.json(ja);
        if (ja) await db.collection(COL_LINKS).doc(ja.token).update({ ativo: false, desativadoEm: agora(), desativadoPor: quem(req) });
        const token = crypto.randomBytes(24).toString('base64url');
        const novo = { semestre, uid, nome: prof.nome, ativo: true, criadoEm: agora(), criadoPor: quem(req) };
        await db.collection(COL_LINKS).doc(token).set(novo);
        res.status(201).json({ token, ...novo });
    } catch (e) { erro(res, e); }
});

router.put('/atividades/:id/ava', async (req, res) => {
    try {
        exigeEditor(req);
        const { atividade } = await lerAtividade(req, req.params.id);
        const cursoId = parseInt((req.body || {}).cursoId, 10), tarefaId = parseInt((req.body || {}).tarefaId, 10);
        if (!cursoId || !tarefaId) throw falha(400, 'Escolha o curso e a Tarefa do AVA.');
        const j = await ava.ws('mod_assign_get_assignments', { courseids: [cursoId], includenotenrolledcourses: 1 });
        const c = (j.courses || [])[0], t = c && (c.assignments || []).find(a => a.id === tarefaId);
        if (!t) throw falha(404, 'Essa Tarefa não está nesse curso do AVA.');
        if (t.blindmarking) throw falha(400, 'Essa Tarefa usa envio anônimo: a integração precisa dos nomes. Desative o envio anônimo na Tarefa ou use o ZIP.');
        if (!(t.grade > 0)) throw falha(400, 'Essa Tarefa não tem nota numérica no AVA (nota máxima). Configure a nota da Tarefa antes.');
        const ligacao = { cursoId, cursoNome: c.fullname, tarefaId, tarefaNome: t.name, notaMax: t.grade, ligadoEm: agora(), ligadoPor: quem(req) };
        await db.collection(COL_ATIV).doc(atividade.id).update({ ava: ligacao });
        res.json({ ava: ligacao });
    } catch (e) { erro(res, e); }
});

// GET /atividades/:id/ava/entregas — envios da Tarefa (quem enviou e os arquivos; sem baixar nada ainda)
router.get('/atividades/:id/ava/entregas', async (req, res) => {
    try {
        exigeEditor(req);
        const { atividade } = await lerAtividade(req, req.params.id);
        if (!atividade.ava) throw falha(400, 'Ligue a atividade à Tarefa do AVA primeiro.');
        const [part, subs] = await Promise.all([
            ava.ws('mod_assign_list_participants', { assignid: atividade.ava.tarefaId, groupid: 0, filter: '', onlyids: 1 }),
            ava.ws('mod_assign_get_submissions', { assignmentids: [atividade.ava.tarefaId] })
        ]);
        const nomes = new Map((Array.isArray(part) ? part : []).map(p => [p.id, p.fullname]));
        const envios = ((((subs.assignments || [])[0]) || {}).submissions || []).filter(s => s.status === 'submitted');
        const itens = envios.map(s => {
            const arquivos = [];
            (s.plugins || []).forEach(p => (p.fileareas || []).forEach(fa => (fa.files || []).forEach(f => {
                const caminho = ava.caminhoDoArquivo(f.fileurl);
                if (caminho) arquivos.push({ nome: f.filename, caminho, tipo: f.mimetype || '', tamanho: f.filesize || 0 });
            })));
            const textoOnline = (s.plugins || []).filter(p => p.type === 'onlinetext').flatMap(p => (p.editorfields || []).map(x => x.text || '')).join('\n').trim();
            return { userid: s.userid, nome: nomes.get(s.userid) || `Aluno ${s.userid}`, enviadoEm: s.timemodified || 0, arquivos, textoOnline };
        }).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ tarefa: atividade.ava, participantes: nomes.size, itens });
    } catch (e) { erro(res, e); }
});

// GET /atividades/:id/ava/arquivo?c=/webservice/pluginfile.php/... — o PDF do aluno passa pelo Órbita (o token não sai do servidor)
router.get('/atividades/:id/ava/arquivo', async (req, res) => {
    try {
        const { atividade } = await lerAtividade(req, req.params.id);
        const caminho = String(req.query.c || '');
        if (!podeEditar(req.user)) {
            const snap = await db.collection(COL_ENT).where('atividadeId', '==', atividade.id).where('corretorUid', '==', req.user.uid).get();
            if (!snap.docs.some(d => (d.data().avaArquivos || []).some(a => a.caminho === caminho))) throw falha(403, 'Este arquivo não é de um portfólio distribuído para você.');
        }
        const { tipo, bytes } = await ava.baixarArquivo(caminho);
        res.set('Content-Type', tipo);
        res.set('Cache-Control', 'private, no-store');
        res.send(bytes);
    } catch (e) { erro(res, e); }
});

// GET /atividades/:id/ava/notas — prévia do que vai para o AVA; POST — lança (só finalizadas, com o aluno do AVA)
async function notasParaLancar(atividade) {
    const snap = await db.collection(COL_ENT).where('atividadeId', '==', atividade.id).get();
    const todas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const prontas = todas.filter(e => e.status === 'finalizada' && e.resultado && e.avaUserId);
    const semAluno = todas.filter(e => e.status === 'finalizada' && !e.avaUserId).length;
    return { todas, prontas, semAluno };
}
router.get('/atividades/:id/ava/notas', async (req, res) => {
    try {
        exigeEditor(req);
        const { atividade } = await lerAtividade(req, req.params.id);
        if (!atividade.ava) throw falha(400, 'Ligue a atividade à Tarefa do AVA primeiro.');
        const { todas, prontas, semAluno } = await notasParaLancar(atividade);
        res.json({
            tarefa: atividade.ava, total: todas.length, semAluno,
            itens: prontas.map(e => ({ id: e.id, nome: e.nome, nota: e.resultado.nota, notaAva: notaNoAva(e.resultado.nota, atividade.ava.notaMax),
                jaLancada: !!(e.avaLancado && e.avaLancado.nota === e.resultado.nota), lancadaEm: e.avaLancado ? e.avaLancado.em : '' }))
        });
    } catch (e) { erro(res, e); }
});
router.post('/atividades/:id/ava/notas', async (req, res) => {
    try {
        exigeEditor(req);
        const { atividade } = await lerAtividade(req, req.params.id);
        if (!atividade.ava) throw falha(400, 'Ligue a atividade à Tarefa do AVA primeiro.');
        if ((req.body || {}).confirmar !== true) throw falha(400, 'Confirme o lançamento.');
        const ids = new Set(Array.isArray(req.body.ids) ? req.body.ids.map(String) : []);
        const { prontas } = await notasParaLancar(atividade);
        const alvo = prontas.filter(e => !ids.size || ids.has(e.id));
        const ok = [], erros = [];
        for (const e of alvo) {
            const notaAva = notaNoAva(e.resultado.nota, atividade.ava.notaMax);
            try {
                await ava.ws('mod_assign_save_grade', {
                    assignmentid: atividade.ava.tarefaId, userid: e.avaUserId, grade: notaAva.toFixed(2),
                    attemptnumber: -1, addattempt: 0, workflowstate: '', applytoall: 0,
                    plugindata: { assignfeedbackcomments_editor: { text: feedbackHtml(e), format: 1 } }
                });
                await db.collection(COL_ENT).doc(e.id).update({ avaLancado: { em: agora(), por: quem(req), nota: e.resultado.nota, notaAva } });
                ok.push(e.nome);
            } catch (err) { erros.push(`${e.nome}: ${err.message}`); }
        }
        res.json({ lancadas: ok.length, erros, message: `${ok.length} nota(s) lançada(s) no AVA.${erros.length ? ` ${erros.length} com erro.` : ''}` });
    } catch (e) { erro(res, e); }
});

module.exports = router;
// usado pelo link do professor (src/rotas/portfolio-med-publico.js), que não passa pelo login
module.exports.interno = { gravarCorrecao, referenciaCobrada, lerTurma, COL_ATIV, COL_ENT, COL_TXT, COL_LINKS, falha, erro };
