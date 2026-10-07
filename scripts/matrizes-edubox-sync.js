// ==========================================================================
// Sincronização Edubox -> Órbita (módulo Matrizes).
//
// O Edubox (Postgres na nuvem do fornecedor) só aceita conexão do IP da
// Fatec — o Órbita publicado (Vercel) não alcança. Então este script roda num
// PC da Fatec e SÓ LÊ o Edubox; o que grava é no Firestore do Órbita:
//   matrizes_edubox/{AAAA.S}__{cursoId}   o que cada turma do semestre estuda,
//                                         a matriz completa de cada grade em
//                                         uso (qual matriz cada turma segue)
//   config/matrizes_sync                  semestres disponíveis + última carga
//
// Este script nunca toca em `matrizes_grade` (professor/dia/hora definidos
// pelos coordenadores) — rodar de novo não apaga o trabalho deles.
//
// Como o Edubox modela: cada turma (tac_turma) de um semestre aponta pra uma
// grade (matriz do ano de ingresso) e um período. O que se estuda no semestre
// é o que está lançado na turma (tac_disciplina_turma). Marcas por disciplina:
//   foraDaMatriz  lançada na turma, mas não é do período da grade da turma
//   naoOfertada   é do período da grade da turma, mas não foi lançada
//
// Qual matriz a turma segue: a que o Edubox vincula à turma (tac_turma.gratur).
// Um curso costuma ter VÁRIAS matrizes rodando ao mesmo tempo, cada uma com
// suas turmas (Contábeis: 2023/1 (C1), 2025/1 (C2), 2026/1, 2026/2...), e o
// nome da matriz NÃO coincide com o semestre de ingresso da turma (a turma
// "4 - 2025/2" roda na matriz "2025/1 (C2)"). Por isso não se adivinha pelo
// nome: cada turma mostra a matriz do Edubox e suas disciplinas, e o curso
// mostra quais matrizes estão em uso e por quais turmas. A única conferência
// automática é a confiável: disciplinas lançadas na turma x disciplinas do
// período da matriz da turma (situacao "conferir" quando diferem).
//
// Uso: node scripts/matrizes-edubox-sync.js              (semestre atual + 2 próximos)
//      node scripts/matrizes-edubox-sync.js 2027.1       (só esse)
//      node scripts/matrizes-edubox-sync.js --dry        (não grava, só resume)
// ==========================================================================
const path = require('path');
const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });
const edubox = require(path.join(RAIZ, 'src', 'db-edubox'));

// Código do curso no Edubox -> id usado no cadastro de Usuários (cursos do
// coordenador). Curso fora da lista (extinto) usa o código em minúsculas.
const CURSO_ID = {
    'AGRO': 'agronegocio', 'AGRON': 'agronomia', 'ARQUIT': 'arquitetura-urbanismo',
    'BIOMED': 'biomedicina', 'CI.CONT': 'contabeis', 'DIR': 'direito',
    'ENFER': 'enfermagem', 'ENG.CIV': 'engenharia-civil', 'FINAN': 'gestao-financeira',
    'FISIO': 'fisioterapia', 'GEST.COM': 'gestao-comercial', 'LOG': 'logistica',
    'MED': 'medicina', 'MED.VET.': 'medicina-veterinaria', 'PED': 'pedagogia',
    'PSICO': 'psicologia', 'RH': 'rh'
};

