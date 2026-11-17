const express = require('express');
const router = express.Router();
const { db, admin } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const { gerarMoodleXml } = require('../utils/moodleXml');
const { classificarAreaEnamed } = require('../utils/classificarAreaEnamed');

const COL_CATEGORIAS = 'banco_med_categorias';
const COL_QUESTOES = 'banco_med_questoes';
const COL_PROVAS = 'banco_med_provas';

const checkPermission = verifyToken.requireModulePermission('banco-med-fatec');

const DIFICULDADES_VALIDAS = ['facil', 'media', 'intermediaria', 'dificil'];
// 13/11/2026: sem 'multichoice_multipla' — toda questão da Medicina é de uma resposta (multichoice single do Open LMS)
const TIPOS_VALIDOS = ['multichoice_unica', 'verdadeiro_falso'];

// As 7 áreas de formação da Matriz de Referência do ENAMED — cortam
// transversalmente período/disciplina (ex.: "Ginecologia e Obstetrícia" tem
// questão em vários períodos), por isso é uma tag independente da categoria,
// usada só pra montar simulados ENAMED puxando de todo o banco de uma vez.
const AREAS_ENAMED = [
    'Clínica Médica',
    'Cirurgia',
    'Pediatria',
    'Ginecologia e Obstetrícia',
    'Saúde Mental',
    'Medicina de Família e Comunidade',
    'Medicina Preventiva e Social'
];

// Limite seguro de documento do Firestore (1 MiB) — mesmo padrão já usado
// no módulo Ferida para imagens comprimidas no navegador.
const MAX_IMG_BASE64 = 950000;

// Quem pode ver QUEM elaborou cada questão / navegar o banco por professor.
// Pedido explícito (14/09): "não é legal um professor ver o que o outro já
// cadastrou, é antiético — só o coordenador vê isso, o professor só
// consegue ver o que ele lançou e o que tem no banco disponível". O banco
// continua compartilhado (todo professor usa as questões de todo mundo pra
// montar prova), só a AUTORIA fica anônima pra quem não é coordenador/ADM.
function podeVerAutoria(role, user) {
    return role === 'adm_l1' || role === 'coord_medicina' || !!(user && user.avaliacoesMed);
}

// Tira os campos de autoria da questão antes de mandar pra quem não pode ver
// quem escreveu — a questão em si (enunciado/alternativas/etc.) continua
// visível, só não dá pra saber QUEM fez.
function anonimizarQuestao(q, role, user) {
    if (podeVerAutoria(role, user)) return q;
    const { elaboradoPor, criadoPor, criadoPorNome, professorNome, ...resto } = q;
    return resto;
}

// Resolve o período (1-12) da disciplina, pra gravar de forma denormalizada
// em cada questão — sem isso, filtrar o banco por período no GET /questoes
// exigiria ler a coleção inteira e cruzar com categorias no código (o custo
// de leitura que estávamos tentando evitar).
async function periodoDaCategoria(categoriaId) {
    if (!categoriaId) return null;
    const snap = await db.collection(COL_CATEGORIAS).doc(categoriaId).get();
    return snap.exists ? (snap.data().periodo ?? null) : null;
}

// Período + área ENAMED "padrão" da disciplina (campo areaEnamedPadrao em
// banco_med_categorias, setado uma vez via script de migração a partir da
// colinha disciplina→área). Usado pra sugerir a área automaticamente quando
// uma questão importada é resolvida ou uma questão nova não vem com área
// marcada manualmente — evita ter que marcar questão por questão.
// Sem acento, minúsculo — usado tanto pra normalizar o termo buscado quanto
// pra gerar os tokens de cada título.
function normalizarBusca(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .trim();
}

// Palavras do título (>=2 letras), sem repetir — guardadas em
// `tituloBuscaTokens` pra buscar com `array-contains`. Busca por PREFIXO do
// título inteiro não funcionava (a maioria dos títulos começa com "TBL -",
// "2025.1 -" etc., então a palavra procurada quase nunca é o início literal
// do título) — palavra exata em qualquer posição resolve isso. Limitação:
// só acha por palavra inteira (buscar "col" não acha "coluna"). Combina
// título + nome da disciplina — o professor busca "habilidades" esperando
// achar tanto pelo título da questão quanto pela disciplina "Habilidades
// Clínicas", não só uma coisa ou só a outra.
function tokensDeBusca(...textos) {
    return [...new Set(
        textos.filter(Boolean).flatMap(t => normalizarBusca(t).split(/[^a-z0-9]+/)).filter(w => w.length >= 2)
    )];
}

async function dadosDaCategoria(categoriaId) {
    if (!categoriaId) return { periodo: null, areaEnamedPadrao: null, nome: null };
    const snap = await db.collection(COL_CATEGORIAS).doc(categoriaId).get();
    if (!snap.exists) return { periodo: null, areaEnamedPadrao: null, nome: null };
    const v = snap.data();
    return { periodo: v.periodo ?? null, areaEnamedPadrao: v.areaEnamedPadrao ?? null, nome: v.nome ?? null };
}

function validarQuestao(body) {
    if (!body.titulo || !String(body.titulo).trim()) return 'Informe o título da questão.';
    if (!body.categoriaId) return 'Selecione a categoria/disciplina da questão.';
    if (!DIFICULDADES_VALIDAS.includes(body.dificuldade)) return 'Selecione uma dificuldade válida.';
    if (!TIPOS_VALIDOS.includes(body.tipoMoodle)) return 'Selecione um tipo de questão válido.';
    if (!body.enunciadoHtml || !String(body.enunciadoHtml).trim()) return 'Informe o enunciado da questão.';
    if (!body.justificativa || !String(body.justificativa).trim()) return 'Informe a justificativa da resposta correta.';
    if (!Array.isArray(body.alternativas) || body.alternativas.length < 2) return 'Informe pelo menos duas alternativas.';
    if (!body.alternativas.some(a => a.correta)) return 'Marque ao menos uma alternativa como correta.';
    if (body.tipoMoodle === 'multichoice_unica' && body.alternativas.filter(a => a.correta).length !== 1) {
        return 'Questão de alternativa única precisa ter exatamente uma alternativa correta.';
    }
    if (body.tipoMoodle === 'verdadeiro_falso' && body.alternativas.length !== 2) {
        return 'Questão Verdadeiro/Falso precisa ter exatamente duas alternativas (Verdadeiro e Falso).';
    }
    if (body.imagem && body.imagem.dataUrl && body.imagem.dataUrl.length > MAX_IMG_BASE64) {
        return 'Imagem grande demais mesmo após compressão. Tente uma imagem menor.';
    }
    if (body.areaEnamed && !AREAS_ENAMED.includes(body.areaEnamed)) {
        return 'Área ENAMED inválida.';
    }
    return null;
}

// ==========================================
// CATEGORIAS (disciplina / prova-modelo)
// ==========================================

router.get('/areas-enamed', verifyToken, checkPermission, async (req, res) => {
    res.json(AREAS_ENAMED);
});

