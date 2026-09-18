// Gera o .docx final (Simulado ou Bimestral/Exame) pronto pra secretaria
// imprimir, reproduzindo a estrutura dos modelos reais fornecidos pelo
// usuário (cabeçalho com logo/institucional igual ao papel timbrado real,
// missão institucional, orientações, gabarito e "Boa Prova!" na
// Bimestral/Exame; questões agrupadas por disciplina no Simulado, em DUAS
// COLUNAS — pedido explícito: "são impressos, a faculdade pensa em
// economizar papel, tem que ser lado a lado igual está no arquivo" — a
// Bimestral/Exame, por ter só ~10 questões, continua em uma coluna direta).
const fs = require('fs');
const path = require('path');
const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    AlignmentType, WidthType, BorderStyle, HeadingLevel, ImageRun, Header, Footer,
    HeightRule, VerticalAlignTable
} = require('docx');

const DISCIPLINA_GERAL_ID = 'geral';

// Logo extraído diretamente do cabeçalho do modelo real de Simulado
// fornecido pelo usuário (word/media/image1.png dentro do .docx). Tamanho
// (213x43px) e cor da borda/fonte abaixo replicam exatamente o XML original
// (word/header1.xml e word/footer1.xml do arquivo enviado) — não são
// estimativas.
const LOGO_BUFFER = fs.readFileSync(path.join(__dirname, '../assets/logo-fatec-cabecalho.png'));
const AZUL_MARINHO = '000080';
const AZUL_TEXTO_CABECALHO = '2F5496';
const FONTE_INSTITUCIONAL = 'Bookman Old Style';

// Texto institucional real (extraído do modelo de Prova Bimestral fornecido)
// — fixo por enquanto; se a Secretaria quiser trocar, isso vira configurável.
const MISSAO = 'Missão: Atuar no ensino superior mediante articulação permanente entre a realidade local e o desenvolvimento educacional tendo em vista um processo de educação crítica, propositiva e transformadora.';

const ORIENTACOES = [
    'Horário máximo para entrada em sala: conforme definido pela coordenação;',
    'Horário mínimo para entrega da avaliação e saída da sala: conforme definido pela coordenação;',
    'Os celulares e relógios serão recolhidos pelo professor e entregues ao final da avaliação;',
    'O aluno deverá assinar a lista de chamada;',
    'Os últimos 3 alunos que estiverem em sala deverão entregar a prova ao mesmo tempo;',
    'É vedado o uso de qualquer material de consulta, salvo se expressamente autorizado pelo professor;',
    'Letras ilegíveis terão desconto de nota;',
    'Rasuras terão desconto de nota. Se o aluno errar na questão dissertativa, basta fazer um traço sobre a palavra que foi escrita de forma errada e seguir com a resposta normalmente.',
    'O gabarito da prova será disponibilizado no dia da vista de prova, mesmo momento em que o professor estabelecerá o prazo para recursos sobre eventuais questões que devam ser anuladas.'
];

function paragrafo(texto, opts = {}) {
    // Justificado por padrão — pedido explícito (18/09): "precisa seguir o
    // padrão para avaliações, né, ABNT" (só títulos/cabeçalhos centralizados,
    // que já passam align explícito, ficam de fora disso).
    return new Paragraph({
        alignment: opts.align || AlignmentType.JUSTIFIED,
        spacing: { after: opts.after ?? 120 },
        pageBreakBefore: !!opts.pageBreakBefore,
        keepNext: !!opts.keepNext,
        keepLines: !!opts.keepLines,
        children: [new TextRun({ text: texto, bold: !!opts.bold, size: opts.size || 22 })]
    });
}

function celulaTexto(texto, opts = {}) {
    return new TableCell({
        width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
        columnSpan: opts.colSpan,
        rowSpan: opts.rowSpan,
        children: [new Paragraph({ children: [new TextRun({ text: texto, bold: !!opts.bold, size: 20 })] })]
    });
}

