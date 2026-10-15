const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { classificarComentario } = require('../utils/cpa-comentarios');
const { rotularTurmas } = require('../utils/cpa-turma-labels');
const { relay } = require('../utils/edubox-relay');

// ==========================================================================
// Relatório CPA (Comissão Própria de Avaliação). Substitui em 2026-10-14 o
// módulo anterior (dimensões por eixo SINAES, ranking de professor, capa
// institucional/PDF) — a diretoria não gostou daquela versão e aprovou, em
// vez dela, o app standalone "cpa-fatec" que o usuário construiu por conta
// própria. Esta rota é esse app reimplantado dentro do Órbita: mesmas
// consultas/agregação, agora com login e RBAC do Órbita, e os dados vindo
// do relay (VPS de IP fixo) em vez de conexão direta ao Postgres do Edubox
// (que só aceita o IP da Fatec — nem este backend no Vercel alcançaria).
//
// O relay (ver EDUBOX_RELAY_URL/EDUBOX_RELAY_TOKEN no .env) só devolve dados
// quase-crus; toda agregação por dimensão/disciplina, classificação de
// comentário, rótulo de turma e escopo por cargo ficam aqui.
//
// Quem vê o quê:
//   adm_l1 / adm_l2   todos os cursos, os três públicos (alunos/docentes/administrativo)
//   coordenador       só os cursos do próprio cadastro (users.cursos): alunos e docentes,
//                     nunca administrativo
//   coord_medicina    só Medicina, mesma restrição do coordenador
// ==========================================================================
const checkPermission = verifyToken.requireModulePermission('cpa');
const VE_TUDO = ['adm_l1', 'adm_l2'];

// id do curso no cadastro de Usuários (users.cursos) -> código do curso no Edubox
const CODCUR = {
    'agronegocio': 'AGRO', 'agronomia': 'AGRON', 'arquitetura-urbanismo': 'ARQUIT', 'biomedicina': 'BIOMED',
    'contabeis': 'CI.CONT', 'direito': 'DIR', 'enfermagem': 'ENFER', 'engenharia-civil': 'ENG.CIV',
    'fisioterapia': 'FISIO', 'gestao-comercial': 'GEST.COM', 'gestao-financeira': 'FINAN', 'logistica': 'LOG',
    'medicina': 'MED', 'medicina-veterinaria': 'MED.VET.', 'pedagogia': 'PED', 'psicologia': 'PSICO', 'rh': 'RH'
};

// null = todos os cursos; array = só esses códigos
async function escopoDe(req) {
    if (VE_TUDO.includes(req.user.role)) return null;
    if (req.user.role === 'coord_medicina') return ['MED'];
    // EAD (15/10/2026): as disciplinas a distância passam por todos os cursos da graduação — Medicina fica de fora
    if (req.user.role === 'ead') return Object.values(CODCUR).filter(c => c !== 'MED');
    const snap = await db.collection('users').doc(req.user.uid).get();
    const d = snap.exists ? snap.data() : {};
    const ids = Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
    return ids.map(i => CODCUR[i]).filter(Boolean);
}
const podeVer = (escopo, codcur) => escopo === null || escopo.includes(codcur);


// ---------- agregação (portada de cpa-fatec/src/alunos.js e src/staff.js) ----------
const parseOpcoes = (p) => (p.opcoes || '').split('|').map(o => o.trim()).filter(Boolean);
const escalaInvertidaDe = (opcoes) => opcoes.length > 0 && /ótimo|excelente|bom/i.test(opcoes[0]) && !/ótimo|excelente|bom/i.test(opcoes[opcoes.length - 1]);
const validasDist = (d) => d[0] + d[1] + d[2] + d[3];
const satisfacaoDe = (d) => { const v = validasDist(d); return v ? Math.round((d[0] + d[1]) / v * 1000) / 10 : null; };

