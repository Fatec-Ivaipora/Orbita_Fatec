const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================================================
// Correção de Provas (13/10/2026) — mesmo uso que a Fatec fazia no Evalbee: o coordenador cria a
// avaliação (prova EAD de 10 questões, simulado de 40…), escolhe as turmas, define o gabarito (digitado
// ou puxado do Banco de Provas / Banco MED-FATEC), imprime uma folha de respostas por aluno e depois lê
// as folhas com a câmera do celular pelo Órbita; o acerto sai na hora.
//
// As turmas e os alunos vêm do Edubox pelo CADD (cad_turmas), então não precisa importar turma.
// Cada folha leva um código impresso (avaliação + aluno) que o leitor reconhece.
// Só coordenador e direção usam (aluno e professor não acessam). Coordenador: só turmas do próprio curso.
//
//   correcao_avaliacoes/{id}            avaliação: gabarito, disciplinas por questão, alunos (cópia)
//   correcao_leituras/{id}__{indice}    respostas lidas de cada aluno
//   config/correcao_seq                 contador do código numérico das avaliações
// ==========================================================================
const checkPermission = verifyToken.requireModulePermission('correcao-provas');
const { escopoDe, podeVer, CODCUR } = require('./cpa')._interno;
const COL = 'correcao_avaliacoes';
const COL_LEIT = 'correcao_leituras';
const ADM = ['adm_l1', 'adm_l2'];
const LETRAS = 'ABCDE';
const MAX_QUESTOES = 60;

const texto = (v, max) => String(v || '').trim().slice(0, max);
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
// rastreabilidade (14/10/2026): cada avaliação fica guardada por semestre, disciplina, tipo e bimestre,
// além de quem criou — a lista da tela se organiza por isso.
const TIPOS = ['bimestral', 'exame', 'simulado', 'ead', 'dp', 'outra'];
function camposRastreio(body, base = {}) {
    const out = {};
    if (body.tipo !== undefined) out.tipo = TIPOS.includes(body.tipo) ? body.tipo : 'outra';
    if (body.bimestre !== undefined) out.bimestre = [1, 2].includes(Number(body.bimestre)) ? Number(body.bimestre) : null;
    if (body.disciplina !== undefined) out.disciplina = texto(body.disciplina, 120) || null;
    if (body.professor !== undefined) out.professor = texto(body.professor, 120) || null;
    return { ...base, ...out };
}

// gabarito: letras aceitas ("A", ou "AC" se mais de uma vale) ou "X" = questão anulada (vale para todos)
function acertou(gab, resp) {
    if (!gab) return false;
    if (gab === 'X') return true;
    return !!resp && resp.length === 1 && gab.includes(resp);
}
// Conta como certa também: (1) questão que o coordenador decidiu considerar certa para o aluno
// (l.consideradas, com quem e quando) e (2) dupla marcação em que uma das marcadas é a certa, se a
// avaliação estiver com "aceitarDupla" ligado. Ver PUT .../considerar.
function certaNaFolha(av, l, i) {
    const q = av.questoes[i], r = (l.respostas || [])[i];
    if (l.consideradas && l.consideradas[i]) return true;
    if (acertou(q.g, r)) return true;
    if (av.aceitarDupla && r === '*' && q.g && q.g !== 'X' && [...String((l.duplas || {})[i] || '')].some(x => q.g.includes(x))) return true;
    return false;
}
function resultado(av, respostasOuLeitura) {
    const l = Array.isArray(respostasOuLeitura) ? { respostas: respostasOuLeitura } : (respostasOuLeitura || {});
    const porDisc = {};
    let acertos = 0;
    av.questoes.forEach((q, i) => {
        const ok = certaNaFolha(av, l, i);
        if (ok) acertos++;
        const d = q.d || '';
        const x = (porDisc[d] = porDisc[d] || { acertos: 0, total: 0 });
        x.total++; if (ok) x.acertos++;
    });
    const total = av.questoes.length;
    const nota = av.valorTotal ? Math.round(acertos / total * av.valorTotal * 100) / 100 : null;
    return { acertos, total, nota, porDisc };
}

async function escopo(req) { return escopoDe(req); }
function podeAvaliacao(esc, av) { return esc === null || (av.codcurs || []).some(c => podeVer(esc, c)); }
const souDono = (req, av) => ADM.includes(req.user.role) || av.criadoPorUid === req.user.uid;

