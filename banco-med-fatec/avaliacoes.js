// ================================================================
//  BANCO MED-FATEC — aba AVALIAÇÕES (12/11/2026)
//  Grade disciplina × (bimestre, chamada) → avaliação: escrever no modelo padrão, importar Word/PDF/texto,
//  pegar do banco, checklist do padrão ao vivo, tabela de especificação pelo plano de ensino do Edubox,
//  finalizar (questões vão pro banco) e baixar o Moodle XML com a pasta pronta.
//  Regras: banco-med-fatec/padrao.js (window.PadraoMed). Rotas: src/rotas/banco-med-avaliacoes.js
// ================================================================
const P = window.PadraoMed;
const BASE = '/banco-med-fatec/avaliacoes';
let api, baixar, esc;
let semestre = '2026.2';
let disciplinas = [], avaliacoes = [];
let atual = null;            // { avaliacao, questoes, plano, professores, analise }
let filtroProfessor = '';
let carregouGrade = false;

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const ordinal = (n) => `${n}º`;
const LETRAS = ['A', 'B', 'C', 'D', 'E'];
const CORES = [['#E0F2FE', '#075985'], ['#DCFCE7', '#166534'], ['#FEF3C7', '#92400E'], ['#FCE7F3', '#9D174D'], ['#EDE9FE', '#5B21B6'], ['#FFE4E6', '#9F1239'], ['#CCFBF1', '#115E59'], ['#E0E7FF', '#3730A3'], ['#FFEDD5', '#9A3412'], ['#F1F5F9', '#334155']];
function corDe(nome) { let h = 0; for (const c of String(nome || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CORES[h % CORES.length]; }
function iniciais(nome) { const p = String(nome || '?').split(/\s+/).filter(w => w.length > 2 || /^[A-Z]/.test(w)); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function primeiroUltimo(nome) { const p = String(nome || '').split(/\s+/).filter(Boolean); return p.length > 2 ? `${p[0]} ${p[p.length - 1]}` : p.join(' '); }
function avatar(nome, grande) {
  const [bg, fg] = corDe(nome);
  return `<span class="av-avatar${grande ? ' av-avatar-g' : ''}" style="background:${bg};color:${fg}" title="${esc(nome)}" aria-hidden="true">${esc(iniciais(nome))}</span>`;
}
function chipProfessor(nome, extra = '') {
  if (!nome) return '<span class="av-chip av-chip-vazio">Sem professor</span>';
  const [bg, fg] = corDe(nome);
  return `<span class="av-chip" style="background:${bg};color:${fg}">${avatar(nome)}${esc(primeiroUltimo(nome))}${extra}</span>`;
}
const ICONE = {
  voltar: '<path d="M15 18l-6-6 6-6"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  importar: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  banco: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  editar: '<path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4z"/>',
  lixo: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  cima: '<path d="M18 15l-6-6-6 6"/>',
  baixo: '<path d="M6 9l6 6 6-6"/>',
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alerta: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  baixar: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M5 21h14"/>',
  cadeado: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  livro: '<path d="M4 4h10a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M8 20a4 4 0 0 1 0-8h10"/>'
};
const ic = (n, cls = '') => `<svg class="bmf-icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONE[n]}</svg>`;
function toast(msg, tipo = 'ok') {
  let t = $('#av-toast');
  if (!t) { t = document.createElement('div'); t.id = 'av-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.className = `av-toast av-toast-${tipo}`; t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4200);
}
// HTML seguro do caso clínico / feedback: mantém parágrafo, negrito, lista, tabela (exames), sub/sobrescrito;
// tira estilo, classe, script, imagem e qualquer atributo (colado do Word ou vindo do AVA).
const TAGS_OK = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'SUB', 'SUP', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV', 'SPAN']);
function limpaHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  (function limpar(no) {
    [...no.childNodes].forEach(f => {
      if (f.nodeType === 1) {
        if (/^(SCRIPT|STYLE|META|LINK|TITLE|XML|O:P)$/i.test(f.tagName)) return f.remove();
        if (!TAGS_OK.has(f.tagName)) { limpar(f); f.replaceWith(...f.childNodes); return; }
        while (f.attributes.length) f.removeAttribute(f.attributes[0].name);
        limpar(f);
        if (f.tagName === 'SPAN') f.replaceWith(...f.childNodes);
      } else if (f.nodeType !== 3) f.remove();
    });
  })(doc.body);
  return doc.body.innerHTML.replace(/<p>\s*(<br>)?\s*<\/p>/gi, '').trim();
}
function htmlParaTexto(html) {
  const d = document.createElement('div');
  d.innerHTML = String(html || '').replace(/<\/(p|div|li)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  return d.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

// ==========================================================================================
// GRADE (lista de avaliações do semestre)
// ==========================================================================================
async function carregarGrade() {
  const view = $('#bmf-view-avaliacoes');
  $('#av-conteudo', view).innerHTML = '<div class="av-carregando"><span class="av-spin"></span>Buscando as disciplinas da Medicina no Edubox…</div>';
  try {
    const [d, l] = await Promise.all([api(`${BASE}/disciplinas?semestre=${semestre}`), api(`${BASE}?semestre=${semestre}`)]);
    disciplinas = d.disciplinas; avaliacoes = l;
    $('#av-fonte', view).textContent = d.fonte !== semestre ? `Professores e planos de ${d.fonte} (o Edubox ainda não tem os diários de ${semestre}).` : '';
    carregouGrade = true;
    renderGrade();
  } catch (e) {
    $('#av-conteudo', view).innerHTML = `<div class="av-vazio">${esc(e.message)}</div>`;
  }
}

function slotHtml(disc, bim, ch) {
  const av = avaliacoes.find(a => a.chave === disc.chave && a.bimestre === bim && a.chamada === ch);
  const rotulo = `${ordinal(bim)} bimestre, ${ch}ª chamada`;
  if (!av) return `<button type="button" class="av-slot av-slot-vazio" data-criar="${esc(disc.chave)}" data-bim="${bim}" data-ch="${ch}" aria-label="Montar ${rotulo}">${ic('mais')}<span>Montar</span><em class="av-slot-ch">${ch}ª chamada</em></button>`;
  const fin = av.status === 'finalizada';
  const plan = Number(disc.qtdQuestoes) || 0;
  const pct = plan ? Math.min(100, Math.round(100 * av.totalQuestoes / plan)) : 0;
  return `<button type="button" class="av-slot ${fin ? 'av-slot-fin' : 'av-slot-rasc'}" data-abrir="${esc(av.id)}" aria-label="${rotulo}: ${fin ? 'finalizada' : 'em montagem'}, ${av.totalQuestoes}${plan ? ` de ${plan}` : ''} questões">
    ${fin ? ic('cadeado') : ic('editar')}<span><b>${av.totalQuestoes}</b>${plan ? ` de ${plan}` : ` ${av.totalQuestoes === 1 ? 'questão' : 'questões'}`}</span>${plan ? `<i class="av-slot-barra" aria-hidden="true"><i style="width:${pct}%"></i></i>` : ''}<small>${fin ? 'Finalizada' : 'Em montagem'}</small><em class="av-slot-ch">${ch}ª chamada</em></button>`;
}

function renderGrade() {
  const busca = P.norm($('#av-busca').value || '');
  const lista = disciplinas.filter(d => !busca || P.norm(`${d.nome} ${d.sigla} ${d.professores.join(' ')}`).includes(busca));
  const periodos = [...new Set(lista.map(d => d.periodo))].sort((a, b) => a - b);
  const montadas = avaliacoes.length, fin = avaliacoes.filter(a => a.status === 'finalizada').length;
  $('#av-resumo').textContent = `${disciplinas.length} disciplinas · ${montadas} avaliação(ões) em andamento ou prontas · ${fin} finalizada(s)`;
  if (!lista.length) { $('#av-conteudo').innerHTML = '<div class="av-vazio">Nenhuma disciplina encontrada.</div>'; return; }
  $('#av-conteudo').innerHTML = `
    <div class="av-grade" role="table" aria-label="Avaliações por disciplina">
      <div class="av-grade-cab" role="row">
        <span role="columnheader">Disciplina</span>
        <span role="columnheader" class="av-grade-bim">1º bimestre<small><i>1ª chamada</i><i>2ª chamada</i></small></span>
        <span role="columnheader" class="av-grade-bim">2º bimestre<small><i>1ª chamada</i><i>2ª chamada</i></small></span>
      </div>
      ${periodos.map(p => `
        <div class="av-periodo" role="row"><span role="cell">${ordinal(p)} período</span></div>
        ${lista.filter(d => d.periodo === p).map(d => `
          <div class="av-disc" role="row">
            <div class="av-disc-info" role="cell">
              <strong>${esc(d.nome)}</strong>
              <span class="av-disc-meta">${esc(d.sigla || '')} · <button type="button" class="av-link" data-criterios="${esc(d.chave)}">${d.criteriosDefinidos ? 'Critérios definidos' : 'Critérios: padrão'}</button> · <button type="button" class="av-link" data-progresso="${esc(d.chave)}">Progresso</button></span>

              <span class="av-disc-profs" aria-label="Professores: ${esc(d.professores.join(', '))}">${d.professores.map(n => avatar(n)).join('')}</span>
            </div>
            <div class="av-slots" role="cell" data-rotulo="1º bimestre">${slotHtml(d, 1, 1)}${slotHtml(d, 1, 2)}</div>
            <div class="av-slots" role="cell" data-rotulo="2º bimestre">${slotHtml(d, 2, 1)}${slotHtml(d, 2, 2)}</div>
          </div>`).join('')}`).join('')}
    </div>`;
}

async function criarAvaliacao(chave, bim, ch) {
  try {
    const r = await api(BASE, { method: 'POST', body: JSON.stringify({ semestre, chave, bimestre: bim, chamada: ch }) });
    await abrirAvaliacao(r.id);
    avaliacoes = await api(`${BASE}?semestre=${semestre}`);
  } catch (e) { toast(e.message, 'erro'); }
}

// ==========================================================================================
// EDITOR DA AVALIAÇÃO
// ==========================================================================================
async function abrirAvaliacao(id) {
  $('#av-grade-tela').hidden = true;
  const ed = $('#av-editor');
  ed.hidden = false;
  ed.innerHTML = '<div class="av-carregando"><span class="av-spin"></span>Abrindo a avaliação e o plano de ensino…</div>';
  try {
    atual = await api(`${BASE}/${encodeURIComponent(id)}`);
    filtroProfessor = '';
    renderEditor();
    window.scrollTo({ top: 0 });
  } catch (e) { ed.innerHTML = `<div class="av-vazio">${esc(e.message)} <button type="button" class="av-link" data-voltar>Voltar</button></div>`; }
}
async function recarregarAtual() {
  atual = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}`);
  renderEditor();
}
function voltarGrade() {
  atual = null;
  $('#av-editor').hidden = true; $('#av-editor').innerHTML = '';
  $('#av-grade-tela').hidden = false;
  carregarGrade();
}

function rotuloUnidade(n) {
  const u = (atual.plano.unidades || []).find(x => x.numero === Number(n));
  return u ? `Unidade ${u.numero}` : (n ? `Unidade ${n}` : 'Sem unidade');
}

function renderEditor() {
  const { avaliacao: av, questoes, plano, analise } = atual;
  const fin = av.status === 'finalizada';
  const profsNaProva = Object.entries(analise.professores).sort((a, b) => b[1] - a[1]);
  const visiveis = questoes.map((q, i) => ({ q, n: i + 1 })).filter(x => !filtroProfessor || (x.q.professorNome || 'Sem professor') === filtroProfessor);
  const prontas = questoes.filter(q => q.padrao.ok).length;
  $('#av-editor').innerHTML = `
    <header class="av-ed-cab">
      <button type="button" class="av-voltar" data-voltar>${ic('voltar')}Avaliações</button>
      <div class="av-ed-titulo">
        <h2>${esc(av.disciplina)}</h2>
        <p>${esc(av.sigla || '')} · ${esc(av.semestre)} · <b>${ordinal(av.bimestre)} bimestre</b> · <b>${av.chamada}ª chamada</b>
          <span class="av-status ${fin ? 'av-status-fin' : 'av-status-rasc'}">${fin ? 'Finalizada' : 'Em montagem'}</span></p>
      </div>
      <div class="av-ed-acoes">
        <button type="button" class="btn btn-secondary av-btn" data-conferir ${questoes.length ? '' : 'disabled'}>Conferência CADAM</button>
        ${fin ? `<button type="button" class="btn btn-primary av-btn" data-xml>${ic('baixar')}Baixar para o AVA</button>
                 <button type="button" class="btn btn-secondary av-btn" data-reabrir>Reabrir</button>`
              : `<button type="button" class="btn btn-primary av-btn" data-finalizar ${questoes.length ? '' : 'disabled'}>${ic('ok')}Finalizar avaliação</button>
                 <button type="button" class="av-icone-btn av-perigo" data-excluir-av title="Excluir avaliação" aria-label="Excluir avaliação">${ic('lixo')}</button>`}
      </div>
    </header>

    <div class="av-ed-corpo">
      <section class="av-ed-questoes" aria-label="Questões da avaliação">
        ${fin ? `<div class="av-faixa av-faixa-fin">${ic('cadeado')}<div><b>Avaliação finalizada.</b> As ${questoes.length} questões estão no banco de ${esc(av.disciplina)}, na pasta ${esc(av.semestre)} / ${ordinal(av.bimestre)} bimestre / ${av.chamada}ª chamada. Baixe o arquivo e importe no banco de questões do AVA.</div></div>` : `
        <div class="bmf-toolbar av-toolbar">
          <div class="av-toolbar-acoes">
            <button type="button" class="btn av-btn-branco" data-nova>${ic('mais')}Escrever questão</button>
            <button type="button" class="btn av-btn-fantasma" data-importar>${ic('importar')}Importar Word, PDF ou texto</button>
            <button type="button" class="btn av-btn-fantasma" data-banco>${ic('banco')}Pegar do banco</button>
          </div>
        </div>`}

        ${analise.pendencias.length && !fin ? `<div class="av-faixa av-faixa-aviso" role="status">${ic('alerta')}<ul>${analise.pendencias.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}

        <div class="av-prog" aria-label="${prontas} de ${questoes.length} questões no padrão">
          <div class="av-prog-barra"><span style="width:${questoes.length ? Math.round(100 * prontas / questoes.length) : 0}%"></span></div>
          <span>${analise.planejado ? `<b>${questoes.length}</b> de <b>${analise.planejado}</b> questões · ` : ''}<b>${prontas}</b> de <b>${questoes.length}</b> no padrão${analise.avisos ? ` · ${analise.avisos} orientação(ões)` : ''}</span>
        </div>

        ${profsNaProva.length > 1 ? `<div class="av-filtro-prof" role="group" aria-label="Filtrar por professor">
          <button type="button" class="av-fp ${!filtroProfessor ? 'ativo' : ''}" data-fp="">Todos <b>${questoes.length}</b></button>
          ${profsNaProva.map(([n, c]) => `<button type="button" class="av-fp ${filtroProfessor === n ? 'ativo' : ''}" data-fp="${esc(n)}">${n === 'Sem professor' ? '' : avatar(n)}${esc(primeiroUltimo(n))} <b>${c}</b></button>`).join('')}
        </div>` : ''}

        <ol class="av-lista">
          ${visiveis.length ? visiveis.map(({ q, n }) => linhaQuestao(q, n, fin, questoes.length)).join('') : `<li class="av-vazio">${questoes.length ? 'Nenhuma questão deste professor.' : 'Nenhuma questão ainda. Escreva no modelo, importe do Word/PDF ou pegue do banco da disciplina.'}</li>`}
        </ol>
      </section>

      <aside class="av-ed-plano" aria-label="Tabela de especificação">
        ${painelPlano(plano, analise, av)}
      </aside>
    </div>`;
}

function linhaQuestao(q, n, fin, total) {
  const p = q.padrao;
  const status = p.ok ? `<span class="av-selo av-selo-ok">${ic('ok')}No padrão</span>` : `<span class="av-selo av-selo-erro">${ic('alerta')}${p.bloqueios.length} a corrigir</span>`;
  return `<li class="av-q ${p.ok ? '' : 'av-q-erro'}">
    <span class="av-q-n">${n}</span>
    <div class="av-q-corpo">
      <div class="av-q-topo">${chipProfessor(q.professorNome)}<span class="av-tag">${esc(rotuloUnidade(q.unidade))}</span>
        <span class="av-tag ${p.aplicacao ? 'av-tag-caso' : ''}">${p.aplicacao ? 'Caso clínico' : 'Memorização'}</span>${(q.imagens || []).length || q.temImagem ? `<span class="av-tag">${(q.imagens || []).length + (q.temImagem ? 1 : 0)} imagem(ns)</span>` : ''}${status}</div>
      <p class="av-q-obj">${q.objetivo ? esc(q.objetivo) : '<i>Objetivo a definir</i>'}</p>
      <p class="av-q-enun">${esc(P.texto(q.casoClinico || q.enunciadoHtml).slice(0, 240))}${P.texto(q.casoClinico || q.enunciadoHtml).length > 240 ? '…' : ''}</p>
      ${(!p.ok || p.avisos.length) ? `<details class="av-q-det"><summary>${p.bloqueios.length ? `${p.bloqueios.length} a corrigir` : ''}${p.bloqueios.length && p.avisos.length ? ' · ' : ''}${p.avisos.length ? `${p.avisos.length} orientação(ões)` : ''}</summary>
        <ul>${p.bloqueios.map(b => `<li class="av-b">${esc(b.msg)}</li>`).join('')}${p.avisos.map(a => `<li class="av-a">${esc(a.msg)}</li>`).join('')}</ul></details>` : ''}
    </div>
    ${fin ? '' : `<div class="av-q-acoes">
      <button type="button" class="av-icone-btn" data-subir="${esc(q.id)}" ${n === 1 ? 'disabled' : ''} aria-label="Subir questão ${n}">${ic('cima')}</button>
      <button type="button" class="av-icone-btn" data-descer="${esc(q.id)}" ${n === total ? 'disabled' : ''} aria-label="Descer questão ${n}">${ic('baixo')}</button>
      <button type="button" class="av-icone-btn" data-editar="${esc(q.id)}" aria-label="Editar questão ${n}">${ic('editar')}</button>
      <button type="button" class="av-icone-btn av-perigo" data-retirar="${esc(q.id)}" aria-label="Retirar questão ${n}">${ic('lixo')}</button>
    </div>`}
  </li>`;
}

function painelPlano(plano, analise, av) {
  if (plano.erro) return `<h3>Plano de ensino</h3><p class="av-nota">${esc(plano.erro)}</p>`;
  if (!plano.encontrado) return `<h3>Plano de ensino</h3><p class="av-nota">O plano de ensino desta disciplina não está preenchido no Edubox. A análise de cobertura fica de fora.</p>`;
  const max = Math.max(1, ...analise.porUnidade.map(u => Math.max(u.qtd, u.esperado)));
  const total = analise.total || 1;
  return `
    <div class="av-crit-origem ${atual.criterios && atual.criterios.definidos ? 'av-crit-def' : ''}">
      <span>${atual.criterios && atual.criterios.definidos ? `Critérios definidos por <b>${esc(atual.criterios.definidoPor)}</b> em ${dataBR(atual.criterios.definidoEm)}` : 'Critérios padrão — ainda não definidos para esta disciplina'}</span>
      <button type="button" class="av-link" data-criterios-av>Ver critérios</button>
    </div>
    <h3>Tabela de especificação</h3>
    <p class="av-nota">Unidades do ${ordinal(av.bimestre)} bimestre no plano de ensino (Edubox ${esc(plano.semestreFonte)}). A barra clara é o esperado pelo peso de cada unidade.</p>
    <ul class="av-unids">
      ${analise.porUnidade.map(u => `<li class="av-unid av-unid-${u.situacao}">
        <div class="av-unid-cab"><b>Unidade ${u.numero}</b><span>${u.ch}h</span><span class="av-unid-n">${u.qtd}<small>/${Math.round(u.esperado)}</small></span></div>
        <div class="av-unid-tit">${esc(u.titulo)}</div>
        <div class="av-barra" aria-hidden="true"><span class="av-barra-esp" style="width:${100 * u.esperado / max}%"></span><span class="av-barra-qtd" style="width:${100 * u.qtd / max}%"></span></div>
      </li>`).join('') || '<li class="av-nota">Sem unidades para este bimestre.</li>'}
    </ul>
    ${analise.foraDoBimestre ? `<p class="av-nota av-nota-aviso">${analise.foraDoBimestre} questão(ões) de unidade do outro bimestre.</p>` : ''}

    <h3>Equilíbrio</h3>
    <div class="av-eq" aria-label="${analise.aplicacao} de caso clínico e ${analise.memorizacao} de memorização">
      <div class="av-eq-barra"><span class="av-eq-caso" style="width:${100 * analise.aplicacao / total}%"></span></div>
      <div class="av-eq-leg"><span><i class="av-dot av-dot-caso"></i>Caso clínico <b>${analise.aplicacao}</b></span><span><i class="av-dot"></i>Memorização <b>${analise.memorizacao}</b></span></div>
    </div>

    <h3>Objetivos do plano <small>${analise.objetivos.filter(o => o.qtd).length} de ${analise.objetivos.length}</small></h3>
    <ul class="av-objs">${analise.objetivos.map(o => `<li class="${o.qtd ? 'av-obj-ok' : ''}"><span class="av-obj-n">${o.qtd || '–'}</span>${esc(o.objetivo)}</li>`).join('')}</ul>

    <h3>Professores da disciplina${analise.planejado ? ` <small>prova de ${analise.planejado}</small>` : ''}</h3>
    <ul class="av-profs">${atual.professores.map(n => { const m = (analise.porProfessor || []).find(x => P.norm(x.nome) === P.norm(n)); const f = analise.professores[n] || 0; return `<li class="${m ? (f >= m.meta ? 'av-prof-ok' : 'av-prof-falta') : ''}">${chipProfessor(n)}<b>${f}${m ? `<small> de ${m.meta}</small>` : ''}</b></li>`; }).join('')}</ul>`;
}

// ---------- ações do editor ----------
async function moverQuestao(id, delta) {
  const ids = atual.questoes.map(q => q.id);
  const i = ids.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  try { await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/ordem`, { method: 'PUT', body: JSON.stringify({ questoesIds: ids }) }); await recarregarAtual(); }
  catch (e) { toast(e.message, 'erro'); }
}
async function retirarQuestao(id) {
  const q = atual.questoes.find(x => x.id === id);
  const nova = q && q.status === 'rascunho_avaliacao';
  if (!confirmar(nova ? 'Excluir esta questão? Ela foi escrita nesta avaliação e ainda não está no banco.' : 'Retirar esta questão da avaliação? Ela continua no banco da disciplina.')) return;
  try { await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/questoes/${encodeURIComponent(id)}`, { method: 'DELETE' }); await recarregarAtual(); toast(nova ? 'Questão excluída.' : 'Questão retirada da avaliação.'); }
  catch (e) { toast(e.message, 'erro'); }
}
// confirmação dentro da página (sem window.confirm): o próprio botão pede o 2º clique
let pendente = null;
function confirmar(msg) {
  if (pendente && pendente.msg === msg && Date.now() - pendente.em < 6000) { pendente = null; return true; }
  pendente = { msg, em: Date.now() };
  toast(`${msg} Clique de novo para confirmar.`, 'aviso');
  return false;
}
async function finalizar() {
  try { const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/finalizar`, { method: 'POST' }); toast(r.message); await recarregarAtual(); }
  catch (e) { toast(e.message, 'erro'); }
}
async function reabrir() {
  if (!confirmar('Reabrir a avaliação para ajustes? Depois finalize e baixe o arquivo de novo.')) return;
  try { const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/reabrir`, { method: 'POST' }); toast(r.message); await recarregarAtual(); }
  catch (e) { toast(e.message, 'erro'); }
}
async function excluirAvaliacao() {
  if (!confirmar('Excluir esta avaliação? As questões escritas nela também são excluídas; as do banco continuam no banco.')) return;
  try { await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}`, { method: 'DELETE' }); toast('Avaliação excluída.'); voltarGrade(); }
  catch (e) { toast(e.message, 'erro'); }
}
// O XML é montado AQUI no navegador (12/11/2026): as imagens/GIFs vêm direto do Storage, em tamanho original —
// pelo servidor um GIF de Libras de 13 MB não passaria do limite de resposta.
function blobParaBase64(blob) {
  return new Promise((ok, falha) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => falha(new Error('Não consegui ler uma imagem.')); r.readAsDataURL(blob); });
}
const nomeSeguro = (n) => String(n || 'imagem').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'imagem';
async function baixarXml() {
  const btn = document.querySelector('[data-xml]');
  if (btn) { btn.disabled = true; btn.dataset.txt = btn.innerHTML; btn.textContent = 'Montando o arquivo…'; }
  try {
    const dados = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/exportar`);
    const questoes = [];
    for (const [i, q] of dados.questoes.entries()) {
      const arquivos = [];
      for (const [j, im] of (q.imagens || []).entries()) {
        const r = await fetch(im.url);
        if (!r.ok) throw new Error(`Não consegui baixar a imagem "${im.nome}" da questão ${i + 1}.`);
        arquivos.push({ nome: `q${i + 1}-${j + 1}-${nomeSeguro(im.nome)}`, base64: await blobParaBase64(await r.blob()) });
      }
      let imagem = null;
      if (q.temImagemAntiga) {
        const a = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/questoes/${encodeURIComponent(q.id)}/imagem-antiga`);
        if (a.dataUrl) imagem = { nome: `q${i + 1}-${nomeSeguro(a.nome)}`, dataUrl: a.dataUrl };
      }
      const imgs = arquivos.map(a => `<p><img src="@@PLUGINFILE@@/${a.nome}" alt="Imagem da questão ${i + 1}"></p>`).join('\n');
      const perg = q.pergunta ? `<p><strong>${esc(q.pergunta)}</strong></p>` : '';
      // imagem entre o caso clínico e a pergunta (onde o aluno precisa dela)
      const enunciadoHtml = (q.casoClinico || q.pergunta) ? [q.casoClinico, imgs, perg].filter(Boolean).join('\n') : [q.enunciadoHtml, imgs].filter(Boolean).join('\n');
      questoes.push({ ...q, enunciadoHtml, arquivos, imagem });
    }
    const xml = window.MoodleXml.gerarMoodleXml(dados.pasta, questoes);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }));
    link.download = dados.nomeArquivo;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast('Arquivo baixado. No AVA: Banco de questões → Importar → formato Moodle XML.');
  } catch (e) { toast(e.message, 'erro'); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset.txt; } }
}

// ==========================================================================================
// MODAL: escrever / padronizar questão (com checklist do padrão ao vivo)
// ==========================================================================================
const CHECKLIST = [
  { t: 'Professor, unidade e objetivo', c: ['professor', 'unidade', 'objetivo'] },
  { t: 'Caso clínico (situação real)', c: ['memorizacao'], aviso: true },
  { t: 'Pergunta direta no final', c: ['pergunta', 'enunciado'] },
  { t: 'Enunciado afirmativo (sem EXCETO / INCORRETA)', c: ['negativo'] },
  { t: '4 ou 5 alternativas, sem repetição', c: ['qtd', 'vazia', 'repetida'] },
  { t: 'Uma única alternativa correta', c: ['gabarito', 'tipo'] },
  { t: 'Sem "nenhuma" ou "todas as alternativas"', c: ['nenhuma'] },
  { t: 'Correta sem pista (tamanho, palavra repetida, termo absoluto)', c: ['longa', 'pista', 'absoluto', 'afirmativas'] },
  { t: 'Sem opinião nem termo vago ("seria", "pode", "é possível")', c: ['opiniao', 'pode'] },
  { t: 'Um assunto por questão', c: ['dois-assuntos'] },
  { t: 'Feedback geral da resposta', c: ['feedback'] },
  { t: 'Referência bibliográfica', c: ['referencia'] }
];
let editando = null; // id da questão ou null (nova)
// Contexto do editor (13/11/2026): o MESMO editor serve à avaliação e ao Banco de Questões.
// { modo, sigla, bimestre|null, plano, professores, titulo, salvar(f, id), aposSalvar(), envio, imagemAntiga(id)?, categorias?, categoriaId? }
let ed = null;
let imgsQuestao = [];          // [{ caminho, nome, url, mimeType }] — no Storage
let imgAntiga = null, removerImagem = false; // imagem antiga (comprimida, dentro do documento)
let enviandoImgs = 0;

function modalHtml() {
  return `<div class="av-modal-fundo" id="av-modal-q" hidden>
    <div class="av-modal" role="dialog" aria-modal="true" aria-labelledby="av-mq-tit">
      <header class="av-modal-cab"><h2 id="av-mq-tit">Questão</h2><button type="button" class="av-icone-btn" data-fechar-q aria-label="Fechar">${ic('x')}</button></header>
      <div class="av-mq-corpo">
        <form id="av-form-q" class="av-mq-form" novalidate>
          <fieldset class="av-sec"><legend>Identificação</legend>
            <label class="av-campo" id="av-q-disc-campo" hidden><span>Disciplina</span><select id="av-q-disc"></select></label>
            <div class="av-campos3">
              <label class="av-campo"><span>Professor que elaborou</span><select id="av-q-prof"></select></label>
              <label class="av-campo"><span>Unidade do plano</span><select id="av-q-unid"></select></label>
              <label class="av-campo"><span>Dificuldade</span><select id="av-q-dif"><option value="facil">Fácil</option><option value="media" selected>Média</option><option value="intermediaria">Intermediária</option><option value="dificil">Difícil</option></select></label>
            </div>
            <label class="av-campo"><span>Objetivo do plano de ensino que a questão avalia</span><select id="av-q-obj"></select></label>
            <input type="text" id="av-q-obj-outro" class="av-input" spellcheck="true" lang="pt-BR" maxlength="400" placeholder="Escreva o objetivo" hidden>
            <label class="av-campo"><span>Título da questão no AVA</span>
              <span class="av-titulo-linha"><span class="av-titulo-pre" id="av-q-titulo-pre">Prof. –</span><input type="text" id="av-q-nome" class="av-input" spellcheck="true" lang="pt-BR" maxlength="160" placeholder="Nome da questão (tema ou objetivo)"></span>
            </label>
          </fieldset>

          <fieldset class="av-sec"><legend>Caso clínico</legend>
            <div id="av-q-caso" class="av-rico av-prontuario" contenteditable="true" spellcheck="true" lang="pt-BR" role="textbox" aria-multiline="true" aria-label="Caso clínico" data-ph="Paciente, idade, sexo, queixa, história, achados do exame e dos exames complementares…"></div>
            <div class="av-imgs" id="av-q-imgs" aria-live="polite"></div>
            <div class="av-img-linha">
              <label class="av-btn-img"><input type="file" id="av-q-img" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>+ Adicionar imagem ou GIF</label>
              <span class="av-nota">ECG, raio-X, foto, GIF animado (ex.: sinal em Libras). Vai ao AVA no tamanho original.</span>
            </div>
            <label class="av-campo"><span>Pergunta</span><input type="text" id="av-q-perg" class="av-input av-pergunta" spellcheck="true" lang="pt-BR" maxlength="600" placeholder="Ex.: Qual a conduta mais adequada neste momento?"></label>
          </fieldset>

          <fieldset class="av-sec"><legend>Alternativas <small>marque a correta</small></legend>
            <div id="av-q-alts"></div>
            <button type="button" class="av-link" id="av-q-mais-alt">+ 5ª alternativa</button>
          </fieldset>

          <fieldset class="av-sec"><legend>Feedback e referência</legend>
            <label class="av-campo"><span>Feedback geral (por que a correta é a correta)</span></label>
            <div id="av-q-just" class="av-rico" contenteditable="true" spellcheck="true" lang="pt-BR" role="textbox" aria-multiline="true" aria-label="Feedback geral" data-ph="Explicação que o aluno vê depois da prova…"></div>
            <label class="av-campo"><span>Referência</span><select id="av-q-ref"></select></label>
            <input type="text" id="av-q-ref-outra" class="av-input" spellcheck="true" lang="pt-BR" maxlength="600" placeholder="Autor. Título. Edição. Editora, ano." hidden>
          </fieldset>
        </form>

        <aside class="av-check" aria-label="Checklist do padrão">
          <h3>Checklist do padrão</h3>
          <ol id="av-check-lista"></ol>
          <p class="av-check-rodape" id="av-check-rodape"></p>
          <section class="av-pt" aria-labelledby="av-pt-tit">
            <div class="av-pt-cab"><h4 id="av-pt-tit">Português e ABNT <span id="av-pt-n"></span></h4><button type="button" class="av-pt-tudo" id="av-pt-tudo" hidden>Corrigir tudo</button></div>
            <ul id="av-pt-lista" aria-live="polite"></ul>
          </section>
        </aside>
      </div>
      <footer class="av-modal-rodape">
        <button type="button" class="btn btn-secondary av-btn" data-fechar-q>Cancelar</button>
        <button type="button" class="btn btn-primary av-btn" id="av-q-salvar">Salvar questão</button>
      </footer>
    </div></div>`;
}

function linhaAlt(i, a = {}) {
  return `<div class="av-alt" data-i="${i}">
    <label class="av-alt-letra"><input type="radio" name="av-correta" value="${i}" ${a.correta ? 'checked' : ''} aria-label="Alternativa ${LETRAS[i]} é a correta"><span>${LETRAS[i]}</span></label>
    <div class="av-alt-campos">
      <input type="text" class="av-input av-alt-txt" spellcheck="true" lang="pt-BR" maxlength="1500" placeholder="Texto da alternativa ${LETRAS[i]}" value="${esc(P.texto(a.texto || ''))}">
    </div>
    ${i === 4 ? `<button type="button" class="av-icone-btn" data-tirar-alt aria-label="Tirar a alternativa E">${ic('x')}</button>` : ''}
  </div>`;
}

function preencherSelects(q) {
  const { plano, professores } = ed;
  const bim = ed.bimestre || null;
  const profs = [...new Set([...(professores || []), ...(q.professorNome ? [q.professorNome] : [])])];
  $('#av-q-prof').innerHTML = `<option value="">Escolha…</option>${profs.map(n => `<option ${n === q.professorNome ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  // professor logado: o nome vem do perfil e não se troca
  if (ed.travaProfessor) { $('#av-q-prof').innerHTML = `<option>${esc(ed.travaProfessor)}</option>`; }
  $('#av-q-prof').disabled = !!ed.travaProfessor;
  const unids = plano.unidades || [];
  const doBim = bim ? unids.filter(u => u.bimestre === bim) : unids, outras = bim ? unids.filter(u => u.bimestre !== bim) : [];
  const opU = (u) => `<option value="${u.numero}" ${Number(q.unidade) === u.numero ? 'selected' : ''}>Unidade ${u.numero} (${u.ch}h) – ${esc(u.titulo)}</option>`;
  $('#av-q-unid').innerHTML = `<option value="">Escolha…</option>${doBim.length ? `<optgroup label="${bim ? `${ordinal(bim)} bimestre` : 'Unidades do plano de ensino'}">${doBim.map(opU).join('')}</optgroup>` : ''}${outras.length ? `<optgroup label="Outro bimestre">${outras.map(opU).join('')}</optgroup>` : ''}${!unids.length ? [1, 2, 3, 4].map(n => `<option value="${n}" ${Number(q.unidade) === n ? 'selected' : ''}>Unidade ${n}</option>`).join('') : ''}`;
  const objs = plano.objetivos || [];
  const objOutro = q.objetivo && !objs.some(o => P.norm(o) === P.norm(q.objetivo));
  $('#av-q-obj').innerHTML = `<option value="">Escolha…</option>${objs.map(o => `<option ${P.norm(o) === P.norm(q.objetivo || '') ? 'selected' : ''}>${esc(o)}</option>`).join('')}<option value="__outro" ${objOutro ? 'selected' : ''}>Outro objetivo (escrever)</option>`;
  $('#av-q-obj-outro').hidden = !objOutro; $('#av-q-obj-outro').value = objOutro ? q.objetivo : '';
  const refs = plano.referencias || [];
  const refOutra = q.fonte && !refs.includes(q.fonte);
  $('#av-q-ref').innerHTML = `<option value="">Sem referência</option>${refs.map(r => `<option ${r === q.fonte ? 'selected' : ''}>${esc(r.length > 150 ? r.slice(0, 149) + '…' : r)}</option>`).join('')}<option value="__outra" ${refOutra ? 'selected' : ''}>Outra referência (escrever)</option>`;
  // o texto da opção pode estar cortado: guarda o valor inteiro
  [...$('#av-q-ref').options].forEach((o, i) => { if (i > 0 && i <= refs.length) o.value = refs[i - 1]; });
  $('#av-q-ref-outra').hidden = !refOutra; $('#av-q-ref-outra').value = refOutra ? q.fonte : '';
}

function abrirQuestao(id) {
  const q = id ? atual.questoes.find(x => x.id === id) : { alternativas: [{}, {}, {}, {}, {}], dificuldade: 'media', professorNome: filtroProfessor && filtroProfessor !== 'Sem professor' ? filtroProfessor : '' };
  const avId = encodeURIComponent(atual.avaliacao.id);
  ed = {
    modo: 'avaliacao', travaProfessor: null, sigla: atual.avaliacao.sigla, bimestre: atual.avaliacao.bimestre, plano: atual.plano, professores: atual.professores,
    titulo: id ? (q.padronizadaEm || q.status === 'rascunho_avaliacao' ? 'Editar questão' : 'Padronizar questão do banco') : 'Nova questão',
    salvar: (f, qid) => api(qid ? `${BASE}/${avId}/questoes/${encodeURIComponent(qid)}` : `${BASE}/${avId}/questoes`, { method: qid ? 'PUT' : 'POST', body: JSON.stringify(f) }),
    aposSalvar: recarregarAtual, envio: `${BASE}/imagens/envio`,
    imagemAntiga: (qid) => api(`${BASE}/${avId}/questoes/${encodeURIComponent(qid)}/imagem-antiga`)
  };
  abrirEditor(q, id);
}
function abrirEditor(q, id) {
  if (!$('#av-modal-q')) { document.body.insertAdjacentHTML('beforeend', modalHtml()); ligarModalQuestao(); }
  editando = id || null; imgAntiga = null; removerImagem = false; enviandoImgs = 0;
  $('#av-mq-tit').textContent = ed.titulo;
  // disciplina: só no Banco (na avaliação ela já vem da avaliação)
  $('#av-q-disc-campo').hidden = ed.modo !== 'banco';
  if (ed.modo === 'banco') {
    const porPer = {};
    (ed.categorias || []).forEach(c => { (porPer[c.periodo] = porPer[c.periodo] || []).push(c); });
    $('#av-q-disc').innerHTML = `<option value="">Escolha a disciplina…</option>${Object.keys(porPer).sort((a, b) => a - b).map(pp => `<optgroup label="${ordinal(pp)} período">${porPer[pp].map(c => `<option value="${esc(c.id)}" ${c.id === ed.categoriaId ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}</optgroup>`).join('')}`;
  }
  preencherSelects(q);
  $('#av-q-dif').value = q.dificuldade || 'media';
  $('#av-q-nome').value = q.nomeQuestao || '';
  $('#av-q-caso').innerHTML = limpaHtml(q.casoClinico || q.enunciadoHtml || '');
  $('#av-q-perg').value = q.pergunta || '';
  $('#av-q-just').innerHTML = limpaHtml(q.justificativa || '');
  const alts = (q.alternativas && q.alternativas.length ? q.alternativas : [{}, {}, {}, {}, {}]).slice(0, 5);
  $('#av-q-alts').innerHTML = alts.map((a, i) => linhaAlt(i, a)).join('');
  $('#av-q-mais-alt').hidden = alts.length >= 5;
  imgsQuestao = (q.imagens || []).map(i => ({ caminho: i.caminho, nome: i.nome, url: i.url, mimeType: i.mimeType }));
  renderImgs();
  if (q.imagemAntiga) { imgAntiga = q.imagemAntiga; renderImgs(); }
  else if (q.temImagem && id && ed.imagemAntiga) ed.imagemAntiga(id)
    .then(a => { if (a.dataUrl && editando === id) { imgAntiga = a; renderImgs(); } }).catch(() => {});
  $('#av-modal-q').hidden = false;
  document.body.classList.add('av-sem-rolagem');
  atualizarChecklist();
  setTimeout(() => (id ? $('#av-q-caso') : $('#av-q-prof')).focus(), 30);
}
function fecharQuestao() { $('#av-modal-q').hidden = true; document.body.classList.remove('av-sem-rolagem'); }

function lerForm() {
  const objSel = $('#av-q-obj').value, refSel = $('#av-q-ref').value;
  const correta = Number(($('input[name="av-correta"]:checked') || {}).value ?? -1);
  return {
    professorNome: $('#av-q-prof').value,
    unidade: $('#av-q-unid').value,
    dificuldade: $('#av-q-dif').value,
    objetivo: objSel === '__outro' ? $('#av-q-obj-outro').value.trim() : objSel,
    nomeQuestao: $('#av-q-nome').value.replace(/\s+/g, ' ').trim(),
    casoClinico: limpaHtml($('#av-q-caso').innerHTML).trim(),
    pergunta: $('#av-q-perg').value.trim(),
    alternativas: [...document.querySelectorAll('#av-q-alts .av-alt')].map((el, i) => ({ texto: $('.av-alt-txt', el).value.trim(), correta: i === correta })),
    justificativa: limpaHtml($('#av-q-just').innerHTML).trim(),
    fonte: refSel === '__outra' ? $('#av-q-ref-outra').value.trim() : refSel
  };
}
function atualizarChecklist() {
  const f = lerForm();
  const q = { ...f, tipoMoodle: 'multichoice_unica', enunciadoHtml: `${f.casoClinico} ${f.pergunta}` };
  const r = P.avaliarQuestao(q);
  const cods = new Map([...r.bloqueios.map(b => [b.cod, 'erro']), ...r.avisos.map(a => [a.cod, 'aviso'])]);
  const msgs = [...r.bloqueios, ...r.avisos];
  $('#av-check-lista').innerHTML = CHECKLIST.map(item => {
    const st = item.c.some(c => cods.get(c) === 'erro') ? 'erro' : item.c.some(c => cods.get(c) === 'aviso') ? 'aviso' : 'ok';
    const det = msgs.filter(m => item.c.includes(m.cod)).map(m => m.msg);
    return `<li class="av-ck av-ck-${st}"><span class="av-ck-ic">${st === 'ok' ? ic('ok') : st === 'erro' ? ic('x') : ic('alerta')}</span><div>${esc(item.t)}${det.length ? `<small>${esc(det[0])}</small>` : ''}</div></li>`;
  }).join('');
  $('#av-check-rodape').textContent = r.ok ? (r.avisos.length ? 'Pode salvar. As orientações em amarelo são recomendações.' : 'Questão no padrão.') : `${r.bloqueios.length} item(ns) em vermelho impedem a questão de entrar numa avaliação. Você pode salvar e terminar depois.`;
  $('#av-q-titulo-pre').textContent = f.professorNome ? `Prof. ${f.professorNome} –` : 'Prof. (escolha o professor) –';
  $('#av-q-nome').placeholder = f.objetivo ? `Se deixar vazio: ${f.objetivo.slice(0, 90)}` : 'Nome da questão (tema ou objetivo)';
  document.querySelectorAll('#av-q-alts .av-alt').forEach((el, i) => { el.classList.toggle('av-alt-certa', !!(f.alternativas[i] && f.alternativas[i].correta)); });
  renderPortugues();
}

// ---------- corretor de português e ABNT (13/11/2026) — só regras, sem IA (revisao-pt.js) ----------
let ptAchados = [];
function camposTexto() {
  const c = [{ nome: 'Caso clínico', el: $('#av-q-caso'), rico: true }, { nome: 'Pergunta', el: $('#av-q-perg'), opts: { pergunta: true } }];
  document.querySelectorAll('#av-q-alts .av-alt-txt').forEach((el, i) => c.push({ nome: `Alternativa ${LETRAS[i]}`, el }));
  c.push({ nome: 'Feedback', el: $('#av-q-just'), rico: true }, { nome: 'Título', el: $('#av-q-nome') });
  return c;
}
function nosDeTexto(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), out = [];
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.trim()) out.push(n);
  return out;
}
function juntarAchados() {
  const RV = window.RevisaoPt;
  if (!RV) return [];
  const lista = [];
  camposTexto().forEach(c => {
    if (!c.el) return;
    if (c.rico) {
      nosDeTexto(c.el).forEach((no, k) => RV.achar(no.data, { maiuscula: k === 0 }).forEach(a => lista.push({ campo: c.nome, ...a,
        aplicar: () => { no.data = RV.aplicar(no.data, a); }, tudo: () => { no.data = RV.corrigirTudo(no.data, { maiuscula: k === 0 }); } })));
    } else {
      RV.achar(c.el.value, c.opts).forEach(a => lista.push({ campo: c.nome, ...a,
        aplicar: () => { c.el.value = RV.aplicar(c.el.value, a); }, tudo: () => { c.el.value = RV.corrigirTudo(c.el.value, c.opts); } }));
    }
  });
  // referência: a escrita na mão corrige no campo; a do plano de ensino vira "Outra referência" já corrigida
  const sel = $('#av-q-ref');
  const outra = sel && sel.value === '__outra';
  const ref = outra ? $('#av-q-ref-outra').value : (sel ? sel.value : '');
  RV.abnt(ref).forEach(a => lista.push({ campo: 'Referência', ...a,
    aplicar: () => { const novo = RV.aplicar(ref, a); sel.value = '__outra'; $('#av-q-ref-outra').hidden = false; $('#av-q-ref-outra').value = novo; },
    tudo: () => { const v = outra ? $('#av-q-ref-outra').value : ref; const novo = RV.aplicarTodos(v, RV.abnt(v)); sel.value = '__outra'; $('#av-q-ref-outra').hidden = false; $('#av-q-ref-outra').value = novo; } }));
  // alternativas com pontuação desigual
  const alts = [...document.querySelectorAll('#av-q-alts .av-alt-txt')].map(e => e.value.trim()).filter(Boolean);
  const comPonto = alts.filter(a => /\.$/.test(a)).length;
  if (comPonto && comPonto < alts.length) lista.push({ campo: 'Alternativas', de: '', para: '', motivo: 'Pontuação desigual: ou todas terminam com ponto, ou nenhuma.' });
  return lista;
}
function renderPortugues() {
  const ul = $('#av-pt-lista');
  if (!ul) return;
  ptAchados = juntarAchados();
  const corrigiveis = ptAchados.filter(a => a.para).length;
  $('#av-pt-n').textContent = ptAchados.length ? `(${ptAchados.length})` : '';
  $('#av-pt-tudo').hidden = corrigiveis < 2;
  if (!ptAchados.length) { ul.innerHTML = '<li class="av-pt-ok">Nenhum erro encontrado pelas regras. Confira também as palavras sublinhadas em vermelho no texto.</li>'; return; }
  ul.innerHTML = ptAchados.slice(0, 40).map((a, i) => `<li class="av-pt-item">
      <div class="av-pt-campo">${esc(a.campo)}</div>
      ${a.de || a.para ? `<div class="av-pt-troca">${a.de ? `<del>${esc(a.de.trim() || '␣')}</del>` : ''}${a.para ? ` <span aria-hidden="true">→</span> <ins>${esc(a.para.trim() || '␣')}</ins>` : ''}</div>` : ''}
      <small>${esc(a.motivo)}</small>
      ${a.para ? `<button type="button" class="av-pt-btn" data-pt="${i}">Corrigir</button>` : ''}
    </li>`).join('') + (ptAchados.length > 40 ? `<li class="av-pt-ok">… e mais ${ptAchados.length - 40}. Corrija estes primeiro.</li>` : '');
}

async function salvarQuestao() {
  const btn = $('#av-q-salvar');
  const f = lerForm();
  if (P.texto(f.casoClinico).length + f.pergunta.length < 5) { toast('Escreva o caso clínico e a pergunta.', 'erro'); return; }
  if (enviandoImgs) { toast('Espere as imagens terminarem de subir.', 'aviso'); return; }
  f.imagens = imgsQuestao.map(i => ({ caminho: i.caminho, nome: i.nome }));
  if (removerImagem) f.manterImagem = false;
  btn.disabled = true; btn.textContent = 'Salvando…';
  try {
    if (ed.modo === 'banco' && !ed.categoriaId) { toast('Escolha a disciplina da questão.', 'erro'); return; }
    const r = await ed.salvar(f, editando);
    fecharQuestao();
    toast(r.padrao && r.padrao.ok ? `${r.message} No padrão.` : r.message);
    await ed.aposSalvar();
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; btn.textContent = 'Salvar questão'; }
}

function renderImgs() {
  const caixa = $('#av-q-imgs'); if (!caixa) return;
  const itens = [];
  if (imgAntiga && !removerImagem) itens.push(`<figure class="av-img"><img src="${imgAntiga.dataUrl}" alt=""><figcaption>Imagem antiga (comprimida)</figcaption><button type="button" class="av-icone-btn" data-tirar-antiga aria-label="Remover imagem antiga">${ic('x')}</button></figure>`);
  imgsQuestao.forEach((im, i) => itens.push(`<figure class="av-img"><img src="${esc(im.url)}" alt=""><figcaption>${esc(im.nome)}${/gif/.test(im.mimeType || '') ? ' · GIF' : ''}</figcaption><button type="button" class="av-icone-btn" data-tirar-img="${i}" aria-label="Remover ${esc(im.nome)}">${ic('x')}</button></figure>`));
  if (enviandoImgs) itens.push(`<figure class="av-img av-img-env"><span class="av-spin"></span><figcaption>Enviando ${enviandoImgs}…</figcaption></figure>`);
  caixa.innerHTML = itens.join('');
}
async function enviarImagem(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error(`"${file.name}" não é imagem PNG, JPG, GIF ou WEBP.`);
  if (file.size > 25 * 1024 * 1024) throw new Error(`"${file.name}" passa de 25 MB.`);
  const envio = await api((ed && ed.envio) || `${BASE}/imagens/envio`, { method: 'POST', body: JSON.stringify({ nome: file.name, mimeType: file.type, tamanho: file.size }) });
  const r = await fetch(envio.url, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!r.ok) throw new Error(`Não consegui enviar "${file.name}". Tente de novo.`);
  return { caminho: envio.caminho, nome: file.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(file), mimeType: file.type };
}

function ligarModalQuestao() {
  const m = $('#av-modal-q');
  m.addEventListener('click', (e) => {
    if (e.target.closest('[data-fechar-q]') || e.target === m) return fecharQuestao();
    if (e.target.closest('[data-tirar-alt]')) { e.target.closest('.av-alt').remove(); $('#av-q-mais-alt').hidden = false; atualizarChecklist(); }
    const ti = e.target.closest('[data-tirar-img]');
    if (ti) { imgsQuestao.splice(Number(ti.dataset.tirarImg), 1); renderImgs(); }
    if (e.target.closest('[data-tirar-antiga]')) { removerImagem = true; renderImgs(); }
    const bt = e.target.closest('[data-pt]');
    if (bt) { const a = ptAchados[Number(bt.dataset.pt)]; if (a) { a.aplicar(); atualizarChecklist(); } }
    if (e.target.closest('#av-pt-tudo')) { const feitos = new Set(); ptAchados.filter(a => a.para).forEach(a => { const k = a.campo; if (!feitos.has(k)) { feitos.add(k); a.tudo(); } }); atualizarChecklist(); toast('Correções aplicadas. Confira o texto antes de salvar.', 'ok'); }
  });
  m.addEventListener('input', atualizarChecklist);
  m.addEventListener('change', (e) => {
    if (e.target.id === 'av-q-disc') { trocarDisciplinaEditor(e.target.value); return; }
    if (e.target.id === 'av-q-obj') { $('#av-q-obj-outro').hidden = e.target.value !== '__outro'; if (e.target.value === '__outro') $('#av-q-obj-outro').focus(); }
    if (e.target.id === 'av-q-ref') { $('#av-q-ref-outra').hidden = e.target.value !== '__outra'; if (e.target.value === '__outra') $('#av-q-ref-outra').focus(); }
    atualizarChecklist();
  });
  $('#av-q-mais-alt').addEventListener('click', () => { $('#av-q-alts').insertAdjacentHTML('beforeend', linhaAlt(4)); $('#av-q-mais-alt').hidden = true; atualizarChecklist(); });
  $('#av-q-salvar').addEventListener('click', salvarQuestao);
  $('#av-q-img').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (imgsQuestao.length + files.length > 8) { toast('No máximo 8 imagens por questão.', 'aviso'); return; }
    enviandoImgs += files.length; renderImgs();
    for (const file of files) {
      try { imgsQuestao.push(await enviarImagem(file)); }
      catch (err) { toast(err.message, 'erro'); }
      finally { enviandoImgs--; renderImgs(); }
    }
  });
  // colar no editor rico: só texto com quebras (Word traz estilo que quebra o AVA)
  m.querySelectorAll('.av-rico').forEach(el => el.addEventListener('paste', (e) => {
    const html = e.clipboardData.getData('text/html');
    if (!html) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, limpaHtml(html));
  }));
}

// ==========================================================================================
// MODAL: importar (Word / PDF / texto) — prévia antes de salvar
// ==========================================================================================
let previaImport = [];
function abrirImportar() {
  let m = $('#av-modal-imp');
  if (!m) {
    document.body.insertAdjacentHTML('beforeend', `<div class="av-modal-fundo" id="av-modal-imp" hidden>
      <div class="av-modal av-modal-medio" role="dialog" aria-modal="true" aria-labelledby="av-mi-tit">
        <header class="av-modal-cab"><h2 id="av-mi-tit">Importar questões</h2><button type="button" class="av-icone-btn" data-fechar-imp aria-label="Fechar">${ic('x')}</button></header>
        <div class="av-modal-corpo">
          <p class="av-nota">Questões numeradas ("Questão 1", "1.", "1)") com alternativas a) a e). Uma linha "Gabarito: C" depois da questão já marca a correta. No Word (.docx), as imagens e GIFs vêm junto com a questão.</p>
          <p class="av-modelo-baixar"><a class="btn btn-secondary av-btn" href="/banco-med-fatec/modelo-questoes-medicina.docx" download>Baixar o modelo de questões (Word)</a><span class="av-nota">Questão 01 → linha Disciplina – Tema – Dificuldade → Enunciado → alternativas (a <b>correta pintada de amarelo</b>) → Feedback da Questão → Referência Bibliográfica.</span></p>
          <div class="av-campos2">
            <label class="av-campo"><span>Arquivo Word ou PDF</span><input type="file" id="av-imp-arq" accept=".docx,.doc,.pdf"></label>
            <label class="av-campo"><span>Professor de todas as questões</span><select id="av-imp-prof"></select></label>
          </div>
          <label class="av-campo"><span>…ou cole o texto</span><textarea id="av-imp-txt" rows="7" class="av-input" placeholder="1. Paciente de 45 anos…&#10;a) …&#10;b) …&#10;Gabarito: B"></textarea></label>
          <div class="av-campos2">
            <label class="av-campo"><span>Unidade de todas as questões</span><select id="av-imp-unid"></select></label>
            <div class="av-campo av-campo-acao"><button type="button" class="btn btn-secondary av-btn" id="av-imp-ler">Ler as questões</button></div>
          </div>
          <div id="av-imp-previa"></div>
        </div>
        <footer class="av-modal-rodape">
          <button type="button" class="btn btn-secondary av-btn" data-fechar-imp>Cancelar</button>
          <button type="button" class="btn btn-primary av-btn" id="av-imp-salvar" disabled>Importar para a avaliação</button>
        </footer>
      </div></div>`);
    m = $('#av-modal-imp');
    m.addEventListener('click', (e) => { if (e.target.closest('[data-fechar-imp]') || e.target === m) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); } });
    $('#av-imp-ler').addEventListener('click', lerImportacao);
    $('#av-imp-salvar').addEventListener('click', salvarImportacao);
    m.addEventListener('change', (e) => { if (e.target.matches('.av-imp-gab')) { previaImport[Number(e.target.dataset.i)].gabarito = e.target.value || null; mostrarPrevia(''); } });
  }
  $('#av-imp-prof').innerHTML = `<option value="">Definir depois</option>${atual.professores.map(n => `<option>${esc(n)}</option>`).join('')}`;
  $('#av-imp-unid').innerHTML = `<option value="">Definir depois</option>${(atual.plano.unidades || []).filter(u => u.bimestre === atual.avaliacao.bimestre).map(u => `<option value="${u.numero}">Unidade ${u.numero} – ${esc(u.titulo)}</option>`).join('')}`;
  $('#av-imp-arq').value = ''; $('#av-imp-txt').value = ''; $('#av-imp-previa').innerHTML = ''; previaImport = []; $('#av-imp-salvar').disabled = true;
  m.hidden = false; document.body.classList.add('av-sem-rolagem');
}
async function lerImportacao() {
  const arq = $('#av-imp-arq').files[0], txt = $('#av-imp-txt').value.trim();
  if (!arq && !txt) { toast('Escolha o arquivo ou cole o texto.', 'erro'); return; }
  const btn = $('#av-imp-ler'); btn.disabled = true; btn.textContent = 'Lendo…';
  try {
    // Word .docx: lido aqui no navegador, com as imagens (Word com GIF passa do limite de envio do servidor)
    if (arq && /\.docx$/i.test(arq.name)) {
      // 1º o modelo de prova da Medicina (Questão / Enunciado / Feedback / Referência, correta em amarelo)
      const doModelo = await window.LerWord.lerModelo(arq);
      if (doModelo && doModelo.length) { previaImport = doModelo; mostrarPrevia(''); return; }
      const itens = await window.LerWord.ler(arq);
      previaImport = P.lerQuestoesDeLinhas(itens);
      if (!previaImport.length) throw new Error('Não encontrei questões objetivas. As questões precisam estar numeradas ("Questão 1", "1.", "2)") com as alternativas a), b), c)...');
      mostrarPrevia('');
      return;
    }
    const body = { texto: txt };
    if (arq) {
      const b64 = await new Promise((ok, falha) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = falha; r.readAsDataURL(arq); });
      Object.assign(body, { arquivoBase64: b64, nomeArquivo: arq.name, texto: '' });
    }
    const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/importar/analisar`, { method: 'POST', body: JSON.stringify(body) });
    previaImport = r.questoes;
    mostrarPrevia(r.aviso);
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; btn.textContent = 'Ler as questões'; }
}
function mostrarPrevia(aviso) {
  {
    const semGab = previaImport.filter(q => !q.gabarito).length;
    const nImg = previaImport.reduce((s2, q) => s2 + (q.imagens || []).length, 0);
    $('#av-imp-previa').innerHTML = `
      <p class="av-nota"><b>${previaImport.length}</b> questão(ões) encontrada(s)${nImg ? `, com <b>${nImg}</b> imagem(ns)` : ''}.${semGab ? ` ${semGab} sem gabarito: marque abaixo.` : ''} ${aviso ? esc(aviso) : ''}</p>
      <ol class="av-previa">${previaImport.map((q, i) => `<li>${q.tema || q.tituloOriginal ? `<div class="av-previa-meta">${q.tema ? `<span class="av-tag">${esc(q.tema)}</span>` : ''}${q.dificuldade ? `<span class="av-tag">${esc({ facil: 'Fácil', media: 'Média', intermediaria: 'Intermediária', dificil: 'Difícil' }[q.dificuldade] || q.dificuldade)}</span>` : ''}${q.justificativa ? '<span class="av-selo av-selo-ok">Feedback</span>' : '<span class="av-selo av-selo-erro">Sem feedback</span>'}${q.fonte ? '<span class="av-selo av-selo-ok">Referência</span>' : ''}${q.gabarito ? '' : '<span class="av-selo av-selo-erro">Sem marca-texto: marque a correta</span>'}</div>` : ''}<p>${esc(q.enunciado.slice(0, 260))}${q.enunciado.length > 260 ? '…' : ''}</p>
        ${(q.imagens || []).length ? `<div class="av-previa-imgs">${q.imagens.map(im => `<img src="${im.dataUrl}" alt="">`).join('')}</div>` : ''}
        <div class="av-previa-alts">${q.alternativas.map((a, j) => `<span class="${q.gabarito === LETRAS[j] ? 'av-previa-certa' : ''}"><b>${LETRAS[j]})</b> ${esc(String(a).slice(0, 90))}</span>`).join('')}</div>
        <label class="av-previa-gab">Correta <select class="av-imp-gab" data-i="${i}"><option value="">?</option>${q.alternativas.map((a, j) => `<option ${q.gabarito === LETRAS[j] ? 'selected' : ''}>${LETRAS[j]}</option>`).join('')}</select></label></li>`).join('')}</ol>`;
    $('#av-imp-salvar').disabled = !previaImport.length;
  }
}
async function dataUrlParaArquivo(dataUrl, nome) {
  const blob = await (await fetch(dataUrl)).blob();
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([blob], `${nome}.${ext}`, { type: blob.type });
}
async function salvarImportacao() {
  const btn = $('#av-imp-salvar'); btn.disabled = true;
  try {
    // sobe as imagens do Word pro Storage antes; a questão só leva o caminho
    const total = previaImport.reduce((s2, q) => s2 + (q.imagens || []).length, 0);
    let feitas = 0;
    const questoes = [];
    for (const q of previaImport) {
      const imagens = [];
      for (const [j, im] of (q.imagens || []).slice(0, 8).entries()) {
        btn.textContent = `Enviando imagens ${++feitas}/${total}…`;
        const env = await enviarImagem(await dataUrlParaArquivo(im.dataUrl, `questao-${q.numero}-${j + 1}`));
        imagens.push({ caminho: env.caminho, nome: env.nome });
      }
      questoes.push({ numero: q.numero, enunciado: q.enunciado, alternativas: q.alternativas, gabarito: q.gabarito, imagens,
        ...(q.pergunta !== undefined && q.casoHtml !== undefined ? { casoHtml: q.casoHtml, pergunta: q.pergunta, justificativa: q.justificativa, fonte: q.fonte, dificuldade: q.dificuldade, tema: q.tema } : {}) });
    }
    btn.textContent = 'Importando…';
    const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/importar`, { method: 'POST', body: JSON.stringify({ questoes, professorNome: $('#av-imp-prof').value, unidade: $('#av-imp-unid').value }) });
    $('#av-modal-imp').hidden = true; document.body.classList.remove('av-sem-rolagem');
    toast(r.message); await recarregarAtual();
  } catch (e) { toast(e.message, 'erro'); btn.disabled = false; }
  finally { btn.textContent = 'Importar para a avaliação'; }
}

