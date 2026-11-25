// OSCE da Medicina (25/11/2026) — conferência da estação e cálculo da nota. SEM IA: só regras, baseadas nos guias
// da AMEE (Guide 81: como montar a OSCE; Guide 49: qualidade da OSCE). A conferência NÃO diz "está bom/ruim":
// mostra o que a estação já tem e o que pode melhorar, POR QUÊ e COMO (sugestão). Quem decide é o professor.
// Compartilhado entre o servidor (require) e a tela (window.OsceConferencia).
(function (raiz, fabrica) {
    if (typeof module === 'object' && module.exports) module.exports = fabrica();
    else raiz.OsceConferencia = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => String(r2(v)).replace('.', ',');
const VAGO = /\b(de\s+(forma|maneira|modo)\s+(correta|adequada|satisfatoria|apropriada|eficaz|eficiente)|corretamente|adequadamente|satisfatoriamente|de forma correta|bem feit[oa])\b/;
const IDENTIFICACAO = /\b(nome|numero|apresent\w*|identific\w*)\b/;
const PARADA = new Set(['para', 'como', 'com', 'sem', 'que', 'uma', 'umas', 'uns', 'dos', 'das', 'nos', 'nas', 'pelo', 'pela', 'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'isso', 'aluno', 'aluna', 'examinador', 'avaliador', 'forma', 'correta', 'correto', 'voce', 'deve', 'devera', 'sobre', 'entre', 'mostre', 'execute', 'faca', 'realize', 'informe', 'diga']);
const palavrasChave = (s) => semAcento(s).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length > 3 && !PARADA.has(w)).map(w => w.replace(/s$/, ''));

const pesoDe = (it) => (Number(it && it.peso) > 0 ? Number(it.peso) : 1);
const temParcial = (it) => it && it.semParcial !== true;

// nota da estação: cada item vale "peso"; fez = 1, parcial = 0,5, não fez = 0. Escala para o valor da estação.
// marcas[i] = 1 | 0.5 | 0 | null (não marcado)
function calcular(estacao, marcas, valor) {
    const itens = (estacao && estacao.itens) || [];
    const max = itens.reduce((s, it) => s + pesoDe(it), 0);
    let obtido = 0, marcados = 0;
    itens.forEach((it, i) => {
        const m = marcas ? marcas[i] : null;
        if (m === null || m === undefined || m === '') return;
        marcados++;
        const v = Number(m) === 0.5 && temParcial(it) ? 0.5 : (Number(m) >= 1 ? 1 : 0);
        obtido += v * pesoDe(it);
    });
    const v = Number(valor) > 0 ? Number(valor) : max;
    return { obtido: r2(obtido), max: r2(max), marcados, completo: marcados === itens.length && itens.length > 0, pontos: max ? r2(v * obtido / max) : 0, valor: r2(v) };
}

// conferência da estação → { fortes: [texto], sugestoes: [{ campo, nivel, oque, porque, como }], portugues: [...] }
// nivel: 'importante' (falta algo que atrapalha a correção) | 'sugestao' (melhora a qualidade)
function conferir(e, RevisaoPt) {
    const fortes = [], sug = [];
    const add = (campo, nivel, oque, porque, como) => sug.push({ campo, nivel, oque, porque, como });
    const itens = (e.itens || []).filter(it => String(it.texto || '').trim());
    const tarefas = (e.tarefas || []).map(t => String(t || '').trim()).filter(Boolean);
    const criticos = (e.criticos || []).map(t => String(t || '').trim()).filter(Boolean);
    const cenario = String(e.cenario || '').trim();
    const totalPeso = itens.reduce((s, it) => s + pesoDe(it), 0) || 1;

    // objetivo e dados da estação
    if (e.objetivo) fortes.push('Está ligada a um objetivo do plano de ensino da disciplina.');
    else add('Objetivo', 'importante', 'A estação não está ligada a um objetivo do plano de ensino.',
        'Assim a coordenação vê se as estações da OSCE cobrem o que foi ensinado, sem repetir nem deixar algo de fora.',
        'Escolha na lista o objetivo do plano de ensino que esta estação avalia.');
    if (!(Number(e.tempoMin) > 0)) add('Tempo', 'importante', 'O tempo da estação não está informado.',
        'Todas as estações precisam do mesmo ritmo; o avaliador avisa quando falta 1 minuto e o aluno troca de sala no mesmo momento.',
        'Informe o tempo em minutos (em geral, de 5 a 10).');

    // cenário e tarefas (o que o aluno lê na porta)
    if (!cenario) add('Cenário', 'importante', 'A estação não tem cenário para o aluno.',
        'Sem o contexto, o aluno não sabe o que se espera dele e perde tempo perguntando.',
        'Escreva em 2 ou 3 frases: onde ele está, quem é o paciente e o que precisa fazer.');
    else if (cenario.length < 90) add('Cenário', 'sugestao', 'O cenário está curto.',
        'O aluno precisa saber onde está, quem é o paciente e por que vai fazer o procedimento — isso muda a conduta.',
        'Acrescente o dado que justifica a tarefa. Ex.: "Na laringoscopia você vê só a epiglote (via aérea difícil)".');
    if (!tarefas.length) add('Tarefas', 'importante', 'Não há tarefas para o aluno.',
        'É pela lista de tarefas que o aluno sabe o que vai ser avaliado.',
        'Liste as tarefas, uma por linha, na ordem em que ele deve fazer.');
    if (cenario && tarefas.length) fortes.push('Cenário e tarefas do aluno estão separados do gabarito.');

    // checklist
    if (!itens.length) add('Checklist', 'importante', 'A estação não tem itens no checklist.',
        'Sem itens, cada avaliador corrige do seu jeito.',
        'Escreva os passos que o avaliador deve ver, um por item.');
    else if (itens.length < 5) add('Checklist', 'sugestao', `O checklist tem ${itens.length} itens: cada um vale cerca de ${Math.round(100 / itens.length)}% da estação.`,
        'Com poucos itens, um único deslize muda muito a nota, e itens grandes viram "tudo ou nada".',
        'Divida os passos maiores em passos menores que dá para ver (de 8 a 15 itens costuma funcionar bem).');
    else if (itens.length > 20) add('Checklist', 'sugestao', `O checklist tem ${itens.length} itens.`,
        'Com muitos itens o avaliador não consegue marcar tudo no tempo da estação e passa a marcar "de memória".',
        'Junte os passos muito pequenos ou tire o que não é essencial para a habilidade.');
    else fortes.push(`Quantidade de itens boa para marcar no tempo (${itens.length}).`);

    itens.forEach((it, i) => {
        const n = i + 1, t = String(it.texto).trim(), ts = semAcento(t);
        if (VAGO.test(ts)) add(`Item ${n}`, 'importante', `"${t}" não diz o que o avaliador deve ver.`,
            'Cada avaliador entende "de forma correta" de um jeito; aí a nota passa a depender de quem avalia, e não do que o aluno fez.',
            'Troque por passos que dá para ver: o que o aluno faz, com o quê e em que ordem. Se for preciso, divida em mais itens.');
        else if (t.length > 120 && ((t.match(/,| e /g) || []).length >= 2)) add(`Item ${n}`, 'sugestao', 'O item parece juntar mais de uma ação.',
            'Se o aluno faz só uma parte, o avaliador fica em dúvida entre "fez" e "parcial".',
            'Separe em itens, uma ação por item.');
        if (temParcial(it) && !String(it.parcial || '').trim()) add(`Item ${n}`, 'sugestao', 'O "parcial" não diz quando vale.',
            'Sem critério, um avaliador dá 0,5 e outro dá 1,0 para a mesma execução.',
            'Escreva quando é parcial (ex.: "esquece 1 material") ou marque que este item não tem parcial.');
        if (IDENTIFICACAO.test(ts) && pesoDe(it) / totalPeso >= 0.15) add(`Item ${n}`, 'sugestao', `Apresentar-se/identificar-se vale ${Math.round(100 * pesoDe(it) / totalPeso)}% da estação.`,
            'Dizer o nome não mostra a habilidade que a estação avalia; pesa igual a um passo técnico.',
            'Dê peso menor a este item ou junte com "fala o que está fazendo" (comunicação).');
    });
    if (itens.length && itens.every(it => !temParcial(it) || String(it.parcial || '').trim())) fortes.push('Todos os itens dizem quando vale "parcial".');

    // tarefas x itens: o que o aluno lê tem que estar no checklist
    tarefas.forEach((tf) => {
        const ch = palavrasChave(tf);
        if (!ch.length) return;
        const coberta = itens.some(it => { const ci = new Set(palavrasChave(it.texto)); return ch.filter(w => ci.has(w)).length >= Math.min(2, ch.length); });
        if (!coberta) add('Tarefas', 'sugestao', `A tarefa "${tf}" não aparece no checklist.`,
            'O aluno faz a tarefa e não ganha ponto por ela — ou o avaliador cobra algo que o aluno não sabia que seria avaliado.',
            'Inclua um item para esta tarefa ou ajuste o texto da tarefa.');
    });

    // segurança, impressão geral e papel do avaliador
    if (criticos.length) fortes.push(`Tem ${criticos.length} erro(s) crítico(s) definido(s).`);
    else add('Erros críticos', 'sugestao', 'A estação não tem erro crítico.',
        'Sem ele, o aluno pode fazer algo perigoso para o paciente e ainda tirar nota alta somando os outros itens.',
        'Liste o que não pode acontecer (ex.: "apoiou a lâmina nos dentes", "não confirmou a posição do tubo").');
    if (e.escalaGlobal === false) add('Impressão geral', 'sugestao', 'A estação está sem a impressão geral do avaliador.',
        'O checklist mostra se o aluno fez os passos; a impressão geral pega segurança e organização. Ela também ajuda a coordenação a achar a nota de corte (método do aluno limítrofe).',
        'Deixe ligada a impressão geral (insuficiente → excelente).');
    else fortes.push('Tem a impressão geral do avaliador (insuficiente → excelente).');
    if (!String(e.papelAvaliador || '').trim()) add('Avaliador', 'sugestao', 'O papel do avaliador na estação não está escrito.',
        'Se um avaliador ajuda o aluno e outro não, a prova fica desigual.',
        'Escreva o que o avaliador faz e o que não faz (ex.: "entrega o tubo quando o aluno pedir; não dá dicas").');
    if (!String(e.gabarito || '').trim()) add('Gabarito', 'sugestao', 'A estação não tem gabarito da técnica.',
        'O gabarito ajuda o avaliador a decidir entre "fez" e "parcial" do mesmo jeito que os outros.',
        'Descreva como é o procedimento certo, passo a passo.');
    if (!(e.materiais || []).filter(Boolean).length) add('Materiais', 'sugestao', 'A lista de materiais da sala não está preenchida.',
        'Quem monta a sala precisa saber o que deixar, e todas as salas ficam iguais.',
        'Liste os materiais (um por linha).');

    // português (mesmo revisor do Banco MED)
    const portugues = [];
    if (RevisaoPt && RevisaoPt.achar) {
        const campo = (nome, t) => { if (String(t || '').trim()) RevisaoPt.achar(String(t)).forEach(a => portugues.push({ campo: nome, ...a })); };
        campo('Tema', e.tema); campo('Cenário', cenario);
        tarefas.forEach((t, i) => campo(`Tarefa ${i + 1}`, t));
        itens.forEach((it, i) => { campo(`Item ${i + 1}`, it.texto); campo(`Item ${i + 1} (parcial)`, it.parcial); });
        criticos.forEach((t, i) => campo(`Erro crítico ${i + 1}`, t));
        campo('Papel do avaliador', e.papelAvaliador); campo('Gabarito', e.gabarito);
    }
    const ordem = { importante: 0, sugestao: 1 };
    sug.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
    return { fortes, sugestoes: sug, portugues, importantes: sug.filter(s => s.nivel === 'importante').length };
}

return { calcular, conferir, pesoDe, temParcial, fmt, r2 };
}));
