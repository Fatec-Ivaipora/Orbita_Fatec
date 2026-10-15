// Relatório CPA por professor — PDF vetorial (texto de verdade, não foto da
// tela): leve, nítido, rápido e com quebra de página controlada aqui (nenhuma
// pergunta ou comentário fica partido entre duas páginas).
//
// Recebe o construtor do jsPDF por parâmetro pra funcionar tanto no navegador
// (window.jspdf.jsPDF) quanto num teste em Node.

const A4 = { w: 210, h: 297 };
const M = 15;                    // margem lateral
const W = A4.w - 2 * M;          // largura útil
const TOPO = 16, RODAPE = 16;    // área reservada no topo das páginas seguintes e no rodapé

const COR = {
  marca: [18, 41, 77], azul: [31, 111, 178], tinta: [13, 27, 51], tinta2: [68, 83, 107], mudo: [91, 106, 128],
  linha: [227, 232, 240], fundo: [246, 248, 251], trilho: [226, 232, 240],
  bom: [15, 122, 75], neutro: [100, 116, 139], atencao: [200, 57, 47],
};
const ROT = ['Ótimo', 'Bom', 'Regular', 'Ruim', 'Não sei'];
const CORES_DIST = [[21, 128, 61], [132, 204, 22], [245, 158, 11], [220, 38, 38]];
const GRUPOS = [
  { k: 'bom', rotulo: 'Elogios', cor: COR.bom, fundo: [236, 247, 241] },
  { k: 'neutro', rotulo: 'Neutros', cor: COR.neutro, fundo: COR.fundo },
  { k: 'atencao', rotulo: 'Pontos de atenção', cor: COR.atencao, fundo: [253, 240, 238] },
];

// As fontes padrão do PDF só têm os caracteres do Windows-1252 (acentos do
// português incluídos); emoji e afins em comentário de aluno quebrariam o texto.
const CP1252 = new Set([
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)),
  ...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ',
]);
const limpa = (s) => [...String(s ?? '')].map(c => (CP1252.has(c) ? c : (/\s/.test(c) ? ' ' : ''))).join('').replace(/[ \t]+/g, ' ').trim();
const frase = (s) => limpa(s).toLowerCase().replace(/(^\s*[a-zà-ú])/, m => m.toUpperCase());
const dimCurta = (n) => { const t = frase(String(n || '').replace(/^.*[-–]\s*/, '')); return t || frase(n); };
const pct = (v) => `${String(v).replace('.', ',')}%`;
const alt = (tam) => tam * 0.3528 * 1.3; // altura de linha em mm para um tamanho de fonte em pt

