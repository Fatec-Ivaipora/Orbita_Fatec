// Classifica uma questão numa das 7 áreas ENAMED pelo CONTEÚDO (título +
// enunciado), pra disciplinas "transversais" que não têm uma área fixa
// (Sistemas Morfofisiológicos, Patologia Clínica, Habilidades Clínicas etc. —
// cobrem várias áreas ao mesmo tempo, então a disciplina sozinha não decide).
// Heurística por palavra-chave: soma pontos por área, só sugere quando UMA
// área se destaca claramente das demais — senão fica em branco pro professor
// decidir (melhor não marcar do que marcar errado).

const AREAS_ENAMED = [
    'Clínica Médica',
    'Cirurgia',
    'Pediatria',
    'Ginecologia e Obstetrícia',
    'Saúde Mental',
    'Medicina de Família e Comunidade',
    'Medicina Preventiva e Social'
];

const PALAVRAS_CHAVE = {
    'Clínica Médica': [
        'diabetes', 'diabetic', 'hipertens', 'cardiovascular', 'cardiac', 'coracao',
        'pulmao', 'pulmonar', 'respirator', 'dpoc', 'asma', 'renal', 'hepatic',
        'gastrointestinal', 'endocrino', 'tireoide', 'anemia', 'dislipidemia',
        'arritmia', 'infarto', 'avc', 'acidente vascular cerebral', 'idoso',
        'geriatr', 'insuficiencia cardiaca', 'insuficiencia renal', 'choque',
        'sepse', 'febre', 'cirrose', 'hepatite', 'ulcera peptica', 'colesterol',
        'obesidade', 'sindrome metabolica', 'artrite reumatoide', 'lupus',
        'cuidado paliativo', 'urgencia clinica', 'dor toracica'
    ],
    'Cirurgia': [
        'cirurgic', 'cirurgia', 'sutura', 'bisturi', 'apendicite', 'hernia',
        'colecistite', 'pos operatorio', 'pre operatorio', 'anestesi',
        'laparotomia', 'laparoscopi', 'abdome agudo', 'trauma abdominal',
        'politrauma', 'fratura', 'amputacao', 'enxerto', 'drenagem cirurgica',
        'oncologia cirurgica', 'tumor cirurgico', 'ressecção', 'biopsia excisional'
    ],
    'Pediatria': [
        'crianca', 'lactente', 'recem nascido', 'recem-nascido', 'neonatal',
        'infantil', 'puericultura', 'calendario vacinal', 'vacina infantil',
        'crescimento e desenvolvimento', 'aleitamento materno', 'amamentacao',
        'adolescente', 'pediatr', 'apgar', 'icterícia neonatal', 'desnutricao infantil'
    ],
    'Ginecologia e Obstetrícia': [
        'gestante', 'gestacao', 'gestacional', 'parto', 'puerperio', 'gravidez',
        'gravida', 'utero', 'uterina', 'ovario', 'obstetric', 'ginecolog',
        'pre natal', 'pre-natal', 'papanicolau', 'ciclo menstrual', 'menstrua',
        'contracep', 'placenta', 'cesarea', 'aborto', 'climaterio', 'menopausa',
        'colo do utero', 'mama', 'mastite'
    ],
    'Saúde Mental': [
        'ansiedade', 'depress', 'psiquiatr', 'transtorno mental', 'esquizofrenia',
        'suicid', 'bipolar', 'psicose', 'saude mental', 'dependencia quimica',
        'uso de substancias', 'alcoolismo', 'transtorno de humor', 'panico',
        'psicoterapi', 'antidepressivo', 'antipsicotico'
    ],
    'Medicina de Família e Comunidade': [
        'atencao basica', 'unidade basica de saude', 'ubs', 'territorializacao',
        'territorio', 'agente comunitario', 'estrategia saude da familia',
        'esf ', 'visita domiciliar', 'longitudinalidade', 'integralidade do cuidado',
        'coordenacao do cuidado', 'nasf'
    ],
    'Medicina Preventiva e Social': [
        'epidemiolog', 'saude publica', 'vigilancia epidemiologica', 'sus ',
        'sistema unico de saude', 'politica de saude', 'indicador de saude',
        'promocao da saude', 'saude coletiva', 'saude do trabalhador',
        'saude ocupacional', 'medicina legal', 'necropsia', 'perícia medica',
        'determinantes sociais', 'desigualdade social', 'saude global'
    ]
};

function normalizar(s) {
    return String(s || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase();
}

// Retorna a área sugerida ou null (sem sugestão confiável). `titulo` e
// `enunciadoHtml`/`justificativa` entram concatenados — quanto mais texto,
// melhor o sinal.
function classificarAreaEnamed(titulo, ...camposHtml) {
    const texto = normalizar([titulo, ...camposHtml].filter(Boolean).join(' '));
    if (!texto.trim()) return null;

    const pontos = {};
    for (const area of AREAS_ENAMED) {
        let pontuacao = 0;
        for (const termo of PALAVRAS_CHAVE[area]) {
            if (texto.includes(termo)) pontuacao++;
        }
        if (pontuacao > 0) pontos[area] = pontuacao;
    }

    const entradas = Object.entries(pontos).sort((a, b) => b[1] - a[1]);
    if (!entradas.length) return null;

    const [melhorArea, melhorScore] = entradas[0];
    const segundoScore = entradas[1] ? entradas[1][1] : 0;

    // só sugere se a área líder se destacar claramente da segunda colocada —
    // empate ou quase-empate é sinal ambíguo, melhor deixar em branco.
    if (melhorScore < 1) return null;
    if (segundoScore > 0 && melhorScore <= segundoScore) return null;

    return melhorArea;
}

module.exports = { classificarAreaEnamed, AREAS_ENAMED, PALAVRAS_CHAVE };
