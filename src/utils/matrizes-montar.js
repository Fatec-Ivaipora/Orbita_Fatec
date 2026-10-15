// Monta a visão de Matrizes (por curso/semestre) a partir do dado cru que o
// relay devolve em /matrizes/dados. Antes isso rodava em
// scripts/matrizes-edubox-sync.js e era gravado em matrizes_edubox no
// Firestore; agora é montado a cada consulta (ver src/rotas/matrizes.js).
//
// Como o Edubox modela: cada turma (tac_turma) de um semestre aponta pra uma
// grade (matriz do ano de ingresso) e um período. O que se estuda no semestre
// é o que está lançado na turma (tac_disciplina_turma). Marcas por disciplina:
//   foraDaMatriz  lançada na turma, mas não é do período da grade da turma
//   naoOfertada   é do período da grade da turma, mas não foi lançada
//
// Qual matriz a turma segue: a que o Edubox vincula à turma (tac_turma.gratur).
// Um curso costuma ter VÁRIAS matrizes rodando ao mesmo tempo, e o nome da
// matriz NÃO coincide com o semestre de ingresso da turma — por isso não se
// adivinha pelo nome. A única conferência automática é a confiável: disciplinas
// lançadas na turma x disciplinas do período da matriz da turma (situacao
// "conferir" quando diferem).

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
const CODCUR_DE = Object.fromEntries(Object.entries(CURSO_ID).map(([cod, id]) => [id, cod]));
const cursoIdDe = (codcur) => CURSO_ID[codcur] || String(codcur).toLowerCase();
const codcurDe = (cursoId) => CODCUR_DE[cursoId] || String(cursoId).toUpperCase();

const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const num = (v) => Number(v) || 0;

// "2027/1" ou "2027-1" -> "2027.1"
const normSemestre = (s) => String(s).replace(/[/-]/, '.');
// "2027.1" -> ["2027/1" (graduação), "2027-1" (Medicina)]
const formatosEdubox = (semestre) => [semestre.replace('.', '/'), semestre.replace('.', '-')];

// semestre atual + os 2 próximos
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

// { turmas, grades, oferta, matriz } (linhas cruas do relay) -> um doc por curso/semestre
function montar({ turmas, grades, oferta, matriz }) {
    if (!turmas.length) return [];

    const ofertaPorTurma = new Map();
    oferta.forEach(o => empurra(ofertaPorTurma, o.turdtu, o));
    const matrizPorGradePeriodo = new Map();
    const matrizPorGrade = new Map();
    matriz.forEach(d => {
        empurra(matrizPorGradePeriodo, `${d.gradis}:${d.perdis}`, d);
        empurra(matrizPorGrade, d.gradis, d);
    });
    const gradeInfo = new Map(grades.map(g => [g.codgra, g]));

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
        const cursoId = cursoIdDe(t.curtur);
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

        const divergentes = disciplinas.filter(d => d.foraDaMatriz || d.naoOfertada);
        doc.turmas.push({
            codTurma: t.codtur,
            nome: limpa(t.nomtur),
            periodo: num(t.pertur),
            codGrade: t.gratur,
            grade: limpa(t.desgra),
            situacao: divergentes.length ? 'conferir' : 'ok',
            disciplinas
        });

        if (t.gratur && !doc.grades.some(g => g.codGrade === t.gratur)) doc.grades.push(gradeCompleta(t.gratur));
    }
    docs.forEach(d => d.grades.sort((a, b) => b.codGrade - a.codGrade));
    return [...docs.values()];
}

module.exports = { montar, semestresPadrao, normSemestre, formatosEdubox, cursoIdDe, codcurDe };
