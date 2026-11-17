// Relatório CADAM em PDF (17/11/2026) — padrão dos relatórios do Órbita: PDF vetorial (texto de verdade) com o jsPDF,
// logos FATEC IVP + MED FATEC no cabeçalho, rodapé "Órbita Fatec" com página x de y, nada partido entre páginas.
// Dois documentos, a partir do mesmo diagnóstico do cadam-relatorio.js:
//   montarPdfDevolutiva → para o professor (formativo)    montarPdfExecutivo → para a coordenação (parecer)
// Recebe o construtor do jsPDF por parâmetro (window.jspdf.jsPDF no navegador).

const A4 = { w: 210, h: 297 };
const M = 15, W = A4.w - 2 * M, TOPO = 20, RODAPE = 16;
const COR = {
  med: [0, 79, 159], ciano: [0, 159, 227], tinta: [13, 27, 51], tinta2: [68, 83, 107], mudo: [100, 116, 139],
  linha: [226, 232, 240], fundo: [246, 248, 251], branco: [255, 255, 255],
  ok: [21, 128, 61], okF: [236, 247, 241], aj: [180, 83, 9], ajF: [255, 251, 235], er: [185, 28, 28], erF: [254, 242, 242], sug: [0, 79, 159], sugF: [239, 246, 255]
};
const NIVEL = {
  obrigatorio: { rot: 'Corrigir antes de enviar', c: COR.er, f: COR.erF },
  ajuste: { rot: 'Para melhorar', c: COR.aj, f: COR.ajF },
  sugestao: { rot: 'Dica', c: COR.sug, f: COR.sugF }
};
const SIT = { Aprovada: ['Pronta', COR.ok], Ajustar: ['Para melhorar', COR.aj], Corrigir: ['Corrigir antes de enviar', COR.er] };
// as fontes padrão do PDF só têm Windows-1252 (acentos ok); seta e afins viram texto simples
const CP1252 = new Set([...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)), ...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);
const TROCA = { '→': '->', '≤': '<=', '≥': '>=', '×': 'x' };
const limpa = (s) => [...String(s ?? '')].map(c => c === '\n' ? '\n' : TROCA[c] || (CP1252.has(c) ? c : (/\s/.test(c) ? ' ' : ''))).join('').replace(/[ \t]+/g, ' ').trim();
const alt = (tam) => tam * 0.3528 * 1.35;
const hoje = () => new Date().toLocaleDateString('pt-BR');