export function montarPdfProfessor(JsPDF, { professor, nomeCurso, campanha, disciplinas, logo }) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  let y = M;

  const cor = (c) => doc.setTextColor(...c);
  const fonte = (tam, estilo = 'normal', c = COR.tinta) => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); cor(c); };
  const quebra = (txt, tam, largura, estilo = 'normal') => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); return doc.splitTextToSize(limpa(txt), largura); };
  const novaPagina = () => { doc.addPage(); y = TOPO + 4; };
  const garantir = (h) => { if (y + h > A4.h - RODAPE) novaPagina(); };

  // ---------- capa ----------
  let topoTitulo = y;
  let xTitulo = M;
  if (logo) {
    const hLogo = 13, wLogo = hLogo * (logo.w / logo.h);
    doc.addImage(logo.dataUrl, 'PNG', M, y, wLogo, hLogo);
    xTitulo = M + wLogo + 6;
  }
  fonte(8, 'bold', COR.mudo);
  doc.text('RELATÓRIO CPA · AVALIAÇÃO DOS ALUNOS', xTitulo, topoTitulo + 4);
  fonte(10, 'normal', COR.tinta2);
  doc.text(quebra(`${nomeCurso} · ${campanha || ''}`, 10, A4.w - M - xTitulo), xTitulo, topoTitulo + 9.5);
  y = topoTitulo + 17;
  doc.setDrawColor(...COR.marca); doc.setLineWidth(0.7); doc.line(M, y, A4.w - M, y);
  y += 10;

  fonte(9, 'bold', COR.mudo);
  doc.text('PROFESSOR(A)', M, y); y += 7;
  const nomeLinhas = quebra(professor, 20, W, 'bold');
  fonte(20, 'bold', COR.marca); doc.text(nomeLinhas, M, y); y += nomeLinhas.length * alt(20) + 2;
  fonte(9, 'normal', COR.mudo);
  doc.text(`Emitido em ${new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })}`, M, y);
  y += 10;

  // resumo: uma linha por disciplina
  fonte(11, 'bold', COR.marca); doc.text(`Disciplinas avaliadas (${disciplinas.length})`, M, y); y += 5;
  const col = [M, M + 112, M + 135, M + 158]; // disciplina | nota | avaliações | satisfação
  const cab = () => {
    doc.setFillColor(...COR.fundo); doc.rect(M, y, W, 7, 'F');
    fonte(7.5, 'bold', COR.mudo);
    doc.text('DISCIPLINA', col[0] + 2, y + 4.7);
    doc.text('NOTA (0–10)', col[1], y + 4.7); doc.text('AVALIAÇÕES', col[2], y + 4.7); doc.text('SATISFAÇÃO', col[3], y + 4.7);
    y += 7;
  };
  cab();
  for (const d of disciplinas) {
    const ls = quebra(d.disciplina, 9, col[1] - col[0] - 6);
    const ld = d.dimensao ? quebra(dimCurta(d.dimensao), 7, col[1] - col[0] - 6) : [];
    const h = Math.max(7, ls.length * alt(9) + ld.length * alt(7) + 3);
    if (y + h > A4.h - RODAPE) { novaPagina(); cab(); }
    fonte(9, 'normal', COR.tinta); doc.text(ls, col[0] + 2, y + 4.6);
    if (ld.length) { fonte(7, 'normal', COR.mudo); doc.text(ld, col[0] + 2, y + 4.6 + ls.length * alt(9)); }
    fonte(9, 'bold', COR.tinta);
    doc.text(d.mediaGeral === null ? '—' : d.mediaGeral.toFixed(1), col[1], y + 4.6);
    doc.text(String(d.totalAvaliacoes), col[2], y + 4.6);
    doc.text(d.satisfacao === null ? '—' : pct(d.satisfacao), col[3], y + 4.6);
    y += h;
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, y, A4.w - M, y);
  }
  y += 6;
  fonte(8, 'normal', COR.mudo);
  doc.text(quebra('Satisfação = respostas Ótimo + Bom sobre o total de respostas válidas ("Não sei" fica fora da base). A nota geral (0–10) é a nota que o aluno deu à disciplina.', 8, W), M, y);

  // ---------- uma seção por disciplina ----------
  for (const d of disciplinas) {
    novaPagina();
    y = M;
    fonte(8, 'bold', COR.mudo); doc.text(quebra(d.dimensao ? `DISCIPLINA · ${dimCurta(d.dimensao).toUpperCase()}` : 'DISCIPLINA', 8, W, 'bold')[0], M, y); y += 6;
    const t = quebra(d.disciplina, 15, W, 'bold');
    fonte(15, 'bold', COR.marca); doc.text(t, M, y); y += t.length * alt(15);
    fonte(9.5, 'normal', COR.tinta2);
    const outros = (d.professores || []).filter(p => p !== professor);
    doc.text(quebra(`${professor}${outros.length ? ` (com ${outros.join(', ')})` : ''}`, 9.5, W), M, y); y += 7;

    // ficha
    const caixa = (x, w, rotulo, valor) => {
      doc.setFillColor(...COR.fundo); doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2);
      doc.roundedRect(x, y, w, 15, 1.5, 1.5, 'FD');
      fonte(7, 'bold', COR.mudo); doc.text(rotulo, x + 3, y + 5);
      fonte(14, 'bold', COR.tinta); doc.text(valor, x + 3, y + 12);
    };
    const wc = (W - 8) / 3;
    caixa(M, wc, 'NOTA GERAL (0–10)', d.mediaGeral === null ? '—' : d.mediaGeral.toFixed(1));
    caixa(M + wc + 4, wc, 'AVALIAÇÕES', String(d.totalAvaliacoes));
    caixa(M + 2 * (wc + 4), wc, 'SATISFAÇÃO', d.satisfacao === null ? '—' : pct(d.satisfacao));
    y += 23;

    // perguntas
    if (d.perguntas && d.perguntas.length) {
      fonte(11, 'bold', COR.marca); doc.text('Resultado por pergunta', M, y); y += 5;
      let x = M;
      fonte(8, 'normal', COR.tinta2);
      ROT.slice(0, 4).forEach((r, i) => { doc.setFillColor(...CORES_DIST[i]); doc.rect(x, y - 2.6, 3, 3, 'F'); doc.text(r, x + 4.5, y); x += doc.getTextWidth(r) + 10; });
      fonte(8, 'italic', COR.mudo); doc.text('"Não sei" fica fora da base', x + 2, y);
      y += 6;
      for (const p of d.perguntas) {
        const ls = quebra(frase(p.pergunta), 9.5, W, 'bold');
        const h = ls.length * alt(9.5) + 1.5 + 7 + 10;
        garantir(h);
        fonte(9.5, 'bold', COR.tinta); doc.text(ls, M, y + 3); y += ls.length * alt(9.5) + 1.5;
        barra(doc, M, y, W, 7, p.dist); y += 7;
        fonte(8, 'normal', COR.tinta2);
        doc.text(ROT.map((r, i) => `${r} ${p.dist[i]}`).join('   ·   '), M, y + 4.2);
        fonte(8, 'bold', COR.tinta);
        doc.text(`Satisfação: ${p.satisfacao === null ? '—' : pct(p.satisfacao)}`, A4.w - M, y + 4.2, { align: 'right' });
        y += 10;
      }
      y += 2;
    }

    // comentários
    const cs = d.comentarios || [];
    // título dos comentários vai junto com o 1º grupo e o 1º comentário
    const primeiro = GRUPOS.map(g => cs.find(c => c.classificacao === g.k)).find(Boolean);
    garantir(7 + (primeiro ? 8 + quebra(primeiro.texto, 9, W - 7).length * alt(9) + 4 : 6));
    fonte(11, 'bold', COR.marca); doc.text(`Comentários dos estudantes (${cs.length})`, M, y + 3); y += 7;
    if (!cs.length) { fonte(9, 'italic', COR.mudo); doc.text('Sem comentários.', M, y + 2); continue; }
    for (const g of GRUPOS) {
      const lista = cs.filter(c => c.classificacao === g.k);
      if (!lista.length) continue;
      const linhasDe = (c) => quebra(c.texto, 9, W - 7);
      // título do grupo nunca fica sozinho no fim da página
      garantir(8 + linhasDe(lista[0]).length * alt(9) + 4);
      y += 2;
      fonte(9.5, 'bold', g.cor); doc.text(`${g.rotulo} (${lista.length})`, M, y + 3); y += 6;
      for (const c of lista) comentario(linhasDe(c), g);
    }
  }

  function comentario(linhas, g) {
    const lh = alt(9);
    const caberNaPagina = A4.h - RODAPE - (TOPO + 4);
    if (linhas.length * lh + 4 > A4.h - RODAPE - y && linhas.length * lh + 4 <= caberNaPagina) novaPagina();
    // comentário maior que uma página inteira (raro): vai em pedaços
    let i = 0;
    while (i < linhas.length) {
      const cabem = Math.max(1, Math.floor((A4.h - RODAPE - y - 4) / lh));
      const pedaco = linhas.slice(i, i + cabem);
      const h = pedaco.length * lh + 3.5;
      doc.setFillColor(...g.fundo); doc.rect(M, y, W, h, 'F');
      doc.setFillColor(...g.cor); doc.rect(M, y, 1, h, 'F');
      fonte(9, 'normal', COR.tinta); doc.text(pedaco, M + 4, y + 2 + lh * 0.75);
      y += h + 1.8;
      i += pedaco.length;
      if (i < linhas.length) novaPagina();
    }
  }

  // ---------- cabeçalho e rodapé de todas as páginas ----------
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    if (p > 1) {
      fonte(7.5, 'normal', COR.mudo);
      doc.text(limpa(`${professor} · ${nomeCurso}`), M, 9);
      doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, 11, A4.w - M, 11);
    }
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, A4.h - 11, A4.w - M, A4.h - 11);
    fonte(7.5, 'normal', COR.mudo);
    doc.text('Relatório CPA · FATEC Ivaiporã', M, A4.h - 7);
    doc.text(`Página ${p} de ${n}`, A4.w - M, A4.h - 7, { align: 'right' });
  }
  return doc;
}

