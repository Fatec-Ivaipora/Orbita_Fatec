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
        // Só o professor, sem dia e horário ainda (10/11/2026): o coordenador define quem dá a aula antes
        // de fechar o horário (e a Secretaria Acadêmica já lança o professor no Edubox).
        if (!dia && !inicio && !fim) return { professor };
        if (!DIAS.includes(dia)) throw new Error(`Horário ${i + 1}: dia da semana inválido.`);
        if (!HORA.test(inicio) || !HORA.test(fim)) throw new Error(`Horário ${i + 1}: informe início e fim (HH:MM).`);
        if (minutos(fim) <= minutos(inicio)) throw new Error(`Horário ${i + 1}: o fim precisa ser depois do início.`);
        // sala (ensalamento): opcional; aceita "4", "M.A. 2", "LAB INFORMATICA 12" ou várias separadas por "/"
        const sala = String(a.sala || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        return sala ? { professor, dia, inicio, fim, sala } : { professor, dia, inicio, fim };
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
            if (!at || sem > at.sem || (sem === at.sem && NIVEL_TIT(p.titulacao) > NIVEL_TIT(at.tit))) m.set(k, { nome, sem, tit: p.titulacao });
        });
        return [...m.values()].map(p => ({ nome: p.nome, titulacao: ROTULO_TIT(p.tit) })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    } catch (e) {
        console.error('[matrizes] titulações:', e.message);
        return [];
    }
}

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

router.get('/titulacao', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : '';
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre.' });
        const escopo = await escopoDe(req);
        const [docsEdubox, cd] = await Promise.all([
            matrizesDoSemestre(semestre),
            relay(`/corpo-docente/lista?semestres=${encodeURIComponent(formatosEdubox(semestre).join(','))}`, { timeoutMs: 30000 }).catch(e => ({ ok: false, erro: e.message }))
        ]);
        const cursos = new Map(docsEdubox.filter(m => podeVer(escopo, m.cursoId)).map(m => [m.cursoId, { cursoId: m.cursoId, cursoNome: m.cursoNome, professores: new Map(), semProfessor: 0 }]));
        const doEdubox = cd && cd.ok && (cd.professores || []).length > 0;
        if (doEdubox) {
            cd.professores.forEach(p => {
                const c = cursos.get(cursoIdDe(String(p.codcur).trim()));
                if (!c) return;
                const k = String(p.codfun);
                if (!c.professores.has(k)) c.professores.set(k, { nome: p.nome, titulacao: ROTULO_TIT(p.titulacao), diarios: p.diarios });
            });
        } else {
            // planejamento: o que os coordenadores definiram nos horários deste semestre
            const [gSnap, tits] = await Promise.all([db.collection('matrizes_grade').where('semestre', '==', semestre).get(), titulacoesEdubox(semestre)]);
            const lista = tits.map(t => ({ ...t, toks: normNome(t.nome).split(' ') }));
            gSnap.forEach(d => {
                const x = d.data(), c = cursos.get(x.cursoId || d.id.split('__')[1]);
                if (!c) return;
                Object.values(x.alocacoes || {}).forEach(a => (a.aulas || []).forEach(au => {
                    if (ehContratar(au.professor)) return;
                    const achado = acharProfessor(lista, au.professor);
                    const k = achado && !achado.ambiguo ? normNome(achado.nome) : normNome(au.professor);
                    if (!c.professores.has(k)) c.professores.set(k, { nome: achado && !achado.ambiguo ? achado.nome : au.professor, titulacao: achado ? achado.titulacao : '', digitado: au.professor });
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
        const out = [...cursos.values()].map(c => {
            const profs = [...c.professores.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
            const n = (t) => profs.filter(p => p.titulacao === t).length;
            const cont = { doutor: n('Doutor'), mestre: n('Mestre'), especialista: n('Especialista'), graduado: n('Graduado') };
            cont.semTitulacao = profs.length - cont.doutor - cont.mestre - cont.especialista - cont.graduado;
            return { cursoId: c.cursoId, cursoNome: c.cursoNome, total: profs.length, ...cont, semProfessor: c.semProfessor, professores: profs };
        }).sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR'));
        res.json({ semestre, fonte: doEdubox ? 'edubox' : 'matrizes', erroEdubox: cd && !cd.ok ? cd.erro : null, cursos: out });
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
                titulacoesEdubox(semestre)
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
