const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================================================
// Financeiro Medicina — 18/11/2026. Substitui a planilha "PLANILHA REMATRÍCULA" do Financeiro (Lisa), uma aba por
// turma e semestre (T1 6º, T2 5º, T3 3º, T4 1º em 2027.1). Serve pra calcular os valores que o Financeiro lança
// no Edubox na rematrícula — o Edubox NÃO tem esse cálculo de acordo/reajuste, e este módulo NÃO grava no Edubox.
//   - Turma: semestre, período, ingresso, valor integral da mensalidade e as COLUNAS DE SALDO da turma (cada
//     turma tem as suas: "Saldo reajustado 1º e 2º", "Saldo devedor 5º sem. 2026.2"…). Coluna com entraNoTotal
//     soma no "a receber"; as outras são histórico (originais).
//   - Aluno: contrato mãe (integral com o desconto de pontualidade), % de desconto, valor mensal que PAGA
//     (acordo com o Fábio), quitação, saldos por coluna, categoria (Pravaler, ProUni, quitou…) e observação.
//   - Saldo do semestre (calculado): (contrato mãe − mensal) × 6, a mesma conta da planilha.
//   - Reajuste por turma: % na parcela (integral, contrato mãe e mensal) e % nos saldos escolhidos — prévia e,
//     só depois, confirmar (fica no histórico da turma).
// Coleções: fin_med_turmas/{semestre__turma} · fin_med_alunos/{auto}
// Acesso: SÓ Lisa e Fábio Costa (USUARIOS_PERMITIDOS, abaixo).
// ==========================================================================
// 18/11/2026 (pedido do usuário): SÓ a Lisa (Financeiro) e o Fábio Costa (direção) veem este módulo — ninguém mais,
// nem outros ADM N1 ou o resto do Financeiro. Incluir alguém só quando pedirem: acrescentar o uid aqui E em
// core/permissions.js (MODULES['financeiro-medicina'].somenteUsuarios).
const USUARIOS_PERMITIDOS = [
    'A6gsjqRTwdeAy29KVxcHJg2jYNy2', // LISA MARIE (Financeiro)
    'EtrSfFo1FCYD6ZZOFQ6AL25axWX2'  // FABIO COSTA (direção)
];
// Só VER (sem editar), a pedido (18/11/2026): Paulo Henrique (Suporte AVA). Também precisa estar em somenteUsuarios.
const USUARIOS_SO_VER = [
    'rhQ6fe4HQfMOCCejry1sPx0hA1v1' // Paulo henrique (Suporte AVA) — só leitura
];
const somentePermitidos = (req, res, next) => (USUARIOS_PERMITIDOS.includes(req.user && req.user.uid)
    || (USUARIOS_SO_VER.includes(req.user && req.user.uid) && req.method === 'GET')
    ? next() : res.status(403).json({ error: USUARIOS_SO_VER.includes(req.user && req.user.uid) ? 'Seu acesso ao Financeiro da Medicina é só de leitura.' : 'Acesso restrito: só a Lisa e o Fábio veem o Financeiro da Medicina.' }));
const checkPermission = [verifyToken.requireModulePermission('financeiro-medicina'), somentePermitidos];
const COL_T = 'fin_med_turmas';
const COL_A = 'fin_med_alunos';
const SEMESTRE = /^\d{4}\.[12]$/;
const MESES_SEMESTRE = 6;
const CATEGORIAS = ['', 'pravaler', 'prouni50', 'prouni100', 'prouni50-pravaler', 'quitou', 'vai-quitar', 'inadimplente', 'pendente-fabio'];

