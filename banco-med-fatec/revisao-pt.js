// Revisão de português e ABNT das questões (13/11/2026) — SEM IA e sem internet: só regras.
// Pega os erros que mais aparecem nas provas dos professores (acento, ç/ão, reforma ortográfica, crase,
// abreviação informal, espaço e pontuação, unidades de medida) e confere a referência na NBR 6023.
// Cada achado traz { de, para, motivo, idx } — "para" vazio = só aviso (não dá pra corrigir sozinho).
// Compartilhado entre o servidor (require) e a tela (window.RevisaoPt).
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica();
    else raiz.RevisaoPt = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const L = 'A-Za-zÀ-ÖØ-öø-ÿ';              // letras (com acento)
const P = (s) => new RegExp(s, 'g');
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// mantém maiúscula do original: "Nao" -> "Não", "NAO" -> "NÃO"
function comCaixa(orig, novo) {
    if (!orig || !novo) return novo;
    if (orig.length > 1 && orig === orig.toUpperCase() && orig !== orig.toLowerCase()) return novo.toUpperCase();
    if (orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase()) return novo[0].toUpperCase() + novo.slice(1);
    return novo;
}

// ---------- palavras que os professores escrevem sem acento / erradas (chave sem acento, minúscula) ----------
const PALAVRAS = {
    nefrotica: 'nefrótica', nefrotico: 'nefrótico', nefritica: 'nefrítica', nefritico: 'nefrítico', diabetico: 'diabético', diabetica: 'diabética', diabeticos: 'diabéticos', cirrotico: 'cirrótico', isquemico: 'isquêmico', isquemica: 'isquêmica', hemorragico: 'hemorrágico', hemorragica: 'hemorrágica', metabolico: 'metabólico', metabolica: 'metabólica', alergico: 'alérgico', alergica: 'alérgica', cardiologico: 'cardiológico', toxico: 'tóxico', toxica: 'tóxica', septico: 'séptico', septica: 'séptica', anatomico: 'anatômico', anatomica: 'anatômica', fisiopatologico: 'fisiopatológico', embolico: 'embólico', trombotico: 'trombótico', atrofico: 'atrófico', hipertrofico: 'hipertrófico', cianotico: 'cianótico', icterico: 'ictérico', icterica: 'ictérica', hipovolemico: 'hipovolêmico', hipovolemica: 'hipovolêmica', hemodinamico: 'hemodinâmico', hemodinamica: 'hemodinâmica', ortopedico: 'ortopédico', oncologico: 'oncológico', endocrino: 'endócrino', linfatico: 'linfático', pancreatico: 'pancreático', cutaneo: 'cutâneo', cutanea: 'cutânea', epidemiologico: 'epidemiológico', farmacologico: 'farmacológico', profilatico: 'profilático', sintomatico: 'sintomático', assintomatico: 'assintomático', assintomatica: 'assintomática', organico: 'orgânico', psicologico: 'psicológico', psiquico: 'psíquico', exantematico: 'exantemático', tecnica: 'técnica', tecnicas: 'técnicas', tecnico: 'técnico', etico: 'ético', etica: 'ética', bioetica: 'bioética', biopsia: 'biópsia', raiox: 'raio X', eletrolitico: 'eletrolítico', sodico: 'sódico', hidrico: 'hídrico', termico: 'térmico', cefalico: 'cefálico', toracica: 'torácica', vertebra: 'vértebra', vertebras: 'vértebras', femur: 'fêmur', umero: 'úmero', cranio: 'crânio', utero: 'útero', ovario: 'ovário', ovarios: 'ovários', figado: 'fígado', pancreas: 'pâncreas', esofago: 'esôfago', estomago: 'estômago', bronquios: 'brônquios', alveolo: 'alvéolo', alveolos: 'alvéolos', miocardio: 'miocárdio', pericardio: 'pericárdio', endocardio: 'endocárdio', ventriculo: 'ventrículo', ventriculos: 'ventrículos', atrio: 'átrio', atrios: 'átrios', valvula: 'válvula', valvulas: 'válvulas', arteria: 'artéria', leucocito: 'leucócito', leucocitos: 'leucócitos', linfocito: 'linfócito', linfocitos: 'linfócitos', neutrofilo: 'neutrófilo', neutrofilos: 'neutrófilos', eritrocito: 'eritrócito', eritrocitos: 'eritrócitos', hematocrito: 'hematócrito', acucar: 'açúcar', oxigenio: 'oxigênio', nitrogenio: 'nitrogênio', hidrogenio: 'hidrogênio', dioxido: 'dióxido', saturacao: 'saturação', frequencia: 'frequência', pressao: 'pressão',
    nao: 'não', hipotese: 'hipótese', hipoteses: 'hipóteses', etiologia: 'etiologia', patologia: 'patologia', ambulatorio: 'ambulatório',
    laboratorio: 'laboratório', exames: 'exames', urgencia: 'urgência', emergencia: 'emergência', tambem: 'também', voce: 'você', voces: 'vocês', entao: 'então', porem: 'porém', alem: 'além', apos: 'após',
    atraves: 'através', atravez: 'através', 'atravéz': 'através', tres: 'três', numero: 'número', numeros: 'números', sao: 'são', estao: 'estão',
    serao: 'serão', irao: 'irão', terao: 'terão', poderao: 'poderão', deverao: 'deverão', ja: 'já', ate: 'até', mes: 'mês',
    obvio: 'óbvio', provavel: 'provável', provaveis: 'prováveis', possivel: 'possível', possiveis: 'possíveis', impossivel: 'impossível',
    saude: 'saúde', diagnostico: 'diagnóstico', diagnosticos: 'diagnósticos', prognostico: 'prognóstico', terapeutico: 'terapêutico',
    terapeutica: 'terapêutica', terapeuticos: 'terapêuticos', farmaco: 'fármaco', farmacos: 'fármacos', cronico: 'crônico', cronica: 'crônica',
    cronicos: 'crônicos', cardiaco: 'cardíaco', cardiaca: 'cardíaca', toracico: 'torácico', toracica: 'torácica', abdomen: 'abdômen',
    orgao: 'órgão', orgaos: 'órgãos', clinico: 'clínico', clinicos: 'clínicos', clinicas: 'clínicas', medico: 'médico', medicos: 'médicos',
    medica: 'médica', fisico: 'físico', fisica: 'física', fisicos: 'físicos', sindrome: 'síndrome', sindromes: 'síndromes', obito: 'óbito',
    torax: 'tórax', historia: 'história', periodo: 'período', unico: 'único', unica: 'única', basico: 'básico', basica: 'básica',
    proximo: 'próximo', proxima: 'próxima', maximo: 'máximo', minimo: 'mínimo', agua: 'água', util: 'útil', facil: 'fácil', dificil: 'difícil',
    especifico: 'específico', especifica: 'específica', patologico: 'patológico', fisiologico: 'fisiológico', sistemico: 'sistêmico',
    venoso: 'venoso', arterias: 'artérias', arteria: 'artéria', veia: 'veia', musculo: 'músculo', musculos: 'músculos', osseo: 'ósseo', ossea: 'óssea',
    acido: 'ácido', acidos: 'ácidos', sodio: 'sódio', potassio: 'potássio', calcio: 'cálcio', magnesio: 'magnésio', glicose: 'glicose',
    hemoglobina: 'hemoglobina', eletrocardiograma: 'eletrocardiograma', analgesico: 'analgésico', antibiotico: 'antibiótico',
    antibioticos: 'antibióticos', cirurgico: 'cirúrgico', cirurgica: 'cirúrgica', pediatrico: 'pediátrico', obstetrico: 'obstétrico',
    ginecologico: 'ginecológico', neurologico: 'neurológico', psiquiatrico: 'psiquiátrico', respiratorio: 'respiratório', respiratoria: 'respiratória',
    hepatico: 'hepático', hepatica: 'hepática', renal: 'renal', gastrico: 'gástrico', gastrica: 'gástrica', cancer: 'câncer', tumor: 'tumor',
    edêma: 'edema', 'paciênte': 'paciente', 'paciêntes': 'pacientes', 'ítem': 'item', 'ítens': 'itens', 'rúbrica': 'rubrica', 'gratuíto': 'gratuito',
    hipertencao: 'hipertensão', 'hipertenção': 'hipertensão', 'hipotenção': 'hipotensão', menas: 'menos', seje: 'seja', esteje: 'esteja',
    concerteza: 'com certeza', derrepente: 'de repente', 'excessão': 'exceção', 'excesão': 'exceção', 'previlégio': 'privilégio',
    beneficiente: 'beneficente', apartir: 'a partir', porisso: 'por isso', mendingo: 'mendigo', 'auto-estima': 'autoestima',
    'infra-estrutura': 'infraestrutura', 'semi-árido': 'semiárido', antiinflamatorio: 'anti-inflamatório', 'antiinflamatório': 'anti-inflamatório',
    antiinflamatorios: 'anti-inflamatórios', 'antiinflamatórios': 'anti-inflamatórios', microorganismo: 'micro-organismo',
    microorganismos: 'micro-organismos', 'contra-indicação': 'contraindicação', 'contra-indicado': 'contraindicado',
    'contra-indicada': 'contraindicada', 'pré-natal': 'pré-natal', 'pos-operatorio': 'pós-operatório', 'pos-operatório': 'pós-operatório',
    'pre-operatorio': 'pré-operatório', 'pre-operatório': 'pré-operatório', 'intra-hospitalar': 'intra-hospitalar', 'extra-sistole': 'extrassístole',
    'extra-sístole': 'extrassístole', 'auto-medicação': 'automedicação', 'auto-exame': 'autoexame', 'co-morbidade': 'comorbidade',
    'co-morbidades': 'comorbidades', 'sub-cutâneo': 'subcutâneo', 'sub-cutaneo': 'subcutâneo', subcutaneo: 'subcutâneo', 'intra-venoso': 'intravenoso',
    'intra-muscular': 'intramuscular'
};
// verbos/substantivos que só valem com acento conforme o sentido: avisa, não corrige sozinho
// palavra que só leva acento como substantivo/adjetivo: corrige quando vem depois de artigo/determinante
const SUBST = {
    analise: 'análise', analises: 'análises', evidencia: 'evidência', evidencias: 'evidências', referencia: 'referência', referencias: 'referências',
    pratica: 'prática', praticas: 'práticas', critica: 'crítica', criticas: 'críticas', influencia: 'influência', sequencia: 'sequência',
    potencia: 'potência', duvida: 'dúvida', duvidas: 'dúvidas', clinica: 'clínica', diagnostica: 'diagnóstica', calculo: 'cálculo', calculos: 'cálculos',
    estimulo: 'estímulo', estimulos: 'estímulos', liquido: 'líquido', liquidos: 'líquidos', ultimo: 'último', ultima: 'última', publico: 'público',
    pratico: 'prático', experiencia: 'experiência'
};
const RE_DETERMINANTE = /(?:^|[^\wÀ-ÿ])(a|as|o|os|da|das|do|dos|na|nas|no|nos|uma|umas|um|uns|pela|pelas|pelo|pelos|à|às|ao|aos|sua|suas|seu|seus|esta|essa|este|esse|cada|nesta|nessa|neste|nesse|desta|dessa|deste|desse|outra|outro|nova|novo|boa|bom|primeira|primeiro)\s+$/i;
const CONFIRA = {};
// abreviações informais
const INFORMAL = {
    pct: 'paciente', pcte: 'paciente', pcts: 'pacientes', pctes: 'pacientes', vc: 'você', vcs: 'vocês', tb: 'também', tbm: 'também',
    qdo: 'quando', qto: 'quanto', hj: 'hoje', msm: 'mesmo', mto: 'muito', mta: 'muita', pq: '', obs: ''
};
delete INFORMAL.obs;
// ç/ão/ência que caem sem acento (regra geral, com exceções)
const EXC_AO = new Set(['cacao', 'macao', 'callao', 'bao', 'tao', 'ao', 'kao', 'mao']);
const EXC_CAO = new Set([]);
// crase antes de palavra que não aceita artigo feminino
const SEM_CRASE = /(?<![\wÀ-ÿ])à (partir|seguir|respeito|medida que|nível|prazo|vista de|ele|eles|você|vocês|mim|ti|este|esse|isso|isto|uma|cada|qualquer|todo|todos|tudo|quem|vossa|sua excelência)\b/gi;
const VERBO_INF = /(?<![\wÀ-ÿ])à ([a-zà-ú]+(?:ar|er|ir))(?![\wÀ-ÿ])/gi;
const NAO_VERBO = new Set(['mulher', 'colher', 'qualquer', 'lugar', 'par', 'mar', 'bar', 'dor', 'cor']);

