// Relatório de Avaliação Docente (o que as coordenações responderam sobre
// os professores) para o Diretor Acadêmico levar à reunião — PDF vetorial
// montado direto com o jsPDF: texto de verdade, leve e nítido.
//
// Página 1: indicadores do ciclo + resultado por curso (ordem alfabética).
// Página 2: média de cada critério do questionário, pontos fortes/a
// desenvolver, distribuição por faixa e como a nota é calculada.
//
// Recebe o construtor do jsPDF por parâmetro (window.jspdf.jsPDF no navegador).

const A4 = { w: 210, h: 297 };
const M = 15;
const W = A4.w - 2 * M;
const TOPO = 18, RODAPE = 16;

const COR = {
  marca: [18, 41, 77], azul: [31, 111, 178], tinta: [13, 27, 51], tinta2: [68, 83, 107], mudo: [100, 116, 139],
  linha: [226, 232, 240], fundo: [246, 248, 251], trilho: [232, 237, 243], branco: [255, 255, 255],
};

// Faixas da nota (escala de 1 a 5 do questionário).
const FAIXAS = [
  { min: 4.5, rotulo: 'Excelente', cor: [21, 128, 61] },
  { min: 4.0, rotulo: 'Muito bom', cor: [101, 163, 13] },
  { min: 3.0, rotulo: 'Regular', cor: [217, 119, 6] },
  { min: -Infinity, rotulo: 'Atenção', cor: [220, 38, 38] },
];
const faixaDe = (n) => FAIXAS.find(f => n >= f.min);

// Nome curto de cada critério (mesma ordem das 10 perguntas do questionário).
const CRITERIOS = [
  'Domínio do conteúdo',
  'Clareza na explicação',
  'Relação com a prática profissional',
  'Planejamento e organização das aulas',
  'Metodologias e recursos',
  'Participação e pensamento crítico',
  'Respeito e relação com os alunos',
  'Atividades e avaliações formativas',
  'Abertura a sugestões',
  'Contribuição para a formação',
];

// As fontes padrão do PDF só têm os caracteres do Windows-1252.
const CP1252 = new Set([
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...Array.from({ length: 96 }, (_, i) => String.fromCharCode(160 + i)),
  ...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ',
]);
const limpa = (s) => [...String(s ?? '')].map(c => (CP1252.has(c) ? c : (/\s/.test(c) ? ' ' : ''))).join('').replace(/[ \t]+/g, ' ').trim();
const num = (v, casas = 2) => v === null || v === undefined ? '—' : v.toFixed(casas).replace('.', ',');
const pct = (v) => `${Math.round(v)}%`;
const alt = (tam) => tam * 0.3528 * 1.3;
const normNome = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Nome digitado pelo coordenador x nome no Edubox: "Matheus Vinicius" bate com
// "MATHEUS VINICIUS OLIVEIRA BRUNK", "Adriana Neri" com "ADRIANA NERY EUGÊNIO".
// O primeiro nome tem que bater; dos demais, aceita 1 a mais que não existe no
// Edubox desde que outros 2 batam ("Rafaeli Fagá Daniel Cordioli"). Erro de 1
// letra vale em palavra de 4+ letras. Comparação feita sempre dentro do curso.
const PALAVRAS_FORA = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'prof', 'profa', 'professor', 'professora']);
const tokens = (s) => normNome(s).replace(/[^a-z ]/g, ' ').split(' ').filter(t => t && !PALAVRAS_FORA.has(t));
function distancia(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
const mesmaPalavra = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && distancia(a, b) <= 1);
export function mesmoProfessor(digitado, nomeEdubox) {
  const a = tokens(digitado), b = tokens(nomeEdubox);
  if (!a.length || !b.length || !mesmaPalavra(a[0], b[0])) return false;
  const resto = a.slice(1);
  const batem = resto.filter(t => b.slice(1).some(e => mesmaPalavra(t, e))).length;
  return batem === resto.length || (batem >= 2 && resto.length - batem <= 1);
}

