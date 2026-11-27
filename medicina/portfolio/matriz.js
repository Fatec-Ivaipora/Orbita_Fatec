// Portfólio Reflexivo — Medicina / SCIC (23/11/2026)
// MATRIZ DE AVALIAÇÃO DO PORTFÓLIO — fonte ÚNICA, usada pelo servidor (src/rotas/portfolio-med.js) e pela tela
// (medicina/portfolio/app.js). Transcrita dos "Prompt_Correcao_Portfolio_{2,4,5}o_Periodo.docx" (Parte 1 — bloco fixo,
// igual nos três períodos). NÃO alterar descritor, nível ou ponto sem documento novo da coordenação de Medicina:
// é isso que garante o mesmo critério para todos os professores.
//
// Quem decide a nota é o professor; o sistema só CALCULA a partir do que ele marcou:
//   C1 e C4 → o professor escolhe o nível;
//   C2      → o professor marca os 3 elementos (análise, necessidades, ações) e o nível sai deles;
//   C3      → o professor marca os objetivos da turma atingidos e o nível sai da proporção;
//   nota    → soma estrita dos 4 critérios (sem média, sem arredondar pra cima);
//   atraso/plágio → só se o professor marcar (a regra nunca é aplicada sozinha).
(function (raiz) {
  'use strict';

  const VERSAO = 'SCIC-2026.2';

  const NIVEIS = ['O', 'B', 'DM', 'I'];
  const NOME_NIVEL = { O: 'Ótimo', B: 'Bom', DM: 'Deve melhorar', I: 'Insuficiente' };

  const CRITERIOS = [
    {
      id: 'c1', num: 1, nome: 'Descrição do confronto experimental', max: 3,
      avalia: 'A qualidade da descrição das experiências vividas pelo estudante, verificando se ele apenas relata fatos ou se constrói uma descrição contextualizada e reflexiva.',
      niveis: {
        O: { pts: 3, descritor: 'Descrição rica, contextualizada e reflexiva.', aplicar: 'O texto descreve a experiência com riqueza de detalhes, situa a experiência em um contexto (cenário, população, condições, relação com o conteúdo da disciplina) e produz reflexão sobre o vivido.' },
        B: { pts: 1.5, descritor: 'Descrição reflexiva com alguma reflexão, superficial.', aplicar: 'Há descrição com reflexão presente, porém superficial — a reflexão existe, mas não aprofunda, não contextualiza ou fica no plano genérico.' },
        DM: { pts: 0, descritor: 'Descrição pura dos fatos sem visão reflexiva.', aplicar: 'O texto apenas narra o que aconteceu, em formato de relatório de atividades, sem qualquer elaboração reflexiva sobre a experiência.' },
        I: { pts: 0, descritor: 'Não apresenta ou descrição confusa/incompleta.', aplicar: 'Não há descrição de experiência, ou a descrição é confusa, desorganizada ou incompleta a ponto de não permitir compreender o vivido.' }
      }
    },
    {
      id: 'c2', num: 2, nome: 'Análise de situações vivenciadas', max: 3,
      avalia: 'A capacidade de analisar criticamente as situações vividas, identificando necessidades e propondo ações. Três elementos verificáveis: (a) análise crítica consistente, (b) identificação de necessidades, (c) proposta de ações. A ausência de (b) ou de (c) rebaixa o nível.',
      niveis: {
        O: { pts: 3, descritor: 'Análise crítica consistente, identificando necessidades e propondo ações.', aplicar: 'Os três elementos estão presentes: análise crítica consistente + identificação de necessidades + proposta de ações.' },
        B: { pts: 1.5, descritor: 'Análise crítica consistente, sem identificação de necessidades ou sem proposta de ações.', aplicar: 'A análise crítica é consistente, mas falta a identificação de necessidades OU falta a proposta de ações. Basta a ausência de um dos dois.' },
        DM: { pts: 0, descritor: 'Análise crítica superficial sem identificação de necessidades e sem proposta de ações.', aplicar: 'A análise é superficial E faltam tanto a identificação de necessidades quanto a proposta de ações.' },
        I: { pts: 0, descritor: 'Ausência de análise ou incoerências graves.', aplicar: 'Não há análise, ou o texto apresenta incoerências graves que comprometem o raciocínio.' }
      }
    },
    {
      id: 'c3', num: 3, nome: 'Desenvolvimento de objetivos e/ou tarefas', max: 2,
      avalia: 'Se o estudante menciona, discute e atinge os objetivos propostos para o portfólio — EXCLUSIVAMENTE os objetivos específicos desta turma.',
      niveis: {
        O: { pts: 2, descritor: 'Menciona, discute e atinge 90% ou + dos objetivos.', aplicar: '90% ou mais dos objetivos foram mencionados, discutidos e atingidos.' },
        B: { pts: 1, descritor: 'Menciona, discute e atinge 75% ou + dos objetivos.', aplicar: '75% ou mais (e menos de 90%) dos objetivos foram mencionados, discutidos e atingidos.' },
        DM: { pts: 0, descritor: 'Menciona, discute e atinge até 50% dos objetivos.', aplicar: 'Até 50% dos objetivos foram mencionados, discutidos e atingidos.' },
        I: { pts: 0, descritor: 'Não menciona, discute ou atinge objetivos.', aplicar: 'Os objetivos não são mencionados, não são discutidos ou não são atingidos.' }
      }
    },
    {
      id: 'c4', num: 4, nome: 'Organização e clareza na escrita', max: 2,
      avalia: 'Coesão textual, coerência, estruturação do texto e correção gramatical (erros gramaticais contam na avaliação).',
      verificar: 'Coesão entre parágrafos e seções, coerência da linha de raciocínio, estruturação (introdução, desenvolvimento, fechamento), pontuação, concordância verbal e nominal, regência, ortografia, uso de primeira pessoa adequado ao gênero portfólio e legibilidade geral.',
      niveis: {
        O: { pts: 2, descritor: 'Texto claro, coeso, bem estruturado e sem erros gramaticais.', aplicar: 'O texto é claro, coeso, bem estruturado E não apresenta erros gramaticais.' },
        B: { pts: 1, descritor: 'Texto claro, coeso e/ou com poucos erros gramaticais.', aplicar: 'O texto é claro e coeso, ainda que apresente poucos erros gramaticais.' },
        DM: { pts: 0, descritor: 'Texto com pouca coerência e/ou vários erros gramaticais.', aplicar: 'Há pouca coerência textual E/OU vários erros gramaticais.' },
        I: { pts: 0, descritor: 'Erros que afetam a capacidade de compreensão/leitura do texto ou não apresentado.', aplicar: 'Os erros comprometem a compreensão do texto, ou o texto não foi apresentado.' }
      }
    }
  ];
  const POR_ID = {};
  CRITERIOS.forEach(c => { POR_ID[c.id] = c; });

  // Orientações da disciplina — CONTEXTO, não critério: falhas aqui vão como observação, sem mexer na nota.
  const ITENS_CAPA = ['Logo da instituição', 'Nome do estudante', 'Curso e turma', 'Unidade básica de saúde', 'Nome do preceptor', 'Nome do facilitador'];

  // Condições especiais — o professor decide; o sistema só aplica o que ele marcar.
  const PENALIDADES = {
    nenhuma: { rotulo: 'Nenhuma', fator: 1 },
    atraso: { rotulo: 'Entrega em atraso (até 48h) — 50% da nota', fator: 0.5 },
    plagio_nova_versao: { rotulo: 'Plágio: nova versão em 24h — 50% da nota', fator: 0.5 },
    plagio_zerar: { rotulo: 'Plágio: nota zerada', fator: 0 }
  };

  const NOTA_C2 = 'Combinação não prevista literalmente na matriz — nível escolhido pelo professor.';
  const NOTA_C3_FAIXA = 'Faixa entre 50% e 75% não prevista na matriz; atribuído BOM por aproximação ao nível superior imediato — decisão sujeita a revisão do professor.';

  // C2: o nível sai dos 3 elementos. analise: 'consistente' | 'superficial' | 'ausente' (ausência ou incoerência grave)
  function nivelC2(c2) {
    const a = c2 && c2.analise;
    const nec = !!(c2 && c2.necessidades);
    const aco = !!(c2 && c2.acoes);
    if (!a) return { nivel: null };
    if (a === 'ausente') return { nivel: 'I' };
    if (a === 'consistente' && nec && aco) return { nivel: 'O' };
    if (a === 'consistente' && (nec !== aco)) return { nivel: 'B' };
    if (a === 'superficial' && !nec && !aco) return { nivel: 'DM' };
    // consistente sem os dois, ou superficial com algum deles: a matriz não diz — o professor escolhe e justifica
    const manual = NIVEIS.includes(c2.nivelManual) ? c2.nivelManual : null;
    return { nivel: manual, manual: true, nota: NOTA_C2 };
  }

  // O QUE COBRAR (27/11/2026, pedido do prof. João Felipe): a coordenação escolhe, por atividade, quais critérios e quais
  // objetivos do C3 são cobrados. cobrar = { criterios: ['c1',…], objetivos: [índices] } (ausente = tudo). Critério não
  // cobrado sai da conta e o valor dele é distribuído entre os demais, na proporção do máximo de cada um (a nota continua
  // de 0 a 10); objetivo não cobrado sai do C3 (a proporção conta só os cobrados). Com tudo marcado, nada muda.
  function normCobrar(cobrar, totalObjetivos) {
    const ids = CRITERIOS.map(c => c.id);
    const crit = cobrar && Array.isArray(cobrar.criterios) && cobrar.criterios.some(id => ids.includes(id)) ? ids.filter(id => cobrar.criterios.includes(id)) : ids;
    const obj = cobrar && Array.isArray(cobrar.objetivos)
      ? [...new Set(cobrar.objetivos.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < (totalObjetivos || 0)))].sort((a, b) => a - b) : null;
    return { criterios: crit, objetivos: obj && obj.length && obj.length < (totalObjetivos || 0) ? obj : null };
  }

  // C3: proporção de objetivos da turma mencionados, discutidos e atingidos (só os cobrados, se a coordenação escolheu)
  function nivelC3(c3, totalObjetivos, objCobrados) {
    const todos = Array.isArray(c3 && c3.objetivos) ? c3.objetivos.slice(0, totalObjetivos) : [];
    const marc = objCobrados ? objCobrados.map(i => !!todos[i]) : todos;
    const n = marc.filter(Boolean).length;
    const total = objCobrados ? objCobrados.length : (totalObjetivos || 0);
    if (!total) return { nivel: null, n, total, pct: 0 };
    const pct = n / total;
    if (n === 0) return { nivel: 'I', n, total, pct };
    if (pct >= 0.9) return { nivel: 'O', n, total, pct };
    if (pct >= 0.75) return { nivel: 'B', n, total, pct };
    if (pct > 0.5) return { nivel: 'B', n, total, pct, nota: NOTA_C3_FAIXA };
    return { nivel: 'DM', n, total, pct };
  }

  const arred2 = (x) => Math.round(x * 100) / 100;
  const NOTA_MAX_ = 10;

  // Calcula tudo a partir do que o professor marcou. Não decide nada sozinho.
  function calcular(av, totalObjetivos, cobrar) {
    av = av || {};
    const cob = normCobrar(cobrar, totalObjetivos);
    const maxCobrado = CRITERIOS.filter(c => cob.criterios.includes(c.id)).reduce((a, c) => a + c.max, 0);
    const k = maxCobrado ? NOTA_MAX_ / maxCobrado : 1; // redistribui o valor dos critérios não cobrados
    const r = { criterios: {}, completo: true, faltando: [], cobrar: cob, redistribuido: k !== 1 };
    let soma = 0;
    CRITERIOS.forEach(c => {
      const dado = av[c.id] || {};
      if (!cob.criterios.includes(c.id)) { r.criterios[c.id] = { nivel: null, pts: 0, max: 0, naoCobrado: true, justificativa: '' }; return; }
      let info;
      if (c.id === 'c2') info = nivelC2(dado);
      else if (c.id === 'c3') info = nivelC3(dado, totalObjetivos, cob.objetivos);
      else info = { nivel: NIVEIS.includes(dado.nivel) ? dado.nivel : null };
      const pts = info.nivel ? arred2(c.niveis[info.nivel].pts * k) : 0;
      const just = String(dado.justificativa || '').trim();
      r.criterios[c.id] = { ...info, pts, max: arred2(c.max * k), justificativa: just };
      if (!info.nivel) { r.completo = false; r.faltando.push(`Critério ${c.num}: nível não definido`); }
      if (!just) { r.completo = false; r.faltando.push(`Critério ${c.num}: falta a evidência/justificativa`); }
      soma += pts;
    });
    r.soma = arred2(soma);
    const pen = PENALIDADES[av.penalidade] ? av.penalidade : 'nenhuma';
    r.penalidade = pen;
    r.fator = PENALIDADES[pen].fator;
    r.nota = arred2(soma * r.fator);
    return r;
  }

  const fmt = (x) => (x == null ? '—' : Number(x).toFixed(1).replace('.', ','));

  // nota de corte já gravada, recalculada com o que a coordenação escolheu cobrar (níveis e objetivos guardados nela)
  function notaDaReferencia(ref, totalObjetivos, cobrar) {
    if (!ref || ref.semTexto || ref.nota == null || !ref.niveis) return null;
    const av = {
      c1: { nivel: ref.niveis.c1, justificativa: '-' },
      c2: { analise: 'consistente', necessidades: false, acoes: false, nivelManual: ref.niveis.c2, justificativa: '-' }, // usa o nível já decidido
      c3: { objetivos: (ref.c3 && ref.c3.objetivos) || [], justificativa: '-' },
      c4: { nivel: ref.niveis.c4, justificativa: '-' }
    };
    return calcular(av, totalObjetivos, cobrar);
  }
  const M = { VERSAO, NIVEIS, NOME_NIVEL, CRITERIOS, POR_ID, ITENS_CAPA, PENALIDADES, NOTA_C2, NOTA_C3_FAIXA, nivelC2, nivelC3, calcular, normCobrar, notaDaReferencia, fmt, NOTA_MAX: 10 };
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else raiz.PortfolioMatriz = M;
})(typeof window !== 'undefined' ? window : this);
