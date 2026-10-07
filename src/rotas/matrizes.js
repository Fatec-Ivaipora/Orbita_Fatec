const express = require('express');
const router = express.Router();
const { admin, db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

// ==========================================================================
// Matrizes: o que cada curso estuda no semestre (vem do Edubox, ver
// scripts/matrizes-edubox-sync.js) + professor/dia/hora de cada disciplina,
// definidos pelo coordenador e que viram o horário de aula do curso.
//
// Coleções:
//   matrizes_edubox/{AAAA.S}__{cursoId}  só o script de sincronização grava
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

// GET /api/matrizes?semestre=2027.1
router.get('/', verifyToken, verifyToken.requireModulePermission('matrizes'), async (req, res) => {
    try {
        const sync = (await db.collection('config').doc('matrizes_sync').get()).data() || {};
        const semestres = sync.semestres || [];
        const semestre = SEMESTRE.test(req.query.semestre || '') ? req.query.semestre : (semestres[semestres.length - 1] || '');
        const escopo = await escopoDe(req);

        let cursos = [];
        let professores = [];
        let salas = [];
        if (semestre) {
            const [mSnap, gSnap] = await Promise.all([
                db.collection('matrizes_edubox').where('semestre', '==', semestre).get(),
                db.collection('matrizes_grade').where('semestre', '==', semestre).get()
            ]);
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
            mSnap.forEach(d => {
                const m = d.data();
                if (!podeVer(escopo, m.cursoId)) return;
                cursos.push({
                    id: d.id, cursoId: m.cursoId, cursoNome: m.cursoNome,
                    turmas: (m.turmas || []).sort((a, b) => a.periodo - b.periodo),
                    grades: m.grades || [],
                    // períodos que estudam juntos, conforme os arquivos de horário (ex.: [[1,2],[3,4],[5]])
                    grupos: ((grades.get(d.id) || {}).grupos || []).map(g => (Array.isArray(g) ? g : g.periodos || [])),
                    // quadro do ensalamento: por grupo de turmas, o que acontece em cada dia (sala, EAD, protegida...)
                    ensalamento: (grades.get(d.id) || {}).ensalamento || [],
                    alocacoes: (grades.get(d.id) || {}).alocacoes || {}
                });
            });
            cursos.sort((a, b) => a.cursoNome.localeCompare(b.cursoNome, 'pt-BR'));
            professores = [...nomes].sort((a, b) => a.localeCompare(b, 'pt-BR'));
            salas = [...salasSet.values()].sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
        }

        res.json({
            semestres, semestre, atualizadoEm: sync.atualizadoEm || null,
            escopo: escopo === null ? 'todos' : 'cursos', cursos, professores, salas
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

        const docId = `${semestre}__${cursoId}`;
        const mSnap = await db.collection('matrizes_edubox').doc(docId).get();
        if (!mSnap.exists) return res.status(404).json({ error: 'Curso/semestre não encontrado.' });
        const m = mSnap.data();
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

module.exports = router;
module.exports._interno = { limparAulas, acharConflitos, podeVer };