// GET /api/correcao/turmas — turmas do semestre atual (graduação e medicina) que a pessoa pode ver
router.get('/turmas', verifyToken, checkPermission, async (req, res) => {
    try {
        const esc = await escopo(req);
        const snap = await db.collection('cad_ciclos').get();
        const ciclos = snap.docs.map(d => d.data());
        // o semestre mais recente de cada segmento
        const atual = {};
        ciclos.forEach(c => { if (!atual[c.segmento] || String(c.semestre) > String(atual[c.segmento].semestre)) atual[c.segmento] = c; });
        const turmas = Object.values(atual).flatMap(c => (c.turmas || []).filter(t => podeVer(esc, t.codcur)).map(t => ({ ...t, semestre: c.semestre, segmento: c.segmento })));
        // turmas de TESTE/treino (cad_turmas com teste:true, criadas à mão): ficam fora do CADD e não somem
        // quando o CADD atualiza; servem pra testar e pra treinar coordenador sem usar turma de verdade
        const teste = await db.collection('cad_turmas').where('teste', '==', true).get();
        teste.forEach(d => { const t = d.data(); if (podeVer(esc, t.codcur)) turmas.push({ id: t.id, turma: t.turma, codcur: t.codcur, curso: t.curso, periodo: t.periodo, alunos: (t.alunos || []).length, grupo: t.id, semestre: t.semestre, segmento: t.segmento, teste: true }); });
        turmas.sort((a, b) => String(a.curso).localeCompare(String(b.curso), 'pt-BR') || String(a.turma).localeCompare(String(b.turma), 'pt-BR'));
        res.json({ turmas, adm: ADM.includes(req.user.role), uid: req.user.uid });
    } catch (err) {
        console.error('[correcao] turmas:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/correcao/disciplinas?turmas=id1,id2 — disciplinas das turmas escolhidas (para a avaliação)
router.get('/disciplinas', verifyToken, checkPermission, async (req, res) => {
    try {
        const ids = String(req.query.turmas || '').split(',').filter(Boolean).slice(0, 30);
        const esc = await escopo(req);
        const docs = await Promise.all(ids.map(id => db.collection('cad_turmas').doc(id).get()));
        const mapa = new Map();
        docs.filter(d => d.exists).map(d => d.data()).filter(t => podeVer(esc, t.codcur)).forEach(t => (t.disciplinas || []).filter(d => !d.dp).forEach(d => {
            const k = normNome(d.nome);
            const x = mapa.get(k) || mapa.set(k, { nome: d.nome, professor: d.professor || '', turmas: [] }).get(k);
            if (!x.turmas.includes(t.id)) x.turmas.push(t.id);
            if (!x.professor && d.professor) x.professor = d.professor;
        }));
        res.json({ disciplinas: [...mapa.values()].sort((a, b) => b.turmas.length - a.turmas.length || a.nome.localeCompare(b.nome, 'pt-BR')) });
    } catch (err) {
        console.error('[correcao] disciplinas:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- prova de DP ----------
// Alunos que fazem a disciplina como DP (vindos de qualquer turma). No CADD, a disciplina de outra turma
// aparece marcada dp:true dentro da turma do aluno.
async function turmasDoCurso(codcur) {
    const snap = await db.collection('cad_ciclos').get();
    const atual = {};
    snap.docs.map(d => d.data()).forEach(c => { if (!atual[c.segmento] || String(c.semestre) > String(atual[c.segmento].semestre)) atual[c.segmento] = c; });
    const ids = Object.values(atual).flatMap(c => (c.turmas || []).filter(t => t.codcur === codcur).map(t => t.id));
    const docs = await Promise.all(ids.map(id => db.collection('cad_turmas').doc(id).get()));
    return docs.filter(d => d.exists).map(d => d.data());
}
function alunosDP(ts, chave) {
    const out = [];
    ts.forEach(t => {
        const disc = new Map((t.disciplinas || []).filter(d => d.dp && normNome(d.nome) === chave).map(d => [d.id, d]));
        if (!disc.size) return;
        (t.alunos || []).forEach(a => { if ((a.d || []).some(x => disc.has(x.id))) out.push({ a, t }); });
    });
    return out;
}
// GET /api/correcao/dp/:codcur — disciplinas que têm aluno de DP no semestre atual
router.get('/dp/:codcur', verifyToken, checkPermission, async (req, res) => {
    try {
        const codcur = String(req.params.codcur);
        if (!podeVer(await escopo(req), codcur)) return res.status(403).json({ error: 'Você não tem acesso a este curso.' });
        const ts = await turmasDoCurso(codcur);
        const mapa = new Map();
        ts.forEach(t => (t.disciplinas || []).filter(d => d.dp).forEach(d => {
            const k = normNome(d.nome);
            const x = mapa.get(k) || mapa.set(k, { chave: k, nome: d.nome, professor: d.professor || '' }).get(k);
            if (!x.professor && d.professor) x.professor = d.professor;
        }));
        const disciplinas = [...mapa.values()].map(x => ({ ...x, alunos: new Set(alunosDP(ts, x.chave).map(y => String(y.a.alu || y.a.id))).size }))
            .filter(x => x.alunos).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ disciplinas });
    } catch (err) {
        console.error('[correcao] dp:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- gabarito vindo dos bancos ----------
// Banco de Provas (graduação): cursos por id ("agronomia"…); coordenador só os do cadastro.
async function cursosBP(req) {
    if (ADM.includes(req.user.role)) return null;
    if (req.user.role === 'ead') return null; // 21/10/2026: EAD vê o Banco de Provas de todos os cursos da graduação (Medicina fora, ver foraDoEad)
    const u = await db.collection('users').doc(req.user.uid).get();
    const d = u.exists ? u.data() : {};
    return Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
}
const foraDoEad = (req, curso) => req.user.role === 'ead' && curso === 'medicina';
const podeMed = (req) => ['adm_l1', 'adm_l2', 'coord_medicina'].includes(req.user.role);

// GET /api/correcao/bancos/provas — provas montadas nos bancos que a pessoa pode usar
router.get('/bancos/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        const lista = [];
        const meus = await cursosBP(req);
        if (meus === null || meus.length) {
            const snap = meus === null ? await db.collection('docencia_bp_provas').get()
                : await db.collection('docencia_bp_provas').where('curso', 'in', meus.slice(0, 10)).get();
            snap.forEach(d => { const p = d.data(); if (foraDoEad(req, p.curso)) return; lista.push({ origem: 'bp', id: d.id, nome: p.nome, tipo: p.tipo, curso: p.curso, n: (p.questoesIds || []).length, em: p.createdAt }); });
        }
        if (podeMed(req)) {
            const snap = await db.collection('banco_med_provas').get();
            snap.forEach(d => { const p = d.data(); lista.push({ origem: 'med', id: d.id, nome: p.nome, tipo: p.tipo, curso: 'medicina', n: (p.questoesIds || []).length, em: p.createdAt }); });
        }
        lista.sort((a, b) => String(b.em || '').localeCompare(String(a.em || '')));
        res.json({ provas: lista });
    } catch (err) {
        console.error('[correcao] bancos:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/correcao/bancos/:origem/:id — gabarito e disciplina de cada questão, na numeração da prova impressa
router.get('/bancos/:origem/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { origem, id } = req.params;
        if (origem === 'bp') {
            const s = await db.collection('docencia_bp_provas').doc(id).get();
            if (!s.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
            const prova = { id: s.id, ...s.data() };
            const meus = await cursosBP(req);
            if ((meus !== null && !meus.includes(prova.curso)) || foraDoEad(req, prova.curso)) return res.status(403).json({ error: 'Você não tem vínculo com esse curso.' });
            const [qs, ds] = await Promise.all([
                Promise.all((prova.questoesIds || []).map(q => db.collection('docencia_bp_questoes').doc(q).get())),
                db.collection('docencia_bp_disciplinas').where('curso', '==', prova.curso).get()
            ]);
            const nomes = { geral: 'Conhecimentos Gerais' };   // mesmo id fixo do Banco de Provas (DISCIPLINA_GERAL_ID)
            ds.forEach(d => { nomes[d.id] = d.data().nome; });
            const questoes = qs.filter(x => x.exists).map(x => ({ id: x.id, ...x.data() }));
            const { numerarQuestoesObjetivas } = require('../utils/gerarProvaDocx');
            const numeradas = numerarQuestoesObjetivas(prova, questoes, { nomesDisciplina: nomes });
            const dissertativas = questoes.filter(q => q.tipo === 'dissertativa').length;
            const disc = prova.disciplinaId ? (nomes[prova.disciplinaId] || '') : '';
            res.json({
                nome: prova.nome, curso: prova.curso, dissertativas, tipo: prova.tipo, bimestre: prova.bimestre || null,
                disciplina: prova.tipo === 'simulado' ? 'Várias (simulado)' : disc, professor: prova.professorNome || null,
                questoes: numeradas.map(({ questao, secaoNome }) => ({ q: questao.id, g: String(questao.gabarito || '').toUpperCase().replace(/[^A-E]/g, ''), d: secaoNome || disc }))
            });
        } else if (origem === 'med') {
            if (!podeMed(req)) return res.status(403).json({ error: 'O Banco MED-FATEC é da Coordenação de Medicina.' });
            const s = await db.collection('banco_med_provas').doc(id).get();
            if (!s.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
            const prova = s.data();
            const [qs, cs] = await Promise.all([
                Promise.all((prova.questoesIds || []).map(q => db.collection('banco_med_questoes').doc(q).get())),
                db.collection('banco_med_categorias').get()
            ]);
            const cat = {}; cs.forEach(d => { cat[d.id] = d.data().nome; });
            const questoes = qs.filter(x => x.exists).map(x => ({ id: x.id, ...x.data() }));
            res.json({
                nome: prova.nome, curso: 'medicina', dissertativas: 0, tipo: prova.tipo === 'enamed' ? 'simulado' : 'bimestral', bimestre: null,
                disciplina: prova.tipo === 'enamed' ? `ENAMED — ${prova.areaEnamed || ''}` : (cat[prova.categoriaId] || null), professor: prova.criadoPorNome || null,
                questoes: questoes.map(q => ({
                    q: q.id,
                    g: gabaritoMed(q),
                    d: prova.tipo === 'enamed' ? (q.areaEnamed || cat[q.categoriaId] || '') : (cat[q.categoriaId] || '')
                }))
            });
        } else return res.status(400).json({ error: 'Banco desconhecido.' });
    } catch (err) {
        console.error('[correcao] gabarito do banco:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- avaliações ----------
function validarQuestoes(lista, nAlt) {
    if (!Array.isArray(lista) || !lista.length) return 'A avaliação precisa ter pelo menos uma questão.';
    if (lista.length > MAX_QUESTOES) return `No máximo ${MAX_QUESTOES} questões por folha.`;
    const validas = LETRAS.slice(0, nAlt);
    for (const [i, q] of lista.entries()) {
        const g = String(q.g || '').toUpperCase();
        if (g && g !== 'X' && ![...g].every(l => validas.includes(l))) return `Gabarito inválido na questão ${i + 1}.`;
    }
    return null;
}
const limparQuestoes = (lista) => lista.map(q => ({ g: String(q.g || '').toUpperCase().replace(/[^A-EX]/g, '').slice(0, 5), d: texto(q.d, 80), ...(q.q ? { q: texto(q.q, 60) } : {}) }));
const gabaritoMed = (q) => (q.alternativas || []).map((a, i) => (a.correta ? LETRAS[i] : '')).join('').slice(0, 5);
const idsDoBanco = (questoes) => [...new Set(questoes.map(q => q.q).filter(Boolean))];

// Gabarito mudou no Banco de Provas / MED-FATEC (14/10/2026): atualiza as avaliações que usam a questão.
// As leituras ficam; o acerto é recalculado na hora de mostrar. Questão que o coordenador anulou aqui
// continua anulada. Só lê quando alguém muda um gabarito (array-contains em questaoIds).
async function propagarGabarito(questaoId, gabarito, quem) {
    const g = String(gabarito || '').toUpperCase().replace(/[^A-E]/g, '').slice(0, 5);
    if (!questaoId || !g) return 0;
    const snap = await db.collection(COL).where('questaoIds', 'array-contains', String(questaoId)).get();
    let n = 0;
    for (const d of snap.docs) {
        const av = d.data();
        let mudou = false;
        const questoes = (av.questoes || []).map((q, i) => {
            if (q.q !== String(questaoId) || q.g === 'X' || q.g === g) return q;
            mudou = true; return { ...q, g };
        });
        if (!mudou) continue;
        await d.ref.update({ questoes, gabaritoDoBancoEm: new Date().toISOString(), gabaritoDoBancoPor: quem || '' });
        n++;
    }
    return n;
}

// GET /api/correcao/avaliacoes — avaliações das turmas que a pessoa pode ver (sem a lista de alunos)
router.get('/avaliacoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const esc = await escopo(req);
        const snap = await db.collection(COL).get();
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => podeAvaliacao(esc, a))
            .map(({ alunos, ...a }) => ({ ...a, nAlunos: (alunos || []).length }))
            .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
        res.json({ avaliacoes: lista, uid: req.user.uid, adm: ADM.includes(req.user.role) });
    } catch (err) {
        console.error('[correcao] lista:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/correcao/avaliacoes — { nome, data, turmas:[cad_turmas id], nAlt, questoes:[{g,d}], valorTotal, origem, provaId }
router.post('/avaliacoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = texto(req.body.nome, 120);
        if (!nome) return res.status(400).json({ error: 'Informe o nome da avaliação.' });
        const rastreio = camposRastreio({ tipo: req.body.tipo, bimestre: req.body.bimestre, disciplina: req.body.disciplina, professor: req.body.professor });
        if (!rastreio.disciplina && !(req.body.dp && req.body.dp.nome)) return res.status(400).json({ error: 'Informe a disciplina da avaliação.' });
        const nAlt = Number(req.body.nAlt) === 4 ? 4 : 5;
        const erroQ = validarQuestoes(req.body.questoes, nAlt);
        if (erroQ) return res.status(400).json({ error: erroQ });
        const esc = await escopo(req);
        const turmas = [], alunos = [];
        let dp = null;
        if (req.body.dp && req.body.dp.codcur && req.body.dp.chave) {
            // prova de DP: alunos que fazem a disciplina como DP, de qualquer turma do curso
            const codcur = String(req.body.dp.codcur);
            if (!podeVer(esc, codcur)) return res.status(403).json({ error: 'Você só pode usar turmas do seu curso.' });
            const ts = await turmasDoCurso(codcur);
            const achados = alunosDP(ts, normNome(req.body.dp.chave));
            if (!achados.length) return res.status(400).json({ error: 'Nenhum aluno de DP nessa disciplina.' });
            const vistos = new Set();
            achados.sort((x, y) => String(x.a.nome).localeCompare(String(y.a.nome), 'pt-BR')).forEach(({ a, t }) => {
                const k = String(a.alu || a.id); if (vistos.has(k)) return; vistos.add(k);
                if (!turmas.some(x => x.id === t.id)) turmas.push({ id: t.id, turma: t.turma, curso: t.curso, codcur: t.codcur, semestre: t.semestre });
                alunos.push({ i: alunos.length, alu: k, mat: String(a.id), nome: a.nome, turmaId: t.id });
            });
            dp = { codcur, disciplina: texto(req.body.dp.nome, 120) || req.body.dp.chave };
        }
        if (dp) { rastreio.disciplina = rastreio.disciplina || dp.disciplina; rastreio.tipo = rastreio.tipo || 'dp'; }
        const ids = dp ? [] : (Array.isArray(req.body.turmas) ? req.body.turmas.slice(0, 30) : []);
        if (!dp && !ids.length) return res.status(400).json({ error: 'Escolha pelo menos uma turma.' });
        const tSnaps = await Promise.all(ids.map(id => db.collection('cad_turmas').doc(String(id)).get()));
        for (const s of tSnaps) {
            if (!s.exists) return res.status(404).json({ error: 'Turma não encontrada. Atualize o CADD.' });
            const t = s.data();
            if (!podeVer(esc, t.codcur)) return res.status(403).json({ error: 'Você só pode usar turmas do seu curso.' });
            turmas.push({ id: t.id, turma: t.turma, curso: t.curso, codcur: t.codcur, semestre: t.semestre });
            (t.alunos || []).slice().sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'))
                .forEach(a => alunos.push({ i: alunos.length, alu: String(a.alu || a.id), mat: String(a.id), nome: a.nome, turmaId: t.id }));
        }
        if (!alunos.length) return res.status(400).json({ error: 'As turmas escolhidas não têm aluno ativo no Edubox. Escolha outra turma ou adicione os alunos depois de criar.' });
        if (alunos.length > 4000) return res.status(400).json({ error: 'Turmas demais numa avaliação só.' });
        // código numérico curto (vai impresso na folha e no código de leitura): contador com transação
        const seqRef = db.collection('config').doc('correcao_seq');
        // o código vai impresso na folha: nunca repete (se o contador for mexido, pula os que já existem)
        let codigo = 0;
        for (let tentativa = 0; tentativa < 20 && !codigo; tentativa++) {
            const n = await db.runTransaction(async (tx) => {
                const s = await tx.get(seqRef);
                const prox = (((s.exists && s.data().ultimo) || 0) % 65535) + 1;
                tx.set(seqRef, { ultimo: prox }, { merge: true });
                return prox;
            });
            const usado = await db.collection(COL).where('codigo', '==', n).limit(1).get();
            if (usado.empty) codigo = n;
        }
        if (!codigo) return res.status(500).json({ error: 'Não foi possível gerar o código da avaliação. Tente de novo.' });
        const valorTotal = Number(req.body.valorTotal) > 0 ? Math.min(100, Number(req.body.valorTotal)) : null;
        const dado = {
            nome, codigo, data: /^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '') ? req.body.data : null,
            nAlt, questoes: limparQuestoes(req.body.questoes), questaoIds: idsDoBanco(limparQuestoes(req.body.questoes)), valorTotal,
            origem: ['bp', 'med'].includes(req.body.origem) ? req.body.origem : 'manual', provaId: texto(req.body.provaId, 60) || null,
            turmas, codcurs: [...new Set(turmas.map(t => t.codcur))], alunos, dp, ...rastreio,
            semestre: turmas.map(t => String(t.semestre || '')).sort().pop() || null,
            criadoPor: req.user.name || req.user.email || '', criadoPorUid: req.user.uid, criadoEm: new Date().toISOString()
        };
        const ref = await db.collection(COL).add(dado);
        res.json({ message: 'Avaliação criada.', id: ref.id });
    } catch (err) {
        console.error('[correcao] criar:', err);
        res.status(500).json({ error: err.message });
    }
});

async function carregar(req, id) {
    const s = await db.collection(COL).doc(String(id)).get();
    if (!s.exists) return { erro: [404, 'Avaliação não encontrada.'] };
    const av = { id: s.id, ...s.data() };
    if (!podeAvaliacao(await escopo(req), av)) return { erro: [403, 'Você não tem acesso a esta avaliação.'] };
    return { av };
}

// GET /api/correcao/avaliacoes/:id — avaliação, alunos e o que já foi lido (com o resultado calculado)
router.get('/avaliacoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const ls = await db.collection(COL_LEIT).where('avaliacaoId', '==', av.id).get();
        const leituras = {};
        ls.forEach(d => { const l = d.data(); leituras[l.i] = { ...l, ...resultado(av, l) }; });
        res.json({ avaliacao: av, leituras, podeEditar: souDono(req, av) });
    } catch (err) {
        console.error('[correcao] abrir:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/correcao/avaliacoes/:id — nome, data, valor e gabarito (as leituras ficam; o resultado é recalculado)
router.put('/avaliacoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        if (!souDono(req, av)) return res.status(403).json({ error: 'Só quem criou (ou a direção) pode alterar a avaliação.' });
        const mud = { editadoEm: new Date().toISOString(), editadoPor: req.user.name || req.user.email || '' };
        if (req.body.nome !== undefined) { mud.nome = texto(req.body.nome, 120); if (!mud.nome) return res.status(400).json({ error: 'Informe o nome.' }); }
        if (req.body.data !== undefined) mud.data = /^\d{4}-\d{2}-\d{2}$/.test(req.body.data || '') ? req.body.data : null;
        Object.assign(mud, camposRastreio(req.body));
        if (req.body.disciplina !== undefined && !mud.disciplina) return res.status(400).json({ error: 'Informe a disciplina.' });
        if (req.body.aceitarDupla !== undefined) mud.aceitarDupla = !!req.body.aceitarDupla;
        if (req.body.valorTotal !== undefined) mud.valorTotal = Number(req.body.valorTotal) > 0 ? Math.min(100, Number(req.body.valorTotal)) : null;
        if (req.body.questoes !== undefined) {
            // o número de questões não muda depois de criada: as folhas já foram impressas com essa quantidade
            if (!Array.isArray(req.body.questoes) || req.body.questoes.length !== av.questoes.length) return res.status(400).json({ error: 'O número de questões não pode mudar depois de criada (as folhas já saíram com essa quantidade).' });
            const e = validarQuestoes(req.body.questoes, av.nAlt); if (e) return res.status(400).json({ error: e });
            mud.questoes = limparQuestoes(req.body.questoes.map((q, i) => ({ ...q, q: q.q || (av.questoes[i] || {}).q })));
            mud.questaoIds = idsDoBanco(mud.questoes);
        }
        await db.collection(COL).doc(av.id).update(mud);
        res.json({ message: 'Avaliação atualizada.' });
    } catch (err) {
        console.error('[correcao] editar:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/correcao/avaliacoes/:id — apaga a avaliação e as leituras
router.delete('/avaliacoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        if (!souDono(req, av)) return res.status(403).json({ error: 'Só quem criou (ou a direção) pode excluir a avaliação.' });
        const ls = await db.collection(COL_LEIT).where('avaliacaoId', '==', av.id).get();
        for (let i = 0; i < ls.docs.length; i += 400) {
            const b = db.batch(); ls.docs.slice(i, i + 400).forEach(d => b.delete(d.ref)); await b.commit();
        }
        await db.collection(COL).doc(av.id).delete();
        res.json({ message: 'Avaliação excluída.' });
    } catch (err) {
        console.error('[correcao] excluir:', err);
        res.status(500).json({ error: err.message });
    }
});

// ---------- aluno que faltou na lista (14/10/2026) ----------
// GET /api/correcao/avaliacoes/:id/buscar-aluno?q=nome — procura nas turmas do curso (Edubox, via CADD)
router.get('/avaliacoes/:id/buscar-aluno', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const q = normNome(req.query.q);
        if (q.length < 3) return res.json({ alunos: [] });
        const ja = new Set(av.alunos.map(a => String(a.alu)));
        const achados = [];
        for (const codcur of av.codcurs || []) {
            const ts = await turmasDoCurso(codcur);
            ts.forEach(t => (t.alunos || []).forEach(a => {
                if (normNome(a.nome).includes(q)) achados.push({ alu: String(a.alu || a.id), mat: String(a.id), nome: a.nome, turmaId: t.id, turma: t.turma, jaEsta: ja.has(String(a.alu || a.id)) });
            }));
        }
        const vistos = new Set();
        res.json({ alunos: achados.filter(a => !vistos.has(a.alu) && vistos.add(a.alu)).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).slice(0, 15) });
    } catch (err) {
        console.error('[correcao] buscar aluno:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/correcao/avaliacoes/:id/alunos — { alu?, mat?, nome, turmaId? } inclui um aluno na avaliação
router.post('/avaliacoes/:id/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const nome = texto(req.body.nome, 120).toUpperCase();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        let turma = null;
        if (req.body.turmaId) {
            const t = await db.collection('cad_turmas').doc(String(req.body.turmaId)).get();
            if (t.exists) {
                const d = t.data();
                if (!podeVer(await escopo(req), d.codcur)) return res.status(403).json({ error: 'Essa turma não é do seu curso.' });
                turma = { id: d.id, turma: d.turma, curso: d.curso, codcur: d.codcur, semestre: d.semestre };
            }
        }
        const ref = db.collection(COL).doc(av.id);
        const novo = await db.runTransaction(async (tx) => {
            const s2 = await tx.get(ref);
            const atual = s2.data();
            const alu = texto(req.body.alu, 20);
            if (alu && atual.alunos.some(a => String(a.alu) === alu)) throw Object.assign(new Error('Esse aluno já está na avaliação.'), { status: 400 });
            const i = atual.alunos.reduce((m, a) => Math.max(m, a.i), -1) + 1;
            if (i > 4095) throw Object.assign(new Error('Limite de alunos da avaliação.'), { status: 400 });
            const a = { i, alu: alu || `extra-${i}`, mat: texto(req.body.mat, 20) || '—', nome, turmaId: turma ? turma.id : (atual.turmas[0] || {}).id || '', extra: true,
                adicionadoPor: req.user.name || req.user.email || '', adicionadoEm: new Date().toISOString() };
            const turmas = turma && !atual.turmas.some(t => t.id === turma.id) ? [...atual.turmas, turma] : atual.turmas;
            tx.update(ref, { alunos: [...atual.alunos, a], turmas });
            return { a, turmas };
        });
        res.json({ message: 'Aluno adicionado.', aluno: novo.a, turmas: novo.turmas });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        console.error('[correcao] adicionar aluno:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/correcao/avaliacoes/:id/alunos/:i — tira um aluno ADICIONADO à mão (e a leitura dele)
router.delete('/avaliacoes/:id/alunos/:i', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const i = Number(req.params.i);
        const a = av.alunos.find(x => x.i === i);
        if (!a) return res.status(404).json({ error: 'Aluno não encontrado.' });
        if (!a.extra) return res.status(400).json({ error: 'Só dá para tirar aluno que foi adicionado à mão.' });
        await db.collection(COL).doc(av.id).update({ alunos: av.alunos.filter(x => x.i !== i) });
        await db.collection(COL_LEIT).doc(`${av.id}__${i}`).delete();
        res.json({ message: 'Aluno retirado.' });
    } catch (err) {
        console.error('[correcao] tirar aluno:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/correcao/avaliacoes/:id/leituras/:i — grava as respostas lidas (câmera) ou corrigidas à mão
router.put('/avaliacoes/:id/leituras/:i', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const i = Number(req.params.i);
        const aluno = av.alunos.find(a => a.i === i);
        if (!aluno) return res.status(404).json({ error: 'Aluno não está nesta avaliação.' });
        const validas = LETRAS.slice(0, av.nAlt);
        const r = Array.isArray(req.body.respostas) ? req.body.respostas : [];
        if (r.length !== av.questoes.length) return res.status(400).json({ error: 'Número de respostas diferente do número de questões.' });
        const respostas = r.map(x => { const v = String(x || '').toUpperCase(); return v === '*' ? '*' : (validas.includes(v) && v.length === 1 ? v : ''); });
        const duplas = {};
        Object.entries(req.body.duplas || {}).forEach(([k, v]) => { const n = Number(k); const letras = [...new Set(String(v).toUpperCase().split('').filter(x => validas.includes(x)))].sort().join(''); if (respostas[n] === '*' && letras.length > 1) duplas[n] = letras; });
        const duvidosas = (Array.isArray(req.body.duvidosas) ? req.body.duvidosas : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < av.questoes.length);
        const ref = db.collection(COL_LEIT).doc(`${av.id}__${i}`);
        const antes = await ref.get();
        const consideradas = antes.exists ? (antes.data().consideradas || {}) : {};
        const dado = {
            avaliacaoId: av.id, i, respostas, duplas, duvidosas: req.body.origem === 'manual' ? [] : duvidosas, consideradas,
            origem: req.body.origem === 'manual' ? 'manual' : 'camera',
            lidoPor: req.user.name || req.user.email || '', lidoPorUid: req.user.uid, lidoEm: new Date().toISOString(),
            ...(antes.exists ? { leituraAnteriorEm: antes.data().lidoEm || null } : {})
        };
        await ref.set(dado);
        res.json({ message: 'Folha registrada.', substituiu: antes.exists, leitura: { ...dado, ...resultado(av, dado) } });
    } catch (err) {
        console.error('[correcao] leitura:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/correcao/avaliacoes/:id/leituras/:i/considerar — { questao (0..n-1), certa: true|false }
// O coordenador decide contar como certa uma questão que não contou para o aluno (duas marcações,
// em branco, errada…). Fica registrado quem e quando; certa:false desfaz.
router.put('/avaliacoes/:id/leituras/:i/considerar', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const k = Number(req.body.questao);
        if (!Number.isInteger(k) || k < 0 || k >= av.questoes.length) return res.status(400).json({ error: 'Questão inválida.' });
        const ref = db.collection(COL_LEIT).doc(`${av.id}__${Number(req.params.i)}`);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Leia ou lance a folha deste aluno antes.' });
        const l = s.data();
        const consideradas = { ...(l.consideradas || {}) };
        if (req.body.certa) consideradas[k] = { por: req.user.name || req.user.email || '', em: new Date().toISOString() };
        else delete consideradas[k];
        await ref.update({ consideradas });
        const nova = { ...l, consideradas };
        res.json({ message: req.body.certa ? 'Questão considerada certa para o aluno.' : 'Desfeito.', leitura: { ...nova, ...resultado(av, nova) } });
    } catch (err) {
        console.error('[correcao] considerar:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/correcao/avaliacoes/:id/leituras/:i — desfaz a leitura de um aluno (para ler de novo)
router.delete('/avaliacoes/:id/leituras/:i', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        await db.collection(COL_LEIT).doc(`${av.id}__${Number(req.params.i)}`).delete();
        res.json({ message: 'Leitura apagada.' });
    } catch (err) {
        console.error('[correcao] apagar leitura:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/correcao/avaliacoes/:id/planilha — resultado em .xlsx (para lançar no Edubox)
router.get('/avaliacoes/:id/planilha', verifyToken, checkPermission, async (req, res) => {
    try {
        const { av, erro } = await carregar(req, req.params.id);
        if (erro) return res.status(erro[0]).json({ error: erro[1] });
        const XLSX = require('xlsx');
        const ls = await db.collection(COL_LEIT).where('avaliacaoId', '==', av.id).get();
        const leit = {}; ls.forEach(d => { leit[d.data().i] = d.data(); });
        const discs = [...new Set(av.questoes.map(q => q.d || ''))].filter(Boolean);
        const turmaNome = Object.fromEntries(av.turmas.map(t => [t.id, t.turma]));
        const linhas = av.alunos.map(a => {
            const l = leit[a.i];
            const r = l ? resultado(av, l) : null;
            const lin = { Turma: turmaNome[a.turmaId] || '', Matrícula: a.mat, Aluno: a.nome, Situação: l ? 'Corrigida' : 'Sem folha lida', Acertos: r ? r.acertos : '', Questões: av.questoes.length, '% de acerto': r ? Math.round(r.acertos / r.total * 1000) / 10 : '' };
            if (av.valorTotal) lin[`Nota (de ${String(av.valorTotal).replace('.', ',')})`] = r ? r.nota : '';
            discs.forEach(d => { lin[d] = r && r.porDisc[d] ? `${r.porDisc[d].acertos}/${r.porDisc[d].total}` : ''; });
            av.questoes.forEach((q, k) => { lin[`Q${k + 1}`] = l ? (l.respostas[k] === '*' ? `dupla (${String((l.duplas || {})[k] || '').split('').join('+') || '?'})` : l.respostas[k] || '') + (l.consideradas && l.consideradas[k] ? ' *' : '') : ''; });
            lin['Consideradas certas pelo coordenador'] = l && l.consideradas ? Object.keys(l.consideradas).map(k => Number(k) + 1).sort((a, b) => a - b).join(', ') : '';
            return lin;
        });
        const legenda = { Turma: av.aceitarDupla ? 'Dupla marcação contou como certa quando uma das marcadas era a certa.' : '', Matrícula: '', Aluno: '* = questão considerada certa pelo coordenador' };
        const gab = { Turma: 'GABARITO', Matrícula: '', Aluno: '' };
        av.questoes.forEach((q, k) => { gab[`Q${k + 1}`] = q.g === 'X' ? 'anulada' : q.g; });
        const ws = XLSX.utils.json_to_sheet([...linhas, {}, gab, legenda]);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Resultado');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${av.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9 ._-]/g, '')}.xlsx"`);
        res.send(buf);
    } catch (err) {
        console.error('[correcao] planilha:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports._interno = { resultado, acertou, CODCUR, propagarGabarito, gabaritoMed };
