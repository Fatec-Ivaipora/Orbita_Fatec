// ==========================================================================
// Leva para o banco de questões do AVA o que a fila (banco-med-ava-fila.js) marcou como pronto — 25/11/2026.
// Mesmo passo a passo testado no AVA real (II Semana Acadêmica de Medicina, 13 questões com imagem em 5 s):
//   1. acha o curso "SEMESTRE - T.n - nº PER - DISCIPLINA" e o questionário da prova;
//   2. lê o banco DO QUESTIONÁRIO: quantas questões a pasta Disciplina/semestre/bimestre/chamada já tem;
//   3. decide sem duplicar (o AVA não substitui questão importada, só cria outra):
//        pasta (ou questionário) já tem tudo  → "ja_estava": só registra no Órbita;
//        pasta tem exatamente o que o Órbita já registrou → importa as novas;
//        qualquer outra conta → "conferir" (a secretaria olha no AVA);
//   4. sobe o XML (só as questões novas, com imagens) e importa com "categoria do arquivo";
//   5. reconta a pasta.
// ==========================================================================
const { lerCursos, lerQuestionarios, lerFormImportacao, contarQuestoesNoQuestionario, lerResultadoImportacao } = require('./ava-sessao');
const { montarXmlDaAvaliacao } = require('./banco-med-xml-ava');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

function questionarioDaProva(p, nome) {
    const n = norm(nome);
    if (p.tipo === 'exame') return /\bEXAME\b/.test(n);
    if (!new RegExp(`\\bPROVA ${p.bimestre} BIMESTRE\\b`).test(n)) return false;
    return p.chamada === 2 ? /\b2 CHAMADA\b/.test(n) : !/\bCHAMADA\b/.test(n);
}

class ImportadorBancoAva {
    constructor(sessao) { this.s = sessao; this.cursos = {}; }

    async cursosDo(semestre) {
        if (!this.cursos[semestre]) {
            const { texto } = await this.s.req(`/course/search.php?search=${encodeURIComponent(semestre + ' PER')}&perpage=all`);
            this.cursos[semestre] = lerCursos(texto).map(c => {
                const m = c.nome.match(/^(\d{4}\.\d)\s*-\s*T\.\s*\d+\s*-\s*\d+\s*\S*\s*PER\s*-\s*(.+)$/i);
                return m && m[1] === semestre ? { ...c, disc: norm(m[2]) } : null;
            }).filter(Boolean);
        }
        return this.cursos[semestre];
    }

    // acha curso e questionário. cmidTeste: manda para um questionário escolhido (teste), sem procurar
    async destino(sit, cmidTeste) {
        if (cmidTeste) return { cmid: Number(cmidTeste), quiz: 'questionário de teste', curso: '', cursoId: null, teste: true };
        const cursos = (await this.cursosDo(sit.semestre)).filter(c => c.disc === norm(sit.disciplina));
        if (cursos.length !== 1) return { erro: cursos.length ? `mais de um curso no AVA com esse nome (${cursos.map(c => c.id).join(', ')})` : `não há curso "${sit.semestre} - T.n - … - ${sit.disciplina}" no AVA` };
        const curso = cursos[0];
        const { texto } = await this.s.req(`/mod/quiz/index.php?id=${curso.id}`);
        const qs = lerQuestionarios(texto).filter(q => questionarioDaProva(sit, q.nome));
        if (qs.length !== 1) return { curso: curso.nome, cursoId: curso.id, erro: qs.length ? `mais de um questionário possível (${qs.map(q => q.nome).join(' / ')})` : `o curso não tem o questionário da prova (${sit.prova})` };
        return { curso: curso.nome, cursoId: curso.id, cmid: qs[0].cmid, quiz: qs[0].nome };
    }

    async lerBanco(cmid, pasta) {
        const { texto } = await this.s.req(`/question/bank/importquestions/import.php?cmid=${cmid}`);
        const form = lerFormImportacao(texto);
        if (!form) throw new Error('não consegui abrir a importação do banco do questionário (sem permissão?)');
        const alvo = pasta.map(norm).join('/');
        const cat = form.categorias.find(c => c.caminho.map(norm).join('/') === alvo);
        return { form, naPasta: cat ? cat.qtd : 0 };
    }

