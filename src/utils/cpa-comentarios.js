// Classificação de comentário da CPA por palavra-chave (heurística, não é NLP de
// verdade) — critério:
//   bom     = elogio
//   neutro  = não elogia, mas também não sugere melhoria/crítica
//   atencao = sugestão de melhoria ou crítica/algo negativo
// "atencao" é checado primeiro: um comentário com elogio E crítica junto
// ("está bom, mas podia ter mais X") cai em atenção, que é a categoria
// acionável pro coordenador. Case-insensitive, sem acento (normaliza antes).
// Portado de cpa-fatec/src/alunos.js e src/staff.js (app aprovado pela
// diretoria, substituiu o módulo CPA anterior do Órbita em 2026-10-14).
const PALAVRAS_ATENCAO = [
    'poderia', 'poderiam', 'deveria', 'deveriam', 'falta', 'faltam', 'faltou',
    'precisa melhorar', 'precisaria', 'precisa de mais', 'precisam de mais',
    'ruim', 'ruins', 'pessimo', 'pessima', 'horrivel', 'nao gostei',
    'insatisfeit', 'insatisfat', 'problema', 'reclama', 'infelizmente',
    'lamentav', 'demora', 'demorado', 'demorada', 'atraso', 'dificuldade',
    'nao funciona', 'descaso', 'pouco caso', 'sugiro', 'sugestao',
    'gostaria que', 'gostaria de mais', 'deixa a desejar', 'a desejar',
    'carente', 'carencia', 'sem estrutura', 'nunca teve',
    'escasso', 'escassez', 'deficiente', 'defasado',
];
// "melhorar"/"melhoria"/"melhorias" sozinhas aparecem tanto em crítica real
// ("precisa melhorar a limpeza") quanto em elogio ao próprio processo de
// melhoria contínua da CPA/instituição ("nos ajuda a melhorar", "servindo
// de base para as melhorias") — bem comum nesse segundo sentido em
// comentários falando da própria CPA. Por isso são "fracas": só decidem
// "atenção" quando não há elogio explícito no resto do comentário (ver
// classificarComentario); havendo elogio, ele vence.
const PALAVRAS_ATENCAO_FRACAS = ['melhorar', 'melhoria', 'melhorias'];
const PALAVRAS_BOM = [
    'otimo', 'otima', 'excelente', 'excelentes', 'muito bom', 'muito boa',
    'adorei', 'adoro', 'gostei muito', 'gostei', 'parabens', 'maravilhos',
    'incrivel', 'sensacional', 'perfeito', 'perfeita', 'satisfeit',
    'satisfatori', 'agradec', 'muito feliz', 'orgulho', 'amei',
    'nota 10', 'esta bom', 'esta boa', 'gosto muito',
    'bom trabalho', 'excelente trabalho', 'sempre atencioso', 'sempre atenciosa',
];
// Frases específicas elogiando a própria CPA/instituição usando vocabulário
// de "melhoria" ou "problema" — sem essas, batem em PALAVRAS_ATENCAO_FRACAS
// (ou, no caso de "problema", na lista forte) e, na falta de outro elogio
// explícito no comentário, cairiam errado em "atenção".
const ELOGIO_PROCESSO_MELHORIA = [
    'melhorias da instituicao', 'ajuda a melhorar', 'ajudam a melhorar',
    'usada como melhoria', 'usado como melhoria',
    'ciencia dos problemas', 'ciencias dos problemas',
    'criticas e melhorias',
];
// Frases que NEGAM queixa/crítica/sugestão ("nada a reclamar", "não há
// críticas") batem por substring nas palavras de atenção acima ("reclama",
// "sugestao" etc) e invertem o sentido — checadas ANTES da lista de atenção
// pra não virar falso positivo. Só suprimem a checagem de atenção pra essa
// frase específica; se o comentário também tiver elogio explícito ("muito
// bom, nada a reclamar"), ainda cai em "bom" normalmente.
const NEGACAO_SEM_QUEIXA = [
    'nada a reclamar', 'nada para reclamar', 'sem nada a reclamar', 'nada reclamar',
    'nao tenho reclamacoes', 'nao tenho o que reclamar', 'nao ha o que reclamar',
    'sem reclamacoes', 'nada de reclamacao', 'nada de reclamar',
    'nao ha criticas', 'nao ha critica', 'nenhuma critica', 'nenhuma sugestao',
    'nada de sugestao', 'nada de critica', 'sem sugestao', 'sem critica',
    'nao tem sugestao', 'nao tem critica', 'nao tem reclamacao',
    'sem sugestoes', 'nao tenho sugestoes', 'nao tenho sugestao',
    'nao ha sugestao', 'nao ha sugestoes',
    'nao encontro criticas', 'nao encontro sugestoes',
    'nada a acrescentar', 'nada a apontar', 'sem nada a apontar',
    'nenhuma queixa', 'sem queixas', 'nao tenho queixas', 'nada de queixa',
    'nao tive problema', 'nao tive nenhum problema', 'nao tive problemas',
    'sem problemas', 'nenhum problema', 'sem nenhum problema',
];
// "Não tem" sozinho, no contexto de comentário de CPA, quase sempre quer
// dizer "não tem [reclamação/crítica]" — bem mais perto de satisfação do
// que de crítica. Ao contrário das negações acima (que caem em "neutro"),
// essa vira direto "bom".
const NEGACAO_POSITIVA = ['nao tem', 'nada tem'];