// ==========================================================================================
// MODAL: pegar do banco da disciplina
// ==========================================================================================
let bancoLista = [];
async function abrirBanco() {
  let m = $('#av-modal-banco');
  if (!m) {
    document.body.insertAdjacentHTML('beforeend', `<div class="av-modal-fundo" id="av-modal-banco" hidden>
      <div class="av-modal av-modal-medio" role="dialog" aria-modal="true" aria-labelledby="av-mb-tit">
        <header class="av-modal-cab"><h2 id="av-mb-tit">Banco da disciplina</h2><button type="button" class="av-icone-btn" data-fechar-banco aria-label="Fechar">${ic('x')}</button></header>
        <div class="av-modal-corpo">
          <div class="av-banco-filtros">
            <input type="search" id="av-banco-busca" class="av-input" placeholder="Buscar no enunciado ou no título">
            <select id="av-banco-filtro"><option value="">Todas</option><option value="padrao">No padrão</option><option value="caso">Caso clínico</option><option value="fora">A padronizar</option></select>
          </div>
          <p class="av-nota">Questões fora do padrão podem entrar, mas precisam ser padronizadas antes de finalizar a avaliação.</p>
          <div id="av-banco-lista" class="av-banco-lista"></div>
        </div>
        <footer class="av-modal-rodape">
          <span id="av-banco-sel" class="av-nota"></span>
          <button type="button" class="btn btn-secondary av-btn" data-fechar-banco>Cancelar</button>
          <button type="button" class="btn btn-primary av-btn" id="av-banco-add" disabled>Adicionar à avaliação</button>
        </footer>
      </div></div>`);
    m = $('#av-modal-banco');
    m.addEventListener('click', (e) => { if (e.target.closest('[data-fechar-banco]') || e.target === m) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); } });
    m.addEventListener('input', (e) => { if (e.target.id === 'av-banco-busca') renderBanco(); });
    m.addEventListener('change', (e) => { if (e.target.id === 'av-banco-filtro') renderBanco(); if (e.target.matches('.av-banco-ck')) contarBanco(); });
    $('#av-banco-add').addEventListener('click', adicionarDoBanco);
  }
  $('#av-banco-lista').innerHTML = '<div class="av-carregando"><span class="av-spin"></span>Lendo o banco da disciplina…</div>';
  $('#av-banco-busca').value = ''; $('#av-banco-filtro').value = '';
  m.hidden = false; document.body.classList.add('av-sem-rolagem');
  try { const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/banco`); bancoLista = r.questoes; renderBanco(r.aviso); }
  catch (e) { $('#av-banco-lista').innerHTML = `<div class="av-vazio">${esc(e.message)}</div>`; }
}
function renderBanco(aviso) {
  const b = P.norm($('#av-banco-busca').value), f = $('#av-banco-filtro').value;
  const marcadas = new Set([...document.querySelectorAll('.av-banco-ck:checked')].map(x => x.value));
  const l = bancoLista.filter(q => (!b || P.norm(`${q.titulo} ${q.enunciado}`).includes(b)) && (!f || (f === 'padrao' && q.padronizada) || (f === 'fora' && !q.padronizada) || (f === 'caso' && q.aplicacao)));
  $('#av-banco-lista').innerHTML = l.length ? l.slice(0, 300).map(q => `
    <label class="av-bq ${q.naAvaliacao ? 'av-bq-ja' : ''}">
      <input type="checkbox" class="av-banco-ck" value="${esc(q.id)}" ${q.naAvaliacao ? 'disabled checked' : marcadas.has(q.id) ? 'checked' : ''}>
      <div><div class="av-q-topo">${q.professorNome ? chipProfessor(q.professorNome) : ''}${q.semestre ? `<span class="av-tag">${esc(q.semestre)}${q.bimestre ? ` · ${ordinal(q.bimestre)} bim` : ''}</span>` : ''}
        <span class="av-tag ${q.aplicacao ? 'av-tag-caso' : ''}">${q.aplicacao ? 'Caso clínico' : 'Memorização'}</span>
        ${q.padronizada ? `<span class="av-selo av-selo-ok">${ic('ok')}No padrão</span>` : `<span class="av-selo av-selo-erro">A padronizar</span>`}${q.naAvaliacao ? '<span class="av-tag">Já está na avaliação</span>' : ''}</div>
        <p class="av-q-obj">${esc(q.titulo || '')}</p><p class="av-q-enun">${esc(q.enunciado)}</p></div>
    </label>`).join('') + (l.length > 300 ? `<p class="av-nota">Mostrando 300 de ${l.length}. Use a busca.</p>` : '') : `<div class="av-vazio">${esc(aviso || 'Nenhuma questão encontrada.')}</div>`;
  contarBanco();
}
function contarBanco() {
  const n = document.querySelectorAll('.av-banco-ck:checked:not(:disabled)').length;
  $('#av-banco-sel').textContent = n ? `${n} selecionada(s)` : '';
  $('#av-banco-add').disabled = !n;
}
async function adicionarDoBanco() {
  const ids = [...document.querySelectorAll('.av-banco-ck:checked:not(:disabled)')].map(x => x.value);
  try {
    const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/banco`, { method: 'POST', body: JSON.stringify({ ids }) });
    $('#av-modal-banco').hidden = true; document.body.classList.remove('av-sem-rolagem');
    toast(r.message); await recarregarAtual();
  } catch (e) { toast(e.message, 'erro'); }
}


