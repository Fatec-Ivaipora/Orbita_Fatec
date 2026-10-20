const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { lerLivroDeNotas, unidadeFeita, ErroLivroNotas } = require('../utils/livroNotasAva');
const { casarComDiarios } = require('../utils/trilhaDiarios');
const { CODCUR } = require('./cpa')._interno;

// código do curso no Edubox (CADD) -> id do curso no Órbita
const CURSO_DO_CODCUR = Object.fromEntries(Object.entries(CODCUR).map(([id, cod]) => [cod, id]));

// ==========================================
// TRILHA EAD (Docência) — participação dos alunos nas unidades de
// aprendizagem do AVA (conteúdo SAGAH) e nota da Trilha EAD por bimestre.
//
// O EAD importa o livro de notas do Open LMS de cada disciplina/turma, quantas
// vezes quiser (cada importação substitui a anterior daquela turma). A tela
// mostra a participação, os rankings por curso e gera o arquivo Nome;Nota
// (0 a 3.0, com ponto) que o EAD lança no Edubox — este módulo NÃO grava
// nada no Edubox (19/10/2026).
//
// Acesso: EAD e ADM importam/excluem (nível 3); coordenador só visualiza
// (nível 2) e só os cursos vinculados a ele em users.cursos.
// Cada tutor do EAD vê e mexe só nas turmas que ele importou; o coordenador do
// EAD (chefe do setor, users.chefeDeSetor) vê e mexe em todas — regra só deste
// módulo (19/10/2026).
// ==========================================

const COL = 'trilha_ead_disciplinas';
const checkPermission = verifyToken.requireModulePermission('trilha-ead');

// Mesma lista de src/rotas/banco-provas.js / avaliacao-docente.js /
// usuarios/app.js — o id é o que fica gravado em users.cursos do coordenador.
const CURSOS = [
    { id: 'agronegocio', name: 'Agronegócio' },
    { id: 'agronomia', name: 'Agronomia' },
    { id: 'arquitetura-urbanismo', name: 'Arquitetura e Urbanismo' },
    { id: 'biomedicina', name: 'Biomedicina' },
    { id: 'contabeis', name: 'Ciências Contábeis' },
    { id: 'direito', name: 'Direito' },
    { id: 'rh', name: 'Recursos Humanos' },
    { id: 'enfermagem', name: 'Enfermagem' },
    { id: 'engenharia-civil', name: 'Engenharia Civil' },
    { id: 'fisioterapia', name: 'Fisioterapia' },
    { id: 'gestao-comercial', name: 'Gestão Comercial' },
    { id: 'gestao-financeira', name: 'Gestão Financeira' },
    { id: 'logistica', name: 'Logística' },
    { id: 'medicina', name: 'Medicina' },
    { id: 'medicina-veterinaria', name: 'Medicina Veterinária' },
    { id: 'pedagogia', name: 'Pedagogia' },
    { id: 'psicologia', name: 'Psicologia' }
];

const VE_TODOS_OS_CURSOS = ['adm_l1', 'adm_l2', 'ead'];

// null = todos os cursos; [] = nenhum
async function cursosVisiveis(req) {
    if (VE_TODOS_OS_CURSOS.includes(req.user.role)) return null;
    const snap = await db.collection('users').doc(req.user.uid).get();
    const d = snap.exists ? snap.data() : {};
    const ids = Array.isArray(d.cursos) && d.cursos.length ? d.cursos : (d.curso ? [d.curso] : []);
    return ids.filter(id => CURSOS.some(c => c.id === id));
}

// Tutor do EAD (sem ser o chefe do setor) só enxerga as turmas dele: devolve o
// uid pra filtrar, ou null quando enxerga as de todos os tutores.
function donoObrigatorio(req) {
    return req.user.role === 'ead' && req.user.chefeDeSetor !== true ? req.user.uid : null;
}
// dono = quem importou a turma pela primeira vez (turma antiga: quem importou)
const donoDe = d => d.donoUid || d.importadoPor || null;

