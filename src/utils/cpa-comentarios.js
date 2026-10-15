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
    // postura/didática do professor (antes passavam como neutro ou até elogio)
    'perdido', 'perdida', 'se confunde', 'confus', 'nao domina', 'nao sabe explicar',
    'nao explica', 'explica mal', 'mal explica', 'dificil de entender', 'nao entendo', 'nao entendi',
    'nao aprendi', 'nao aprendemos', 'enrola', 'desorganizad',
    'grosseir', 'grosso', 'grossa', 'deboch', 'arrogan', 'ignorante', 'desrespeit',
    'falta de respeito', 'mal educad', 'humilh', 'constrang', 'impaciente', 'pouca paciencia',
    'sem paciencia', 'nao tem paciencia', 'nao tem muita paciencia', 'desnecessari',
    'nao tira duvida', 'nao responde', 'decepcion', 'desmotiv', 'nao ajuda',
    'nao consigo aprender', 'nao consigo entender', 'monoton', 'macante', 'superficia',
    'nao tem espaco', 'nao tem lugar',
    'atrapalh', 'dificultando', 'rapido demais', 'explica muito rapido', 'explicando muito rapido',
    'passa muito rapido', 'acelera demais', 'nao cativa', 'aulas paradas', 'muito parad', 'cansativ',
    'nao estamos contentes', 'nao tem resolut', 'pouco didatic', 'nada didatic', 'sem didatica', 'impacien', 'entediante', 'se excede',
    'mais paciencia', 'falar devagar', 'mais devagar', 'acelerad', 'nao achei legal', 'nao e legal',
    'podia colocar', 'podia ter', 'podia ser mais', 'podia dar', 'podia passar','precisamos de mais', 'precisariamos', 'muito puxad',
    'para pouco tempo', 'pra pouco tempo', 'em pouco tempo', 'pouco tempo para', 'pouco tempo pra', 'pouco tempo de aula', 'pouco tempo que temos',
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
    'melhor professor', 'melhor professora', 'explica bem', 'explica muito bem', 'facil de entender',
    'boa didatica', 'otima didatica', 'gente boa', 'muito legal', 'nao tem igual', 'coloquei 10', 'empenhad', 'dedicad',
    'amo ela', 'amo ele', 'amo a ', 'amo o ', 'amo as aulas', 'amo essa', 'amo esse', 'atencios', 'respeitos',
    'sempre disponivel', 'sempre esta disponivel', 'presta disponivel', 'sempre disposta', 'sempre disposto', 'prestativ', 'competente', 'paciente',
    'muita paciencia', 'querid', 'acolhedor', 'uma das melhores', 'um dos melhores', 'favorit',
    'muito didatic', 'extremamente didatic', 'super didatic', 'nota mil', 'ministra bem', 'humana',
    'carismatic', 'maravi', 'bom desempenho', 'dispensa comentario', 'um amor', 'apenas elogios', 'so elogios',
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
// que de crítica, e vira "bom". Só vale pro comentário curto (até 4
// palavras): no meio de um texto maior, "não tem" costuma ser crítica
// ("não tem muita paciência", "não tem material").
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
const REGEX_NADA_RECLAMAR = /\bnada\b[a-z ]{0,25}\breclamar\b/g;
// "nenhuma crítica ou sugestão", "sem reclamações e nem sugestões", "não tenho
// críticas nem sugestões": a negação vale pra lista inteira, não só pro 1º item.
const QUEIXA = '(critica|sugest|reclama|queixa|problema|observac|apontament)[a-z]*';
const REGEX_NEGA_LISTA = new RegExp(`\\b(nenhuma?|sem|nada de|nao (tenho|ha|tem|tive|vejo|encontro)( nenhuma?)?)( (mais|outra|outras|muitas?))? ${QUEIXA}((,? (ou|e|nem|e nem|e\\/ou) | ?\\/ ?)(nenhuma? |de )?${QUEIXA})*`, 'g');
// Crítica negada ("não é difícil de entender", "pra não ficar cansativo") não é crítica.
const REGEX_CRITICA_NEGADA = /\bnao (e|eh|fica|ficar|foi|sao|seja|torna) (tao |muito |nada |nem um pouco )?(dificil de entender|cansativ[a-z]*|confus[a-z]*|chat[a-z]*|monoton[a-z]*|macante|ruim)\b|\bnao deixa (nada )?a desejar\b/g;
// Elogio escrito com palavra de crítica: "deveria ser mais valorizada",
// "poderia ser ela em todas as matérias", "precisamos de mais professores
// como ele", "entende as dificuldades dos alunos", "sempre resolve os
// problemas". Só valem quando o comentário já tem elogio explícito ("o curso
// deveria ser mais valorizado" sozinho continua sendo crítica). Retirados
// antes de procurar crítica e contam como elogio.
const ELOGIO_DISFARCADO = [
    /\b(deveria|deveriam|merece|merecia|precisa|precisava)( ser)?( muito| bem)? mais (valorizad|reconhecid)[a-z]*/g,
    /\b(poderia|podia|deveria|queria|queremos) (ser|ter) (ela|ele|a professora|o professor|essa professora|esse professor|a prof|o prof)( [a-z]+)? (em|nas|nos|de|para|pra) (todas|todos)/g,
    /\b(precisamos de|deveria ter|deveria haver|poderia ter|poderia haver|queria|faltam) mais (professores|professoras|profissionais|pessoas) (como|tao|assim|iguais|igual)/g,
    /\b(entende|entender|compreende|compreender|ajuda|ajudar|ajudando|respeita|considera|acolhe|percebe|resolve|resolver|resolvendo|soluciona|solucionar|sana|sanar|supera|superar)( [a-z]+){0,3} (dificuldades?|problemas?)\b/g,
];
// "top", "show" e "amo" só como palavra inteira ("tópico" e "laptop" não contam).
const REGEX_BOM = /\b(top|show|amo|amoo|foda|legal)\b|^\W*(a|o) (melhor|melhores)\b/;
// "não tem o que reclamar", "não tem nada pra falar", "não tem o que dizer" =
// satisfeito, conta como elogio (se não houver crítica no resto do comentário).
const REGEX_NADA_A_DIZER = /\bnao (tem|tenho|temos|ha) (nada|o que|oq|oque|do que|absolutamente nada)( de| pra| para| a)? (dizer|falar|reclamar|criticar|declarar|comentar|acrescentar)\b/g;