// ==========================================================================================
// CRITÉRIOS DA DISCIPLINA (12/11/2026) — o professor responsável define peso das unidades, bimestre de cada
// unidade, % mínimo de caso clínico e tolerância. Quem define: a responsável pelas avaliações (Ana Beatriz) / coordenação.
// ==========================================================================================
const CRIT = '/banco-med-fatec/avaliacoes/criterios';
let critAtual = null, aoSalvarCrit = null;
function dataBR(iso) { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('pt-BR'); }


export async function abrirCriterios(chave, depois) {
  aoSalvarCrit = depois || null;
  let m = $('#av-modal-crit');
  if (!m) {
    document.body.insertAdjacentHTML('beforeend', `<div class="av-modal-fundo" id="av-modal-crit" hidden>
      <div class="av-modal av-modal-medio" role="dialog" aria-modal="true" aria-labelledby="av-mc-tit">
        <header class="av-modal-cab"><h2 id="av-mc-tit">Critérios da disciplina</h2><button type="button" class="av-icone-btn" data-fechar-crit aria-label="Fechar">${ic('x')}</button></header>
        <div class="av-modal-corpo" id="av-mc-corpo"></div>
        <footer class="av-modal-rodape">
          <button type="button" class="btn btn-secondary av-btn" data-padrao-crit>Voltar ao padrão</button>
          <button type="button" class="btn btn-secondary av-btn" data-fechar-crit>Cancelar</button>
          <button type="button" class="btn btn-primary av-btn" id="av-mc-salvar">Salvar critérios</button>
        </footer>
      </div></div>`);
    m = $('#av-modal-crit');
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-fechar-crit]') || e.target === m) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); }
      if (e.target.closest('[data-padrao-crit]')) preencherCriterios(true);
    });
    m.addEventListener('input', resumoPesos);
    m.addEventListener('click', (e) => { if (e.target.closest('[data-dividir]')) dividirIgualmente(); });
    m.addEventListener('change', async (e) => {
      resumoPesos();
    });
    $('#av-mc-salvar').addEventListener('click', salvarCriterios);
  }
  $('#av-mc-corpo').innerHTML = '<div class="av-carregando"><span class="av-spin"></span>Buscando o plano de ensino…</div>';
  m.hidden = false; document.body.classList.add('av-sem-rolagem');
  try {
    critAtual = await api(`${CRIT}/${encodeURIComponent(chave)}?semestre=${semestre}`);
    preencherCriterios(false);
  } catch (e) { $('#av-mc-corpo').innerHTML = `<div class="av-vazio">${esc(e.message)}</div>`; }
}

