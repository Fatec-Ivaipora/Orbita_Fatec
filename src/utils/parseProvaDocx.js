// Lê um .docx OU .doc (formato antigo) com questões objetivas E dissertativas
// (formato "prova pro aluno", sem gabarito visível — ver PRODUCT do módulo
// Banco de Provas) e devolve uma lista de questões cruas, pra depois casar
// com o gabarito das objetivas (arquivo/lista separada) e jogar na fila de
// revisão — as dissertativas não têm gabarito, entram direto marcadas como
// `tipo: 'dissertativa'`.
//
// Heurística de leitura (baseada em modelos reais fornecidos pelo usuário —
// um .docx moderno estilo "Simulado" e um .doc antigo estilo "Prova
// Bimestral", cada um com uma convenção de numeração diferente):
// - Cada questão é marcada OU por "Questão N" (Simulado) OU por um número
//   solto colado no início da linha ("1.Débora...", "2. Pedro...", Prova
//   Bimestral) — o parser tenta a primeira convenção primeiro; se não achar
//   nenhuma, tenta a segunda, exigindo que os números venham em sequência
//   (1, 2, 3...) pra não confundir uma citação de lei ("Lei nº 5.197") com
//   início de questão.
// - A linha "QUESTÕES DISSERTATIVAS" (pode ter texto depois, tipo "- 1,5
//   cada") é o divisor de seção: fecha o bloco de objetiva que estiver
//   aberto e troca pro modo dissertativa, que reinicia a numeração em 1 (é
//   assim que o modelo real numera) e NÃO tenta separar "últimas N linhas
//   = alternativas" — o bloco inteiro (enunciado + eventuais itens A/B/C
//   discursivos, que fazem parte do texto, não são opções de múltipla
//   escolha) vira o enunciado da dissertativa. Antes disso não existia essa
//   troca de modo: a numeração reiniciada em 1 nunca batia com o próximo
//   número esperado depois da última objetiva, então as linhas da
//   dissertativa simplesmente iam se acumulando dentro do bloco da ÚLTIMA
//   objetiva até o fim do arquivo — resultado: uma objetiva com um texto
//   gigante colado (enunciado + cabeçalho da seção + dissertativas inteiras)
//   e nenhuma dissertativa de fato extraída.
// - Uma linha em CAIXA ALTA sozinha (2+ palavras, só letra e espaço), fora de
//   qualquer questão, é o nome da disciplina daquele bloco (arquivo pode ter
//   várias disciplinas juntas, como o Simulado) — vira sugestão de
//   disciplina, não fixa.
// - Nas OBJETIVAS, as alternativas são sempre as ÚLTIMAS N linhas do bloco da
//   questão (N = parâmetro `alternativasPorQuestao`, 4 ou 5 — não dá pra
//   adivinhar isso sozinho, então quem importa informa antes). O prefixo
//   "A) "/"a."/etc, se existir, é só decorativo — a letra real é sempre por
//   POSIÇÃO (1ª alternativa remanescente = A, 2ª = B...), o que resolve o
//   caso do Word gerar a letra via lista numerada automática (não vem no
//   texto extraído).
// - Quando o Word concatena as alternativas numa única linha só
//   ("A) x.B) y.C) z...", sem quebra de parágrafo entre elas — visto no
//   modelo real), a linha é quebrada em várias antes de aplicar a regra
//   acima.
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');

const LETRAS_ALTERNATIVA = ['A', 'B', 'C', 'D', 'E'];

// .docx é um .zip (assinatura "PK"); .doc antigo é um Compound File OLE
// (assinatura D0 CF 11 E0). Detecta pelo conteúdo, não pela extensão do
// nome do arquivo (mais confiável — o nome vem do cliente).
function ehDocxZip(buffer) {
    return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4B;
}

async function extrairParagrafosDoArquivo(buffer) {
    if (ehDocxZip(buffer)) {
        const { value: html } = await mammoth.convertToHtml({ buffer });
        return extrairParagrafosHtml(html);
    }
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    return doc.getBody().split('\n').map(l => l.replace(/\t+/g, ' ').trim()).filter(Boolean);
}

function extrairParagrafosHtml(html) {
    const paragrafos = [];
    const regex = /<p[^>]*>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = regex.exec(html))) {
        const bruto = m[1] !== undefined ? m[1] : m[2];
        const texto = bruto
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]+>/g, '')
            .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/\s+/g, ' ')
            .trim();
        if (texto) paragrafos.push(texto);
    }
    return paragrafos;
}

// Quebra uma linha que concatenou várias alternativas sem quebra de
// parágrafo — só quebra se achar pelo menos 2 marcadores "X)" (A a E), pra
// não arriscar cortar uma frase comum do enunciado.
function expandirLinhaConcatenada(linha) {
    const marcadores = linha.match(/[A-E]\)/g);
    if (!marcadores || marcadores.length < 2) return [linha];
    return linha.split(/(?=[A-E]\))/).map(p => p.trim()).filter(Boolean);
}

