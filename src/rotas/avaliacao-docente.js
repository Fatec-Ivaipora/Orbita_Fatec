const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');

const COL = 'avaliacoesDocentes';
const CICLOS_COL = 'ciclosAvaliacao';

function isAdmin(role) {
    return role === 'adm_l1' || role === 'adm_l2';
}

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

// Busca os cursos vinculados ao coordenador (definidos em Usuários) — um
// coordenador pode responder por mais de um curso, então isso é sempre uma
// lista. Se só tem 1 vinculado, a avaliação usa esse automaticamente; se
// tem mais de 1, o coordenador escolhe qual dos seus cursos na hora de
// avaliar (nunca um curso fora da própria lista).
// `curso` (singular) é o campo antigo de antes dessa mudança — mantido só
// pra não perder o vínculo de quem foi cadastrado antes da migração.
async function cursosDoCoordenador(uid) {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return [];
    const data = snap.data();
    const idsBrutos = Array.isArray(data.cursos) && data.cursos.length
        ? data.cursos
        : (data.curso ? [data.curso] : []);
    return idsBrutos
        .map(id => CURSOS.find(c => c.id === id))
        .filter(Boolean)
        .map(c => ({ cursoId: c.id, curso: c.name }));
}

// GET /api/avaliacao-docente/cursos — lista fixa de cursos, pra popular o
// seletor de curso da avaliação (só é editável pra quem não é coordenador).
router.get('/cursos', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    res.json(CURSOS);
});

// ==========================================
// CICLOS DE AVALIAÇÃO (ex.: "2026.2") — criados só pelo ADM N1/N2, e
// escolhidos pelo coordenador na hora de cadastrar a avaliação. É o que dá
// pro Diretor Acadêmico filtrar o Painel por período letivo.
// ==========================================