function base(JsPDF, { titulo, logos, linhasInfo }) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const st = { y: M };
  const fonte = (tam, estilo = 'normal', c = COR.tinta) => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); doc.setTextColor(...c); };
  const quebra = (txt, tam, larg, estilo = 'normal') => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); return doc.splitTextToSize(limpa(txt), larg); };
  const novaPagina = () => {
    doc.addPage(); st.y = M;
    fonte(8, 'bold', COR.med); doc.text(limpa(titulo), M, st.y + 3);
    fonte(8, 'normal', COR.mudo); doc.text(limpa(linhasInfo[0] || ''), A4.w - M, st.y + 3, { align: 'right' });
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.3); doc.line(M, st.y + 5.5, A4.w - M, st.y + 5.5);
    st.y = TOPO;
  };
  const garantir = (h) => { if (st.y + h > A4.h - RODAPE) novaPagina(); };
  // parágrafo com quebra de página entre linhas
  const paragrafo = (txt, { tam = 9.5, estilo = 'normal', c = COR.tinta, x = M, larg = W, depois = 2 } = {}) => {
    const ls = quebra(txt, tam, larg, estilo); const h = alt(tam);
    ls.forEach(l => { garantir(h); fonte(tam, estilo, c); doc.text(l, x, st.y + h * 0.75); st.y += h; });
    st.y += depois;
  };
  const par = (titulo, corpo) => { const h = quebra(titulo, 9.5, W, 'bold').length * alt(9.5) + quebra(corpo || '', 9, W - 4).length * alt(9) + 3; garantir(h); };
  const secao = (txt) => { garantir(14); st.y += 3; fonte(12, 'bold', COR.med); doc.text(limpa(txt), M, st.y + 4.5); st.y += 7; doc.setDrawColor(...COR.ciano); doc.setLineWidth(0.6); doc.line(M, st.y, M + 18, st.y); st.y += 4; };
  // caixas de números lado a lado
  const numeros = (lista) => {
    const n = lista.length, gap = 3, w = (W - gap * (n - 1)) / n, h = 18; garantir(h + 3);
    lista.forEach(([valor, rot, c], i) => {
      const x = M + i * (w + gap);
      doc.setFillColor(...COR.fundo); doc.setDrawColor(...COR.linha); doc.setLineWidth(0.3); doc.roundedRect(x, st.y, w, h, 2, 2, 'FD');
      fonte(14, 'bold', c || COR.tinta); doc.text(limpa(String(valor)), x + 3, st.y + 7.5);
      fonte(7.5, 'normal', COR.tinta2); quebra(rot, 7.5, w - 5).slice(0, 2).forEach((l, j) => doc.text(l, x + 3, st.y + 12.2 + j * alt(7.5)));
    });
    st.y += h + 4;
  };
  // tabela com quebra de linha nas células, cabeçalho repetido a cada página
  const tabela = (cols, linhas) => {
    const pad = 1.6, tam = 8, lh = alt(tam);
    const cab = () => {
      const h = lh + pad * 2; garantir(h + lh * 2);
      doc.setFillColor(...COR.med); doc.rect(M, st.y, W, h, 'F'); let x = M;
      cols.forEach(c => { fonte(tam, 'bold', COR.branco); doc.text(limpa(c.t), x + pad, st.y + pad + lh * 0.75); x += c.w; });
      st.y += h;
    };
    cab();
    linhas.forEach((ln, k) => {
      const cel = ln.celulas.map((t, i) => quebra(t, tam, cols[i].w - pad * 2, cols[i].negrito ? 'bold' : 'normal'));
      const h = Math.max(...cel.map(c => c.length)) * lh + pad * 2;
      if (st.y + h > A4.h - RODAPE) { novaPagina(); cab(); }
      if (k % 2) { doc.setFillColor(...COR.fundo); doc.rect(M, st.y, W, h, 'F'); }
      if (ln.cor) { doc.setFillColor(...ln.cor); doc.rect(M, st.y, 1.2, h, 'F'); }
      let x = M;
      cel.forEach((ls, i) => { fonte(tam, cols[i].negrito ? 'bold' : 'normal', COR.tinta); ls.forEach((l, j) => doc.text(l, x + pad + (i === 0 ? 0.8 : 0), st.y + pad + lh * 0.75 + j * lh)); x += cols[i].w; });
      doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, st.y + h, A4.w - M, st.y + h);
      st.y += h;
    });
    st.y += 4;
  };

  // ---------- cabeçalho da 1ª página ----------
  const hLogo = 9;
  if (logos.fatec) { const w = hLogo * logos.fatec.w / logos.fatec.h; doc.addImage(logos.fatec.dataUrl, 'PNG', M, st.y + 1, w, hLogo); }
  if (logos.med) { const w = hLogo * logos.med.w / logos.med.h; doc.addImage(logos.med.dataUrl, 'PNG', A4.w - M - w, st.y + 1, w, hLogo); }
  st.y += hLogo + 3;
  doc.setFillColor(...COR.med); doc.rect(M, st.y, W, 1.2, 'F'); doc.setFillColor(...COR.ciano); doc.rect(M, st.y + 1.2, W, 0.6, 'F');
  st.y += 7;
  fonte(17, 'bold', COR.tinta); doc.text(limpa(titulo), M, st.y + 5); st.y += 9;
  linhasInfo.forEach((l, i) => { fonte(i ? 9 : 10, i ? 'normal' : 'bold', i ? COR.tinta2 : COR.med); doc.text(quebra(l, i ? 9 : 10, W)[0], M, st.y + 3.5); st.y += i ? 4.6 : 5.2; });
  st.y += 3;

  const fechar = () => {
    const n = doc.getNumberOfPages();
    for (let p = 1; p <= n; p++) {
      doc.setPage(p);
      doc.setDrawColor(...COR.linha); doc.setLineWidth(0.3); doc.line(M, A4.h - 11, A4.w - M, A4.h - 11);
      fonte(7.5, 'normal', COR.mudo);
      doc.text(limpa(`Órbita Fatec · Banco de Questões da Medicina · Relatório CADAM · gerado em ${hoje()}`), M, A4.h - 7);
      doc.text(`Página ${p} de ${n}`, A4.w - M, A4.h - 7, { align: 'right' });
    }
    return doc;
  };
  return { doc, st, fonte, quebra, paragrafo, par, secao, numeros, tabela, garantir, fechar };
}

