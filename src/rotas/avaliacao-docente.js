const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const COL = 'avaliacoesDocentes';

// Cursos da FATEC IVP — mesma lista usada em Usuários pra vincular o
// Coordenador a um curso. Fixa aqui (e não na coleção `courses` do
// Financeiro) pra não depender das permissões de Licitação/Matrículas só
// pra listar cursos dentro de Avaliação Docente.
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
    { id: 'medicina', name: 'Medicina' },
    { id: 'medicina-veterinaria', name: 'Medicina Veterinária' },
    { id: 'pedagogia', name: 'Pedagogia' },
    { id: 'psicologia', name: 'Psicologia' }
];

// As 10 perguntas fixas do questionário (escala 1-5 ou "na" = Não tenho
// elementos para avaliar). As perguntas 11 e 12 são abertas (`positivo` e
// `melhoria`) e não entram no cálculo da nota.
const PERGUNTAS = [
    'O professor demonstra domínio do conteúdo e transmite segurança ao desenvolver os temas da disciplina?',
    'O professor explica os conteúdos de forma clara, utilizando exemplos e estratégias que facilitam a compreensão e a aprendizagem?',
    'O professor relaciona os conteúdos da disciplina com situações práticas da profissão, do mercado de trabalho e da realidade regional?',
    'As aulas são planejadas, organizadas e aproveitam adequadamente o tempo destinado à aprendizagem?',
    'O professor utiliza metodologias, recursos tecnológicos e diferentes estratégias que tornam as aulas mais dinâmicas e estimulam o interesse dos alunos?',
    'O professor estimula a participação, o pensamento crítico, os questionamentos e o protagonismo dos alunos durante as aulas?',
    'O professor demonstra respeito, ética, disponibilidade e boa relação com os alunos, considerando diferentes níveis de conhecimento e ritmos de aprendizagem?',
    'As atividades, avaliações e orientações realizadas pelo professor contribuem para o desenvolvimento das competências necessárias à formação profissional?',
    'O professor demonstra abertura para ouvir os alunos, receber sugestões e aperfeiçoar sua forma de ensinar?',
    'De modo geral, o trabalho deste professor contribui efetivamente para sua aprendizagem e formação profissional?'
];

const VALORES_VALIDOS = ['1', '2', '3', '4', '5', 'na'];

// Cada pergunta é respondida como { valor: '1'..'5'|'na', obs: 'texto opcional' }.
// Valida que `respostas` tem as 10 perguntas, cada uma com valor válido.
function validarRespostas(respostas) {
    if (!respostas || typeof respostas !== 'object') return 'Respostas do questionário ausentes.';
    for (let n = 1; n <= PERGUNTAS.length; n++) {
        const resposta = respostas[`p${n}`];
        const valor = resposta && typeof resposta === 'object' ? resposta.valor : resposta;
        if (!VALORES_VALIDOS.includes(String(valor))) {
            return `Resposta inválida ou ausente para a pergunta ${n}.`;
        }
    }
    return null;
}

// Normaliza cada pergunta para { valor, obs } antes de salvar (aceita string
// solta por retrocompatibilidade com respostas salvas antes do campo obs existir).
function normalizarRespostas(respostas) {
    const normalizado = {};
    for (let n = 1; n <= PERGUNTAS.length; n++) {
        const resposta = respostas[`p${n}`];
        if (resposta && typeof resposta === 'object') {
            normalizado[`p${n}`] = { valor: String(resposta.valor), obs: resposta.obs || '' };
        } else {
            normalizado[`p${n}`] = { valor: String(resposta), obs: '' };
        }
    }
    return normalizado;
}

// Nota = média das respostas numéricas (1-5), ignorando "na". Se todas as
// perguntas foram marcadas "na", não há nota (null).
function calcularNota(respostas) {
    const valores = Object.values(respostas || {})
        .map(r => (r && typeof r === 'object' ? r.valor : r))
        .filter(v => v !== 'na')
        .map(Number)
        .filter(n => !isNaN(n));
    if (!valores.length) return null;
    return valores.reduce((a, b) => a + b, 0) / valores.length;
}

// Coordenador só enxerga/edita as avaliações que ele mesmo criou (uma
// "sessão" de avaliação por coordenador). Qualquer outro papel com acesso
// ao módulo (ADM N1/N2 no papel de Diretor Acadêmico) vê tudo — necessário
// pro Painel do Diretor comparar entre coordenadores/cursos.
function apenasProprias(role) {
    return role === 'coordenador';
}

// Busca o curso vinculado ao coordenador (definido em Usuários) — o
// coordenador NUNCA escolhe o curso na hora de avaliar, ele sempre avalia
// dentro do curso que o administrador vinculou ao cargo dele.
async function cursoDoCoordenador(uid) {
    const snap = await db.collection('users').doc(uid).get();
    const cursoId = snap.exists ? snap.data().curso : null;
    const curso = CURSOS.find(c => c.id === cursoId);
    return curso ? { cursoId: curso.id, curso: curso.name } : { cursoId: null, curso: '' };
}

// GET /api/avaliacao-docente/cursos — lista fixa de cursos, pra popular o
// seletor de curso da avaliação (só é editável pra quem não é coordenador).
router.get('/cursos', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    res.json(CURSOS);
});