// GET /api/avaliacao-docente/ciclos — qualquer papel com acesso ao módulo
// pode listar (precisa pra popular o seletor tanto do coordenador quanto
// do filtro do Painel do Diretor).
router.get('/ciclos', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const snap = await db.collection(CICLOS_COL).orderBy('nome', 'desc').get();
        const ciclos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        res.json(ciclos);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/avaliacao-docente/ciclos — só ADM N1/N2 cria (coordenador só
// escolhe entre os que já existem).
router.post('/ciclos', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        if (!isAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Apenas administradores podem criar ciclos de avaliação.' });
        }
        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome do ciclo (ex.: 2026.2).' });

        const existente = await db.collection(CICLOS_COL).where('nome', '==', nome).limit(1).get();
        if (!existente.empty) return res.status(400).json({ error: `O ciclo "${nome}" já existe.` });

        const newDoc = db.collection(CICLOS_COL).doc();
        await newDoc.set({ nome, createdAt: new Date().toISOString(), createdBy: req.user.uid });
        res.status(201).json({ message: 'Ciclo criado com sucesso!', id: newDoc.id, nome });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/avaliacao-docente/ciclos/:id — só ADM N1/N2.
router.delete('/ciclos/:id', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        if (!isAdmin(req.user.role)) {
            return res.status(403).json({ error: 'Apenas administradores podem remover ciclos de avaliação.' });
        }
        await db.collection(CICLOS_COL).doc(req.params.id).delete();
        res.json({ message: 'Ciclo removido com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
        snap.forEach(doc => avaliacoes.push(formatarAvaliacao(doc.id, doc.data())));
        res.json(avaliacoes);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const SEMESTRES_VALIDOS = Array.from({ length: 10 }, (_, i) => String(i + 1));

// Normalmente uma avaliação cobre um único semestre, mas em casos
// específicos (ex.: mesma turma avaliada num período que abrange mais de um
// semestre) o cadastro aceita vários de uma vez — por isso `semestre` é
// sempre armazenado como array, mesmo quando só tem um item. Aceita tanto
// array quanto valor solto (retrocompatibilidade com o corpo antigo da
// requisição) e retorna null se estiver vazio ou tiver algum valor inválido.
function normalizarSemestres(input) {
    const bruto = Array.isArray(input) ? input : (input !== undefined && input !== null && input !== '' ? [input] : []);
    const unicos = [...new Set(bruto.map(String))];
    if (!unicos.length || !unicos.every(s => SEMESTRES_VALIDOS.includes(s))) return null;
    return unicos.sort((a, b) => Number(a) - Number(b));
}

// Registros antigos guardam `semestre` como string única — normaliza pra
// array na leitura, pra front nunca precisar tratar os dois formatos.
function formatarAvaliacao(id, data) {
    const semestre = Array.isArray(data.semestre) ? data.semestre : (data.semestre ? [String(data.semestre)] : []);
    return { id, ...data, semestre };
}

// POST /api/avaliacao-docente — cadastro rápido: só docente + semestre(s).
// O questionário (as 12 perguntas) é respondido depois, pelo botão
// "Avaliar" na listagem, via PUT /:id/responder.
router.post('/', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const { docente, semestre, cicloId } = req.body;
        if (!docente || !String(docente).trim()) return res.status(400).json({ error: 'Informe o nome do professor.' });
        const semestres = normalizarSemestres(semestre);
        if (!semestres) return res.status(400).json({ error: 'Selecione ao menos um período válido (1 a 10).' });

        if (!cicloId) return res.status(400).json({ error: 'Selecione o ciclo de avaliação.' });
        const cicloSnap = await db.collection(CICLOS_COL).doc(cicloId).get();
        if (!cicloSnap.exists) return res.status(400).json({ error: 'Ciclo de avaliação inválido.' });
        const ciclo = cicloSnap.data().nome;

        // Coordenador só pode lançar avaliação dentro de um dos próprios
        // cursos vinculados — o curso enviado pelo cliente é ignorado se não
        // bater com nenhum dos vínculos dele.
        let cursoId = req.body.cursoId || null;
        let curso = req.body.curso || '';
        if (apenasProprias(req.user.role)) {
            const vinculos = await cursosDoCoordenador(req.user.uid);
            if (!vinculos.length) {
                return res.status(403).json({ error: 'Seu usuário ainda não está vinculado a nenhum curso. Peça a um administrador para vincular seu(s) curso(s) em Usuários.' });
            }
            if (vinculos.length === 1) {
                cursoId = vinculos[0].cursoId;
                curso = vinculos[0].curso;
            } else {
                const escolhido = vinculos.find(v => v.cursoId === cursoId);
                if (!escolhido) {
                    return res.status(400).json({ error: 'Selecione um dos cursos vinculados ao seu cadastro.' });
                }
                curso = escolhido.curso;
            }
        }

        const newDoc = db.collection(COL).doc();
        await newDoc.set({
            docente: String(docente).trim(),
            semestre: semestres,
            cursoId,
            curso,
            cicloId,
            ciclo,
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

// PUT /api/avaliacao-docente/:id — edita os dados básicos (docente/período/ciclo).
router.put('/:id', verifyToken, verifyToken.requireModulePermission('avaliacao-docente'), async (req, res) => {
    try {
        const docRef = db.collection(COL).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode editar as avaliações que você mesmo criou.' });
        }

        const { docente, semestre, cicloId } = req.body;
        if (!docente || !String(docente).trim()) return res.status(400).json({ error: 'Informe o nome do professor.' });
        const semestres = normalizarSemestres(semestre);
        if (!semestres) return res.status(400).json({ error: 'Selecione ao menos um período válido (1 a 10).' });

        if (!cicloId) return res.status(400).json({ error: 'Selecione o ciclo de avaliação.' });
        const cicloSnap = await db.collection(CICLOS_COL).doc(cicloId).get();
        if (!cicloSnap.exists) return res.status(400).json({ error: 'Ciclo de avaliação inválido.' });

        await docRef.update({
            docente: String(docente).trim(),
            semestre: semestres,
            cicloId,
            ciclo: cicloSnap.data().nome
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