// CAIXA ALTA "de verdade": só letras (com acento) e espaço — nada de dígito
// ou pontuação. Isso é o que separa um título de seção real ("GESTÃO DE
// PESSOAS") de uma alternativa/citação que por acaso não tem minúscula
// ("E) V, F, V, F.", "(FGV - 2024)") — essas têm parêntese, vírgula, dígito
// ou traço, um título de disciplina nunca tem. Exige 2+ palavras também —
// senão um conectivo sozinho em caixa alta dentro da própria questão
// (ex.: "PORQUE", comum em questão de asserção/razão) derruba o bloco no
// meio, perdendo o resto da questão.
function pareceCabecalhoDeSecao(linha) {
    if (/^Quest(ã|a)o\b/i.test(linha)) return false;
    if (linha.length < 3 || linha.length > 80) return false;
    if (!/^[A-ZÀ-Ú\s]+$/.test(linha)) return false;
    if (FRASES_IGNORADAS_COMO_SECAO.has(linha.trim())) return false;
    return linha.trim().split(/\s+/).length >= 2;
}

// Remove um prefixo de letra decorativo ("A)", "a.", "A -") do INÍCIO da
// linha, se existir — a letra de verdade vem da posição, não desse prefixo.
const PREFIXO_LETRA_REGEX = /^([A-Ea-e])\s*[\)\.\-]\s*/;

function limparPrefixoLetra(linha) {
    return linha.replace(PREFIXO_LETRA_REGEX, '').trim();
}

// Letra que estava de fato escrita na linha original (antes de limpar), se
// existir — usada só pra CONFERIR contra a letra atribuída por posição,
// nunca pra decidir a letra real (ver comentário no topo do arquivo).
function extrairLetraImpressa(linha) {
    const m = PREFIXO_LETRA_REGEX.exec(linha);
    return m ? m[1].toUpperCase() : null;
}

// Convenção "Questão N" (modelo Simulado) — marcador numa linha própria.
function marcadorPorPalavra(linha) {
    const m = /^Quest(ã|a)o\s*0*(\d+)/i.exec(linha);
    return m ? parseInt(m[2], 10) : null;
}

// Convenção "N." solto colado no início da linha, com o texto da questão
// já emendado ("1.Débora, primária..." — modelo Prova Bimestral). Só conta
// como marcador se for exatamente o próximo número esperado — evita
// confundir "Lei nº 5.197" ou item de lista de outra coisa com início de
// questão nova.
function marcadorPorNumeroSolto(linha, proximoEsperado) {
    // Três variações vistas no modelo real: "1.Débora..." (ponto colado,
    // sem espaço), "4 Leda..." (sem pontuação nenhuma, só espaço) e
    // "1 . Pedro..." (espaço ANTES do ponto também — visto na seção de
    // dissertativas do modelo real; sem essa terceira variação a seção
    // inteira era descartada porque o marcador nunca batia). Exige uma
    // LETRA logo depois (não outro dígito) — senão uma grade de gabarito
    // ("01  02  03  04...") também bateria com o padrão. A checagem de
    // sequência (só aceita o PRÓXIMO número esperado) cobre o resto dos
    // falsos positivos.
    const m = /^(\d{1,3})\s*(?:[\.\)]\s*|\s+)(?=[A-Za-zÀ-ÿ])/.exec(linha);
    if (!m) return null;
    const numero = parseInt(m[1], 10);
    return numero === proximoEsperado ? numero : null;
}

function limparInicioBloco(linhas) {
    const semNumero = linhas[0]
        .replace(/^Quest(ã|a)o\s*0*\d+\s*[:\-]?\s*/i, '')
        .replace(/^\d{1,3}\s*(?:[\.\)]\s*|\s+)/, '')
        .trim();
    return [semNumero, ...linhas.slice(1)].filter(Boolean);
}

// Frases fixas de "chrome" da prova impressa (instruções, título de seção
// de objetivas) que tecnicamente batem com o padrão de cabeçalho em CAIXA
// ALTA mas nunca são nome de disciplina — evita virar sugestão de
// disciplina sem sentido. "QUESTÕES DISSERTATIVAS" NÃO entra aqui — tem
// tratamento próprio (troca de modo), ver pareceInicioDissertativas.
const FRASES_IGNORADAS_COMO_SECAO = new Set([
    'ORIENTAÇÕES PARA A PROVA', 'QUESTÕES OBJETIVAS', 'BOA PROVA'
]);

// Divisor "QUESTÕES DISSERTATIVAS" — pode vir só isso ou com texto depois
// na mesma linha ("QUESTÕES DISSERTATIVAS - 1,5 cada", "(0,75 CADA)").
function pareceInicioDissertativas(linha) {
    return /^QUEST(Õ|O)ES\s+DISSERTATIVAS\b/i.test(linha.trim());
}

