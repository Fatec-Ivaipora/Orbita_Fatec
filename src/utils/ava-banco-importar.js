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
const { lerCursos, lerQuestionarios, lerFormImportacao, lerResumoQuestionario, lerResultadoImportacao, semTags } = require('./ava-sessao');
const { montarXmlDaAvaliacao } = require('./banco-med-xml-ava');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// ---------- formulário do AVA (editor de questão) — 26/11/2026 ----------
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function decodificarHtml(s) {
    return String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
function atributo(tag, nome) {
    const m = tag.match(new RegExp(`\\s${nome}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`\\s${nome}\\s*=\\s*'([^']*)'`, 'i'));
    return m ? m[1] : null;
}
// campos do formulário na ordem em que o navegador enviaria: [[nome, valor], ...]
function lerCamposForm(form) {
    const out = [];
    const re = /<(input|textarea|select)\b([^>]*)>/gi;
    let m;
    while ((m = re.exec(form))) {
        const tag = m[1].toLowerCase(), attrs = m[0];
        const nomeBruto = atributo(attrs, 'name');
        if (!nomeBruto) continue;
        const nome = decodificarHtml(nomeBruto);
        if (tag === 'input') {
            const tipo = (atributo(attrs, 'type') || 'text').toLowerCase();
            if (['submit', 'button', 'image', 'reset', 'file'].includes(tipo)) continue;
            if ((tipo === 'checkbox' || tipo === 'radio') && !/\schecked\b/i.test(attrs)) continue;
            out.push([nome, decodificarHtml(atributo(attrs, 'value') || (tipo === 'checkbox' ? 'on' : ''))]);
        } else if (tag === 'textarea') {
            const fim = form.indexOf('</textarea>', re.lastIndex);
            out.push([nome, decodificarHtml(form.slice(re.lastIndex, fim < 0 ? re.lastIndex : fim))]);
            if (fim >= 0) re.lastIndex = fim;
        } else {
            const fim = form.indexOf('</select>', re.lastIndex);
            const opcoes = [...form.slice(re.lastIndex, fim < 0 ? re.lastIndex : fim).matchAll(/<option\b([^>]*)>/gi)].map(o => o[1]);
            const marcadas = opcoes.filter(o => /\sselected\b/i.test(' ' + o));
            const vale = (o) => decodificarHtml(atributo(' ' + o, 'value') || '');
            if (/\smultiple\b/i.test(attrs)) marcadas.forEach(o => out.push([nome, vale(o)]));
            else if (opcoes.length) out.push([nome, vale(marcadas[0] || opcoes[0])]);
            if (fim >= 0) re.lastIndex = fim;
        }
    }
    return out;
}

function questionarioDaProva(p, nome) {
    const n = norm(nome);
    if (p.tipo === 'exame') return /\bEXAME\b/.test(n);
    // "📝 Prova · 2º Bimestre — 2ª Chamada" (padrão) e, no ADP de Habilidades Clínicas I (26/11/2026),
    // "AVALIAÇÃO 2º BIMESTRE - ADP - …" / "AVALIAÇÃO 2º CHAMADA - 2º BIMESTRE - ADP - …"
    if (!new RegExp(`\\b(PROVA|AVALIACAO)( 2 CHAMADA)? ${p.bimestre} BIMESTRE\\b`).test(n)) return false;
    return p.chamada === 2 ? /\b2 CHAMADA\b/.test(n) : !/\bCHAMADA\b/.test(n);
}

class ImportadorBancoAva {
    constructor(sessao) { this.s = sessao; this.cursos = {}; }

    async cursosDo(semestre) {
        if (!this.cursos[semestre]) {
            const { texto } = await this.s.req(`/course/search.php?search=${encodeURIComponent(semestre + ' PER')}&perpage=all`);
            const turmasT = lerCursos(texto).map(c => {
                const m = c.nome.match(/^(\d{4}\.\d)\s*-\s*T\.\s*(\d+)\s*-\s*\d+\s*\S*\s*PER\s*-\s*(.+)$/i);
                return m && m[1] === semestre ? { ...c, turma: `T${m[2]}`, turmas: [`T${m[2]}`], nomeDisc: m[3], disc: norm(m[3]) } : null;
            }).filter(Boolean);
            // Dependência e adaptação da Medicina (26/11/2026) têm curso próprio, em outro padrão de nome:
            // "ADP - MEDICINA - 2026.2 - PATOLOGIA CLÍNICA I", "DP - MEDICINA - 2026.2 - SISTEMAS MORFOFISIOLÓGICOS III"
            // (e "DP - ADP - MEDICINA - …", que serve às duas turmas).
            let especiais = [];
            try {
                const r = await this.s.req(`/course/search.php?search=${encodeURIComponent('MEDICINA - ' + semestre)}&perpage=all`);
                especiais = lerCursos(r.texto).map(c => {
                    const m = c.nome.match(/^((?:A?DP)(?:\s*-\s*A?DP)?)\s*-\s*MEDICINA\s*-\s*(\d{4}\.\d)\s*-\s*(.+)$/i);
                    if (!m || m[2] !== semestre) return null;
                    const turmas = m[1].toUpperCase().split(/\s*-\s*/);
                    return { ...c, turma: turmas[0], turmas, nomeDisc: m[3], disc: norm(m[3]) };
                }).filter(Boolean);
            } catch (e) { especiais = []; }
            this.cursos[semestre] = [...turmasT, ...especiais];
        }
        return this.cursos[semestre];
    }

    // Questionários do curso (25/11/2026). Para o usuário de integração, /mod/quiz/index.php vira a "visão geral de
    // atividades" do Moodle 5.1, que carrega a lista depois (sem link no HTML). E as provas ficam em subseções
    // ("📁 AVALIAÇÕES · 2º BIMESTRE"), que têm página própria. Então lê a página do curso e a de cada subseção.
    async questionariosDoCurso(cursoId) {
        if (!this.quizzes) this.quizzes = {};
        if (this.quizzes[cursoId]) return this.quizzes[cursoId];
        const { texto } = await this.s.req(`/course/view.php?id=${cursoId}`);
        const achados = lerQuestionarios(texto);
        const secoes = [...new Set((texto.match(/\/course\/section\.php\?id=\d+/g) || []))];
        for (const u of secoes) {
            for (const q of lerQuestionarios((await this.s.req(u)).texto)) if (!achados.some(x => x.cmid === q.cmid)) achados.push(q);
        }
        this.quizzes[cursoId] = achados;
        return achados;
    }

    // acha curso e questionário. cmidTeste: manda para um questionário escolhido (teste), sem procurar
    async destino(sit, cmidTeste) {
        if (cmidTeste) return { cmid: Number(cmidTeste), quiz: 'questionário de teste', curso: '', cursoId: null, teste: true };
        // envio de questões continua só nos cursos das turmas T.n (as de DP/ADP têm o mesmo nome de disciplina)
        const cursos = (await this.cursosDo(sit.semestre)).filter(c => /^T\d+$/.test(c.turma) && c.disc === norm(sit.disciplina));
        if (cursos.length !== 1) return { erro: cursos.length ? `mais de um curso no AVA com esse nome (${cursos.map(c => c.id).join(', ')})` : `não há curso "${sit.semestre} - T.n - … - ${sit.disciplina}" no AVA` };
        const curso = cursos[0];
        const qs = (await this.questionariosDoCurso(curso.id)).filter(q => questionarioDaProva(sit, q.nome));
        if (qs.length !== 1) return { curso: curso.nome, cursoId: curso.id, erro: qs.length ? `mais de um questionário possível (${qs.map(q => q.nome).join(' / ')})` : `o curso não tem o questionário da prova (${sit.prova})` };
        return { curso: curso.nome, cursoId: curso.id, cmid: qs[0].cmid, quiz: qs[0].nome };
    }

    // ---------- trazer do AVA para validar (26/11/2026) ----------
    // Prova que o professor montou direto no AVA: exporta o banco do questionário em Moodle-XML (categoria "Topo",
    // que leva todas as pastas) e lê o nome das questões que estão de fato na prova (edit.php), para separar das
    // que só estão no banco. Precisa de moodle/question:viewall e exportall no papel de integração.
    // → [{ nome, id }] na ordem da prova; id = questão no AVA (link "Editar no AVA" da tela de validação)
    async questoesDaProva(cmid) {
        const { texto } = await this.s.req(`/mod/quiz/edit.php?cmid=${cmid}`);
        const out = [];
        for (const bloco of texto.split(/<li\b[^>]*class="[^"]*\bslot\b/).slice(1)) {
            const nome = (bloco.match(/<span[^>]*class="[^"]*\bquestionname\b[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1];
            if (!nome) continue;
            const id = (bloco.match(/editquestion\/question\.php\?[^"]*?\bid=(\d+)/) || [])[1];
            out.push({ nome: semTags(nome).replace(/\s+/g, ' ').trim(), id: id ? Number(id) : null });
        }
        return out.filter(q => q.nome);
    }
    async exportarXml(cmid) {
        const pag = (await this.s.req(`/question/bank/exportquestions/export.php?cmid=${cmid}`)).texto;
        const sesskey = (pag.match(/name="sesskey"\s+value="([^"]+)"/) || [])[1] || this.s.sesskey;
        const sel = (pag.match(/<select[^>]*name="category"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || '';
        const topo = (sel.match(/<option[^>]*value="([^"]+)"/) || [])[1];
        if (!sesskey || !topo) throw new Error('não consegui abrir a exportação do banco do questionário (falta moodle/question:exportall no papel de integração?)');
        const corpo = new URLSearchParams({ cmid: String(cmid), sesskey, _qf__qbank_exportquestions_form_export_form: '1', format: 'xml', category: topo.replace(/&amp;/g, '&'), cattofile: '1', contexttofile: '1', submitbutton: 'Exportar' });
        const res = (await this.s.req('/question/bank/exportquestions/export.php', { method: 'POST', body: corpo.toString() })).texto;
        const link = (res.match(/href="([^"]*\/question\/export\/[^"]+)"/) || [])[1];
        if (!link) throw new Error('o AVA não gerou o arquivo de exportação');
        const xml = (await this.s.req(link.replace(/&amp;/g, '&'))).texto;
        if (!/^\s*(<\?xml|<quiz)/.test(xml)) throw new Error('o arquivo exportado não é um Moodle-XML');
        return xml;
    }

    // ---------- levar a alteração feita no Órbita para a questão no AVA (26/11/2026) ----------
    // Abre o editor da questão (question.php), reenvia todos os campos do formulário como vieram (inclusive as áreas
    // de arquivos das imagens) e troca só o enunciado, as alternativas, a correta e o feedback geral. As imagens que
    // já estavam no AVA continuam (as <img> do enunciado/feedback antigos são mantidas). O AVA guarda versão nova.
    async editarQuestao(cmid, id, { enunciadoHtml, alternativas, feedbackHtml }) {
        const pag = await this.s.req(`/question/bank/editquestion/question.php?cmid=${cmid}&id=${id}`);
        const form = (pag.texto.match(/<form\b[^>]*class="[^"]*\bmform\b[^"]*"[^>]*>[\s\S]*?<\/form>/) || [])[0];
        if (!form) throw new Error('não consegui abrir o editor da questão no AVA (sem permissão de editar?)');
        const action = new URL(decodificarHtml(atributo(form.match(/<form\b[^>]*>/)[0], 'action') || 'question.php'), pag.url).toString();
        const campos = lerCamposForm(form);
        const valor = (k) => (campos.find(([n]) => n === k) || [])[1] || '';
        if (!campos.some(([k]) => k === 'questiontext[text]') || !campos.some(([k]) => k === 'answer[0][text]')) throw new Error('o editor do AVA não é de múltipla escolha');
        const vagas = Number(valor('noanswers')) || 0;
        if (alternativas.length > vagas) throw new Error(`a questão no AVA tem ${vagas} alternativas e no Órbita ${alternativas.length}: ajuste pelo "Editar no AVA"`);
        const imgs = (h) => (String(h || '').match(/<img\b[^>]*>/g) || []).join(' ');
        const comImgs = (novoHtml, antigo) => { const i = imgs(antigo); return i && !/<img\b/.test(novoHtml) ? `${novoHtml}\n<p>${i}</p>` : novoHtml; };
        const novo = new Map([
            ['questiontext[text]', comImgs(String(enunciadoHtml || ''), valor('questiontext[text]'))],
            ['generalfeedback[text]', comImgs(String(feedbackHtml || ''), valor('generalfeedback[text]'))]
        ]);
        for (let i = 0; i < vagas; i++) {
            const a = alternativas[i];
            novo.set(`answer[${i}][text]`, a ? `<p>${escHtml(a.texto)}</p>` : '');
            novo.set(`fraction[${i}]`, a && a.correta ? '1.0' : '0.0');
        }
        const corpo = new URLSearchParams();
        const feitos = new Set();
        for (const [k, v] of campos) {
            if (!novo.has(k)) { corpo.append(k, v); continue; }
            if (!feitos.has(k)) { corpo.append(k, novo.get(k)); feitos.add(k); }
        }
        corpo.set('submitbutton', 'Salvar mudanças');
        const res = await this.s.req(action, { method: 'POST', body: corpo.toString() });
        // deu certo: o AVA redireciona para a prova; se o formulário volta, foi recusado
        if (/name="_qf__qtype_[a-z]+_edit_form"/.test(res.texto)) {
            const msg = (res.texto.match(/class="[^"]*\b(?:error|invalid-feedback)\b[^"]*"[^>]*>\s*([^<]{3,})/) || [])[1];
            throw new Error(`o AVA recusou a alteração${msg ? `: ${decodificarHtml(msg).trim()}` : ''}`);
        }
        return true;
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

    // Só lê o questionário da prova (25/11/2026): quantas questões tem, nota máxima, soma das notas e abertura.
    // A Joyce decide pelo Órbita com esses números; nada muda no AVA.
    async resumoDaProva(sit) {
        const d = await this.destino(sit, null);
        if (d.erro) return { erro: d.erro, curso: d.curso || '', cursoId: d.cursoId || null };
        const pasta = [sit.disciplina, sit.semestre, ...(sit.tipo === 'exame' ? ['Exame semestral'] : [`${sit.bimestre}º Bimestre`, `${sit.chamada}ª chamada`])];
        const naPasta = (await this.lerBanco(d.cmid, pasta)).naPasta;
        const resumo = lerResumoQuestionario((await this.s.req(`/mod/quiz/edit.php?cmid=${d.cmid}`)).texto);
        return { curso: d.curso, cursoId: d.cursoId, cmid: d.cmid, quiz: d.quiz, naPasta, resumo };
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
        r.resumo = lerResumoQuestionario((await this.s.req(`/mod/quiz/edit.php?cmid=${d.cmid}`)).texto);
        const noQuiz = r.resumo.noQuestionario;
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
        r.naPasta = depois;
        if (depois === J + P) return { ...r, status: 'importada', enviadas: sit.prontas, noAva: depois, msg: `${P} questão(ões) importada(s)` };
        if (res.erro && depois === naPasta) return { ...r, status: 'erro', noAva: depois, msg: `o AVA não importou: ${res.erro}` };
        return { ...r, status: 'conferir', noAva: depois, msg: `importou, mas a pasta ficou com ${depois} e o esperado era ${J + P}: confira no AVA${res.erro ? ` (${res.erro})` : ''}` };
    }
}

module.exports = { ImportadorBancoAva, questionarioDaProva, lerCamposForm };
