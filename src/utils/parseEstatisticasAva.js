// ================================================================
//  ÓRBITA — RELATÓRIO DESEMPENHO (Medicina)
//  Leitura do export de "Estatísticas do questionário" do AVA (Open LMS /
//  Moodle) e cálculo da análise psicométrica de cada item.
//
//  Formatos aceitos:
//    .csv / .tsv / .txt  — download direto da página de Estatísticas
//    .xlsx / .xls        — mesmo download em Excel (usa a dep `xlsx` que o
//                          projeto já tem por causa de Matrículas)
//    .pdf                — só funciona se `pdf-parse` estiver instalado; sem
//                          ele a rota devolve uma mensagem pedindo o CSV.
//
//  O CSV é sempre o caminho mais confiável: o PDF depende de como o Open LMS
//  quebrou as linhas na hora de imprimir.
//
//  O layout do CSV foi conferido contra um export real do AVA da instituição
//  ("SAUD.MENT. - Prova · 1º Bimestre-Status.csv", 45 questões):
//    - o cabeçalho do questionário vem como DUAS linhas (rótulos + valores),
//      não como pares rótulo/valor;
//    - números negativos saem escapados pro Excel: "'-8,22%";
//    - a análise de respostas vem SEM coluna Q#: é um bloco
//      "Resposta do modelo / Crédito parcial / Número / Frequência" por
//      questão, na ordem da tabela;
//    - a última alternativa de cada bloco é sempre "[Não há resposta]".
//  Versões mais antigas do Moodle usam pares rótulo/valor e uma coluna Q# na
//  análise de respostas — os dois formatos seguem lidos.
// ================================================================

// ---- Faixas do índice de discriminação (em %) -------------------
// Referência clássica de análise de itens. Mexer aqui muda o relatório
// inteiro (cards, cores, lista de revisão) — é o único lugar que define isso.
const FAIXAS = [
    { nome: 'Problemática', min: -Infinity, max: 0 },
    { nome: 'Fraca', min: 0, max: 20 },
    { nome: 'Razoável', min: 20, max: 30 },
    { nome: 'Boa', min: 30, max: 50 },
    { nome: 'Excelente', min: 50, max: Infinity }
];

const LIMITE_REVISAO = 20;        // abaixo disso a questão entra na lista de revisão
const FACILIDADE_MUITO_ALTA = 85; // acima disso "quase todos acertaram"
const FACILIDADE_MUITO_BAIXA = 30;

// ---- Normalização de texto e números ----------------------------