// GET /professores — lista quem tem acesso ao banco (professor_medicina e
// coord_medicina), pro filtro "ver questões de um professor". Só quem pode
// ver autoria (coordenador/ADM) — um professor não navega o banco pelo nome
// de um colega específico, só pelas próprias questões ("Minhas questões",
// que não precisa dessa lista).
router.get('/professores', verifyToken, checkPermission, async (req, res) => {
    if (!podeVerAutoria(req.user.role, req.user)) return res.status(403).json({ error: 'Só a coordenação pode ver o banco por professor.' });
    try {
        const snap = await db.collection('users').where('role', 'in', ['professor_medicina', 'coord_medicina']).get();
        const extra = await db.collection('users').where('professorMedicina', '==', true).get();
        const professores = [...snap.docs, ...extra.docs.filter(d => !snap.docs.some(x => x.id === d.id))]
            .map(d => ({ uid: d.id, nome: d.data().name || d.data().email }))
            .sort((a, b) => a.nome.localeCompare(b.nome));
        res.json(professores);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.get('/categorias', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_CATEGORIAS).get();
        let categorias = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        // professor de Medicina vê só o banco das disciplinas que dá no semestre (13/11/2026)
        const prof = await disciplinasDoProfessor(req);
        if (prof) categorias = categorias.filter(c => prof.categoriaIds.includes(c.id));
        // Ordena por período (1º a 12º) e, dentro do mesmo período, por nome —
        // reflete a grade real do curso (série/semestre), não ordem alfabética solta.
        categorias.sort((a, b) => (a.periodo - b.periodo) || a.nome.localeCompare(b.nome));

        // Contagem de questões publicadas por disciplina — usa count() agregado
        // (não lê os documentos, só o total), pra mostrar na lista sem quebrar a
        // economia de leitura do banco.
        await Promise.all(categorias.map(async (c) => {
            const agg = await db.collection(COL_QUESTOES)
                .where('categoriaId', '==', c.id)
                .where('status', '==', 'publicada')
                .count().get();
            c.totalQuestoes = agg.data().count;
        }));

        res.json(categorias);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post('/categorias', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = String(req.body.nome || '').trim();
        const periodo = parseInt(req.body.periodo, 10);
        if (!nome) return res.status(400).json({ error: 'Informe o nome da disciplina.' });
        if (!Number.isInteger(periodo) || periodo < 1 || periodo > 12) {
            return res.status(400).json({ error: 'Selecione o período (1º a 12º) da disciplina.' });
        }

        const newDoc = db.collection(COL_CATEGORIAS).doc();
        await newDoc.set({
            nome,
            nomeBreve: req.body.nomeBreve ? String(req.body.nomeBreve).trim() : '',
            periodo,
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: new Date().toISOString()
        });
        res.status(201).json({ message: 'Categoria criada!', id: newDoc.id });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ==========================================
// QUESTÕES (banco compartilhado)
// ==========================================

// GET /questoes/contagem-dificuldade — total de questões publicadas por
// dificuldade, pro filtro do Banco de Questões mostrar "Fácil (23)" etc. Usa
// count() agregado (não lê os documentos), mesmo padrão da contagem por
// disciplina — não pesa na economia de leitura do banco.
router.get('/questoes/contagem-dificuldade', verifyToken, checkPermission, async (req, res) => {
    try {
        const contagens = {};
        const prof = await disciplinasDoProfessor(req);
        await Promise.all(DIFICULDADES_VALIDAS.map(async (dif) => {
            contagens[dif] = await contarPorDisciplinas(prof, q => q.where('dificuldade', '==', dif).where('status', '==', 'publicada'));
        }));
        res.json(contagens);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /questoes/contagem-area-enamed — total de questões publicadas por área
// ENAMED (mesmo padrão de count() agregado). Usado na aba "Questões ENAMED"
// pra mostrar quanto cada área já tem de conteúdo real, não só a referência
// estática de qual disciplina cai em qual área.
router.get('/questoes/contagem-area-enamed', verifyToken, checkPermission, async (req, res) => {
    try {
        const contagens = {};
        const prof = await disciplinasDoProfessor(req);
        await Promise.all(AREAS_ENAMED.map(async (area) => {
            contagens[area] = await contarPorDisciplinas(prof, q => q.where('areaEnamed', '==', area).where('status', '==', 'publicada'));
        }));
        res.json(contagens);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /questoes/contagem-professor — total de questões publicadas por quem
// criou (mesmo padrão count() agregado). Usado no relatório do coordenador
// pra ver quanto cada professor já contribuiu pro banco — só coordenação/ADM.
router.get('/questoes/contagem-professor', verifyToken, checkPermission, async (req, res) => {
    if (!podeVerAutoria(req.user.role, req.user)) return res.status(403).json({ error: 'Só a coordenação pode ver o relatório por professor.' });
    try {
        const professoresSnap = await db.collection('users').where('role', 'in', ['professor_medicina', 'coord_medicina']).get();
        const extraSnap = await db.collection('users').where('professorMedicina', '==', true).get();
        const contagens = [];
        await Promise.all([...professoresSnap.docs, ...extraSnap.docs.filter(d => !professoresSnap.docs.some(x => x.id === d.id))].map(async (d) => {
            const agg = await db.collection(COL_QUESTOES)
                .where('criadoPor', '==', d.id)
                .where('status', '==', 'publicada')
                .count().get();
            contagens.push({ uid: d.id, nome: d.data().name || d.data().email, total: agg.data().count });
        }));
        contagens.sort((a, b) => b.total - a.total);
        res.json(contagens);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /questoes — SEMPRE espera pelo menos um filtro (periodo, categoriaId
// ou status) vindo do cliente. O banco pode crescer bastante (importação do
// AVA traz dezenas por vez), então nunca lemos a coleção inteira aqui — só o
// pedaço que a tela realmente precisa mostrar naquele momento.
router.get('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        let query = db.collection(COL_QUESTOES);
        if (req.query.periodo) query = query.where('periodo', '==', parseInt(req.query.periodo, 10));
        // professor: uma consulta por disciplina DELE (nunca as demais) — mesmo formato de consulta que já existia
        const prof = await disciplinasDoProfessor(req);
        const soDisciplinas = prof ? (req.query.categoriaId ? prof.categoriaIds.filter(id => id === req.query.categoriaId) : prof.categoriaIds) : null;
        if (!prof && req.query.categoriaId) query = query.where('categoriaId', '==', req.query.categoriaId);
        if (req.query.areaEnamed) query = query.where('areaEnamed', '==', req.query.areaEnamed);
        if (req.query.dificuldade) query = query.where('dificuldade', '==', req.query.dificuldade);
        if (req.query.criadoPor) {
            // Quem não pode ver autoria só pode filtrar pelas PRÓPRIAS
            // questões ("Minhas questões") — nunca navegar pelo que um
            // colega específico cadastrou. IMPORTANTE: se não pode ver
            // autoria, o filtro é FORÇADO pro próprio uid (nunca cai pra
            // "sem filtro nenhum") — um criadoPor de outra pessoa (ou
            // qualquer valor incorreto vindo do cliente) nunca deve resultar
            // em ver o banco inteiro sem restrição nenhuma.
            const valor = podeVerAutoria(req.user.role, req.user) ? req.query.criadoPor : req.user.uid;
            query = query.where('criadoPor', '==', valor);
        }
        if (req.query.status) query = query.where('status', '==', req.query.status);
        if (req.query.busca) {
            // array-contains só aceita 1 valor — usa a primeira palavra
            // significativa do que foi digitado; o resto da frase (se
            // houver) é refinado em memória no cliente.
            const primeiraPalavra = normalizarBusca(req.query.busca).split(/[^a-z0-9]+/).find(w => w.length >= 2);
            if (primeiraPalavra) query = query.where('tituloBuscaTokens', 'array-contains', primeiraPalavra);
        }

        const docs = soDisciplinas
            ? (await Promise.all(soDisciplinas.map(id => query.where('categoriaId', '==', id).get()))).flatMap(sn => sn.docs)
            : (await query.get()).docs;
        let lista = docs.map(d => ({ id: d.id, ...d.data() }));
        let resp = null;
        if (prof) {
            resp = await categoriasComoResponsavel(req);
            // adjunto: só as próprias questões; responsável: todas as da disciplina dele
            lista = lista.filter(q => resp.has(q.categoriaId) || minhaQuestao(q, prof, req.user.uid));
        }
        const questoes = lista.map(q => (resp && resp.has(q.categoriaId) ? q : anonimizarQuestao(q, req.user.role, req.user)));
        questoes.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(questoes);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post('/questoes', verifyToken, checkPermission, async (req, res) => {
    try {
        const erro = validarQuestao(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const { titulo, categoriaId, dificuldade, tipoMoodle, enunciadoHtml, alternativas, justificativa, fonte, imagem, areaEnamed } = req.body;
        await exigeDisciplinaDoProfessor(req, categoriaId);
        const { periodo, areaEnamedPadrao, nome: nomeDaCategoria } = await dadosDaCategoria(categoriaId);

        const newDoc = db.collection(COL_QUESTOES).doc();
        await newDoc.set({
            titulo: String(titulo).trim(),
            tituloBusca: normalizarBusca(titulo),
            tituloBuscaTokens: tokensDeBusca(titulo, nomeDaCategoria),
            categoriaId,
            periodo,
            // Se o professor não marcou a área manualmente: usa a área padrão
            // da disciplina (colinha ENAMED) se ela tiver uma fixa, senão
            // tenta classificar pelo conteúdo (disciplina transversal).
            areaEnamed: areaEnamed || areaEnamedPadrao || classificarAreaEnamed(titulo, enunciadoHtml, justificativa),
            dificuldade,
            tipoMoodle,
            enunciadoHtml,
            alternativas: alternativas.map(a => ({ texto: String(a.texto || ''), correta: !!a.correta })),
            justificativa: justificativa || '',
            fonte: fonte || '',
            imagem: (imagem && imagem.dataUrl) ? { nome: imagem.nome || 'imagem', dataUrl: imagem.dataUrl } : null,
            status: 'publicada',
            elaboradoPor: req.user.name || req.user.email || 'Professor',
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        res.status(201).json({ message: 'Questão salva no banco!', id: newDoc.id });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.put('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_QUESTOES).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });

        const erro = validarQuestao(req.body);
        if (erro) return res.status(400).json({ error: erro });

        const { titulo, categoriaId, dificuldade, tipoMoodle, enunciadoHtml, alternativas, justificativa, fonte, imagem, areaEnamed } = req.body;
        await exigeDisciplinaDoProfessor(req, snap.data().categoriaId);
        await exigeDisciplinaDoProfessor(req, categoriaId);
        const { periodo, areaEnamedPadrao, nome: nomeDaCategoria } = await dadosDaCategoria(categoriaId);

        await docRef.update({
            titulo: String(titulo).trim(),
            tituloBusca: normalizarBusca(titulo),
            tituloBuscaTokens: tokensDeBusca(titulo, nomeDaCategoria),
            categoriaId,
            periodo,
            areaEnamed: areaEnamed || areaEnamedPadrao || classificarAreaEnamed(titulo, enunciadoHtml, justificativa),
            dificuldade,
            tipoMoodle,
            enunciadoHtml,
            alternativas: alternativas.map(a => ({ texto: String(a.texto || ''), correta: !!a.correta })),
            justificativa: justificativa || '',
            fonte: fonte || '',
            imagem: (imagem && imagem.dataUrl) ? { nome: imagem.nome || 'imagem', dataUrl: imagem.dataUrl } : null,
            updatedAt: new Date().toISOString()
        });
        // gabarito mudou: atualiza as avaliações da Correção de Provas que usam a questão
        const { gabaritoMed, propagarGabarito } = require('./correcao-provas')._interno;
        const gNovo = gabaritoMed({ alternativas: alternativas.map(a => ({ correta: !!a.correta })) });
        const avs = gNovo && gNovo !== gabaritoMed(snap.data()) ? await propagarGabarito(req.params.id, gNovo, req.user.name || req.user.email) : 0;
        res.json({ message: avs ? `Questão atualizada! (gabarito novo também em ${avs} avaliação(ões) da Correção de Provas)` : 'Questão atualizada!', avaliacoesAtualizadas: avs });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.delete('/questoes/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (ehProfessorRestrito(req.user)) {
            const sn = await db.collection(COL_QUESTOES).doc(req.params.id).get();
            if (!sn.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
            await exigeDisciplinaDoProfessor(req, sn.data().categoriaId);
        }
        await db.collection(COL_QUESTOES).doc(req.params.id).delete();
        res.json({ message: 'Questão removida do banco.' });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ==========================================
// IMPORTAÇÃO DO AVA (Moodle XML já parseado no navegador)
// ==========================================
// O parsing do XML acontece no cliente (DOMParser) — aqui só recebemos as
// questões já normalizadas pro nosso formato. Toda questão importada entra
// com status 'revisao_importacao' (nunca aparece no banco/prova até alguém
// confirmar manualmente a disciplina correta — pedido do professor: "põe
// numa fila de revisão").

function validarQuestaoImportada(q) {
    if (!q.titulo || !String(q.titulo).trim()) return 'Questão sem título.';
    if (!TIPOS_VALIDOS.includes(q.tipoMoodle)) return `Tipo de questão inválido para "${q.titulo}".`;
    if (!Array.isArray(q.alternativas) || q.alternativas.length < 2) return `Alternativas insuficientes em "${q.titulo}".`;
    if (!q.alternativas.some(a => a.correta)) return `Nenhuma alternativa correta identificada em "${q.titulo}".`;
    if (q.imagem && q.imagem.dataUrl && q.imagem.dataUrl.length > MAX_IMG_BASE64) return `Imagem grande demais em "${q.titulo}".`;
    return null;
}

// Normaliza título+enunciado pra comparação de duplicata: tira tag HTML,
// acento e espaço extra. Duas questões só contam como "a mesma" se título E
// enunciado baterem depois dessa normalização — evita falso-positivo entre
// questões parecidas mas com enunciados diferentes.
function normalizarComparacao(str) {
    return String(str || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}
function chaveDuplicata(q) {
    return `${normalizarComparacao(q.titulo)}|${normalizarComparacao(q.enunciadoHtml)}`;
}

router.post('/questoes/importar-lote', verifyToken, checkPermission, async (req, res) => {
    try {
        const categoriaSugeridaTexto = String(req.body.categoriaSugeridaTexto || '').trim();
        const questoesRecebidas = Array.isArray(req.body.questoes) ? req.body.questoes : [];
        if (!questoesRecebidas.length) return res.status(400).json({ error: 'Nenhuma questão encontrada nesse arquivo.' });

        // Todo o banco (publicada ou ainda em revisão) entra na comparação —
        // não faz sentido reimportar uma questão que já está esperando revisão.
        const existentesSnap = await db.collection(COL_QUESTOES).get();
        const chavesExistentes = new Set(existentesSnap.docs.map(d => chaveDuplicata(d.data())));

        const loteId = db.collection(COL_QUESTOES).doc().id;
        const erros = [];
        const duplicadas = [];
        const validas = [];

        questoesRecebidas.forEach(q => {
            const erro = validarQuestaoImportada(q);
            if (erro) { erros.push({ titulo: q.titulo || '(sem título)', motivo: erro }); return; }

            const chave = chaveDuplicata(q);
            if (chavesExistentes.has(chave)) { duplicadas.push(q.titulo || '(sem título)'); return; }
            chavesExistentes.add(chave); // pega duplicata repetida dentro do próprio arquivo também

            validas.push(q);
        });

        // Firestore aceita no máx. 500 operações por batch — corta em pedaços
        // por segurança (um arquivo de disciplina real dificilmente chega perto disso).
        for (let i = 0; i < validas.length; i += 400) {
            const pedaco = validas.slice(i, i + 400);
            const batch = db.batch();
            pedaco.forEach(q => {
                const ref = db.collection(COL_QUESTOES).doc();
                batch.set(ref, {
                    titulo: String(q.titulo).trim(),
                    tituloBusca: normalizarBusca(q.titulo),
                    tituloBuscaTokens: tokensDeBusca(q.titulo), // ainda sem disciplina (revisão) — o resolver soma o nome dela depois
                    categoriaId: null,
                    categoriaSugeridaTexto,
                    loteId,
                    dificuldade: DIFICULDADES_VALIDAS.includes(q.dificuldade) ? q.dificuldade : 'media',
                    tipoMoodle: q.tipoMoodle,
                    enunciadoHtml: q.enunciadoHtml || '',
                    alternativas: q.alternativas.map(a => ({ texto: String(a.texto || ''), correta: !!a.correta })),
                    justificativa: q.justificativa || '',
                    fonte: q.fonte || '',
                    imagem: (q.imagem && q.imagem.dataUrl) ? { nome: q.imagem.nome || 'imagem', dataUrl: q.imagem.dataUrl } : null,
                    status: 'revisao_importacao',
                    elaboradoPor: q.elaboradoPor || 'Importado do AVA',
                    criadoPor: req.user.uid,
                    criadoPorNome: req.user.name || req.user.email || 'Professor',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                });
            });
            await batch.commit();
        }

        res.status(201).json({ loteId, criadas: validas.length, duplicadas, erros });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// PUT /questoes/lote/:loteId/resolver — confirma a disciplina certa pra
// todas as questões daquele lote de importação de uma vez, e elas passam a
// aparecer no banco normal.
router.put('/questoes/lote/:loteId/resolver', verifyToken, checkPermission, async (req, res) => {
    try {
        const { categoriaId } = req.body;
        if (!categoriaId) return res.status(400).json({ error: 'Selecione a disciplina antes de confirmar.' });
        const { periodo, areaEnamedPadrao, nome: nomeDaCategoria } = await dadosDaCategoria(categoriaId);
        const tokensDaDisciplina = tokensDeBusca(nomeDaCategoria);

        const snap = await db.collection(COL_QUESTOES)
            .where('loteId', '==', req.params.loteId)
            .where('status', '==', 'revisao_importacao')
            .get();
        if (snap.empty) return res.status(404).json({ error: 'Lote de importação não encontrado (ou já resolvido).' });

        const batch = db.batch();
        // Questão importada do AVA nunca vem com área ENAMED (o Moodle não tem
        // esse campo). Se a disciplina escolhida tem área fixa, usa ela; se é
        // transversal (cobre várias áreas — Sistemas Morfofisiológicos,
        // Patologia Clínica etc.), tenta classificar cada questão pelo próprio
        // conteúdo (título+enunciado). Nem sempre acha uma área confiável —
        // aí fica em branco mesmo, o professor ajusta na mão se quiser.
        snap.docs.forEach(doc => {
            const q = doc.data();
            const areaEnamed = areaEnamedPadrao || classificarAreaEnamed(q.titulo, q.enunciadoHtml, q.justificativa);
            const dados = { categoriaId, periodo, areaEnamed, status: 'publicada', updatedAt: new Date().toISOString() };
            // soma as palavras do nome da disciplina às que já tinha (do
            // título) — busca por "habilidades" já acha por disciplina,
            // não só pelo título específico da questão.
            if (tokensDaDisciplina.length) dados.tituloBuscaTokens = admin.firestore.FieldValue.arrayUnion(...tokensDaDisciplina);
            batch.update(doc.ref, dados);
        });
        await batch.commit();

        res.json({ message: 'Disciplina confirmada!', atualizadas: snap.size });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE /questoes/lote/:loteId — descarta o lote inteiro (o professor
// decidiu que essas questões importadas não devem entrar no banco).
router.delete('/questoes/lote/:loteId', verifyToken, checkPermission, async (req, res) => {
    try {
        const snap = await db.collection(COL_QUESTOES)
            .where('loteId', '==', req.params.loteId)
            .where('status', '==', 'revisao_importacao')
            .get();
        if (snap.empty) return res.status(404).json({ error: 'Lote de importação não encontrado (ou já resolvido).' });

        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();

        res.json({ message: 'Lote descartado.', removidas: snap.size });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ==========================================
// PROVAS (privada por professor — só quem criou vê/mexe; o banco de
// questões continua compartilhado. Pedido do professor: "restrito a cada
// professor as provas que eu criei, só eu vejo, pra não ficar poluído a
// tela" — ADM N1 é a única exceção, mesmo bypass de todo módulo do sistema.)
// ==========================================

function apenasProprias(role) {
    return role !== 'adm_l1' && role !== 'coord_medicina';
}

router.get('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        let query = db.collection(COL_PROVAS);
        if (apenasProprias(req.user.role)) {
            query = query.where('criadoPor', '==', req.user.uid);
        }
        const snap = await query.get();
        const provas = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        provas.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        res.json(provas);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post('/provas', verifyToken, checkPermission, async (req, res) => {
    try {
        const nome = String(req.body.nome || '').trim();
        const semestre = String(req.body.semestre || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome da prova.' });
        if (!semestre) return res.status(400).json({ error: 'Informe o semestre de aplicação da prova (ex: 2026.1).' });

        // "disciplina" (padrão): prova de uma única disciplina, como sempre foi.
        // "enamed": simulado que cruza várias disciplinas/períodos, agrupado
        // pela área de formação do ENAMED em vez de uma categoria só.
        const tipo = req.body.tipo === 'enamed' ? 'enamed' : 'disciplina';
        if (ehProfessorRestrito(req.user)) {
            if (tipo === 'enamed') return res.status(403).json({ error: 'O simulado ENAMED usa o banco de todas as disciplinas: quem monta é a coordenação.' });
            await exigeDisciplinaDoProfessor(req, req.body.categoriaId);
        }
        if (tipo === 'enamed') {
            if (!req.body.areaEnamed || !AREAS_ENAMED.includes(req.body.areaEnamed)) {
                return res.status(400).json({ error: 'Selecione a área ENAMED da prova.' });
            }
        } else if (!req.body.categoriaId) {
            return res.status(400).json({ error: 'Selecione a categoria/disciplina da prova.' });
        }

        const newDoc = db.collection(COL_PROVAS).doc();
        await newDoc.set({
            nome,
            semestre,
            tipo,
            categoriaId: tipo === 'disciplina' ? req.body.categoriaId : null,
            areaEnamed: tipo === 'enamed' ? req.body.areaEnamed : null,
            questoesIds: Array.isArray(req.body.questoesIds) ? req.body.questoesIds : [],
            criadoPor: req.user.uid,
            criadoPorNome: req.user.name || req.user.email || 'Professor',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            exportacoes: []
        });
        res.status(201).json({ message: 'Prova criada!', id: newDoc.id });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.put('/provas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_PROVAS).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode editar as provas que você mesmo criou.' });
        }

        const nome = String(req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ error: 'Informe o nome da prova.' });
        if (req.body.categoriaId) await exigeDisciplinaDoProfessor(req, req.body.categoriaId);

        await docRef.update({
            nome,
            semestre: req.body.semestre !== undefined ? String(req.body.semestre).trim() : snap.data().semestre,
            categoriaId: req.body.categoriaId || snap.data().categoriaId,
            questoesIds: Array.isArray(req.body.questoesIds) ? req.body.questoesIds : snap.data().questoesIds,
            updatedAt: new Date().toISOString()
        });
        res.json({ message: 'Prova atualizada!' });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.delete('/provas/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_PROVAS).doc(req.params.id);
        if (apenasProprias(req.user.role)) {
            const snap = await docRef.get();
            if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
            if (snap.data().criadoPor !== req.user.uid) {
                return res.status(403).json({ error: 'Você só pode remover as provas que você mesmo criou.' });
            }
        }
        await docRef.delete();
        res.json({ message: 'Prova removida.' });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET /api/banco-med-fatec/provas/:id/exportar — gera o Moodle XML com as
// questões da prova, na ordem salva, e devolve como arquivo pra download.
router.get('/provas/:id/exportar', verifyToken, checkPermission, async (req, res) => {
    try {
        const docRef = db.collection(COL_PROVAS).doc(req.params.id);
        const snap = await docRef.get();
        if (!snap.exists) return res.status(404).json({ error: 'Prova não encontrada.' });
        if (apenasProprias(req.user.role) && snap.data().criadoPor !== req.user.uid) {
            return res.status(403).json({ error: 'Você só pode exportar as provas que você mesmo criou.' });
        }
        const prova = snap.data();

        if (!prova.questoesIds || !prova.questoesIds.length) {
            return res.status(400).json({ error: 'Esta prova ainda não tem nenhuma questão selecionada.' });
        }

        const questaoDocs = await Promise.all(
            prova.questoesIds.map(qid => db.collection(COL_QUESTOES).doc(qid).get())
        );
        const questoes = questaoDocs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() }));

        if (!questoes.length) {
            return res.status(400).json({ error: 'Nenhuma das questões desta prova foi encontrada no banco (podem ter sido removidas).' });
        }

        const xml = gerarMoodleXml(prova.nome, questoes);

        await docRef.update({
            exportacoes: [...(prova.exportacoes || []), {
                por: req.user.uid,
                porNome: req.user.name || req.user.email || 'Professor',
                em: new Date().toISOString()
            }]
        });

        const nomeArquivo = `${prova.nome.replace(/[^a-zA-Z0-9._ -]/g, '_')}.xml`;
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
        res.send(xml);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// ==========================================
// EDITOR PADRÃO NO BANCO (13/11/2026) — o "Nova Questão" e o editar do Banco usam o MESMO editor da montagem
// da avaliação (professor, unidade e objetivo do plano, caso clínico, pergunta, alternativas com feedback,
// feedback geral, referência, imagens/GIFs, checklist do padrão). Serve a todos que usam o Banco.
// ==========================================
const AV = () => require('./banco-med-avaliacoes')._interno;
const semestreAtual = () => { const d = new Date(); return `${d.getFullYear()}.${d.getMonth() >= 6 ? 2 : 1}`; };

// Professor de Medicina (13/11/2026): escreve questão só nas disciplinas que dá no semestre (diários do Edubox)
// e o nome dele vem do PERFIL — fica fixo no título "Prof. Nome – …", ninguém digita. Quem vê autoria
// (coordenação, ADM, responsável pelas avaliações) continua escolhendo professor e disciplina livremente.
function ehProfessorRestrito(user) { return (user.role === 'professor_medicina' || user.professorMedicina === true) && !podeVerAutoria(user.role, user); }
const perfilCache = new Map();
async function perfilProfessor(user) {
    const c = perfilCache.get(user.uid);
    if (c && Date.now() - c.em < 5 * 60000) return c.valor;
    const snap = await db.collection('users').doc(user.uid).get();
    // nomeEdubox (16/11/2026): quando o nome da conta difere do Edubox (ex.: "TATIANE BORZUK" x "Tatiane Borzuk da Fonseca")
    const nome = String((snap.exists && (snap.data().nomeEdubox || snap.data().name || snap.data().nome)) || user.name || '').replace(/\s+/g, ' ').trim();
    const { listaDisciplinas, normNome } = AV();
    const { fonte, disciplinas } = await listaDisciplinas(semestreAtual());
    const minhas = nome ? disciplinas.filter(d => d.professores.some(p => normNome(p) === normNome(nome))) : [];
    const valor = { restrito: true, nome, semestre: fonte, categoriaIds: minhas.map(d => d.categoriaId).filter(Boolean), disciplinas: minhas.map(d => d.nome) };
    perfilCache.set(user.uid, { em: Date.now(), valor });
    return valor;
}
// null = não é professor restrito (vê tudo); senão o perfil com as disciplinas dele
async function disciplinasDoProfessor(req) { return ehProfessorRestrito(req.user) ? perfilProfessor(req.user) : null; }
async function contarPorDisciplinas(prof, filtro) {
    if (!prof) return (await filtro(db.collection(COL_QUESTOES)).count().get()).data().count;
    const ns = await Promise.all(prof.categoriaIds.map(id => filtro(db.collection(COL_QUESTOES).where('categoriaId', '==', id)).count().get()));
    return ns.reduce((a, n) => a + n.data().count, 0);
}
async function exigeDisciplinaDoProfessor(req, categoriaId) {
    if (!ehProfessorRestrito(req.user)) return null;
    const p = await perfilProfessor(req.user);
    if (!p.categoriaIds.includes(String(categoriaId || ''))) {
        const e = new Error(`Você só tem acesso ao banco das disciplinas em que é professor(a) em ${p.semestre}.`); e.status = 403; throw e;
    }
    return p;
}
router.get('/eu-professor', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.json({ restrito: false });
        res.json(await perfilProfessor(req.user));
    } catch (err) { res.status(500).json({ error: 'Não consegui buscar suas disciplinas no Edubox agora. Tente de novo em instantes.' }); }
});

// ---------- Conferência CADAM do professor (13/11/2026) ----------
// O professor confere, no padrão da aula CADAM (+ português e ABNT), as questões DELE nas provas das disciplinas
// dele — em montagem ou já finalizadas. Nunca recebe as questões dos colegas. A Bia/coordenação conferem a prova
// inteira pela aba Avaliações.
const COL_AVALIACOES = 'banco_med_avaliacoes';
// cota do professor na prova (critérios da disciplina, definidos pela responsável) + quantas ele já fez
async function minhaParte(av, prof, uid, critCache) {
    if (!critCache.has(av.chave)) critCache.set(av.chave, db.collection('banco_med_criterios').doc(String(av.chave || '-')).get().then(s => (s.exists ? s.data() : {})).catch(() => ({})));
    const crit = await critCache.get(av.chave);
    const n = AV().normNome;
    const ent = Object.entries(crit.porProfessor || {}).find(([nome]) => n(nome) === n(prof.nome));
    const ids = av.questoesIds || [];
    const docs = ids.length ? await db.getAll(...ids.map(id => db.collection(COL_QUESTOES).doc(id))) : [];
    const feitas = docs.filter(d => d.exists && minhaQuestao(d.data(), prof, uid)).length;
    return { meta: ent ? Number(ent[1]) : null, feitas, qtdProva: crit.qtdQuestoes || null };
}
const minhaQuestao = (q, prof, uid) => AV().normNome(q.professorNome || q.elaboradoPor) === AV().normNome(prof.nome) || (!q.professorNome && q.criadoPor === uid);
router.get('/conferencia', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'A coordenação confere a prova inteira pela aba Avaliações.' });
        const prof = await perfilProfessor(req.user);
        const snaps = await Promise.all(prof.categoriaIds.map(id => db.collection(COL_AVALIACOES).where('categoriaId', '==', id).get()));
        const critCache = new Map();
        const todas = snaps.flatMap(sn => sn.docs).map(d => ({ id: d.id, ...d.data() }));
        // datas do calendário (Aplicação de Provas): disciplina + etapa (b1/b2 = 1ª chamada do bimestre; sub = 2ª chamada)
        const n = AV().normNome;
        const cal = {};
        (await db.collection('med_aplicacao_provas').where('semestre', '==', prof.semestre).get()).docs.forEach(d => {
            const p = d.data(); const k = `${n(p.disciplina)}|${p.etapa}`; if (!cal[k] || p.data < cal[k]) cal[k] = p.data;
        });
        const dataDe = (a, chamada) => cal[`${n(a.disciplina)}|${a.tipo === 'exame' || chamada === 'exame' ? 'exame' : chamada === 2 ? 'sub' : 'b' + a.bimestre}`] || null;
        // 2ª chamada pronta = questões dele na avaliação de 2ª chamada (se já existe) + as marcadas "2ª chamada" no banco da disciplina
        const reservaCache = new Map();
        const reservaUso = async (a, uso) => {
            const k = `${a.categoriaId}|${a.semestre}`;
            if (!reservaCache.has(k)) reservaCache.set(k, db.collection(COL_QUESTOES).where('categoriaId', '==', a.categoriaId).where('usoProva', 'in', ['c2', 'exame']).get()
                .then(sn => sn.docs.map(d => ({ id: d.id, ...d.data() })).filter(q => q.status === 'publicada' && (!q.semestre || q.semestre === a.semestre))));
            return (await reservaCache.get(k)).filter(q => q.usoProva === uso && (uso === 'exame' || !q.bimestre || q.bimestre === a.bimestre) && minhaQuestao(q, prof, req.user.uid));
        };
        const reserva2 = (a) => reservaUso(a, 'c2');
        const lista = (await Promise.all(todas.map(async a => {
            const parte = await minhaParte(a, prof, req.user.uid, critCache);
            const item = { id: a.id, tipo: a.tipo || '', disciplina: a.disciplina, sigla: a.sigla, semestre: a.semestre, bimestre: a.bimestre, chamada: a.chamada, status: a.status, totalProva: (a.questoesIds || []).length, ...parte, envio: (a.envios || {})[AV().chaveEnvio(prof.nome)] || null, data: dataDe(a, a.chamada) };
            // exame: na 1ª chamada do 2º bimestre, mostra também o que ele já deixou pronto para o exame
            if (a.tipo !== 'exame' && a.chamada === 1 && a.bimestre === 2) {
                const avE = todas.find(x => x.chave === a.chave && x.semestre === a.semestre && x.tipo === 'exame');
                const resE = await reservaUso(a, 'exame');
                const idsE = new Set((avE && avE.questoesIds) || []);
                const naE = avE ? (await minhaParte(avE, prof, req.user.uid, critCache)).feitas : 0;
                item.exame = { meta: parte.meta, feitas: naE + resE.filter(q => !idsE.has(q.id)).length, avaliacaoId: avE ? avE.id : null, data: dataDe(a, 'exame') };
            }
            if (a.tipo !== 'exame' && a.chamada !== 2) {
                const av2 = todas.find(x => x.tipo !== 'exame' && x.chave === a.chave && x.semestre === a.semestre && x.bimestre === a.bimestre && x.chamada === 2);
                const res = await reserva2(a);
                let naAv2 = 0;
                if (av2) { const p2 = await minhaParte(av2, prof, req.user.uid, critCache); naAv2 = p2.feitas; }
                const ids2 = new Set((av2 && av2.questoesIds) || []);
                item.segunda = { meta: parte.meta, feitas: naAv2 + res.filter(q => !ids2.has(q.id)).length, avaliacaoId: av2 ? av2.id : null, data: dataDe(a, 2) };
            }
            return item;
        }))).sort((a, b) => String(b.semestre).localeCompare(String(a.semestre)) || (b.bimestre - a.bimestre) || (a.chamada - b.chamada) || String(a.disciplina).localeCompare(String(b.disciplina)));
        res.json({ professor: prof.nome, semestre: prof.semestre, avaliacoes: lista });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
// O professor sinaliza que subiu as questões dele no banco do AVA e no questionário (16/11/2026)
router.put('/conferencia/:id/envio', verifyToken, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'Só o professor marca o envio das questões dele.' });
        const etapa = req.body.etapa;
        if (!['bancoAva', 'questionario'].includes(etapa)) return res.status(400).json({ error: 'Etapa inválida.' });
        const ref = db.collection(COL_AVALIACOES).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
        const prof = await exigeDisciplinaDoProfessor(req, snap.data().categoriaId);
        const k = AV().chaveEnvio(prof.nome);
        const valor = req.body.feito ? { feito: true, em: new Date().toISOString() } : { feito: false, em: null };
        await ref.update(new admin.firestore.FieldPath('envios', k, 'professor'), prof.nome, new admin.firestore.FieldPath('envios', k, etapa), valor);
        res.json({ message: req.body.feito ? (etapa === 'bancoAva' ? 'Marcado: subiu no banco de questões do AVA.' : 'Marcado: está no questionário do AVA.') : 'Marcação desfeita.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
// XML do professor, um arquivo por prova (17/11/2026): antes o botão da 1ª chamada levava junto as "a mais" da
// disciplina (2ª chamada, exame, dependência, adaptação) e o professor recebia questão de outras provas no mesmo
// arquivo. Agora a tela mostra um botão por grupo ("1ª chamada", "2ª chamada", "Exame"...) e cada um baixa só o seu.
//   ?resumo=1  → só diz quais grupos ele tem e quantas questões (sem baixar nada, sem marcar nada)
//   ?uso=c2    → baixa só aquele grupo; sem ?uso = o grupo da própria prova
// Grupo da própria prova = as questões dele nesta avaliação. Outro grupo = as dele na avaliação irmã (mesma disciplina
// e semestre; 2ª chamada do mesmo bimestre, exame). Reserva do banco (questão marcada 2ª chamada/exame fora de
// qualquer prova) não entra: o professor baixa o que está montado na prova.
router.get('/conferencia/:id/xml', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'A coordenação baixa o arquivo da prova inteira na aba Avaliações.' });
        const snap = await db.collection(COL_AVALIACOES).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
        const av = { id: snap.id, ...snap.data() };
        const prof = await exigeDisciplinaDoProfessor(req, av.categoriaId);
        const { comLinks, USOS_PROVA, usoDaAvaliacao } = AV();
        const usoDaProva = usoDaAvaliacao(av);
        const lerDaAvaliacao = async (a) => {
            const ids = a.questoesIds || [];
            const docs = ids.length ? await db.getAll(...ids.map(id => db.collection(COL_QUESTOES).doc(id))) : [];
            return docs.filter(d => d.exists).map(d => ({ id: d.id, ...d.data() })).filter(q => minhaQuestao(q, prof, req.user.uid));
        };
        // grupos: uso → { questoes, avaliacao (de onde vêm: número no AVA e marca de envio) }
        const grupos = { [usoDaProva]: { questoes: await lerDaAvaliacao(av), avaliacao: av } };
        const irmas = (await db.collection(COL_AVALIACOES).where('categoriaId', '==', av.categoriaId).get()).docs
            .map(d => ({ id: d.id, ...d.data() })).filter(a => a.id !== av.id && a.chave === av.chave && a.semestre === av.semestre);
        for (const u of ['c1', 'c2', 'exame']) {
            if (u === usoDaProva) continue;
            const a = irmas.find(x => usoDaAvaliacao(x) === u && (u === 'exame' || !av.bimestre || x.bimestre === av.bimestre));
            if (a) grupos[u] = { questoes: await lerDaAvaliacao(a), avaliacao: a };
        }
        const ordemUso = ['c1', 'c2', 'exame', 'dp', 'adp'];
        const usos = Object.keys(grupos).filter(u => grupos[u].questoes.length).sort((a, b) => ordemUso.indexOf(a) - ordemUso.indexOf(b));

        if (req.query.resumo) {
            return res.json({ usoDaProva, bimestre: av.bimestre || null, grupos: usos.map(u => ({ uso: u, rotulo: USOS_PROVA[u], qtd: grupos[u].questoes.length, daProva: u === usoDaProva })) });
        }

        const uso = req.query.uso ? String(req.query.uso) : usoDaProva;
        const g = grupos[uso];
        if (!g || !g.questoes.length) return res.json({ publicadas: 0, grupos: [] });
        const posicao = new Map(((g.avaliacao && g.avaliacao.questoesIds) || []).map((id, i) => [id, i + 1]));
        // 16/11/2026: o professor monta e sobe no AVA sem esperar a Ana Beatriz — então o arquivo só sai quando
        // as questões dele passam na Conferência CADAM (nada "a corrigir"); as orientações não bloqueiam.
        const PadraoMed = require('../../banco-med-fatec/padrao.js');
        const fora = g.questoes.filter(q => !PadraoMed.avaliarQuestao(q).ok);
        if (fora.length) {
            const nums = fora.map(q => posicao.get(q.id)).filter(Boolean).sort((a, b) => a - b);
            const onde = nums.length === fora.length ? `nº ${nums.join(', ')} da ${USOS_PROVA[uso]}` : `${fora.length} questão(ões) da ${USOS_PROVA[uso]}`;
            return res.status(400).json({ error: `Ainda há questão sua com item a corrigir na Conferência CADAM (${onde}). Corrija e baixe de novo: o arquivo do AVA só sai com as suas questões no padrão.` });
        }
        // 17/11/2026: baixou para o AVA (todas no padrão) = as questões dele entram no banco da disciplina na hora,
        // sem esperar o titular finalizar. É a mesma questão: o que ele corrigir depois na prova vale no banco.
        const paraPublicar = g.questoes.filter(q => q.status === 'rascunho_avaliacao');
        if (paraPublicar.length) {
            const agoraIso = new Date().toISOString();
            const lote = db.batch();
            paraPublicar.forEach(q => lote.update(db.collection(COL_QUESTOES).doc(q.id), { status: 'publicada', publicadaNoEnvio: true, publicadaEm: agoraIso, padronizadaEm: agoraIso, padronizadaPor: prof.nome, updatedAt: agoraIso }));
            await lote.commit();
        }
        // marca automática no Progresso (17/11/2026): o titular vê que ele baixou o arquivo daquela prova
        if (g.avaliacao) {
            const kEnvio = AV().chaveEnvio(prof.nome);
            await db.collection(COL_AVALIACOES).doc(g.avaliacao.id).update(new admin.firestore.FieldPath('envios', kEnvio, 'professor'), prof.nome, new admin.firestore.FieldPath('envios', kEnvio, 'arquivo'), { feito: true, em: new Date().toISOString() }).catch(() => {});
        }
        const base = [av.disciplina, av.semestre, ...(av.bimestre ? [`${av.bimestre}º Bimestre`] : [])].map(x => String(x).replace(/\//g, '-')).join('/');
        const raiz = [av.disciplina, av.semestre].map(x => String(x).replace(/\//g, '-')).join('/');
        const questoes = [];
        for (const q of g.questoes) questoes.push({
            id: q.id, titulo: q.titulo, tipoMoodle: q.tipoMoodle, casoClinico: q.casoClinico || '', pergunta: q.pergunta || '', enunciadoHtml: q.enunciadoHtml || '',
            alternativas: q.alternativas || [], justificativa: q.justificativa || '', fonte: q.fonte || '', dificuldade: q.dificuldade, elaboradoPor: q.elaboradoPor || q.professorNome || '',
            usoProva: uso, imagens: await comLinks(q.imagens, 30), imagensFeedback: await comLinks(q.imagensFeedback, 30),
            ...(posicao.get(q.id) ? { numeroAva: posicao.get(q.id) } : {})
        });
        // prefixo do nome no AVA: [2ºB 1ªCH], [2ºB 2ªCH], [EXAME], [DEP], [ADAPT]
        const prefixo = uso === 'exame' ? 'EXAME' : uso === 'dp' ? 'DEP' : uso === 'adp' ? 'ADAPT' : `${av.bimestre}ºB ${uso === 'c2' ? '2ª' : '1ª'}CH`;
        const rotuloArq = uso === 'exame' ? 'exame' : uso === 'dp' ? 'dependencia' : uso === 'adp' ? 'adaptacao' : `${av.bimestre}o bim ${uso === 'c2' ? '2a' : '1a'} chamada`;
        res.json({
            publicadas: paraPublicar.length,
            nomeArquivo: `${(av.sigla || av.disciplina)} ${av.semestre} ${rotuloArq} - ${prof.nome}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._ -]/g, '_') + '.xml',
            grupos: [{ uso, rotulo: USOS_PROVA[uso], prefixo, categoria: uso === 'exame' ? `${raiz}/Exame semestral` : `${base}/${USOS_PROVA[uso]}`, questoes }]
        });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.get('/conferencia/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'A coordenação confere a prova inteira pela aba Avaliações.' });
        const snap = await db.collection(COL_AVALIACOES).doc(req.params.id).get();
        if (!snap.exists) return res.status(404).json({ error: 'Avaliação não encontrada.' });
        const av = snap.data();
        const prof = await exigeDisciplinaDoProfessor(req, av.categoriaId);
        const ids = av.questoesIds || [];
        const docs = ids.length ? await db.getAll(...ids.map(id => db.collection(COL_QUESTOES).doc(id))) : [];
        const minhas = [];
        for (let i = 0; i < docs.length; i++) {
            const d = docs[i];
            if (!d.exists) continue;
            const q = { id: d.id, ...d.data() };
            if (minhaQuestao(q, prof, req.user.uid)) minhas.push({ numero: i + 1, ...(await AV().resumoComImagens(q)) });
        }
        res.json({
            avaliacao: { id: snap.id, disciplina: av.disciplina, sigla: av.sigla, semestre: av.semestre, bimestre: av.bimestre, chamada: av.chamada, status: av.status, categoriaId: av.categoriaId },
            totalProva: ids.length, professor: prof.nome, questoes: minhas,
            envio: (av.envios || {})[AV().chaveEnvio(prof.nome)] || null,
            ...(await minhaParte(av, prof, req.user.uid, new Map()).then(p => ({ meta: p.meta, qtdProva: p.qtdProva })))
        });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Divisão das questões pelo professor RESPONSÁVEL da disciplina (16/11/2026): a coordenação / responsável pelas
// avaliações escolhe o responsável nos Critérios; ele define o tamanho da prova e quantas questões cada colega faz.
// Só isso: unidades, pesos e limites continuam com a coordenação.
// Responsável (titular) x adjunto (16/11/2026): o responsável vê TODAS as questões da disciplina, com autoria;
// o adjunto vê só as que ele mesmo fez. Responsável = o definido nos Critérios (e, quando o relay trouxer, o titular do Edubox).
async function categoriasComoResponsavel(req) {
    if (!ehProfessorRestrito(req.user)) return null;
    if (req._respCats) return req._respCats;
    const lista = await disciplinasDoResponsavel(req).catch(() => []);
    req._respCats = new Set(lista.filter(d => d.souResponsavel).map(d => d.categoriaId));
    return req._respCats;
}
async function disciplinasDoResponsavel(req) {
    const prof = await perfilProfessor(req.user);
    const { listaDisciplinas, lerCriterios, normNome } = AV();
    const { disciplinas } = await listaDisciplinas(semestreAtual());
    const minhas = disciplinas.filter(d => prof.categoriaIds.includes(d.categoriaId));
    const crits = await Promise.all(minhas.map(d => lerCriterios(d.chave)));
    return minhas.map((d, i) => {
        const c = crits[i] || {};
        return { chave: d.chave, disciplina: d.nome, sigla: d.sigla, categoriaId: d.categoriaId, professores: d.professores,
            // responsável = o escolhido nos Critérios; sem escolha, o professor TITULAR do Edubox
            responsavel: c.responsavel || (d.titulares || []).join(' / '),
            souResponsavel: c.responsavel ? normNome(c.responsavel) === normNome(prof.nome) : (d.titulares || []).some(t => normNome(t) === normNome(prof.nome)),
            qtdQuestoes: c.qtdQuestoes || null, porProfessor: c.porProfessor || {}, bimestres: c.bimestres || {}, limites: { ...require('../../banco-med-fatec/padrao.js').CRITERIOS_PADRAO, ...(c.limites || {}) }, padraoLimites: require('../../banco-med-fatec/padrao.js').CRITERIOS_PADRAO, divisaoPor: c.divisaoPor || '', divisaoEm: c.divisaoEm || null };
    });
}
// unidades do plano de ensino com o bimestre em vigor (o que o responsável/coordenação definiu, senão o do plano)
async function unidadesComBimestre(d) {
    const { planoDaDisciplina } = AV();
    const plano = await planoDaDisciplina(semestreAtual(), d.disciplina).catch(() => ({ unidades: [] }));
    return (plano.unidades || []).map(u => ({ numero: u.numero, titulo: u.titulo, ch: u.ch, bimestrePlano: u.bimestre, bimestre: Number((d.bimestres || {})[u.numero]) || u.bimestre }));
}
// o responsável acompanha a disciplina: quanto cada professor fez e se já subiu no AVA e no questionário
router.get('/divisao/:chave/progresso', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'A coordenação acompanha pela aba Avaliações.' });
        const d = (await disciplinasDoResponsavel(req)).find(x => x.chave === req.params.chave);
        if (!d || !d.souResponsavel) return res.status(403).json({ error: 'Só o professor responsável pela disciplina acompanha os colegas.' });
        res.json(await AV().progressoDisciplina(d.chave, semestreAtual()));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.get('/divisao', verifyToken, checkPermission, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'A coordenação divide as questões nos Critérios da disciplina (aba Avaliações).' });
        const lista = await disciplinasDoResponsavel(req);
        await Promise.all(lista.filter(d => d.souResponsavel).map(async d => { d.unidades = await unidadesComBimestre(d); }));
        res.json(lista);
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});
router.put('/divisao/:chave', verifyToken, async (req, res) => {
    try {
        if (!ehProfessorRestrito(req.user)) return res.status(403).json({ error: 'A coordenação divide as questões nos Critérios da disciplina (aba Avaliações).' });
        const d = (await disciplinasDoResponsavel(req)).find(x => x.chave === req.params.chave);
        if (!d || !d.souResponsavel) return res.status(403).json({ error: 'Só o professor responsável pela disciplina divide as questões.' });
        const { limparCriterios, COL_CRIT } = AV();
        const c = limparCriterios({ qtdQuestoes: req.body.qtdQuestoes, porProfessor: req.body.porProfessor, bimestres: req.body.bimestres, limites: req.body.limites });
        const prof = await perfilProfessor(req.user);
        await db.collection(COL_CRIT).doc(d.chave).set({ disciplina: d.disciplina, sigla: d.sigla, qtdQuestoes: c.qtdQuestoes, divisaoPor: prof.nome, divisaoPorUid: req.user.uid, divisaoEm: new Date().toISOString() }, { merge: true });
        // em que bimestre cada unidade foi trabalhada (16/11/2026): o responsável ajusta quando uma unidade do 1º foi dada no 2º
        const upd = { porProfessor: c.porProfessor };
        if (req.body.bimestres && typeof req.body.bimestres === 'object') upd.bimestres = c.bimestres;
        // avisos de equilíbrio (caso clínico mínimo, unidade com poucas/demais questões): o responsável também ajusta (16/11/2026)
        if (req.body.limites && typeof req.body.limites === 'object') upd.limites = c.limites;
        await db.collection(COL_CRIT).doc(d.chave).update(upd);
        res.json({ message: 'Salvo. Cada professor já vê a parte dele em "Conferir minhas provas", e as unidades seguem o bimestre que você definiu.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Modelo de questões (Word) da disciplina, para o professor (16/11/2026): o professor só baixa o das disciplinas
// que ministra no semestre; coordenação e ADM baixam de qualquer uma. Vem com os objetivos e as unidades do plano.
router.get('/modelo/:categoriaId', verifyToken, checkPermission, async (req, res) => {
    try {
        const prof = await exigeDisciplinaDoProfessor(req, req.params.categoriaId);
        const cat = await db.collection(COL_CATEGORIAS).doc(req.params.categoriaId).get();
        if (!cat.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const c = cat.data();
        const semestre = /^\d{4}\.[12]$/.test(req.query.semestre || '') ? req.query.semestre : semestreAtual();
        const bimestre = ['1', '2'].includes(String(req.query.bimestre)) ? Number(req.query.bimestre) : null;
        const { planoDaDisciplina, montarModeloDocx, enviarDocx } = AV();
        const planoEdubox = await planoDaDisciplina(semestre, c.nome).catch(() => ({ unidades: [], objetivos: [] }));
        const { listaDisciplinas, lerCriterios, normNome } = AV();
        const dd = (await listaDisciplinas(semestre).catch(() => ({ disciplinas: [] }))).disciplinas.find(x => normNome(x.nome) === normNome(c.nome));
        const plano = require('../../banco-med-fatec/padrao.js').aplicarCriterios(planoEdubox, (dd && await lerCriterios(dd.chave).catch(() => null)) || {});
        // prova escolhida na janela (16/11/2026): c1 / c2 / exame — o cabeçalho do modelo já sai com ela
        const qual = String(req.query.prova || '');
        const chamada = qual === 'c2' ? 2 : qual === 'c1' ? 1 : null;
        enviarDocx(res, await montarModeloDocx({ disciplina: c.nome, sigla: c.nomeBreve || '', semestre, bimestre: qual === 'exame' ? null : bimestre, chamada, professor: prof ? prof.nome : '', plano, prova: qual === 'exame' ? 'Exame semestral' : '' }));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/contexto/:categoriaId', verifyToken, checkPermission, async (req, res) => {
    try {
        const prof = await exigeDisciplinaDoProfessor(req, req.params.categoriaId);
        const cat = await db.collection(COL_CATEGORIAS).doc(req.params.categoriaId).get();
        if (!cat.exists) return res.status(404).json({ error: 'Disciplina não encontrada.' });
        const c = cat.data();
        const semestre = /^\d{4}\.[12]$/.test(req.query.semestre || '') ? req.query.semestre : semestreAtual();
        const { listaDisciplinas, planoDaDisciplina, normNome } = AV();
        const [lista, plano] = await Promise.all([
            listaDisciplinas(semestre).catch(() => ({ disciplinas: [] })),
            planoDaDisciplina(semestre, c.nome).catch(() => ({ unidades: [], objetivos: [], referencias: [] }))
        ]);
        const d = lista.disciplinas.find(x => normNome(x.nome) === normNome(c.nome));
        // unidades no bimestre que a coordenação definiu nos Critérios (16/11/2026)
        const crit = d ? await AV().lerCriterios(d.chave).catch(() => null) : null;
        const planoCrit = require('../../banco-med-fatec/padrao.js').aplicarCriterios(plano, crit || {});
        res.json({ categoriaId: cat.id, disciplina: c.nome, sigla: c.nomeBreve || c.nome, periodo: c.periodo, professores: prof ? [prof.nome] : (d ? d.professores : []), plano: planoCrit });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/questoes/:id/completa', verifyToken, checkPermission, async (req, res) => {
    try {
        const s = await db.collection(COL_QUESTOES).doc(req.params.id).get();
        if (!s.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
        const profQ = await exigeDisciplinaDoProfessor(req, s.data().categoriaId);
        let ehResp = false;
        if (profQ) {
            ehResp = (await categoriasComoResponsavel(req)).has(s.data().categoriaId);
            if (!ehResp && !minhaQuestao(s.data(), profQ, req.user.uid)) return res.status(403).json({ error: 'Você vê só as suas questões. O professor responsável pela disciplina vê todas.' });
        }
        const q = await AV().resumoComImagens({ id: s.id, ...s.data() });
        const antiga = s.data().imagem;
        if (q.temImagem && antiga && antiga.dataUrl) q.imagemAntiga = { nome: antiga.nome || 'imagem', dataUrl: antiga.dataUrl };
        res.json(ehResp ? q : anonimizarQuestao(q, req.user.role, req.user));
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/imagens/envio', verifyToken, checkPermission, async (req, res) => {
    try { res.json(await AV().linkEnvioImagem(req.body)); }
    catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

async function questaoPadraoDoBody(req) {
    const categoriaId = String(req.body.categoriaId || '');
    if (!categoriaId) { const e = new Error('Escolha a disciplina.'); e.status = 400; throw e; }
    const cat = await db.collection(COL_CATEGORIAS).doc(categoriaId).get();
    if (!cat.exists) { const e = new Error('Disciplina não encontrada.'); e.status = 400; throw e; }
    const c = cat.data();
    const { questaoDoBody, confirmarImagens, tokens } = AV();
    const q = questaoDoBody(req.body, { sigla: c.nomeBreve || c.nome });
    if (q.enunciadoHtml.replace(/<[^>]+>/g, '').trim().length < 5) { const e = new Error('Escreva o caso clínico e a pergunta.'); e.status = 400; throw e; }
    return { q, c, categoriaId, confirmarImagens, tokens };
}

router.post('/questoes-padrao', verifyToken, checkPermission, async (req, res) => {
    try {
        const prof = await exigeDisciplinaDoProfessor(req, req.body.categoriaId);
        if (prof) req.body.professorNome = prof.nome;
        const { q, c, categoriaId, confirmarImagens, tokens } = await questaoPadraoDoBody(req);
        q.imagens = await confirmarImagens(req.body.imagens);
        q.imagensFeedback = await confirmarImagens(req.body.imagensFeedback);
        q.padrao = require('../../banco-med-fatec/padrao.js').avaliarQuestao(q);
        if (!q.semestre) q.semestre = semestreAtual();
        if (q.bimestre === undefined) q.bimestre = null;
        const quem = req.user.name || req.user.email || 'Professor';
        const ref = db.collection(COL_QUESTOES).doc();
        await ref.set({
            ...q, categoriaId, periodo: c.periodo ?? null, status: 'publicada',
            areaEnamed: (req.body.areaEnamed && AREAS_ENAMED.includes(req.body.areaEnamed)) ? req.body.areaEnamed : (c.areaEnamedPadrao || classificarAreaEnamed(q.titulo, q.enunciadoHtml, q.justificativa)),
            tituloBusca: normalizarBusca(q.titulo), tituloBuscaTokens: tokens(q.titulo, c.nome),
            elaboradoPor: q.professorNome || quem, criadoPor: req.user.uid, criadoPorNome: quem,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        });
        res.status(201).json({ id: ref.id, padrao: q.padrao, message: 'Questão salva no banco.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/questoes-padrao/:id', verifyToken, checkPermission, async (req, res) => {
    try {
        const ref = db.collection(COL_QUESTOES).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) return res.status(404).json({ error: 'Questão não encontrada.' });
        const antes = snap.data();
        // quem não vê autoria recebe a questão sem o nome do professor: salvar não pode apagar o autor
        if (!podeVerAutoria(req.user.role, req.user)) req.body.professorNome = antes.professorNome || '';
        const prof = await exigeDisciplinaDoProfessor(req, req.body.categoriaId);
        if (prof && antes.criadoPor === req.user.uid) req.body.professorNome = prof.nome;
        const { q, c, categoriaId, confirmarImagens, tokens } = await questaoPadraoDoBody(req);
        if (!req.body.imagem && antes.imagem && req.body.manterImagem !== false) q.imagem = antes.imagem;
        q.imagens = req.body.imagens === undefined ? (antes.imagens || []) : await confirmarImagens(req.body.imagens);
        const ficam = new Set(q.imagens.map(i => i.caminho));
        const { bucket } = AV();
        await Promise.all((antes.imagens || []).filter(i => !ficam.has(i.caminho)).map(i => bucket().file(i.caminho).delete({ ignoreNotFound: true })));
        q.imagensFeedback = req.body.imagensFeedback === undefined ? (antes.imagensFeedback || []) : await confirmarImagens(req.body.imagensFeedback);
        const ficamFb = new Set(q.imagensFeedback.map(i => i.caminho));
        await Promise.all((antes.imagensFeedback || []).filter(i => !ficamFb.has(i.caminho)).map(i => bucket().file(i.caminho).delete({ ignoreNotFound: true })));
        q.padrao = require('../../banco-med-fatec/padrao.js').avaliarQuestao(q);
        const quem = req.user.name || req.user.email || 'Professor';
        await ref.update({
            ...q, categoriaId, periodo: c.periodo ?? null,
            tituloBusca: normalizarBusca(q.titulo), tituloBuscaTokens: tokens(q.titulo, c.nome),
            elaboradoPor: q.professorNome || antes.elaboradoPor || quem,
            padronizadaEm: q.padrao.ok ? new Date().toISOString() : null, padronizadaPor: q.padrao.ok ? quem : null,
            updatedAt: new Date().toISOString()
        });
        let avs = 0;
        if (antes.status === 'publicada') {
            const { gabaritoMed, propagarGabarito } = require('./correcao-provas')._interno;
            const gNovo = gabaritoMed({ alternativas: q.alternativas });
            if (gNovo && gNovo !== gabaritoMed(antes)) avs = await propagarGabarito(req.params.id, gNovo, quem);
        }
        res.json({ padrao: q.padrao, message: avs ? `Questão atualizada (gabarito novo também em ${avs} avaliação(ões) da Correção de Provas).` : 'Questão atualizada.' });
    } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// Avaliações por disciplina / semestre / bimestre / chamada (12/11/2026) — ver banco-med-avaliacoes.js
router.use('/avaliacoes', require('./banco-med-avaliacoes'));

module.exports = router;