// Números do relatório a partir das avaliações (já filtradas pelo ciclo).
// `edubox` (opcional) = { semestres, cursos: [{ curso, professores: [nomes] }] }
// vindo de /api/avaliacao-docente/professores-edubox.
export function resumirAvaliacoes(avaliacoes, perguntas, edubox = null) {
  const concluidas = avaliacoes.filter(a => a.status === 'concluida' && a.nota !== null && a.nota !== undefined);
  const pendentes = avaliacoes.filter(a => a.status !== 'concluida').length;
  // concluídas só com N/A em todas as perguntas: não têm nota
  const semNota = avaliacoes.filter(a => a.status === 'concluida').length - concluidas.length;
  const media = (l) => (l.length ? l.reduce((s, a) => s + Number(a.nota), 0) / l.length : null);

  // todo curso com professor no Edubox aparece, mesmo sem nenhuma avaliação
  const nomesCursos = new Set([
    ...concluidas.map(a => a.curso || 'Sem curso'),
    ...(edubox ? edubox.cursos.map(c => c.curso) : []),
  ]);
  const avaliadosGeral = new Set();
  const naoIdentificados = [];
  const porCurso = [...nomesCursos].map(curso => {
    const doCurso = concluidas.filter(a => (a.curso || 'Sem curso') === curso);
    const base = { curso, total: doCurso.length, media: media(doCurso), professores: null, avaliados: null, faltam: null, faltantes: [] };
    if (!edubox) {
      // sem o Edubox: um professor por nome digitado
      const g = new Map();
      avaliacoes.filter(a => a.status === 'concluida' && (a.curso || 'Sem curso') === curso).forEach(a => {
        const k = normNome(a.docente);
        if (!g.has(k)) g.set(k, { nome: String(a.docente || '').trim(), l: [] });
        g.get(k).l.push(a);
      });
      base.professoresDetalhe = [...g.values()].map(({ nome, l }) => ({
        nome, naoEncontrado: false, avaliacoes: l.length, media: media(l.filter(a => a.nota !== null && a.nota !== undefined)),
        periodos: [...new Set(l.flatMap(a => (Array.isArray(a.semestre) ? a.semestre : [a.semestre]).filter(Boolean).map(String)))].sort((x, y) => Number(x) - Number(y)),
      })).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
      return base;
    }
    const profs = (edubox.cursos.find(c => c.curso === curso) || {}).professores || [];
    // avaliado = tem avaliação respondida no curso (mesmo que só com N/A)
    const respondidas = avaliacoes.filter(a => a.status === 'concluida' && (a.curso || 'Sem curso') === curso);
    const avaliados = new Set();
    const porProf = new Map(profs.map(p => [p, []])); // nome no Edubox -> avaliações dele no curso
    const semProf = new Map();                         // nome digitado que não bateu -> avaliações
    respondidas.forEach(a => {
      const achados = profs.filter(p => mesmoProfessor(a.docente, p));
      if (achados.length) achados.forEach(p => { avaliados.add(p); avaliadosGeral.add(p); porProf.get(p).push(a); });
      else {
        naoIdentificados.push({ curso, docente: a.docente });
        const k = String(a.docente || '').trim();
        if (!semProf.has(k)) semProf.set(k, []);
        semProf.get(k).push(a);
      }
    });
    const faltantes = profs.filter(p => !avaliados.has(p));
    // detalhe por professor (usado no relatório de um curso só)
    const detalhe = (nome, l, naoEncontrado) => ({
      nome, naoEncontrado, avaliacoes: l.length, media: media(l.filter(a => a.nota !== null && a.nota !== undefined)),
      periodos: [...new Set(l.flatMap(a => (Array.isArray(a.semestre) ? a.semestre : [a.semestre]).filter(Boolean).map(String)))].sort((x, y) => Number(x) - Number(y)),
    });
    const professoresDetalhe = [
      ...[...porProf.entries()].map(([p, l]) => detalhe(p, l, false)),
      ...[...semProf.entries()].map(([p, l]) => detalhe(p, l, true)),
    ].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return { ...base, professores: profs.length, avaliados: avaliados.size, faltam: faltantes.length, faltantes, professoresDetalhe };
  }).sort((a, b) => a.curso.localeCompare(b.curso, 'pt-BR'));

  const criterios = perguntas.map((pergunta, i) => {
    const vals = concluidas
      .map(a => a.respostas && a.respostas[`p${i + 1}`])
      .map(r => (r && typeof r === 'object' ? r.valor : r))
      .filter(v => v !== undefined && v !== null && v !== 'na')
      .map(Number).filter(n => !isNaN(n));
    return { n: i + 1, nome: CRITERIOS[i] || `Critério ${i + 1}`, pergunta, media: vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null, respostas: vals.length };
  });

  const distribuicao = FAIXAS.map(f => ({ ...f, total: concluidas.filter(a => faixaDe(Number(a.nota)) === f).length }));
  const profsEdubox = edubox ? new Set(edubox.cursos.flatMap(c => c.professores)).size : null;

  return {
    total: concluidas.length,
    pendentes,
    semNota,
    mediaGeral: media(concluidas),
    cursos: porCurso.filter(c => c.total > 0).length,
    cursosTotal: porCurso.length,
    // sem o Edubox, conta os nomes digitados distintos
    professores: edubox ? avaliadosGeral.size : new Set(concluidas.map(a => normNome(a.docente))).size,
    professoresEdubox: profsEdubox,
    semestresEdubox: edubox ? edubox.semestres : [],
    naoIdentificados,
    porCurso,
    criterios,
    distribuicao,
  };
}