// Dimensões tipo G vêm do relay já agregadas por pergunta (uma linha por
// codque: respostas + média). Dimensões tipo D vêm uma linha por
// (pergunta, disciplina, opção de resposta) — pra dar pra montar tanto a
// distribuição de UMA disciplina (ver montarPerguntasPorDisciplina) quanto a
// visão agregada "do curso inteiro" aqui: soma todas as disciplinas por
// (codgru, codque) e recalcula média/distribuição a partir da soma.
function montarPerguntasPorGrupo(perguntas) {
    const porChave = new Map();
    for (const p of perguntas) {
        const chave = `${p.codgru}|${p.codque}`;
        if (!porChave.has(chave)) porChave.set(chave, { codgru: p.codgru, codque: p.codque, pergunta: p.pergunta, opcoes: parseOpcoes(p), dist: [0, 0, 0, 0, 0], respostas: 0, somaPonderada: 0 });
        const acc = porChave.get(chave);
        if (p.op !== undefined) {
            // linha de distribuição (dimensão D): soma no dist e também na média ponderada
            const op = Number(p.op), n = Number(p.n) || 0;
            if (op >= 1 && op <= 5) acc.dist[op - 1] += n;
            acc.respostas += n;
            acc.somaPonderada += op * n;
        } else {
            // linha já agregada (dimensão G): sem distribuição por opção, só média/respostas
            const resp = Number(p.respostas) || 0;
            const media = p.media === null || p.media === undefined ? null : Number(p.media);
            acc.respostas += resp;
            if (media !== null) acc.somaPonderada += media * resp;
        }
    }
    const mapa = new Map();
    for (const acc of porChave.values()) {
        const media = acc.respostas > 0 ? Math.round((acc.somaPonderada / acc.respostas) * 100) / 100 : null;
        if (!mapa.has(acc.codgru)) mapa.set(acc.codgru, []);
        mapa.get(acc.codgru).push({
            codque: acc.codque, pergunta: acc.pergunta, opcoes: acc.opcoes,
            escalaInvertida: escalaInvertidaDe(acc.opcoes), respostas: acc.respostas, media,
            dist: validasDist(acc.dist) + acc.dist[4] > 0 ? acc.dist : null,
            satisfacao: validasDist(acc.dist) > 0 ? satisfacaoDe(acc.dist) : null,
        });
    }
    return mapa;
}

// Distribuição de resposta por pergunta de UMA disciplina específica (pro
// relatório/PDF por disciplina) — só existe pra dimensões tipo D.
function montarPerguntasPorDisciplina(perguntasD) {
    const porPerguntaDisc = new Map(); // `${codgru}|${codque}|${disciplina}` -> acumulador
    for (const p of perguntasD) {
        if (!p.disciplina) continue;
        const chave = `${p.codgru}|${p.codque}|${p.disciplina}`;
        if (!porPerguntaDisc.has(chave)) {
            porPerguntaDisc.set(chave, { codgru: p.codgru, disciplina: p.disciplina, codque: p.codque, pergunta: p.pergunta, opcoes: parseOpcoes(p), dist: [0, 0, 0, 0, 0] });
        }
        const acc = porPerguntaDisc.get(chave);
        const op = Number(p.op), n = Number(p.n) || 0;
        if (op >= 1 && op <= 5) acc.dist[op - 1] += n;
    }
    const mapa = new Map(); // `${codgru}|${disciplina}` -> array de perguntas
    for (const acc of porPerguntaDisc.values()) {
        const chaveDisc = `${acc.codgru}|${acc.disciplina}`;
        if (!mapa.has(chaveDisc)) mapa.set(chaveDisc, []);
        mapa.get(chaveDisc).push({
            codque: acc.codque, pergunta: acc.pergunta, opcoes: acc.opcoes,
            dist: acc.dist, respostas: validasDist(acc.dist) + acc.dist[4], satisfacao: satisfacaoDe(acc.dist),
        });
    }
    return mapa;
}