// Margens menores que o padrão do Word (1 polegada) — pedido explícito
// (18/09): sem isso o texto da mantenedora no cabeçalho institucional
// ("Mantida pela União de Ensino Superior... UNESVI") não cabia numa linha
// só e quebrava pra uma 4ª linha (o modelo real tem só 3).
const MARGENS_PAGINA = { top: 1080, bottom: 1080, left: 720, right: 720 };

const SEM_BORDA_TABELA = {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

// Cabeçalho institucional — tabela sem borda (logo à esquerda, texto da
// mantenedora à direita, proporção 37/63 igual ao original) + linha dupla
// separadora embaixo (thinThickLargeGap navy, igual ao papel timbrado
// real). Cria uma instância nova a cada chamada (cada seção do docx precisa
// da sua própria, mesmo repetindo o mesmo conteúdo).
function criarCabecalhoInstitucional() {
    const celulaLogo = new TableCell({
        width: { size: 30, type: WidthType.PERCENTAGE },
        verticalAlign: VerticalAlignTable.CENTER,
        children: [new Paragraph({
            children: [new ImageRun({ type: 'png', data: LOGO_BUFFER, transformation: { width: 213, height: 43 } })]
        })]
    });
    const linhaTexto = (texto) => new Paragraph({
        children: [new TextRun({ text: texto, bold: true, size: 16, color: AZUL_TEXTO_CABECALHO, font: FONTE_INSTITUCIONAL })]
    });
    const celulaInstitucional = new TableCell({
        width: { size: 70, type: WidthType.PERCENTAGE },
        verticalAlign: VerticalAlignTable.CENTER,
        children: [
            linhaTexto('Mantida pela União de Ensino Superior do Vale do Ivaí Ltda - UNESVI'),
            linhaTexto('Credenciamento EaD - Portaria nº 874 de 28 de novembro de 2025'),
            linhaTexto('Recredenciamento - Portaria nº 878 de 28 de novembro de 2025')
        ]
    });

    return new Header({
        children: [
            new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                borders: SEM_BORDA_TABELA,
                rows: [new TableRow({
                    height: { value: 1039, rule: HeightRule.ATLEAST },
                    children: [celulaLogo, celulaInstitucional]
                })]
            }),
            new Paragraph({
                spacing: { before: 30, after: 0 },
                border: { bottom: { style: BorderStyle.THIN_THICK_LARGE_GAP, size: 2, color: AZUL_MARINHO, space: 0 } },
                children: []
            })
        ]
    });
}

// Rodapé institucional — exatamente as duas linhas do arquivo real
// (word/footer1.xml): endereço / site, centralizado, Bookman Old Style
// negrito azul-marinho, cada linha com a borda superior fina navy.
function criarRodapeInstitucional() {
    const linhaRodape = (texto) => new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: AZUL_MARINHO, space: 1 } },
        children: [new TextRun({ text: texto, bold: true, size: 16, color: AZUL_MARINHO, font: FONTE_INSTITUCIONAL })]
    });

    return new Footer({
        children: [
            linhaRodape('Avenida Brasil, 45 – Fone (43) 3472-0201 – CEP 86870-000 – Ivaiporã /Paraná'),
            linhaRodape('www.fatecivaipora.com.br')
        ]
    });
}

const SEM_BORDA = {
    top: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
    left: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
    right: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' },
};

// Célula "Estou Ciente" — o aluno assina confirmando que leu as orientações
// da prova (item do modelo real que faltava: só existia o campo de nome,
// sem lugar pro aluno atestar que está ciente das regras e a data). Ocupa
// 3 linhas da tabela (rowSpan), do mesmo jeito que o modelo real — a caixa
// fica ao lado de Curso/Período/Disciplina, não ao lado de Acadêmico(a).
function celulaEstouCiente(rowSpan) {
    return new TableCell({
        width: { size: 35, type: WidthType.PERCENTAGE },
        rowSpan,
        children: [
            new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { after: 20 },
                children: [new TextRun({ text: 'Estou Ciente', size: 18 })]
            }),
            new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: '_____/_____/_____', size: 18 })]
            })
        ]
    });
}