// GET /api/avaliacao-docente/dashboard — agregados pro Painel do Diretor
// (ou pro próprio coordenador, restrito às suas avaliações).
router.get('/dashboard', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        let query = db.collection(COL);
        if (apenasProprias(req.user.role)) {
            query = query.where('criadoPor', '==', req.user.uid);
        }
        const snap = await query.get();
        const avaliacoes = snap.docs.map(d => d.data());

        const total = avaliacoes.length;
        const comNota = avaliacoes.filter(a => a.nota !== null && a.nota !== undefined);
        const mediaGeral = comNota.length
            ? comNota.reduce((soma, a) => soma + Number(a.nota), 0) / comNota.length
            : 0;

        const porCursoMap = new Map();
        avaliacoes.forEach(a => {
            const chave = a.curso || 'Sem curso';
            if (!porCursoMap.has(chave)) porCursoMap.set(chave, { curso: chave, total: 0, comNota: 0, soma: 0 });
            const entry = porCursoMap.get(chave);
            entry.total += 1;
            if (a.nota !== null && a.nota !== undefined) {
                entry.comNota += 1;
                entry.soma += Number(a.nota);
            }
        });
        const porCurso = [...porCursoMap.values()]
            .map(c => ({ curso: c.curso, total: c.total, media: c.comNota ? c.soma / c.comNota : 0 }))
            .sort((a, b) => b.media - a.media);

        res.json({ total, mediaGeral, porCurso });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/avaliacao-docente - Lista avaliações docentes
router.get('/', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        let query = db.collection(COL);
        if (apenasProprias(req.user.role)) {
            query = query.where('criadoPor', '==', req.user.uid);
        }
        const snap = await query.get();
        const avaliacoes = [];
        snap.forEach(doc => avaliacoes.push({ id: doc.id, ...doc.data() }));
        res.json(avaliacoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const SEMESTRES_VALIDOS = Array.from({ length: 10 }, (_, i) => String(i + 1));

// POST /api/avaliacao-docente — cadastro rápido: só docente + semestre.
// O questionário (as 12 perguntas) é respondido depois, pelo botão
// "Avaliar" na listagem, via PUT /:id/responder.
router.post('/', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const { docente, semestre } = req.body;
        if (!docente || !String(docente).trim()) return res.status(400).json({ error: 'Informe o nome do professor.' });
        if (!SEMESTRES_VALIDOS.includes(String(semestre))) return res.status(400).json({ error: 'Selecione um semestre válido (1 a 10).' });

        // Coordenador só pode lançar avaliação dentro do próprio curso
        // vinculado — o curso enviado pelo cliente é ignorado nesse caso.
        let cursoId = req.body.cursoId || null;
        let curso = req.body.curso || '';
        if (apenasProprias(req.user.role)) {
            const vinculo = await cursoDoCoordenador(req.user.uid);
            if (!vinculo.cursoId) {
                return res.status(403).json({ error: 'Seu usuário ainda não está vinculado a um curso. Peça a um administrador para vincular seu curso em Usuários.' });
            }
            cursoId = vinculo.cursoId;
            curso = vinculo.curso;
        }

        const newDoc = db.collection(COL).doc();
        await newDoc.set({
            docente: String(docente).trim(),
            semestre: String(semestre),
            cursoId,
            curso,
            status: 'pendente',
            respostas: null,
            nota: null,
            alunos: null,
            alunosNomes: [],
            positivo: '',
            melhoria: '',
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Coordenador',
            createdAt: new Date().toISOString()
        });
        res.status(201).json({ message: 'Avaliação cadastrada! Agora responda o questionário.', id: newDoc.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/avaliacao-docente/:id — edita os dados básicos (docente/semestre).
router.put('/:id', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const docRef = db.collection(COL).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode editar as avaliações que você mesmo criou.' });
        }

        const { docente, semestre } = req.body;
        if (!docente || !String(docente).trim()) return res.status(400).json({ error: 'Informe o nome do professor.' });
        if (!SEMESTRES_VALIDOS.includes(String(semestre))) return res.status(400).json({ error: 'Selecione um semestre válido (1 a 10).' });

        await docRef.update({
            docente: String(docente).trim(),
            semestre: String(semestre)
        });
        res.json({ message: 'Avaliação atualizada com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/avaliacao-docente/:id/responder — salva as respostas do
// questionário (as 12 perguntas) de uma avaliação já cadastrada.
router.put('/:id/responder', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const docRef = db.collection(COL).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode responder as avaliações que você mesmo criou.' });
        }

        const { respostas, positivo, melhoria, alunos, alunosNomes } = req.body;
        const erroRespostas = validarRespostas(respostas);
        if (erroRespostas) return res.status(400).json({ error: erroRespostas });

        const alunosNum = parseInt(alunos, 10);
        if (!Number.isInteger(alunosNum) || alunosNum < 1) {
            return res.status(400).json({ error: 'Informe a quantidade de alunos que participaram da avaliação.' });
        }

        // Nomes são opcionais por aluno — normaliza pro tamanho da turma
        // informada (trunca sobras, completa faltantes com string vazia).
        const nomesBrutos = Array.isArray(alunosNomes) ? alunosNomes : [];
        const nomesNormalizados = Array.from({ length: alunosNum }, (_, i) => String(nomesBrutos[i] || '').trim());

        await docRef.update({
            respostas: normalizarRespostas(respostas),
            nota: calcularNota(respostas),
            positivo: positivo || '',
            melhoria: melhoria || '',
            alunos: alunosNum,
            alunosNomes: nomesNormalizados,
            status: 'concluida'
        });
        res.json({ message: 'Questionário salvo com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/avaliacao-docente/:id
router.delete('/:id', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const docRef = db.collection(COL).doc(req.params.id);

        if (apenasProprias(req.user.role)) {
            const snap = await docRef.get();
            if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
            if (snap.data().criadoPor !== req.user.uid) {
                return res.status(403).json({ error: 'Você só pode remover as avaliações que você mesmo criou.' });
            }
        }

        await docRef.delete();
        res.json({ message: 'Avaliação removida com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
