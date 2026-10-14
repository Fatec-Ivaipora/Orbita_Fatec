// ==========================================================================
// Folha de respostas (Correção de Provas) — uma página A4 por aluno, no padrão dos relatórios da FATEC:
// logo, nome da avaliação, curso, turma, aluno, quais questões são de qual disciplina, e a área de
// respostas com os 4 quadrados pretos e o código que o celular lê. Desenhada em SVG com medidas em mm,
// as mesmas do leitor (leitor.js) — por isso não depende do tamanho da impressão.
// ==========================================================================
import { L, LETRAS, posBolinha, posBit, codificar } from './leitor.js';

const MIN = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em']);
const tituloCaso = (s) => String(s || '').toLowerCase().split(' ').map((p, i) => (i && MIN.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1))).join(' ');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FX = 15, FY = 103;      // onde fica o quadrado do canto superior esquerdo na página
const AZUL = '#1B3A4B', VERDE = '#34B3A0', CINZA = '#64748b';

// faixas de questões por disciplina: [{ de, ate, nome }]
export function faixas(questoes) {
  const out = [];
  questoes.forEach((q, i) => {
    const d = q.d || '';
    const u = out[out.length - 1];
    if (u && u.nome === d) u.ate = i + 1; else out.push({ de: i + 1, ate: i + 1, nome: d });
  });
  return out.filter(f => f.nome);
}
export const codigoLegivel = (cod, i) => `${String(cod).padStart(4, '0')}-${String(i + 1).padStart(3, '0')}`;