// item de recomendação (bloco com barra colorida à esquerda), sem partir entre páginas
function blocoItem(P, m) {
  const nv = NIVEL[m.nivel] || NIVEL.sugestao, x = M + 4, larg = W - 8, tam = 8.6, lh = alt(tam);
  const partes = [
    ...P.quebra(m.titulo, 9, larg, 'bold').map(t => ({ t, e: 'bold', tam: 9 })),
    ...(m.porque ? P.quebra('Por quê: ' + m.porque, tam, larg).map(t => ({ t, tam })) : []),
    ...(m.como ? P.quebra('Como fazer: ' + m.como, tam, larg).map(t => ({ t, tam })) : []),
    ...((m.exemplos || []).flatMap(e => P.quebra(e, 8, larg).map(t => ({ t, tam: 8, c: COR.tinta2 })))),
    ...(m.fonte ? [{ t: 'Fonte: ' + limpa(m.fonte), tam: 7.2, c: COR.mudo }] : [])
  ];
  const h = partes.reduce((s, p) => s + alt(p.tam), 0) + 3;
  P.garantir(h + 1.5);
  P.doc.setFillColor(...nv.f); P.doc.rect(M + 2, P.st.y, W - 2, h, 'F');
  P.doc.setFillColor(...nv.c); P.doc.rect(M + 2, P.st.y, 1, h, 'F');
  let y = P.st.y + 1.5;
  partes.forEach(p => { P.fonte(p.tam, p.e || 'normal', p.c || COR.tinta); P.doc.text(p.t, x, y + alt(p.tam) * 0.75); y += alt(p.tam); });
  P.st.y += h + 1.5;
}

