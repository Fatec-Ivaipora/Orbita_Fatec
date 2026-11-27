// ================================================================
//  ÓRBITA — MEDICINA · painel de abertura e espectro (27/11/2026)
//  A mesma linguagem visual em todos os módulos do menu Medicina (Banco de Questões, Aplicação de Provas, OSCE,
//  Portfólio, Relatório de Desempenho): cada tela abre com UMA frase que responde a pergunta da coordenação
//  ("as provas estão discriminando bem?", "quanto do banco está no padrão?"), um ESPECTRO grande com as partes
//  e a legenda dizendo o que cada parte significa. As linhas da lista usam o espectro pequeno.
//  Só monta HTML (string). Estilos em medicina/comum/painel.css.
// ================================================================
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Cores MED (as faixas boas na marca; as de atenção em âmbar/laranja/vermelho)
export const COR = {
  azul: '#004F9F', ciano: '#009FE3', ambar: '#E9B43A', laranja: '#EC7A45', vermelho: '#B91C1C',
  verde: '#0F7A4B', cinza: '#94A3B8', cinzaClaro: '#CBD5E1'
};

// partes: [{ nome, n, cor, dica? }] — na ordem em que aparecem
export function espectro(partes, { grande = false, rotulo = '' } = {}) {
  const vis = (partes || []).filter(p => p.n > 0);
  const total = vis.reduce((s, p) => s + p.n, 0);
  if (!total) return `<div class="med-espectro med-espectro-vazio${grande ? ' med-espectro-grande' : ''}"></div>`;
  const aria = esc(`${rotulo ? `${rotulo}: ` : ''}${vis.map(p => `${p.nome} ${p.n}`).join(', ')}`);
  return `<div class="med-espectro${grande ? ' med-espectro-grande' : ''}" role="img" aria-label="${aria}">${vis.map(p =>
    `<span style="flex:${p.n};background:${p.cor}" title="${esc(`${p.nome}: ${p.n}${p.dica ? ` — ${p.dica}` : ''}`)}">${grande && p.n / total >= 0.06 ? p.n : ''}</span>`).join('')}</div>`;
}

export function legenda(partes) {
  return `<ul class="med-legenda">${(partes || []).map(p =>
    `<li><i style="background:${p.cor}"></i><b>${esc(p.nome)}</b> ${p.n}${p.dica ? `<small>${esc(p.dica)}</small>` : ''}</li>`).join('')}</ul>`;
}

// destaque: o número grande da frase (ex.: "58%"); frase: o resto (texto já escapado/HTML simples);
// sub: linha de apoio (HTML); partes: o espectro grande; extras: [{ rotulo, partes }] espectros menores com título
export function painel({ destaque = '', frase = '', sub = '', partes = [], extras = [], semLegenda = false } = {}) {
  return `<div class="med-painel">
    <p class="med-painel-frase">${destaque ? `<b>${esc(destaque)}</b> ` : ''}${frase}</p>
    ${sub ? `<p class="med-painel-sub">${sub}</p>` : ''}
    ${partes.length ? espectro(partes, { grande: true }) : ''}
    ${partes.length && !semLegenda ? legenda(partes) : ''}
    ${extras.length ? `<div class="med-painel-extras">${extras.map(x => `<div class="med-painel-extra"><span class="med-painel-extra-rot">${esc(x.rotulo)}</span>${espectro(x.partes, { rotulo: x.rotulo })}<span class="med-painel-extra-leg">${x.partes.filter(p => p.n).map(p => `<span><i style="background:${p.cor}"></i>${esc(p.nome)} ${p.n}</span>`).join('')}</span></div>`).join('')}</div>` : ''}
  </div>`;
}