function preencherCriterios(voltarPadrao) {
  const c = critAtual, cr = voltarPadrao ? { bimestres: {}, pesos: {}, limites: {}, qtdQuestoes: null, porProfessor: {} } : c.criterios;
  const lim = { ...c.padrao, ...(cr.limites || {}) };
  const quemDefiniu = c.criterios.definidos ? `Definidos por ${esc(c.criterios.definidoPor)} em ${dataBR(c.criterios.definidoEm)}.` : 'Ainda não definidos: as avaliações desta disciplina usam o padrão (peso = carga horária, metade das unidades em cada bimestre).';
  $('#av-mc-tit').textContent = `Critérios — ${c.disciplina}`;
  $('#av-mc-corpo').innerHTML = `
    <p class="av-nota">${quemDefiniu}</p>

    <h3 class="av-mc-h">Tamanho da prova e divisão entre os professores</h3>
    <div class="av-mc-qtd">
      <label class="av-campo"><span>Questões por prova</span><input type="number" id="av-mc-total" class="av-input" min="0" max="300" value="${cr.qtdQuestoes || ''}" placeholder="ex.: 20"></label>
      <button type="button" class="btn btn-secondary av-btn" data-dividir>Dividir igualmente</button>
    </div>
    ${(c.professores || []).length ? `<div class="av-mc-profs">${c.professores.map(n => `<label class="av-mc-prof">${chipProfessor(n)}<input type="number" class="av-input av-mc-prof-n" data-prof="${esc(n)}" min="0" max="300" value="${(cr.porProfessor || {})[n] || ''}" placeholder="0" aria-label="Questões de ${esc(n)}"></label>`).join('')}</div>
    <p class="av-nota" id="av-mc-soma"></p>` : '<p class="av-nota">O Edubox não tem professores lançados nesta disciplina.</p>'}

    <h3 class="av-mc-h">Unidades do plano de ensino <small>Edubox ${esc(c.semestreFonte || '')}</small></h3>
    ${c.unidades.length ? `<table class="av-mc-tab">
      <thead><tr><th>Unidade</th><th>CH</th><th>Bimestre</th><th>Peso na prova</th></tr></thead>
      <tbody>${c.unidades.map(u => {
        const bim = (cr.bimestres || {})[u.numero] || u.bimestre;
        const peso = (cr.pesos || {})[u.numero] ?? u.ch;
        return `<tr data-u="${u.numero}">
          <td><b>Unidade ${u.numero}</b><small>${esc(u.titulo)}</small></td>
          <td>${u.ch}h</td>
          <td><select class="av-mc-bim" aria-label="Bimestre da unidade ${u.numero}"><option value="1" ${bim === 1 ? 'selected' : ''}>1º</option><option value="2" ${bim === 2 ? 'selected' : ''}>2º</option></select></td>
          <td><input type="number" class="av-input av-mc-peso" min="0" max="1000" step="1" value="${peso}" aria-label="Peso da unidade ${u.numero}"><small class="av-mc-pct"></small></td>
        </tr>`; }).join('')}</tbody></table>
      <p class="av-nota">O peso define quantas questões cada unidade deve ter dentro do bimestre. Igual à carga horária = proporcional às horas; peso 0 = a unidade não entra na prova.</p>`
      : `<p class="av-nota av-nota-aviso">O plano de ensino desta disciplina não está preenchido no Edubox.</p>`}

    <h3 class="av-mc-h">Equilíbrio e tolerância</h3>
    <div class="av-campos3">
      <label class="av-campo"><span>Mínimo de caso clínico (%)</span><input type="number" id="av-mc-caso" class="av-input" min="0" max="100" value="${lim.minCaso}"></label>
      <label class="av-campo"><span>Avisar se a unidade tiver menos de (% do esperado)</span><input type="number" id="av-mc-abaixo" class="av-input" min="0" max="100" value="${lim.abaixo}"></label>
      <label class="av-campo"><span>Avisar se tiver mais de (% do esperado)</span><input type="number" id="av-mc-acima" class="av-input" min="100" max="500" value="${lim.acima}"></label>
    </div>
    <p class="av-nota">Padrão: ${c.padrao.minCaso}% de caso clínico; avisa abaixo de ${c.padrao.abaixo}% e acima de ${c.padrao.acima}% do esperado. São avisos para quem monta a prova — não impedem finalizar.</p>`;
  resumoPesos();
}

