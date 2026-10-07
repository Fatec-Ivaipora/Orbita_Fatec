// Classificação de comentários da CPA (bom / neutro / atenção) por palavra-chave. Reaproveitado do módulo CPA anterior
// (removido em 2026-08), com os mesmos critérios definidos com a TI:
//   bom = elogio · neutro = nem elogia nem critica/sugere · atencao = crítica ou sugestão de melhoria.
const PALAVRAS_ATENCAO = [
    'poderia', 'poderiam', 'deveria', 'deveriam', 'falta', 'faltam', 'faltou',
    'precisa melhorar', 'precisaria', 'precisa de mais', 'precisam de mais',
    'melhorar', 'melhoria', 'melhorias',
    'ruim', 'ruins', 'pessimo', 'pessima', 'horrivel', 'nao gostei',
    'insatisfeit', 'insatisfat', 'problema', 'reclama', 'infelizmente',
    'lamentav', 'demora', 'demorado', 'demorada', 'atraso', 'dificuldade',
    'nao funciona', 'descaso', 'pouco caso', 'sugiro', 'sugestao',
    'gostaria que', 'gostaria de mais', 'deixa a desejar', 'a desejar',
    'carente', 'carencia', 'sem estrutura', 'nunca teve',
    'escasso', 'escassez', 'deficiente', 'defasado',
    'superficial', 'confus', 'cansativ', 'monoton', 'desorganiz', 'insuficient', 'desatualiz', 'atrapalh', 'nao entend', 'nao consigo',
];
const PALAVRAS_BOM = [
    'otimo', 'otima', 'excelente', 'excelentes', 'muito bom', 'muito boa',
    'adorei', 'adoro', 'gostei muito', 'gostei', 'parabens', 'maravilhos',
    'incrivel', 'sensacional', 'perfeito', 'perfeita', 'satisfeit',
    'satisfatori', 'agradec', 'muito feliz', 'orgulho', 'amei',
    'nota 10', 'esta bom', 'esta boa', 'gosto muito',
    'bom trabalho', 'excelente trabalho', 'sempre atencioso', 'sempre atenciosa',
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
    'sem sugestoes', 'nao tenho sugestoes', 'nao ha sugestao', 'nao ha sugestoes',
    'nada a acrescentar', 'nada a apontar', 'sem nada a apontar',
    'nenhuma queixa', 'sem queixas', 'nao tenho queixas', 'nada de queixa',
    'nao tive problema', 'nao tive nenhum problema', 'nao tive problemas',
    'sem problemas', 'nenhum problema', 'sem nenhum problema',
];
// "Não tem" sozinho, no contexto de comentário de CPA, quase sempre quer
// dizer "não tem [reclamação/crítica]" — bem mais perto de satisfação do
// que de crítica. Ao contrário das negações acima (que caem em "neutro"),
// essa vira direto "bom", a pedido do usuário.
const NEGACAO_POSITIVA = ['nao tem', 'nada tem'];

// "Tem como melhorar", "a melhorar" — sugestão de melhoria genérica demais
// pra ser útil pro coordenador (não diz o quê). Só vira "neutro" quando é
// basicamente o comentário inteiro (ver limite de palavras abaixo); dentro
// de um comentário maior e mais específico, "melhorar" continua contando
// pra "atenção" normalmente.
const MELHORIA_VAGA = [
    'tem como melhorar', 'a melhorar', 'pode melhorar', 'poderia melhorar',
    'precisa melhorar', 'deveria melhorar', 'tem que melhorar',
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
    // "não tem" só vale como "não tem reclamação" quando o comentário é curto; num texto maior
    // ("ead é superficial, não tem o que se prender") é crítica e segue para a checagem normal
    if (numPalavras <= 5 && NEGACAO_POSITIVA.some(p => t.includes(p))) return 'bom';
    if (NEGACAO_SEM_QUEIXA.some(p => t.includes(p)) || REGEX_NADA_RECLAMAR.test(t)) {
        return PALAVRAS_BOM.some(p => t.includes(p)) ? 'bom' : 'neutro';
    }
    if (numPalavras <= 4 && MELHORIA_VAGA.some(p => t.includes(p))) return 'neutro';
    if (PALAVRAS_ATENCAO.some(p => t.includes(p))) return 'atencao';
    if (PALAVRAS_BOM.some(p => t.includes(p))) return 'bom';
    return 'neutro';
}

module.exports = { classificarComentario, normalizar };