// Tabela de CABEÇALHO — 3 colunas (Acadêmico/Curso/Disciplina/Professor/
// Data/Valor à esquerda em 2 colunas + "Estou Ciente" numa caixa à direita
// que ocupa 3 linhas), reproduzindo EXATAMENTE a estrutura do modelo real
// fornecido pelo usuário (18/09) — antes disso era só 2 colunas simples e a
// caixa "Estou Ciente" ficava do lado errado (ao lado de "Acadêmico(a)" em
// vez de ao lado de Curso/Período/Disciplina) e faltavam as linhas em
// branco de respiro antes de "Professor(a)" e antes de "Valor".
function tabelaCabecalhoBimestral(prova, opts, valorTotal) {
    const linhaCheia = (texto) => new TableRow({ children: [celulaTexto(texto, { width: 100, colSpan: 3 })] });
    return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: SEM_BORDA,
        rows: [
            new TableRow({
                children: [
                    celulaTexto('Acadêmico(a):', { width: 65, colSpan: 2 }),
                    celulaEstouCiente(3)
                ]
            }),
            new TableRow({
                children: [
                    celulaTexto(`Curso: ${opts.cursoNome}`, { width: 38 }),
                    celulaTexto(`Período: ${opts.periodoLabel || ''}`, { width: 27 })
                ]
            }),
            new TableRow({ children: [celulaTexto(`Disciplina: ${opts.disciplinaNome || ''}`, { width: 65, colSpan: 2 })] }),
            linhaCheia(''),
            linhaCheia(`Professor(a): ${prova.professorNome || ''}`),
            // Exame não tem bimestre — só acontece depois do 2º bimestre,
            // pra quem não atingiu a média no semestre inteiro (pedido
            // explícito 18/09: "não tem bimestre no caso").
            new TableRow({
                children: [
                    celulaTexto('Data: ____/____/______', { width: 38 }),
                    prova.tipo === 'exame'
                        ? celulaTexto('', { width: 62, colSpan: 2 })
                        : celulaTexto('(  ) 1º Bimestre      (  ) 2º Bimestre', { width: 62, colSpan: 2 })
                ]
            }),
            linhaCheia(''),
            new TableRow({
                children: [
                    celulaTexto(`Valor: ${valorTotal || ''}`, { width: 38 }),
                    celulaTexto('Nota: ______', { width: 62, colSpan: 2 })
                ]
            })
        ]
    });
}

function blocoOrientacoes() {
    return [
        paragrafo(MISSAO, { after: 200, size: 20 }),
        paragrafo('ORIENTAÇÕES PARA A PROVA', { bold: true, after: 100 }),
        ...ORIENTACOES.map(o => paragrafo(`•  ${o}`, { size: 20, after: 60 }))
    ];
}

function gradeGabarito(quantidade) {
    if (!quantidade) return [];
    const cabecalho = new TableRow({
        children: Array.from({ length: quantidade }, (_, i) =>
            celulaTexto(String(i + 1).padStart(2, '0'), { bold: true }))
    });
    const vazia = new TableRow({
        children: Array.from({ length: quantidade }, () => celulaTexto(' '))
    });
    return [
        paragrafo('GABARITO', { bold: true, after: 60, align: AlignmentType.CENTER }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: SEM_BORDA, rows: [cabecalho, vazia] }),
        paragrafo('', { after: 200 })
    ];
}

