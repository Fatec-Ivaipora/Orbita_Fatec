// Trilha EAD — casa o livro de notas do AVA com os DIÁRIOS do Edubox, usando os
// dados que o CADD já sincroniza do Edubox (cad_turmas: turma, período, curso,
// disciplinas com a modalidade, e os alunos de cada turma).
//
// Por que: no AVA as turmas que estudam juntas (ex.: 1º e 2º período) ficam num
// curso só, mas no Edubox cada período tem o próprio diário. O livro de notas
// não diz o período do aluno — o diário diz. Casando, a tela separa o arquivo
// do Edubox por diário e já inclui (com 0) quem está no diário e não fez nada
// no AVA (19/10/2026).
//
// Só leitura: lê cad_turmas do semestre (o mesmo dado que a tela do CADD usa).

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const PARADAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'A', 'O', 'AO', 'AOS', 'NA', 'NO']);
const ROMANO = /^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/;
const CASAMENTO_MINIMO = 0.75;

// Nome social: o AVA mostra o nome social e o Edubox o civil (caso real 20/10:
// "MATTEUS RAFAEL AGACCE DA SILVA" no AVA = "LUDIMILA APARECIDA AGACCE DA SILVA"
// no Edubox). Segunda tentativa: os DOIS últimos sobrenomes (sem "da", "de"...),
// e só vale se for a única pessoa ainda sem par com esses sobrenomes — senão
// "... DA SILVA" casaria qualquer um.
const PARTICULAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E']);
function chaveSobrenome(nome) {
    const t = norm(nome).split(' ').filter(x => x && !PARTICULAS.has(x));
    return t.length >= 3 ? t.slice(-2).join(' ') : null;
}
// {chaveSobrenome -> [pessoas]} só de quem ainda não casou pelo nome completo
function indicePorSobrenome(pessoas) {
    const m = new Map();
    pessoas.forEach(p => {
        const k = chaveSobrenome(p.nome);
        if (k) (m.get(k) || m.set(k, []).get(k)).push(p);
    });
    return m;
}

// A sigla do AVA ("TEO HIST ARQ URB III") contra o nome do Edubox ("TEORIA E
// HISTÓRIA DA ARQUITETURA E URBANISMO III"): cada pedaço da sigla tem que ser o
// começo de uma palavra do nome, na ordem; o número romano tem que bater exato
// (senão "... II" casaria com "... III"). Devolve 0 a 1.
function casamentoDisciplina(sigla, nome) {
    const s = norm(sigla).split(' ').filter(t => t && !PARADAS.has(t));
    const n = norm(nome).split(' ').filter(t => t && !PARADAS.has(t));
    if (!s.length || !n.length) return 0;
    if (s.filter(t => ROMANO.test(t)).join() !== n.filter(t => ROMANO.test(t)).join()) return 0;
    let j = 0, acertos = 0;
    for (const t of s) {
        while (j < n.length && !(ROMANO.test(t) ? n[j] === t : n[j].startsWith(t))) j++;
        if (j < n.length) { acertos++; j++; }
    }
    return acertos / s.length;
}

// cad_turmas do semestre muda poucas vezes por dia (agente do CADD) — guarda
// 10 min pra prévia + importação não lerem tudo duas vezes.
const cache = new Map();
async function turmasDoCadd(db, semestre) {
    const c = cache.get(semestre);
    if (c && Date.now() - c.em < 10 * 60 * 1000) return c.turmas;
    const snap = await db.collection('cad_turmas').where('semestre', '==', semestre).get();
    const turmas = snap.docs.map(d => d.data());
    cache.set(semestre, { em: Date.now(), turmas });
    return turmas;
}

/**
 * @returns {{ diarios: object[], diarioDoAluno: (string|null)[], codcurs: string[] }}
 *   diarios: [{ id, codtur, turma, periodo, codcur, curso, coddtu, disciplina, modal, alunos: [{alu, nome}] }]
 *   diarioDoAluno: para cada aluno do livro (mesma ordem), o id do diário ou null
 */