function resumoCotas() {
  const el = $('#av-mc-soma'); if (!el) return;
  const qtd = Number(($('#av-mc-total') || {}).value) || 0;
  const soma = [...document.querySelectorAll('.av-mc-prof-n')].reduce((t, i) => t + (Number(i.value) || 0), 0);
  el.textContent = !qtd ? 'Defina quantas questões a prova tem para dividir entre os professores.' : soma === qtd ? `A divisão soma as ${qtd} questões da prova.` : `A divisão soma ${soma} de ${qtd} questões.`;
  el.classList.toggle('av-nota-aviso', !!qtd && soma !== qtd);
}
function dividirIgualmente() {
  const qtd = Number(($('#av-mc-total') || {}).value) || 0;
  const campos = [...document.querySelectorAll('.av-mc-prof-n')];
  if (!qtd || !campos.length) { toast('Defina primeiro quantas questões a prova tem.', 'aviso'); return; }
  const base = Math.floor(qtd / campos.length), resto = qtd % campos.length;
  campos.forEach((c, i) => { c.value = base + (i < resto ? 1 : 0); });
  resumoPesos();
}
function resumoPesos() {
  resumoCotas();
  [1, 2].forEach(b => {
    const linhas = [...document.querySelectorAll('#av-mc-corpo .av-mc-tab tbody tr')].filter(tr => Number(tr.querySelector('.av-mc-bim').value) === b);
    const total = linhas.reduce((s, tr) => s + (Number(tr.querySelector('.av-mc-peso').value) || 0), 0);
    const qtd = Number(($('#av-mc-total') || {}).value) || 0;
    linhas.forEach(tr => { const p = Number(tr.querySelector('.av-mc-peso').value) || 0; tr.querySelector('.av-mc-pct').textContent = total ? `${Math.round(100 * p / total)}% do ${b}º bimestre${qtd ? ` = ${Math.round(qtd * p / total * 10) / 10} questões` : ''}` : ''; });
  });
}

