// Portfólio — devolutiva padronizada em PDF (27/11/2026)
// Pedido da coordenação: o aluno recebe sempre o MESMO formato, sem comentário vago. Para cada critério cobrado sai o
// nível, o DESCRITOR OFICIAL da matriz para aquele nível e a evidência apontada pelo professor (página/trecho); no C3,
// cada objetivo cobrado como atingido ou não. O texto livre fica só no bloco "Devolutiva do professor" (pontos fortes,
// a desenvolver, recomendação e análise do professor). Só sai de correção FINALIZADA. jsPDF (texto de verdade).

const AZUL = [0, 79, 159], CIANO = [0, 159, 227], TINTA = [30, 41, 59], MUDO = [100, 116, 139];
const COR_NIVEL = { O: [21, 128, 61], B: [3, 105, 161], DM: [180, 110, 0], I: [185, 28, 28] };
const nomeArq = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
const dataBr = (iso) => (iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '');

export function pdfDevolutiva(e, { M, turma, atividade, valor }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const fmt = M.fmt;
  const f2 = (x) => (x == null ? '—' : String(Math.round(Number(x) * 100) / 100).replace('.', ',')); // pontos redistribuídos têm 2 casas
  const r = e.resultado, av = e.avaliacao;
  const naDisc = (n) => Math.round(Number(n) * valor / 10 * 10 + 1e-9) / 10;
  const W = 210, MG = 16, LARG = W - 2 * MG;
  let y = 0;
  const garantir = (h) => { if (y + h > 280) { doc.addPage(); y = 18; } };
  const texto = (t, x, o = {}) => {
    if (!String(t || '').trim()) return;
    const tam = o.tam || 10;
    doc.setFont('helvetica', o.negrito ? 'bold' : o.italico ? 'italic' : 'normal');
    doc.setFontSize(tam); doc.setTextColor(...(o.cor || TINTA));
    const linhas = doc.splitTextToSize(String(t), o.larg || LARG);
    linhas.forEach(l => { garantir(tam * 0.45); doc.text(l, x, y + tam * 0.35); y += tam * 0.45; });
    y += o.depois ?? 1.5;
  };
  const titulo = (t) => { garantir(14); y += 2; doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...AZUL); doc.text(t, MG, y + 4); y += 6; doc.setDrawColor(...CIANO); doc.setLineWidth(0.5); doc.line(MG, y, MG + 18, y); y += 3; };

  // faixa
  doc.setFillColor(...AZUL); doc.rect(0, 0, W, 26, 'F');
  doc.setFillColor(...CIANO); doc.rect(0, 26, W, 1.4, 'F');
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.text('Devolutiva do Portfólio Reflexivo', MG, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  doc.text(`Faculdade de Tecnologia do Vale do Ivaí · Medicina · ${turma.componente || 'SCIC'}`, MG, 19);

  // nota
  y = 34;
  doc.setDrawColor(...AZUL); doc.setLineWidth(0.6); doc.roundedRect(W - MG - 46, 33, 46, 26, 2, 2, 'S');
  doc.setTextColor(...AZUL); doc.setFont('helvetica', 'bold'); doc.setFontSize(22);
  doc.text(fmt(naDisc(r.nota)), W - MG - 23, 46, { align: 'center' });
  doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUDO);
  doc.text(`de ${fmt(valor)} pontos`, W - MG - 23, 52, { align: 'center' });
  doc.text(`${f2(r.nota)} na matriz de 10`, W - MG - 23, 56.5, { align: 'center' });
  const largId = LARG - 52;
  texto(e.nome, MG, { negrito: true, tam: 13, larg: largId, depois: 2 });
  texto(`${atividade.titulo} · ${turma.turma}${turma.periodo ? ` · ${turma.periodo}º período` : ''} · ${turma.semestre}`, MG, { tam: 9.5, cor: MUDO, larg: largId });
  if (turma.tema) texto(`Tema: ${turma.tema}`, MG, { tam: 9.5, cor: MUDO, larg: largId });
  if (turma.questaoNorteadora) texto(`Questão norteadora: ${turma.questaoNorteadora}`, MG, { tam: 9, italico: true, cor: MUDO, larg: largId });
  y = Math.max(y, 62);

  // critérios
  titulo('Avaliação pela matriz');
  if (r.redistribuido) texto('Nesta atividade a coordenação escolheu o que cobrar: o valor dos itens não cobrados foi distribuído entre os demais.', MG, { tam: 8.5, cor: MUDO });
  M.CRITERIOS.forEach(c => {
    const x = r.criterios[c.id];
    if (!x || x.naoCobrado) return;
    garantir(18);
    doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.3); doc.line(MG, y, W - MG, y); y += 2;
    const nomeL = doc.splitTextToSize(`${c.num}. ${c.nome}`, LARG - 62);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...TINTA); doc.text(nomeL, MG, y + 3.8);
    doc.setTextColor(...(COR_NIVEL[x.nivel] || MUDO)); doc.setFontSize(10);
    doc.text(x.nivel ? M.NOME_NIVEL[x.nivel] : '—', W - MG - 24, y + 3.8, { align: 'right' });
    doc.setTextColor(...TINTA); doc.text(`${f2(x.pts)} / ${f2(x.max)}`, W - MG, y + 3.8, { align: 'right' });
    y += nomeL.length * 4.6 + 2;
    if (x.nivel) texto(`Descritor da matriz: ${c.niveis[x.nivel].descritor}`, MG + 2, { tam: 9, larg: LARG - 4, depois: 1 });
    if (c.id === 'c3') {
      const objs = turma.objetivos || [];
      const cob = (r.cobrar && r.cobrar.objetivos) || objs.map((_, k) => k);
      texto(`${x.n} de ${x.total} objetivos atingidos (${Math.round((x.pct || 0) * 100)}%):`, MG + 2, { tam: 9, larg: LARG - 4, depois: 0.5 });
      cob.forEach(k => texto(`${av.c3.objetivos[k] ? '[atingido]' : '[não atingido]'}  ${k + 1}. ${objs[k]}`, MG + 5, { tam: 8.8, cor: av.c3.objetivos[k] ? [21, 128, 61] : [185, 28, 28], larg: LARG - 8, depois: 0.3 }));
      y += 1;
    }
    if (x.nota) texto(x.nota, MG + 2, { tam: 8.5, italico: true, cor: MUDO, larg: LARG - 4, depois: 0.5 });
    texto(`Evidência no portfólio: ${x.justificativa || '—'}`, MG + 2, { tam: 9, cor: MUDO, larg: LARG - 4, depois: 2 });
  });
  doc.setDrawColor(226, 232, 240); doc.line(MG, y, W - MG, y); y += 2;
  if (r.penalidade !== 'nenhuma') texto(`Condição especial aplicada: ${M.PENALIDADES[r.penalidade].rotulo} (soma ${f2(r.soma)} × ${String(r.fator).replace('.', ',')}).`, MG, { tam: 9.5, negrito: true, cor: [185, 28, 28] });
  texto(`Nota final: ${f2(r.nota)} na matriz de 10 = ${fmt(naDisc(r.nota))} de ${fmt(valor)} na disciplina.`, MG, { tam: 10, negrito: true, cor: AZUL, depois: 2 });

  // devolutiva do professor (texto livre, separado)
  titulo('Devolutiva do professor');
  // a "Análise do professor" é INTERNA (explica a diferença para a nota de corte, que o aluno não vê) — não entra aqui
  [['Pontos fortes', av.feedback.fortes], ['Pontos a desenvolver', av.feedback.desenvolver], ['Recomendação prática', av.feedback.recomendacao]]
    .forEach(([t, v]) => { if (String(v || '').trim()) { texto(t, MG, { tam: 9.5, negrito: true, depois: 0.5 }); texto(v, MG, { tam: 9.8, depois: 2.5 }); } });

  const pags = doc.getNumberOfPages();
  for (let p = 1; p <= pags; p++) {
    doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUDO);
    doc.text(`Corrigido por ${e.corrigidoPor || ''} em ${dataBr(e.corrigidoEm)} · Matriz ${e.matrizVersao || M.VERSAO} · Órbita Fatec`, MG, 290);
    doc.text(`${p}/${pags}`, W - MG, 290, { align: 'right' });
  }
  return doc;
}
export const nomeDevolutiva = (e) => nomeArq(`Devolutiva_Portfolio_${e.nome}.pdf`);
export const nomeZip = (turma, atividade) => nomeArq(`Devolutivas_${turma.turma}_${atividade.titulo}.zip`);