const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const num = (v) => Number(v) || 0;
const semAcento = (s) => limpa(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// "2027/1" ou "2027-1" -> "2027.1"
const normSemestre = (s) => String(s).replace(/[/-]/, '.');

function semestresPadrao(hoje = new Date()) {
    let ano = hoje.getFullYear();
    let sem = hoje.getMonth() < 6 ? 1 : 2;
    const lista = [];
    for (let i = 0; i < 3; i++) {
        lista.push(`${ano}.${sem}`);
        if (sem === 1) sem = 2; else { sem = 1; ano++; }
    }
    return lista;
}

function discDe(d, extra = {}) {
    return {
        codDisciplina: d.coddis,
        nome: limpa(d.nomdis),
        tipo: limpa(d.tipdis) || 'Presencial',
        ch: {
            teorica: num(d.choteodis), pratica: num(d.chopradis),
            // sincrona = "síncrona mediada" (chosmedis): aula ao vivo mediada por tecnologia; só existe em
            // disciplinas "A Distância". Sem essa coluna essas disciplinas apareciam com a CH toda zerada.
            ead: num(d.choeaddis), sincrona: num(d.chosmedis), extensao: num(d.choextdis), total: num(d.chtdis)
        },
        ...extra
    };
}
const porNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
const empurra = (mapa, chave, valor) => { (mapa.get(chave) || mapa.set(chave, []).get(chave)).push(valor); };

async function montar(semestres) {
    const formatos = semestres.flatMap(s => [s.replace('.', '/'), s.replace('.', '-')]);
    const turmas = (await edubox.query(
        `select t.codtur, t.nomtur, t.curtur, t.gratur, t.pertur, t.semtur, c.descur, g.desgra
           from ivp.tac_turma t
           join ivp.tac_curso c on c.codcur = t.curtur
           left join ivp.tac_grade g on g.codgra = t.gratur
          where t.semtur = any($1)
          order by t.curtur, t.pertur`, [formatos])).rows;
    if (!turmas.length) return [];

    const cursosUsados = [...new Set(turmas.map(t => t.curtur))];
    const todasGrades = (await edubox.query(
        `select codgra, desgra, curgra, chogra from ivp.tac_grade where curgra = any($1)`, [cursosUsados])).rows;

    const codTurmas = turmas.map(t => t.codtur);
    const gradesBuscar = [...new Set(turmas.map(t => t.gratur).filter(Boolean))];

    const oferta = (await edubox.query(
        `select x.turdtu, d.coddis, d.nomdis, d.tipdis, d.perdis, d.gradis,
                d.choteodis, d.chopradis, d.choeaddis, d.choextdis, d.chosmedis, d.chtdis
           from ivp.tac_disciplina_turma x
           join ivp.tac_disciplina d on d.coddis = x.disdtu
          where x.turdtu = any($1)`, [codTurmas])).rows;
    const matriz = (await edubox.query(
        `select d.coddis, d.nomdis, d.tipdis, d.perdis, d.gradis,
                d.choteodis, d.chopradis, d.choeaddis, d.choextdis, d.chosmedis, d.chtdis
           from ivp.tac_disciplina d where d.gradis = any($1)`, [gradesBuscar])).rows;

    const ofertaPorTurma = new Map();
    oferta.forEach(o => empurra(ofertaPorTurma, o.turdtu, o));
    const matrizPorGradePeriodo = new Map();
    const matrizPorGrade = new Map();
    matriz.forEach(d => {
        empurra(matrizPorGradePeriodo, `${d.gradis}:${d.perdis}`, d);
        empurra(matrizPorGrade, d.gradis, d);
    });
    const gradeInfo = new Map(todasGrades.map(g => [g.codgra, g]));

    // matriz completa de uma grade (todos os períodos), pra tela
    const gradeCompleta = (cod) => {
        const info = gradeInfo.get(cod) || {};
        const periodos = new Map();
        (matrizPorGrade.get(cod) || []).forEach(d => empurra(periodos, d.perdis, discDe(d)));
        return {
            codGrade: cod, nome: limpa(info.desgra), chTotal: num(info.chogra),
            periodos: [...periodos.entries()].sort((a, b) => a[0] - b[0])
                .map(([periodo, disciplinas]) => ({ periodo: num(periodo), disciplinas: disciplinas.sort(porNome) }))
        };
    };

    const docs = new Map();
    for (const t of turmas) {
        const semestre = normSemestre(t.semtur);
        const cursoId = CURSO_ID[t.curtur] || String(t.curtur).toLowerCase();
        const id = `${semestre}__${cursoId}`;
        if (!docs.has(id)) {
            docs.set(id, { id, semestre, cursoId, codCurso: t.curtur, cursoNome: limpa(t.descur), turmas: [], grades: [] });
        }
        const doc = docs.get(id);

        const lancadas = ofertaPorTurma.get(t.codtur) || [];
        const daMatriz = matrizPorGradePeriodo.get(`${t.gratur}:${t.pertur}`) || [];
        const idsLancadas = new Set(lancadas.map(o => o.coddis));
        const idsMatriz = new Set(daMatriz.map(d => d.coddis));
        const disciplinas = [
            ...lancadas.map(o => discDe(o, idsMatriz.has(o.coddis) ? {} : { foraDaMatriz: true })),
            ...daMatriz.filter(d => !idsLancadas.has(d.coddis)).map(d => discDe(d, { naoOfertada: true }))
        ].sort(porNome);

        // Confere só o que é fato do Edubox: o que foi lançado na turma bate
        // com o período da matriz que a turma segue?
        const divergentes = disciplinas.filter(d => d.foraDaMatriz || d.naoOfertada);
        doc.turmas.push({
            codTurma: t.codtur,
            nome: limpa(t.nomtur),
            periodo: num(t.pertur),
            codGrade: t.gratur,
            grade: limpa(t.desgra),
            situacao: divergentes.length ? "conferir" : "ok",
            disciplinas
        });

        if (t.gratur && !doc.grades.some(g => g.codGrade === t.gratur)) doc.grades.push(gradeCompleta(t.gratur));
    }
    docs.forEach(d => d.grades.sort((a, b) => b.codGrade - a.codGrade));
    return [...docs.values()];
}

async function sincronizar({ semestres, dry = false } = {}) {
    const inicio = Date.now();
    const lista = (semestres && semestres.length ? semestres : semestresPadrao());
    const docs = await montar(lista);

    if (!dry) {
        const { db } = require(path.join(RAIZ, 'src', 'firebase'));
        const agora = new Date().toISOString();
        for (const d of docs) {
            await db.collection('matrizes_edubox').doc(d.id).set({ ...d, atualizadoEm: agora });
        }
        const presentes = [...new Set(docs.map(d => d.semestre))].sort();
        await db.collection('config').doc('matrizes_sync').set({
            semestres: presentes, atualizadoEm: agora, cursos: docs.length
        }, { merge: true });
    }
    return { docs, duracaoMs: Date.now() - inicio };
}

module.exports = { sincronizar, semestresPadrao };

if (require.main === module) {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    const detalhe = args.includes('--detalhe');
    const semestres = args.filter(a => /^\d{4}\.[12]$/.test(a));
    sincronizar({ semestres, dry }).then(({ docs, duracaoMs }) => {
        let tot = 0, conf = 0;
        docs.forEach(d => {
            const n = d.turmas.reduce((s, t) => s + t.disciplinas.length, 0);
            const cf = d.turmas.filter(t => t.situacao === "conferir");
            tot += n; conf += cf.length;
            console.log(`${d.semestre}  ${d.cursoId.padEnd(24)} ${String(d.turmas.length).padStart(2)} turmas  ${String(d.grades.length).padStart(2)} matriz(es)  ${String(n).padStart(3)} disciplinas${cf.length ? `  | ${cf.length} turma(s) p/ conferir` : ""}`);
            if (detalhe) d.turmas.forEach(t => console.log(`      per ${t.periodo}  ${t.nome}  ->  ${t.grade}${t.situacao === "conferir" ? "  [conferir]" : ""}`));
        });
        console.log(`
${docs.length} curso(s)/semestre, ${tot} disciplinas, ${conf} turma(s) p/ conferir, ${Math.round(duracaoMs / 1000)}s${dry ? " — SIMULAÇÃO, nada foi gravado" : " — gravado no Firestore"}`);
        process.exit(0);
    }).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
}