// keepNext encadeado do enunciado até a penúltima alternativa (a última
// pode ficar no fim da página sem problema — é o fim da questão) — pedido
// explícito (18/09): "quase no final da página... quebrado para o aluno
// ler o enunciado". Sem isso o Word podia cortar a questão no meio,
// deixando o enunciado numa página e as alternativas na próxima.
// Sem keepNext/keepLines de propósito — pedido explícito (18/09): "pode
// retirar os espaços e preencher, não tem problema ir pra outra página o
// resto da pergunta". Prioriza aproveitar o papel; o texto flui livre,
// mesmo que corte uma questão entre página/coluna.
function blocoQuestaoObjetiva(numero, q) {
    const alternativas = q.alternativas || [];
    const paras = [paragrafo(`${numero}. ${q.enunciadoHtml}`, { bold: false, after: 80 })];
    alternativas.forEach(alt => {
        paras.push(paragrafo(`${alt.letra}) ${alt.texto}`, { size: 20, after: 40 }));
    });
    // Espaço visível entre uma questão e outra — pedido explícito (18/09):
    // "só deixa um espaço de uma questão pra outra pra ficar claro qual
    // questão é" (sem prender o bloco inteiro, só separação visual).
    paras.push(paragrafo('', { after: 240 }));
    return paras;
}

// Simulado: "Questão 01" em parágrafo próprio antes do enunciado — pedido
// explícito (18/09), igual ao modelo real ("Questão 01" / "(FGV - 2024)" /
// enunciado em parágrafos separados), diferente da Bimestral/Exame (que usa
// "1. enunciado" corrido, conforme o modelo dela).
// keepNext só até a 1ª alternativa (não encadeado por todas) — pedido
// explícito (18/09): "estão ficando muito espaços na prova". Prender o
// bloco inteiro (enunciado + todas as alternativas) fazia o Word jogar a
// questão inteira pra próxima coluna sempre que não coubesse por inteiro,
// deixando buracos grandes no Simulado (colunas estreitas). Só grudar o
// enunciado com a 1ª alternativa evita o pior caso (pergunta separada de
// TODAS as opções) sem forçar esses saltos grandes.
function blocoQuestaoObjetivaSimulado(numero, q) {
    const alternativas = q.alternativas || [];
    const paras = [
        // keepNext só aqui: "Questão XX" nunca fica sozinho no fim da
        // página/coluna, separado do próprio enunciado — pedido explícito
        // (18/09): "trava o número da questão junto do texto pra não
        // acontecer isso". O resto (alternativas) continua livre pra fluir.
        paragrafo(`Questão ${String(numero).padStart(2, '0')}`, { bold: true, after: 60, keepNext: true }),
        paragrafo(q.enunciadoHtml, { bold: false, after: 80 })
    ];
    alternativas.forEach(alt => {
        paras.push(paragrafo(`${alt.letra}) ${alt.texto}`, { size: 20, after: 40 }));
    });
    // Espaço visível entre uma questão e outra — mesmo pedido (18/09) da
    // Bimestral/Exame, aplicado aqui também.
    paras.push(paragrafo('', { after: 240 }));
    return paras;
}

function blocoQuestaoDissertativa(numero, q) {
    const paras = [paragrafo(`${numero}. ${q.enunciadoHtml}`, { after: 100 })];
    for (let i = 0; i < 8; i++) {
        paras.push(new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999', space: 1 } },
            spacing: { after: 200 },
            children: [new TextRun({ text: ' ' })]
        }));
    }
    return paras;
}

// Ordem/numeração EXATA em que cada tipo de prova imprime as questões —
// usada tanto pra gerar a prova quanto pra gerar o gabarito separado, pra
// nunca ficar um número diferente do outro.
function numerarQuestoesObjetivas(prova, questoes, opts) {
    if (prova.tipo === 'simulado') {
        const porDisciplina = new Map();
        questoes.forEach(q => {
            const chave = q.disciplinaId || DISCIPLINA_GERAL_ID;
            if (!porDisciplina.has(chave)) porDisciplina.set(chave, []);
            porDisciplina.get(chave).push(q);
        });
        // Pedido explícito (17/09): Conhecimentos Gerais vem PRIMEIRO no
        // Simulado, as disciplinas do curso vêm depois.
        const chaves = [...porDisciplina.keys()].sort((a, b) => {
            if (a === DISCIPLINA_GERAL_ID) return -1;
            if (b === DISCIPLINA_GERAL_ID) return 1;
            return 0;
        });
        const numeradas = [];
        chaves.forEach(chave => {
            porDisciplina.get(chave).forEach(q => numeradas.push({
                numero: numeradas.length + 1, questao: q,
                secaoNome: (opts.nomesDisciplina && opts.nomesDisciplina[chave]) || 'Disciplina'
            }));
        });
        return numeradas;
    }
    return questoes.filter(q => q.tipo === 'objetiva').map((q, i) => ({ numero: i + 1, questao: q, secaoNome: null }));
}

