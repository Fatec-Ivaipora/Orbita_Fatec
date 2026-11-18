const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================================================
// Aulas EAD (Gestão de T.I.) — 18/11/2026. Junta numa página o que o T.I controlava em várias planilhas:
//   1. Salas Zoom: as contas/salas fixas da instituição (AULA 30..44, EAD-1/EAD-2) com link e senhas.
//      As salas de setor (NAPED Medicina, Coordenação EAD, Suporte AVA, Direção Acadêmica) ficam marcadas
//      como "fixa" e não entram na distribuição. Importadas da "LISTAGEM LINKS ZOOM" (.xlsx, uma aba por dia).
//   2. Disciplinas EAD do semestre por curso: período, carga horária, dia, horário e professor que DÁ a aula.
//      Importadas da planilha "DISCIPLINAS EaD <semestre> LEVANTAMENTO" (.xlsx). Não confundir com o
//      professor que CRIA a disciplina (Automação AVA).
//   3. Sala de cada professor no semestre: regra do T.I = o mesmo link em todos os dias em que o professor dá
//      aula. "Distribuir" escolhe, pra quem não tem, uma sala livre em TODOS os dias dele.
//      Ocupações avulsas por dia (síncrona mediada, reserva) ficam em `ocupacoes`.
//   4. Gravações: cada UA (12 nas de 60/80 h: 6 por bimestre; 6 nas de 30/40 h: 3 por bimestre) e a revisão
//      de cada bimestre passam por Gravou (professor) → Baixou → YouTube → AVA (T.I). Quem marca é o T.I.
//      O relatório do dia (texto) vai para o coordenador EAD, que não tem acesso à página.
// Coleções: ead_aulas_salas/{id} · ead_aulas_disc/{semestre__curso__disciplina__periodo} · ead_aulas_semestre/{semestre}
// ==========================================================================
const checkPermission = verifyToken.requireModulePermission('ead-aulas');
const COL_SALAS = 'ead_aulas_salas';
const COL_DISC = 'ead_aulas_disc';
const COL_SEM = 'ead_aulas_semestre';
const SEMESTRE = /^\d{4}\.[12]$/;
const DIAS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
const ETAPAS = ['gravou', 'baixou', 'youtube', 'ava'];

const texto = (v, max = 200) => (v ?? '').toString().replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const slug = (s) => norm(s).toLowerCase().replace(/ /g, '-').slice(0, 80) || 'x';
const agora = () => new Date().toISOString();
const quemFez = (req) => req.user.name || req.user.email || '';
const PALAVRAS_VAZIAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'A', 'O', 'AS', 'OS', 'NA', 'NO', 'NAS', 'NOS']);
const chaveNome = (s) => norm(String(s || '').replace(/\(\s*QUINZENAL\s*\)/i, '')).split(' ').filter(w => w && !PALAVRAS_VAZIAS.has(w)).map(w => (w.length > 3 ? w.replace(/S$/, '') : w)).join(' ');
const diaDe = (s) => { const n = norm(s); return n.startsWith('SEG') ? 'segunda' : n.startsWith('TER') ? 'terca' : n.startsWith('QUA') ? 'quarta' : n.startsWith('QUI') ? 'quinta' : n.startsWith('SEX') ? 'sexta' : n.startsWith('SAB') ? 'sabado' : ''; };
const qtdPorCh = (ch) => ((Number(ch) || 0) >= 60 ? 12 : 6);
const numTxt = (v) => (typeof v === 'number' ? String(Math.round(v)) : texto(v, 40));

const soTi = (req, res) => {
    if (['adm_l1', 'adm_l2', 'ti'].includes(req.user.role) || req.method === 'GET') return true;
    res.status(403).json({ error: 'Só o T.I altera esta página.' }); return false;
};

const CURSO_DA_PLANILHA = [[/AGRONEG/, 'agronegocio', 'Agronegócio'], [/AGRONOMIA/, 'agronomia', 'Agronomia'], [/ARQUITET/, 'arquitetura-urbanismo', 'Arquitetura e Urbanismo'],
    [/BIOMED/, 'biomedicina', 'Biomedicina'], [/CONTA/, 'contabeis', 'Ciências Contábeis'], [/DIREITO/, 'direito', 'Direito'], [/ENFERM/, 'enfermagem', 'Enfermagem'],
    [/ENGENHARIA/, 'engenharia-civil', 'Engenharia Civil'], [/FISIO/, 'fisioterapia', 'Fisioterapia'], [/COMERCIAL/, 'gestao-comercial', 'Gestão Comercial'],
    [/FINANCEIRA/, 'gestao-financeira', 'Gestão Financeira'], [/LOGIST/, 'logistica', 'Logística'], [/VETERIN/, 'medicina-veterinaria', 'Medicina Veterinária'],
    [/^MEDICINA$/, 'medicina', 'Medicina'], [/PEDAGOG/, 'pedagogia', 'Pedagogia'], [/PSICOLOG/, 'psicologia', 'Psicologia'], [/RECURSOS HUMANOS|\bRH\b/, 'rh', 'Recursos Humanos']];
