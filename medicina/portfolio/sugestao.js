// Portfólio Reflexivo — SUGESTÃO AUTOMÁTICA da correção (26/11/2026)
// Lê o texto do portfólio e PRÉ-MARCA a matriz (medicina/portfolio/matriz.js) com o trecho que justifica cada
// marcação. É só sugestão: o professor confere, muda o que quiser e finaliza — "quem decide a nota é o professor".
// Sem IA e sem serviço externo (LGPD): regras fixas sobre palavras e frases do próprio texto, rodando no navegador.
//
//   C1 (descrição)   → contexto do cenário (UBS, território, equipe, paciente…) + reflexão em 1ª pessoa
//                      ("percebi", "aprendi", "me fez refletir"…) + tamanho do texto;
//   C2 (análise)     → (a) conectivos de análise ("porque", "no entanto", "determinantes"…), (b) necessidades
//                      ("falta de", "dificuldade", "necessidade"…), (c) ações ("proponho", "seria importante"…);
//   C3 (objetivos)   → cada objetivo da turma: as palavras-chave dele aparecem no texto? (metade ou mais);
//   C4 (escrita)     → estrutura (parágrafos, introdução/conclusão), frases longas demais e erros comuns.
// Onde a regra não enxerga (gramática fina, profundidade da reflexão), a justificativa diz "confira".
(function (raiz) {
  const VERSAO = 'sugestao-1';

  const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // frases com a página de onde vieram ([[p.N]] marca a página no texto extraído)
  function frasesDo(texto) {
    const out = [];
    let pag = 1;
    String(texto || '').split(/(\[\[p\.\d+\]\])/).forEach(parte => {
      const m = /^\[\[p\.(\d+)\]\]$/.exec(parte);
      if (m) { pag = Number(m[1]); return; }
      parte.replace(/\s+/g, ' ').split(/(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ"“(])/).forEach(f => {
        const t = f.trim();
        if (t.split(' ').length >= 4) out.push({ texto: t, pag, norm: semAcento(t) });
      });
    });
    return out;
  }

  const RE = {
    reflexao: /\b(percebi|perceber|senti|sentir|me senti|aprendi|aprender com|refleti|reflexao|me fez|me faz|fez-me|compreendi|entendi|reconheco|acredito|considero|minha percepcao|para mim|me marcou|me sensibilizou|me impactou|impactou|notei|me surpreendeu|fiquei|me chamou a atencao|chamou minha atencao|vivencia|vivenciar|experiencia)\b/,
    contexto: /\b(ubs|usf|unidade basica|unidade de saude|territorio|comunidade|populacao|paciente|usuario|familia|equipe|acs|agente comunitari|visita domiciliar|preceptor|sus|esf|estrategia saude da familia|acolhimento|consulta|bairro|microarea)\b/,
    analise: /\b(porque|pois|portanto|devido|consequencia|consequentemente|reflete|evidencia|demonstra|contradi|no entanto|entretanto|contudo|por outro lado|considerando|determinantes sociais|vulnerabilidade|desigualdade|impacto|causa|relacao entre|em contrapartida|logo)\b/,
    necessidade: /\b(necessidade|necessario|necessaria|precisa|precisam|precisaria|falta de|faltam|carencia|dificuldade|dificuldades|demanda|problema|problemas|deficiencia|lacuna|barreira|fragilidade|insuficiente|sobrecarga)\b/,
    acao: /\b(proponho|propomos|propor|proposta|sugiro|sugerimos|sugestao|poderia|poderiam|deveria|deveriam|seria importante|seria interessante|seria necessario|intervencao|estrategia|plano de acao|acao educativa|acoes educativas|implementar|implementacao|criar um|criar uma|realizar uma|realizar um|capacitacao|roda de conversa|grupo de|campanha)\b/,
    estrutura: /\b(introducao|conclusao|consideracoes finais|referencias|desenvolvimento|objetivo deste|neste portfolio|este portfolio)\b/
  };
  // erros comuns que dá para ver sem corretor (sinal fraco: só aponta para o professor conferir)
  const ERROS = [
    [/\ba nivel de\b/, '"a nível de"'], [/\bmais sem\b/, '"mais sem" (mas)'], [/\bhaviam\s+(muitos|muitas|varios|varias|pessoas|pacientes)\b/, '"haviam" no sentido de existir'],
    [/\bconcerteza\b/, '"concerteza"'], [/\bderrepente\b/, '"derrepente"'], [/\bfazem\s+\d+\s+(anos|dias|meses)\b/, '"fazem X anos"'],
    [/\bmenas\b/, '"menas"'], [/\bseje\b/, '"seje"'], [/\bpra mim fazer\b/, '"pra mim fazer"'], [/\bao inves de\b.*\bao inves de\b/, 'repetição de "ao invés de"'],
    [/\s,|,,|\.\./, 'pontuação duplicada ou espaço antes da vírgula'], [/\bvc\b|\bpq\b|\btb\b|\btbm\b/, 'abreviação informal (vc, pq, tb)']
  ];

  const trecho = (f, max = 220) => `p. ${f.pag}: "${f.texto.length > max ? f.texto.slice(0, max).replace(/\s+\S*$/, '') + '…' : f.texto}"`;
  const comRe = (frases, re) => frases.filter(f => re.test(f.norm));

  // palavras que não distinguem um objetivo do outro
  const PARADAS = new Set(('compreender entender identificar reconhecer descrever analisar discutir conhecer dominar integrar promover incluindo inclusive ' +
    'atraves sobre entre como para pela pelo pelas pelos dentro junto importancia conceito conceitos visao forma formas modo praticas pratica ' +
    'saude unidade unidades estudante estudantes aluno alunos objetivo objetivos portfolio individuo').split(' '));
  function palavrasChave(obj) {
    const vistas = new Set();
    return semAcento(obj).replace(/\([^)]*\)/g, ' ').split(/[^a-z0-9]+/)
      .filter(w => w.length >= 5 && !PARADAS.has(w))
      .map(w => w.slice(0, 6))
      .filter(w => !vistas.has(w) && vistas.add(w));
  }

  function sugerir(texto, objetivos) {
    const frases = frasesDo(texto);
    const corpo = semAcento(String(texto || '').replace(/\[\[p\.\d+\]\]/g, ' '));
    const palavras = corpo.split(/\s+/).filter(Boolean).length;
    const sinais = { palavras, frases: frases.length };
    const sug = { versao: VERSAO, em: new Date().toISOString(), sinais };

    if (palavras < 40) {
      const j = `Sugestão automática: o texto lido tem só ${palavras} palavra(s) (arquivo escaneado, foto ou texto incompleto). Não dá para sugerir — avalie pelo arquivo original.`;
      sug.semTexto = true;
      sug.c1 = { nivel: 'I', justificativa: j };
      sug.c2 = { analise: 'ausente', necessidades: false, acoes: false, justificativa: j };
      sug.c3 = { objetivos: (objetivos || []).map(() => false), justificativa: j };
      sug.c4 = { nivel: 'I', justificativa: j };
      return sug;
    }

    // ---- C1: descrição contextualizada e reflexiva
    const refl = comRe(frases, RE.reflexao), ctx = comRe(frases, RE.contexto);
    sinais.reflexao = refl.length; sinais.contexto = ctx.length;
    let n1;
    if (refl.length >= 5 && ctx.length >= 5 && palavras >= 700) n1 = 'O';
    else if (refl.length >= 2 && ctx.length >= 2) n1 = 'B';
    else n1 = ctx.length >= 1 ? 'DM' : 'I'; // narra o que aconteceu (relatório) sem reflexão = DM; nem descrição = I
    const ev1 = [refl[0], refl[Math.floor(refl.length / 2)]].filter((f, i, a) => f && a.indexOf(f) === i).map(f => trecho(f));
    sug.c1 = {
      nivel: n1,
      justificativa: `Sugestão automática: ${ctx.length} frase(s) situam o cenário (UBS, território, equipe, paciente) e ${refl.length} trazem reflexão em 1ª pessoa, em ${palavras} palavras.` +
        (ev1.length ? ` Ex.: ${ev1.join(' · ')}.` : ' Não achei trecho de reflexão: parece relato de atividades.') + ' Confira a profundidade da reflexão.'
    };

    // ---- C2: análise (a), necessidades (b), ações (c)
    const an = comRe(frases, RE.analise), nec = comRe(frases, RE.necessidade), aco = comRe(frases, RE.acao);
    sinais.analise = an.length; sinais.necessidades = nec.length; sinais.acoes = aco.length;
    // consistente: argumentação espalhada pelo texto (4+ frases ou 1 em cada 4)
    const analise = (an.length >= 4 || (frases.length && an.length / frases.length >= 0.25 && an.length >= 2)) ? 'consistente' : an.length >= 1 ? 'superficial' : 'ausente';
    // combinação que a matriz não prevê (ex.: análise superficial COM necessidades): a sugestão fica no nível de
    // baixo (DM) — o professor sobe se o texto merecer, justificando
    const literal = (analise === 'consistente' && nec.length >= 1 && aco.length >= 1) || (analise === 'consistente' && (nec.length >= 1) !== (aco.length >= 1)) ||
      (analise === 'superficial' && !nec.length && !aco.length) || analise === 'ausente';
    sug.c2 = {
      analise, necessidades: nec.length >= 1, acoes: aco.length >= 1, ...(literal ? {} : { nivelManual: 'DM' }),
      justificativa: `Sugestão automática: (a) análise ${analise} — ${an.length} frase(s) com argumentação${an[0] ? `, ex.: ${trecho(an[0], 160)}` : ''}; ` +
        `(b) necessidades: ${nec[0] ? trecho(nec[0], 160) : 'não identificadas no texto'}; (c) ações: ${aco[0] ? trecho(aco[0], 160) : 'nenhuma proposta encontrada'}.`
    };

    // ---- C3: objetivos da turma
    const achados = (objetivos || []).map(o => {
      const chaves = palavrasChave(o);
      const tem = chaves.filter(k => corpo.includes(k));
      const precisa = chaves.length <= 2 ? chaves.length : Math.ceil(chaves.length / 2);
      const ok = chaves.length > 0 && tem.length >= precisa;
      let melhor = null, nm = 0;
      if (ok) frases.forEach(f => { const n = chaves.filter(k => f.norm.includes(k)).length; if (n > nm) { nm = n; melhor = f; } });
      return { ok, tem: tem.length, de: chaves.length, melhor };
    });
    sinais.objetivos = achados.filter(a => a.ok).length;
    sug.c3 = {
      objetivos: achados.map(a => a.ok),
      justificativa: `Sugestão automática: ${achados.filter(a => a.ok).length} de ${achados.length} objetivo(s) aparecem no texto pelas palavras-chave. ` +
        achados.map((a, i) => `Obj. ${i + 1}: ${a.ok ? (a.melhor ? trecho(a.melhor, 120) : 'citado') : 'não encontrado'}`).join(' · ') +
        '. Mencionar não é atingir: confira se cada um foi discutido.'
    };

    // ---- C4: organização e escrita
    const paragrafos = String(texto || '').split(/\n\s*\n|\n(?=\s*[A-ZÁÉÍÓÚ])/).filter(p => p.trim().split(/\s+/).length >= 15).length;
    const longas = frases.filter(f => f.texto.split(' ').length > 45).length;
    const estrutura = RE.estrutura.test(corpo);
    const erros = ERROS.filter(([re]) => re.test(corpo)).map(([, t]) => t);
    sinais.paragrafos = paragrafos; sinais.frasesLongas = longas; sinais.errosComuns = erros.length;
    const pctLongas = frases.length ? longas / frases.length : 0;
    let n4;
    if (erros.length >= 3 || pctLongas > 0.3) n4 = 'DM';
    else if (estrutura && paragrafos >= 4 && !erros.length && pctLongas <= 0.1) n4 = 'O';
    else n4 = 'B';
    sug.c4 = {
      nivel: n4,
      justificativa: `Sugestão automática: ${paragrafos} parágrafo(s), ${estrutura ? 'com' : 'sem'} introdução/conclusão identificável, ${longas} frase(s) com mais de 45 palavras` +
        `${erros.length ? `, possíveis erros: ${erros.join('; ')}` : ', sem os erros comuns que a regra procura'}. A regra não corrige gramática: confira concordância, regência e ortografia.`
    };
    return sug;
  }

  const S = { VERSAO, sugerir, frasesDo, palavrasChave };
  if (typeof module !== 'undefined' && module.exports) module.exports = S;
  else raiz.PortfolioSugestao = S;
})(typeof window !== 'undefined' ? window : this);