const texto = (v, max = 200) => (v ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const agora = () => new Date().toISOString();
const quemFez = (req) => req.user.name || req.user.email || '';
const idTurma = (semestre, turma) => `${semestre}__${turma}`;
const podeEditar = (req) => USUARIOS_PERMITIDOS.includes(req.user.uid); // os dois editam (a rota já barra os outros)
const soEditor = (req, res) => { if (podeEditar(req)) return true; res.status(403).json({ error: 'Só o Financeiro altera esta página.' }); return false; };

// cálculos do aluno (iguais à planilha)
function calcular(a, turma) {
    const cm = Number(a.contratoMae) || 0, mensal = Number(a.mensal) || 0;
    const difMes = mensal > 0 && cm > mensal ? Math.round((cm - mensal) * 100) / 100 : 0;
    const saldoSemestre = Math.round(difMes * MESES_SEMESTRE * 100) / 100;
    const colsTotal = (turma.colunas || []).filter(c => c.entraNoTotal).map(c => c.id);
    const saldosAnteriores = colsTotal.reduce((s, id) => s + (Number((a.saldos || {})[id]) || 0), 0);
    return { difMes, saldoSemestre, saldosAnteriores: Math.round(saldosAnteriores * 100) / 100, totalReceber: Math.round((saldosAnteriores + saldoSemestre) * 100) / 100 };
}
function totaisDa(turma, alunos) {
    const t = { alunos: alunos.length, mensal: 0, contratoMae: 0, saldoSemestre: 0, saldosAnteriores: 0, totalReceber: 0, comSaldo: 0, porColuna: {} };
    alunos.forEach(a => {
        const c = calcular(a, turma);
        t.mensal += Number(a.mensal) || 0; t.contratoMae += Number(a.contratoMae) || 0;
        t.saldoSemestre += c.saldoSemestre; t.saldosAnteriores += c.saldosAnteriores; t.totalReceber += c.totalReceber;
        if (c.totalReceber > 0) t.comSaldo++;
        (turma.colunas || []).forEach(col => { t.porColuna[col.id] = (t.porColuna[col.id] || 0) + (Number((a.saldos || {})[col.id]) || 0); });
    });
    Object.keys(t).forEach(k => { if (typeof t[k] === 'number') t[k] = Math.round(t[k] * 100) / 100; });
    Object.keys(t.porColuna).forEach(k => { t.porColuna[k] = Math.round(t.porColuna[k] * 100) / 100; });
    return t;
}

async function turmaOu404(id, res) {
    const s = await db.collection(COL_T).doc(String(id)).get();
    if (!s.exists) { res.status(404).json({ error: 'Turma não encontrada.' }); return null; }
    return { ref: s.ref, id: s.id, ...s.data() };
}
async function alunosDa(turmaId) {
    const s = await db.collection(COL_A).where('turmaId', '==', turmaId).get();
    return s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.ordem ?? 9999) - (b.ordem ?? 9999) || a.nome.localeCompare(b.nome, 'pt-BR'));
}

