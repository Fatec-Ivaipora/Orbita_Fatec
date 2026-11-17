// Relatório CADAM — auditoria da prova em forma de DEVOLUTIVA ao professor (17/11/2026, pedido da coordenação de Medicina).
// Segue o roteiro de auditoria da coordenação: 4 eixos (1 integridade estrutural/AVA, 2 vícios e pistas,
// 3 qualidade psicométrica/NBME, 4 matriz e distribuição temática) → parecer Apta / Requer ajustes / Inapta,
// tabela de inconformidades, balanço temático e recomendações prioritárias.
// Só orienta: NÃO cria trava nova. As travas da prova continuam no padrao.js.
// Base: NBME (Guia para redação de questões 2022 e Construindo o Teste Escrito 2016), BMJ, Romão & Sá 2019,
// Gottlieb 2023, Bloom revisado e a aula Avaliação CADAM. UMD: servidor (require) e tela (window.CadamRelatorio).
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica(require('./padrao.js'), require('./revisao-pt.js'));
    else raiz.CadamRelatorio = fabrica(raiz.PadraoMed, raiz.RevisaoPt);
}(typeof self !== 'undefined' ? self : this, function (P, RV) {
'use strict';
const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const F = {
    nbme: 'NBME 2022', nbme16: 'NBME 2016', bmj: 'BMJ', rs: 'Romão & Sá 2019',
    got: 'Gottlieb 2023', bloom: 'Bloom revisado', cadam: 'Padrão CADAM'
};
const EIXOS = {
    1: 'Integridade estrutural e AVA',
    2: 'Vícios de elaboração e pistas',
    3: 'Qualidade psicométrica (NBME)',
    4: 'Matriz e distribuição temática'
};
// obrigatorio = corrigir antes de liberar · ajuste = deve melhorar · sugestao = boa prática
const NIVEL = { obrigatorio: 3, ajuste: 2, sugestao: 1 };
const txt = (h) => P.texto(h || '');
const sem = (s) => P.norm(s || '');
const frases = (t) => String(t || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
const MODELOS = {
    diagnostico: 'Qual é o diagnóstico mais provável?',
    exame: 'Qual é o exame mais apropriado neste momento?',
    conduta: 'Qual é o próximo passo mais adequado na conduta?',
    mecanismo: 'Qual é o mecanismo mais provável desse achado?',
    geral: 'Qual é o diagnóstico mais provável?" ou "Qual é a conduta mais adequada?'
};
function tarefaDa(pergunta) {
    const p = sem(pergunta);
    if (/diagnostic|hipotese/.test(p)) return 'diagnostico';
    if (/exame|investigac|solicitar/.test(p)) return 'exame';
    if (/conduta|tratamento|terapeutic|manejo|proximo passo|prescri|farmaco|medicament/.test(p)) return 'conduta';
    if (/mecanismo|fisiopatolog|por que|causa/.test(p)) return 'mecanismo';
    return 'geral';
}
// Bloom ESTIMADO pela tarefa (o verbo sozinho não decide — NBME 2016)
const NIVEIS = ['Lembrar', 'Entender', 'Aplicar', 'Analisar', 'Avaliar', 'Criar'];
function bloomDaQuestao(q, aplicacao) {
    const p = sem(q.pergunta || q.enunciadoHtml);
    if (!aplicacao) return /mecanismo|por que|explica|fisiopatolog/.test(p) ? 'Entender' : 'Lembrar';
    if (/mais adequad|melhor|prioridade|mais apropriad|justific/.test(p) && /conduta|tratamento|manejo|abordagem|resposta/.test(p)) return 'Avaliar';
    if (/diagnostic|hipotese|diferencial|explica(m)? (esses|estes|os) achados/.test(p)) return 'Analisar';
    return 'Aplicar';
}
const VERBOS = [
    ['Criar', /^(criar|planejar|elaborar|propor|formular|produzir|desenvolver|construir|projetar)\b/],
    ['Avaliar', /^(avaliar|julgar|justificar|decidir|criticar|diagnosticar|escolher|validar|priorizar)\b/],
    ['Analisar', /^(analisar|diferenciar|distinguir|contrastar|correlacionar|relacionar|organizar|discriminar|examinar|interpretar)\b/],
    ['Aplicar', /^(aplicar|realizar|executar|usar|utilizar|manejar|conduzir|prescrever|calcular|demonstrar|resolver|atuar|implementar|indicar|solicitar|orientar)\b/],
    ['Entender', /^(compreender|entender|explicar|descrever|classificar|resumir|exemplificar|comparar|discutir|caracterizar)\b/],
    ['Lembrar', /^(reconhecer|identificar|listar|citar|definir|nomear|recordar|conhecer|lembrar|enumerar)\b/]
];
function nivelDoObjetivo(obj) {
    const o = sem(obj).replace(/^o\d+\s*[–-]\s*/, '');
    for (const [nivel, re] of VERBOS) if (re.test(o)) return nivel;
    return null;
}
// marcas de bancas externas (no texto ORIGINAL, com maiúsculas) e números de questão importada
const RE_BANCA = /\b(FAMERP|UEL|UEM|UEPG|UNIOESTE|UFPR|UNIFESP|USP(-RP|-SP)?|UNICAMP|UNESP|REVALIDA|ENARE|ENADE|ENAMED|SUS-?SP|AMRIGS|HCPA|PSU-?MG|SURCE|UFRJ|UERJ|UFMG|UFRGS|UFSC|UFBA|UFPE|INEP|CESPE|CEBRASPE|VUNESP|IBFC|CONSULPLAN|FUVEST)\b/;
const RE_QUESTAO_IMPORTADA = /(\(\s*(quest[aã]o|q\.?)\s*\d+\s*\)|^\s*(quest[aã]o|q)\s*\d+\s*[\.\-–:)]|\b(prova|concurso|resid[eê]ncia)\s+(de\s+)?(19|20)\d{2}\b|\((19|20)\d{2}\)\s*$)/i;
const RE_ALINEA = /^\s*(\(?[a-eA-E]\)|[a-eA-E][\.\-–]\s|\(?\d{1,2}\)|\d{1,2}[\.\-–]\s)/;
const RE_SALA = /(dit[oa]s?|vist[oa]s?|discutid[oa]s?|abordad[oa]s?|explicad[oa]s?|trabalhad[oa]s?|estudad[oa]s?|mostrad[oa]s?) (em|na|nas) (sala|aula)|conforme (a |o |as |os )?(aula|professor|professora|slide|material de aula)|segundo (o |a )?professor|de acordo com (a |o )?(aula|professor)|em sala de aula|como vimos/;
const RE_MIDIA_REF = /(figura|imagem|foto(grafia|micrografia)?|eletrocardiograma|\becg\b|radiografia|raio-?x|tomografia|ressonancia|ultrassonografia|tabela|grafico|lamina|laudo|esquema)/;
const RE_DEITICO = /(abaixo|a seguir|seguinte|observe|analise (a|o|as|os)|veja|mostrad|apresentad|ilustrad|em anexo|anexad|ao lado|acima)/;
const RE_PCT_PERG = /%|porcent|valor|previsto|cvf|vef|espirometr|propor|taxa|frequen|prevalen|incid|risco|chance|probabil|sensibilidade|especificidade|valor preditivo|saturac|fracao|hematocrito|eficacia/;

// ---------- auditoria de UMA questão ----------
function analisarQuestao(q) {
    const pd = P.avaliarQuestao(q);
    const casoBruto = txt(q.casoClinico || ''), perg = String(txt(q.pergunta) || '').trim();
    const enun = casoBruto || txt(q.enunciadoHtml);
    const alts = (q.alternativas || []).map(a => txt(a.texto));
    const tudoBruto = [enun, perg, ...alts].join('\n');
    const iCerta = (q.alternativas || []).findIndex(a => a.correta);
    const imagens = (q.imagens || []).length + (q.imagem && !(q.imagens || []).length ? 1 : 0);
    const fortes = [], melhorar = [];
    const S = (eixo, nivel, tipo, titulo, porque, como, fonte, extra) => melhorar.push({ eixo, nivel, tipo, titulo, porque, como, fonte, ...(extra || {}) });
    const tarefa = tarefaDa(perg || enun);
    const aplicacao = pd.aplicacao;

    // ---- pontos fortes (a devolutiva começa pelo que está bom)
    if (aplicacao) fortes.push('Parte de um caso clínico (questão de aplicação).');
    if (/\?\s*$/.test(perg)) fortes.push('Pergunta direta, terminando em "?".');
    if (aplicacao && /\b\d{1,3}\s*(anos|meses|dias)\b/.test(sem(frases(casoBruto)[0]))) fortes.push('O caso começa com a idade do paciente.');
    if (txt(q.justificativa).length >= 60 || (q.imagensFeedback || []).length) fortes.push('Tem feedback explicando a resposta.');
    if (q.fonte && !(RV && RV.abnt(q.fonte).length)) fortes.push('Referência no formato ABNT.');
    if (q.objetivo && q.unidade) fortes.push('Ligada a um objetivo e a uma unidade do plano de ensino.');

    // ---- travas do padrão (já impedem finalizar/enviar)
    pd.bloqueios.forEach(b => S(1, 'obrigatorio', 'Fora do padrão', b.msg, 'Sem isso a questão não pode ser finalizada nem ir para o AVA.', 'Abra a questão (lápis) e ajuste.', F.cadam));

    // ================= EIXO 1 — integridade estrutural e AVA =================
    const fr = frases(casoBruto);
    const iPerg = fr.findIndex(f => /\?$/.test(f));
    if (iPerg >= 0 && iPerg < fr.length - 1)
        S(1, 'obrigatorio', 'Inversão de fluxo', 'A pergunta aparece no meio do caso clínico, antes do fim do texto base.',
          'O aluno lê a pergunta antes de ter todas as informações; no AVA caso e pergunta ficam embaralhados.',
          'Deixe o caso completo primeiro e a pergunta só no campo "Pergunta", no final.', F.nbme);
    else if (!casoBruto && enun.length > 200 && enun.indexOf('?') >= 0 && enun.indexOf('?') < enun.length * 0.5)
        S(1, 'ajuste', 'Inversão de fluxo', 'O enunciado começa pela pergunta e só depois traz o texto base.', 'A ordem esperada é: caso → pergunta → alternativas.', 'Mova a pergunta para o final.', F.nbme);
    if ((casoBruto.match(/(^|\s)(\(?[a-eA-E]\)|[a-eA-E]\.)\s+\S/g) || []).length >= 3)
        S(1, 'obrigatorio', 'Inversão de fluxo', 'Há alternativas digitadas dentro do caso clínico.', 'No AVA elas aparecem duas vezes (no texto e nas opções), ou antes do caso.', 'Apague as alternativas do texto do caso; elas ficam só nos campos de alternativa.', F.cadam);
    const sTodo = sem(tudoBruto);
    // a palavra que aponta ("abaixo", "a seguir", "em anexo") tem que estar colada na mídia — "valores abaixo" não conta
    const RE_REF = new RegExp(RE_MIDIA_REF.source + ".{0,35}" + RE_DEITICO.source + "|" + RE_DEITICO.source + ".{0,20}" + RE_MIDIA_REF.source + "|(rx|radiografia|tomografia|ecg|imagem)[^.:]{0,25}:s*imagem");
    if (!imagens && RE_REF.test(sTodo)) {
        const m = sTodo.match(RE_MIDIA_REF);
        S(1, 'obrigatorio', 'Mídia ausente', `O texto cita "${m[0]}" que não foi anexada à questão.`,
          'Sem a mídia a questão fica impossível de responder (ou é respondida pelo texto, e a mídia sobra).',
          'Anexe a imagem na questão (lápis → Imagem) ou retire a referência do texto.', F.cadam);
    }
    const vistos = new Set(); let dup = null;
    frases([casoBruto, perg].join(' ')).forEach(f => { const k = sem(f); if (k.length > 25) { if (vistos.has(k)) dup = dup || f; vistos.add(k); } });
    if (dup) S(1, 'obrigatorio', 'Duplicação', `Trecho repetido: "${dup.slice(0, 90)}${dup.length > 90 ? '…' : ''}".`,
        'Repetição por erro de edição confunde e aparece em dobro no AVA.', 'Apague a repetição (o caso fica no campo "Caso clínico" e a pergunta só no campo "Pergunta").', F.cadam);
    if (alts.map(sem).some((a, i, arr) => a && arr.indexOf(a) !== i))
        S(1, 'obrigatorio', 'Duplicação', 'Há duas alternativas iguais.', 'O aluno fica com menos opções reais e pode haver duas corretas.', 'Troque uma delas por outro distrator plausível.', F.cadam);

    // ================= EIXO 2 — vícios graves e pistas =================
    const banca = tudoBruto.match(RE_BANCA) || txt(q.justificativa).match(RE_BANCA);
    if (banca || RE_QUESTAO_IMPORTADA.test(tudoBruto))
        S(2, 'obrigatorio', 'Resíduo de cópia', banca ? `Marca de banca externa no texto ("${banca[0]}").` : 'Número de questão ou de prova importada no texto.',
          'Questão copiada de banca é encontrada pelo aluno em segundos e não foi feita para o objetivo da disciplina.',
          'Retire a marca e reescreva a partir do objetivo; se for adaptação, diga isso só na referência.', F.cadam);
    if (alts.some(a => /\d\s*%/.test(a)) && !RE_PCT_PERG.test(sem(perg + ' ' + enun)))
        S(2, 'ajuste', 'Resíduo de cópia', 'Alternativa com porcentagem que a pergunta não pede (ex.: "12%").',
          'Costuma ser estatística de resposta da banca de origem que ficou colada na alternativa.', 'Confira e apague o número se não fizer parte da resposta.', F.cadam);
    const comAlinea = alts.filter(a => RE_ALINEA.test(a));
    if (comAlinea.length)
        S(2, 'obrigatorio', 'Alíneas fora do padrão', comAlinea.length === alts.length ? 'As alternativas trazem letra ou número digitado no início ("a.", "1)").' : 'Parte das alternativas traz letra ou número digitado no início, misturando formatos.',
          'O AVA já coloca A, B, C, D; com a letra digitada a alternativa aparece como "A. a." ou misturada com números.',
          'Apague a letra/número do começo de cada alternativa.', F.cadam);
    const pt = RV ? RV.revisarQuestao(q, P.texto) : [];
    if (pt.length) S(2, 'ajuste', 'Português e ABNT', `${pt.length} apontamento(s) de português e ABNT.`,
        'Erros de escrita prejudicam a clareza e podem gerar recurso.', 'Na lista da prova, use "Corrigir (ver antes de aplicar)".', F.cadam,
        { exemplos: pt.slice(0, 3).map(p => p.de ? `${p.campo}: "${p.de}" → "${p.para}"` : `${p.campo}: ${p.motivo}`) });
    if (alts.length >= 2) {
        if (alts.some(a => /\b(frequentemente|geralmente|raramente|comumente|normalmente|as vezes|ocasionalmente|habitualmente|sempre|nunca)\b/.test(sem(a))))
            S(2, 'ajuste', 'Pista', 'Alternativa com termo absoluto ou de frequência ("sempre", "nunca", "geralmente").', 'O aluno experiente descarta essas alternativas sem saber o conteúdo.', 'Retire o termo e afirme com precisão.', F.nbme);
        const pal = alts.map(a => sem(a).split(/\s+/));
        let comum = 0; while (pal.every(p => p[comum] && p[comum] === pal[0][comum])) comum++;
        if (comum >= 2) S(2, 'sugestao', 'Redação', `Todas as alternativas começam igual ("${alts[0].split(/\s+/).slice(0, comum).join(' ')}…").`, 'O aluno lê a mesma coisa quatro vezes.', 'Leve o trecho repetido para a pergunta.', F.nbme);
        const nums = alts.map(a => { const m = /^\s*[<>≤≥]?\s*(\d+(?:[.,]\d+)?)/.exec(a); return m ? parseFloat(m[1].replace(',', '.')) : null; });
        if (nums.every(x => x !== null) && nums.some((x, i) => i && x < nums[i - 1]))
            S(2, 'sugestao', 'Redação', 'Alternativas numéricas fora de ordem.', 'Fora de ordem confunde e pode criar pista pela posição.', 'Coloque em ordem crescente, no mesmo formato.', F.nbme);
        const s = alts.map(sem);
        if (s.some(x => /aument/.test(x)) && s.some(x => /diminu|reduz/.test(x)) && s.some(x => /(nao (se )?alter|inalterad|sem alterac)/.test(x)))
            S(2, 'ajuste', 'Pista', 'Alternativas cobrem todas as possibilidades ("aumenta", "diminui", "não altera").', 'A resposta só pode estar nesse trio e a quarta alternativa vira descarte.', 'Pergunte de outro jeito ou use alternativas que não se completem.', F.nbme);
        if (iCerta >= 0) {
            const dupla = (a) => /\s(e|\+)\s/.test(a) || /\(/.test(a);
            if (dupla(alts[iCerta]) && alts.filter(dupla).length === 1)
                S(2, 'ajuste', 'Pista', 'Só a alternativa correta tem dois itens ou explicação entre parênteses.', 'A alternativa mais completa chama a atenção e entrega a resposta.', 'Deixe as quatro no mesmo formato.', F.nbme);
            const conj = s.map(x => new Set(x.split(/\s+/).filter(w => w.length > 3)));
            const sobre = conj.map((c, i) => conj.reduce((t, o, j) => t + (i === j ? 0 : [...c].filter(w => o.has(w)).length), 0));
            const max = Math.max(...sobre);
            if (max >= 3 && sobre[iCerta] === max && sobre.filter(v => v === max).length === 1)
                S(2, 'ajuste', 'Pista', 'A correta é a que mais repete palavras das outras (convergência).', 'O aluno acha a resposta pelo que as opções têm em comum.', 'Escreva distratores independentes, vindos de erros comuns de raciocínio.', F.nbme);
        }
    }

    // ================= EIXO 3 — psicometria e NBME =================
    const comando = sem(perg || frases(enun).slice(-1)[0] || '');
    if (/\b(exceto|incorret[ao]s?|fals[ao]s?)\b|\bnao (e|esta|sao|estao|corresponde|constitui|representa|apresenta|se aplica|faz parte|indicad)/.test(comando))
        S(3, 'obrigatorio', 'Enunciado negativo', 'Comando negativo ("NÃO", "INCORRETA", "EXCETO").',
          'O NBME contraindica: o aluno acerta achando a única falsa, sem mostrar que sabe o que é certo, e erra por desatenção.',
          `Pergunte pela alternativa correta. Ex.: "${MODELOS[tarefa]}"`, F.nbme);
    if (RE_SALA.test(sem(tudoBruto + ' ' + txt(q.justificativa))))
        S(3, 'obrigatorio', 'Vício de sala de aula', 'A resposta depende do que foi dito em aula ("conforme visto em sala").',
          'A questão deve se apoiar na literatura médica, não na fala do professor.', 'Retire a referência à aula e cite a fonte bibliográfica.', F.rs);
    if (imagens) {
        const pequenas = (q.imagens || []).filter(im => im.tamanho && im.tamanho < 12000).length;
        if (pequenas) S(3, 'ajuste', 'Qualidade da imagem', `${pequenas} imagem(ns) com arquivo muito pequeno (menos de 12 KB).`, 'Arquivo pequeno costuma ser imagem de baixa resolução, com dados ilegíveis na tela do aluno.', 'Substitua por uma versão com mais resolução e confira se lê bem no celular.', F.cadam);
    }
    if (/qual(is)? das (seguintes )?(alternativas|afirmativas|afirmacoes|assertivas|opcoes)|e correto afirmar|assinale a (alternativa )?(correta|verdadeira)|marque a (alternativa )?(correta|verdadeira)/.test(sem(perg || enun)))
        S(3, 'ajuste', 'Pergunta aberta', 'A pergunta está aberta ("qual das alternativas", "é correto afirmar").',
          'Cobrindo as alternativas, o aluno não consegue prever a resposta; vira um verdadeiro-ou-falso em quatro partes.',
          `Feche a pergunta em uma tarefa. Ex.: "${MODELOS[tarefa]}"`, F.nbme);
    if (perg && /:\s*$/.test(perg) && !/assinale|marque|analise/.test(sem(perg)))
        S(3, 'sugestao', 'Redação', 'Pergunta termina com ":" (frase para completar).', 'Favorece pistas gramaticais.', 'Escreva como pergunta direta terminando em "?".', F.nbme);
    if (aplicacao && casoBruto) {
        if (!/\b\d{1,3}\s*(anos|meses|dias)\b/.test(sem(frases(casoBruto)[0])))
            S(3, 'sugestao', 'Caso clínico', 'O caso não começa com idade e sexo.', 'A ordem padrão ajuda o raciocínio e uniformiza a prova.', 'Comece por "Homem de 45 anos…" e siga: local → queixa → duração → história → exame físico → exames.', F.nbme);
        const interp = (sem(casoBruto).match(/\b(febril|taquicardic[oa]|bradicardic[oa]|hipotens[oa]|taquipneic[oa]|hipoxemic[oa])\b/g) || []);
        if (interp.length) S(3, 'sugestao', 'Caso clínico', `Achado já interpretado no caso ("${[...new Set(interp)].join('", "')}").`, 'Dar o valor bruto deixa a interpretação para o aluno, que é o que se quer avaliar.', 'Troque pelo dado: "T 38,5 °C", "FC 118 bpm", "PA 85 x 50 mmHg".', F.bmj);
        if (/\b(pa|pressao arterial)\s*:?\s*\d{2,3}\s*[x×\/]\s*\d{2,3}(?!\s*mm)/i.test(casoBruto) || /\bfc\s*:?\s*\d{2,3}(?!\s*(bpm|batimentos))/i.test(casoBruto))
            S(3, 'sugestao', 'Caso clínico', 'Sinal vital sem unidade.', 'Número sem unidade abre margem para dúvida.', 'Use "PA 150 x 95 mmHg", "FC 118 bpm", "FR 22 irpm", "T 38,5 °C".', F.got);
    }
    const bloom = bloomDaQuestao(q, aplicacao);
    const nObj = q.objetivo ? nivelDoObjetivo(q.objetivo) : null;
    if (nObj && NIVEIS.indexOf(bloom) < NIVEIS.indexOf(nObj) - 1)
        S(3, 'ajuste', 'Bloom', `A questão (${bloom}) está abaixo do nível do objetivo (${nObj}).`, 'O objetivo pede um raciocínio que a questão não avalia.',
          nObj === 'Analisar' ? 'Use um caso com dados para interpretar (diagnóstico diferencial, achado que discrimina).' : 'Aproxime a tarefa da questão do verbo do objetivo.', F.bloom);
    const fb = sem(txt(q.justificativa));
    if (fb.length >= 30 && iCerta >= 0) {
        const citaErradas = alts.filter((a, i) => i !== iCerta).filter(a => { const w = sem(a).split(/\s+/).filter(x => x.length > 4); return w.length && w.some(x => fb.includes(x)); }).length;
        if (!citaErradas) S(3, 'sugestao', 'Feedback', 'O feedback explica só a correta.', 'O aluno aprende mais entendendo por que cada distrator está errado.', 'Acrescente uma frase sobre cada alternativa errada.', F.got);
    }
    const ano = (String(q.fonte || '').match(/\b(19|20)\d{2}\b/g) || []).map(Number).sort((a, b) => b - a)[0];
    if (ano && new Date().getFullYear() - ano > 10)
        S(3, 'sugestao', 'Referência', `Referência de ${ano}.`, 'O gabarito deve se apoiar em fonte atual.', 'Confira se há edição ou diretriz mais recente.', F.rs);

    melhorar.sort((a, b) => NIVEL[b.nivel] - NIVEL[a.nivel] || a.eixo - b.eixo);
    const pior = melhorar.length ? melhorar[0].nivel : null;
    return { fortes, melhorar, pior, bloom, nivelObjetivo: nObj, tarefa, aplicacao, imagens, ok: pd.ok,
        gabarito: iCerta >= 0 ? LETRAS[iCerta] : null, certa: iCerta >= 0 ? alts[iCerta] : '',
        objetivo: q.objetivo || '', unidade: q.unidade || null,
        situacao: pior === 'obrigatorio' ? 'Corrigir' : pior === 'ajuste' ? 'Ajustar' : 'Aprovada' };
}

// ---------- auditoria da PROVA ----------
function analisarProva(questoes, analise) {
    const itens = questoes.map(analisarQuestao);
    const n = questoes.length;
    const pct = (x) => (n ? Math.round(100 * x / n) : 0);
    const letras = {}; itens.forEach(i => { if (i.gabarito) letras[i.gabarito] = (letras[i.gabarito] || 0) + 1; });
    const bloom = {}; itens.forEach(i => { bloom[i.bloom] = (bloom[i.bloom] || 0) + 1; });
    const caso = itens.filter(i => i.aplicacao).length;
    const minutos = itens.reduce((s, i) => s + (i.aplicacao ? 5 : 3), 0) + (n ? 15 : 0);
    const geral = []; // inconformidades da prova inteira
    const G = (eixo, nivel, tipo, titulo, como) => geral.push({ eixo, nivel, tipo, titulo, como });

    // EIXO 4 — matriz e distribuição temática (tema = objetivo do plano de ensino)
    const porObjetivo = {}; itens.forEach((i, k) => { const t = i.objetivo || '(sem objetivo)'; (porObjetivo[t] = porObjetivo[t] || []).push(k + 1); });
    const porUnidade = {}; itens.forEach(i => { const t = i.unidade ? 'Unidade ' + i.unidade : '(sem unidade)'; porUnidade[t] = (porUnidade[t] || 0) + 1; });
    const temas = Object.entries(porObjetivo).map(([tema, qs]) => ({ tema, qtd: qs.length, questoes: qs, pct: pct(qs.length) })).sort((a, b) => b.qtd - a.qtd);
    const semObjetivo = analise && analise.objetivos ? analise.objetivos.filter(o => !o.qtd).map(o => o.objetivo) : [];
    const nObjPlano = analise && analise.objetivos ? analise.objetivos.length : temas.length;
    const limite = Math.max(4, Math.ceil(n * 0.25));
    temas.filter(t => t.qtd > limite && nObjPlano > 1).forEach(t => { t.alerta = true;
        G(4, 'ajuste', 'Hiperconcentração', `${t.qtd} de ${n} questões (${t.pct}%) no mesmo objetivo: "${t.tema.slice(0, 110)}${t.tema.length > 110 ? '…' : ''}".`, 'Redistribua: cerca de 1/4 da prova por objetivo, no máximo, e pelo menos 1 questão para cada objetivo do bimestre.'); });
    if (semObjetivo.length) G(4, 'ajuste', 'Lacuna da matriz', `${semObjetivo.length} objetivo(s) do bimestre sem nenhuma questão.`, 'Inclua ao menos 1 questão (idealmente 2) para cada objetivo sem questão.');
    const porDesfecho = {};
    itens.forEach((i, k) => { const d = sem(i.certa).replace(/[^a-z0-9 ]/g, '').trim(); if (d.length >= 4) (porDesfecho[d] = porDesfecho[d] || { texto: i.certa, questoes: [] }).questoes.push(k + 1); });
    const redundancias = Object.values(porDesfecho).filter(d => d.questoes.length > 1);
    redundancias.forEach(d => G(4, 'ajuste', 'Redundância de desfecho', `As questões ${d.questoes.join(', ')} têm a mesma resposta correta ("${d.texto.slice(0, 70)}").`, 'Confira se cobram o mesmo desfecho; se sim, troque uma por outro tema da matriz.'));
    // posição da correta (A, B, C, D) não é avaliada: no AVA o Safe Exam Browser embaralha questões e alternativas por aluno (17/11/2026)
    // caso clínico × conhecimento NÃO é cobrado: os primeiros períodos são conteúdo de base, sem caso clínico (17/11/2026)

    // parecer
    const comObrig = itens.filter(i => i.pior === 'obrigatorio').length;
    const comAjuste = itens.filter(i => i.pior === 'ajuste').length;
    const travadas = itens.filter(i => !i.ok).length;
    let parecer = 'Apta';
    if (travadas || comObrig > Math.max(2, n * 0.2)) parecer = 'Inapta';
    else if (comObrig || comAjuste || geral.some(g => g.nivel !== 'sugestao')) parecer = 'Requer ajustes';
    // tabela sinóptica (obrigatórios e ajustes; sugestões ficam só na devolutiva de cada questão)
    const tabela = [];
    geral.filter(g => g.nivel !== 'sugestao').forEach(g => tabela.push({ questao: null, ...g }));
    itens.forEach((it, k) => it.melhorar.filter(m => m.nivel !== 'sugestao').forEach(m => tabela.push({ questao: k + 1, ...m })));
    tabela.sort((a, b) => NIVEL[b.nivel] - NIVEL[a.nivel] || (a.questao || 0) - (b.questao || 0));
    // recomendações prioritárias: agrupadas por tipo de falha, com as questões
    const grupos = {};
    itens.forEach((it, k) => it.melhorar.forEach(m => {
        const g = grupos[m.tipo] = grupos[m.tipo] || { tipo: m.tipo, nivel: m.nivel, como: m.como, questoes: [] };
        if (NIVEL[m.nivel] > NIVEL[g.nivel]) { g.nivel = m.nivel; g.como = m.como; }
        if (!g.questoes.includes(k + 1)) g.questoes.push(k + 1);
    }));
    geral.forEach(g => { if (!grupos['P:' + g.tipo]) grupos['P:' + g.tipo] = { tipo: g.tipo, nivel: g.nivel, como: g.como, questoes: [], prova: true }; });
    const prioridades = Object.values(grupos).filter(g => g.nivel !== 'sugestao').sort((a, b) => NIVEL[b.nivel] - NIVEL[a.nivel] || b.questoes.length - a.questoes.length);
    const conferenciaVisual = itens.map((it, k) => (it.imagens ? k + 1 : null)).filter(Boolean);
    return { itens, total: n, caso, pctCaso: pct(caso), letras, bloom, minutos, temas, porUnidade, semObjetivo, redundancias, geral, tabela, prioridades,
        conferenciaVisual, parecer, comObrig, comAjuste, travadas, aprovadas: itens.filter(i => i.situacao === 'Aprovada').length };
}

return { analisarQuestao, analisarProva, bloomDaQuestao, nivelDoObjetivo, MODELOS, EIXOS };
}));