// "Tem como melhorar", "a melhorar", "sempre pode melhorar" — sugestão de
// melhoria genérica demais pra ser útil pro coordenador (não diz o quê).
// Se o resto do comentário tiver elogio explícito ("ótimo, mas sempre pode
// melhorar"), vira "bom" — é ressalva de cortesia, não crítica real. Sem
// elogio, só vira "neutro" quando é basicamente o comentário inteiro (ver
// limite de palavras abaixo); dentro de um comentário maior e mais
// específico, sem elogio, continua contando pra "atenção".
const MELHORIA_VAGA = [
    'tem como melhorar', 'a melhorar', 'pode melhorar', 'poderia melhorar',
    'precisa melhorar', 'deveria melhorar', 'tem que melhorar',
    'sempre pode melhorar', 'sempre podemos melhorar', 'podemos melhorar',
];

function normalizar(texto) {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, ''); // remove acentos (ex: "não" -> "nao")
}

// "nada ... a reclamar" com palavras no meio ("nada especificamente a
// reclamar", "nada em especial a reclamar") — mais tolerante que checar
// frases fixas uma a uma.
const REGEX_NADA_RECLAMAR = /\bnada\b[a-z ]{0,25}\breclamar\b/;

function classificarComentario(texto) {
    const t = normalizar(texto);
    const numPalavras = t.split(/\s+/).filter(Boolean).length;
    const temElogio = PALAVRAS_BOM.some(p => t.includes(p));

    if (NEGACAO_POSITIVA.some(p => t.includes(p))) return 'bom';
    if (ELOGIO_PROCESSO_MELHORIA.some(p => t.includes(p))) return 'bom';
    if (NEGACAO_SEM_QUEIXA.some(p => t.includes(p)) || REGEX_NADA_RECLAMAR.test(t)) {
        return temElogio ? 'bom' : 'neutro';
    }
    if (MELHORIA_VAGA.some(p => t.includes(p))) {
        if (temElogio) return 'bom';
        return numPalavras <= 4 ? 'neutro' : 'atencao';
    }
    if (PALAVRAS_ATENCAO.some(p => t.includes(p))) return 'atencao';
    if (PALAVRAS_ATENCAO_FRACAS.some(p => t.includes(p))) return temElogio ? 'bom' : 'atencao';
    if (temElogio) return 'bom';
    return 'neutro';
}

module.exports = { classificarComentario, normalizar };