export function montarRelatorioDocente(JsPDF, { ciclo, resumo, logo, curso = null, mediaInstitucional = null }) {
  const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  let y = M;

  const fonte = (tam, estilo = 'normal', c = COR.tinta) => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); doc.setTextColor(...c); };
  const quebra = (txt, tam, largura, estilo = 'normal') => { doc.setFont('helvetica', estilo); doc.setFontSize(tam); return doc.splitTextToSize(limpa(txt), largura); };
  const novaPagina = () => { doc.addPage(); y = TOPO + 4; };
  const garantir = (h) => { if (y + h > A4.h - RODAPE) novaPagina(); };
  const titulo = (t, sub) => {
    fonte(13, 'bold', COR.marca); doc.text(t, M, y + 4);
    if (sub) { fonte(8.5, 'normal', COR.mudo); doc.text(sub, A4.w - M, y + 4, { align: 'right' }); }
    y += 7;
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.3); doc.line(M, y, A4.w - M, y);
    y += 5;
  };
  // barra horizontal 0–5 com o valor colorido pela faixa
  const barra = (x, yy, w, h, valor, marcaMedia) => {
    doc.setFillColor(...COR.trilho); doc.roundedRect(x, yy, w, h, h / 2, h / 2, 'F');
    if (valor !== null) {
      const f = faixaDe(valor);
      doc.setFillColor(...f.cor); doc.roundedRect(x, yy, Math.max(h, (valor / 5) * w), h, h / 2, h / 2, 'F');
    }
    if (marcaMedia !== null && marcaMedia !== undefined) {
      const xm = x + (marcaMedia / 5) * w;
      doc.setDrawColor(...COR.marca); doc.setLineWidth(0.4); doc.setLineDashPattern([0.8, 0.8], 0);
      doc.line(xm, yy - 1.2, xm, yy + h + 1.2); doc.setLineDashPattern([], 0);
    }
  };

  // ---------- cabeçalho ----------
  let xTitulo = M;
  if (logo) {
    const hLogo = 14, wLogo = hLogo * (logo.w / logo.h);
    doc.addImage(logo.dataUrl, 'PNG', M, y, wLogo, hLogo);
    xTitulo = M + wLogo + 6;
  }
  fonte(8, 'bold', COR.mudo); doc.text('FATEC IVAIPORÃ · DIREÇÃO ACADÊMICA', xTitulo, y + 4);
  fonte(19, 'bold', COR.marca); doc.text('Relatório de Avaliação Docente', xTitulo, y + 11.5);
  y += 19;
  doc.setDrawColor(...COR.marca); doc.setLineWidth(0.8); doc.line(M, y, A4.w - M, y);
  y += 6;
  fonte(9.5, 'normal', COR.tinta2);
  doc.text(limpa(curso ? `Avaliação dos professores pela coordenação do curso · Ciclo ${ciclo}` : `Avaliação dos professores pelas coordenações de curso · Ciclo ${ciclo}`), M, y);
  fonte(8.5, 'normal', COR.mudo);
  doc.text(`Emitido em ${new Date().toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' })}`, A4.w - M, y, { align: 'right' });
  y += 8;
  if (curso) {
    fonte(8, 'bold', COR.mudo); doc.text('CURSO', M, y);
    fonte(16, 'bold', COR.marca); doc.text(limpa(curso), M, y + 7);
    y += 14;
  }

  // ---------- indicadores ----------
  const gap = 4, wc = (W - 3 * gap) / 4, hc = 27;
  const card = (i, rotulo, valor, sub, destaque) => {
    const x = M + i * (wc + gap);
    if (destaque) { doc.setFillColor(...COR.marca); doc.roundedRect(x, y, wc, hc, 2, 2, 'F'); }
    else { doc.setFillColor(...COR.fundo); doc.setDrawColor(...COR.linha); doc.setLineWidth(0.25); doc.roundedRect(x, y, wc, hc, 2, 2, 'FD'); }
    fonte(6.8, 'bold', destaque ? [190, 205, 230] : COR.mudo); doc.text(rotulo, x + 4, y + 6);
    fonte(21, 'bold', destaque ? COR.branco : COR.tinta); doc.text(valor, x + 4, y + 16);
    if (sub) { const ls = quebra(sub, 6.8, wc - 7).slice(0, 2); fonte(6.8, 'normal', destaque ? [190, 205, 230] : COR.mudo); doc.text(ls, x + 4, y + 21.5 - (ls.length - 1) * 1.4); }
  };
  const r = resumo;
  const comEdubox = r.professoresEdubox !== null;
  // "2026/2" (graduação) e "2026-2" (Medicina) são o mesmo semestre
  const semestre = [...new Set((r.semestresEdubox || []).map(x => String(x).replace('-', '/')))].join(' e ');
  const fora = [r.pendentes ? `${r.pendentes} pendente${r.pendentes > 1 ? 's' : ''}` : '', r.semNota ? `${r.semNota} só N/A` : ''].filter(Boolean).join(' · ');
  card(0, 'AVALIAÇÕES REALIZADAS', String(r.total), fora ? `fora do cálculo: ${fora}` : 'todas concluídas');
  card(1, curso ? 'MÉDIA DO CURSO' : 'MÉDIA GERAL', num(r.mediaGeral), r.mediaGeral === null ? '' : `de 5,00 · ${faixaDe(r.mediaGeral).rotulo.toLowerCase()}${curso && mediaInstitucional !== null ? ` · instituição: ${num(mediaInstitucional)}` : ''}`, true);
  if (comEdubox && curso) {
    const cobertura = r.professoresEdubox ? (r.professores / r.professoresEdubox) * 100 : 0;
    card(2, 'PROFESSORES AVALIADOS', `${r.professores}/${r.professoresEdubox}`, `${pct(cobertura)} dos professores do curso em ${semestre} (Edubox)`);
    card(3, 'FALTAM AVALIAR', String(r.professoresEdubox - r.professores), 'professores do curso sem avaliação no ciclo');
  } else if (comEdubox) {
    const cobertura = r.professoresEdubox ? (r.professores / r.professoresEdubox) * 100 : 0;
    card(2, 'PROFESSORES AVALIADOS', `${r.professores}/${r.professoresEdubox}`, `${pct(cobertura)} dos professores com aula em ${semestre} (Edubox)`);
    card(3, 'FALTAM AVALIAR', String(r.professoresEdubox - r.professores), `professores sem avaliação · ${r.cursos} de ${r.cursosTotal} cursos já avaliaram`);
  } else {
    card(2, 'CURSOS AVALIADOS', String(r.cursos), 'com ao menos 1 avaliação');
    card(3, 'PROFESSORES AVALIADOS', String(r.professores), 'nomes distintos');
  }
  y += hc + 10;

  if (!curso) {
  // ---------- resultado por curso ----------
  titulo('Resultado por curso', comEdubox ? `ordem alfabética · professores do Edubox (${semestre})` : 'ordem alfabética · média de 0 a 5');
  const col = { curso: M + 3, prof: M + 68, aval: M + 85, falta: M + 99, avs: M + 118, media: M + 131, barra: M + 134, faixa: A4.w - M - 2 };
  const wBarra = 24;
  // classificação (Excelente, Muito bom...) à direita da barra
  const classificacao = (media, yt) => {
    if (media === null) { fonte(7.8, 'normal', COR.mudo); doc.text('Sem avaliação', col.faixa, yt, { align: 'right' }); return; }
    const f = faixaDe(media);
    fonte(7.8, 'bold', f.cor); doc.text(f.rotulo, col.faixa, yt, { align: 'right' });
    doc.setFillColor(...f.cor); doc.circle(col.faixa - doc.getTextWidth(f.rotulo) - 2.3, yt - 1.05, 1, 'F');
  };
  const cab = () => {
    doc.setFillColor(...COR.marca); doc.rect(M, y, W, 8, 'F');
    fonte(6.9, 'bold', COR.branco);
    doc.text('CURSO', col.curso, y + 5.2);
    doc.text('PROFESSORES', col.prof, y + 5.2, { align: 'right' });
    doc.text('AVALIADOS', col.aval, y + 5.2, { align: 'right' });
    doc.text('FALTAM', col.falta, y + 5.2, { align: 'right' });
    doc.text('AVALIAÇÕES', col.avs, y + 5.2, { align: 'right' });
    doc.text('MÉDIA', col.media, y + 5.2, { align: 'right' });
    doc.text('0 A 5', col.barra, y + 5.2);
    doc.text('CLASSIFICAÇÃO', col.faixa, y + 5.2, { align: 'right' });
    y += 8;
  };
  cab();
  const hl = 7.5;
  const nOuTraco = (v) => (v === null || v === undefined ? '—' : String(v));
  r.porCurso.forEach((c, i) => {
    if (y + hl > A4.h - RODAPE - 4) { novaPagina(); cab(); }
    if (i % 2 === 1) { doc.setFillColor(...COR.fundo); doc.rect(M, y, W, hl, 'F'); }
    const yt = y + 5.2;
    const nome = quebra(c.curso, 9.3, col.prof - col.curso - 17, 'bold')[0];
    fonte(9.3, 'bold', c.total ? COR.tinta : COR.mudo); doc.text(nome, col.curso, yt);
    fonte(9.3, 'normal', COR.tinta2);
    doc.text(nOuTraco(c.professores), col.prof, yt, { align: 'right' });
    doc.text(nOuTraco(c.avaliados), col.aval, yt, { align: 'right' });
    if (c.faltam !== null) fonte(9.3, 'bold', c.faltam ? FAIXAS[3].cor : FAIXAS[0].cor);
    doc.text(nOuTraco(c.faltam), col.falta, yt, { align: 'right' });
    fonte(9.3, 'normal', COR.tinta2); doc.text(String(c.total), col.avs, yt, { align: 'right' });
    fonte(9.3, 'bold', c.media === null ? COR.mudo : faixaDe(c.media).cor); doc.text(num(c.media), col.media, yt, { align: 'right' });
    barra(col.barra, y + 2.6, wBarra, 2.7, c.media, r.mediaGeral);
    classificacao(c.media, yt);
    y += hl;
  });
  // total geral (professor que dá aula em mais de um curso conta uma vez só)
  doc.setDrawColor(...COR.marca); doc.setLineWidth(0.5); doc.line(M, y, A4.w - M, y);
  const yt = y + 5.5;
  fonte(9.3, 'bold', COR.marca);
  doc.text('Total geral', col.curso, yt);
  if (comEdubox) {
    doc.text(String(r.professoresEdubox), col.prof, yt, { align: 'right' });
    doc.text(String(r.professores), col.aval, yt, { align: 'right' });
    doc.text(String(r.professoresEdubox - r.professores), col.falta, yt, { align: 'right' });
  }
  doc.text(String(r.total), col.avs, yt, { align: 'right' });
  doc.text(num(r.mediaGeral), col.media, yt, { align: 'right' });
  if (r.mediaGeral !== null) { barra(col.barra, y + 2.8, wBarra, 2.7, r.mediaGeral, null); classificacao(r.mediaGeral, yt); }
  y += 8.3;
  doc.line(M, y, A4.w - M, y);
  y += 5;

  // legenda
  fonte(7.3, 'normal', COR.mudo);
  let x = M;
  doc.text('Média:', x, y); x += doc.getTextWidth('Média:') + 2.5;
  [['Excelente', '4,50 a 5,00'], ['Muito bom', '4,00 a 4,49'], ['Regular', '3,00 a 3,99'], ['Atenção', 'abaixo de 3,00']].forEach(([rot, faixa], i) => {
    doc.setFillColor(...FAIXAS[i].cor); doc.circle(x + 1.1, y - 1, 1.1, 'F'); x += 3.4;
    fonte(7.3, 'bold', COR.tinta2); doc.text(rot, x, y); x += doc.getTextWidth(rot) + 1.2;
    fonte(7.3, 'normal', COR.mudo); doc.text(faixa, x, y); x += doc.getTextWidth(faixa) + 3.5;
  });
  doc.setDrawColor(...COR.marca); doc.setLineWidth(0.4); doc.setLineDashPattern([0.8, 0.8], 0);
  doc.line(x + 0.5, y - 2.2, x + 0.5, y + 0.6); doc.setLineDashPattern([], 0);
  fonte(7.3, 'normal', COR.mudo); doc.text(`média geral (${num(r.mediaGeral)})`, x + 2.5, y);
  if (comEdubox) {
    y += 4.2;
    const ls = quebra('Professores = com aula no curso no semestre (Edubox). Quem leciona em mais de um curso conta em cada um; no total, uma vez. Nomes no anexo.', 7.3, W);
    fonte(7.3, 'normal', COR.mudo); doc.text(ls, M, y); y += (ls.length - 1) * alt(7.3);
  }

  } else {
    // ---------- relatório de um curso: resultado por professor ----------
    const cc = r.porCurso.find(c => c.curso === curso) || { professoresDetalhe: [] };
    const lista = cc.professoresDetalhe || [];
    titulo('Resultado por professor', comEdubox ? `ordem alfabética · professores do curso no Edubox (${semestre})` : 'ordem alfabética · média de 0 a 5');
    const colP = { nome: M + 3, avs: M + 92, per: M + 97, media: M + 134, barra: M + 137, faixa: A4.w - M - 2 };
    const wB = 22;
    const cabP = () => {
      doc.setFillColor(...COR.marca); doc.rect(M, y, W, 8, 'F');
      fonte(6.9, 'bold', COR.branco);
      doc.text('PROFESSOR', colP.nome, y + 5.2);
      doc.text('AVALIAÇÕES', colP.avs, y + 5.2, { align: 'right' });
      doc.text('PERÍODOS', colP.per, y + 5.2);
      doc.text('MÉDIA', colP.media, y + 5.2, { align: 'right' });
      doc.text('0 A 5', colP.barra, y + 5.2);
      doc.text('CLASSIFICAÇÃO', colP.faixa, y + 5.2, { align: 'right' });
      y += 8;
    };
    cabP();
    const hlP = 7.3;
    if (!lista.length) { fonte(9, 'italic', COR.mudo); doc.text('Nenhum professor encontrado para este curso.', M + 3, y + 5); y += 8; }
    lista.forEach((p, i) => {
      if (y + hlP > A4.h - RODAPE - 4) { novaPagina(); cabP(); }
      if (i % 2 === 1) { doc.setFillColor(...COR.fundo); doc.rect(M, y, W, hlP, 'F'); }
      const yt = y + 4.9;
      const avaliado = p.avaliacoes > 0;
      const nome = limpa(p.nome) + (p.naoEncontrado ? ' *' : '');
      let tam = 8.8; while (tam > 6.5 && quebra(nome, tam, colP.avs - colP.nome - 18, 'bold').length > 1) tam -= 0.25;
      fonte(tam, 'bold', avaliado ? COR.tinta : COR.mudo); doc.text(quebra(nome, tam, colP.avs - colP.nome - 18, 'bold')[0], colP.nome, yt);
      fonte(8.8, 'normal', COR.tinta2); doc.text(String(p.avaliacoes), colP.avs, yt, { align: 'right' });
      const per = p.periodos.length ? p.periodos.map(x => `${x}º`).join(', ') : '—';
      fonte(8, 'normal', COR.tinta2); doc.text(quebra(per, 8, colP.media - colP.per - 12)[0], colP.per, yt);
      fonte(8.8, 'bold', p.media === null ? COR.mudo : faixaDe(p.media).cor); doc.text(num(p.media), colP.media, yt, { align: 'right' });
      barra(colP.barra, y + 2.4, wB, 2.6, p.media, r.mediaGeral);
      if (!avaliado) { fonte(7.8, 'bold', FAIXAS[3].cor); doc.text('Não avaliado', colP.faixa, yt, { align: 'right' }); }
      else if (p.media === null) { fonte(7.8, 'normal', COR.mudo); doc.text('Só N/A', colP.faixa, yt, { align: 'right' }); }
      else {
        const f = faixaDe(p.media);
        fonte(7.8, 'bold', f.cor); doc.text(f.rotulo, colP.faixa, yt, { align: 'right' });
        doc.setFillColor(...f.cor); doc.circle(colP.faixa - doc.getTextWidth(f.rotulo) - 2.3, yt - 1.05, 1, 'F');
      }
      y += hlP;
    });
    doc.setDrawColor(...COR.marca); doc.setLineWidth(0.5); doc.line(M, y, A4.w - M, y);
    y += 5;
    fonte(7.3, 'normal', COR.mudo);
    let xl = M;
    doc.text('Média:', xl, y); xl += doc.getTextWidth('Média:') + 2.5;
    [['Excelente', '4,50 a 5,00'], ['Muito bom', '4,00 a 4,49'], ['Regular', '3,00 a 3,99'], ['Atenção', 'abaixo de 3,00']].forEach(([rot, faixa], i) => {
      doc.setFillColor(...FAIXAS[i].cor); doc.circle(xl + 1.1, y - 1, 1.1, 'F'); xl += 3.4;
      fonte(7.3, 'bold', COR.tinta2); doc.text(rot, xl, y); xl += doc.getTextWidth(rot) + 1.2;
      fonte(7.3, 'normal', COR.mudo); doc.text(faixa, xl, y); xl += doc.getTextWidth(faixa) + 3.5;
    });
    doc.setDrawColor(...COR.marca); doc.setLineWidth(0.4); doc.setLineDashPattern([0.8, 0.8], 0);
    doc.line(xl + 0.5, y - 2.2, xl + 0.5, y + 0.6); doc.setLineDashPattern([], 0);
    fonte(7.3, 'normal', COR.mudo); doc.text(`média do curso (${num(r.mediaGeral)})`, xl + 2.5, y);
    y += 4.2;
    const nota = [
      comEdubox ? 'Lista = professores com aula no curso no semestre (Edubox). Um professor pode ter mais de uma avaliação (uma por turma/período).' : 'Um professor pode ter mais de uma avaliação (uma por turma/período).',
      lista.some(p => p.naoEncontrado) ? '* Nome digitado na avaliação que não foi encontrado entre os professores do curso no Edubox.' : '',
    ].filter(Boolean).join(' ');
    const ls = quebra(nota, 7.3, W);
    doc.text(ls, M, y); y += (ls.length - 1) * alt(7.3);
  }

  // como ler (caixa compacta no fim da página 1)
  const notas = [
    'Cada avaliação é preenchida pela coordenação do curso, com 10 perguntas na escala 1 Discordo totalmente · 2 Discordo · 3 Nem concordo, nem discordo · 4 Concordo · 5 Concordo totalmente.',
    'Nota da avaliação = média das respostas de 1 a 5 ("Não tenho elementos para avaliar" fica fora). Média do curso = média das notas das suas avaliações; média geral = média de todas as avaliações concluídas do ciclo.',
  ].map(t => quebra(t, 7.4, W - 12));
  const hNotas = 9 + notas.reduce((s2, ls) => s2 + ls.length * alt(7.4) + 1.2, 0);
  y += 7;
  const naPagina1 = y + hNotas <= A4.h - RODAPE;
  if (!naPagina1) novaPagina();
  doc.setFillColor(...COR.fundo); doc.roundedRect(M, y, W, hNotas, 2, 2, 'F');
  fonte(8.5, 'bold', COR.marca); doc.text('Como ler este relatório', M + 5, y + 6);
  let yn = y + 10.5;
  notas.forEach(ls => {
    doc.setFillColor(...COR.azul); doc.circle(M + 6, yn - 0.9, 0.7, 'F');
    fonte(7.4, 'normal', COR.tinta2); doc.text(ls, M + 9, yn);
    yn += ls.length * alt(7.4) + 1.2;
  });
  y += hNotas;

  // ---------- página 2: critérios ----------
  if (naPagina1) novaPagina(); else y += 8;
  titulo('Média por critério avaliado', 'as 10 perguntas do questionário · média de 0 a 5');
  const wB = 58, xB = A4.w - M - wB - 12;
  r.criterios.forEach((c, i) => {
    const ls = quebra(c.pergunta, 7.3, xB - (M + 11) - 6);
    const h = Math.max(13, 5.5 + ls.length * alt(7.3) + 3);
    garantir(h);
    if (i % 2 === 0) { doc.setFillColor(...COR.fundo); doc.rect(M, y, W, h, 'F'); }
    doc.setFillColor(...COR.marca); doc.circle(M + 5, y + 5.2, 3, 'F');
    fonte(8, 'bold', COR.branco); doc.text(String(c.n), M + 5, y + 6.3, { align: 'center' });
    fonte(9.5, 'bold', COR.tinta); doc.text(limpa(c.nome), M + 11, y + 5.6);
    fonte(7.3, 'normal', COR.mudo); doc.text(ls, M + 11, y + 9.6);
    barra(xB, y + 3.6, wB, 3.2, c.media, r.mediaGeral);
    fonte(10, 'bold', c.media === null ? COR.mudo : faixaDe(c.media).cor);
    doc.text(num(c.media), A4.w - M - 1.5, y + 6.4, { align: 'right' });
    y += h;
  });
  y += 7;

  // pontos fortes x a desenvolver
  const validos = r.criterios.filter(c => c.media !== null);
  if (validos.length >= 2) {
    const ord = [...validos].sort((a, b) => b.media - a.media);
    const qtd = Math.min(3, Math.floor(validos.length / 2));
    const fortes = ord.slice(0, qtd), fracos = ord.slice(-qtd).reverse();
    const wq = (W - 6) / 2, hq = 9 + qtd * 6.5;
    garantir(hq + 4);
    const quadro = (xq, tituloQ, lista, cor) => {
      doc.setFillColor(...cor.map(v => Math.round(v + (255 - v) * 0.9))); doc.roundedRect(xq, y, wq, hq, 2, 2, 'F');
      doc.setFillColor(...cor); doc.rect(xq, y, 1.4, hq, 'F');
      fonte(9, 'bold', cor); doc.text(tituloQ, xq + 5, y + 6);
      lista.forEach((c, i) => {
        const yy = y + 12 + i * 6.5;
        fonte(8.5, 'normal', COR.tinta); doc.text(quebra(`${c.n}. ${c.nome}`, 8.5, wq - 22)[0], xq + 5, yy);
        fonte(8.5, 'bold', COR.tinta); doc.text(num(c.media), xq + wq - 4, yy, { align: 'right' });
      });
    };
    quadro(M, 'Pontos fortes (maiores médias)', fortes, FAIXAS[0].cor);
    quadro(M + wq + 6, 'Pontos a desenvolver (menores médias)', fracos, FAIXAS[2].cor);
    y += hq + 9;
  }

  // distribuição por faixa
  garantir(30);
  titulo('Distribuição das avaliações por faixa', `${r.total} avaliações concluídas`);
  const totalD = r.distribuicao.reduce((s, d) => s + d.total, 0) || 1;
  let xd = M;
  doc.setFillColor(...COR.trilho); doc.roundedRect(M, y, W, 7, 1.5, 1.5, 'F');
  r.distribuicao.forEach(d => {
    if (!d.total) return;
    const wd = Math.max(2, (d.total / totalD) * W);
    doc.setFillColor(...d.cor); doc.rect(xd, y, wd, 7, 'F');
    if (wd >= 12) { fonte(7.5, 'bold', COR.branco); doc.text(pct((d.total / totalD) * 100), xd + wd / 2, y + 4.7, { align: 'center' }); }
    xd += wd;
  });
  y += 12;
  const wl = W / 4;
  r.distribuicao.forEach((d, i) => {
    const xl = M + i * wl;
    doc.setFillColor(...d.cor); doc.circle(xl + 1.4, y - 1.1, 1.4, 'F');
    fonte(8.5, 'bold', COR.tinta); doc.text(d.rotulo, xl + 4.5, y);
    fonte(8.5, 'normal', COR.tinta2); doc.text(`${d.total} (${pct((d.total / totalD) * 100)})`, xl + 4.5, y + 4.5);
  });
  y += 13;

  // ---------- anexo: quem falta avaliar (só no geral; no do curso já está na tabela) ----------
  if (comEdubox && !curso) {
    const comFalta = r.porCurso.filter(c => c.faltantes.length);
    novaPagina();
    titulo('Anexo · Professores ainda não avaliados', `${r.professoresEdubox - r.professores} professores · por curso`);
    fonte(7.6, 'normal', COR.mudo);
    const intro = quebra(`Professores com aula no curso em ${semestre} (Edubox) sem nenhuma avaliação respondida pela coordenação desse curso no ciclo ${ciclo}. A conferência é feita pelo nome digitado na avaliação; um nome muito diferente do cadastro pode fazer o professor aparecer aqui mesmo avaliado (veja a lista do fim da página).`, 7.6, W);
    doc.text(intro, M, y); y += intro.length * alt(7.6) + 4;
    const nCol = 3, wCol = W / nCol, lh = 4.2;
    if (!comFalta.length) { fonte(9, 'italic', COR.mudo); doc.text('Todos os professores já foram avaliados.', M, y + 3); y += 8; }
    comFalta.forEach(c => {
      const linhas = Math.ceil(c.faltantes.length / nCol);
      garantir(8 + Math.min(linhas, 3) * lh);
      doc.setFillColor(...COR.fundo); doc.rect(M, y, W, 6.5, 'F');
      fonte(9, 'bold', COR.marca); doc.text(limpa(c.curso), M + 3, y + 4.5);
      fonte(8, 'bold', FAIXAS[3].cor); doc.text(`faltam ${c.faltam} de ${c.professores}`, A4.w - M - 3, y + 4.5, { align: 'right' });
      y += 9;
      for (let l = 0; l < linhas; l++) {
        garantir(lh);
        for (let k = 0; k < nCol; k++) {
          const nome = c.faltantes[l * nCol + k];
          if (!nome) continue;
          // nome longo: diminui a letra até caber na coluna (sem cortar)
          let tam = 8; while (tam > 6 && quebra(nome, tam, wCol - 4).length > 1) tam -= 0.25;
          fonte(tam, 'normal', COR.tinta);
          doc.text(quebra(nome, tam, wCol - 4)[0], M + 3 + k * wCol, y);
        }
        y += lh;
      }
      y += 2.5;
    });
    if (r.naoIdentificados.length) {
      y += 2;
      garantir(12 + r.naoIdentificados.length * lh);
      fonte(9.5, 'bold', COR.marca); doc.text('Avaliações com nome não encontrado no Edubox', M, y + 3); y += 7;
      fonte(7.6, 'normal', COR.mudo);
      doc.text(limpa('O nome digitado não bateu com nenhum professor com aula no curso neste semestre — vale conferir a grafia na avaliação.'), M, y); y += 5;
      r.naoIdentificados.forEach(n => {
        garantir(lh);
        fonte(8, 'bold', COR.tinta2); doc.text(limpa(n.curso), M + 3, y);
        fonte(8, 'normal', COR.tinta); doc.text(limpa(n.docente), M + 55, y);
        y += lh;
      });
    }
  }

  // ---------- cabeçalho e rodapé ----------
  const n = doc.getNumberOfPages();
  for (let p = 1; p <= n; p++) {
    doc.setPage(p);
    if (p > 1) {
      fonte(7.5, 'normal', COR.mudo);
      doc.text(limpa(`Relatório de Avaliação Docente${curso ? ` · ${curso}` : ''} · Ciclo ${ciclo}`), M, 10);
      doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, 12, A4.w - M, 12);
    }
    doc.setDrawColor(...COR.linha); doc.setLineWidth(0.2); doc.line(M, A4.h - 11, A4.w - M, A4.h - 11);
    fonte(7.5, 'normal', COR.mudo);
    doc.text('Relatório de Avaliação Docente · FATEC Ivaiporã', M, A4.h - 7);
    doc.text(`Página ${p} de ${n}`, A4.w - M, A4.h - 7, { align: 'right' });
  }
  return doc;
}