// ============ DEVOLUTIVA (professor) ============
export function montarPdfDevolutiva(JsPDF, { CR, questoes, av, rotulo, professor, logos }) {
  const P = base(JsPDF, { titulo: 'Relatório CADAM — Devolutiva ao professor', logos,
    linhasInfo: [professor ? `Prof.(a) ${professor}` : 'Todos os professores', `${av.disciplina} · ${rotulo} · ${av.semestre}`] });
  const itens = questoes.map(q => ({ q, r: CR.analisarQuestao(q) }));
  const n = itens.length, corr = itens.filter(x => x.r.situacao === 'Corrigir').length, aj = itens.filter(x => x.r.situacao === 'Ajustar').length;
  P.paragrafo('Esta devolutiva é para ajudar você a escrever questões cada vez melhores. Ela mostra o que já está bom, o que precisa ser corrigido antes da prova ser liberada e o porquê de cada recomendação, com base no padrão CADAM e nas diretrizes do NBME para questões de medicina.', { c: COR.tinta2, depois: 4 });
  P.numeros([[n, 'questões'], [n - corr - aj, 'prontas', COR.ok], [aj, 'para melhorar', COR.aj], [corr, 'corrigir antes de enviar', COR.er]]);
  const fortes = {}; itens.forEach(({ r }) => r.fortes.forEach(f => { fortes[f] = (fortes[f] || 0) + 1; }));
  const topF = Object.entries(fortes).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (topF.length) { P.secao('O que você já faz bem'); topF.forEach(([f, k]) => P.paragrafo(`•  ${f} (${k} de ${n})`, { x: M + 2, larg: W - 2, depois: 0.8 })); }
  const tipos = {}; itens.forEach(({ q, r }) => r.melhorar.forEach(m => { const t = tipos[m.tipo] = tipos[m.tipo] || { ...m, qs: [] }; if (!t.qs.includes(q.numero)) t.qs.push(q.numero); }));
  const top = Object.values(tipos).sort((a, b) => b.qs.length - a.qs.length).slice(0, 4);
  if (top.length) {
    P.secao('O que mais apareceu nas suas questões');
    top.forEach((t, i) => { P.par(`${i + 1}. ${t.tipo}  (questões ${t.qs.join(', ')})`, `${t.porque || ''} ${t.como ? 'Como fazer: ' + t.como : ''}`); P.paragrafo(`${i + 1}. ${t.tipo}  (questões ${t.qs.join(', ')})`, { estilo: 'bold', depois: 0.5 }); P.paragrafo(`${t.porque || ''} ${t.como ? 'Como fazer: ' + t.como : ''}`, { x: M + 4, larg: W - 4, c: COR.tinta2, tam: 9, depois: 2 }); });
  }
  P.secao('Questão por questão');
  itens.forEach(({ q, r }) => {
    const [rot, c] = SIT[r.situacao];
    P.garantir(22);
    P.doc.setFillColor(...COR.fundo); P.doc.rect(M, P.st.y, W, 7, 'F'); P.doc.setFillColor(...c); P.doc.rect(M, P.st.y, 1.4, 7, 'F');
    P.fonte(10, 'bold', COR.tinta); P.doc.text(`Questão ${q.numero}`, M + 3.5, P.st.y + 4.8);
    P.fonte(8.5, 'bold', c); P.doc.text(limpa(rot), M + 26, P.st.y + 4.8);
    P.fonte(8, 'normal', COR.mudo); P.doc.text(limpa(`Bloom estimado: ${r.bloom}${r.nivelObjetivo ? ' · objetivo pede ' + r.nivelObjetivo : ''}`), A4.w - M - 2, P.st.y + 4.8, { align: 'right' });
    P.st.y += 9;
    const enun = CR.texto ? CR.texto(q.casoClinico || q.enunciadoHtml) : '';
    if (enun) P.paragrafo(enun.length > 220 ? enun.slice(0, 220) + '…' : enun, { tam: 8.5, c: COR.tinta2, depois: 1.5 });
    if (r.fortes.length) { P.paragrafo('O que está bom: ' + r.fortes.join(' '), { tam: 8.5, c: COR.ok, depois: 1.5 }); }
    r.melhorar.forEach(m => blocoItem(P, m));
    if (!r.melhorar.length) P.paragrafo('Questão no padrão. Bom trabalho!', { estilo: 'bold', c: COR.ok, tam: 9 });
    P.st.y += 2;
  });
  return P.fechar();
}

