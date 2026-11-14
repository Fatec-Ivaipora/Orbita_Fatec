// Leitura das questões a partir de LINHAS de texto — compartilhado entre o servidor (Word, via
// src/utils/parseProvaDocx.js) e o navegador (página do professor: colar as questões, 10/11/2026).
// Por isso não usa require nem nada de Node: no navegador vira window.ParseLinhas.
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica();
    else raiz.ParseLinhas = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const LETRAS_ALTERNATIVA = ['A', 'B', 'C', 'D', 'E'];

// Quebra uma linha que concatenou várias alternativas sem quebra de
// parágrafo — só quebra se achar pelo menos 2 marcadores "X)" (A a E), pra
// não arriscar cortar uma frase comum do enunciado.
// Letra grudada em outra letra ou número não é alternativa: "(SIFA)." tem um "A)" no fim (13/11/2026,
// prova de Fisioterapia: a alternativa E era cortada em duas e as letras andavam uma casa).
// Letra minúscula também ("a) ... b) ... c) ...", simulado da Biomedicina, 13/11/2026), mas só quando as
// letras vêm em sequência a, b, c... — um "c)" solto numa frase não corta nada.
function expandirLinhaConcatenada(linha) {
    if (linha.startsWith('\u0001')) return [linha];   // título do Word (ver montarQuestoesDeLinhas)
    const marcadores = linha.match(/(?<![\p{L}\p{N}])[A-E]\)/gu);
    if (marcadores && marcadores.length >= 2) return linha.split(/(?<![\p{L}\p{N}])(?=[A-E]\))/u).map(p => p.trim()).filter(Boolean);
    const minusculas = [...linha.matchAll(/(?<![\p{L}\p{N}])([a-e])\)/gu)];
    if (minusculas.length < 2 || minusculas[0][1] !== 'a') return [linha];
    if (!minusculas.every((m, i) => m[1].charCodeAt(0) === 97 + i)) return [linha];
    const partes = [];
    let ultimo = 0;
    minusculas.forEach(m => { partes.push(linha.slice(ultimo, m.index)); ultimo = m.index; });
    partes.push(linha.slice(ultimo));
    return partes.map(p => p.trim()).filter(Boolean);
}

// CAIXA ALTA "de verdade": só letras (com acento) e espaço — nada de dígito
// ou pontuação. Isso é o que separa um título de seção real ("GESTÃO DE
// PESSOAS") de uma alternativa/citação que por acaso não tem minúscula
// ("E) V, F, V, F.", "(FGV - 2024)") — essas têm parêntese, vírgula, dígito
// ou traço, um título de disciplina nunca tem. Exige 2+ palavras também —
// senão um conectivo sozinho em caixa alta dentro da própria questão
// (ex.: "PORQUE", comum em questão de asserção/razão) derruba o bloco no
// meio, perdendo o resto da questão.
// Aceita também título com traço ou vírgula separando as partes ("DIREITO CIVIL - PESSOAS E BENS", 29/10/2026):
// traço com espaço dos dois lados, entre palavras em caixa alta. Linha de alternativa/fonte continua
// de fora porque tem parêntese, vírgula ou número ("FGV - 2025 DPE-RO Analista (Superior)").
function pareceCabecalhoDeSecao(linha) {
    if (/^Quest(ã|a)o\b/i.test(linha)) return false;
    if (linha.length < 3 || linha.length > 80) return false;
    // palavras em caixa alta separadas por espaço, ' - ' ou ', ' ("ÉTICA, BIOÉTICA, CULTURA E SOCIEDADE")
    if (!/^[A-ZÀ-Ú]+(?:\s+[A-ZÀ-Ú]+|\s+[-–—]\s+[A-ZÀ-Ú]+|,\s*[A-ZÀ-Ú]+)*$/.test(linha.trim())) return false;
    // alternativa do tipo "V, F, V, F" não é título: precisa de 2+ palavras de 3+ letras
    if (linha.trim().split(/[\s,–—-]+/).filter(w => w.length >= 3).length < 2) return false;
    if (FRASES_IGNORADAS_COMO_SECAO.has(linha.trim())) return false;
    return linha.trim().split(/\s+/).length >= 2;
}