async function salvarCriterios() {
  const bimestres = {}, pesos = {};
  document.querySelectorAll('#av-mc-corpo .av-mc-tab tbody tr').forEach(tr => {
    bimestres[tr.dataset.u] = Number(tr.querySelector('.av-mc-bim').value);
    pesos[tr.dataset.u] = Number(tr.querySelector('.av-mc-peso').value);
  });
  const limites = { minCaso: Number($('#av-mc-caso').value), abaixo: Number($('#av-mc-abaixo').value), acima: Number($('#av-mc-acima').value) };
  const btn = $('#av-mc-salvar'); btn.disabled = true;
  try {
    const porProfessor = {};
    document.querySelectorAll('.av-mc-prof-n').forEach(i => { if (Number(i.value) > 0) porProfessor[i.dataset.prof] = Number(i.value); });
    const qtdQuestoes = Number(($('#av-mc-total') || {}).value) || null;
    const r = await api(`${CRIT}/${encodeURIComponent(critAtual.chave)}`, { method: 'PUT', body: JSON.stringify({ bimestres, pesos, limites, qtdQuestoes, porProfessor, semestre }) });
    $('#av-modal-crit').hidden = true; document.body.classList.remove('av-sem-rolagem');
    toast(r.message);
    const d = disciplinas.find(x => x.chave === critAtual.chave); if (d) d.criteriosDefinidos = true;
    if (aoSalvarCrit) await aoSalvarCrit();
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; }
}


