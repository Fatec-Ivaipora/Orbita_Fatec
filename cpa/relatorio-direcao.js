// Relatório da Direção (CPA) — visão executiva de uma campanha inteira:
// alunos (todos os cursos juntos), docentes ou administrativo. PDF vetorial
// montado com o jsPDF, no formato que a direção usava antes (resumo
// executivo, temas dos comentários, consolidado por dimensão e uma seção por
// dimensão), mas com tudo tirado dos números e dos comentários reais — sem
// frase pronta repetida.
//
// Dados: GET /api/cpa/relatorio-direcao (src/rotas/cpa.js, montarRelatorioDirecao).
// Temas: cpa/temas-cpa.js.

import { analisarTemas, temasEmergentes, temasDoComentario, TEMAS } from './temas-cpa.js?v=1';

const A4 = { w: 210, h: 297 };
const M = 15;
const W = A4.w - 2 * M;
const TOPO = 18, RODAPE = 16;

const COR = {
  marca: [18, 41, 77], azul: [31, 111, 178], tinta: [13, 27, 51], tinta2: [68, 83, 107], mudo: [100, 116, 139],
  linha: [226, 232, 240], fundo: [246, 248, 251], trilho: [232, 237, 243], branco: [255, 255, 255],
  bom: [21, 128, 61], neutro: [100, 116, 139], atencao: [200, 57, 47],
};
const CORES_DIST = [[21, 128, 61], [132, 204, 22], [245, 158, 11], [220, 38, 38]];
const ROT = ['Ótimo', 'Bom', 'Regular', 'Ruim', 'Não sei'];

// Conceito pela média (0–10) e classificação pela distância da média geral.
const CONCEITOS = [
  { min: 9.5, rotulo: 'Excelente', cor: [21, 128, 61] },
  { min: 9.0, rotulo: 'Muito bom', cor: [101, 163, 13] },
  { min: 8.0, rotulo: 'Bom', cor: [31, 111, 178] },
  { min: 7.0, rotulo: 'Regular', cor: [217, 119, 6] },
  { min: -Infinity, rotulo: 'Insuficiente', cor: [220, 38, 38] },
];
const conceitoDe = (m) => CONCEITOS.find(c => m >= c.min);
const CLASSES = {
  forte: { rotulo: 'Ponto forte', cor: [21, 128, 61] },
  estavel: { rotulo: 'Estável', cor: [100, 116, 139] },
  atencao: { rotulo: 'Atenção', cor: [217, 119, 6] },
  prioridade: { rotulo: 'Prioridade', cor: [220, 38, 38] },
};
function classificacaoDe(media, mediaGeral) {
  if (media === null || mediaGeral === null) return CLASSES.estavel;
  const d = media - mediaGeral;
  if (media < 7 || d <= -0.5) return CLASSES.prioridade;
  if (d <= -0.2) return CLASSES.atencao;
  if (d >= 0.3) return CLASSES.forte;
  return CLASSES.estavel;
}

const PUBLICOS = {
  A: { titulo: 'Percepção dos Alunos sobre a Instituição', quem: 'alunos', rotulo: 'ALUNOS' },
  P: { titulo: 'Percepção dos Docentes sobre a Instituição', quem: 'docentes', rotulo: 'DOCENTES' },
  O: { titulo: 'Percepção do Corpo Técnico-Administrativo sobre a Instituição', quem: 'colaboradores do administrativo', rotulo: 'ADMINISTRATIVO' },
};