// ---------------- semestres e resumo ----------------
router.get('/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const s = await db.collection(COL_T).get();
        const lista = [...new Set(s.docs.map(d => d.data().semestre))].filter(x => SEMESTRE.test(x)).sort().reverse();
        res.json(lista.length ? lista : ['2027.1']);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /resumo?semestre= — turmas do semestre com os totais (o "quanto tenho a receber" do Fábio)
router.get('/resumo', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [tSnap, aSnap] = await Promise.all([db.collection(COL_T).where('semestre', '==', semestre).get(), db.collection(COL_A).where('semestre', '==', semestre).get()]);
        const alunos = aSnap.docs.map(d => d.data());
        const turmas = tSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.turma.localeCompare(b.turma, 'pt-BR', { numeric: true }))
            .map(t => ({ ...t, totais: totaisDa(t, alunos.filter(a => a.turmaId === t.id)) }));
        const geral = turmas.reduce((g, t) => { ['alunos', 'mensal', 'saldoSemestre', 'saldosAnteriores', 'totalReceber', 'comSaldo'].forEach(k => { g[k] = Math.round(((g[k] || 0) + t.totais[k]) * 100) / 100; }); return g; }, {});
        res.json({ semestre, turmas, geral, podeEditar: podeEditar({ ...req, method: 'PUT' }), categorias: CATEGORIAS });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------- turmas ----------------
router.get('/turmas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const t = await turmaOu404(req.params.id, res); if (!t) return;
        const alunos = await alunosDa(t.id);
        const { ref, ...turma } = t;
        res.json({ turma, alunos: alunos.map(a => ({ ...a, calc: calcular(a, turma) })), totais: totaisDa(turma, alunos), podeEditar: podeEditar({ ...req, method: 'PUT' }), categorias: CATEGORIAS });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/turmas', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        const b = req.body || {};
        const semestre = texto(b.semestre, 6), turma = texto(b.turma, 10).toUpperCase();
        if (!SEMESTRE.test(semestre) || !/^T\d{1,2}$/.test(turma)) return res.status(400).json({ error: 'Informe o semestre e a turma (ex.: T4).' });
        const id = idTurma(semestre, turma);
        const ref = db.collection(COL_T).doc(id);
        if ((await ref.get()).exists) return res.status(400).json({ error: 'Essa turma já existe neste semestre.' });
        const dados = { semestre, turma, periodo: texto(b.periodo, 10), ingresso: texto(b.ingresso, 10), integral: num(b.integral), colunas: [], historicoReajustes: [], createdAt: agora(), createdBy: quemFez(req) };
        // copiar as colunas de saldo (e, se pedido, os alunos) da mesma turma no semestre anterior
        if (b.copiarDe) {
            const origem = await db.collection(COL_T).doc(String(b.copiarDe)).get();
            if (origem.exists) dados.colunas = (origem.data().colunas || []).map(c => ({ ...c }));
        }
        await ref.set(dados);
        let copiados = 0;
        if (b.copiarDe && b.copiarAlunos) {
            const alunos = await alunosDa(String(b.copiarDe));
            for (let i = 0; i < alunos.length; i += 400) {
                const batch = db.batch();
                alunos.slice(i, i + 400).forEach(a => { const { id: _i, calc, ...resto } = a; batch.set(db.collection(COL_A).doc(), { ...resto, semestre, turma, turmaId: id, quitou: null, descQuitacao: null, createdAt: agora(), createdBy: quemFez(req), updatedAt: agora() }); copiados++; });
                await batch.commit();
            }
        }
        res.status(201).json({ id, ...dados, copiados });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/turmas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        const t = await turmaOu404(req.params.id, res); if (!t) return;
        const b = req.body || {};
        const upd = { updatedAt: agora(), updatedBy: quemFez(req) };
        if (b.periodo !== undefined) upd.periodo = texto(b.periodo, 10);
        if (b.ingresso !== undefined) upd.ingresso = texto(b.ingresso, 10);
        if (b.integral !== undefined) upd.integral = num(b.integral);
        if (b.colunas !== undefined) {
            if (!Array.isArray(b.colunas)) return res.status(400).json({ error: 'Colunas inválidas.' });
            upd.colunas = b.colunas.map((c, i) => ({ id: texto(c.id, 40) || `c${Date.now()}${i}`, rotulo: texto(c.rotulo, 80) || 'Saldo', entraNoTotal: !!c.entraNoTotal })).slice(0, 30);
        }
        await t.ref.update(upd);
        res.json({ ok: true, ...upd });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------- alunos ----------------
function dadosAluno(b, turma, parcial) {
    const d = {};
    if (!parcial || b.nome !== undefined) { d.nome = texto(b.nome, 150).toUpperCase(); d.nomeNorm = norm(d.nome); }
    ['contratoMae', 'descontoPct', 'mensal', 'quitou', 'descQuitacao'].forEach(k => { if (b[k] !== undefined) d[k] = num(b[k]); });
    if (b.categoria !== undefined) { if (!CATEGORIAS.includes(b.categoria)) { const e = new Error('Categoria inválida.'); e.status = 400; throw e; } d.categoria = b.categoria; }
    if (b.obs !== undefined) d.obs = texto(b.obs, 2000);
    if (b.saldos !== undefined && b.saldos && typeof b.saldos === 'object') {
        const ids = new Set((turma.colunas || []).map(c => c.id));
        d.saldos = {};
        Object.entries(b.saldos).forEach(([k, v]) => { if (ids.has(k)) { const n = num(v); if (n !== null) d.saldos[k] = n; } });
    }
    return d;
}
router.post('/alunos', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        const t = await turmaOu404((req.body || {}).turmaId, res); if (!t) return;
        const d = dadosAluno(req.body || {}, t, false);
        if (!d.nome) return res.status(400).json({ error: 'Informe o nome do aluno.' });
        const ja = await db.collection(COL_A).where('turmaId', '==', t.id).where('nomeNorm', '==', d.nomeNorm).limit(1).get();
        if (!ja.empty) return res.status(400).json({ error: 'Esse aluno já está nesta turma.' });
        const dados = { semestre: t.semestre, turma: t.turma, turmaId: t.id, saldos: {}, categoria: '', ...d, createdAt: agora(), createdBy: quemFez(req), updatedAt: agora() };
        const ref = await db.collection(COL_A).add(dados);
        res.status(201).json({ id: ref.id, ...dados, calc: calcular(dados, t) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.put('/alunos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        const ref = db.collection(COL_A).doc(req.params.id);
        const s = await ref.get();
        if (!s.exists) return res.status(404).json({ error: 'Aluno não encontrado.' });
        const t = await turmaOu404(s.data().turmaId, res); if (!t) return;
        const d = dadosAluno(req.body || {}, t, true);
        if (d.saldos) d.saldos = { ...(s.data().saldos || {}), ...d.saldos, ...Object.fromEntries(Object.entries(req.body.saldos).filter(([, v]) => v === '' || v === null).map(([k]) => [k, null])) };
        if (d.saldos) Object.keys(d.saldos).forEach(k => { if (d.saldos[k] === null) delete d.saldos[k]; });
        const upd = { ...d, updatedAt: agora(), updatedBy: quemFez(req) };
        await ref.update(upd);
        const final = { ...s.data(), ...upd };
        res.json({ id: s.id, ...final, calc: calcular(final, t) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.delete('/alunos/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        await db.collection(COL_A).doc(req.params.id).delete();
        res.json({ message: 'Aluno retirado da turma.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------- reajuste ----------------
// POST /turmas/:id/reajuste { pctParcela, pctSaldo, colunasSaldo:[ids], ajustarMensal, ajustarIntegral, aplicar }
// pctParcela: contrato mãe, (se ajustarMensal) o mensal de quem paga e (se ajustarIntegral) o valor integral da turma —
// a planilha às vezes já traz o integral reajustado no título, por isso é opcional. pctSaldo: em cada coluna escolhida.
// Arredonda em centavos. aplicar=false devolve a prévia.
router.post('/turmas/:id/reajuste', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        const t = await turmaOu404(req.params.id, res); if (!t) return;
        const b = req.body || {};
        const pP = num(b.pctParcela) || 0, pS = num(b.pctSaldo) || 0;
        if (pP < 0 || pP > 50 || pS < 0 || pS > 50) return res.status(400).json({ error: 'Informe percentuais entre 0 e 50.' });
        const cols = (Array.isArray(b.colunasSaldo) ? b.colunasSaldo : []).filter(id => (t.colunas || []).some(c => c.id === id));
        if (!pP && !(pS && cols.length)) return res.status(400).json({ error: 'Informe o % da parcela e/ou o % do saldo (com as colunas).' });
        const fP = 1 + pP / 100, fS = 1 + pS / 100;
        const r2 = (v) => Math.round(v * 100) / 100;
        const alunos = await alunosDa(t.id);
        const previa = alunos.map(a => {
            const novo = {};
            if (pP) {
                if (a.contratoMae) novo.contratoMae = r2(a.contratoMae * fP);
                if (b.ajustarMensal !== false && a.mensal) novo.mensal = r2(a.mensal * fP);
            }
            if (pS && cols.length) {
                const s = { ...(a.saldos || {}) };
                cols.forEach(id => { if (Number(s[id])) s[id] = r2(Number(s[id]) * fS); });
                novo.saldos = s;
            }
            const antes = calcular(a, t), depois = calcular({ ...a, ...novo }, t);
            return { id: a.id, nome: a.nome, contratoMae: [a.contratoMae, novo.contratoMae ?? a.contratoMae], mensal: [a.mensal, novo.mensal ?? a.mensal], totalReceber: [antes.totalReceber, depois.totalReceber], novo };
        });
        const resumo = { integral: [t.integral, pP && t.integral && b.ajustarIntegral ? r2(t.integral * fP) : t.integral], totalReceber: [r2(previa.reduce((s, p) => s + p.totalReceber[0], 0)), r2(previa.reduce((s, p) => s + p.totalReceber[1], 0))] };
        if (!b.aplicar) return res.json({ previa: previa.map(({ novo, ...p }) => p), resumo });
        for (let i = 0; i < previa.length; i += 400) {
            const batch = db.batch();
            previa.slice(i, i + 400).forEach(p => { if (Object.keys(p.novo).length) batch.update(db.collection(COL_A).doc(p.id), { ...p.novo, updatedAt: agora(), updatedBy: `${quemFez(req)} (reajuste)` }); });
            await batch.commit();
        }
        const hist = { em: agora(), por: quemFez(req), pctParcela: pP, pctSaldo: pS, colunas: cols.map(id => (t.colunas.find(c => c.id === id) || {}).rotulo), ajustarMensal: b.ajustarMensal !== false, ajustarIntegral: !!b.ajustarIntegral, integralAntes: t.integral, integralDepois: resumo.integral[1] };
        await t.ref.update({ integral: resumo.integral[1], historicoReajustes: [...(t.historicoReajustes || []), hist], updatedAt: agora(), updatedBy: quemFez(req) });
        res.json({ ok: true, resumo, message: `Reajuste aplicado em ${previa.length} aluno(s).` });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ---------------- trazer alunos das Matrículas ----------------
// POST /turmas/:id/trazer-matriculas { aplicar } — Medicina do semestre, no período da turma. Quem não está na turma entra
// (só o nome; valores ficam pro Financeiro). Devolve também quem está na turma e não está nas Matrículas.
router.post('/turmas/:id/trazer-matriculas', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soEditor(req, res)) return;
        const t = await turmaOu404(req.params.id, res); if (!t) return;
        if (!t.periodo) return res.status(400).json({ error: 'Informe o período da turma antes (ex.: 6º).' });
        const [mSnap, alunos] = await Promise.all([
            db.collection('matriculas_alunos').where('modulo', '==', 'medicina').where('semestre', '==', t.semestre).get(),
            alunosDa(t.id)
        ]);
        const doPeriodo = mSnap.docs.map(d => d.data()).filter(m => m.periodo === t.periodo && !/^(Cancelou|Trancou|1ª Evasão|2ª Evasão|Transferência|Desistente)/.test(m.situacao || ''));
        // mesmo aluno com o nome escrito diferente (abreviação, letra dobrada): usa a comparação dos Contratos
        const { nomeParecido } = require('./contratos')._interno;
        const mesmo = (x, y) => norm(x) === norm(y) || nomeParecido(x, y);
        const faltam = doPeriodo.filter(m => !alunos.some(a => mesmo(a.nome, m.nome))).map(m => ({ nome: String(m.nome).toUpperCase().trim(), situacao: m.situacao }));
        const soNaTurma = alunos.filter(a => !doPeriodo.some(m => mesmo(a.nome, m.nome))).map(a => a.nome);
        if (!req.body.aplicar) return res.json({ faltam, soNaTurma, matriculas: doPeriodo.length });
        const batch = db.batch();
        faltam.slice(0, 450).forEach(f => batch.set(db.collection(COL_A).doc(), { semestre: t.semestre, turma: t.turma, turmaId: t.id, nome: f.nome, nomeNorm: norm(f.nome), saldos: {}, categoria: '', obs: '', createdAt: agora(), createdBy: `${quemFez(req)} (Matrículas)`, updatedAt: agora() }));
        await batch.commit();
        res.json({ ok: true, incluidos: faltam.length, message: `${faltam.length} aluno(s) incluído(s) a partir das Matrículas.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports._interno = { calcular, totaisDa, CATEGORIAS, norm, idTurma, USUARIOS_PERMITIDOS };