    async subirEImportar(form, cmid, xml, nomeArquivo) {
        if (!form.itemid || !form.contextoId || !form.repoUpload) throw new Error('não reconheci o seletor de arquivo da importação');
        const up = new FormData();
        up.append('repo_upload_file', new Blob([xml], { type: 'text/xml' }), nomeArquivo);
        Object.entries({ sesskey: this.s.sesskey, repo_id: form.repoUpload, itemid: form.itemid, author: 'Órbita', savepath: '/', title: nomeArquivo, ctx_id: form.contextoId, env: 'filepicker', client_id: form.clientId, maxbytes: -1, areamaxbytes: -1, license: 'unknown', overwrite: 1 })
            .forEach(([k, v]) => up.append(k, String(v)));
        const ur = await this.s.req('/repository/repository_ajax.php?action=upload', { method: 'POST', body: up, tipo: 'json' });
        if (!ur || ur.error || (!ur.url && ur.event !== 'fileexists')) throw new Error(`o AVA recusou o arquivo: ${(ur && (ur.error || ur.event)) || 'resposta inesperada'}`);
        const corpo = new URLSearchParams();
        form.escondidos.forEach(([n, v]) => corpo.append(n, v));
        const def = form.categorias[0];
        Object.entries({ cmid, format: 'xml', category: def ? def.valor : '', catfromfile: '1', contextfromfile: '1', matchgrades: 'error', stoponerror: '1', newfile: form.itemid, submitbutton: 'Importar' })
            .forEach(([k, v]) => corpo.set(k, String(v)));
        const { texto } = await this.s.req('/question/bank/importquestions/import.php', { method: 'POST', body: corpo.toString() });
        return lerResultadoImportacao(texto);
    }

    // sit: situação da avaliação (fila); av: documento da avaliação. simular: só confere, não importa.
    async enviar(sit, av, { simular = false, cmidTeste = null } = {}) {
        const P = sit.prontas.length, J = sit.jaNoAva;
        const base = { em: new Date().toISOString(), esperado: J + P };
        const d = await this.destino(sit, cmidTeste);
        if (d.erro) return { ...base, status: 'conferir', msg: d.erro, curso: d.curso || '', cursoId: d.cursoId || null };
        const r = { ...base, curso: d.curso, cursoId: d.cursoId, cmid: d.cmid, quiz: d.quiz, teste: !!d.teste };
        const pasta = [sit.disciplina, sit.semestre, ...(sit.tipo === 'exame' ? ['Exame semestral'] : [`${sit.bimestre}º Bimestre`, `${sit.chamada}ª chamada`])];
        const { form, naPasta } = await this.lerBanco(d.cmid, pasta);
        const noQuiz = contarQuestoesNoQuestionario((await this.s.req(`/mod/quiz/edit.php?cmid=${d.cmid}`)).texto);
        r.naPasta = naPasta; r.noQuiz = noQuiz;
        if (P && (naPasta === J + P || (naPasta === 0 && noQuiz === J + P)))
            return { ...r, status: 'ja_estava', enviadas: sit.prontas, noAva: Math.max(naPasta, noQuiz), msg: naPasta ? `a pasta do AVA já tinha as ${naPasta} questões` : `o questionário já tinha as ${noQuiz} questões (de outro banco)` };
        if (naPasta !== J || (naPasta === 0 && noQuiz > 0 && noQuiz !== J))
            return { ...r, status: 'conferir', noAva: naPasta, msg: `no AVA a pasta tem ${naPasta} e o questionário ${noQuiz} questão(ões); o Órbita esperava ${J} antes de enviar mais ${P}. Não importou para não duplicar.` };
        if (simular) return { ...r, status: 'simulado', noAva: naPasta, msg: `importaria ${P} questão(ões) aqui` };
        const { xml, n, nomeArquivo } = await montarXmlDaAvaliacao(av, sit.prontas);
        if (n !== P) throw new Error(`o XML saiu com ${n} questões e eram ${P}`);
        const res = await this.subirEImportar(form, d.cmid, xml, nomeArquivo);
        const depois = (await this.lerBanco(d.cmid, pasta)).naPasta;
        if (depois === J + P) return { ...r, status: 'importada', enviadas: sit.prontas, noAva: depois, msg: `${P} questão(ões) importada(s)` };
        if (res.erro && depois === naPasta) return { ...r, status: 'erro', noAva: depois, msg: `o AVA não importou: ${res.erro}` };
        return { ...r, status: 'conferir', noAva: depois, msg: `importou, mas a pasta ficou com ${depois} e o esperado era ${J + P}: confira no AVA${res.erro ? ` (${res.erro})` : ''}` };
    }
}

module.exports = { ImportadorBancoAva, questionarioDaProva };