function pagina(av, aluno, turma, logo) {
  const n = av.questoes.length, nAlt = av.nAlt || 5;
  const disc = faixas(av.questoes);
  const P = (x, y) => [FX + x, FY + y];
  let s = '';
  // ---- cabeçalho no padrão FATEC ----
  s += `<image href="${logo}" x="15" y="9" height="15" width="48" preserveAspectRatio="xMinYMid meet"/>`;
  s += `<text x="195" y="15" text-anchor="end" font-size="5.4" font-weight="700" fill="${AZUL}">FOLHA DE RESPOSTAS</text>`;
  s += `<text x="195" y="21" text-anchor="end" font-size="3.5" fill="${CINZA}">FATEC Ivaiporã · ${esc(tituloCaso(turma ? turma.curso : ''))}</text>`;
  s += `<rect x="15" y="27" width="180" height="0.9" fill="${AZUL}"/>`;
  s += `<text x="15" y="33.8" font-size="4.6" font-weight="700" fill="${AZUL}">${esc(av.nome)}</text>`;
  const tipoTxt = { bimestral: 'Prova bimestral', exame: 'Exame', simulado: 'Simulado', ead: 'Prova EAD', dp: 'Prova de DP', outra: '' }[av.tipo] || '';
  const discTxt = av.disciplina && av.disciplina !== 'Várias (simulado)' ? tituloCaso(av.disciplina) : '';
  s += `<text x="195" y="33.8" text-anchor="end" font-size="3.4" fill="${CINZA}">${av.data ? new Date(av.data + 'T12:00:00').toLocaleDateString('pt-BR') : ''}${av.valorTotal ? ` · valor ${String(av.valorTotal).replace('.', ',')}` : ''} · ${n} questões</text>`;
  if (discTxt || tipoTxt) s += `<text x="15" y="38.6" font-size="3" fill="${AZUL}"><tspan font-weight="700">${esc([tipoTxt, av.bimestre ? `${av.bimestre}º bimestre` : ''].filter(Boolean).join(' · '))}</tspan>${discTxt ? `  ·  Disciplina: ${esc(discTxt.length > 70 ? discTxt.slice(0, 68) + '…' : discTxt)}` : ''}</text>`;
  // caixa do aluno
  s += `<rect x="15" y="41.5" width="180" height="19.5" rx="1.5" fill="none" stroke="#cbd5e1" stroke-width="0.3"/>`;
  s += `<text x="19" y="46.3" font-size="2.5" fill="${CINZA}" letter-spacing="0.15">ALUNO(A)</text>`;
  // nome comprido diminui pra não invadir o código da folha (à direita)
  const tamNome = aluno.nome.length > 56 ? 3.3 : aluno.nome.length > 44 ? 4 : 5;
  s += `<text x="19" y="52.4" font-size="${tamNome}" font-weight="700" fill="#0b1f33">${esc(aluno.nome.length > 70 ? aluno.nome.slice(0, 68) + '…' : aluno.nome)}</text>`;
  s += `<text x="19" y="58.2" font-size="3.2" fill="#334155">Turma ${esc(turma ? turma.turma : '')} · Matrícula ${esc(aluno.mat)}</text>`;
  s += `<text x="191" y="46.3" text-anchor="end" font-size="2.5" fill="${CINZA}" letter-spacing="0.15">FOLHA</text>`;
  s += `<text x="191" y="52.4" text-anchor="end" font-size="4.4" font-weight="700" fill="${AZUL}" font-family="Consolas, monospace">${codigoLegivel(av.codigo, aluno.i)}</text>`;
  s += `<text x="191" y="58.2" text-anchor="end" font-size="2.6" fill="${CINZA}">Assinatura: ______________________</text>`;
  // disciplinas
  let y = 67;
  if (disc.length) {
    s += `<text x="15" y="${y}" font-size="3.3" font-weight="700" fill="${AZUL}">Questões por disciplina</text>`;
    s += `<rect x="15" y="${y + 1.4}" width="1" height="${Math.ceil(disc.length / 2) * 4.6 + 1}" fill="${VERDE}"/>`;
    disc.slice(0, 16).forEach((f, k) => {
      const cx = 18 + (k % 2) * 90, cy = y + 5.4 + Math.floor(k / 2) * 4.6;
      s += `<text x="${cx}" y="${cy}" font-size="3" fill="#0b1f33"><tspan font-weight="700">${f.de === f.ate ? f.de : `${f.de} a ${f.ate}`}</tspan>  ${esc((n2 => (n2.length > 52 ? n2.slice(0, 50) + '…' : n2))(tituloCaso(f.nome)))}</text>`;
    });
  }
  else if (av.dp) s += `<text x="15" y="${y}" font-size="3.3" fill="#0b1f33"><tspan font-weight="700" fill="${AZUL}">Prova de DP</tspan> — ${esc(av.dp.disciplina)}</text>`;
  s += `<text x="15" y="90" font-size="2.9" fill="${CINZA}">Use caneta azul ou preta e pinte a bolinha inteira. Marque uma só resposta por questão.</text>`;
  s += `<text x="15" y="94.5" font-size="2.9" fill="${CINZA}">Não rasure, não dobre a folha e não escreva perto dos quadrados pretos nem na faixa do código.</text>`;
  // ---- área de respostas (medidas do leitor) ----
  for (const [x, y2] of [[0, 0], [L.W, 0], [L.W, L.H], [0, L.H]]) { const [px, py] = P(x - L.MARCA / 2, y2 - L.MARCA / 2); s += `<rect x="${px}" y="${py}" width="${L.MARCA}" height="${L.MARCA}" fill="#000"/>`; }
  codificar(av.codigo, aluno.i).forEach((bit, b) => {
    const p = posBit(b), [px, py] = P(p.x - L.ID_LADO / 2, p.y - L.ID_LADO / 2);
    if (bit) s += `<rect x="${px}" y="${py}" width="${L.ID_LADO}" height="${L.ID_LADO}" fill="#000"/>`;
  });
  { const [px, py] = P(L.ID_X0 - 2.4, L.ID_Y - 2.6); s += `<rect x="${px}" y="${py}" width="${(L.ID_BITS - 1) * L.ID_PASSO + 4.8}" height="5.2" fill="none" stroke="#cbd5e1" stroke-width="0.2" stroke-dasharray="0.8 0.8"/>`; }
  const colunas = Math.ceil(n / L.LINHAS);
  for (let c = 0; c < colunas; c++) {
    for (let a = 0; a < nAlt; a++) { const p = posBolinha(c * L.LINHAS, a), [px, py] = P(p.x, L.Y0 - 6); s += `<text x="${px}" y="${py}" text-anchor="middle" font-size="3" font-weight="700" fill="${AZUL}">${LETRAS[a]}</text>`; }
  }
  // divisões entre disciplinas (linha fina entre a última questão de uma e a primeira da outra)
  disc.forEach((f, k) => {
    if (k === 0) return;
    const q = f.de - 1; if (q % L.LINHAS === 0) return;
    const p = posBolinha(q, 0), [px, py] = P(L.COL_X[Math.floor(q / L.LINHAS)], p.y - L.PASSO_Y / 2);
    s += `<line x1="${px}" x2="${px + L.NUM_W + (nAlt - 1) * L.PASSO_X + 4}" y1="${py}" y2="${py}" stroke="${VERDE}" stroke-width="0.35"/>`;
  });
  for (let q = 0; q < n; q++) {
    const p0 = posBolinha(q, 0), [nx, ny] = P(p0.x - 4.6, p0.y + 1.15);
    s += `<text x="${nx}" y="${ny}" text-anchor="end" font-size="3.3" font-weight="700" fill="#0b1f33">${q + 1}</text>`;
    for (let a = 0; a < nAlt; a++) {
      const p = posBolinha(q, a), [cx, cy] = P(p.x, p.y);
      s += `<circle cx="${cx}" cy="${cy}" r="${L.RAIO}" fill="none" stroke="#475569" stroke-width="0.3"/><text x="${cx}" y="${cy + 0.95}" text-anchor="middle" font-size="2.6" fill="#a3adbd">${LETRAS[a]}</text>`;
    }
  }
 // quadro "como preencher" na coluna que sobra (até 40 questões)
  if (colunas < L.COL_X.length) {
    const [bx, by] = P(L.COL_X[colunas] + 4, L.Y0 - 4);
    const ex = (dx, dy, tipo, rot, ok) => {
      const cx = bx + dx, cy = by + dy;
      let m = `<circle cx="${cx}" cy="${cy}" r="${L.RAIO}" fill="${tipo === 'cheia' ? '#0b1f33' : 'none'}" stroke="#475569" stroke-width="0.3"/>`;
      if (tipo === 'x') m += `<path d="M${cx - 1.8} ${cy - 1.8}L${cx + 1.8} ${cy + 1.8}M${cx + 1.8} ${cy - 1.8}L${cx - 1.8} ${cy + 1.8}" stroke="#0b1f33" stroke-width="0.6"/>`;
      if (tipo === 'v') m += `<path d="M${cx - 1.8} ${cy}L${cx - 0.4} ${cy + 1.6}L${cx + 2} ${cy - 1.8}" fill="none" stroke="#0b1f33" stroke-width="0.6"/>`;
      if (tipo === 'meia') m += `<path d="M${Array.from({ length: 13 }, (_, k) => { const a = Math.PI * k / 12; return `${(cx - L.RAIO * Math.cos(a)).toFixed(2)} ${(cy + L.RAIO * Math.sin(a)).toFixed(2)}`; }).join(' L')} Z" fill="#0b1f33"/>`;
      return m + `<text x="${cx + 5}" y="${cy + 1.1}" font-size="2.9" fill="${ok ? '#0f7a4b' : '#b42318'}" font-weight="700">${rot}</text>`;
    };
    s += `<rect x="${bx - 3}" y="${by - 5}" width="50" height="58" rx="1.5" fill="none" stroke="#cbd5e1" stroke-width="0.3"/>`;
    s += `<text x="${bx}" y="${by + 1}" font-size="3.2" font-weight="700" fill="${AZUL}">Como preencher</text>`;
    s += ex(3, 10, 'cheia', 'Assim: certo', true) + ex(3, 19, 'x', 'Não vale', false) + ex(3, 28, 'v', 'Não vale', false) + ex(3, 37, 'meia', 'Não vale', false);
    s += `<text x="${bx}" y="${by + 46}" font-size="2.5" fill="${CINZA}">Duas bolinhas na mesma</text><text x="${bx}" y="${by + 49.5}" font-size="2.5" fill="${CINZA}">questão anulam a resposta.</text>`;
  }
  s += `<text x="15" y="290" font-size="2.6" fill="${CINZA}">Órbita FATEC · Correção de Provas · avaliação ${String(av.codigo).padStart(4, '0')}</text>`;
  s += `<text x="195" y="290" text-anchor="end" font-size="2.6" fill="${CINZA}">Uso interno — a correção é feita pela coordenação.</text>`;
  return `<svg class="pg" xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297" font-family="'Segoe UI', Arial, sans-serif">${s}</svg>`;
}

// HTML completo (uma página por aluno), pronto pra imprimir
export function htmlFolhas(av, alunos) {
  const logo = `${location.origin}/img/fateclogoazul.png`;
  const turmas = Object.fromEntries((av.turmas || []).map(t => [t.id, t]));
  const paginas = alunos.map(a => pagina(av, a, turmas[a.turmaId], logo)).join('');
  return `<!DOCTYPE html><html lang="pt-br"><head><meta charset="utf-8"><title>Folhas de resposta — ${esc(av.nome)}</title>
<style>
  @page { size: A4; margin: 0; }
  html, body { margin: 0; padding: 0; background: #e2e8f0; }
  .pg { display: block; background: #fff; margin: 0 auto; page-break-after: always; break-after: page; }
  @media screen { .pg { margin: 10px auto; box-shadow: 0 2px 10px rgba(0,0,0,.15); } }
  @media print { html, body { background: #fff; } }
</style></head><body>${paginas}</body></html>`;
}