// Barra empilhada da distribuição (Ótimo/Bom/Regular/Ruim). Toda faixa com
// resposta tem pelo menos 1,6 mm, pra uma resposta "Ruim" sozinha não sumir.
function barra(doc, x, y, w, h, dist) {
  const v = dist[0] + dist[1] + dist[2] + dist[3];
  doc.setFillColor(...COR.trilho); doc.roundedRect(x, y, w, h, 1.2, 1.2, 'F');
  if (!v) return;
  const MIN = 1.6;
  const ativos = [0, 1, 2, 3].filter(i => dist[i] > 0);
  const larguras = [0, 0, 0, 0];
  const pequenos = ativos.filter(i => (dist[i] / v) * w < MIN);
  const resto = w - pequenos.length * MIN;
  const vGrandes = ativos.filter(i => !pequenos.includes(i)).reduce((s, i) => s + dist[i], 0);
  ativos.forEach(i => { larguras[i] = pequenos.includes(i) ? MIN : (dist[i] / vGrandes) * resto; });
  let cx = x;
  for (const i of [0, 1, 2, 3]) {
    if (!larguras[i]) continue;
    doc.setFillColor(...CORES_DIST[i]); doc.rect(cx, y, larguras[i], h, 'F');
    const p = Math.round((dist[i] / v) * 100);
    if (larguras[i] >= 11) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
      doc.text(`${p}%`, cx + larguras[i] / 2, y + h / 2 + 1.1, { align: 'center' });
    }
    cx += larguras[i];
  }
}

// Agrupa as disciplinas do relatório (todas as dimensões) por professor.
export function disciplinasPorProfessor(dimensoes) {
  const mapa = new Map();
  for (const dim of dimensoes) {
    for (const d of dim.disciplinas || []) {
      const v = (d.perguntas || []).reduce((acc, p) => { acc.ok += p.dist[0] + p.dist[1]; acc.val += p.dist[0] + p.dist[1] + p.dist[2] + p.dist[3]; return acc; }, { ok: 0, val: 0 });
      const item = { ...d, dimensao: dim.nome, satisfacao: v.val ? Math.round((v.ok / v.val) * 1000) / 10 : null };
      const profs = d.professores && d.professores.length ? d.professores : ['Sem professor identificado'];
      for (const p of profs) {
        if (!mapa.has(p)) mapa.set(p, []);
        mapa.get(p).push(item);
      }
    }
  }
  return [...mapa.entries()]
    .map(([professor, lista]) => ({ professor, disciplinas: lista.sort((a, b) => a.disciplina.localeCompare(b.disciplina, 'pt-BR')) }))
    .sort((a, b) => (a.professor === 'Sem professor identificado') - (b.professor === 'Sem professor identificado') || a.professor.localeCompare(b.professor, 'pt-BR'));
}