// As fontes padrão do PDF só têm os caracteres do Windows-1252.
const CP1252 = new Set([
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)),
  ...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ',
]);
const limpa = (s) => [...String(s ?? '')].map(c => (CP1252.has(c) ? c : (/\s/.test(c) ? ' ' : ''))).join('').replace(/[ \t]+/g, ' ').trim();
// siglas voltam para maiúsculas depois do "frase" (o Edubox guarda tudo em CAIXA ALTA)
const SIGLAS = /\b(fatec|pdi|cpa|ead|ava|tcc|nde|ies|enade|mec|rh|ti)\b/g;
const frase = (s) => limpa(s).toLowerCase().replace(/(^\s*[a-zà-ú])/, m => m.toUpperCase()).replace(SIGLAS, m => m.toUpperCase());
const num1 = (v) => (v === null || v === undefined ? '—' : v.toFixed(1).replace('.', ','));
const pct = (v) => (v === null || v === undefined ? '—' : `${String(Math.round(v * 10) / 10).replace('.', ',')}%`);
const alt = (tam) => tam * 0.3528 * 1.3;
const curta = (s, n) => { const t = frase(s); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

const validas = (d) => d[0] + d[1] + d[2] + d[3];
const satisf = (d) => (d && validas(d) ? ((d[0] + d[1]) / validas(d)) * 100 : null);
const somaDist = (lista) => lista.reduce((a, d) => (d ? a.map((v, i) => v + d[i]) : a), [0, 0, 0, 0, 0]);

// Comentário de sugestão concreta (para "Sugestões"): pede algo, tem tamanho razoável.
const SUGESTAO = /\b(poderia|poderiam|deveria|deveriam|sugiro|sugestao|gostaria|precisa|precisamos|falta|faltam|seria bom|seria interessante|ideal seria|melhorar)\b/;
const normTxt = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------- números de cada dimensão e do conjunto ----------
export function analisarDirecao(dados) {
  const dims = dados.dimensoes.map(d => {
    const dist = somaDist(d.perguntas.map(p => p.dist));
    return { ...d, dist, satisfacao: satisf(dist) };
  });
  const comMedia = dims.filter(d => d.mediaGeral !== null);
  const mediaGeral = comMedia.length ? comMedia.reduce((s, d) => s + d.mediaGeral, 0) / comMedia.length : null;
  const distGeral = somaDist(dims.map(d => d.dist));
  dims.forEach(d => { d.classe = classificacaoDe(d.mediaGeral, mediaGeral); d.conceito = d.mediaGeral === null ? null : conceitoDe(d.mediaGeral); });
  const comentarios = dims.flatMap(d => d.comentarios.map(c => ({ ...c, dimensao: d.nome })));
  return {
    dims, mediaGeral, satisfacaoGeral: satisf(distGeral),
    temas: analisarTemas(comentarios), emergentes: temasEmergentes(comentarios),
    totalComentarios: comentarios.length,
    contagem: { bom: comentarios.filter(c => c.classificacao === 'bom').length, neutro: comentarios.filter(c => c.classificacao === 'neutro').length, atencao: comentarios.filter(c => c.classificacao === 'atencao').length },
  };
}

// Pontos positivos / oportunidades de uma dimensão, a partir das perguntas e dos temas dos comentários.
function pontosDaDimensao(d) {
  const perg = d.perguntas.filter(p => p.dist && validas(p.dist) > 0).map(p => ({ ...p, sat: satisf(p.dist), neg: ((p.dist[2] + p.dist[3]) / validas(p.dist)) * 100 }));
  const temas = analisarTemas(d.comentarios);
  const positivos = [], melhorias = [];
  [...perg].sort((a, b) => b.sat - a.sat).filter(p => p.sat >= 85).slice(0, 2)
    .forEach(p => positivos.push(`Alta aprovação (${pct(p.sat)} Ótimo + Bom): ${curta(p.pergunta, 95)}`));
  temas.filter(t => t.elogios >= 2 && t.elogios >= t.criticas).sort((a, b) => b.elogios - a.elogios).slice(0, 2)
    .forEach(t => positivos.push(`Elogios sobre ${t.nome.toLowerCase()} (${plural(t.elogios, 'comentário', 'comentários')})`));
  [...perg].sort((a, b) => b.neg - a.neg).filter(p => p.neg >= 8).slice(0, 2)
    .forEach(p => melhorias.push(`${pct(p.neg)} de Regular + Ruim: ${curta(p.pergunta, 95)}`));
  temas.filter(t => t.criticas >= 2).sort((a, b) => b.criticas - a.criticas).slice(0, 3)
    .forEach(t => melhorias.push(`Críticas sobre ${t.nome.toLowerCase()} (${plural(t.criticas, 'comentário', 'comentários')})`));
  return { positivos, melhorias, temas };
}

// Comentários que vão no relatório: sugestões concretas primeiro, depois um elogio.
function escolherComentarios(comentarios, qtd = 3) {
  const tamanhoBom = (c) => c.texto.length >= 40 && c.texto.length <= 480;
  const vistos = new Set();
  const unicos = comentarios.filter(c => { const k = normTxt(c.texto).replace(/\W+/g, ''); if (vistos.has(k)) return false; vistos.add(k); return true; });
  // mais temas citados = comentário mais informativo
  const peso = (c) => temasDoComentario(c.texto).length * 100 + Math.min(c.texto.length, 300);
  const sugestoes = unicos.filter(c => c.classificacao === 'atencao' && tamanhoBom(c) && SUGESTAO.test(normTxt(c.texto))).sort((a, b) => peso(b) - peso(a)).slice(0, qtd);
  const elogio = unicos.filter(c => c.classificacao === 'bom' && tamanhoBom(c)).sort((a, b) => peso(b) - peso(a))[0];
  return { sugestoes, elogio };
}

export function montarRelatorioDirecao(JsPDF, { dados, tipo, logo }) {
  const pub = PUBLICOS[tipo] || PUBLICOS.A;
  const an = analisarDirecao(dados);
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  let y = M;

  const fonte = (tam, estilo = 'normal', c = COR.tinta) => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); doc.setTextColor(...c); };
  const quebra = (txt, tam, largura, estilo = 'normal') => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); return doc.splitTextToSize(limpa(txt), largura); };
  const novaPagina = () => { doc.addPage(); y = TOPO + 4; };
  const garantir = (h) => { if (y + h > A4.h - RODAPE) novaPagina(); };
  const titulo = (t, sub) => {
    garantir(16);
    fonte(13, 'bold', COR.marca); doc.text(limpa(t), M, y + 4);
    if (sub) { fonte(8.3, 'normal', COR.mudo); doc.text(limpa(sub), A4.w - M, y + 4, { align: 'right' }); }
    y += 7;
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.3); doc.line(M, y, A4.w - M, y);
    y += 5;
  };
  const paragrafo = (txt, tam = 8.8, cor = COR.tinta2, largura = W, x = M) => {
    const ls = quebra(txt, tam, largura);
    garantir(ls.length * alt(tam) + 1);
    fonte(tam, 'normal', cor); doc.text(ls, x, y + 3); y += ls.length * alt(tam) + 2;
  };
  const chip = (x, yy, rotulo, cor, alinhar = 'left') => {
    fonte(7.2, 'bold', COR.branco);
    const w = doc.getTextWidth(rotulo) + 5;
    const xi = alinhar === 'right' ? x - w : x;
    doc.setFillColor(...cor); doc.roundedRect(xi, yy - 3.4, w, 4.8, 1.2, 1.2, 'F');
    doc.text(rotulo, xi + 2.5, yy);
    return w;
  };
  // barra empilhada Ótimo/Bom/Regular/Ruim (Não sei fica fora, como na satisfação)
  const barraDist = (x, yy, w, h, dist) => {
    const v = validas(dist);
    doc.setFillColor(...COR.trilho); doc.roundedRect(x, yy, w, h, 1, 1, 'F');
    if (!v) return;
    let cx = x;
    [0, 1, 2, 3].forEach(i => {
      if (!dist[i]) return;
      const wi = Math.max(1.4, (dist[i] / v) * w);
      doc.setFillColor(...CORES_DIST[i]); doc.rect(cx, yy, Math.min(wi, x + w - cx), h, 'F');
      const p = Math.round((dist[i] / v) * 100);
      if (wi >= 10) { fonte(7.2, 'bold', COR.branco); doc.text(`${p}%`, cx + wi / 2, yy + h / 2 + 1, { align: 'center' }); }
      cx += wi;
    });
  };
  // lista com marcador colorido
  const lista = (itens, cor, largura = W - 4, x = M) => {
    itens.forEach(t => {
      const ls = quebra(t, 8.5, largura - 4);
      garantir(ls.length * alt(8.5) + 1.5);
      doc.setFillColor(...cor); doc.circle(x + 1.2, y + 2, 0.9, 'F');
      fonte(8.5, 'normal', COR.tinta); doc.text(ls, x + 4, y + 3);
      y += ls.length * alt(8.5) + 1.6;
    });
  };
  const citacao = (texto, cor) => {
    // sem aspas que o próprio aluno já colocou, e começando com maiúscula
    const t = limpa(texto).replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/^\p{Ll}/u, m => m.toUpperCase());
    const ls = quebra(`"${t}"`, 8.3, W - 9);
    const lh = alt(8.3);
    // comentário longo demais para o resto da página começa na próxima
    if (y + ls.length * lh + 4 > A4.h - RODAPE && ls.length * lh + 4 < A4.h - RODAPE - TOPO - 4) novaPagina();
    const h = ls.length * lh + 3.5;
    doc.setFillColor(...cor.map(v => Math.round(v + (255 - v) * 0.92))); doc.rect(M, y, W, h, 'F');
    doc.setFillColor(...cor); doc.rect(M, y, 1, h, 'F');
    fonte(8.3, 'italic', COR.tinta); doc.text(ls, M + 4.5, y + 2 + lh * 0.75);
    y += h + 2;
  };

  // ============ capa + resumo executivo ============
  let xTitulo = M;
  if (logo) {
    const hLogo = 14, wLogo = hLogo * (logo.w / logo.h);
    doc.addImage(logo.dataUrl, 'PNG', M, y, wLogo, hLogo);
    xTitulo = M + wLogo + 6;
  }
  fonte(8, 'bold', COR.mudo); doc.text(`COMISSÃO PRÓPRIA DE AVALIAÇÃO (CPA) · ${pub.rotulo}`, xTitulo, y + 4);
  fonte(18, 'bold', COR.marca); doc.text('Relatório de Avaliação Institucional', xTitulo, y + 11.5);
  y += 19;
  doc.setDrawColor(...COR.marca); doc.setLineWidth(0.8); doc.line(M, y, A4.w - M, y);
  y += 6;
  fonte(10, 'bold', COR.tinta2); doc.text(limpa(pub.titulo), M, y);
  fonte(8.5, 'normal', COR.mudo);
  doc.text(`Emitido em ${new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })}`, A4.w - M, y, { align: 'right' });
  y += 5;
  fonte(8.8, 'normal', COR.tinta2);
  doc.text(limpa(`Campanha: ${dados.avaliacao.descricao}${dados.avaliacao.semava ? ` · semestre ${dados.avaliacao.semava}` : ''}`), M, y);
  y += 8;

  titulo('Resumo executivo');
  const gap = 4, wc = (W - 3 * gap) / 4, hc = 25;
  const card = (i, rotulo, valor, sub, destaque) => {
    const x = M + i * (wc + gap);
    if (destaque) { doc.setFillColor(...COR.marca); doc.roundedRect(x, y, wc, hc, 2, 2, 'F'); }
    else { doc.setFillColor(...COR.fundo); doc.setDrawColor(...COR.linha); doc.setLineWidth(0.25); doc.roundedRect(x, y, wc, hc, 2, 2, 'FD'); }
    fonte(6.8, 'bold', destaque ? [190, 205, 230] : COR.mudo); doc.text(rotulo, x + 4, y + 6);
    fonte(20, 'bold', destaque ? COR.branco : COR.tinta); doc.text(valor, x + 4, y + 15.5);
    if (sub) { const ls = quebra(sub, 6.8, wc - 7).slice(0, 2); fonte(6.8, 'normal', destaque ? [190, 205, 230] : COR.mudo); doc.text(ls, x + 4, y + 20.5 - (ls.length - 1) * 1.4); }
  };
  card(0, 'RESPONDENTES', String(dados.respondentes), tipo === 'A' && dados.cursos ? `${pub.quem} de ${plural(dados.cursos, 'curso', 'cursos')}` : pub.quem);
  card(1, 'MÉDIA GERAL (0 A 10)', num1(an.mediaGeral), an.mediaGeral === null ? '' : `conceito ${conceitoDe(an.mediaGeral).rotulo.toLowerCase()} · média das dimensões`, true);
  card(2, 'SATISFAÇÃO GERAL', pct(an.satisfacaoGeral), 'respostas Ótimo + Bom ("Não sei" fora da base)');
  card(3, 'DIMENSÕES AVALIADAS', String(an.dims.length), `${an.totalComentarios} comentários analisados`);
  y += hc + 7;

  paragrafo(`Este relatório consolida a percepção dos ${pub.quem} sobre as dimensões institucionais avaliadas na campanha "${limpa(dados.avaliacao.descricao)}". `
    + `A média geral foi ${num1(an.mediaGeral)} (de 0 a 10) e ${pct(an.satisfacaoGeral)} das respostas às perguntas foram Ótimo ou Bom. `
    + `Dos ${an.totalComentarios} comentários escritos, ${an.contagem.bom} são elogios, ${an.contagem.atencao} apontam algo a melhorar e ${an.contagem.neutro} são neutros.`);
  y += 2;

  // destaques x oportunidades (dimensões)
  const ord = [...an.dims].filter(d => d.mediaGeral !== null).sort((a, b) => b.mediaGeral - a.mediaGeral);
  const fortes = ord.slice(0, 3);
  const fracas = ord.filter(d => d.mediaGeral < an.mediaGeral).slice(-3).reverse();
  const wq = (W - 6) / 2;
  const linhasQ = (l) => l.map(d => quebra(`${d.nome} (${num1(d.mediaGeral)})`, 8.2, wq - 9));
  const lf = linhasQ(fortes), lo = fracas.length ? linhasQ(fracas) : [quebra('Nenhuma dimensão ficou abaixo da média geral.', 8.2, wq - 9)];
  const hq = 10 + Math.max(lf.reduce((s, l) => s + l.length * alt(8.2) + 1.6, 0), lo.reduce((s, l) => s + l.length * alt(8.2) + 1.6, 0));
  garantir(hq + 4);
  const quadro = (xq, tituloQ, linhas, cor) => {
    doc.setFillColor(...cor.map(v => Math.round(v + (255 - v) * 0.9))); doc.roundedRect(xq, y, wq, hq, 2, 2, 'F');
    doc.setFillColor(...cor); doc.rect(xq, y, 1.4, hq, 'F');
    fonte(9, 'bold', cor); doc.text(tituloQ, xq + 5, y + 6);
    let yy = y + 11;
    linhas.forEach(ls => { doc.setFillColor(...cor); doc.circle(xq + 6, yy - 1, 0.8, 'F'); fonte(8.2, 'normal', COR.tinta); doc.text(ls, xq + 8.5, yy); yy += ls.length * alt(8.2) + 1.6; });
  };
  quadro(M, 'Dimensões com melhor desempenho', lf, CLASSES.forte.cor);
  quadro(M + wq + 6, 'Dimensões com oportunidade de melhoria', lo, CLASSES.atencao.cor);
  y += hq + 8;

  // temas mais mencionados
  titulo('Temas mais mencionados nos comentários', 'cada comentário pode citar mais de um tema');
  const temasTop = an.temas.slice(0, 8);
  if (!temasTop.length) paragrafo('Não houve comentários suficientes para identificar temas.');
  else {
    const cT = { nome: M + 2, men: M + 92, elo: M + 112, cri: M + 132, barra: M + 137 };
    const wT = A4.w - M - 2 - cT.barra;
    garantir(8 + temasTop.length * 6.6);
    doc.setFillColor(...COR.marca); doc.rect(M, y, W, 7, 'F');
    fonte(6.9, 'bold', COR.branco);
    doc.text('TEMA', cT.nome, y + 4.7); doc.text('MENÇÕES', cT.men, y + 4.7, { align: 'right' });
    doc.text('ELOGIOS', cT.elo, y + 4.7, { align: 'right' }); doc.text('CRÍTICAS', cT.cri, y + 4.7, { align: 'right' });
    doc.text('ELOGIO · NEUTRO · CRÍTICA', cT.barra, y + 4.7);
    y += 7;
    temasTop.forEach((t, i) => {
      if (i % 2 === 1) { doc.setFillColor(...COR.fundo); doc.rect(M, y, W, 6.6, 'F'); }
      const yt = y + 4.5;
      fonte(8.6, 'bold', COR.tinta); doc.text(limpa(t.nome), cT.nome, yt);
      fonte(8.6, 'normal', COR.tinta2); doc.text(String(t.mencoes), cT.men, yt, { align: 'right' });
      fonte(8.6, 'bold', COR.bom); doc.text(String(t.elogios), cT.elo, yt, { align: 'right' });
      fonte(8.6, 'bold', COR.atencao); doc.text(String(t.criticas), cT.cri, yt, { align: 'right' });
      let bx = cT.barra;
      [[t.elogios, COR.bom], [t.neutros, [203, 213, 225]], [t.criticas, COR.atencao]].forEach(([n, cor]) => {
        if (!n) return; const wi = (n / t.mencoes) * wT; doc.setFillColor(...cor); doc.rect(bx, y + 2, wi, 2.6, 'F'); bx += wi;
      });
      y += 6.6;
    });
    y += 5;
  }

  // temas emergentes
  titulo('Temas emergentes', 'assuntos que se repetem e não estão na lista de temas');
  if (!an.emergentes.length) paragrafo('Nenhum assunto novo apareceu com frequência suficiente nesta campanha: os comentários se concentram nos temas acima.');
  else {
    paragrafo('Expressões que se repetem em vários comentários, quase sempre com crítica ou pedido, e que não se encaixam nos temas já mapeados. Vale considerar incluir esses assuntos nos próximos instrumentos da CPA.', 8.3, COR.mudo);
    an.emergentes.forEach(e => {
      const ex = e.exemplo ? quebra(`"${e.exemplo.length > 220 ? e.exemplo.slice(0, 219).replace(/\s+\S*$/, '') + '…' : e.exemplo}"`, 7.6, W - 52) : [];
      const h = Math.max(6, ex.length * alt(7.6) + 2.5);
      garantir(h + 1);
      fonte(8.8, 'bold', COR.tinta); doc.text(frase(e.termo), M + 2, y + 4);
      fonte(7.4, 'normal', COR.mudo); doc.text(`${plural(e.comentarios, 'comentário', 'comentários')}`, M + 2, y + 7.6);
      if (ex.length) { fonte(7.6, 'italic', COR.tinta2); doc.text(ex, M + 50, y + 4); }
      y += h + 2;
      doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, y - 1, A4.w - M, y - 1);
    });
    y += 3;
  }

  // ============ consolidado por dimensão ============
  novaPagina();
  titulo('Consolidado por dimensão', 'média de 0 a 10 · satisfação = Ótimo + Bom');
  const cD = { nome: M + 2, resp: M + 104, media: M + 120, sat: M + 138, conc: M + 142, classe: A4.w - M - 2 };
  const cabD = () => {
    doc.setFillColor(...COR.marca); doc.rect(M, y, W, 7.5, 'F');
    fonte(6.9, 'bold', COR.branco);
    doc.text('DIMENSÃO', cD.nome, y + 4.9); doc.text('RESPOSTAS', cD.resp, y + 4.9, { align: 'right' });
    doc.text('MÉDIA', cD.media, y + 4.9, { align: 'right' }); doc.text('SATISF.', cD.sat, y + 4.9, { align: 'right' });
    doc.text('CONCEITO', cD.conc, y + 4.9); doc.text('CLASSIFICAÇÃO', cD.classe, y + 4.9, { align: 'right' });
    y += 7.5;
  };
  cabD();
  an.dims.forEach((d, i) => {
    const ls = quebra(d.nome, 8.3, cD.resp - cD.nome - 20, 'bold');
    const h = Math.max(7.5, ls.length * alt(8.3) + 3.5);
    if (y + h > A4.h - RODAPE - 4) { novaPagina(); cabD(); }
    if (i % 2 === 1) { doc.setFillColor(...COR.fundo); doc.rect(M, y, W, h, 'F'); }
    const yt = y + 4.8;
    fonte(8.3, 'bold', COR.tinta); doc.text(ls, cD.nome, yt);
    fonte(8.6, 'normal', COR.tinta2); doc.text(String(d.totalAvaliacoes), cD.resp, yt, { align: 'right' });
    fonte(8.8, 'bold', d.conceito ? d.conceito.cor : COR.mudo); doc.text(num1(d.mediaGeral), cD.media, yt, { align: 'right' });
    fonte(8.6, 'normal', COR.tinta2); doc.text(pct(d.satisfacao), cD.sat, yt, { align: 'right' });
    fonte(8.2, 'bold', d.conceito ? d.conceito.cor : COR.mudo); doc.text(d.conceito ? d.conceito.rotulo : '—', cD.conc, yt);
    chip(cD.classe, yt, d.classe.rotulo, d.classe.cor, 'right');
    y += h;
  });
  doc.setDrawColor(...COR.marca); doc.setLineWidth(0.5); doc.line(M, y, A4.w - M, y);
  y += 5;
  paragrafo(`Conceito pela média: Excelente 9,5 ou mais · Muito bom 9,0 a 9,4 · Bom 8,0 a 8,9 · Regular 7,0 a 7,9 · Insuficiente abaixo de 7,0. `
    + `Classificação comparada à média geral (${num1(an.mediaGeral)}): Ponto forte = 0,3 ou mais acima · Estável = até 0,2 abaixo ou 0,2 acima · Atenção = 0,2 a 0,5 abaixo · Prioridade = mais de 0,5 abaixo (ou média menor que 7,0).`, 7.6, COR.mudo);
  y += 3;

  // matriz de prioridades (temas) + recomendações
  const comCritica = an.temas.filter(t => t.criticas > 0).sort((a, b) => b.criticas - a.criticas);
  const maxCrit = comCritica[0]?.criticas || 0;
  // alta = muito criticado (30%+ do tema mais criticado) E crítica é a maioria das opiniões do tema
  const alta = comCritica.filter(t => t.criticas >= Math.max(3, maxCrit * 0.3) && t.criticas / (t.criticas + t.elogios) >= 0.5);
  const media = comCritica.filter(t => !alta.includes(t) && t.criticas >= Math.max(2, maxCrit * 0.1));
  const baixa = comCritica.filter(t => !alta.includes(t) && !media.includes(t));
  titulo('Matriz de prioridades (temas com crítica)', 'número = comentários com crítica');
  [['Alta prioridade', alta, CLASSES.prioridade.cor], ['Média prioridade', media, CLASSES.atencao.cor], ['Baixa prioridade', baixa, CLASSES.estavel.cor]].forEach(([rot, l, cor]) => {
    const txt = l.length ? l.map(t => `${t.nome} (${t.criticas})`).join(' · ') : '—';
    const ls = quebra(txt, 8.4, W - 42);
    garantir(ls.length * alt(8.4) + 3);
    chip(M, y + 3.4, rot, cor);
    fonte(8.4, 'normal', COR.tinta); doc.text(ls, M + 38, y + 3.4);
    y += Math.max(6.5, ls.length * alt(8.4) + 3);
  });
  y += 3;

  titulo('Recomendações');
  const rec = [];
  const prio = an.dims.filter(d => d.classe === CLASSES.prioridade), aten = an.dims.filter(d => d.classe === CLASSES.atencao);
  if (prio.length) rec.push(`Elaborar plano de ação com prazo para as dimensões em Prioridade: ${prio.map(d => d.nome).join('; ')}.`);
  if (aten.length) rec.push(`Acompanhar a cada semestre as dimensões em Atenção: ${aten.map(d => d.nome).join('; ')}.`);
  if (alta.length) rec.push(`Tratar os temas de alta prioridade nos comentários: ${alta.map(t => t.nome.toLowerCase()).join(', ')}.`);
  if (an.emergentes.length) rec.push(`Considerar nos próximos instrumentos da CPA os assuntos emergentes: ${an.emergentes.slice(0, 5).map(e => frase(e.termo).toLowerCase()).join(', ')}.`);
  rec.push(`Divulgar os resultados aos ${pub.quem}, mostrando o que será feito a partir desta avaliação.`);
  rec.push('Comparar com o ciclo anterior para acompanhar a evolução das dimensões e o efeito das ações.');
  lista(rec, COR.azul);

  // ============ uma seção por dimensão ============
  an.dims.forEach(d => {
    novaPagina();
    fonte(7.6, 'bold', COR.mudo); doc.text('DIMENSÃO', M, y + 2);
    y += 4;
    const tl = quebra(d.nome, 13.5, W, 'bold');
    fonte(13.5, 'bold', COR.marca); doc.text(tl, M, y + 4.5); y += tl.length * alt(13.5) + 3;

    // ficha
    const wf = (W - 12) / 4, hf = 15;
    const ficha = (i, rot, val, cor) => {
      const x = M + i * (wf + 4);
      doc.setFillColor(...COR.fundo); doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.roundedRect(x, y, wf, hf, 1.5, 1.5, 'FD');
      fonte(6.6, 'bold', COR.mudo); doc.text(rot, x + 3, y + 5);
      fonte(12.5, 'bold', cor || COR.tinta); doc.text(val, x + 3, y + 11.8);
    };
    ficha(0, 'MÉDIA (0 A 10)', num1(d.mediaGeral), d.conceito && d.conceito.cor);
    ficha(1, 'CONCEITO', d.conceito ? d.conceito.rotulo : '—', d.conceito && d.conceito.cor);
    ficha(2, 'RESPOSTAS', String(d.totalAvaliacoes));
    ficha(3, 'SATISFAÇÃO', pct(d.satisfacao));
    y += hf + 4;
    chip(M, y + 3, d.classe.rotulo, d.classe.cor);
    const pd = pontosDaDimensao(d);
    const dif = d.mediaGeral !== null && an.mediaGeral !== null ? d.mediaGeral - an.mediaGeral : null;
    const temasTxt = pd.temas.slice(0, 3).map(t => `${t.nome.toLowerCase()} (${t.mencoes})`).join(', ');
    const analise = [
      dif === null ? '' : `Média ${num1(d.mediaGeral)}, ${Math.abs(dif) < 0.05 ? 'igual à' : `${num1(Math.abs(dif))} ${dif > 0 ? 'acima' : 'abaixo'} da`} média geral (${num1(an.mediaGeral)}).`,
      d.satisfacao === null ? '' : `${pct(d.satisfacao)} das respostas foram Ótimo ou Bom.`,
      d.comentarios.length ? `${plural(d.comentarios.length, 'comentário', 'comentários')}${temasTxt ? `; temas mais citados: ${temasTxt}` : ''}.` : 'Sem comentários escritos nesta dimensão.',
    ].filter(Boolean).join(' ');
    const lsA = quebra(analise, 8.6, W - 30);
    fonte(8.6, 'normal', COR.tinta2); doc.text(lsA, M + 28, y + 3);
    y += Math.max(6, lsA.length * alt(8.6) + 2) + 3;

    // perguntas
    if (d.perguntas.length) {
      fonte(10.5, 'bold', COR.marca); doc.text('Questões avaliadas', M, y + 3); y += 8;
      let xl = M;
      fonte(7.6, 'normal', COR.tinta2);
      ROT.slice(0, 4).forEach((r, i) => { doc.setFillColor(...CORES_DIST[i]); doc.rect(xl, y - 2.4, 2.8, 2.8, 'F'); doc.text(r, xl + 4, y); xl += doc.getTextWidth(r) + 8.5; });
      fonte(7.6, 'italic', COR.mudo); doc.text('"Não sei" fica fora das porcentagens', xl + 1, y);
      y += 4;
      d.perguntas.forEach(p => {
        const ls = quebra(frase(p.pergunta), 8.6, W, 'bold');
        garantir(ls.length * alt(8.6) + 13);
        fonte(8.6, 'bold', COR.tinta); doc.text(ls, M, y + 3); y += ls.length * alt(8.6) + 1.3;
        if (p.dist) {
          barraDist(M, y, W, 5.5, p.dist); y += 5.5;
          const ns = p.dist[4], tot = validas(p.dist) + ns;
          fonte(7.6, 'normal', COR.tinta2);
          doc.text(ROT.map((r, i) => `${r} ${p.dist[i]}`).join('  ·  ') + (tot ? `  (Não sei = ${pct((ns / tot) * 100)})` : ''), M, y + 3.6);
          fonte(7.8, 'bold', COR.tinta); doc.text(`Satisfação: ${pct(satisf(p.dist))}`, A4.w - M, y + 3.6, { align: 'right' });
          y += 7.5;
        } else {
          fonte(7.8, 'normal', COR.mudo); doc.text(`Média ${p.media === null ? '—' : String(p.media).replace('.', ',')} · ${p.respostas} respostas`, M, y + 3); y += 6.5;
        }
      });
      y += 2;
    }

    // pontos positivos x oportunidades
    garantir(18);
    fonte(10.5, 'bold', COR.bom); doc.text('Pontos positivos', M, y + 3); y += 5.5;
    lista(pd.positivos.length ? pd.positivos : ['Nenhum destaque acima de 85% de satisfação nas perguntas desta dimensão.'], COR.bom);
    y += 2;
    garantir(14);
    fonte(10.5, 'bold', COR.atencao); doc.text('Oportunidades de melhoria', M, y + 3); y += 5.5;
    lista(pd.melhorias.length ? pd.melhorias : ['Nenhum ponto com crítica recorrente nesta dimensão.'], COR.atencao);
    y += 2;

    // sugestões e comentários
    const { sugestoes, elogio } = escolherComentarios(d.comentarios);
    if (sugestoes.length || elogio) {
      garantir(16);
      fonte(10.5, 'bold', COR.marca); doc.text('Sugestões e comentários representativos', M, y + 3); y += 6;
      sugestoes.forEach(c => citacao(c.texto, COR.atencao));
      if (elogio) citacao(elogio.texto, COR.bom);
    }
  });

  // ---------- cabeçalho e rodapé ----------
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    if (p > 1) {
      fonte(7.5, 'normal', COR.mudo);
      doc.text(limpa(`Relatório de Avaliação Institucional · ${pub.rotulo} · ${dados.avaliacao.descricao}`), M, 10);
      doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, 12, A4.w - M, 12);
    }
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, A4.h - 11, A4.w - M, A4.h - 11);
    fonte(7.5, 'normal', COR.mudo);
    doc.text('Comissão Própria de Avaliação (CPA) · FATEC Ivaiporã', M, A4.h - 7);
    doc.text(`Página ${p} de ${n}`, A4.w - M, A4.h - 7, { align: 'right' });
  }
  return doc;
}

export { TEMAS };