function montarRelatorioAluno({ avaliacao, curso, grupos, perguntas, notas, professores }) {
    const perguntasPorGrupo = montarPerguntasPorGrupo(perguntas);
    const perguntasPorDisciplina = montarPerguntasPorDisciplina(perguntas);
    const nomePorCodpro = new Map((professores || []).map(p => [p.codpro, p.nome]));

    const dimensaoInfo = new Map();
    const disciplinaInfo = new Map();
    for (const row of notas) {
        if (!dimensaoInfo.has(row.codgru)) dimensaoInfo.set(row.codgru, { somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [] });
        const info = dimensaoInfo.get(row.codgru);
        const notaBruta = row.notnot === null || row.notnot === undefined ? null : Number(row.notnot);
        const nota = (notaBruta !== null && notaBruta >= 0 && notaBruta <= 10) ? notaBruta : null;
        info.totalAvaliacoes += 1;
        if (nota !== null) { info.somaNotas += nota; info.countNotas += 1; }

        const texto = (row.obsnot || '').trim();
        const comentario = texto.split(/\s+/).filter(Boolean).length >= 2
            ? { texto, classificacao: classificarComentario(texto) }
            : null;
        if (comentario) info.comentarios.push(comentario);

        if (row.disciplina) {
            const chave = `${row.codgru}|${row.disciplina}`;
            if (!disciplinaInfo.has(chave)) {
                disciplinaInfo.set(chave, { codgru: row.codgru, disciplina: row.disciplina, somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [], professores: new Set() });
            }
            const dInfo = disciplinaInfo.get(chave);
            dInfo.totalAvaliacoes += 1;
            if (nota !== null) { dInfo.somaNotas += nota; dInfo.countNotas += 1; }
            if (comentario) dInfo.comentarios.push(comentario);
            const nomeProf = nomePorCodpro.get(row.codpro);
            if (nomeProf) dInfo.professores.add(nomeProf);
        }
    }

    const disciplinasPorGrupo = new Map();
    for (const d of disciplinaInfo.values()) {
        if (!disciplinasPorGrupo.has(d.codgru)) disciplinasPorGrupo.set(d.codgru, []);
        disciplinasPorGrupo.get(d.codgru).push({
            disciplina: d.disciplina,
            professores: [...d.professores].sort((a, b) => a.localeCompare(b, 'pt-BR')),
            mediaGeral: d.countNotas > 0 ? Math.round((d.somaNotas / d.countNotas) * 100) / 100 : null,
            totalAvaliacoes: d.totalAvaliacoes,
            comentarios: d.comentarios,
            perguntas: perguntasPorDisciplina.get(`${d.codgru}|${d.disciplina}`) || [],
        });
    }
    for (const lista of disciplinasPorGrupo.values()) lista.sort((a, b) => b.totalAvaliacoes - a.totalAvaliacoes);

    const dimensoes = grupos.map(g => {
        const info = dimensaoInfo.get(g.codgru) || { somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [] };
        const mediaGeral = info.countNotas > 0 ? Math.round((info.somaNotas / info.countNotas) * 100) / 100 : null;
        return {
            codgru: g.codgru,
            nome: g.nome,
            mediaGeral,
            totalAvaliacoes: info.totalAvaliacoes,
            perguntas: perguntasPorGrupo.get(g.codgru) || [],
            comentarios: info.comentarios,
            disciplinas: disciplinasPorGrupo.get(g.codgru) || [],
        };
    });

    return { avaliacao, curso, dimensoes };
}

function montarRelatorioStaff({ avaliacao, grupos, perguntas, notas }) {
    const perguntasPorGrupo = montarPerguntasPorGrupo(perguntas);

    const dimensaoInfo = new Map();
    for (const row of notas) {
        if (!dimensaoInfo.has(row.codgru)) dimensaoInfo.set(row.codgru, { somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [] });
        const info = dimensaoInfo.get(row.codgru);
        const notaBruta = row.notnot === null || row.notnot === undefined ? null : Number(row.notnot);
        const nota = (notaBruta !== null && notaBruta >= 0 && notaBruta <= 10) ? notaBruta : null;
        info.totalAvaliacoes += 1;
        if (nota !== null) { info.somaNotas += nota; info.countNotas += 1; }
        const texto = (row.obsnot || '').trim();
        if (texto.split(/\s+/).filter(Boolean).length >= 2) {
            info.comentarios.push({ texto, classificacao: classificarComentario(texto) });
        }
    }

    const dimensoes = grupos.map(g => {
        const info = dimensaoInfo.get(g.codgru) || { somaNotas: 0, countNotas: 0, totalAvaliacoes: 0, comentarios: [] };
        const mediaGeral = info.countNotas > 0 ? Math.round((info.somaNotas / info.countNotas) * 100) / 100 : null;
        return {
            codgru: g.codgru, nome: g.nome, mediaGeral, totalAvaliacoes: info.totalAvaliacoes,
            perguntas: perguntasPorGrupo.get(g.codgru) || [], comentarios: info.comentarios, disciplinas: [],
        };
    });

    return { avaliacao, dimensoes };
}