// ==========================================================================================
// EDITOR PADRÃO NO BANCO DE QUESTÕES (13/11/2026) — mesmo editor da montagem da avaliação
// ==========================================================================================
const VAZIO_PLANO = { unidades: [], objetivos: [], referencias: [] };
async function contextoDisciplina(categoriaId) {
  if (!categoriaId) return { sigla: '', plano: VAZIO_PLANO, professores: [] };
  try { return await api(`/banco-med-fatec/contexto/${encodeURIComponent(categoriaId)}`); }
  catch (e) { toast(e.message, 'erro'); return { sigla: '', plano: VAZIO_PLANO, professores: [] }; }
}
async function trocarDisciplinaEditor(categoriaId) {
  ed.categoriaId = categoriaId || null;
  const ctx = await contextoDisciplina(categoriaId);
  Object.assign(ed, { sigla: ctx.sigla, plano: ctx.plano || VAZIO_PLANO, professores: ctx.professores || [] });
  const f = lerForm();
  preencherSelects({ ...f, fonte: f.fonte });
  atualizarChecklist();
}
// professor de Medicina: só as disciplinas que ele dá no semestre (Edubox) e o nome do perfil fixo no título
let euProfessor = null;
async function perfilProfessor() {
  if (!euProfessor) euProfessor = await api('/banco-med-fatec/eu-professor');
  return euProfessor;
}
export async function abrirEditorBanco({ questaoId = null, categoriaId = null, categorias = [], aposSalvar = async () => {} } = {}) {
  let q = { alternativas: [{}, {}, {}, {}, {}], dificuldade: 'media' };
  let eu;
  try { eu = await perfilProfessor(); } catch (e) { toast(e.message, 'erro'); return; }
  if (eu.restrito) {
    categorias = categorias.filter(c => eu.categoriaIds.includes(c.id));
    if (!categorias.length) { toast(`Você não aparece como professor(a) de nenhuma disciplina de Medicina em ${eu.semestre} no Edubox. Fale com a coordenação.`, 'erro'); return; }
  }
  if (questaoId) {
    try { q = await api(`/banco-med-fatec/questoes/${encodeURIComponent(questaoId)}/completa`); }
    catch (e) { toast(e.message, 'erro'); return; }
    categoriaId = q.categoriaId || categoriaId;
    if (eu.restrito && !eu.categoriaIds.includes(categoriaId)) { toast(`Esta questão é de uma disciplina em que você não é professor(a) em ${eu.semestre}.`, 'erro'); return; }
  }
  if (eu.restrito) {
    if (!eu.categoriaIds.includes(categoriaId)) categoriaId = categorias.length === 1 ? categorias[0].id : null;
    if (!questaoId) q.professorNome = eu.nome;
  }
  const ctx = await contextoDisciplina(categoriaId);
  ed = {
    modo: 'banco', categorias, categoriaId: categoriaId || null, sigla: ctx.sigla, bimestre: null,
    travaProfessor: eu.restrito ? (q.professorNome || eu.nome) : null,
    plano: ctx.plano || VAZIO_PLANO, professores: ctx.professores || [],
    titulo: questaoId ? (q.padronizadaEm ? 'Editar questão' : 'Padronizar questão') : 'Nova questão',
    salvar: (f, qid) => api(qid ? `/banco-med-fatec/questoes-padrao/${encodeURIComponent(qid)}` : '/banco-med-fatec/questoes-padrao', { method: qid ? 'PUT' : 'POST', body: JSON.stringify({ ...f, categoriaId: ed.categoriaId }) }),
    aposSalvar, envio: '/banco-med-fatec/imagens/envio'
  };
  abrirEditor(q, questaoId);
}