const cursoDe = (s) => { const n = norm(s); const c = CURSO_DA_PLANILHA.find(([re]) => re.test(n)); return c ? { id: c[1], nome: c[2] } : null; };

// itens de gravação da disciplina, na ordem: UA-01..UA-06, REV-1, UA-07..UA-12, REV-2 (ou 3 + 3 nas de 6 UAs)
function itensGravacao(qtd) {
    const meio = qtd / 2, out = [];
    for (let n = 1; n <= qtd; n++) {
        out.push({ id: `UA-${String(n).padStart(2, '0')}`, rotulo: `UA - ${String(n).padStart(2, '0')}`, bimestre: n <= meio ? 1 : 2 });
        if (n === meio) out.push({ id: 'REV-1', rotulo: 'Revisão 1º bim.', bimestre: 1, revisao: true });
    }
    out.push({ id: 'REV-2', rotulo: 'Revisão 2º bim.', bimestre: 2, revisao: true });
    return out;
}

const XLSX = () => require('xlsx');
function linhasDaAba(ws) { return XLSX().utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }); }
function semestreDaCelula(v) {
    if (v instanceof Date && !isNaN(v)) return `${v.getUTCFullYear()}.${v.getUTCMonth() + 1}`; // "2027.1" que virou 01/01/2027
    if (typeof v === 'number') return v.toFixed(1);
    const m = String(v || '').match(/(\d{4})\s*[./-]\s*([12])/);
    return m ? `${m[1]}.${m[2]}` : '';
}
function lerXlsx(base64) {
    const b = String(base64 || '');
    if (!b) { const e = new Error('Envie a planilha (.xlsx).'); e.status = 400; throw e; }
    try { return XLSX().read(Buffer.from(b, 'base64'), { type: 'buffer', cellDates: true }); }
    catch (err) { const e = new Error('Não consegui ler esse arquivo. No Google Planilhas: Arquivo › Fazer download › Microsoft Excel (.xlsx).'); e.status = 400; throw e; }
}

// ------------------------------ Salas Zoom ------------------------------
const FIXAS = /NAPED|SUPORTE AVA|DIRE[CÇ][AÃ]O ACAD|COORDENA[CÇ][AÃ]O EAD/i;
const ordemSala = (s) => { const m = String(s.conta || '').match(/(\d+)/); return (m ? Number(m[1]) : 999) * 10 + (/2\s*$/.test(s.nome) ? 2 : 1); };

function lerPlanilhaZoom(wb) {
    const porLink = new Map();
    wb.SheetNames.forEach(nomeAba => {
        const rows = linhasDaAba(wb.Sheets[nomeAba]);
        const iCab = rows.findIndex(r => r.some(c => /LINK/.test(norm(c))) && r.some(c => /SALA/.test(norm(c))));
        if (iCab < 0) return;
        const cab = rows[iCab].map(norm);
        const col = (re) => cab.findIndex(c => re.test(c));
        const c = { prof: col(/^PROF/), conta: col(/^EMAIL|^CONTA/), nome: col(/SALA/), link: col(/LINK/), senha: col(/^SENHA$/), anf: col(/ANFITRI/) };
        rows.slice(iCab + 1).forEach(r => {
            const link = texto(r[c.link], 400);
            if (!/^https?:\/\//i.test(link)) return;
            const ocupante = texto(r[c.prof], 120);
            const s = porLink.get(link) || { link, conta: texto(r[c.conta], 40), nome: texto(r[c.nome], 80), senha: numTxt(r[c.senha]), senhaAnfitriao: numTxt(r[c.anf]), fixo: '' };
            if (FIXAS.test(ocupante) && !s.fixo) s.fixo = ocupante.replace(/\s+/g, ' ').trim().toUpperCase();
            porLink.set(link, s);
        });
    });
    return [...porLink.values()].sort((a, b) => ordemSala(a) - ordemSala(b));
}

router.get('/salas', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_SALAS).get();
        res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ordemSala(a) - ordemSala(b)));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /salas/importar { arquivoBase64, aplicar } — prévia (aplicar=false) ou grava (atualiza pelo link; não apaga as outras)
