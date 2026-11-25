// ==========================================================================
// Resultados das provas da Medicina no AVA → Aplicação de Provas (25/11/2026).
// Para cada prova do calendário (med_aplicacao_provas) que já fechou, o agente do droplet acha o questionário
// no AVA e lê o relatório "Notas" do questionário (CSV, todos os alunos inscritos): quem fez, a nota de cada um
// e quem não fez (lista da 2ª chamada). Grava em med_resultados_ava/<id da prova>.
// Só leitura no AVA. Precisa de mod/quiz:viewreports no papel de integração (regras/regra_do_app.md, seção 8).
// Notas de aluno são dado pessoal: a tela é só da coordenação de Medicina e do ADM (como a Impressão).
// ==========================================================================
const { lerResumoQuestionario } = require('./ava-sessao');
const { questionarioDaProva } = require('./ava-banco-importar');

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const MESES = { JAN: 1, FEV: 2, MAR: 3, ABR: 4, MAI: 5, JUN: 6, JUL: 7, AGO: 8, SET: 9, OUT: 10, NOV: 11, DEZ: 12 };
const num = (s) => { const t = String(s || '').trim(); if (!t || t === '-') return null; const n = Number(t.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };

// ---------- nome da disciplina: "Mecanismos de Defesa e Doença" × "MECANISMOS DE DEFESAS E DOENÇAS" ----------
const VAZIAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'EM', 'A', 'O', 'AS', 'OS', 'PARA', 'COM']);
const ROMANOS = new Set(['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']);
function partesDoNome(s) {
    const palavras = norm(String(s || '').replace(/\([^)]*\)/g, ' ')).split(' ').filter(Boolean);
    const romanos = palavras.filter(p => ROMANOS.has(p)).join(' ');
    const resto = new Set(palavras.filter(p => !ROMANOS.has(p) && !VAZIAS.has(p)).map(p => (p.length > 4 ? p.replace(/S$/, '') : p)));
    return { romanos, resto };
}
function parecido(a, b) {
    const x = partesDoNome(a), y = partesDoNome(b);
    // "Optativa" no calendário × "OPTATIVA I" no AVA: sem número romano de um lado, vale com nota um pouco menor
    if (x.romanos !== y.romanos && x.romanos && y.romanos) return 0;
    const inter = [...x.resto].filter(p => y.resto.has(p)).length;
    const uniao = new Set([...x.resto, ...y.resto]).size;
    const base = uniao ? inter / uniao : 0;
    return x.romanos === y.romanos ? base : base * 0.9;
}

// "Este questionário abriu em quarta-feira, 25 nov. 2026, 08:30, ..." → '2026-11-25'
function dataDaAbertura(txt) {
    const m = norm(txt).match(/\b(\d{1,2}) (JAN|FEV|MAR|ABR|MAI|JUN|JUL|AGO|SET|OUT|NOV|DEZ) (\d{4})\b/);
    return m ? `${m[3]}-${String(MESES[m[2]]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` : null;
}
const fechou = (txt) => /encerrado|foi fechado|fechou/i.test(String(txt || ''));

// prova do calendário → { cmid, quiz, curso, cursoId, abertura, resumo, aviso } ou { erro }
// prova.avaCmid (se alguém ligou à mão) vale mais que a busca.
async function questionarioDaAplicacao(imp, prova) {
    const etapa = prova.etapa;
    const sit = etapa === 'exame' ? { tipo: 'exame' } : { tipo: '', bimestre: etapa === 'b1' ? 1 : 2, chamada: etapa === 'sub' ? 2 : 1 };
    let curso = null;
    // DP e adaptação não têm curso "T.n" no AVA: só com o questionário ligado à mão
    if (!prova.avaCmid && !/^T\d+$/.test(String(prova.turma || ''))) return { erro: `turma ${prova.turma} (dependência/adaptação) não tem curso próprio no AVA: ligue o questionário à mão`, especial: true };
    if (!prova.avaCmid) {
        const cursos = (await imp.cursosDo(prova.semestre)).filter(c => c.turma === prova.turma)
            .map(c => ({ ...c, nota: parecido(prova.disciplina, c.nomeDisc) })).filter(c => c.nota >= 0.5).sort((a, b) => b.nota - a.nota);
        if (!cursos.length) return { erro: `não achei no AVA o curso da ${prova.turma} parecido com "${prova.disciplina}"` };
        if (cursos.length > 1 && cursos[0].nota === cursos[1].nota) return { erro: `mais de um curso parecido no AVA (${cursos.slice(0, 3).map(c => c.nome).join(' / ')})` };
        curso = cursos[0];
    }
    let candidatos;
    if (prova.avaCmid) candidatos = [{ cmid: Number(prova.avaCmid), nome: 'ligado à mão' }];
    else {
        const todos = await imp.questionariosDoCurso(curso.id);
        // 2ª chamada: vale a de qualquer bimestre; a data decide
        candidatos = todos.filter(q => (etapa === 'sub' ? /\b2 CHAMADA\b/.test(norm(q.nome)) : questionarioDaProva(sit, q.nome)));
    }
    if (!candidatos.length) return { erro: `o curso ${curso.nome} não tem o questionário dessa prova`, curso: curso.nome, cursoId: curso.id };
    const lidos = [];
    for (const q of candidatos) {
        const resumo = lerResumoQuestionario((await imp.s.req(`/mod/quiz/edit.php?cmid=${q.cmid}`)).texto);
        lidos.push({ ...q, resumo, data: dataDaAbertura(resumo.abertura) });
    }
    const naData = lidos.filter(q => q.data === prova.data);
    const q = naData.length === 1 ? naData[0] : lidos.length === 1 ? lidos[0] : null;
    if (!q) return { erro: `mais de um questionário possível e nenhum abre em ${prova.data} (${lidos.map(x => `${x.nome}: ${x.data || '?'}`).join(' / ')})`, curso: curso && curso.nome };
    return {
        cmid: q.cmid, quiz: q.nome, curso: curso ? curso.nome : '', cursoId: curso ? curso.id : null, resumo: q.resumo,
        aviso: q.data && q.data !== prova.data ? `o questionário abre em ${q.data} e a prova está marcada para ${prova.data}` : ''
    };
}