// Tira do texto os trechos casados por `frases` (mais longos primeiro) e diz se achou algum.
function tirar(t, frases) {
    let achou = false;
    for (const p of [...frases].sort((a, b) => b.length - a.length)) {
        if (t.includes(p)) { achou = true; t = t.split(p).join(' | '); }
    }
    return [t, achou];
}

// Os trechos que negam queixa ("nada a reclamar"), elogiam a própria CPA ou
// pedem melhoria genérica são retirados ANTES de procurar crítica — mas a
// análise continua no resto do comentário. Antes, achar um desses trechos
// encerrava a classificação, e uma crítica real que viesse depois se perdia
// (ex.: "...não tem muita paciência... debochou da minha cara" saía como elogio).
function classificarComentario(texto) {
    const t = normalizar(texto);
    const numPalavras = t.split(/\s+/).filter(Boolean).length;
    const temElogio = PALAVRAS_BOM.some(p => t.includes(p)) || REGEX_BOM.test(t);

    let [resto, elogioProcesso] = tirar(t, ELOGIO_PROCESSO_MELHORIA);
    const satisfeito = t.replace(REGEX_NADA_A_DIZER, '') !== t;
    if (temElogio || satisfeito) for (const re of ELOGIO_DISFARCADO) {
        const sem = resto.replace(re, ' | ');
        if (sem !== resto) { elogioProcesso = true; resto = sem; }
    }
    let negouQueixa = false, negouFixa, melhoriaVaga;
    const semNadaADizer = resto.replace(REGEX_NADA_A_DIZER, ' | ');
    const nadaADizer = semNadaADizer !== resto;
    resto = semNadaADizer;
    resto = resto.replace(REGEX_CRITICA_NEGADA, ' | ');
    for (const re of [REGEX_NEGA_LISTA, REGEX_NADA_RECLAMAR]) {
        const sem = resto.replace(re, ' | ');
        if (sem !== resto) { negouQueixa = true; resto = sem; }
    }
    [resto, negouFixa] = tirar(resto, NEGACAO_SEM_QUEIXA);
    negouQueixa = negouQueixa || negouFixa;
    [resto, melhoriaVaga] = tirar(resto, MELHORIA_VAGA);

    if (PALAVRAS_ATENCAO.some(p => resto.includes(p))) return 'atencao';
    const elogio = temElogio || elogioProcesso || nadaADizer;
    if (melhoriaVaga) return elogio ? 'bom' : (numPalavras <= 4 ? 'neutro' : 'atencao');
    if (PALAVRAS_ATENCAO_FRACAS.some(p => resto.includes(p))) return elogio ? 'bom' : (negouQueixa ? 'neutro' : 'atencao');
    if (elogio) return 'bom';
    // "Não tem" / "não tem nada" sozinho = não tem do que reclamar
    if (numPalavras <= 4 && NEGACAO_POSITIVA.some(p => t.includes(p))) return 'bom';
    return 'neutro';
}

module.exports = { classificarComentario, normalizar };