// Relatório da Direção: campanha inteira (alunos de todos os cursos, docentes
// ou administrativo) já agregada no relay (/cpa/direcao). Mesmas regras do
// resto: média da dimensão = nota 0–10 do respondente, comentário com 2+ palavras.
function montarRelatorioDirecao({ avaliacao, tipo, grupos, dist, notas, comentarios, respondentes, cursos }) {
    const perguntasPorGrupo = montarPerguntasPorGrupo(dist || []);
    const notaPorGrupo = new Map((notas || []).map(n => [n.codgru, n]));
    const comentPorGrupo = new Map();
    for (const c of comentarios || []) {
        const texto = String(c.obsnot || '').trim();
        if (texto.split(/\s+/).filter(Boolean).length < 2) continue;
        if (!comentPorGrupo.has(c.codgru)) comentPorGrupo.set(c.codgru, []);
        comentPorGrupo.get(c.codgru).push({ texto, classificacao: classificarComentario(texto) });
    }
    const dimensoes = (grupos || []).map(g => {
        const n = notaPorGrupo.get(g.codgru) || { total: 0, validas: 0, soma: 0 };
        return {
            codgru: g.codgru, nome: g.nome,
            mediaGeral: n.validas ? Math.round((Number(n.soma) / n.validas) * 100) / 100 : null,
            totalAvaliacoes: Number(n.total) || 0,
            perguntas: perguntasPorGrupo.get(g.codgru) || [],
            comentarios: comentPorGrupo.get(g.codgru) || [],
        };
    }).filter(d => d.totalAvaliacoes > 0 || d.perguntas.length);
    return { avaliacao, tipo, respondentes: respondentes || 0, cursos: cursos || 0, dimensoes };
}

function extrairOrdemTurma(nomeTurma) {
    const m = /(\d{4})[/-](\d)\s*$/.exec(nomeTurma || '');
    if (!m) return 0;
    return Number(m[1]) * 10 + Number(m[2]);
}

async function montarParticipacao(avaliacao, linhas, escopo) {
    const linhasEscopo = escopo === null ? linhas : linhas.filter(l => escopo.includes(l.codcur));
    const cursosPorCodigo = new Map();
    for (const row of linhasEscopo) {
        if (!cursosPorCodigo.has(row.codcur)) {
            cursosPorCodigo.set(row.codcur, { codcur: row.codcur, nome: row.nome, total: 0, iniciou: 0, concluiu: 0, turmas: [] });
        }
        const curso = cursosPorCodigo.get(row.codcur);
        const total = Number(row.total), iniciou = Number(row.iniciou), concluiu = Number(row.concluiu);
        curso.total += total; curso.iniciou += iniciou; curso.concluiu += concluiu;
        curso.turmas.push({
            codtur: row.codtur, nome: row.nome_turma, ordem: extrairOrdemTurma(row.nome_turma),
            total, iniciou, concluiu, percentual: total > 0 ? Math.round((concluiu / total) * 1000) / 10 : 0,
        });
    }

    const cursos = [];
    for (const c of cursosPorCodigo.values()) {
        const turmasOrdenadas = c.turmas.sort((a, b) => b.ordem - a.ordem);
        const rotulos = await rotularTurmas(db, c.codcur, turmasOrdenadas.map(t => t.nome));
        cursos.push({
            codcur: c.codcur, nome: c.nome, totalMatriculados: c.total, respondentes: c.concluiu, iniciaram: c.iniciou,
            percentual: c.total > 0 ? Math.round((c.concluiu / c.total) * 1000) / 10 : 0,
            turmas: turmasOrdenadas.map(({ ordem, nome, ...t }, i) => ({ ...t, nome: rotulos[i] || nome })),
        });
    }
    cursos.sort((a, b) => a.percentual - b.percentual);
    return { avaliacao, cursos };
}

// ---------- rotas ----------