const CHAMADA_LABEL = { 1: 'PRIMEIRA CHAMADA', 2: 'SEGUNDA CHAMADA' };

async function gerarDocxBimestralOuExame(prova, questoes, opts) {
    const objetivas = questoes.filter(q => q.tipo === 'objetiva');
    const dissertativas = questoes.filter(q => q.tipo === 'dissertativa');
    const valorObjetivas = objetivas.reduce((s, q) => s + (q.valor || 0), 0);
    const valorDissertativas = dissertativas.reduce((s, q) => s + (q.valor || 0), 0);

    const titulo = prova.tipo === 'exame' ? 'EXAME' : 'PROVA BIMESTRAL';
    const tituloComChamada = prova.chamada ? `${titulo} (${CHAMADA_LABEL[prova.chamada]})` : titulo;

    const children = [
        paragrafo(tituloComChamada, { bold: true, align: AlignmentType.CENTER, size: 28, after: 200 }),
        tabelaCabecalhoBimestral(prova, opts, valorObjetivas + valorDissertativas),
        paragrafo('', { after: 150 }),
        ...blocoOrientacoes(),
        ...gradeGabarito(objetivas.length)
    ];

    if (objetivas.length) {
        children.push(paragrafo(`QUESTÕES OBJETIVAS${valorObjetivas ? ` (${valorObjetivas.toFixed(2)} no total)` : ''}`, { bold: true, align: AlignmentType.CENTER, after: 150 }));
        objetivas.forEach((q, i) => children.push(...blocoQuestaoObjetiva(i + 1, q)));
    }
    if (dissertativas.length) {
        // Pedido explícito (18/09): "acabou as objetivas quase no final da
        // página, as discursivas precisam iniciar em outra página" — só
        // força a quebra quando teve objetiva ANTES (senão, numa prova só
        // de dissertativa — caso do Exame — criaria uma página em branco
        // no início).
        children.push(paragrafo(`QUESTÕES DISSERTATIVAS${valorDissertativas ? ` (${valorDissertativas.toFixed(2)} no total)` : ''}`, { bold: true, align: AlignmentType.CENTER, after: 150, pageBreakBefore: objetivas.length > 0 }));
        dissertativas.forEach((q, i) => children.push(...blocoQuestaoDissertativa(i + 1, q)));
    }

    children.push(paragrafo('Boa Prova!', { bold: true, align: AlignmentType.CENTER, after: 0 }));

    const doc = new Document({
        sections: [{
            headers: { default: criarCabecalhoInstitucional() },
            footers: { default: criarRodapeInstitucional() },
            properties: { page: { margin: MARGENS_PAGINA } },
            children
        }]
    });
    return Packer.toBuffer(doc);
}

async function gerarDocxSimulado(prova, questoes, opts) {
    const numeradas = numerarQuestoesObjetivas(prova, questoes, opts);

    // SEM capa — pedido explícito (18/09): "é só colocar as questões,
    // esquece de fazer capa, a capa é OUTRO arquivo que a secretaria vai
    // imprimir junto da prova". Este arquivo é só o caderno de questões,
    // lado a lado em duas colunas (economia de papel), igual ao modelo real
    // fornecido (que também começa direto na primeira disciplina).
    const questoesChildren = [];
    let secaoAtual = null;
    numeradas.forEach(({ numero, questao, secaoNome }) => {
        if (secaoNome !== secaoAtual) {
            questoesChildren.push(paragrafo(secaoNome, { bold: true, after: 150 }));
            secaoAtual = secaoNome;
        }
        questoesChildren.push(...blocoQuestaoObjetivaSimulado(numero, questao));
    });

    const doc = new Document({
        sections: [
            {
                headers: { default: criarCabecalhoInstitucional() },
                footers: { default: criarRodapeInstitucional() },
                properties: {
                    page: { margin: MARGENS_PAGINA },
                    column: { count: 2, space: 720, separate: true }
                },
                children: questoesChildren
            }
        ]
    });
    return Packer.toBuffer(doc);
}