async function casarComDiarios(db, semestre, livro) {
    const turmas = await turmasDoCadd(db, semestre);
    const nomesAva = new Set(livro.alunos.map(a => norm(a.nome)));

    // diários cuja disciplina casa com a sigla; com mais de um candidato por
    // turma, fica o de maior casamento (e prefere a disciplina EAD)
    const candidatos = [];
    for (const t of turmas) {
        let melhor = null;
        for (const d of t.disciplinas || []) {
            if (d.dp) continue;
            const sc = casamentoDisciplina(livro.disciplina, d.nome) + (d.modal === 'ead' ? 0.01 : 0);
            if (sc >= CASAMENTO_MINIMO && (!melhor || sc > melhor.sc)) melhor = { d, sc };
        }
        if (!melhor) continue;
        const alunos = (t.alunos || []).map(a => ({ alu: a.alu || null, nome: a.nome }));
        // só entra o diário que tem pelo menos um aluno do arquivo — evita
        // pegar a mesma disciplina de outra turma que não é a deste AVA
        if (!alunos.some(a => nomesAva.has(norm(a.nome)))) continue;
        candidatos.push({
            id: t.id, codtur: t.codtur, turma: t.turma, periodo: t.periodo, codcur: t.codcur, curso: t.curso,
            coddtu: melhor.d.id, disciplina: melhor.d.nome, modal: melhor.d.modal || null, alunos
        });
    }
    candidatos.sort((a, b) => a.periodo - b.periodo || a.turma.localeCompare(b.turma, 'pt-BR'));

    const diarioPorNome = new Map();
    candidatos.forEach(d => d.alunos.forEach(a => {
        const k = norm(a.nome);
        if (!diarioPorNome.has(k)) diarioPorNome.set(k, d.id);
    }));
    const diarioDoAluno = livro.alunos.map(a => diarioPorNome.get(norm(a.nome)) || null);
    const nomeEdubox = livro.alunos.map(() => null);   // preenchido quando casou pelo sobrenome

    // 2ª tentativa no diário: sobrenome, entre quem do diário ainda não tem par
    const jaCasados = new Set(livro.alunos.filter((_, i) => diarioDoAluno[i]).map(a => norm(a.nome)));
    const livresNoDiario = indicePorSobrenome(candidatos.flatMap(d => d.alunos
        .filter(x => !jaCasados.has(norm(x.nome))).map(x => ({ nome: x.nome, diario: d.id }))));
    const semParNoAva = indicePorSobrenome(livro.alunos.filter((_, i) => !diarioDoAluno[i]));
    livro.alunos.forEach((a, i) => {
        if (diarioDoAluno[i]) return;
        const k = chaveSobrenome(a.nome);
        const lado = k && livresNoDiario.get(k);
        if (lado && lado.length === 1 && (semParNoAva.get(k) || []).length === 1) {
            diarioDoAluno[i] = lado[0].diario;
            nomeEdubox[i] = lado[0].nome;
        }
    });

    // Aluno do AVA fora desses diários: procura o nome em TODAS as turmas do
    // semestre, pro tutor do EAD saber onde lançar à mão (ex.: aluno de outro
    // curso que faz a disciplina junto, ou DP). Diz também se a disciplina
    // existe naquela turma (19/10/2026).
    // índice do semestre inteiro por sobrenome, pra quem não aparece pelo nome
    const todosDoSemestre = indicePorSobrenome(turmas.flatMap(t => (t.alunos || []).map(x => ({ nome: x.nome, turmaId: t.id }))));
    const ondeEsta = livro.alunos.map((a, i) => {
        if (diarioDoAluno[i]) return null;
        const k = norm(a.nome);
        let achadas = turmas.filter(t => (t.alunos || []).some(x => norm(x.nome) === k));
        if (!achadas.length) {
            // nome social: procura pelo sobrenome no semestre (só se for pessoa única)
            const ks = chaveSobrenome(a.nome);
            const lado = ks && todosDoSemestre.get(ks);
            const pessoas = lado ? [...new Set(lado.map(p => norm(p.nome)))] : [];
            if (pessoas.length === 1 && (semParNoAva.get(ks) || []).length === 1) {
                nomeEdubox[i] = lado[0].nome;
                achadas = turmas.filter(t => lado.some(p => p.turmaId === t.id));
            }
        }
        return achadas.map(t => {
            const d = (t.disciplinas || [])
                .map(x => ({ x, sc: casamentoDisciplina(livro.disciplina, x.nome) }))
                .filter(c => c.sc >= CASAMENTO_MINIMO)
                .sort((p, q) => q.sc - p.sc)[0];
            return {
                curso: t.curso, codcur: t.codcur, turma: t.turma, periodo: t.periodo,
                disciplina: d ? d.x.nome : null, dp: d ? !!d.x.dp : false
            };
        });
    });

    // Nem em turma ativa do Edubox (o CADD só traz matrícula ativa): a situação
    // no módulo Matrículas explica — ex.: trancou no semestre e continua no AVA
    // porque o AVA não tira ninguém (caso real 19/10). Consulta só os nomes que
    // faltaram, por igualdade (sem varrer o semestre inteiro).
    const situacaoMatricula = await Promise.all(livro.alunos.map(async (a, i) => {
        if (!ondeEsta[i] || ondeEsta[i].length) return null;
        const nomes = [...new Set([a.nome, a.nome.toUpperCase(), nomeEdubox[i]].filter(Boolean))];
        const snap = await db.collection('matriculas_alunos')
            .where('semestre', '==', semestre).where('nome', 'in', nomes).limit(3).get();
        if (snap.empty) return null;
        const m = snap.docs[0].data();
        return { situacao: m.situacao || '', curso: m.curso || '', periodo: m.periodo || '' };
    }));

    return {
        diarios: candidatos,
        diarioDoAluno,
        nomeEdubox,
        ondeEsta,
        situacaoMatricula,
        codcurs: [...new Set(candidatos.map(d => d.codcur))]
    };
}

module.exports = { casarComDiarios, casamentoDisciplina, norm };