// GET /api/cpa/campanhas?tipo=A|P|O
router.get('/campanhas', verifyToken, checkPermission, async (req, res) => {
    const tipo = req.query.tipo || 'A';
    if (tipo === 'O' || tipo === 'P') {
        const escopo = await escopoDe(req);
        if (escopo !== null) return res.status(403).json({ error: 'A avaliação de docentes e administrativo é restrita à direção.' });
    }
    try {
        const r = await relay(`/cpa/campanhas?tipo=${encodeURIComponent(tipo)}`);
        res.json({ campanhas: r.campanhas });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/cpa/cursos?codava= (opcional)
router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    try {
        const escopo = await escopoDe(req);
        const r = await relay(`/cpa/cursos${req.query.codava ? `?codava=${encodeURIComponent(req.query.codava)}` : ''}`);
        const cursos = escopo === null ? r.cursos : r.cursos.filter(c => escopo.includes(c.codcur));
        res.json({ cursos });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/cpa/relatorio-aluno?codava=&curso=
router.get('/relatorio-aluno', verifyToken, checkPermission, async (req, res) => {
    const { codava, curso } = req.query;
    if (!codava || !curso) return res.status(400).json({ error: 'codava e curso são obrigatórios.' });
    try {
        const escopo = await escopoDe(req);
        if (!podeVer(escopo, curso)) return res.status(403).json({ error: 'Você não tem acesso a este curso.' });
        const r = await relay(`/cpa/relatorio-aluno?codava=${encodeURIComponent(codava)}&curso=${encodeURIComponent(curso)}`);
        res.json(montarRelatorioAluno(r));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/cpa/relatorio-staff?codava=&tipo=P|O&curso= (curso opcional — sem curso = todos os professores da campanha, só direção)
router.get('/relatorio-staff', verifyToken, checkPermission, async (req, res) => {
    const { codava, tipo, curso } = req.query;
    if (!codava || !tipo) return res.status(400).json({ error: 'codava e tipo são obrigatórios.' });
    try {
        const escopo = await escopoDe(req);
        if ((tipo === 'O' || tipo === 'P') && escopo !== null) {
            return res.status(403).json({ error: 'A avaliação de docentes e administrativo é restrita à direção.' });
        }
        const q = `codava=${encodeURIComponent(codava)}&tipo=${encodeURIComponent(tipo)}${curso ? `&curso=${encodeURIComponent(curso)}` : ''}`;
        const r = await relay(`/cpa/relatorio-staff?${q}`);
        res.json(montarRelatorioStaff(r));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/cpa/relatorio-direcao?codava=&tipo=A|P|O
router.get('/relatorio-direcao', verifyToken, checkPermission, async (req, res) => {
    // visão executiva da campanha inteira (alunos = todos os cursos juntos). Só direção (ADM N1/N2).
    const { codava, tipo } = req.query;
    if (!codava || !['A', 'P', 'O'].includes(tipo)) return res.status(400).json({ error: 'codava e tipo (A, P ou O) são obrigatórios.' });
    try {
        const escopo = await escopoDe(req);
        if (escopo !== null) return res.status(403).json({ error: 'O relatório da direção é restrito à direção.' });
        const r = await relay(`/cpa/direcao?codava=${encodeURIComponent(codava)}&tipo=${tipo}`, { timeoutMs: 60000 });
        res.json(montarRelatorioDirecao(r));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/cpa/participacao?codava=
router.get('/participacao', verifyToken, checkPermission, async (req, res) => {
    const { codava } = req.query;
    if (!codava) return res.status(400).json({ error: 'codava é obrigatório.' });
    try {
        const escopo = await escopoDe(req);
        const r = await relay(`/cpa/participacao?codava=${encodeURIComponent(codava)}`);
        const resultado = await montarParticipacao(r.avaliacao, r.linhas, escopo);
        res.json(resultado);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/cpa/participacao-detalhe?codava=&curso= — lista nominal (responderam/não),
// pra gerar a lista de quem falta responder. Mesmo escopo por curso de todo o resto.
router.get('/participacao-detalhe', verifyToken, checkPermission, async (req, res) => {
    const { codava, curso } = req.query;
    if (!codava || !curso) return res.status(400).json({ error: 'codava e curso são obrigatórios.' });
    try {
        const escopo = await escopoDe(req);
        if (!podeVer(escopo, curso)) return res.status(403).json({ error: 'Você não tem acesso a este curso.' });
        const r = await relay(`/cpa/participacao-detalhe?codava=${encodeURIComponent(codava)}&curso=${encodeURIComponent(curso)}`);
        res.json({ avaliacao: r.avaliacao, alunos: r.alunos });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

module.exports = router;
module.exports._interno = { escopoDe, podeVer, CODCUR, montarRelatorioAluno, montarRelatorioStaff, montarParticipacao, montarRelatorioDirecao };