function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Gabarito clicável direto na pré-visualização — pedido explícito (18/09):
// "editar no final seria legal, aí já atualiza no banco também, na mesma
// tela aonde tem pra visualizar e imprimir a prova". Cada alternativa é um
// botão (data-letra); o clique é tratado no frontend (app.js), que chama
// PUT /questoes/:id/gabarito e atualiza a questão de verdade no banco — o
// HTML aqui só marca visualmente qual é a correta AGORA.
function htmlGabaritoEditavel(q) {
    return `<div class="bp-prev-gabarito-editor">${(q.alternativas || []).map(alt => `
        <button type="button" class="bp-prev-alt-btn${alt.letra === q.gabarito ? ' bp-prev-alt-correta' : ''}" data-letra="${escHtml(alt.letra)}">${escHtml(alt.letra)}) ${escHtml(alt.texto)}</button>`).join('')}</div>`;
}

// Pré-visualização em HTML antes de gerar o .docx final — pedido explícito
// (18/09): "poderia ter uma tela para a pessoa ver a prova antes de
// baixar... se precisar alterar alguma coisa já sai certo". Reaproveita as
// MESMAS constantes/ordenação do gerador de .docx (MISSAO, ORIENTACOES,
// CHAMADA_LABEL, numerarQuestoesObjetivas) pra nunca divergir do arquivo
// real — só a "renderização" é diferente (HTML em vez de Paragraph/Table).
function previewHtmlBimestralOuExame(prova, questoes, opts) {
    const objetivas = questoes.filter(q => q.tipo === 'objetiva');
    const dissertativas = questoes.filter(q => q.tipo === 'dissertativa');
    const valorObjetivas = objetivas.reduce((s, q) => s + (q.valor || 0), 0);
    const valorDissertativas = dissertativas.reduce((s, q) => s + (q.valor || 0), 0);

    const titulo = prova.tipo === 'exame' ? 'EXAME' : 'PROVA BIMESTRAL';
    const tituloComChamada = prova.chamada ? `${titulo} (${CHAMADA_LABEL[prova.chamada]})` : titulo;

    // Mesma estrutura de 3 colunas da tabela do .docx (ver
    // tabelaCabecalhoBimestral): "Estou Ciente" ocupa 3 linhas ao lado de
    // Curso/Período/Disciplina, com linhas de respiro antes de Professor(a)
    // e antes de Valor.
    const linhaCab = (a, b) => `<tr><td class="bp-prev-cel">${escHtml(a)}</td><td class="bp-prev-cel" colspan="2">${escHtml(b)}</td></tr>`;
    const linhaCheiaHtml = (texto) => `<tr><td class="bp-prev-cel" colspan="3">${escHtml(texto)}</td></tr>`;
    const cabecalho = `
        <table class="bp-prev-tabela-cab">
            <tr>
                <td class="bp-prev-cel" colspan="2">Acadêmico(a):</td>
                <td class="bp-prev-cel bp-prev-cel-ciente" rowspan="3">
                    <div>Estou Ciente</div>
                    <div>_____/_____/_____</div>
                </td>
            </tr>
            <tr><td class="bp-prev-cel">Curso: ${escHtml(opts.cursoNome)}</td><td class="bp-prev-cel">Período: ${escHtml(opts.periodoLabel || '')}</td></tr>
            <tr><td class="bp-prev-cel" colspan="2">Disciplina: ${escHtml(opts.disciplinaNome || '')}</td></tr>
            ${linhaCheiaHtml('')}
            ${linhaCheiaHtml(`Professor(a): ${prova.professorNome || ''}`)}
            ${linhaCab('Data: ____/____/______', prova.tipo === 'exame' ? '' : '(  ) 1º Bimestre      (  ) 2º Bimestre')}
            ${linhaCheiaHtml('')}
            ${linhaCab(`Valor: ${valorObjetivas + valorDissertativas || ''}`, 'Nota: ______')}
        </table>`;

    const orientacoes = `
        <p>${escHtml(MISSAO)}</p>
        <p class="bp-prev-negrito">ORIENTAÇÕES PARA A PROVA</p>
        <ul class="bp-prev-lista">${ORIENTACOES.map(o => `<li>${escHtml(o)}</li>`).join('')}</ul>`;

    const gabaritoGrid = objetivas.length ? `
        <p class="bp-prev-negrito bp-prev-centro">GABARITO</p>
        <table class="bp-prev-tabela-gabarito">
            <tr>${objetivas.map((_, i) => `<td>${String(i + 1).padStart(2, '0')}</td>`).join('')}</tr>
            <tr>${objetivas.map(() => '<td>&nbsp;</td>').join('')}</tr>
        </table>` : '';

    const blocoObjetivas = objetivas.length ? `
        <p class="bp-prev-negrito bp-prev-centro">QUESTÕES OBJETIVAS${valorObjetivas ? ` (${valorObjetivas.toFixed(2)} no total)` : ''}</p>
        ${objetivas.map((q, i) => `
            <div class="bp-prev-questao" data-questao-id="${escHtml(q.id)}">
                <p>${i + 1}. ${escHtml(q.enunciadoHtml)}</p>
                ${htmlGabaritoEditavel(q)}
            </div>`).join('')}` : '';

    const blocoDissertativas = dissertativas.length ? `
        <p class="bp-prev-negrito bp-prev-centro">QUESTÕES DISSERTATIVAS${valorDissertativas ? ` (${valorDissertativas.toFixed(2)} no total)` : ''}</p>
        ${dissertativas.map((q, i) => `
            <div class="bp-prev-questao">
                <p>${i + 1}. ${escHtml(q.enunciadoHtml)}</p>
                ${Array.from({ length: 4 }, () => '<div class="bp-prev-linha-resposta"></div>').join('')}
            </div>`).join('')}` : '';

    return `
        <p class="bp-prev-titulo">${escHtml(tituloComChamada)}</p>
        ${cabecalho}
        ${orientacoes}
        ${gabaritoGrid}
        ${blocoObjetivas}
        ${blocoDissertativas}
        <p class="bp-prev-negrito bp-prev-centro">Boa Prova!</p>`;
}