// regras de texto: [regex, para (string|função), motivo, tipo]
const REGRAS = [
    [P('(\\S) {2,}(?=\\S)'), (m, a) => `${a} `, 'Espaço duplo.', 'pontuacao'],
    [P(`([${L}]) +,(?=[${L}0-9])`), (m, a) => `${a}, `, 'Vírgula junto da palavra e com espaço depois.', 'pontuacao'],
    [/(?<![\wÀ-ÿ])ha (?=\d|muit|pouc|cerca|mais|menos|algum|alguns|quanto|tempo)/g, 'há ', '"Há" (tempo decorrido / existir) tem acento.', 'ortografia'],
    [/(?<![\wÀ-ÿ])Ha (?=\d|muit|pouc|cerca|mais|menos|algum|alguns|quanto|tempo)/g, 'Há ', '"Há" (tempo decorrido / existir) tem acento.', 'ortografia'],
    [/(\d+)\s*mmhg\b/gi, (m, a) => (m === `${a} mmHg` ? m : `${a} mmHg`), 'A unidade é "mmHg", separada do número.', 'unidade'],
    [P(`([${L}0-9)]) +([,.;:?!])(?![${L}0-9])`), (m, a, b) => `${a}${b}`, 'Sem espaço antes da pontuação.', 'pontuacao'],
    [P(`([,;])(?=[${L}])`), (m, a) => `${a} `, 'Falta espaço depois da vírgula/ponto e vírgula.', 'pontuacao'],
    [P(`([a-zà-ÿ]{3,})\\.(?=[A-ZÀ-Ö][a-zà-ÿ])`), (m, a) => `${a}. `, 'Falta espaço depois do ponto.', 'pontuacao'],
    [/\b(de|da|do|das|dos|que|o|os|as|e|em|no|na|para|com|não|um|uma)\s+\1\b/gi, (m, a) => a, 'Palavra repetida.', 'digitacao'],
    [/\?{2,}|!{2,}/g, (m) => m[0], 'Pontuação repetida.', 'pontuacao'],
    // reforma ortográfica (2009)
    [/ü/g, 'u', 'O trema foi abolido (ex.: frequente, consequência, sequela).', 'ortografia'],
    [P(`\\b([${L}]+)éi(a|as)\\b`), (m, a, b) => `${a}ei${b}`, 'Ditongo "ei" em paroxítona não tem mais acento (ideia, dispneia, apneia, diarreia).', 'ortografia'],
    [P(`\\b([${L}]*)ói(a|as|co|cos|ca|cas)\\b`), (m, a, b) => `${a}oi${b}`, 'Ditongo "oi" em paroxítona não tem mais acento (paranoia, heroico).', 'ortografia'],
    [/ôo/g, 'oo', 'Sem acento em "oo" (voo, enjoo).', 'ortografia'],
    [/\b(l|v|cr|d)êem\b/gi, (m, a) => `${a}eem`, 'Sem acento em "eem" (leem, veem, creem, deem).', 'ortografia'],
    // crase
    [SEM_CRASE, (m, a) => `a ${a}`, 'Não há crase antes desta palavra.', 'crase'],
    [/\bafim de\b/gi, (m) => comCaixa(m, 'a fim de'), '"A fim de" (finalidade) é separado.', 'ortografia'],
    [/\ba nível de\b/gi, (m) => comCaixa(m, 'em nível de'), 'Prefira "em nível de" (ou "quanto a").', 'estilo'],
    [/\bmal estar\b/gi, (m) => comCaixa(m, 'mal-estar'), '"Mal-estar" tem hífen.', 'ortografia'],
    [/\bpor que\s*\?/gi, (m) => comCaixa(m, 'por quê?'), 'No fim da frase é "por quê?".', 'ortografia'],
    [/\bporque\s*\?/gi, (m) => comCaixa(m, 'por quê?'), 'No fim da pergunta é "por quê?".', 'ortografia'],
    // unidades de medida (SI / padrão de laudo)
    [/(\d+)\.(\d+)(?=\s*(°C|ºC|mg|g|kg|mL|ml|L|cm|mm|mmHg|%|bpm|irpm|mEq|U|UI)\b)/g, (m, a, b) => `${a},${b}`, 'Decimal com vírgula (ex.: 38,5 °C).', 'unidade'],
    [/(\d+)\s*º\s*C\b/g, (m, a) => `${a} °C`, 'Grau Celsius é "°C" (com espaço depois do número).', 'unidade'],
    [/(\d+)°C\b/g, (m, a) => `${a} °C`, 'Espaço entre o número e a unidade (38,5 °C).', 'unidade'],
    [/\bmmhg\b|\bMMHG\b|\bmmHG\b/g, 'mmHg', 'A unidade é "mmHg".', 'unidade'],
    [/\b(\d+)Kg\b|\bKg\b/g, (m, a) => a ? `${a} kg` : 'kg', 'Quilograma é "kg" (minúsculo).', 'unidade'],
    [/(\d+)(mg|kg|mL|cm|mm|mmHg|bpm|irpm|mEq|UI)\b/g, (m, a, b) => `${a} ${b}`, 'Espaço entre o número e a unidade.', 'unidade'],
    [/(\d+)\s?ml\b/g, (m, a) => `${a} mL`, 'Mililitro é "mL".', 'unidade']
];