// Título de disciplina com UMA palavra só ("FITOPATOLOGIA", "BOTÂNICA", 03/11/2026): só vale quando a
// linha seguinte já é o "Questão N" — um "PORQUE" solto no meio da questão nunca vem antes de um marcador.
function tituloDeUmaPalavra(linha, proxima) {
    const t = (linha || '').trim();
    if (!/^[A-ZÀ-Ú]{4,40}$/.test(t) || FRASES_IGNORADAS_COMO_SECAO.has(t)) return false;
    return marcadorPorPalavra((proxima || '').trim()) !== null;
}

// Título de disciplina em letras normais ("Anatomia e Fisiologia", "Prát. Laboratório em Morfofisiologia",
// "Empreendedorismo" — simulado da Enfermagem, 05/11/2026): o leitor só aceitava título em CAIXA ALTA e
// juntava as 40 questões numa disciplina só. Vale só logo antes de um "Questão N", curto, sem pontuação no
// fim, sem letra de alternativa no começo e com TODA palavra de 4+ letras começando em maiúscula — assim
// uma alternativa sem letra ("Coluna renal", "O epidídimo.") nunca vira título.
function tituloAntesDaQuestao(linha, proxima) {
    const t = (linha || '').trim();
    if (t.length < 3 || t.length > 80 || /^Quest(ã|a)o\b/i.test(t)) return false;
    if (/[.;:,?!)]$/.test(t)) return false;
    // número ou sinal de fórmula é resposta, não nome de disciplina ("NH4+ em NO2−", simulado de Agro, 13/11/2026)
    if (/[0-9+=−%<>²³₂₃₄]/.test(t)) return false;
    if (/^\(?[A-Ea-e]\s*[\)\.\-–]/.test(t)) return false;
    if (!/^\p{Lu}/u.test(t) || FRASES_IGNORADAS_COMO_SECAO.has(t)) return false;
    // resposta com algarismo romano ("I e II", "II, III e IV") e sigla curta sozinha ("NDA", "DNA") também não
    // são disciplina (simulados da Biomedicina, 13/11/2026)
    if (/^[IVX]+(?:\s*(?:,|e)\s*[IVX]+)*$/.test(t)) return false;
    const palavras = t.split(/\s+/);
    if (palavras.length === 1 && t.replace(/[^\p{L}]/gu, '').length < 5) return false;
    if (palavras.length > 8) return false;
    if (!palavras.filter(w => w.replace(/[^\p{L}]/gu, '').length >= 4).every(w => /^\p{Lu}/u.test(w))) return false;
    return marcadorPorPalavra((proxima || '').trim()) !== null;
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
    // Também "1 - Texto", "2- Texto" e "3 – Texto" (traço ou travessão, o
    // jeito como vários professores numeram — 16/10/2026). Depois do
    // marcador pode vir aspas ou parêntese ("1 - (ENEM) ...").
    // Também dois-pontos ("2: Texto") e uma pontuação sobrando depois do número ("02. : (IBGE)...",
    // "3) - Texto") — 11/11/2026: no simulado de Conhecimentos Gerais da Fisio a "02. :" não era lida e as
    // questões 2 a 5 iam todas pra dentro da 1.
    const m = /^(\d{1,3})\s*(?:[\.\)\-–—:]\s*(?:[:;\-–—]\s*)?|\s+)(?=[A-Za-zÀ-ÿ"“(])/.exec(linha);
    if (!m) return null;
    const numero = parseInt(m[1], 10);
    return numero === proximoEsperado ? numero : null;
}

function limparInicioBloco(linhas) {
    let semNumero = linhas[0]
        .replace(/^Quest(ã|a)o\s*0*\d+\s*[:\-]?\s*/i, '')
        .replace(/^\d{1,3}\s*(?:[\.\)\-–—:]\s*(?:[:;\-–—]\s*)?|\s+)/, '')
        .trim();
    // Sobra de digitação colada no número ("Questão 08l") não vira começo do enunciado.
    if (semNumero.length <= 1) semNumero = '';
    const out = [semNumero, ...linhas.slice(1)].filter(Boolean);
    // "Questão 01" seguido da numeração automática do Word repetindo o número ("1 - (UNESCO...)",
    // simulados da Biomedicina, 13/11/2026): o número repetido sai do começo do enunciado
    const num = (/^Quest(?:ã|a)o\s*0*(\d+)/i.exec(linhas[0]) || [])[1];
    if (num && !semNumero && out.length) out[0] = out[0].replace(new RegExp('^0*' + num + '\\s*[-–—.)]\\s+'), '');
    return out.filter(Boolean);
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

        // Questão só com o número ("Questão 01" sem texto — ex.: as de Conhecimentos Gerais num
        // Simulado, que vêm do banco geral): não é erro, só não tem o que importar (29/10/2026).
        if (!linhas.length) {
            questoes.push({ numero: blocoAtual.numero, tipo: blocoAtual.modo, categoriaSugeridaTexto: disciplinaAtual, vazia: true });
            return;
        }

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
        // Linha solta DEPOIS da última alternativa ("Fundamentação temática:", fonte, comentário — simulado da
        // Fisio, 11/11/2026): se as alternativas estão escritas com letra, em ordem (A, B, C, D[, E]), elas são
        // essas linhas; o que sobra depois da última fica de fora, com aviso. Sem isso a linha solta virava a
        // última alternativa e a A ia parar no enunciado.
        let fim = linhas.length;
        const sobra = [];
        const ultimaLetra = LETRAS_ALTERNATIVA[alternativasPorQuestao - 1];
        for (let k = linhas.length - 2; k >= alternativasPorQuestao; k--) {
            if (extrairLetraImpressa(linhas[k]) !== ultimaLetra) continue;
            const emOrdem = LETRAS_ALTERNATIVA.slice(0, alternativasPorQuestao)
                .every((letra, j) => extrairLetraImpressa(linhas[k - alternativasPorQuestao + 1 + j]) === letra);
            // a sobra não pode ter cara de alternativa ("E) ..." numa prova marcada como 4 alternativas
            // continua caindo no aviso de letra trocada, em vez de sumir)
            if (emOrdem && !linhas.slice(k + 1).some(l => extrairLetraImpressa(l))) {
                fim = k + 1;
                sobra.push(...linhas.slice(k + 1));
            }
            break;
        }
        const alternativasBrutas = linhas.slice(fim - alternativasPorQuestao, fim);
        const enunciadoLinhas = linhas.slice(0, fim - alternativasPorQuestao);

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
        if (sobra.length) avisoAlternativas.push(`Texto depois da alternativa ${ultimaLetra} ficou de fora: "${sobra.join(' ').slice(0, 120)}".`);

        questoes.push({
            numero: blocoAtual.numero,
            tipo: 'objetiva',
            categoriaSugeridaTexto: disciplinaAtual,
            enunciado: enunciadoLinhas.join('\n'),
            alternativas: alternativasBrutas.map(limparPrefixoLetra),
            avisoAlternativas,
            gabarito: blocoAtual.gabarito && LETRAS_ALTERNATIVA.indexOf(blocoAtual.gabarito) < alternativasPorQuestao ? blocoAtual.gabarito : null
        });
    }

    // Título do Word (estilo Título 1, 2...: vem com \u0001 na frente, 13/11/2026): quando o arquivo marca as
    // disciplinas assim, só eles contam como disciplina — nada de adivinhar título pela posição ou pela caixa
    // alta (uma resposta como "Malária" virava disciplina).
    const MARCA_TITULO = '\u0001';
    const sem = (l) => (l && l.startsWith(MARCA_TITULO) ? l.slice(1) : l);
    const usaTitulosDoWord = linhasBrutas.some(l => l.startsWith(MARCA_TITULO) && detectarMarcador(sem(l), 0) === null && marcadorPorPalavra(sem(l)) === null);
    for (let i = 0; i < linhasBrutas.length; i++) {
        const tituloDoWord = linhasBrutas[i].startsWith(MARCA_TITULO);
        const linha = sem(linhasBrutas[i]);
        if (pareceInicioDissertativas(linha)) {
            fecharBloco();
            blocoAtual = null;
            modoAtual = 'dissertativa';
            proximoEsperado = 1;
            continue;
        }
        if (blocoAtual && blocoAtual.modo === 'objetiva' && gabaritoDaLinha(linha)) {
            blocoAtual.gabarito = gabaritoDaLinha(linha);
            continue;
        }
        const numeroMarcador = detectarMarcador(linha, proximoEsperado);
        if (numeroMarcador !== null) {
            fecharBloco();
            blocoAtual = { numero: numeroMarcador, modo: modoAtual, linhas: [linha] };
            proximoEsperado = numeroMarcador + 1;
            continue;
        }
        const ehTituloForte = usaTitulosDoWord ? tituloDoWord : pareceCabecalhoDeSecao(linha);
        let ehTitulo = ehTituloForte || (!usaTitulosDoWord && (tituloDeUmaPalavra(linha, sem(linhasBrutas[i + 1])) || tituloAntesDaQuestao(linha, sem(linhasBrutas[i + 1]))));
        // Título reconhecido só pela posição (logo antes do "Questão N") pode ser a última alternativa SEM letra
        // ("Adipócitos", simulado da Biomedicina, 13/11/2026): só vale como disciplina se a questão já tem o
        // enunciado e todas as alternativas sem essa linha. Senão, é alternativa.
        if (ehTitulo && !ehTituloForte && blocoAtual && blocoAtual.modo === 'objetiva'
            && limparInicioBloco(blocoAtual.linhas).length <= alternativasPorQuestao) ehTitulo = false;
        if (!blocoAtual && ehTitulo) {
            disciplinaAtual = linha;
            continue;
        }
        if (blocoAtual && ehTitulo) {
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

// Linha de gabarito escrita junto da questão ("Gabarito: C", "Resposta: c)", "Resp. B") — 10/11/2026.
// Não entra como alternativa: vira o gabarito já marcado (o professor ainda confere na prévia).
const GABARITO_LINHA_REGEX = /^(?:gabarito|resposta|resp\.?|alternativa correta)\s*[:\-–]?\s*\(?([A-Ea-e])\)?\s*\.?$/i;
function gabaritoDaLinha(linha) {
    const m = GABARITO_LINHA_REGEX.exec((linha || '').trim());
    return m ? m[1].toUpperCase() : null;
}

// Texto colado (do Word, PDF, Google Docs, WhatsApp...) → mesma lista de questões do Word.
// "Questão N" tem prioridade; senão, número solto em sequência (1., 2), 3 -).
function parseTexto(texto, alternativasPorQuestao) {
    const linhas = String(texto || '').replace(/\r/g, '').replace(/ /g, ' ').split('\n')
        .map(l => l.replace(/\t+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean)
        .flatMap(expandirLinhaConcatenada);
    if (linhas.some(l => marcadorPorPalavra(l) !== null)) return montarQuestoesDeLinhas(linhas, alternativasPorQuestao, (l) => marcadorPorPalavra(l));
    return montarQuestoesDeLinhas(linhas, alternativasPorQuestao, (l, p) => marcadorPorNumeroSolto(l, p));
}

// Palpite de 4 ou 5 alternativas pelo texto: tem alternativa "e)" / "E." → 5; só até "d)" → 4.
function palpiteAlternativas(texto) {
    const linhas = String(texto || '').split(/\r?\n/).map(l => l.trim());
    const tem = (letra) => linhas.some(l => new RegExp('^\\(?' + letra + '\\s*[).\\-–]', 'i').test(l)) || new RegExp('(^|\\s)\\(?' + letra + '\\)', 'i').test(String(texto || ''));
    if (tem('e')) return 5;
    if (tem('d')) return 4;
    return 5;
}

return { LETRAS_ALTERNATIVA, expandirLinhaConcatenada, marcadorPorPalavra, marcadorPorNumeroSolto, montarQuestoesDeLinhas, gabaritoDaLinha, parseTexto, palpiteAlternativas };
}));