// ==========================================================================================
// CONFERÊNCIA CADAM (13/11/2026) — relatório da prova no padrão da aula "Avaliação CADAM" + português + ABNT.
// Só regras (padrao.js + revisao-pt.js), sem IA. O professor vê SÓ as questões dele (o servidor filtra);
// a Bia / coordenação veem a prova inteira pela aba Avaliações.
// ==========================================================================================
const SIT = { ok: 'Aprovada', ajustar: 'Ajustar', refazer: 'Refazer' };
function conferirQuestao(q) {
  // o enunciado é sempre caso + pergunta (como no editor)
  if (q.casoClinico || q.pergunta) q = { ...q, enunciadoHtml: `${q.casoClinico || ''} ${q.pergunta || ''}` };
  const pd = P.avaliarQuestao(q);
  const pt = window.RevisaoPt ? window.RevisaoPt.revisarQuestao(q, P.texto) : [];
  const sit = !pd.ok ? 'refazer' : (pd.avisos.length || pt.length) ? 'ajustar' : 'ok';
  return { q, pd, pt, sit };
}
function minutosProva(itens) {
  // CADAM: caso clínico 5 min, múltipla escolha direta 3 min (+ 15 a 20 min de revisão)
  return itens.reduce((s, x) => s + (x.pd.aplicacao ? 5 : 3), 0);
}
function relatorioHtml({ sub, questoes, totalProva, deQuem, editar }) {
  const itens = questoes.map(conferirQuestao);
  const conta = (k) => itens.filter(x => x.sit === k).length;
  const erros = itens.reduce((s, x) => s + x.pt.length, 0);
  const min = minutosProva(itens);
  const lista = itens.map(({ q, pd, pt, sit }) => `
    <li class="av-conf-q av-conf-${sit}">
      <div class="av-conf-q-cab">
        <span class="av-conf-num">Questão ${q.numero}</span>
        <span class="av-conf-sit">${SIT[sit]}</span>
        ${deQuem ? `<span class="av-conf-prof">${esc(q.professorNome || 'Sem professor')}</span>` : ''}
        ${editar ? `<button type="button" class="av-pt-btn av-conf-editar" data-conf-editar="${esc(q.id)}">Abrir e corrigir</button>` : ''}
      </div>
      <p class="av-conf-tit">${esc(q.nomeQuestao || q.objetivo || q.titulo || '')}</p>
      <p class="av-conf-enun">${esc(P.texto(q.pergunta || q.casoClinico || q.enunciadoHtml).slice(0, 220))}</p>
      ${pd.bloqueios.length ? `<h5 class="av-conf-h-erro">Fora do padrão (precisa corrigir)</h5><ul>${pd.bloqueios.map(b => `<li>${esc(b.msg)}</li>`).join('')}</ul>` : ''}
      ${pd.avisos.length ? `<h5 class="av-conf-h-aviso">Recomendações CADAM</h5><ul>${pd.avisos.map(a => `<li>${esc(a.msg)}</li>`).join('')}</ul>` : ''}
      ${pt.length ? `<h5 class="av-conf-h-pt">Português e ABNT</h5><ul class="av-conf-pt">${pt.map(a => `<li><span class="av-conf-campo">${esc(a.campo)}</span> ${a.de ? `<del>${esc(a.de.trim())}</del>` : ''}${a.para ? ` → <ins>${esc(a.para.trim())}</ins>` : ''} <small>${esc(a.motivo)}</small></li>`).join('')}</ul>` : ''}
      ${sit === 'ok' ? '<p class="av-conf-okmsg">Questão no padrão, sem erros de português encontrados.</p>' : ''}
    </li>`).join('');
  return `
    <div class="av-conf-topo">
      <p class="av-conf-sub">${sub}</p>
      <div class="av-conf-nums">
        <div><b>${questoes.length}</b><span>${deQuem ? 'questões na prova' : `questões suas (de ${totalProva} da prova)`}</span></div>
        <div class="av-conf-n-ok"><b>${conta('ok')}</b><span>aprovadas</span></div>
        <div class="av-conf-n-aj"><b>${conta('ajustar')}</b><span>ajustar</span></div>
        <div class="av-conf-n-rf"><b>${conta('refazer')}</b><span>refazer</span></div>
        <div><b>${erros}</b><span>apontamentos de português e ABNT</span></div>
        <div><b>~${min + (questoes.length ? 15 : 0)} min</b><span>tempo de prova${deQuem ? '' : ' (sua parte)'}</span></div>
      </div>
      <p class="av-conf-nota">Padrão da aula CADAM: um assunto por questão, formato simples, sem opinião, sem pista, sem enunciado negativo, uma só correta, caso clínico com os dados necessários, feedback e referência. Português e ABNT conferidos por regras — leia também o texto com atenção.</p>
    </div>
    ${questoes.length ? `<ol class="av-conf-lista">${lista}</ol>` : `<p class="av-vazio">${deQuem ? 'A prova ainda não tem questões.' : 'Nenhuma questão sua nesta prova ainda.'}</p>`}`;
}
let confEditar = null;
function modalConf() {
  if (!$('#av-conf')) {
    document.body.insertAdjacentHTML('beforeend', `<div class="av-modal-fundo" id="av-conf" hidden>
      <div class="av-modal av-conf-modal" role="dialog" aria-modal="true" aria-labelledby="av-conf-tit">
        <header class="av-modal-cab"><h2 id="av-conf-tit">Conferência CADAM</h2>
          <div class="av-conf-acoes"><button type="button" class="av-pt-btn av-conf-imprimir" data-conf-imprimir>Imprimir</button>
          <button type="button" class="av-icone-btn" data-conf-fechar aria-label="Fechar">${ic('x')}</button></div></header>
        <div class="av-conf-corpo" id="av-conf-corpo"></div>
      </div></div>`);
    const m = $('#av-conf');
    m.addEventListener('click', (e) => {
      if (e.target.closest('[data-conf-fechar]') || e.target === m) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); return; }
      if (e.target.closest('[data-conf-imprimir]')) { document.body.classList.add('av-imprimindo-conf'); window.print(); setTimeout(() => document.body.classList.remove('av-imprimindo-conf'), 500); return; }
      const ed2 = e.target.closest('[data-conf-editar]');
      if (ed2 && confEditar) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); confEditar(ed2.dataset.confEditar); return; }
      const av = e.target.closest('[data-conf-av]');
      if (av) abrirConferenciaDaProva(av.dataset.confAv);
      if (e.target.closest('[data-conf-lista]')) abrirConferenciaProfessor();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); } });
  }
  const m = $('#av-conf');
  m.hidden = false; document.body.classList.add('av-sem-rolagem');
  return m;
}
// "Sua parte" na prova: a cota que a responsável definiu pra ele e quantas ele já fez
function parteHtml(a) {
  if (!a.meta) return `<span class="av-parte av-parte-sem">${a.feitas ? `Você tem ${a.feitas} questão(ões) nesta prova` : 'Sua cota ainda não foi definida'}</span>`;
  const falta = a.meta - a.feitas;
  return `<span class="av-parte ${falta > 0 ? 'av-parte-falta' : 'av-parte-ok'}">Sua parte: <b>${a.feitas} de ${a.meta}</b> questões${falta > 0 ? ` · faltam ${falta}` : falta < 0 ? ` · ${-falta} a mais` : ' · completa'}</span>`;
}
// Progresso da disciplina (Bia / coordenação): professor × prova, feitas de cota
async function abrirProgresso(chave) {
  modalConf();
  confEditar = null;
  $('#av-conf-tit').textContent = 'Progresso da disciplina';
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Contando as questões de cada professor…</p>';
  try {
    const r = await api(`${BASE}/progresso/${encodeURIComponent(chave)}?semestre=${encodeURIComponent(semestre)}`);
    const cel = (feitas, meta) => meta ? `<td class="${feitas >= meta ? 'av-pg-ok' : feitas ? 'av-pg-meio' : 'av-pg-zero'}">${feitas} de ${meta}${feitas > meta ? ` <small>(+${feitas - meta})</small>` : ''}</td>` : `<td class="av-pg-livre">${feitas || '–'}</td>`;
    const completos = (i) => r.professores.filter(p => p.meta && p.feitas[i] >= p.meta).length;
    const comCota = r.professores.filter(p => p.meta).length;
    $('#av-conf-corpo').innerHTML = `
      <p class="av-conf-sub">${esc(r.disciplina)} · ${esc(r.semestre)}${r.qtdQuestoes ? ` · prova de ${r.qtdQuestoes} questões` : ''}</p>
      ${!r.provas.length ? '<p class="av-vazio">Nenhuma prova montada ainda nesta disciplina.</p>' : `
      ${!comCota ? '<p class="av-conf-nota">A divisão entre os professores ainda não foi definida nos critérios da disciplina — a tabela mostra só quantas cada um já fez.</p>' : ''}
      <div class="av-pg-tabela"><table>
        <thead><tr><th scope="col">Professor</th>${r.provas.map(p => `<th scope="col">${ordinal(p.bimestre)} bim · ${p.chamada}ª ch.<small>${p.status === 'finalizada' ? 'Finalizada' : 'Em montagem'}</small></th>`).join('')}</tr></thead>
        <tbody>${r.professores.map(pr => `<tr><th scope="row">${esc(pr.nome)}${pr.meta ? '' : ' <small>sem cota</small>'}</th>${pr.feitas.map(f => cel(f, pr.meta)).join('')}</tr>`).join('')}
          ${r.provas.some(p => p.semProfessor) ? `<tr><th scope="row"><i>Sem professor informado</i></th>${r.provas.map(p => `<td class="${p.semProfessor ? 'av-pg-zero' : 'av-pg-livre'}">${p.semProfessor || '–'}</td>`).join('')}</tr>` : ''}
        </tbody>
        <tfoot><tr><th scope="row">Total da prova</th>${r.provas.map((p, i) => `<td>${p.total}${r.qtdQuestoes ? ` de ${r.qtdQuestoes}` : ''}${comCota ? `<small>${completos(i)} de ${comCota} professores completos</small>` : ''}</td>`).join('')}</tr></tfoot>
      </table></div>`}`;
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
}
const subProva = (a) => `${esc(a.disciplina)} · ${ordinal(a.bimestre)} bimestre · ${a.chamada}ª chamada · ${esc(a.semestre)} · ${a.status === 'finalizada' ? 'Finalizada' : 'Em montagem'}`;

// Bia / coordenação: a prova aberta na aba Avaliações, inteira
function conferirProvaAberta() {
  if (!atual) return;
  modalConf();
  const fin = atual.avaliacao.status === 'finalizada';
  confEditar = fin ? null : (id) => abrirQuestao(id);
  $('#av-conf-tit').textContent = 'Conferência CADAM da prova';
  $('#av-conf-corpo').innerHTML = relatorioHtml({ sub: subProva(atual.avaliacao), questoes: atual.questoes.map((q, i) => ({ ...q, numero: i + 1 })), totalProva: atual.questoes.length, deQuem: true, editar: !fin });
}
// Professor: as provas das disciplinas dele e, em cada uma, só as questões dele
export async function abrirConferenciaProfessor() {
  modalConf();
  $('#av-conf-tit').textContent = 'Conferir minhas provas';
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Carregando suas provas…</p>';
  try {
    const r = await api('/banco-med-fatec/conferencia');
    $('#av-conf-corpo').innerHTML = r.avaliacoes.length
      ? `<p class="av-conf-sub">${esc(r.professor)} · provas das suas disciplinas. Você confere só as questões que elaborou.</p>
         <ul class="av-conf-provas">${r.avaliacoes.map(a => `<li><button type="button" data-conf-av="${esc(a.id)}"><b>${esc(a.disciplina)}</b><span>${ordinal(a.bimestre)} bimestre · ${a.chamada}ª chamada · ${esc(a.semestre)}</span><span class="av-status ${a.status === 'finalizada' ? 'av-status-fin' : 'av-status-rasc'}">${a.status === 'finalizada' ? 'Finalizada' : 'Em montagem'}</span>${parteHtml(a)}</button></li>`).join('')}</ul>`
      : `<p class="av-vazio">Ainda não há prova montada nas suas disciplinas de ${esc(r.semestre)}.</p>`;
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
}
async function abrirConferenciaDaProva(id) {
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Conferindo…</p>';
  try {
    const r = await api(`/banco-med-fatec/conferencia/${encodeURIComponent(id)}`);
    const a = r.avaliacao;
    $('#av-conf-tit').textContent = 'Conferência CADAM das minhas questões';
    confEditar = (qid) => abrirEditorBanco({ questaoId: qid, categorias: [{ id: a.categoriaId, nome: a.disciplina, periodo: 0 }], aposSalvar: async () => { modalConf(); await abrirConferenciaDaProva(id); } });
    $('#av-conf-corpo').innerHTML = `<button type="button" class="av-voltar" data-conf-lista>${ic('voltar')}Minhas provas</button><p class="av-conf-cota">${parteHtml({ meta: r.meta, feitas: r.questoes.length })}${r.qtdProva ? ` <span class="av-conf-cota-prova">A prova tem ${r.qtdProva} questões no total, divididas entre os professores da disciplina.</span>` : ''}</p>` + relatorioHtml({ sub: subProva(a), questoes: r.questoes, totalProva: r.totalProva, deQuem: false, editar: true });
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
}
// botão no Banco, só para o professor (quem vê tudo confere pela aba Avaliações)
export async function prepararConferenciaProfessor() {
  try {
    const eu = await perfilProfessor();
    if (!eu.restrito || document.getElementById('bmf-btn-conferencia')) return;
    const nova = document.getElementById('bmf-btn-nova-questao');
    if (!nova) return;
    nova.insertAdjacentHTML('beforebegin', '<button class="btn bmf-btn-on-blue-ghost action-execute" id="bmf-btn-conferencia" type="button"><svg class="bmf-icon" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>Conferir minhas provas</span></button>');
    document.getElementById('bmf-btn-conferencia').addEventListener('click', abrirConferenciaProfessor);
  } catch (e) { /* sem botão se o Edubox não respondeu */ }
}

// crachá do professor (iniciais + cor), o mesmo da avaliação, pra lista do Banco
export function chipProfessorHtml(nome) { return chipProfessor(nome); }

// ==========================================================================================
// INICIALIZAÇÃO
// ==========================================================================================
export function configurarAvaliacoes(opcoes) { ({ apiFetch: api, apiDownload: baixar, esc } = opcoes); }
export async function iniciarAvaliacoes(opcoes) {
  configurarAvaliacoes(opcoes);
  // A página abre primeiro com o login guardado no navegador (token pode estar vencido) e só depois o Firebase
  // confirma: tenta de novo por alguns segundos e só desiste quando o servidor diz que não tem acesso.
  let liberado = false;
  for (let i = 0; i < 8 && !liberado; i++) {
    try { await api(`${BASE}/eu`); liberado = true; }
    catch (e) {
      if (/Só a responsável|nível de acesso suficiente/i.test(e.message)) return false;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (!liberado) return false;
  const view = $('#bmf-view-avaliacoes');
  $('#bmf-tab-avaliacoes').hidden = false;
  view.innerHTML = `
    <div id="av-grade-tela">
      <div class="bmf-toolbar av-toolbar">
        <div class="av-toolbar-acoes">
          <label class="av-sem"><span class="sr-only">Semestre</span><select id="av-semestre">
            ${['2026.1', '2026.2', '2027.1'].map(s => `<option ${s === semestre ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
          <input type="search" id="av-busca" class="av-busca" placeholder="Buscar disciplina, sigla ou professor" aria-label="Buscar disciplina">
        </div>
        <span id="av-resumo" class="av-resumo"></span>
      </div>
      <p id="av-fonte" class="av-nota"></p>
      <div id="av-conteudo"></div>
    </div>
    <div id="av-editor" hidden></div>`;
  $('#av-semestre').addEventListener('change', (e) => { semestre = e.target.value; carregarGrade(); });
  $('#av-busca').addEventListener('input', () => carregouGrade && renderGrade());
  view.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.progresso) return abrirProgresso(t.dataset.progresso);
    if (t.dataset.criar) return criarAvaliacao(t.dataset.criar, Number(t.dataset.bim), Number(t.dataset.ch));
    if (t.dataset.abrir) return abrirAvaliacao(t.dataset.abrir);
    if (t.hasAttribute('data-voltar')) return voltarGrade();
    if (t.hasAttribute('data-nova')) return abrirQuestao(null);
    if (t.hasAttribute('data-importar')) return abrirImportar();
    if (t.hasAttribute('data-banco')) return abrirBanco();
    if (t.dataset.editar) return abrirQuestao(t.dataset.editar);
    if (t.dataset.retirar) return retirarQuestao(t.dataset.retirar);
    if (t.dataset.subir) return moverQuestao(t.dataset.subir, -1);
    if (t.dataset.descer) return moverQuestao(t.dataset.descer, 1);
    if (t.hasAttribute('data-finalizar')) return finalizar();
    if (t.hasAttribute('data-reabrir')) return reabrir();
    if (t.hasAttribute('data-excluir-av')) return excluirAvaliacao();
    if (t.hasAttribute('data-xml')) return baixarXml();
    if (t.hasAttribute('data-conferir')) return conferirProvaAberta();
    if (t.dataset.fp !== undefined) { filtroProfessor = t.dataset.fp; renderEditor(); }
    if (t.dataset.criterios) return abrirCriterios(t.dataset.criterios, carregarGrade);
    if (t.hasAttribute('data-criterios-av')) return abrirCriterios(atual.avaliacao.chave, recarregarAtual);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['#av-modal-q', '#av-modal-imp', '#av-modal-banco'].forEach(s => { const m = $(s); if (m && !m.hidden) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); } });
  });
  return true;
}
export function abrirAbaAvaliacoes() { if (!carregouGrade && !atual) carregarGrade(); }
