// Leitura do LIVRO DE NOTAS exportado do Open LMS (AVA) — usado pela Trilha
// EAD (docencia/trilha-ead). Um arquivo por disciplina/turma, com uma linha
// por aluno e uma coluna por unidade de aprendizagem do SAGAH:
//
//   Nome | Sobrenome | Número de identificação | Instituição | Departamento |
//   Endereço de e-mail | Ferramenta externa: UA 01 - <título> (Real) | ... |
//   UA 12 ... (Real) | Total do curso (Real) | Último download...
//
// Valor da unidade = % de participação (0–100); "-" = não fez.
// Só lê e organiza: a regra da nota (0,5 por unidade com 100%) fica em
// NOTA_UNIDADE/notaBimestre, usada pelo servidor e repetida na tela.

class ErroLivroNotas extends Error {}

const NOTA_UNIDADE = 0.5;      // cada unidade com 100% de participação vale 0,5
const UNIDADES_POR_BIMESTRE = 6; // UA 01–06 = 1º bimestre, UA 07–12 = 2º

const txt = v => String(v === null || v === undefined ? '' : v).trim();

// Contas internas que aparecem no livro de notas mas não são aluno (20/10/2026).
const USUARIOS_INTERNOS = ['PROFESSOR FATEC'];
const chave = v => txt(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// "100", "100,00", "71.5", "85 %" → número; "-", "" → null (não fez)
function valor(v) {
    const t = txt(v).replace('%', '').replace(/\s+/g, '');
    if (!t || t === '-') return null;
    const n = Number(t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

// Só conta a unidade com participação completa (regra do EAD, 19/10/2026).
const unidadeFeita = v => v !== null && v !== undefined && v >= 99.995;

function notaBimestre(feitas) {
    return Math.round(feitas * NOTA_UNIDADE * 10) / 10;
}

function bimestreDa(numeroUnidade) {
    return Math.ceil(numeroUnidade / UNIDADES_POR_BIMESTRE);
}

// CSV do próprio AVA: separador vírgula (às vezes ponto e vírgula), com aspas.
function lerCsv(texto) {
    const amostra = texto.slice(0, 5000);
    const sep = (amostra.match(/;/g) || []).length > (amostra.match(/,/g) || []).length ? ';' : ',';
    const linhas = [];
    let linha = [], campo = '', aspas = false;
    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (aspas) {
            if (c === '"') {
                if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false;
            } else campo += c;
        } else if (c === '"') aspas = true;
        else if (c === sep) { linha.push(campo); campo = ''; }
        else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
        else if (c !== '\r') campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

function lerGrade(buffer, nomeArquivo) {
    const ext = txt(nomeArquivo).toLowerCase().split('.').pop();
    if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') {
        const XLSX = require('xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer' });
        return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
    }
    return lerCsv(buffer.toString('utf8').replace(/^﻿/, ''));
}

// "TEO HIST ARQ URB III - 7602 Notas.xlsx" → disciplina + código do curso no AVA
function disciplinaDoArquivo(nomeArquivo) {
    const base = txt(nomeArquivo).replace(/\.[a-z0-9]+$/i, '').replace(/\s*notas\s*$/i, '').trim();
    const m = base.match(/^(.*?)\s*-\s*(\d{3,})$/);
    return m ? { disciplina: m[1].trim(), codigoAva: m[2] } : { disciplina: base, codigoAva: null };
}

/**
 * @returns {{ disciplina, codigoAva, unidades: {n, titulo}[], alunos: {nome, email, notas: (number|null)[]}[] }}
 */
function lerLivroDeNotas(buffer, nomeArquivo) {
    const grade = lerGrade(buffer, nomeArquivo).map(l => (l || []).map(txt));

    const idxCab = grade.findIndex(l => l.some(c => /^ua\s*0*\d{1,2}\b/.test(chave(c).replace(/^ferramenta externa\s*/, ''))));
    if (idxCab === -1) {
        throw new ErroLivroNotas(
            'Não encontrei as colunas das unidades (UA 01, UA 02...). Confira se o arquivo é o ' +
            'livro de notas exportado do curso no AVA (Notas → Exportar → Excel ou CSV).'
        );
    }
    const cab = grade[idxCab];
    const k = cab.map(chave);
    const idxNome = k.findIndex(c => c === 'nome' || c === 'first name' || c === 'nome completo');
    const idxSobrenome = k.findIndex(c => c === 'sobrenome' || c === 'last name');
    const idxEmail = k.findIndex(c => c.includes('e mail') || c === 'email');
    if (idxNome === -1) throw new ErroLivroNotas('Não encontrei a coluna "Nome" no arquivo.');

    const unidades = [];
    cab.forEach((h, i) => {
        const limpo = txt(h).replace(/^ferramenta externa:\s*/i, '');
        const m = limpo.match(/^UA\s*0*(\d{1,2})\b\s*[-–:]?\s*(.*)$/i);
        if (!m) return;
        const titulo = m[2].replace(/\s*\((real|porcentagem|percentage|letra)\)\s*$/i, '').trim();
        unidades.push({ n: Number(m[1]), titulo, coluna: i });
    });
    unidades.sort((a, b) => a.n - b.n);

    const alunos = [];
    for (const linha of grade.slice(idxCab + 1)) {
        const nome = [linha[idxNome], idxSobrenome >= 0 ? linha[idxSobrenome] : '']
            .map(txt).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        if (!nome) continue;
        if (USUARIOS_INTERNOS.includes(chave(nome).toUpperCase())) continue;
        alunos.push({
            nome,
            email: idxEmail >= 0 ? txt(linha[idxEmail]).toLowerCase() : '',
            notas: unidades.map(u => valor(linha[u.coluna]))
        });
    }
    if (!alunos.length) throw new ErroLivroNotas('O arquivo não tem nenhum aluno.');
    alunos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    return {
        ...disciplinaDoArquivo(nomeArquivo),
        unidades: unidades.map(({ n, titulo }) => ({ n, titulo })),
        alunos
    };
}

module.exports = {
    lerLivroDeNotas,
    disciplinaDoArquivo,
    unidadeFeita,
    notaBimestre,
    bimestreDa,
    NOTA_UNIDADE,
    UNIDADES_POR_BIMESTRE,
    ErroLivroNotas
};