// ---------- relatório "Notas" do questionário (CSV) ----------
function lerCsv(texto) {
    const linhas = [];
    let campo = '', linha = [], aspas = false;
    const t = String(texto || '').replace(/^﻿/, '');
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (aspas) {
            if (ch === '"' && t[i + 1] === '"') { campo += '"'; i++; } else if (ch === '"') aspas = false; else campo += ch;
        } else if (ch === '"') aspas = true;
        else if (ch === ',') { linha.push(campo); campo = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else campo += ch;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas.filter(l => l.some(c => c.trim()));
}
// → { notaMax, alunos: [{ nome, situacao: 'finalizada'|'em_andamento'|'nao_enviada'|'nao_fez', nota, inicio, fim, duracao, tentativas }], media }
function lerRelatorio(texto) {
    const [cab, ...linhas] = lerCsv(texto);
    if (!cab) throw new Error('o relatório do questionário veio vazio (sem permissão de ver relatórios?)');
    const col = (re) => cab.findIndex(c => re.test(c.trim()));
    const iS = col(/^Sobrenome$/i), iN = col(/^Nome$/i), iSit = col(/^Situa/i), iIni = col(/^Iniciado/i), iFim = col(/^Completo/i), iDur = col(/^Dura/i), iNota = col(/^Nota\//i);
    if (iS < 0 || iN < 0) throw new Error(`não reconheci as colunas do relatório (${cab.slice(0, 8).join(', ')})`);
    // sem a coluna Nota: a nota está oculta no Livro de Notas e o papel de integração não tem moodle/grade:viewhidden
    if (iNota < 0) throw Object.assign(new Error('o AVA não mostrou as notas (nota oculta no Livro de Notas: falta moodle/grade:viewhidden no papel de integração)'), { semNota: true });
    const notaMax = num(cab[iNota].split('/')[1]);
    let media = null;
    const porAluno = new Map();
    for (const l of linhas) {
        const nome = `${(l[iN] || '').trim()} ${(l[iS] || '').trim()}`.trim();
        if (!nome) { media = num(l[iNota]); continue; } // linha da média geral
        const s = norm(l[iSit] || '');
        const situacao = !s || s === '-' ? 'nao_fez' : /FINALIZ/.test(s) ? 'finalizada' : /ANDAMENTO/.test(s) ? 'em_andamento' : /NUNCA|VENCID|ABANDON/.test(s) ? 'nao_enviada' : 'outra';
        const at = { nome, situacao, nota: num(l[iNota]), inicio: (l[iIni] || '').trim(), fim: (l[iFim] || '').trim(), duracao: (l[iDur] || '').trim() };
        const k = norm(nome);
        const antes = porAluno.get(k);
        // mais de uma tentativa: fica a melhor finalizada (e conta as tentativas)
        if (!antes) porAluno.set(k, { ...at, tentativas: at.situacao === 'nao_fez' ? 0 : 1 });
        else {
            const melhor = (at.situacao === 'finalizada' && (antes.situacao !== 'finalizada' || (at.nota || 0) > (antes.nota || 0))) ? at : antes;
            porAluno.set(k, { ...melhor, tentativas: antes.tentativas + (at.situacao === 'nao_fez' ? 0 : 1) });
        }
    }
    const alunos = [...porAluno.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    // a linha de média nem sempre vem para o usuário de integração: calcula com as finalizadas
    const notas = alunos.filter(a => a.situacao === 'finalizada' && a.nota !== null).map(a => a.nota);
    if (media === null && notas.length) media = Math.round(notas.reduce((s, n) => s + n, 0) / notas.length * 100) / 100;
    return { notaMax, media, alunos };
}

async function lerResultados(imp, cmid) {
    const { texto } = await imp.s.req(`/mod/quiz/report.php?id=${cmid}&mode=overview&attempts=enrolled_any&download=csv`);
    if (/<html/i.test(texto.slice(0, 500))) throw new Error('o AVA não entregou o relatório (sem permissão de ver relatórios do questionário?)');
    return lerRelatorio(texto);
}

module.exports = { questionarioDaAplicacao, lerResultados, lerRelatorio, parecido, dataDaAbertura, fechou };