// ============ EXECUTIVO (coordenação) ============
export function montarPdfExecutivo(JsPDF, { CR, questoes, av, rotulo, analise, logos }) {
  const P = base(JsPDF, { titulo: 'Relatório CADAM — Executivo', logos,
    linhasInfo: [`${av.disciplina} · ${rotulo} · ${av.semestre}`, `Situação da prova: ${av.status === 'finalizada' ? 'finalizada' : 'em montagem'} · uso da coordenação`] });
  const r = CR.analisarProva(questoes, analise);
  P.secao('1. Resumo executivo');
  const corP = r.parecer === 'Apta' ? [COR.ok, COR.okF] : r.parecer === 'Inapta' ? [COR.er, COR.erF] : [COR.aj, COR.ajF];
  P.garantir(12); P.doc.setFillColor(...corP[1]); P.doc.roundedRect(M, P.st.y, W, 9, 1.5, 1.5, 'F');
  P.fonte(11, 'normal', corP[0]); P.doc.text('Parecer preliminar:', M + 4, P.st.y + 6); P.fonte(11, 'bold', corP[0]); P.doc.text(r.parecer, M + 42, P.st.y + 6); P.st.y += 12;
  P.numeros([[r.total, 'questões'], [r.aprovadas, 'aprovadas', COR.ok], [r.comAjuste, 'requerem ajuste', COR.aj], [r.comObrig, 'correção obrigatória', COR.er], [r.pctCaso + '%', 'caso clínico'], ['~' + r.minutos + ' min', 'tempo estimado']]);
  const bloom = ['Lembrar', 'Entender', 'Aplicar', 'Analisar', 'Avaliar'].filter(b => r.bloom[b]).map(b => `${b} ${r.bloom[b]}`).join(' · ');
  P.paragrafo(`Bloom estimado: ${bloom || '—'}.${r.travadas ? ` ${r.travadas} questão(ões) ainda fora do padrão (não saem para o AVA).` : ''}`, { tam: 9, c: COR.tinta2, depois: 3 });

  P.secao('2. Tabela sinóptica de inconformidades');
  if (r.tabela.length) P.tabela([{ t: 'Nº', w: 13, negrito: true }, { t: 'Tipo de falha', w: 33, negrito: true }, { t: 'Descrição', w: 58 }, { t: 'Impacto e ação corretiva', w: W - 104 }],
    r.tabela.map(t => ({ cor: (NIVEL[t.nivel] || NIVEL.ajuste).c, celulas: [t.questao == null ? 'Prova' : String(t.questao), `${t.tipo}\nEixo ${t.eixo} · ${t.nivel === 'obrigatorio' ? 'obrigatória' : 'ajuste'}`, t.titulo + ((t.exemplos || []).length ? '\n' + t.exemplos.join('\n') : ''), `${t.porque ? t.porque + ' ' : ''}${t.como || ''}`] })));
  else P.paragrafo('Nenhuma inconformidade obrigatória ou de ajuste.', { c: COR.ok, estilo: 'bold' });

  P.secao('3. Análise temática e balanço da matriz');
  P.tabela([{ t: 'Objetivo / tema', w: 120 }, { t: 'Itens', w: 22, negrito: true }, { t: 'Questões', w: W - 142 }],
    [...r.temas.map(t => ({ cor: t.alerta ? COR.aj : null, celulas: [t.tema + (t.alerta ? '\nHiperconcentração' : ''), `${t.qtd} (${t.pct}%)`, t.questoes.join(', ')] })),
     ...r.semObjetivo.map(o => ({ cor: COR.er, celulas: [o + '\nSem questão', '0', '—'] }))]);
  P.paragrafo(r.redundancias.length ? `Redundância de desfecho: ${r.redundancias.map(d => `questões ${d.questoes.join(', ')} ("${d.texto.slice(0, 60)}")`).join('; ')}.` : 'Sem redundância de desfecho (nenhuma resposta correta se repete).', { tam: 9, c: COR.tinta2 });

  P.secao('4. Recomendações prioritárias para a devolutiva ao docente');
  if (r.prioridades.length) r.prioridades.forEach((p, i) => { P.par(`${i + 1}. ${p.tipo}  —  ${p.questoes.join(', ')}`, p.como || ''); P.paragrafo(`${i + 1}. ${p.tipo}  —  ${p.questoes.length ? 'questões ' + p.questoes.join(', ') : 'prova inteira'}`, { estilo: 'bold', c: (NIVEL[p.nivel] || NIVEL.ajuste).c, depois: 0.4 }); P.paragrafo(p.como || '', { x: M + 4, larg: W - 4, tam: 9, c: COR.tinta2, depois: 2 }); });
  else P.paragrafo('Nada obrigatório a pedir ao professor.', { c: COR.ok, estilo: 'bold' });
  if (r.conferenciaVisual.length) P.paragrafo(`Conferir a olho as imagens das questões ${r.conferenciaVisual.join(', ')}: sem seta, legenda ou texto que entregue a resposta, e legíveis no celular.`, { tam: 9 });

  P.secao('Situação por professor');
  const profs = {}; questoes.forEach((q, k) => { const p = q.professorNome || 'Sem professor'; const x = profs[p] = profs[p] || { n: 0, ok: 0, aj: 0, co: 0 }; x.n++; const s = r.itens[k].situacao; if (s === 'Aprovada') x.ok++; else if (s === 'Ajustar') x.aj++; else x.co++; });
  P.tabela([{ t: 'Professor(a)', w: 90, negrito: true }, { t: 'Questões', w: 22 }, { t: 'Prontas', w: 22 }, { t: 'Ajustar', w: 23 }, { t: 'Corrigir', w: W - 157 }],
    Object.entries(profs).map(([p, x]) => ({ cor: x.co ? COR.er : x.aj ? COR.aj : COR.ok, celulas: [p, String(x.n), String(x.ok), String(x.aj), String(x.co)] })));
  P.paragrafo('Relatório automático: confere padrões de escrita e estrutura; não substitui a leitura do conteúdo médico (gabarito, dados clínicos). Imagens não são lidas pelo sistema.', { tam: 8, c: COR.mudo });
  return P.fechar();
}