// ---- Unidade marcada como concluída à mão (20/10/2026) ----
// O tutor marca "concluída" sem reimportar (ex.: o aluno fez e o AVA não
// registrou). Fica em `manuais` — { chaveDoAluno: { "7": { ava, por, em } } } —
// e é reaplicado a cada reimportação, então a decisão não se perde. `ava`
// guarda o valor que o AVA trouxe, pra voltar a ele se desmarcar.
const chaveAluno = a => (a.email || '').toLowerCase() || String(a.nome || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

function aplicarManuais(unidades, alunos, manuais) {
    alunos.forEach(a => {
        const doAluno = manuais[chaveAluno(a)];
        a.manuais = [];
        if (!doAluno) return;
        Object.keys(doAluno).forEach(n => {
            const j = unidades.findIndex(u => String(u.n) === String(n));
            if (j < 0) return;
            doAluno[n].ava = a.notas[j];   // valor atual do AVA, pra desmarcar voltar a ele
            a.notas[j] = 100;
            a.manuais.push(Number(n));
        });
    });
}

const validarSemestre = s => /^\d{4}\.[12]$/.test(s || '');
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function lerArquivo(req, res) {
    const { arquivoBase64, nomeArquivo } = req.body || {};
    if (!arquivoBase64 || !nomeArquivo) {
        res.status(400).json({ error: 'Envie o livro de notas exportado do AVA.' });
        return null;
    }
    const buffer = Buffer.from(String(arquivoBase64).replace(/^data:[^;]*;base64,/, ''), 'base64');
    if (!buffer.length) {
        res.status(400).json({ error: 'O arquivo enviado está vazio.' });
        return null;
    }
    return buffer;
}

// Resumo guardado junto (lista e ranking de cursos não precisam recalcular).
// Unidade "aberta" = alguém já tem valor nela no AVA; as que ninguém abriu
// ainda (o AVA libera aos poucos) não entram no denominador.
// Participação conta SÓ os alunos ativos da turma = os que estão no diário
// regular da disciplina no Edubox. DP/adaptação (matriculados em outra turma),
// quem trancou/desistiu e conta de professor no AVA ficam de fora (20/10/2026).
// Sem diário encontrado não dá pra saber quem é da turma: aí contam todos.
function alunosAtivos(livro, temDiario) {
    return temDiario ? livro.alunos.filter(a => a.diario) : livro.alunos;
}

function resumir(livro, temDiario = false) {
    const abertas = livro.unidades.map((_, j) => livro.alunos.some(a => a.notas[j] !== null));
    const nAbertas = abertas.filter(Boolean).length;
    const ativos = alunosAtivos(livro, temDiario);
    let feitas = 0;
    ativos.forEach(a => a.notas.forEach((v, j) => { if (abertas[j] && unidadeFeita(v)) feitas++; }));
    const possiveis = ativos.length * nAbertas;
    return {
        alunos: ativos.length,
        alunosNoAva: livro.alunos.length,
        unidades: livro.unidades.length,
        unidadesAbertas: nAbertas,
        feitas,
        possiveis,
        participacao: possiveis ? Math.round(feitas / possiveis * 1000) / 10 : null
    };
}

router.get('/cursos', verifyToken, checkPermission, async (req, res) => {
    try {
        const visiveis = await cursosVisiveis(req);
        res.json(visiveis === null ? CURSOS : CURSOS.filter(c => visiveis.includes(c.id)));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

const livroAlunoNome = (casado, i) => (casado._nomes || [])[i] || '';

// Diários do Edubox (via CADD) desta turma do AVA, resumidos pra tela.
function resumoDiarios(casado) {
    return {
        diarios: casado.diarios.map(d => ({ turma: d.turma, periodo: d.periodo, disciplina: d.disciplina, alunos: d.alunos.length })),
        naoEncontrados: casado.diarioDoAluno.filter(x => !x).length,
        foraDosDiarios: casado.ondeEsta
            .map((onde, i) => (onde ? { nome: livroAlunoNome(casado, i), nomeEdubox: casado.nomeEdubox[i], ondeEsta: onde, matricula: casado.situacaoMatricula[i] } : null))
            .filter(Boolean),
        cursoSugerido: casado.codcurs.length === 1 ? (CURSO_DO_CODCUR[casado.codcurs[0]] || null) : null
    };
}

// Lê o arquivo SEM gravar — a tela mostra o que foi encontrado antes de salvar.
router.post('/previa', verifyToken, checkPermission, async (req, res) => {
    try {
        const buffer = lerArquivo(req, res);
        if (!buffer) return;
        const livro = lerLivroDeNotas(buffer, req.body.nomeArquivo);
        const casado = validarSemestre(req.body.semestre) ? await casarComDiarios(db, req.body.semestre, livro) : null;
        if (casado) {
            casado._nomes = livro.alunos.map(a => a.nome);
            livro.alunos.forEach((a, i) => { a.diario = casado.diarioDoAluno[i]; });
        }
        res.json({
            disciplina: livro.disciplina,
            codigoAva: livro.codigoAva,
            unidades: livro.unidades,
            resumo: resumir(livro, !!(casado && casado.diarios.length)),
            ...(casado ? resumoDiarios(casado) : { diarios: [], naoEncontrados: null, cursoSugerido: null })
        });
    } catch (err) {
        if (err instanceof ErroLivroNotas) return res.status(422).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Importa (ou reimporta) o livro de notas de uma disciplina/turma.
router.post('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const buffer = lerArquivo(req, res);
        if (!buffer) return;
        const { semestre, cursoId } = req.body;
        const turma = String(req.body.turma || '').trim().slice(0, 40);
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Escolha o semestre.' });
        const curso = CURSOS.find(c => c.id === cursoId);
        if (!curso) return res.status(400).json({ error: 'Escolha o curso da disciplina.' });

        const livro = lerLivroDeNotas(buffer, req.body.nomeArquivo);
        // de qual diário do Edubox é cada aluno (turmas juntas no AVA = vários diários)
        const casado = await casarComDiarios(db, semestre, livro);
        livro.alunos.forEach((a, i) => {
            a.diario = casado.diarioDoAluno[i];
            if (casado.nomeEdubox[i]) a.nomeEdubox = casado.nomeEdubox[i];   // nome social no AVA ≠ nome civil no Edubox
            // fora dos diários: em que turma(s) do Edubox ele está, pro tutor lançar à mão
            if (!a.diario) {
                a.ondeEsta = casado.ondeEsta[i] || [];
                a.matricula = casado.situacaoMatricula[i] || null;   // ex.: Trancou no semestre
            }
        });
        const disciplina = String(req.body.disciplina || livro.disciplina).trim().slice(0, 120);
        if (!disciplina) return res.status(400).json({ error: 'Informe o nome da disciplina.' });

        // Mesma turma do AVA no mesmo semestre = mesmo documento (reimportar atualiza).
        const id = [semestre, livro.codigoAva || slug(disciplina), slug(turma) || 'sem-turma'].join('_').replace(/\./g, '-');
        const ref = db.collection(COL).doc(id);
        const atual = await ref.get();
        const soDono = donoObrigatorio(req);
        if (atual.exists && soDono && donoDe(atual.data()) !== soDono) {
            const nome = atual.data().donoNome || atual.data().importadoPorNome || 'outro tutor';
            return res.status(403).json({ error: `Essa turma foi importada por ${nome}. Peça pra essa pessoa atualizar ou fale com o coordenador do EAD.` });
        }
        const agora = new Date().toISOString();
        // marcações manuais da importação anterior continuam valendo
        const manuais = atual.exists ? (atual.data().manuais || {}) : {};
        aplicarManuais(livro.unidades, livro.alunos, manuais);
        const dados = {
            semestre,
            cursoId: curso.id,
            curso: curso.name,
            turma,
            disciplina,
            codigoAva: livro.codigoAva,
            nomeArquivo: String(req.body.nomeArquivo).slice(0, 180),
            unidades: livro.unidades,
            alunos: livro.alunos,
            diarios: casado.diarios,
            manuais,
            resumo: resumir(livro, casado.diarios.length > 0),
            importadoPor: req.user.uid,
            importadoPorNome: req.user.name || req.user.email || '',
            // o tutor dono continua o mesmo quando o coordenador do EAD reimporta
            donoUid: atual.exists ? (donoDe(atual.data()) || req.user.uid) : req.user.uid,
            donoNome: atual.exists ? (atual.data().donoNome || atual.data().importadoPorNome || '') : (req.user.name || req.user.email || ''),
            importadoEm: agora,
            criadoEm: atual.exists ? (atual.data().criadoEm || agora) : agora,
            importacoes: (atual.exists ? (atual.data().importacoes || 1) : 0) + 1
        };
        await ref.set(dados);
        res.status(atual.exists ? 200 : 201).json({ id, ...dados, reimportado: atual.exists });
    } catch (err) {
        if (err instanceof ErroLivroNotas) return res.status(422).json({ error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// Todas as turmas importadas do semestre (com os alunos — o ranking de alunos
// por curso é montado na tela). Só lê quando a pessoa escolhe o semestre.
router.get('/', verifyToken, checkPermission, async (req, res) => {
    try {
        const { semestre } = req.query;
        if (!validarSemestre(semestre)) return res.status(400).json({ error: 'Informe o semestre (ex.: 2026.2).' });
        const visiveis = await cursosVisiveis(req);
        if (visiveis !== null && !visiveis.length) return res.json([]);
        const soDono = donoObrigatorio(req);
        const snap = await db.collection(COL).where('semestre', '==', semestre).get();
        const lista = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(d => visiveis === null || visiveis.includes(d.cursoId))
            .filter(d => !soDono || donoDe(d) === soDono)
            .sort((a, b) => a.curso.localeCompare(b.curso, 'pt-BR') || a.disciplina.localeCompare(b.disciplina, 'pt-BR'));
        res.json(lista);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Marca/desmarca uma unidade como concluída à mão pra um aluno.
// corpo: { indice, nome, ua, concluida }
router.patch('/:id/manual', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const atual = await ref.get();
        if (!atual.exists) return res.status(404).json({ error: 'Turma não encontrada.' });
        const t = atual.data();
        const soDono = donoObrigatorio(req);
        if (soDono && donoDe(t) !== soDono) return res.status(403).json({ error: 'Só quem importou a turma (ou o coordenador do EAD) pode marcar.' });

        const { indice, nome, ua, concluida } = req.body || {};
        const aluno = t.alunos[indice];
        if (!aluno || aluno.nome !== nome) return res.status(409).json({ error: 'A lista de alunos mudou — atualize a tela e tente de novo.' });
        const j = t.unidades.findIndex(u => String(u.n) === String(ua));
        if (j < 0) return res.status(400).json({ error: 'Unidade não encontrada nesta turma.' });

        const manuais = t.manuais || {};
        const k = chaveAluno(aluno);
        const doAluno = manuais[k] || {};
        aluno.manuais = aluno.manuais || [];
        if (concluida) {
            if (!doAluno[ua]) doAluno[ua] = { ava: aluno.notas[j] };
            doAluno[ua].por = req.user.name || req.user.email || '';
            doAluno[ua].em = new Date().toISOString();
            aluno.notas[j] = 100;
            if (!aluno.manuais.includes(Number(ua))) aluno.manuais.push(Number(ua));
        } else if (doAluno[ua]) {
            aluno.notas[j] = doAluno[ua].ava === undefined ? null : doAluno[ua].ava;
            delete doAluno[ua];
            aluno.manuais = aluno.manuais.filter(n => String(n) !== String(ua));
        }
        if (Object.keys(doAluno).length) manuais[k] = doAluno; else delete manuais[k];

        const atualizacao = {
            alunos: t.alunos,
            manuais,
            resumo: resumir({ unidades: t.unidades, alunos: t.alunos }, (t.diarios || []).length > 0),
            atualizadoEm: new Date().toISOString()
        };
        await ref.update(atualizacao);
        res.json({ id: atual.id, ...t, ...atualizacao });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL).doc(req.params.id);
        const atual = await ref.get();
        if (!atual.exists) return res.status(404).json({ error: 'Turma não encontrada.' });
        const soDono = donoObrigatorio(req);
        if (soDono && donoDe(atual.data()) !== soDono) return res.status(403).json({ error: 'Só quem importou a turma (ou o coordenador do EAD) pode excluir.' });
        await ref.delete();
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