function previewHtmlSimulado(prova, questoes, opts) {
    const numeradas = numerarQuestoesObjetivas(prova, questoes, opts);
    const blocos = [];
    let secaoAtual = null;
    numeradas.forEach(({ numero, questao, secaoNome }) => {
        if (secaoNome !== secaoAtual) {
            blocos.push(`<p class="bp-prev-negrito">${escHtml(secaoNome)}</p>`);
            secaoAtual = secaoNome;
        }
        blocos.push(`
            <div class="bp-prev-questao" data-questao-id="${escHtml(questao.id)}">
                <p class="bp-prev-negrito">Questão ${String(numero).padStart(2, '0')}</p>
                <p>${escHtml(questao.enunciadoHtml)}</p>
                ${htmlGabaritoEditavel(questao)}
            </div>`);
    });
    return `<p class="bp-prev-titulo">SIMULADO</p>${blocos.join('')}`;
}

async function gerarPreviewHtml(prova, questoes, opts) {
    return prova.tipo === 'simulado'
        ? previewHtmlSimulado(prova, questoes, opts)
        : previewHtmlBimestralOuExame(prova, questoes, opts);
}

async function gerarProvaDocx(prova, questoes, opts) {
    if (prova.tipo === 'simulado') return gerarDocxSimulado(prova, questoes, opts);
    return gerarDocxBimestralOuExame(prova, questoes, opts);
}