function semAcento(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
        .normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Normaliza um rótulo pra comparação: sem acento, minúsculo, sem pontuação.
function chave(texto) {
    return semAcento(texto).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const txt = v => String(v === null || v === undefined ? '' : v).trim();

// Converte "93,85%", "93.85 %", "0,9385", "'-8,22%" (escape do Excel pra
// negativo) ou 65 em número na escala 0–100. Devolve null quando não há
// número (célula vazia, travessão, etc.).
function num(valor) {
    if (valor === null || valor === undefined) return null;
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;

    let s = String(valor).trim();
    if (!s || ['-', '—', '–', 'n/a'].includes(s.toLowerCase())) return null;

    const temPct = s.includes('%');
    s = s.replace(/%/g, '').trim().replace(/[^\d,.\-+]/g, '');
    if (!s || s === '-' || s === '+') return null;

    // Decide qual separador é o decimal
    if (s.includes(',') && s.includes('.')) {
        s = s.lastIndexOf(',') > s.lastIndexOf('.')
            ? s.replace(/\./g, '').replace(',', '.')   // 1.234,56
            : s.replace(/,/g, '');                      // 1,234.56
    } else if (s.includes(',')) {
        s = s.replace(',', '.');
    }

    const v = parseFloat(s);
    if (!Number.isFinite(v)) return null;

    // O Moodle às vezes entrega o índice como fração (0.9385 / 1,00) em vez
    // de percentual — nesse caso a escala precisa ser corrigida.
    if (!temPct && v >= -1 && v <= 1 && s.includes('.')) return v * 100;
    return v;
}

// ---- Rótulos das colunas / campos do Moodle (PT-BR e EN) --------

const COLUNAS = {
    nome: ['nome da questao', 'question name'],
    tentativas: ['tentativas', 'attempts'],
    facilidade: ['indice de facilidade', 'facility index', 'facilidade'],
    desvio: ['desvio padrao', 'standard deviation'],
    pesoEfetivo: ['peso efetivo', 'effective weight'],
    discriminacao: ['indice de discriminacao', 'discrimination index', 'discriminacao'],
    eficiencia: ['eficiencia de discriminacao', 'eficiencia discriminativa', 'discriminative efficiency', 'eficiencia']
};

// A coluna do número da questão é casada por igualdade, nunca por prefixo:
// "Q" pegaria qualquer coluna começada em Q ("Quantidade de...").
const COLUNA_N = ['q', 'q num', 'n', 'numero da questao'];

// Ordem importa: o primeiro rótulo que casar é o que vale, então os mais
// específicos vêm antes ("Nota média das primeiras tentativas" tem que
// ganhar de "Nota mediana...", que também começa com "nota media").
const CAMPOS_META = {
    titulo: ['nome do questionario', 'quiz name'],
    cursoTurma: ['nome do curso', 'course name', 'curso'],
    aplicacao: ['abrir o questionario', 'aberto em', 'quiz opened', 'abertura'],
    encerramento: ['encerrar o questionario', 'fechar em', 'quiz closed', 'encerramento', 'fechado em'],
    nAlunos: [
        'quantidade de primeiras tentativas avaliadas',
        'numero total de primeiras tentativas completas avaliadas',
        'number of complete graded first attempts',
        'primeiras tentativas completas avaliadas'
    ],
    notaMedia: [
        'nota media das primeiras tentativas',
        'average grade of first attempts',
        'nota media de todas as tentativas'
    ],
    desvioPadrao: ['desvio padrao', 'standard deviation of grades'],
    consistenciaInterna: [
        'coeficiente de consistencia interna',
        'coefficient of internal consistency',
        'consistencia interna'
    ]
};

function casarCampoMeta(rotulo) {
    const k = chave(rotulo);
    if (!k) return null;
    for (const [campo, aliases] of Object.entries(CAMPOS_META)) {
        if (aliases.some(a => k === a || k.startsWith(a))) return campo;
    }
    return null;
}

function mapearCabecalho(linha) {
    const mapa = {};
    const normal = linha.map(c => chave(c));

    normal.forEach((c, i) => {
        if (c && COLUNA_N.includes(c) && mapa.n === undefined) mapa.n = i;
    });
    for (const [campo, aliases] of Object.entries(COLUNAS)) {
        for (let i = 0; i < normal.length; i++) {
            if (!normal[i]) continue;
            if (aliases.some(a => normal[i] === a || normal[i].startsWith(a))) {
                if (mapa[campo] === undefined) mapa[campo] = i;
                break;
            }
        }
    }
    return mapa;
}

// Grava um valor de cabeçalho já no tipo certo (data, inteiro ou percentual).
function atribuirMeta(meta, campo, valor) {
    const v = txt(valor);
    if (!v || meta[campo] !== undefined) return;
    if (campo === 'aplicacao' || campo === 'encerramento') meta[campo] = dataParaIso(v);
    else if (campo === 'titulo') meta.titulo = limparTitulo(v);
    else if (campo === 'cursoTurma') meta.cursoTurma = v;
    else if (campo === 'nAlunos') { const n = num(v); if (n !== null) meta.nAlunos = Math.round(n); }
    else { const n = num(v); if (n !== null) meta[campo] = n; }
}


// Professores marcam o questionário com emoji no AVA ("📝 Prova · 1º Bimestre").
// No relatório impresso isso vira ruído — tira do começo do título.
function limparTitulo(valor) {
    return txt(valor)
        .replace(/^[\s\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]+/u, '')
        .trim();
}

// Datas do Moodle → ISO curto (2026-04-14T13:30). Cobre "14/04/2026 13:30" e
// "segunda-feira, 21 set. 2026, 08:00". Se não reconhecer, devolve o texto
// como veio — o docente ajusta no cabeçalho editável do relatório.
const MESES = {
    jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
    jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12
};

function dataParaIso(texto) {
    const t = txt(texto);
    if (!t) return '';
    const p = n => String(n).padStart(2, '0');

    let m = t.match(/(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})(?:[,\s]+(\d{1,2})[:h](\d{2}))?/);
    if (m) {
        let ano = parseInt(m[3], 10);
        if (ano < 100) ano += 2000;
        return `${ano}-${p(m[2])}-${p(m[1])}T${p(m[4] || 0)}:${p(m[5] || 0)}`;
    }

    // "21 set. 2026, 08:00" / "21 de setembro de 2026 08:00"
    m = semAcento(t).toLowerCase()
        .match(/(\d{1,2})\s+(?:de\s+)?([a-z]{3,})\.?\s+(?:de\s+)?(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/);
    if (m) {
        const mes = MESES[m[2].slice(0, 3)];
        if (mes) return `${m[3]}-${p(mes)}-${p(m[1])}T${p(m[4] || 0)}:${p(m[5] || 0)}`;
    }
    return t;
}

// ---- Leitura de CSV ---------------------------------------------

// Parser de CSV com aspas — o texto de uma alternativa costuma ter vírgula e
// até quebra de linha dentro das aspas.
function lerCsv(texto, sep) {
    const linhas = [];
    let campo = '';
    let linha = [];
    let dentroDeAspas = false;

    for (let i = 0; i < texto.length; i++) {
        const c = texto[i];
        if (dentroDeAspas) {
            if (c === '"') {
                if (texto[i + 1] === '"') { campo += '"'; i++; }
                else dentroDeAspas = false;
            } else campo += c;
            continue;
        }
        if (c === '"') { dentroDeAspas = true; continue; }
        if (c === sep) { linha.push(campo); campo = ''; continue; }
        if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
        if (c === '\r') continue;
        campo += c;
    }
    if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
}

function detectarSeparador(texto) {
    // Conta só fora das aspas — o texto das alternativas é cheio de vírgula.
    const amostra = texto.slice(0, 20000);
    const contagem = { ',': 0, ';': 0, '\t': 0 };
    let dentro = false;
    for (const c of amostra) {
        if (c === '"') { dentro = !dentro; continue; }
        if (!dentro && contagem[c] !== undefined) contagem[c]++;
    }
    const melhor = Object.entries(contagem).sort((a, b) => b[1] - a[1])[0];
    return melhor[1] > 0 ? melhor[0] : ',';
}

// ---- Extração da tabela (vale pra CSV e pra XLSX) ---------------

function extrairDeGrade(linhas) {
    const meta = {};
    const questoes = [];

    lerCabecalhoDoQuestionario(linhas, meta);

    // Tabela de estatísticas por questão
    let idxCabecalho = -1;
    let mapa = {};
    for (let i = 0; i < linhas.length; i++) {
        const m = mapearCabecalho(linhas[i].map(txt));
        if (m.facilidade !== undefined && (m.discriminacao !== undefined || m.nome !== undefined)) {
            idxCabecalho = i;
            mapa = m;
            break;
        }
    }
    if (idxCabecalho === -1) return { meta, questoes, achouTabela: false };

    const celula = (linha, campo) => {
        const i = mapa[campo];
        return (i === undefined || i >= linha.length) ? '' : txt(linha[i]);
    };

    let contador = 0;
    let fimDaTabela = linhas.length;
    for (let i = idxCabecalho + 1; i < linhas.length; i++) {
        const linha = linhas[i];
        const rotuloN = mapa.n !== undefined ? celula(linha, 'n') : '';
        const vazia = !linha.some(c => txt(c));

        // A tabela acaba na primeira linha que não é mais uma questão: linha
        // em branco, rodapé de totais, ou — no export atual do Open LMS — o
        // cabeçalho "Resposta do modelo" que vem grudado logo embaixo.
        if (questoes.length) {
            if (vazia) { fimDaTabela = i; break; }
            if (mapa.n !== undefined && !/^\d+(\.\d+)?$/.test(rotuloN)) { fimDaTabela = i; break; }
            if (['total', 'media', 'totais'].includes(chave(celula(linha, 'nome')))) { fimDaTabela = i; break; }
        } else if (vazia) {
            continue;
        }

        const nome = celula(linha, 'nome');
        const facilidade = num(celula(linha, 'facilidade'));
        if (!nome && facilidade === null) continue;

        contador++;
        const nLido = rotuloN ? num(rotuloN) : null;
        const tentativas = num(celula(linha, 'tentativas'));

        questoes.push({
            n: nLido !== null ? Math.round(nLido) : contador,
            nome: nome || `Questão ${contador}`,
            tentativas: tentativas !== null ? Math.round(tentativas) : null,
            facilidade,
            desvio: num(celula(linha, 'desvio')),
            pesoEfetivo: num(celula(linha, 'pesoEfetivo')),
            discriminacao: num(celula(linha, 'discriminacao')),
            eficiencia: num(celula(linha, 'eficiencia')),
            alternativas: []
        });
    }

    const avisos = lerAnaliseDeRespostas(linhas, questoes, fimDaTabela) || [];
    return { meta, questoes, achouTabela: questoes.length > 0, avisos };
}

// O cabeçalho do questionário vem de dois jeitos conforme a versão do AVA:
//   (a) tabela de duas linhas — uma de rótulos, a seguinte com os valores;
//   (b) pares rótulo/valor, um por linha.
// Tenta (a) primeiro e completa o que faltar com (b).
function lerCabecalhoDoQuestionario(linhas, meta) {
    for (let i = 0; i < linhas.length; i++) {
        const campos = linhas[i].map(casarCampoMeta);
        const achados = campos.filter(Boolean).length;
        if (achados < 3 || !linhas[i + 1]) continue;

        const valores = linhas[i + 1];
        campos.forEach((campo, j) => { if (campo) atribuirMeta(meta, campo, valores[j]); });
        break;
    }

    for (const linha of linhas) {
        const celulas = linha.map(txt);
        if (celulas.filter(Boolean).length < 2) continue;
        const campo = casarCampoMeta(celulas[0]);
        if (!campo) continue;
        atribuirMeta(meta, campo, celulas.slice(1).find(Boolean) || '');
    }
}

const CABECALHO_RESPOSTAS = ['resposta do modelo', 'modelo de resposta', 'response'];
const SEM_RESPOSTA = ['nao ha resposta', 'no answer'];

// Percentual de alunos em cada alternativa. Dois formatos:
//   (a) Open LMS atual — um cabeçalho "Resposta do modelo / Crédito parcial /
//       Número / Frequência" por questão, SEM coluna Q#: os blocos vêm na
//       mesma ordem da tabela de questões;
//   (b) Moodle mais antigo — um cabeçalho só, com Q# na primeira coluna.
function lerAnaliseDeRespostas(linhas, questoes, inicio) {
    // Dois cabeçalhos de bloco convivem no MESMO arquivo, conforme o tipo da
    // questão: "Resposta do modelo | Crédito parcial | Número | Frequência" e
    // "Parte da questão | Resposta | Crédito parcial | Número | Frequência"
    // (este com o código da alternativa na 1ª coluna). Antes só o primeiro
    // era reconhecido: as alternativas dos blocos do segundo tipo iam todas
    // pra última questão do primeiro — ex.: Q6 com 299 alternativas e da Q7
    // em diante vazias (25/09).
    const ehCabecalho = linha => {
        const c = linha.map(chave);
        if (c.some(x => CABECALHO_RESPOSTAS.some(a => x.startsWith(a)))) return true;
        return c.some(x => x.startsWith('parte da questao')) && c.some(x => x === 'resposta');
    };

    const cabecalhos = [];
    for (let i = Math.max(0, inicio - 1); i < linhas.length; i++) {
        if (ehCabecalho(linhas[i])) cabecalhos.push(i);
    }
    if (!cabecalhos.length) return [];

    // Linha de alternativa sempre traz a contagem ou a frequência. O que não
    // traz (ex.: a página de erro em HTML que o AVA cola no fim do CSV quando
    // corta o export no meio) não é alternativa.
    const ehDados = (get, cols) => num(get(cols.contagem)) !== null || num(get(cols.freq)) !== null;
    const veioCortado = linhas.some(l => /^\s*<(!doctype|html)/i.test(txt(l[0])));

    const colunasDe = (linha) => {
        const cab = linha.map(chave);
        const col = (...aliases) => {
            for (let i = 0; i < cab.length; i++) {
                if (aliases.some(a => cab[i] === a || cab[i].startsWith(a))) return i;
            }
            return undefined;
        };
        return {
            q: col('q', 'numero da questao'),
            texto: col(...CABECALHO_RESPOSTAS, 'resposta'),
            credito: col('credito parcial', 'partial credit'),
            contagem: col('numero', 'contagem', 'count'),
            freq: col('frequencia', 'frequency')
        };
    };

    const primeiras = colunasDe(linhas[cabecalhos[0]]);
    const temColunaQ = primeiras.q !== undefined && primeiras.q !== primeiras.texto;

    // Formato (b): um cabeçalho único com Q#
    if (temColunaQ && cabecalhos.length === 1) {
        const porN = new Map(questoes.map(q => [q.n, q]));
        let atual = null;
        for (let i = cabecalhos[0] + 1; i < linhas.length; i++) {
            const linha = linhas[i];
            const get = idx => (idx === undefined || idx >= linha.length) ? '' : txt(linha[idx]);
            const rot = get(primeiras.q);
            if (rot) {
                const v = num(rot);
                if (v !== null && porN.has(Math.round(v))) atual = porN.get(Math.round(v));
            }
            if (!atual || !ehDados(get, primeiras)) continue;
            adicionarAlternativa(atual, get(primeiras.texto), get(primeiras.credito), get(primeiras.contagem), get(primeiras.freq));
        }
        return veioCortado ? ['O arquivo veio cortado do AVA (tem uma página de erro no fim). Baixe o CSV de novo e gere outro relatório.'] : [];
    }

    // Formato (a): um bloco por questão, na ordem
    cabecalhos.forEach((idxCab, bloco) => {
        const questao = questoes[bloco];
        if (!questao) return;
        const cols = colunasDe(linhas[idxCab]);
        const fim = (bloco + 1 < cabecalhos.length) ? cabecalhos[bloco + 1] : linhas.length;

        for (let i = idxCab + 1; i < fim; i++) {
            const linha = linhas[i];
            const get = idx => (idx === undefined || idx >= linha.length) ? '' : txt(linha[idx]);
            if (!ehDados(get, cols)) continue;
            adicionarAlternativa(questao, get(cols.texto), get(cols.credito), get(cols.contagem), get(cols.freq));
        }
    });

    // Os blocos vêm na ordem das questões; se vier menos bloco que questão, o
    // export foi cortado e as últimas ficam sem alternativas — avisa em vez
    // de deixar o relatório parecer completo.
    const avisos = [];
    if (cabecalhos.length < questoes.length) {
        const primeiraSem = questoes[cabecalhos.length];
        avisos.push(
            `O arquivo trouxe as alternativas de só ${cabecalhos.length} das ${questoes.length} questões ` +
            `(da Q${primeiraSem ? primeiraSem.n : cabecalhos.length + 1} em diante veio sem)` +
            (veioCortado ? ' — o AVA cortou o export no meio (tem uma página de erro no fim do arquivo)' : '') +
            '. Os índices de cada questão estão completos; para ter as alternativas, baixe o CSV de novo e gere outro relatório.'
        );
    } else if (cabecalhos.length > questoes.length) {
        avisos.push(`O arquivo tem ${cabecalhos.length} blocos de alternativas para ${questoes.length} questões — confira as alternativas antes de usar o relatório.`);
    } else if (veioCortado) {
        avisos.push('O arquivo veio com uma página de erro do AVA no fim — confira se nada ficou faltando.');
    }
    return avisos;
}

function adicionarAlternativa(questao, texto, credito, contagem, freq) {
    const t = txt(texto).replace(/\s+/g, ' ').trim();
    if (!t) return;

    const c = num(contagem);
    const qtd = c !== null ? Math.round(c) : null;

    // "[Não há resposta]" é uma linha fixa do export — só interessa quando
    // alguém realmente deixou a questão em branco.
    if (SEM_RESPOSTA.some(a => chave(t).includes(a)) && !qtd) return;

    const cred = num(credito);
    questao.alternativas.push({
        texto: t,
        correta: cred !== null && cred >= 99, // 1,00 e 100,00% chegam aqui como 100
        contagem: qtd,
        frequencia: num(freq)
    });
}

// ---- Leitura de PDF ---------------------------------------------

// Uma linha da tabela termina em vários números/percentuais seguidos.
const LINHA_QUESTAO = /^\s*(\d{1,3})(?:\.\d+)?\s+(.+?)\s+((?:[-+]?[\d.,]+\s*%?\s+){2,}[-+]?[\d.,]+\s*%?)\s*$/;

function extrairDeTextoPdf(texto) {
    const linhas = texto.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
    const meta = {};
    const questoes = [];

    for (const linha of linhas) {
        let rotulo, valor;
        if (linha.includes(':')) {
            const p = linha.indexOf(':');
            rotulo = linha.slice(0, p);
            valor = linha.slice(p + 1);
        } else {
            const m = linha.match(/^\s*([A-Za-zÀ-ÿ º°()/]+?)\s{2,}(.+)$/);
            if (!m) continue;
            rotulo = m[1];
            valor = m[2];
        }
        const campo = casarCampoMeta(rotulo);
        if (campo) atribuirMeta(meta, campo, valor);
    }

    for (const linha of linhas) {
        const m = linha.match(LINHA_QUESTAO);
        if (!m) continue;

        const nome = m[2].replace(/^[\s.·-]+|[\s.·-]+$/g, '');
        if (!nome || ['total', 'media'].includes(chave(nome))) continue;

        const numeros = (m[3].match(/[-+]?[\d.,]+\s*%?/g) || []).map(num).filter(v => v !== null);
        if (numeros.length < 3) continue;

        // Ordem padrão do Moodle: tentativas, facilidade, desvio,
        // [adivinhação], [peso planejado], peso efetivo, discriminação, eficiência
        questoes.push({
            n: parseInt(m[1], 10),
            nome,
            tentativas: numeros[0] >= 1 ? Math.round(numeros[0]) : null,
            facilidade: numeros.length > 1 ? numeros[1] : null,
            desvio: numeros.length > 2 ? numeros[2] : null,
            pesoEfetivo: numeros.length >= 5 ? numeros[numeros.length - 3] : null,
            discriminacao: numeros[numeros.length - 2],
            eficiencia: numeros[numeros.length - 1],
            alternativas: []
        });
    }

    lerAnaliseDeRespostasPdf(linhas, questoes);
    return { meta, questoes, achouTabela: questoes.length > 0 };
}

function lerAnaliseDeRespostasPdf(linhas, questoes) {
    const porN = new Map(questoes.map(q => [q.n, q]));
    let atual = null;
    let bloco = -1;
    let dentro = false;

    for (const linha of linhas) {
        const k = chave(linha);
        if (CABECALHO_RESPOSTAS.some(a => k.startsWith(a)) || k.includes('credito parcial')) {
            dentro = true;
            bloco++;
            if (!porN.size) continue;
            // Sem coluna Q# no PDF, cada cabeçalho abre a próxima questão.
            atual = questoes[bloco] || atual;
            continue;
        }
        if (!dentro) continue;

        // "12 Entre a dura-máter e a vertebra 1,00 21 32,31%"
        const m = linha.match(/^\s*(?:(\d{1,3})(?:\.\d+)?\s+)?(.+?)\s+([01](?:[.,]\d+)?|\d{1,3}(?:[.,]\d+)?%)\s+(\d+)\s+([\d.,]+)\s*%\s*$/);
        if (!m) continue;

        if (m[1]) {
            const n = parseInt(m[1], 10);
            if (porN.has(n)) atual = porN.get(n);
        }
        if (!atual) continue;
        adicionarAlternativa(atual, m[2], m[3], m[4], m[5] + '%');
    }
}

// ---- Entrada principal ------------------------------------------

class ErroDeLeitura extends Error {}

/**
 * Lê o export de Estatísticas do AVA.
 * @param {Buffer} buffer conteúdo do arquivo
 * @param {string} nomeArquivo usado só pra decidir o formato
 * @returns {{meta: object, questoes: object[]}} (Promise no caminho do PDF)
 */
function parseEstatisticas(buffer, nomeArquivo) {
    const ext = String(nomeArquivo || '').toLowerCase().split('.').pop();
    const ehPdf = ext === 'pdf' || (buffer.length > 4 && buffer.slice(0, 4).toString() === '%PDF');
    let resultado;

    if (!ehPdf && (ext === 'xlsx' || ext === 'xls' || ext === 'ods')) {
        const XLSX = require('xlsx');
        const wb = XLSX.read(buffer, { type: 'buffer' });
        // A tabela pode estar em qualquer aba — fica com a primeira que tiver
        // um cabeçalho reconhecível.
        for (const nomeAba of wb.SheetNames) {
            const grade = XLSX.utils.sheet_to_json(wb.Sheets[nomeAba], { header: 1, raw: false, defval: '' });
            const r = extrairDeGrade(grade);
            if (r.achouTabela) { resultado = r; break; }
            if (!resultado) resultado = r;
        }
    } else if (ehPdf) {
        let pdfParse;
        try {
            pdfParse = require('pdf-parse');
        } catch (e) {
            throw new ErroDeLeitura(
                'A leitura de PDF exige a biblioteca pdf-parse (rode `npm install` no servidor). ' +
                'Enquanto isso, exporte a mesma página do AVA em CSV — o resultado é mais confiável.'
            );
        }
        // pdf-parse é assíncrono; quem chama precisa dar await no resultado.
        return pdfParse(buffer).then(dados => finalizar(extrairDeTextoPdf(dados.text || '')));
    } else {
        const texto = buffer.toString('utf8').replace(/^﻿/, '');
        resultado = extrairDeGrade(lerCsv(texto, detectarSeparador(texto)));
    }

    return finalizar(resultado);
}

function finalizar(resultado) {
    if (!resultado || !resultado.achouTabela || !resultado.questoes.length) {
        // Com 1 tentativa só, o AVA nem gera as colunas de facilidade e
        // discriminação — não é arquivo errado, é prova sem dado estatístico.
        const n = resultado && resultado.meta ? resultado.meta.nAlunos : undefined;
        if (n !== undefined && n !== null && n < 2) {
            throw new ErroDeLeitura(
                `Esta avaliação tem só ${n} tentativa${n === 1 ? '' : 's'} — com isso o AVA não calcula facilidade ` +
                'nem discriminação, então não há o que analisar. Use o export de uma aplicação com a turma toda.'
            );
        }
        throw new ErroDeLeitura(
            'Não encontrei a tabela de estatísticas por questão neste arquivo. ' +
            'Confira se ele é o download da página "Estatísticas" do questionário no AVA.'
        );
    }
    resultado.questoes.sort((a, b) => a.n - b.n);
    return { meta: resultado.meta || {}, questoes: resultado.questoes, avisos: resultado.avisos || [] };
}

// "2026.2 - T.3 - 2° PER - MECANISMOS DE DEFESAS E DOENÇAS" (o "Nome do curso"
// no export) → semestre, turma, período e disciplina, pra tela de novo
// relatório já vir preenchida e o professor só confirmar (25/09).
function sugerirCabecalho(meta) {
    const cursoTurma = txt(meta && meta.cursoTurma);
    const base = { titulo: txt(meta && meta.titulo), cursoTurma };
    const m = cursoTurma.match(/^(\d{4}\.\d)\s*-\s*(T\s*\.?\s*\d+)\s*-\s*(\d{1,2})\s*[°ºo]?\s*PER\w*\s*-\s*(.+)$/i);
    if (!m) return base;
    const periodo = parseInt(m[3], 10);
    return {
        ...base,
        semestre: m[1],
        turma: `${m[2].replace(/\s+/g, '').toUpperCase()} - ${periodo}º PER`,
        periodo,
        disciplina: m[4].trim()
    };
}

// ---- Psicometria derivada ---------------------------------------

function temNumero(v) { return v !== null && v !== undefined && Number.isFinite(v); }

function classificar(discriminacao) {
    // Sem índice: o AVA deixa a célula vazia quando o desvio padrão é zero
    // (todo mundo acertou ou todo mundo errou). A questão não diferencia
    // ninguém, então entra como Fraca — e cai na lista de revisão.
    if (!temNumero(discriminacao)) return 'Fraca';
    const faixa = FAIXAS.find(f => discriminacao >= f.min && discriminacao < f.max);
    return faixa ? faixa.nome : 'Excelente';
}

function precisaRevisao(q) {
    if (!temNumero(q.discriminacao)) return true;
    return q.discriminacao < LIMITE_REVISAO;
}

const fmt = v => temNumero(v) ? v.toFixed(2).replace('.', ',') + '%' : '—';

function motivoRevisao(q) {
    const d = q.discriminacao;
    const f = q.facilidade;

    if (!temNumero(d)) {
        if (temNumero(f) && f >= 99.5) {
            return 'Todos os alunos acertaram: o AVA não calcula discriminação e a questão não ' +
                   'diferencia ninguém. Serve de aquecimento, não de avaliação.';
        }
        if (temNumero(f) && f <= 0.5) {
            return 'Nenhum aluno acertou: conferir o gabarito antes de qualquer conclusão sobre a turma.';
        }
        return 'O AVA não calculou o índice de discriminação desta questão (desvio padrão zero).';
    }
    if (d < 0) {
        return `Discriminação negativa (${fmt(d)}): alunos com melhor desempenho geral erraram mais ` +
               'que os demais — conferir o gabarito.';
    }
    if (temNumero(f) && f >= FACILIDADE_MUITO_ALTA) {
        return `Discriminação baixa somada à facilidade muito alta (${fmt(f)}): quase todos acertaram, ` +
               'então a questão quase não diferencia.';
    }
    if (temNumero(f) && f <= FACILIDADE_MUITO_BAIXA) {
        return `Discriminação baixa somada à facilidade muito baixa (${fmt(f)}): quase ninguém acertou — ` +
               'conferir enunciado e gabarito.';
    }
    return `Discriminação baixa (${fmt(d)}): a questão diferencia pouco os níveis de conhecimento.`;
}

// O distrator que mais atraiu alunos — é o que interessa olhar quando a
// questão vai mal: costuma apontar o erro conceitual da turma.
// Distrator que atraiu TANTO OU MAIS gente que o gabarito. É o sinal mais
// forte de erro conceitual coletivo (ou de enunciado ambíguo): a turma não
// chutou espalhado, ela convergiu na resposta errada.
function distratorDominante(q) {
    const alts = q.alternativas || [];
    const correta = alts.find(a => a.correta);
    if (!correta) return null;
    const peso = a => temNumero(a.frequencia) ? a.frequencia : (a.contagem || 0);
    const erradas = alts.filter(a => !a.correta && peso(a) >= peso(correta) && peso(a) > 0);
    if (!erradas.length) return null;
    return erradas.reduce((acc, a) => (peso(a) > peso(acc) ? a : acc), erradas[0]);
}

function distratorForte(q) {
    const erradas = (q.alternativas || []).filter(a => !a.correta);
    if (!erradas.length) return null;
    const peso = a => temNumero(a.frequencia) ? a.frequencia : (a.contagem || 0);
    const melhor = erradas.reduce((acc, a) => (peso(a) > peso(acc) ? a : acc), erradas[0]);
    return peso(melhor) > 0 ? melhor : null;
}

function media(valores) {
    const vs = valores.filter(temNumero);
    return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}

/**
 * Enriquece as questões com classificação/motivo e devolve o resumo da prova.
 */
function analisar(questoes) {
    const contagens = {};
    FAIXAS.forEach(f => { contagens[f.nome] = 0; });

    const enriquecidas = questoes.map(q => {
        const classificacao = classificar(q.discriminacao);
        contagens[classificacao]++;
        const revisar = precisaRevisao(q);
        const forte = distratorForte(q);
        const dominante = distratorDominante(q);
        return {
            ...q,
            classificacao,
            revisar,
            motivo: revisar ? motivoRevisao(q) : null,
            // Um distrator que bateu o gabarito merece leitura à parte da
            // discriminação: a questão pode até discriminar bem e ainda
            // assim estar ensinando a coisa errada pra turma inteira.
            alertaDistrator: !!dominante,
            alternativas: (q.alternativas || []).map(a => ({
                ...a,
                distratorForte: forte ? a === forte : false,
                distratorDominante: dominante ? a === dominante : false
            }))
        };
    });

    const resumo = {
        total: enriquecidas.length,
        contagens,
        discriminacaoMedia: media(enriquecidas.map(q => q.discriminacao)),
        facilidadeMedia: media(enriquecidas.map(q => q.facilidade)),
        boasOuExcelentes: contagens['Boa'] + contagens['Excelente'],
        paraRevisar: enriquecidas.filter(q => q.revisar).length,
        comAlternativas: enriquecidas.filter(q => q.alternativas.length > 0).length,
        comDistratorDominante: enriquecidas.filter(q => q.alertaDistrator).length
    };

    return { questoes: enriquecidas, resumo };
}

module.exports = {
    parseEstatisticas,
    sugerirCabecalho,
    analisar,
    classificar,
    precisaRevisao,
    motivoRevisao,
    distratorForte,
    distratorDominante,
    ErroDeLeitura,
    FAIXAS,
    LIMITE_REVISAO
};