function montarQuestoesDeLinhas(linhasBrutas, alternativasPorQuestao, detectarMarcador) {
    const questoes = [];
    let disciplinaAtual = null;
    let blocoAtual = null;
    let proximoEsperado = 1;
    let modoAtual = 'objetiva';

    function fecharBloco() {
        if (!blocoAtual || !blocoAtual.linhas.length) return;
        const linhas = limparInicioBloco(blocoAtual.linhas);

        // Dissertativa: sem alternativas pra separar — o bloco inteiro
        // (enunciado, e eventuais itens A/B/C discursivos que façam parte
        // do texto) é o enunciado. Sem gabarito, então não passa pela
        // etapa de "marcar gabarito" da importação.
        if (blocoAtual.modo === 'dissertativa') {
            questoes.push({
                numero: blocoAtual.numero,
                tipo: 'dissertativa',
                categoriaSugeridaTexto: disciplinaAtual,
                enunciado: linhas.join('\n')
            });
            return;
        }

        if (linhas.length <= alternativasPorQuestao) {
            questoes.push({
                numero: blocoAtual.numero,
                tipo: 'objetiva',
                categoriaSugeridaTexto: disciplinaAtual,
                erro: `Questão ${blocoAtual.numero}: não achei ${alternativasPorQuestao} alternativas + enunciado nesse bloco.`
            });
            return;
        }
        const alternativasBrutas = linhas.slice(linhas.length - alternativasPorQuestao);
        const enunciadoLinhas = linhas.slice(0, linhas.length - alternativasPorQuestao);

        // Confere a letra atribuída por POSIÇÃO contra a letra que estava
        // de fato escrita na linha (se tinha alguma) — pedido explícito
        // (18/09): avisar quando isso não bate, em vez de trocar a letra
        // errada sem ninguém perceber (foi o que aconteceu no agronegócio).
        const avisoAlternativas = [];
        alternativasBrutas.forEach((linhaBruta, i) => {
            const letraPosicao = LETRAS_ALTERNATIVA[i];
            const letraImpressa = extrairLetraImpressa(linhaBruta);
            if (letraImpressa && letraImpressa !== letraPosicao) {
                avisoAlternativas.push(`A alternativa ${letraPosicao} (pela ordem) estava escrita como "${letraImpressa})" no arquivo original — confira antes de marcar o gabarito.`);
            }
        });

        questoes.push({
            numero: blocoAtual.numero,
            tipo: 'objetiva',
            categoriaSugeridaTexto: disciplinaAtual,
            enunciado: enunciadoLinhas.join('\n'),
            alternativas: alternativasBrutas.map(limparPrefixoLetra),
            avisoAlternativas
        });
    }

    for (const linha of linhasBrutas) {
        if (pareceInicioDissertativas(linha)) {
            fecharBloco();
            blocoAtual = null;
            modoAtual = 'dissertativa';
            proximoEsperado = 1;
            continue;
        }
        const numeroMarcador = detectarMarcador(linha, proximoEsperado);
        if (numeroMarcador !== null) {
            fecharBloco();
            blocoAtual = { numero: numeroMarcador, modo: modoAtual, linhas: [linha] };
            proximoEsperado = numeroMarcador + 1;
            continue;
        }
        if (!blocoAtual && pareceCabecalhoDeSecao(linha)) {
            disciplinaAtual = linha;
            continue;
        }
        if (blocoAtual && pareceCabecalhoDeSecao(linha)) {
            fecharBloco();
            blocoAtual = null;
            disciplinaAtual = linha;
            continue;
        }
        if (blocoAtual) blocoAtual.linhas.push(linha);
    }
    fecharBloco();
    return questoes;
}

/**
 * @param {Buffer} buffer - conteúdo do .docx ou .doc
 * @param {number} alternativasPorQuestao - 4 ou 5
 * @returns {Promise<{numero:number, categoriaSugeridaTexto:string|null, enunciado:string, alternativas:string[]}[]>}
 */
async function parseProvaDocx(buffer, alternativasPorQuestao) {
    const linhasBrutas = (await extrairParagrafosDoArquivo(buffer)).flatMap(expandirLinhaConcatenada);

    // Tenta primeiro a convenção "Questão N" (mais confiável, sem risco de
    // falso positivo); só cai pra número solto se não achar nenhuma.
    const temMarcadorPorPalavra = linhasBrutas.some(l => marcadorPorPalavra(l) !== null);
    if (temMarcadorPorPalavra) {
        return montarQuestoesDeLinhas(linhasBrutas, alternativasPorQuestao, (linha) => marcadorPorPalavra(linha));
    }
    return montarQuestoesDeLinhas(linhasBrutas, alternativasPorQuestao, (linha, proximoEsperado) => marcadorPorNumeroSolto(linha, proximoEsperado));
}

module.exports = { parseProvaDocx };