// Gabarito separado — nunca vai junto do arquivo do aluno. Mesma numeração
// da prova impressa (ver numerarQuestoesObjetivas), só com a letra correta
// ao lado. Dissertativa não tem "gabarito" fechado — entra numa lista à
// parte só apontando que a correção é manual.
const TIPO_PROVA_LABEL = { simulado: 'Simulado', bimestral: 'Prova Bimestral', exame: 'Exame' };
const BIMESTRE_LABEL = { 1: '1º Bimestre', 2: '2º Bimestre' };

async function gerarGabaritoDocx(prova, questoes, opts) {
    const numeradas = numerarQuestoesObjetivas(prova, questoes, opts);
    const dissertativas = questoes.filter(q => q.tipo === 'dissertativa');

    // Pedido explícito (18/09): mesmo cabeçalho/rodapé institucional da
    // prova, nome completo da prova bem visível, e só número + alternativa
    // certa — sem resumo do enunciado (isso é só pra secretaria conferir
    // rápido, não pra reler a questão). Disciplina/Bimestre/Tipo/Professor(a)
    // também precisam vir aqui (pedido explícito 18/09) — antes só tinha o
    // nome da prova, sem esses dados de identificação.
    const disciplinaLabel = prova.tipo === 'simulado'
        ? 'Simulado (várias disciplinas)'
        : (opts.disciplinaNome || '—');
    const linhaInfo = (a, b) => new TableRow({ children: [celulaTexto(a, { width: 50 }), celulaTexto(b, { width: 50 })] });
    const tabelaInfo = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: SEM_BORDA,
        rows: [
            linhaInfo(`Disciplina: ${disciplinaLabel}`, `Tipo de prova: ${TIPO_PROVA_LABEL[prova.tipo] || prova.tipo}`),
            // Exame não tem bimestre (acontece só depois do 2º bimestre) —
            // pedido explícito (18/09).
            prova.tipo === 'exame'
                ? linhaInfo(`Professor(a): ${prova.professorNome || '—'}`, '')
                : linhaInfo(`Bimestre: ${BIMESTRE_LABEL[prova.bimestre] || '—'}`, `Professor(a): ${prova.professorNome || '—'}`)
        ]
    });

    const linhaCabecalho = new TableRow({
        children: [celulaTexto('Nº', { bold: true, width: 50 }), celulaTexto('Gabarito', { bold: true, width: 50 })]
    });
    const linhas = numeradas.map(({ numero, questao }) => new TableRow({
        children: [
            celulaTexto(String(numero), { width: 50 }),
            celulaTexto(questao.gabarito || '—', { bold: true, width: 50 })
        ]
    }));

    const children = [
        paragrafo('GABARITO', { bold: true, align: AlignmentType.CENTER, size: 28, after: 60 }),
        paragrafo(prova.nome, { bold: true, align: AlignmentType.CENTER, size: 24, after: 60 }),
        paragrafo('Uso interno — não entregar ao aluno.', { align: AlignmentType.CENTER, after: 150, size: 18 }),
        tabelaInfo,
        paragrafo('', { after: 150 })
    ];

    if (numeradas.length) {
        children.push(new Table({ width: { size: 40, type: WidthType.PERCENTAGE }, borders: SEM_BORDA, rows: [linhaCabecalho, ...linhas] }));
    }

    if (dissertativas.length) {
        children.push(paragrafo('', { after: 200 }));
        children.push(paragrafo('QUESTÕES DISSERTATIVAS (correção manual, sem gabarito fechado)', { bold: true, after: 100 }));
        dissertativas.forEach((q, i) => children.push(paragrafo(`${i + 1}. ${String(q.enunciadoHtml || '').slice(0, 140)}`, { size: 20, after: 60 })));
    }

    const doc = new Document({
        sections: [{
            headers: { default: criarCabecalhoInstitucional() },
            footers: { default: criarRodapeInstitucional() },
            properties: { page: { margin: MARGENS_PAGINA } },
            children
        }]
    });
    return Packer.toBuffer(doc);
}

module.exports = { gerarProvaDocx, gerarGabaritoDocx, gerarPreviewHtml };