function achar(texto, opts) {
    opts = opts || {};
    const t = String(texto || '');
    const out = [];
    const add = (idx, de, para, motivo, tipo) => {
        if (!de || de === para) return;
        if (out.some(o => idx < o.idx + o.de.length && o.idx < idx + de.length)) return; // sobreposição: fica o primeiro
        out.push({ idx, de, para, motivo, tipo });
    };
    // palavras
    const reWord = new RegExp(`[${L}]+(?:-[${L}]+)*`, 'g');
    let m;
    while ((m = reWord.exec(t))) {
        const w = m[0], k = w.toLowerCase(), ks = semAcento(w);
        if (PALAVRAS[k] && PALAVRAS[k] !== k) { add(m.index, w, comCaixa(w, PALAVRAS[k]), 'Ortografia/acentuação.', 'ortografia'); continue; }
        if (k === ks && SUBST[k]) {
            const antes = t.slice(Math.max(0, m.index - 14), m.index);
            if (RE_DETERMINANTE.test(antes)) add(m.index, w, comCaixa(w, SUBST[k]), 'Acentuação (substantivo/adjetivo leva acento).', 'ortografia');
            else if (/^(diagnostica|clinica)$/.test(k) && /(hip[óo]tese|avalia[çc][ãa]o|conduta|impress[ãa]o|pr[áa]tica|investiga[çc][ãa]o|suspeita)\s+$/i.test(antes)) add(m.index, w, comCaixa(w, SUBST[k]), 'Acentuação (adjetivo leva acento).', 'ortografia');
            continue;
        }
        if (k === ks && CONFIRA[k]) { add(m.index, w, '', `Confira o acento: ${CONFIRA[k]}`, 'confira'); continue; }
        if (k === ks && Object.prototype.hasOwnProperty.call(INFORMAL, k)) {
            add(m.index, w, INFORMAL[k] ? comCaixa(w, INFORMAL[k]) : '', INFORMAL[k] ? 'Abreviação informal: escreva por extenso.' : 'Abreviação informal: escreva "porque" ou "por que".', 'informal');
            continue;
        }
        if (k === ks && w.length >= 5 && /cao$/.test(k) && !EXC_CAO.has(k)) { add(m.index, w, comCaixa(w, w.slice(0, -3) + 'ção'), 'Falta "ção" (cedilha e til).', 'ortografia'); continue; }
        if (k === ks && w.length >= 5 && /coes$/.test(k)) { add(m.index, w, comCaixa(w, w.slice(0, -4) + 'ções'), 'Falta "ções" (cedilha e til).', 'ortografia'); continue; }
        if (k === ks && w.length >= 4 && /[^aeiou]ao$|[aeiou]ao$/.test(k) && /ao$/.test(k) && !EXC_AO.has(k) && !/cao$/.test(k)) { add(m.index, w, comCaixa(w, w.slice(0, -2) + 'ão'), 'Falta o til ("ão").', 'ortografia'); continue; }
        if (k === ks && w.length >= 5 && /oes$/.test(k) && !/coes$/.test(k)) { add(m.index, w, comCaixa(w, w.slice(0, -3) + 'ões'), 'Falta o til ("ões").', 'ortografia'); continue; }
        if (k === ks && w.length >= 7 && /encia$/.test(k) && !CONFIRA[k]) { add(m.index, w, comCaixa(w, w.slice(0, -5) + 'ência'), 'Falta o acento ("ência").', 'ortografia'); continue; }
        if (k === ks && w.length >= 7 && /ancia$/.test(k)) { add(m.index, w, comCaixa(w, w.slice(0, -5) + 'ância'), 'Falta o acento ("ância").', 'ortografia'); continue; }
    }
    // abreviações com barra (c/ s/)
    const reBarra = /(^|\s)([cs])\/(?=\s)/gi;
    while ((m = reBarra.exec(t))) add(m.index + m[1].length, `${m[2]}/`, m[2].toLowerCase() === 'c' ? 'com' : 'sem', 'Abreviação informal: escreva por extenso.', 'informal');
    // crase antes de verbo no infinitivo
    VERBO_INF.lastIndex = 0;
    while ((m = VERBO_INF.exec(t))) { if (!NAO_VERBO.has(m[1].toLowerCase())) add(m.index, m[0], `a ${m[1]}`, 'Não há crase antes de verbo.', 'crase'); }
    // regras gerais
    for (const [re, para, motivo, tipo] of REGRAS) {
        re.lastIndex = 0;
        while ((m = re.exec(t))) {
            const novo = typeof para === 'function' ? para(...m) : para;
            add(m.index, m[0], novo, motivo, tipo);
            if (!re.global) break;
        }
    }
    // pergunta: começa com palavra interrogativa e não termina em "?"
    if (opts.pergunta) {
        const s = t.trim();
        if (/^(qual|quais|como|quando|onde|por que|o que|quanto|quantos|quantas|que)\b/i.test(s) && !/\?\s*$/.test(s)) {
            const fim = s.replace(/[.:;!\s]+$/, '');
            const i = t.indexOf(s);
            add(i, s, `${fim}?`, 'Pergunta direta termina com "?".', 'pontuacao');
        }
    }
    // primeira letra maiúscula (texto, alternativa, pergunta)
    if (opts.maiuscula !== false) {
        const mm = /^(\s*)([a-zà-ÿ])/.exec(t);
        if (mm) add(mm[1].length, mm[2], mm[2].toUpperCase(), 'Comece com letra maiúscula.', 'pontuacao');
    }
    return out.sort((a, b) => a.idx - b.idx);
}