router.post('/salas/importar', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const salas = lerPlanilhaZoom(lerXlsx(req.body.arquivoBase64));
        if (!salas.length) return res.status(400).json({ error: 'Não achei salas na planilha (precisa das colunas NOME SALA e LINK ZOOM).' });
        const snap = await db.collection(COL_SALAS).get();
        const existentes = new Map(snap.docs.map(d => [d.data().link, d.id]));
        const previa = salas.map(s => ({ ...s, acao: existentes.has(s.link) ? 'atualizar' : 'nova' }));
        if (!req.body.aplicar) return res.json({ previa });
        const batch = db.batch();
        previa.forEach(s => {
            const ref = existentes.has(s.link) ? db.collection(COL_SALAS).doc(existentes.get(s.link)) : db.collection(COL_SALAS).doc();
            const { acao, ...dados } = s;
            batch.set(ref, { ...dados, updatedAt: agora(), updatedBy: quemFez(req) }, { merge: true });
        });
        await batch.commit();
        res.json({ gravadas: previa.length, message: `${previa.length} sala(s) importada(s).` });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

function salaDoCorpo(b) {
    const s = { conta: texto(b.conta, 40), nome: texto(b.nome, 80), link: texto(b.link, 400), senha: texto(b.senha, 40), senhaAnfitriao: texto(b.senhaAnfitriao, 40), fixo: texto(b.fixo, 80) };
    if (!s.nome || !/^https?:\/\//i.test(s.link)) { const e = new Error('Informe o nome da sala e o link do Zoom (https://...).'); e.status = 400; throw e; }
    return s;
}
router.post('/salas', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const s = salaDoCorpo(req.body || {});
        const ref = await db.collection(COL_SALAS).add({ ...s, createdAt: agora(), createdBy: quemFez(req) });
        res.status(201).json({ id: ref.id, ...s });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.put('/salas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const s = salaDoCorpo(req.body || {});
        const ref = db.collection(COL_SALAS).doc(req.params.id);
        if (!(await ref.get()).exists) return res.status(404).json({ error: 'Sala não encontrada.' });
        await ref.set({ ...s, updatedAt: agora(), updatedBy: quemFez(req) }, { merge: true });
        res.json({ id: req.params.id, ...s });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.delete('/salas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        await db.collection(COL_SALAS).doc(req.params.id).delete();
        res.json({ message: 'Sala excluída.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ------------------------------ Disciplinas do semestre ------------------------------
function lerPlanilhaLevantamento(wb, semestre) {
    const linhas = [];
    wb.SheetNames.forEach(nomeAba => {
        const rows = linhasDaAba(wb.Sheets[nomeAba]);
        const iCab = rows.findIndex(r => r.some(c => norm(c) === 'DISCIPLINA') && r.some(c => norm(c) === 'PROFESSOR'));
        if (iCab < 0) return;
        const cab = rows[iCab].map(norm);
        const col = (re) => cab.findIndex(c => re.test(c));
        const c = { sem: col(/^SEMESTRE/), curso: col(/^CURSO/), per: col(/^PERIODO/), disc: col(/^DISCIPLINA/), ch: col(/^CARGA/), dia: col(/^DIA/), hor: col(/^HORARIO/), prof: col(/^PROFESSOR/) };
        rows.slice(iCab + 1).forEach((r, i) => {
            const nome = texto(r[c.disc], 200);
            if (!nome) return;
            if (c.sem >= 0 && semestreDaCelula(r[c.sem]) !== semestre) return;
            const curso = cursoDe(r[c.curso]);
            const periodo = texto(typeof r[c.per] === 'number' ? String(r[c.per]) : r[c.per], 30);
            linhas.push({
                linha: iCab + i + 2, cursoTxt: texto(r[c.curso], 80), cursoId: curso && curso.id, cursoNome: curso && curso.nome,
                periodo, nome, ch: Number(r[c.ch]) || null, dia: c.dia >= 0 ? diaDe(r[c.dia]) : '', horario: c.hor >= 0 ? texto(r[c.hor], 40) : '',
                professor: c.prof >= 0 ? texto(r[c.prof], 120) : ''
            });
        });
    });
    return linhas;
}
const idDisc = (semestre, cursoId, nome, periodo) => `${semestre}__${cursoId}__${slug(chaveNome(nome))}__${slug(periodo || 'x')}`;

router.get('/semestres', verifyToken, checkPermission, async (req, res) => {
    try {
        const hoje = new Date();
        let ano = hoje.getFullYear(), s = hoje.getMonth() < 6 ? 1 : 2;
        const base = [];
        for (let i = 0; i < 3; i++) { base.push(`${ano}.${s}`); if (s === 1) s = 2; else { s = 1; ano++; } }
        const snap = await db.collection(COL_SEM).get();
        res.json([...new Set([...base, ...snap.docs.map(d => d.id)])].filter(x => SEMESTRE.test(x)).sort());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /?semestre= — tudo da página: disciplinas, salas, sala de cada professor e ocupações avulsas
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const semestre = req.query.semestre;
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const [discSnap, salasSnap, cfgSnap] = await Promise.all([
            db.collection(COL_DISC).where('semestre', '==', semestre).get(),
            db.collection(COL_SALAS).get(),
            db.collection(COL_SEM).doc(semestre).get()
        ]);
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        res.json({
            semestre, dias: DIAS, etapas: ETAPAS,
            disciplinas: discSnap.docs.map(d => { const x = d.data(); return { id: d.id, ...x, itens: itensGravacao(x.qtd || qtdPorCh(x.ch)) }; })
                .sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR') || String(a.periodo).localeCompare(String(b.periodo), 'pt-BR', { numeric: true }) || a.nome.localeCompare(b.nome, 'pt-BR')),
            salas: salasSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ordemSala(a) - ordemSala(b)),
            salaDoProfessor: cfg.salaDoProfessor || {},
            ocupacoes: cfg.ocupacoes || {}
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /disciplinas/importar { semestre, arquivoBase64, aplicar }
// Disciplina nova entra; a que já existe só recebe dia/horário/professor que vierem preenchidos na planilha
// (célula vazia não apaga o que o T.I já tinha posto). Gravações nunca são mexidas pela importação.
router.post('/disciplinas/importar', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const { semestre } = req.body || {};
        if (!SEMESTRE.test(semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const linhas = lerPlanilhaLevantamento(lerXlsx(req.body.arquivoBase64), semestre);
        if (!linhas.length) return res.status(400).json({ error: `Não achei linhas de ${semestre} na planilha (colunas Semestre, Curso, Disciplina, Professor).` });
        const snap = await db.collection(COL_DISC).where('semestre', '==', semestre).get();
        const existentes = new Map(snap.docs.map(d => [d.id, d.data()]));
        const vistos = new Set();
        const previa = [], ignoradas = [];
        linhas.forEach(l => {
            if (!l.cursoId) { ignoradas.push({ ...l, motivo: 'curso não reconhecido' }); return; }
            const id = idDisc(semestre, l.cursoId, l.nome, l.periodo);
            if (vistos.has(id)) { ignoradas.push({ ...l, motivo: 'linha repetida' }); return; }
            vistos.add(id);
            const atual = existentes.get(id);
            const muda = atual ? ['dia', 'horario', 'professor'].filter(k => l[k] && l[k] !== atual[k]) : [];
            previa.push({ id, ...l, acao: !atual ? 'nova' : muda.length ? 'atualizar' : 'igual', muda });
        });
        if (!req.body.aplicar) return res.json({ semestre, previa, ignoradas });
        const gravar = previa.filter(p => p.acao !== 'igual');
        for (let i = 0; i < gravar.length; i += 400) {
            const batch = db.batch();
            gravar.slice(i, i + 400).forEach(p => {
                const ref = db.collection(COL_DISC).doc(p.id);
                if (p.acao === 'nova') {
                    batch.set(ref, { semestre, cursoId: p.cursoId, cursoNome: p.cursoNome, periodo: p.periodo, nome: p.nome, ch: p.ch, qtd: qtdPorCh(p.ch),
                        dia: p.dia, horario: p.horario, professor: p.professor, gravacoes: {}, createdAt: agora(), createdBy: `${quemFez(req)} (planilha)` });
                } else {
                    const upd = { updatedAt: agora(), updatedBy: `${quemFez(req)} (planilha)` };
                    p.muda.forEach(k => { upd[k] = p[k]; });
                    batch.set(ref, upd, { merge: true });
                }
            });
            await batch.commit();
        }
        await db.collection(COL_SEM).doc(semestre).set({ semestre, atualizadoEm: agora() }, { merge: true });
        res.json({ gravadas: gravar.length, message: `${gravar.length} disciplina(s) gravada(s).` });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

function discDoCorpo(b, parcial) {
    const d = {};
    if (!parcial || b.nome !== undefined) d.nome = texto(b.nome, 200);
    if (!parcial || b.periodo !== undefined) d.periodo = texto(b.periodo, 30);
    if (b.ch !== undefined) d.ch = Number(b.ch) || null;
    if (b.qtd !== undefined) { if (![6, 12].includes(Number(b.qtd))) { const e = new Error('A disciplina tem 6 ou 12 UAs.'); e.status = 400; throw e; } d.qtd = Number(b.qtd); }
    if (b.dia !== undefined) { if (b.dia && !DIAS.includes(b.dia)) { const e = new Error('Dia inválido.'); e.status = 400; throw e; } d.dia = b.dia || ''; }
    if (b.horario !== undefined) d.horario = texto(b.horario, 40);
    if (b.professor !== undefined) d.professor = texto(b.professor, 120);
    if (b.obs !== undefined) d.obs = texto(b.obs, 600);
    return d;
}
router.post('/disciplinas', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const b = req.body || {};
        if (!SEMESTRE.test(b.semestre || '')) return res.status(400).json({ error: 'Escolha o semestre.' });
        const curso = CURSO_DA_PLANILHA.find(c => c[1] === b.cursoId);
        if (!curso) return res.status(400).json({ error: 'Escolha o curso.' });
        const d = discDoCorpo(b, false);
        if (!d.nome) return res.status(400).json({ error: 'Informe a disciplina.' });
        const id = idDisc(b.semestre, curso[1], d.nome, d.periodo);
        const ref = db.collection(COL_DISC).doc(id);
        if ((await ref.get()).exists) return res.status(400).json({ error: 'Essa disciplina já está cadastrada neste curso e período.' });
        const dados = { semestre: b.semestre, cursoId: curso[1], cursoNome: curso[2], qtd: d.qtd || qtdPorCh(d.ch), gravacoes: {}, ...d, createdAt: agora(), createdBy: quemFez(req) };
        await ref.set(dados);
        await db.collection(COL_SEM).doc(b.semestre).set({ semestre: b.semestre }, { merge: true });
        res.status(201).json({ id, ...dados, itens: itensGravacao(dados.qtd) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.put('/disciplinas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const ref = db.collection(COL_DISC).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const d = discDoCorpo(req.body || {}, true);
        await ref.set({ ...d, updatedAt: agora(), updatedBy: quemFez(req) }, { merge: true });
        const final = { ...snap.data(), ...d };
        res.json({ id: snap.id, ...final, itens: itensGravacao(final.qtd || qtdPorCh(final.ch)) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.delete('/disciplinas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        await db.collection(COL_DISC).doc(req.params.id).delete();
        res.json({ message: 'Disciplina excluída.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /disciplinas/:id/gravacao { item:'UA-01'|'REV-1', etapa:'gravou'|'baixou'|'youtube'|'ava', feito }
// Marcar uma etapa marca as anteriores (não dá pra subir no YouTube o que não foi gravado); desmarcar
// desmarca as seguintes.
router.patch('/disciplinas/:id/gravacao', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const ref = db.collection(COL_DISC).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const d = snap.data();
        const { item, etapa } = req.body || {};
        const feito = !!(req.body || {}).feito;
        if (!itensGravacao(d.qtd || qtdPorCh(d.ch)).some(i => i.id === item)) return res.status(400).json({ error: 'Unidade inválida.' });
        const iEt = ETAPAS.indexOf(etapa);
        if (iEt < 0) return res.status(400).json({ error: 'Etapa inválida.' });
        const atual = { ...((d.gravacoes || {})[item] || {}) };
        const marca = { em: agora(), por: quemFez(req) };
        ETAPAS.forEach((e, i) => {
            if (feito && i <= iEt && !atual[e]) atual[e] = marca;
            if (!feito && i >= iEt) atual[e] = null;
        });
        const gravacoes = { ...(d.gravacoes || {}), [item]: atual };
        await ref.update({ gravacoes, updatedAt: agora(), updatedBy: quemFez(req) });
        res.json({ id: snap.id, ...d, gravacoes, itens: itensGravacao(d.qtd || qtdPorCh(d.ch)) });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// ------------------------------ Sala de cada professor e ocupações ------------------------------
const chaveProf = (p) => slug(p);

// PUT /semestre/:semestre/sala-professor { professor, salaId } (salaId vazio = tira a sala)
router.put('/semestre/:semestre/sala-professor', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const professor = texto(req.body.professor, 120);
        if (!professor) return res.status(400).json({ error: 'Informe o professor.' });
        const salaId = texto(req.body.salaId, 60);
        const ref = db.collection(COL_SEM).doc(semestre);
        const snap = await ref.get();
        const mapa = { ...((snap.exists && snap.data().salaDoProfessor) || {}) };
        if (salaId) mapa[chaveProf(professor)] = { salaId, professor };
        else delete mapa[chaveProf(professor)];
        await ref.set({ semestre }, { merge: true });
        await ref.update({ salaDoProfessor: mapa, updatedAt: agora(), updatedBy: quemFez(req) }); // update troca o mapa inteiro (apaga a chave tirada)
        res.json({ salaDoProfessor: mapa });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// POST /semestre/:semestre/distribuir — dá sala a quem tem aula e ainda não tem: a 1ª sala (não fixa) livre
// em TODOS os dias do professor, contando as salas já dadas e as ocupações avulsas.
router.post('/semestre/:semestre/distribuir', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const semestre = req.params.semestre;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const [discSnap, salasSnap, cfgSnap] = await Promise.all([
            db.collection(COL_DISC).where('semestre', '==', semestre).get(), db.collection(COL_SALAS).get(), db.collection(COL_SEM).doc(semestre).get()
        ]);
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const mapa = { ...(cfg.salaDoProfessor || {}) };
        const ocup = cfg.ocupacoes || {};
        const salas = salasSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(s => !s.fixo).sort((a, b) => ordemSala(a) - ordemSala(b));
        const diasDoProf = new Map();
        discSnap.docs.forEach(d => { const x = d.data(); if (!x.professor || !x.dia) return; const k = chaveProf(x.professor); if (!diasDoProf.has(k)) diasDoProf.set(k, { professor: x.professor, dias: new Set() }); diasDoProf.get(k).dias.add(x.dia); });
        const usada = (salaId, dia) => Object.entries(mapa).some(([k, v]) => v.salaId === salaId && diasDoProf.get(k)?.dias.has(dia)) || !!(ocup[dia] && ocup[dia][salaId]);
        const semSala = [];
        let dadas = 0;
        [...diasDoProf.entries()].sort((a, b) => b[1].dias.size - a[1].dias.size).forEach(([k, p]) => {
            if (mapa[k]) return;
            const livre = salas.find(s => [...p.dias].every(dia => !usada(s.id, dia)));
            if (livre) { mapa[k] = { salaId: livre.id, professor: p.professor }; dadas++; } else semSala.push(p.professor);
        });
        await db.collection(COL_SEM).doc(semestre).set({ semestre, salaDoProfessor: mapa, updatedAt: agora(), updatedBy: quemFez(req) }, { merge: true });
        res.json({ salaDoProfessor: mapa, dadas, semSala, message: `${dadas} professor(es) receberam sala.${semSala.length ? ` Sem sala livre em todos os dias: ${semSala.join(', ')}.` : ''}` });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PUT /semestre/:semestre/ocupacao { dia, salaId, texto } (texto vazio = libera) — síncrona mediada, reserva etc.
router.put('/semestre/:semestre/ocupacao', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!soTi(req, res)) return;
        const semestre = req.params.semestre;
        const { dia } = req.body || {};
        if (!SEMESTRE.test(semestre) || !DIAS.includes(dia)) return res.status(400).json({ error: 'Dia inválido.' });
        const salaId = texto(req.body.salaId, 60);
        if (!salaId) return res.status(400).json({ error: 'Sala inválida.' });
        const ref = db.collection(COL_SEM).doc(semestre);
        const snap = await ref.get();
        const ocupacoes = { ...((snap.exists && snap.data().ocupacoes) || {}) };
        ocupacoes[dia] = { ...(ocupacoes[dia] || {}) };
        const t = texto(req.body.texto, 120);
        if (t) ocupacoes[dia][salaId] = t; else delete ocupacoes[dia][salaId];
        await ref.set({ semestre }, { merge: true });
        await ref.update({ ocupacoes, updatedAt: agora(), updatedBy: quemFez(req) });
        res.json({ ocupacoes });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
module.exports._interno = { itensGravacao, lerPlanilhaZoom, lerPlanilhaLevantamento, semestreDaCelula, cursoDe, diaDe, chaveNome };
