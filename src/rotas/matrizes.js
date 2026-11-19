const express = require('express');
const router = express.Router();
const { admin, db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { relay } = require('../utils/edubox-relay');
const { montar, semestresPadrao, normSemestre, formatosEdubox, codcurDe, cursoIdDe } = require('../utils/matrizes-montar');

// ==========================================================================
// Matrizes: o que cada curso estuda no semestre (consultado ao vivo no
// Edubox pelo relay, rotas /matrizes/*) + professor/dia/hora de cada
// disciplina, definidos pelo coordenador e que viram o horário de aula do curso.
//
// Coleção:
//   matrizes_grade/{AAAA.S}__{cursoId}   alocacoes: { "{codTurma}:{codDisciplina}":
//                                        { disciplina, turma, aulas: [{professor,dia,inicio,fim}] } }
//
// Quem vê o quê: ADM (N1/N2) e RH veem todos os cursos; qualquer outro cargo
// (coordenador) só os cursos vinculados ao próprio cadastro (users.cursos).
// ==========================================================================
const VE_TUDO = ['adm_l1', 'adm_l2', 'rh'];
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;
const SEMESTRE = /^\d{4}\.[12]$/;

// Cursos que a pessoa pode ver: null = todos, array = só esses.
async function escopoDe(req) {
    if (VE_TUDO.includes(req.user.role)) return null;
    const snap = await db.collection('users').doc(req.user.uid).get();
    const d = snap.exists ? snap.data() : {};
    const ids = Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
    return ids.filter(Boolean);
}
const podeVer = (escopo, cursoId) => escopo === null || escopo.includes(cursoId);

const minutos = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

// Valida e limpa as aulas enviadas pelo cliente.
function limparAulas(aulas) {
    if (!Array.isArray(aulas)) throw new Error('Formato inválido: "aulas" deve ser uma lista.');
    if (aulas.length > 6) throw new Error('No máximo 6 horários por disciplina.');
    return aulas.map((a, i) => {
        const professor = String(a.professor || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const dia = String(a.dia || '');
        const inicio = String(a.inicio || '');
        const fim = String(a.fim || '');
        if (!professor) throw new Error(`Horário ${i + 1}: informe o professor.`);
        // professor novo ou veterano marcado pelo coordenador (18/11/2026); vazio = pelo histórico do Edubox.
        // Só vai pro relatório da direção (aba Titulação), não sai no horário.
        const vinculo = ['novo', 'veterano'].includes(a.vinculo) ? a.vinculo : '';
        const comV = (o) => (vinculo ? { ...o, vinculo } : o);
        // Só o professor, sem dia e horário ainda (10/11/2026): o coordenador define quem dá a aula antes
        // de fechar o horário (e a Secretaria Acadêmica já lança o professor no Edubox).
        if (!dia && !inicio && !fim) return comV({ professor });
        if (!DIAS.includes(dia)) throw new Error(`Horário ${i + 1}: dia da semana inválido.`);
        if (!HORA.test(inicio) || !HORA.test(fim)) throw new Error(`Horário ${i + 1}: informe início e fim (HH:MM).`);
        if (minutos(fim) <= minutos(inicio)) throw new Error(`Horário ${i + 1}: o fim precisa ser depois do início.`);
        // sala (ensalamento): opcional; aceita "4", "M.A. 2", "LAB INFORMATICA 12" ou várias separadas por "/"
        const sala = String(a.sala || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return comV(sala ? { professor, dia, inicio, fim, sala } : { professor, dia, inicio, fim });
    });
}

// Mesmo professor, mesmo dia, horários que se sobrepõem — em qualquer curso
// do semestre. Só avisa (não bloqueia): o RH/coordenação decide.
function acharConflitos(aulas, docsGrade, ignorarDoc, ignorarKey, nomeDisc = '') {
    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const base = (s) => norm(String(s || '')).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    // Mesma disciplina (ou Projeto Integrador, que muda de nome a cada período) com o mesmo professor =
    // turmas que estudam juntas (matriz rotativa), não conflito.
    const mesma = (a, b) => {
        const x = base(a), y = base(b);
        if (!x || !y) return false;
        return x === y || (/^projeto integrador/.test(x) && /^projeto integrador/.test(y)
            && x.split(' ').slice(0, 3).join(' ') === y.split(' ').slice(0, 3).join(' '));
    };
    const conflitos = [];
    for (const g of docsGrade) {
        for (const [key, al] of Object.entries(g.alocacoes || {})) {
            if (g.id === ignorarDoc && key === ignorarKey) continue;
            if (mesma(al.disciplina, nomeDisc)) continue;
            for (const o of al.aulas || []) {
                for (const a of aulas) {
                    if (!a.dia || !o.dia) continue;   // professor sem horário ainda: não tem como conflitar
                    if (o.dia !== a.dia || !(minutos(a.inicio) < minutos(o.fim) && minutos(o.inicio) < minutos(a.fim))) continue;
                    // horário idêntico = provável aula conjunta; sobreposição parcial = conflito de verdade
                    const exato = o.inicio === a.inicio && o.fim === a.fim;
                    if (norm(o.professor) === norm(a.professor)) {
                        conflitos.push({
                            tipo: 'professor', professor: a.professor, dia: a.dia, inicio: o.inicio, fim: o.fim,
                            curso: g.cursoNome || g.cursoId, disciplina: al.disciplina || '', exato
                        });
                    } else if (a.sala && o.sala && base(a.sala) === base(o.sala)) {
                        // mesma sala, mesmo dia, horários que se sobrepõem, outra disciplina e outro professor
                        conflitos.push({
                            tipo: 'sala', sala: a.sala, professor: o.professor, dia: a.dia, inicio: o.inicio, fim: o.fim,
                            curso: g.cursoNome || g.cursoId, disciplina: al.disciplina || '', exato
                        });
                    }
                }
            }
        }
    }
    return conflitos;
}

// Semestres que existem no Edubox entre o atual e os 2 próximos, ex. ["2026.2", "2027.1"].
async function semestresDisponiveis() {
    const candidatos = semestresPadrao();
    const { semestres } = await relay(`/matrizes/semestres?formatos=${encodeURIComponent(candidatos.flatMap(formatosEdubox).join(','))}`);
    return [...new Set(semestres.map(normSemestre))].filter(s => candidatos.includes(s)).sort();
}

// ==========================================
// DISCIPLINAS AJUSTADAS NO ÓRBITA (10/11/2026) — quando a matriz nova ainda não está no Edubox, o
// coordenador inclui/altera aqui e imprime as alterações pra Secretaria Acadêmica lançar no Edubox.
// No doc matrizes_grade/{AAAA.S}__{cursoId}:
//   disciplinasManuais: { M<id>: { nome, tipo, ch, turmas:[codTurma], criadoPor, criadoEm } }
//   ajustesDisciplinas: { "{codTurma}:{codDisciplina}": { nome?, tipo?, ch?, retirar?, lancar?, por, em } }
// Quando o Edubox passar a ter a disciplina, o ajuste continua só como registro (a tela mostra o que mudou).
// ==========================================
const TIPOS_DISC = ['Presencial', 'A Distância'];
const CAMPOS_CH = ['teorica', 'pratica', 'ead', 'sincrona', 'extensao'];
function limparDisciplina(b) {
    const nome = String(b.nome || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 150);
    if (nome.length < 3) throw new Error('Informe o nome da disciplina.');
    const tipo = TIPOS_DISC.includes(b.tipo) ? b.tipo : null;
    if (!tipo) throw new Error('Escolha se a disciplina é presencial ou a distância.');
    const ch = {};
    CAMPOS_CH.forEach(k => {
        const v = Number((b.ch || {})[k] || 0);
        if (!Number.isInteger(v) || v < 0 || v > 1000) throw new Error('Carga horária inválida (use horas inteiras).');
        ch[k] = v;
    });
    ch.total = CAMPOS_CH.reduce((n, k) => n + ch[k], 0);
    if (!ch.total) throw new Error('Informe a carga horária.');
    return { nome, tipo, ch };
}
function aplicarAjustes(m, g) {
    const manuais = (g && g.disciplinasManuais) || {};
    const ajustes = (g && g.ajustesDisciplinas) || {};
    for (const t of m.turmas || []) {
        t.disciplinas = t.disciplinas.map(d => {
            const a = ajustes[`${t.codTurma}:${d.codDisciplina}`];
            if (!a) return d;
            const nd = { ...d, ajuste: { nomeEdubox: d.nome, tipoEdubox: d.tipo, chEdubox: d.ch } };
            if (a.nome) nd.nome = a.nome;
            if (a.tipo) nd.tipo = a.tipo;
            if (a.ch) nd.ch = a.ch;
            if (a.retirar) nd.retirada = true;
            if (a.lancar && d.naoOfertada) { nd.naoOfertada = false; nd.lancar = true; }
            nd.alterada = !!(a.nome || a.tipo || a.ch);
            return nd;
        });
        Object.entries(manuais).forEach(([id, x]) => {
            if ((x.turmas || []).map(String).includes(String(t.codTurma))) {
                t.disciplinas.push({ codDisciplina: id, nome: x.nome, tipo: x.tipo, ch: x.ch, manual: true });
            }
        });
        t.disciplinas.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    }
    return m;
}
async function cursoComAjustes(semestre, cursoId) {
    const docId = `${semestre}__${cursoId}`;
    const [ms, gSnap] = await Promise.all([matrizesDoSemestre(semestre, cursoId), db.collection('matrizes_grade').doc(docId).get()]);
    const m = ms.find(x => x.id === docId);
    return m ? { m: aplicarAjustes(m, gSnap.exists ? gSnap.data() : null), docId, ref: gSnap.ref } : null;
}

// Docs por curso do semestre, montados na hora a partir do relay. `cursoId` filtra um curso só.
async function matrizesDoSemestre(semestre, cursoId) {
    const q = `formatos=${encodeURIComponent(formatosEdubox(semestre).join(','))}${cursoId ? `&curso=${encodeURIComponent(codcurDe(cursoId))}` : ''}`;
    return montar(await relay(`/matrizes/dados?${q}`, { timeoutMs: 30000 }));
}

// Titulação dos professores no Edubox (09/11/2026) — mesma consulta da Automação AVA (relay
// /automacao-ava/titulacoes): o semestre escolhido e os 3 anteriores; por professor vale o semestre mais
// recente (no mesmo semestre, a maior titulação). Se o Edubox não responder, a tela segue sem titulação.
const NIVEL_TIT = (t) => /dout/i.test(t) ? 3 : /mestr/i.test(t) ? 2 : /especiali/i.test(t) ? 1 : 0;
const ROTULO_TIT = (t) => /dout/i.test(t) ? 'Doutor' : /mestr/i.test(t) ? 'Mestre' : /especiali/i.test(t) ? 'Especialista' : /gradu/i.test(t) ? 'Graduado' : '';
function semestresAntes(semestre, n) {
    let [a, s] = semestre.split('.').map(Number);
    const out = [semestre];
    for (let i = 0; i < n; i++) { if (s === 1) { s = 2; a--; } else s = 1; out.push(`${a}.${s}`); }
    return out;
}
async function titulacoesEdubox(semestre) {
    try {
        const sems = semestresAntes(semestre, 3).flatMap(formatosEdubox);
        const r = await relay(`/automacao-ava/titulacoes?semestres=${encodeURIComponent(sems.join(','))}`, { timeoutMs: 20000 });
        const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
        const m = new Map();
        (r.professores || []).forEach(p => {
            const nome = String(p.nome || '').trim(), k = norm(nome), sem = String(p.sem || '').replace(/[/-]/, '.');
            if (!k) return;
            const at = m.get(k);
            if (!at || sem > at.sem || (sem === at.sem && NIVEL_TIT(p.titulacao) > NIVEL_TIT(at.tit))) m.set(k, { nome, sem, tit: p.titulacao, codfun: p.codfun });
        });
        return [...m.values()].map(p => ({ codfun: p.codfun != null ? String(p.codfun) : null, nome: p.nome, titulacao: ROTULO_TIT(p.tit) })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    } catch (e) {
        console.error('[matrizes] titulações:', e.message);
        return [];
    }
}

// ==========================================
// TITULAÇÃO EDITADA PELO COORDENADOR (18/11/2026) — a titulação do Edubox às vezes está errada ou
// desatualizada; o coordenador corrige aqui e vale a editada (editada > Edubox). Um doc por professor:
//   matrizes_titulacoes/F{codfun}        professor que existe no Edubox (chave estável: código dele)
//   matrizes_titulacoes/N_{NOME_NORM}    professor só digitado nos horários, sem cadastro no Edubox
//   { codfun|null, nome, nomeNorm, titulacao, titulacaoEdubox, semestreReferencia, alteradoPor:{uid,nome}, alteradoEm }
// Toda gravação/remoção também vai pro log matrizes_titulacoes_log (quem, quando, de → para).
// Coordenador edita só professor que dá aula no(s) curso(s) dele no semestre (diário do Edubox ou
// horário definido aqui); ADM/RH (escopo = todos) editam qualquer um. Validado aqui, não só na tela.
// ==========================================
const COL_TIT = 'matrizes_titulacoes';
const TITULACOES = ['Doutor', 'Mestre', 'Especialista', 'Graduado'];
const normNomeTit = (s) => normNome(s);   // mesma normalização do resto do módulo
const chaveTit = (codfun, nome) => (codfun != null && String(codfun).trim() ? `F${String(codfun).trim()}` : `N_${normNomeTit(nome).replace(/ /g, '_')}`);

// { porChave: Map(docId → dados), porNome: Map(nomeNorm → dados) }
async function overridesTitulacao() {
    const snap = await db.collection(COL_TIT).get();
    const porChave = new Map(), porNome = new Map();
    snap.forEach(d => { const x = d.data(); porChave.set(d.id, x); if (x.nomeNorm && !porNome.has(x.nomeNorm)) porNome.set(x.nomeNorm, x); });
    return { porChave, porNome };
}
// Professor {codfun?, nome, titulacao} → o mesmo com a titulação que vale + de onde ela veio.
function comOverride(p, ov) {
    const porNome = ov.porNome.get(normNomeTit(p.nome));
    const deOutro = porNome && porNome.codfun && p.codfun != null && String(porNome.codfun) !== String(p.codfun);
    const o = (p.codfun != null && ov.porChave.get(chaveTit(p.codfun))) || (deOutro ? null : porNome) || null;
    if (!o) return { ...p, fonte: 'edubox' };
    const em = o.alteradoEm && o.alteradoEm.toDate ? o.alteradoEm.toDate().toISOString() : (o.alteradoEm || null);
    return { ...p, titulacao: o.titulacao, titulacaoEdubox: p.titulacao || '', fonte: 'coordenador', editadoPor: (o.alteradoPor || {}).nome || '', editadoEm: em };
}
async function titulacoesComOverride(semestre) {
    const [tits, ov] = await Promise.all([titulacoesEdubox(semestre), overridesTitulacao()]);
    const out = tits.map(t => comOverride(t, ov));
    // professor sem cadastro no Edubox (só digitado nos horários) com titulação definida pelo coordenador
    const vistos = new Set(out.map(t => normNomeTit(t.nome)));
    ov.porChave.forEach((o, id) => {
        if (!id.startsWith('N_') || vistos.has(o.nomeNorm)) return;
        vistos.add(o.nomeNorm);
        out.push(comOverride({ codfun: null, nome: o.nome, titulacao: '' }, ov));
    });
    return out.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}

// O professor dá aula em algum curso do escopo neste semestre? (diário do Edubox ou horário definido aqui)
async function professorNoEscopo(semestre, escopo, codfun, nome) {
    if (escopo === null) return true;
    if (!escopo.length) return false;
    if (codfun) {
        const cd = await relay(`/corpo-docente/lista?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}`, { timeoutMs: 30000 }).catch(() => null);
        if (cd && cd.ok && (cd.professores || []).some(p => String(p.codfun) === String(codfun) && escopo.includes(cursoIdDe(String(p.codcur).trim())))) return true;
    }
    const alvo = { nome, toks: normNomeTit(nome).split(' ') };
    const gSnap = await db.collection('matrizes_grade').where('semestre', '==', semestre).get();
    return gSnap.docs.some(d => {
        const x = d.data();
        if (!escopo.includes(x.cursoId || d.id.split('__')[1])) return false;
        return Object.values(x.alocacoes || {}).some(a => (a.aulas || []).some(au => {
            if (ehContratar(au.professor)) return false;
            if (normNomeTit(au.professor) === normNomeTit(nome)) return true;
            if (normNomeTit(au.professor).split(' ').length < 2) return false;
            const achado = acharProfessor([alvo], au.professor);
            return !!(achado && !achado.ambiguo);
        }));
    });
}

// Confere o pedido e devolve o professor "oficial" (nome do Edubox quando vem o codfun).
async function prepararTitulacao(req, res) {
    const b = req.body || {};
    const semestre = SEMESTRE.test(String(b.semestre || '')) ? b.semestre : '';
    if (!semestre) { res.status(400).json({ error: 'Informe o semestre.' }); return null; }
    let codfun = b.codfun != null && /^\d{1,12}$/.test(String(b.codfun).trim()) ? String(b.codfun).trim() : null;
    let nome = String(b.nome || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    let titulacaoEdubox = '';
    const tits = await titulacoesEdubox(semestre);
    let e = codfun ? tits.find(t => t.codfun === codfun) : null;
    if (codfun && !e) codfun = null;   // código desconhecido: segue só pelo nome (chave N_), nunca grava em F{codfun}
    if (e) { nome = e.nome; titulacaoEdubox = e.titulacao || ''; }
    else {
        const porNome = tits.find(t => normNomeTit(t.nome) === normNomeTit(nome));
        if (porNome) titulacaoEdubox = porNome.titulacao || '';
    }
    if (!nome || ehContratar(nome)) { res.status(400).json({ error: 'Informe o professor.' }); return null; }
    const escopo = await escopoDe(req);
    if (!(await professorNoEscopo(semestre, escopo, codfun, nome))) {
        res.status(403).json({ error: 'Você só pode alterar a titulação de professores dos seus cursos.' });
        return null;
    }
    return { semestre, codfun, nome, titulacaoEdubox, id: chaveTit(codfun, nome), quem: { uid: req.user.uid, nome: req.user.name || req.user.email || '' } };
}

// PUT /api/matrizes/titulacao-professor  { semestre, codfun?, nome, titulacao }
router.put('/titulacao-professor', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const titulacao = String((req.body || {}).titulacao || '');
        if (!TITULACOES.includes(titulacao)) return res.status(400).json({ error: 'Titulação inválida. Use Doutor, Mestre, Especialista ou Graduado.' });
        const p = await prepararTitulacao(req, res);
        if (!p) return;
        const ref = db.collection(COL_TIT).doc(p.id);
        const antes = await ref.get();
        await ref.set({
            codfun: p.codfun, nome: p.nome, nomeNorm: normNomeTit(p.nome), titulacao, titulacaoEdubox: p.titulacaoEdubox,
            semestreReferencia: p.semestre, alteradoPor: p.quem, alteradoEm: admin.firestore.FieldValue.serverTimestamp()
        });
        await db.collection(`${COL_TIT}_log`).add({
            chave: p.id, codfun: p.codfun, nome: p.nome, acao: 'editar', de: antes.exists ? antes.data().titulacao : (p.titulacaoEdubox || ''),
            para: titulacao, semestre: p.semestre, por: p.quem, em: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ ok: true, chave: p.id, codfun: p.codfun, nome: p.nome, titulacao, titulacaoEdubox: p.titulacaoEdubox, fonte: 'coordenador', editadoPor: p.quem.nome, editadoEm: new Date().toISOString() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/matrizes/professor-nome  { semestre, de, para } — corrige o nome do professor em TODOS os horários
// do semestre nos cursos que a pessoa vê (coordenador: os dele; ADM/RH: todos), numa gravação só. A titulação
// editada do nome antigo (professor sem Edubox) é copiada pro nome novo.
router.put('/professor-nome', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const b = req.body || {};
        const semestre = SEMESTRE.test(String(b.semestre || '')) ? b.semestre : '';
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const de = String(b.de || '').replace(/\s+/g, ' ').trim();
        const para = String(b.para || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!de || !para) return res.status(400).json({ error: 'Informe o nome atual e o novo nome.' });
        if (ehContratar(para)) return res.status(400).json({ error: 'O novo nome não pode ser "contratar" / "a definir".' });
        if (para.length < 3) return res.status(400).json({ error: 'Nome muito curto.' });
        const escopo = await escopoDe(req);
        const nDe = normNomeTit(de);
        const gSnap = await db.collection('matrizes_grade').where('semestre', '==', semestre).get();
        let aulasTrocadas = 0;
        const docs = [];
        for (const d of gSnap.docs) {
            const x = d.data();
            if (!podeVer(escopo, x.cursoId || d.id.split('__')[1])) continue;
            const mudou = {};
            Object.entries(x.alocacoes || {}).forEach(([k, a]) => {
                let n = 0;
                const aulas = (a.aulas || []).map(au => (normNomeTit(au.professor) === nDe ? (n++, { ...au, professor: para }) : au));
                if (n) { mudou[k] = { ...a, aulas }; aulasTrocadas += n; }
            });
            if (Object.keys(mudou).length) docs.push({ ref: d.ref, mudou });
        }
        if (!aulasTrocadas) return res.status(404).json({ error: 'Não achei esse professor nos horários dos seus cursos neste semestre.' });
        const quem = { uid: req.user.uid, nome: req.user.name || req.user.email || '' };
        const lote = db.batch();
        docs.forEach(({ ref, mudou }) => lote.set(ref, { alocacoes: mudou }, { merge: true }));
        // a titulação editada do nome antigo (chave por nome) é copiada pro nome novo, se ele ainda não tiver
        // uma; a antiga fica, porque outros cursos (fora do escopo de quem renomeou) podem usar o nome antigo
        const velho = db.collection(COL_TIT).doc(chaveTit(null, de)), novo = db.collection(COL_TIT).doc(chaveTit(null, para));
        const [sv, sn] = await Promise.all([velho.get(), novo.get()]);
        if (sv.exists && !sn.exists && velho.id !== novo.id) {
            lote.set(novo, { ...sv.data(), nome: para, nomeNorm: normNomeTit(para), alteradoPor: quem, alteradoEm: admin.firestore.FieldValue.serverTimestamp() });
        }
        lote.set(db.collection(`${COL_TIT}_log`).doc(), { acao: 'renomear', de, para, semestre, aulas: aulasTrocadas, cursos: docs.map(x => x.ref.id), por: quem, em: admin.firestore.FieldValue.serverTimestamp() });
        await lote.commit();
        res.json({ ok: true, de, para, aulas: aulasTrocadas, cursos: docs.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/matrizes/titulacao-professor  { semestre, codfun?, nome } — volta a valer a titulação do Edubox
router.delete('/titulacao-professor', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const p = await prepararTitulacao(req, res);
        if (!p) return;
        const ref = db.collection(COL_TIT).doc(p.id);
        const antes = await ref.get();
        if (antes.exists) {
            await ref.delete();
            await db.collection(`${COL_TIT}_log`).add({
                chave: p.id, codfun: p.codfun, nome: p.nome, acao: 'voltar-edubox', de: antes.data().titulacao, para: p.titulacaoEdubox,
                semestre: p.semestre, por: p.quem, em: admin.firestore.FieldValue.serverTimestamp()
            });
        }
        res.json({ ok: true, codfun: p.codfun, nome: p.nome, titulacao: p.titulacaoEdubox, fonte: 'edubox' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// TITULAÇÃO POR CURSO (09/11/2026) — relatório do diretor: doutores, mestres, especialistas e graduados de
// cada curso. Cada professor conta UMA vez por curso (mesmo dando aula em várias turmas dele); em outro
// curso conta de novo. Fonte: os diários do Edubox (relay /corpo-docente/lista) quando o semestre já tem
// professor lançado; senão (semestre em planejamento) os professores definidos aqui nos horários, com a
// titulação achada no Edubox pelo nome, + quantas disciplinas estão sem professor / "a contratar".
// Regra: mestres + doutores tem que ser MAIOR que especialistas.
// ==========================================
const normNome = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ehContratar = (p) => !String(p || '').trim() || /contrat|a definir|indefinid/i.test(p);
// nome curto digitado pelo coordenador → professor do Edubox (1º nome + os outros nomes ou o começo deles)
function acharProfessor(lista, nome) {
    const tk = normNome(nome).split(' ').filter(Boolean);
    if (!tk.length) return null;
    const c = lista.filter(t => t.toks[0] === tk[0] && tk.slice(1).every(w => t.toks.slice(1).some(x => x === w || x.startsWith(w))));
    return c.length === 1 ? c[0] : (c.length > 1 && new Set(c.map(x => x.titulacao)).size === 1 ? { ...c[0], ambiguo: true } : (c.length ? { nome, titulacao: '?', ambiguo: true } : null));
}

// ==========================================
// PROFESSOR NOVO x VETERANO (18/11/2026) — pedido da direção: quantos professores novos cada curso tem.
// Histórico = diários do Edubox (relay /corpo-docente/lista) nos 10 semestres anteriores (5 anos):
//   veterano    já deu aula na Fatec (em qualquer curso) nos diários anteriores
//   novo        não aparece nos diários anteriores (ou nem tem cadastro no Edubox)
// O coordenador pode corrigir no cadastro do professor (aula.vinculo = novo|veterano): vale o dele.
// Só aparece no cadastro e no relatório da direção — não sai no horário.
// O relay aceita até 4 formatos por chamada (= 2 semestres): 5 chamadas em paralelo.
// ==========================================
const HIST_SEMESTRES = 10;
const histCache = new Map();   // semestre → { em, dados } (10 min, por instância)
async function historicoDocentes(semestre) {
    const c = histCache.get(semestre);
    if (c && Date.now() - c.em < 10 * 60 * 1000) return c.dados;
    const ant = semestresAntes(semestre, HIST_SEMESTRES).slice(1);
    const lotes = [];
    for (let i = 0; i < ant.length; i += 2) lotes.push(ant.slice(i, i + 2).flatMap(formatosEdubox));
    try {
        const rs = await Promise.all(lotes.map(l => relay(`/corpo-docente/lista?semestres=${encodeURIComponent(l.join(','))}`, { timeoutMs: 30000 })));
        const ruim = rs.find(r => !r || !r.ok);
        if (ruim) throw new Error((ruim && ruim.erro) || 'relay sem resposta');
        const fatec = new Set(), curso = new Set(), porCodfun = new Map();
        rs.forEach(r => (r.professores || []).forEach(p => {
            const f = String(p.codfun), cid = cursoIdDe(String(p.codcur).trim());
            fatec.add(f);
            curso.add(`${cid}:${f}`);
            if (!porCodfun.has(f)) porCodfun.set(f, { codfun: f, nome: String(p.nome || '').trim(), cursos: new Set() });
            porCodfun.get(f).cursos.add(cid);
        }));
        // pra achar pelo nome quem só foi digitado nos horários (ou não tem titulação no Edubox)
        const lista = [...porCodfun.values()].map(x => ({ ...x, toks: normNome(x.nome).split(' ') }));
        const dados = { ok: true, fatec, curso, lista, desde: ant[ant.length - 1] };
        histCache.set(semestre, { em: Date.now(), dados });
        return dados;
    } catch (e) {
        console.error('[matrizes] histórico de docentes:', e.message);
        return { ok: false, erro: e.message, fatec: new Set(), curso: new Set(), lista: [] };
    }
}
function vinculoAuto(hist, cursoId, codfun, nome) {
    if (!hist.ok) return null;
    let f = codfun ? String(codfun) : null;
    if (!f) {
        // sem código (professor só digitado no horário): procura pelo nome nos diários anteriores
        const ex = hist.lista.filter(x => normNome(x.nome) === normNome(nome));
        const ach = ex.length === 1 ? ex[0] : acharProfessor(hist.lista, nome);
        if (ach && !ach.ambiguo && ach.codfun) f = ach.codfun;
    }
    // regra da direção (18/11/2026): já tem histórico na Fatec (qualquer curso) = veterano; senão = novo.
    // Se não bater (ex.: professor que saiu e voltou), o coordenador corrige no cadastro do professor.
    return f && hist.fatec.has(f) ? 'veterano' : 'novo';
}

// GET /api/matrizes/historico-docentes?semestre=2027.1 — pro cadastro do professor mostrar o automático (só nomes)
router.get('/historico-docentes', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '';
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const hist = await historicoDocentes(semestre);
        if (!hist.ok) return res.json({ ok: false, erro: hist.erro });
        // só os nomes de quem já deu aula na Fatec (é o que a tela precisa pra mostrar "Pelo histórico")
        res.json({ ok: true, desde: hist.desde, nomes: [...new Set(hist.lista.map(x => x.nome))] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/titulacao', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '';
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const escopo = await escopoDe(req);
        const [docsEdubox, cd, ov, gSnap, hist] = await Promise.all([
            matrizesDoSemestre(semestre),
            relay(`/corpo-docente/lista?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}`, { timeoutMs: 30000 }).catch(e => ({ ok: false, erro: e.message })),
            overridesTitulacao(),
            db.collection('matrizes_grade').where('semestre', '==', semestre).get(),
            historicoDocentes(semestre)
        ]);
        const cursos = new Map(docsEdubox.filter(m => podeVer(escopo, m.cursoId)).map(m => [m.cursoId, { cursoId: m.cursoId, cursoNome: m.cursoNome, professores: new Map(), semProfessor: 0 }]));
        const doEdubox = cd && cd.ok && (cd.professores || []).length > 0;
        if (doEdubox) {
            cd.professores.forEach(p => {
                const c = cursos.get(cursoIdDe(String(p.codcur).trim()));
                if (!c) return;
                const k = String(p.codfun);
                if (!c.professores.has(k)) c.professores.set(k, comOverride({ codfun: k, nome: p.nome, titulacao: ROTULO_TIT(p.titulacao), diarios: p.diarios }, ov));
            });
        } else {
            // planejamento: o que os coordenadores definiram nos horários deste semestre
            const tits = await titulacoesEdubox(semestre);
            const lista = tits.map(t => ({ ...t, toks: normNome(t.nome).split(' ') }));
            gSnap.forEach(d => {
                const x = d.data(), c = cursos.get(x.cursoId || d.id.split('__')[1]);
                if (!c) return;
                Object.values(x.alocacoes || {}).forEach(a => (a.aulas || []).forEach(au => {
                    if (ehContratar(au.professor)) return;
                    const achado = acharProfessor(lista, au.professor);
                    const k = achado && !achado.ambiguo ? normNome(achado.nome) : normNome(au.professor);
                    if (!c.professores.has(k)) {
                        const certo = achado && !achado.ambiguo;
                        c.professores.set(k, comOverride({ codfun: certo ? achado.codfun : null, nome: certo ? achado.nome : au.professor, titulacao: achado ? achado.titulacao : '', digitado: au.professor }, ov));
                    }
                }));
            });
            // disciplinas sem professor (sem horário ou só "contratar"), contadas como na tela
            docsEdubox.forEach(m => {
                const c = cursos.get(m.cursoId);
                if (!c) return;
                const aloc = ((gSnap.docs.find(d => d.id === m.id) || { data: () => ({}) }).data().alocacoes) || {};
                const vistas = new Set();
                (m.turmas || []).forEach(t => (t.disciplinas || []).forEach(dd => {
                    if (dd.naoOfertada) return;
                    const aulas = ((aloc[`${t.codTurma}:${dd.codDisciplina}`] || {}).aulas) || [];
                    const kd = `${t.periodo}:${normNome(dd.nome)}`;   // turmas que estudam juntas não contam 2x
                    if (vistas.has(kd)) return;
                    vistas.add(kd);
                    if (!aulas.length || aulas.every(au => ehContratar(au.professor))) c.semProfessor++;
                }));
            });
        }
        // novo x veterano: o que o coordenador marcou no cadastro do professor vence o histórico do Edubox
        const marcados = new Map();   // cursoId → [{ nome, vinculo }]
        gSnap.forEach(d => {
            const x = d.data(), cid = x.cursoId || d.id.split('__')[1];
            Object.values(x.alocacoes || {}).forEach(a => (a.aulas || []).forEach(au => {
                if (!au.vinculo || ehContratar(au.professor)) return;
                if (!marcados.has(cid)) marcados.set(cid, []);
                marcados.get(cid).push({ nome: au.professor, vinculo: au.vinculo });
            }));
        });
        const marcadoDe = (cursoId, p) => {
            const lista = marcados.get(cursoId) || [];
            const nomes = [normNome(p.digitado || ''), normNome(p.nome)];
            const ex = lista.find(m => nomes.includes(normNome(m.nome)));
            if (ex) return ex.vinculo;
            // nome curto digitado no horário ("Silmara Pietro") → professor do Edubox ("SILMARA R. PIETROBELLI")
            const alvo = [{ nome: p.nome, toks: normNome(p.nome).split(' ') }];
            const curto = lista.find(m => { const a = acharProfessor(alvo, m.nome); return a && !a.ambiguo; });
            return curto ? curto.vinculo : null;
        };
        cursos.forEach(c => c.professores.forEach(p => {
            const auto = vinculoAuto(hist, c.cursoId, p.codfun, p.nome);
            const manual = marcadoDe(c.cursoId, p);
            p.vinculoEdubox = auto;
            p.vinculo = manual || auto;
            p.vinculoFonte = manual ? 'coordenador' : (auto ? 'edubox' : null);
        }));
        const out = [...cursos.values()].map(c => {
            const profs = [...c.professores.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
            const novos = profs.filter(p => p.vinculo === 'novo').length;
            const veteranos = profs.filter(p => p.vinculo === 'veterano').length;
            const n = (t) => profs.filter(p => p.titulacao === t).length;
            const cont = { doutor: n('Doutor'), mestre: n('Mestre'), especialista: n('Especialista'), graduado: n('Graduado') };
            cont.semTitulacao = profs.length - cont.doutor - cont.mestre - cont.especialista - cont.graduado;
            return { cursoId: c.cursoId, cursoNome: c.cursoNome, total: profs.length, ...cont, novos, veteranos, semProfessor: c.semProfessor, professores: profs };
        }).sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR'));
        res.json({ semestre, fonte: doEdubox ? 'edubox' : 'matrizes', erroEdubox: cd && !cd.ok ? cd.erro : null,
            historico: hist.ok ? { desde: hist.desde } : { erro: hist.erro }, cursos: out });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/matrizes?semestre=2027.1
router.get('/', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const semestres = await semestresDisponiveis();
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : (semestres[semestres.length - 1] || '');
        const escopo = await escopoDe(req);

        let cursos = [];
        let professores = [];
        let salas = [];
        let titulacoes = [];
        if (semestre) {
            const [docsEdubox, gSnap, tits] = await Promise.all([
                matrizesDoSemestre(semestre),
                db.collection('matrizes_grade').where('semestre', '==', semestre).get(),
                titulacoesComOverride(semestre)
            ]);
            titulacoes = tits;
            const grades = new Map();
            const nomes = new Set();
            const salasSet = new Map();
            gSnap.forEach(d => {
                grades.set(d.id, d.data());
                // salas: "M.A.1", "M.A. 1" e "m.a. 1" são a mesma sala — guarda uma só grafia
                const addSala = (x) => { const k = String(x).toLowerCase().replace(/[^a-z0-9]/g, ''); if (k && !salasSet.has(k)) salasSet.set(k, x); };
                Object.values(d.data().alocacoes || {}).forEach(a => (a.aulas || []).forEach(x => { nomes.add(x.professor); if (x.sala) addSala(x.sala); }));
                (d.data().ensalamento || []).forEach(g => Object.values(g.dias || {}).forEach(c => { if (c && c.sala) c.sala.split('/').forEach(p => addSala(p.trim())); }));
            });
            docsEdubox.forEach(m => {
                if (!podeVer(escopo, m.cursoId)) return;
                aplicarAjustes(m, grades.get(m.id));
                cursos.push({
                    id: m.id, cursoId: m.cursoId, cursoNome: m.cursoNome,
                    turmas: (m.turmas || []).sort((a, b) => a.periodo - b.periodo || a.nome.localeCompare(b.nome, 'pt-BR')),
                    grades: m.grades || [],
                    // períodos que estudam juntos, conforme os arquivos de horário (ex.: [[1,2],[3,4],[5]])
                    grupos: ((grades.get(m.id) || {}).grupos || []).map(g => (Array.isArray(g) ? g : g.periodos || [])),
                    // quadro do ensalamento: por grupo de turmas, o que acontece em cada dia (sala, EAD, protegida...)
                    ensalamento: (grades.get(m.id) || {}).ensalamento || [],
                    alocacoes: (grades.get(m.id) || {}).alocacoes || {}
                });
            });
            cursos.sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR'));
            professores = [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR'));
            salas = [...salasSet.values()].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
        }

        res.json({
            // dado do Edubox é consultado na hora: "atualizadoEm" é o momento desta consulta
            semestres, semestre, atualizadoEm: new Date().toISOString(),
            escopo: escopo === null ? 'todos' : 'cursos', cursos, professores, salas, titulacoes
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/matrizes/grade/:semestre/:cursoId/:turma/:disciplina  { aulas: [...] }
// Lista vazia remove o horário da disciplina.
router.put('/grade/:semestre/:cursoId/:turma/:disciplina', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const { semestre, cursoId, turma, disciplina } = req.params;
        if (!SEMESTRE.test(semestre)) return res.status(400).json({ error: 'Semestre inválido.' });
        const escopo = await escopoDe(req);
        if (!podeVer(escopo, cursoId)) return res.status(403).json({ error: 'Você não tem acesso a esse curso.' });

        const achado = await cursoComAjustes(semestre, cursoId);
        if (!achado) return res.status(404).json({ error: 'Curso/semestre não encontrado.' });
        const { m, docId } = achado;
        const t = (m.turmas || []).find(x => String(x.codTurma) === turma);
        const d = t && t.disciplinas.find(x => String(x.codDisciplina) === disciplina);
        if (!d) return res.status(404).json({ error: 'Disciplina não pertence a essa turma.' });

        let aulas;
        try { aulas = limparAulas(req.body.aulas); } catch (e) { return res.status(400).json({ error: e.message }); }

        const key = `${turma}:${disciplina}`;
        const ref = db.collection('matrizes_grade').doc(docId);
        const quem = { uid: req.user.uid, nome: req.user.name || req.user.email || '' };
        await ref.set({
            semestre, cursoId, cursoNome: m.cursoNome,
            alocacoes: { [key]: aulas.length
                ? { disciplina: d.nome, turma: t.nome, periodo: t.periodo, aulas, atualizadoEm: new Date().toISOString(), atualizadoPor: quem }
                : admin.firestore.FieldValue.delete() }
        }, { merge: true });

        let conflitos = [];
        if (aulas.length) {
            const todas = await db.collection('matrizes_grade').where('semestre', '==', semestre).get();
            conflitos = acharConflitos(aulas, todas.docs.map(x => ({ id: x.id, ...x.data() })), docId, key, d.nome);
        }
        res.json({ message: 'Horário salvo.', key, aulas, conflitos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- disciplina incluída no Órbita ---
async function prepararCurso(req, res) {
    const { semestre, cursoId } = req.params;
    if (!SEMESTRE.test(semestre)) { res.status(400).json({ error: 'Semestre inválido.' }); return null; }
    const escopo = await escopoDe(req);
    if (!podeVer(escopo, cursoId)) { res.status(403).json({ error: 'Você não tem acesso a esse curso.' }); return null; }
    const achado = await cursoComAjustes(semestre, cursoId);
    if (!achado) { res.status(404).json({ error: 'Curso/semestre não encontrado no Edubox.' }); return null; }
    return { ...achado, semestre, cursoId, quem: { uid: req.user.uid, nome: req.user.name || req.user.email || '' } };
}

// POST /api/matrizes/disciplina/:semestre/:cursoId  { nome, tipo, ch, turmas:[codTurma] }
router.post('/disciplina/:semestre/:cursoId', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const c = await prepararCurso(req, res);
        if (!c) return;
        let disc;
        try { disc = limparDisciplina(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
        const turmas = [...new Set((Array.isArray(req.body.turmas) ? req.body.turmas : []).map(String))];
        if (!turmas.length || turmas.some(t => !c.m.turmas.some(x => String(x.codTurma) === t))) return res.status(400).json({ error: 'Escolha a(s) turma(s) da disciplina.' });
        const id = 'M' + require('crypto').randomBytes(5).toString('hex');
        const reg = { ...disc, turmas, criadoPor: c.quem, criadoEm: new Date().toISOString() };
        await c.ref.set({ semestre: c.semestre, cursoId: c.cursoId, cursoNome: c.m.cursoNome, disciplinasManuais: { [id]: reg } }, { merge: true });
        res.status(201).json({ id, ...reg, message: 'Disciplina incluída.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/matrizes/disciplina/:semestre/:cursoId/:id  { nome, tipo, ch }
router.put('/disciplina/:semestre/:cursoId/:id', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const c = await prepararCurso(req, res);
        if (!c) return;
        const atual = ((await c.ref.get()).data() || {}).disciplinasManuais || {};
        if (!atual[req.params.id]) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        let disc;
        try { disc = limparDisciplina(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
        const reg = { ...atual[req.params.id], ...disc, atualizadoPor: c.quem, atualizadoEm: new Date().toISOString() };
        await c.ref.set({ disciplinasManuais: { [req.params.id]: reg } }, { merge: true });
        res.json({ id: req.params.id, ...reg, message: 'Disciplina atualizada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/matrizes/disciplina/:semestre/:cursoId/:id — tira a disciplina incluída (e o horário dela)
router.delete('/disciplina/:semestre/:cursoId/:id', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const c = await prepararCurso(req, res);
        if (!c) return;
        const g = (await c.ref.get()).data() || {};
        const reg = (g.disciplinasManuais || {})[req.params.id];
        if (!reg) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const del = admin.firestore.FieldValue.delete();
        const alocacoes = {};
        (reg.turmas || []).forEach(t => { if ((g.alocacoes || {})[`${t}:${req.params.id}`]) alocacoes[`${t}:${req.params.id}`] = del; });
        await c.ref.set({ disciplinasManuais: { [req.params.id]: del }, ...(Object.keys(alocacoes).length ? { alocacoes } : {}) }, { merge: true });
        res.json({ message: 'Disciplina excluída.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/matrizes/ajuste/:semestre/:cursoId/:turma/:disciplina — disciplina que veio do Edubox:
// { nome, tipo, ch } (alterar) e/ou { retirar: true } / { lancar: true }; { desfazer: true } apaga o ajuste.
router.put('/ajuste/:semestre/:cursoId/:turma/:disciplina', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const c = await prepararCurso(req, res);
        if (!c) return;
        const { turma, disciplina } = req.params;
        const t = c.m.turmas.find(x => String(x.codTurma) === turma);
        const d = t && t.disciplinas.find(x => String(x.codDisciplina) === disciplina && !x.manual);
        if (!d) return res.status(404).json({ error: 'Disciplina não pertence a essa turma.' });
        const key = `${turma}:${disciplina}`;
        if (req.body.desfazer) {
            await c.ref.set({ ajustesDisciplinas: { [key]: admin.firestore.FieldValue.delete() } }, { merge: true });
            return res.json({ key, ajuste: null, message: 'Alteração desfeita.' });
        }
        const orig = d.ajuste ? { nome: d.ajuste.nomeEdubox, tipo: d.ajuste.tipoEdubox, ch: d.ajuste.chEdubox } : { nome: d.nome, tipo: d.tipo, ch: d.ch };
        const aj = { por: c.quem, em: new Date().toISOString() };
        if (req.body.nome !== undefined) {
            let disc;
            try { disc = limparDisciplina(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
            if (disc.nome !== orig.nome) aj.nome = disc.nome;
            if (disc.tipo !== orig.tipo) aj.tipo = disc.tipo;
            if (CAMPOS_CH.concat('total').some(k => (disc.ch[k] || 0) !== ((orig.ch || {})[k] || 0))) aj.ch = disc.ch;
        }
        if (req.body.retirar) aj.retirar = true;
        if (req.body.lancar) aj.lancar = true;
        if (!aj.nome && !aj.tipo && !aj.ch && !aj.retirar && !aj.lancar) {
            await c.ref.set({ ajustesDisciplinas: { [key]: admin.firestore.FieldValue.delete() } }, { merge: true });
            return res.json({ key, ajuste: null, message: 'Nada mudou em relação ao Edubox.' });
        }
        // retirar do semestre: o horário dessa turma sai junto
        const extra = aj.retirar ? { alocacoes: { [key]: admin.firestore.FieldValue.delete() } } : {};
        await c.ref.set({ semestre: c.semestre, cursoId: c.cursoId, cursoNome: c.m.cursoNome, ajustesDisciplinas: { [key]: aj }, ...extra }, { merge: true });
        res.json({ key, ajuste: aj, message: 'Alteração salva.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
module.exports._interno = { limparAulas, acharConflitos, podeVer, limparDisciplina, aplicarAjustes };