// aplica UM achado (confere se o trecho ainda está lá)
function aplicar(texto, a) {
    const t = String(texto || '');
    if (!a || !a.para && a.para !== '') return t;
    if (t.substr(a.idx, a.de.length) === a.de) return t.slice(0, a.idx) + a.para + t.slice(a.idx + a.de.length);
    const i = t.indexOf(a.de);
    return i < 0 ? t : t.slice(0, i) + a.para + t.slice(i + a.de.length);
}
function aplicarTodos(texto, achados) {
    let t = String(texto || '');
    [...achados].filter(a => a.para).sort((a, b) => b.idx - a.idx).forEach(a => { t = aplicar(t, a); });
    return t;
}

// corrige tudo o que tem correção, em até 4 passadas (uma correção pode revelar outra: "38.5ºC" -> "38,5 °C")
function corrigirTudo(texto, opts) {
    let t = String(texto || '');
    for (let i = 0; i < 4; i++) { const a = achar(t, opts).filter(x => x.para); if (!a.length) break; t = aplicarTodos(t, a); }
    return t;
}

// ---------- ABNT NBR 6023 (livro / artigo / site) ----------
// Formato: SOBRENOME, Iniciais. Título. Edição. Local: Editora, ano.
//          SOBRENOME, Iniciais. Título do artigo. Nome da Revista, Local, v. X, n. Y, p. Z-W, ano.
function abnt(ref) {
    const r = String(ref || '').replace(/\s+/g, ' ').trim();
    const out = [];
    if (!r) return out;
    const add = (de, para, motivo, idx) => { if (de !== para) out.push({ idx: idx !== undefined ? idx : Math.max(0, r.indexOf(de)), de, para, motivo, tipo: 'abnt' }); };
    // autores: "Moore, K. L., Dalley, A. F., & Agur, A. M." -> "MOORE, K. L.; DALLEY, A. F.; AGUR, A. M."
    const reAutor = /([A-ZÀ-Ö][a-zà-ÿ'\-]+(?: (?:de|da|do|dos|das) [A-ZÀ-Ö][a-zà-ÿ'\-]+)?), ((?:[A-ZÀ-Ö]\. ?){1,4})/g;
    let ma;
    while ((ma = reAutor.exec(r))) add(ma[1], ma[1].toUpperCase(), 'ABNT: sobrenome do autor em MAIÚSCULAS (MOORE, K. L.).', ma.index);
    const reSep = /([A-ZÀ-Ö]\.)(,\s*(?:&\s*|e\s+)?|\s+&\s+|\s+e\s+)(?=[A-ZÀ-Ö][a-zà-ÿA-ZÀ-Ö'\-]+, [A-ZÀ-Ö]\.)/g;
    while ((ma = reSep.exec(r))) add(ma[2], '; ', 'ABNT: autores separados por ponto e vírgula (MOORE, K. L.; DALLEY, A. F.).', ma.index + ma[1].length);
    // et al
    const etal = /\bet al(?!\.)\b/.exec(r);
    if (etal) add(etal[0], 'et al.', 'ABNT: "et al." com ponto.');
    // edição: "8ª edição", "8a ed", "8° ed." -> "8. ed."
    const ed = /\b(\d{1,2})\s*(ª|a|º|°|\.)?\s*(edição|edicao|ed\.?)\.?(?=[\s,;]|$)/i.exec(r);
    if (ed && !/^\d{1,2}\. ed\.$/.test(ed[0])) add(ed[0], `${ed[1]}. ed.`, 'ABNT: edição no formato "8. ed.".');
    // ano
    const anos = r.match(/\b(19|20)\d{2}\b/g);
    if (!anos) out.push({ idx: r.length, de: '', para: '', motivo: 'ABNT: falta o ano de publicação.', tipo: 'abnt' });
    // local: editora
    const ehSite = /https?:|disponível em|disponivel em/i.test(r);
    const ehArtigo = /\bv\.\s*\d|\bn\.\s*\d|\bp\.\s*\d|revista|journal|\bj\.|arq\.|bras\./i.test(r);
    if (!ehSite && !ehArtigo && !/[A-ZÀ-Ö][^.:,;]+:\s*[^,]+,\s*(19|20)\d{2}/.test(r)) {
        const ed2 = /\b(Guanabara Koogan|Elsevier|Artmed|Manole|Atheneu|Saunders|McGraw[- ]Hill|AMGH|Roca|Thieme|Revinter|Medbook|Sarvier|MedSi|Lippincott)\b/i.exec(r);
        const LOCAIS = { 'guanabara koogan': 'Rio de Janeiro', elsevier: 'Rio de Janeiro', artmed: 'Porto Alegre', manole: 'Barueri', atheneu: 'São Paulo', roca: 'São Paulo', revinter: 'Rio de Janeiro', amgh: 'Porto Alegre', 'mcgraw-hill': 'Porto Alegre', 'mcgraw hill': 'Porto Alegre', sarvier: 'São Paulo', medbook: 'Rio de Janeiro', thieme: 'Rio de Janeiro' };
        if (ed2 && !new RegExp(`:\\s*${ed2[1]}`, 'i').test(r)) {
            const local = LOCAIS[ed2[1].toLowerCase()];
            if (local) add(ed2[1], `${local}: ${ed2[1]}`, `ABNT: local antes da editora ("${local}: ${ed2[1]}, ano").`);
            else out.push({ idx: r.indexOf(ed2[1]), de: '', para: '', motivo: 'ABNT: falta o local antes da editora ("Cidade: Editora, ano").', tipo: 'abnt' });
        } else if (!ed2) out.push({ idx: 0, de: '', para: '', motivo: 'ABNT: confira "Local: Editora, ano" (livro) ou "Revista, v., n., p., ano" (artigo).', tipo: 'abnt' });
    }
    if (ehSite && !/acesso em/i.test(r)) out.push({ idx: r.length, de: '', para: '', motivo: 'ABNT: site precisa de "Disponível em: <link>. Acesso em: dia mês ano."', tipo: 'abnt' });
    if (!/\.$/.test(r)) { const ini = Math.max(0, r.lastIndexOf(' ', r.length - 6) + 1); add(r.slice(ini), r.slice(ini) + '.', 'ABNT: a referência termina com ponto.', ini); }
    return out;
}

// texto + referência de uma questão inteira → lista por campo
function revisarQuestao(q, textoDe) {
    const tx = textoDe || ((h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
    const r = [];
    const campo = (nome, t, opts) => achar(t, opts).forEach(a => r.push({ campo: nome, ...a }));
    campo('Caso clínico', tx(q.casoClinico || q.enunciadoHtml));
    if (q.pergunta) campo('Pergunta', tx(q.pergunta), { pergunta: true });
    (q.alternativas || []).forEach((a, i) => campo(`Alternativa ${'ABCDE'[i]}`, tx(a.texto)));
    campo('Feedback', tx(q.justificativa));
    if (q.fonte) abnt(q.fonte).forEach(a => r.push({ campo: 'Referência', ...a }));
    // pontuação uniforme nas alternativas
    const alts = (q.alternativas || []).map(a => tx(a.texto)).filter(Boolean);
    const comPonto = alts.filter(a => /\.$/.test(a)).length;
    if (comPonto && comPonto < alts.length) r.push({ campo: 'Alternativas', idx: 0, de: '', para: '', motivo: 'Pontuação desigual: ou todas as alternativas terminam com ponto, ou nenhuma.', tipo: 'pontuacao' });
    return r;
}

return { achar, aplicar, aplicarTodos, corrigirTudo, abnt, revisarQuestao, semAcento };
}));
