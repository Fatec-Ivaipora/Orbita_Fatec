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
// apagar questões (16/11/2026): seleção com caixinha + confirmação clara na própria tela
let selecionadas = new Set();
let confirmandoApagar = false;
// quem usa a aba (16/11/2026): editor (Ana / coordenação / ADM) ou professor (titular nas disciplinas de professor.titulares)
let meuPapel = { editor: true, professor: null };
const souEditor = () => !!meuPapel.editor;
const souTitular = (chave) => souEditor() || !!(meuPapel.professor && meuPapel.professor.titulares.includes(chave));

// ---------- utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const ordinal = (n) => `${n}º`;
// "2º bimestre · 1ª chamada" ou "Exame" (16/11/2026)
const rotuloAvaliacao = (a) => (a.tipo === 'exame' ? 'Exame semestral' : `${ordinal(a.bimestre)} bimestre · ${a.chamada}ª chamada`);
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

function slotHtml(disc, bim, ch, tipo) {
  const av = avaliacoes.find(a => a.chave === disc.chave && (tipo === 'exame' ? a.tipo === 'exame' : a.tipo !== 'exame' && a.bimestre === bim && a.chamada === ch));
  const rotulo = tipo === 'exame' ? 'Exame semestral' : `${ordinal(bim)} bimestre, ${ch}ª chamada`;
  const etiqueta = tipo === 'exame' ? 'Exame semestral' : `${ch}ª chamada`;
  if (!av) return `<button type="button" class="av-slot av-slot-vazio av-slot-uso av-uso-${tipo === 'exame' ? 'exame' : ch === 2 ? 'c2' : 'c1'}" data-criar="${esc(disc.chave)}" data-bim="${bim}" data-ch="${ch}" ${tipo ? `data-tipo="${tipo}"` : ''} aria-label="Montar ${rotulo}">${ic('mais')}<span>Montar</span><em class="av-slot-ch">${etiqueta}</em></button>`;
  const fin = av.status === 'finalizada';
  const plan = Number(disc.qtdQuestoes) || 0;
  const pct = plan ? Math.min(100, Math.round(100 * av.totalQuestoes / plan)) : 0;
  return `<button type="button" class="av-slot ${fin ? 'av-slot-fin' : 'av-slot-rasc'} av-slot-uso av-uso-${tipo === 'exame' ? 'exame' : ch === 2 ? 'c2' : 'c1'}" data-abrir="${esc(av.id)}" aria-label="${rotulo}: ${fin ? 'finalizada' : 'em montagem'}, ${av.totalQuestoes}${plan ? ` de ${plan}` : ''} questões">
    ${fin ? ic('cadeado') : ic('editar')}<span><b>${av.totalQuestoes}</b>${plan ? ` de ${plan}` : ` ${av.totalQuestoes === 1 ? 'questão' : 'questões'}`}</span>${plan ? `<i class="av-slot-barra" aria-hidden="true"><i style="width:${pct}%"></i></i>` : ''}<small>${fin ? 'Finalizada' : 'Em montagem'}</small><em class="av-slot-ch">${etiqueta}</em></button>`;
}

let verFechados = false;
function renderGrade() {
  const busca = P.norm($('#av-busca').value || '');
  const lista = disciplinas.filter(d => !busca || P.norm(`${d.nome} ${d.sigla} ${d.professores.join(' ')}`).includes(busca));
  const periodos = [...new Set(lista.map(d => d.periodo))].sort((a, b) => a - b);
  const montadas = avaliacoes.length, fin = avaliacoes.filter(a => a.status === 'finalizada').length;
  $('#av-resumo').textContent = `${disciplinas.length} disciplinas · ${montadas} avaliação(ões) em andamento ou prontas · ${fin} finalizada(s)`;
  if (!lista.length) { $('#av-conteudo').innerHTML = '<div class="av-vazio">Nenhuma disciplina encontrada.</div>'; return; }
  $('#av-conteudo').innerHTML = `
    <div class="av-grade ${verFechados || !BIMESTRES_FECHADOS.includes(1) ? '' : 'av-grade-sem-b1'}" role="table" aria-label="Avaliações por disciplina">
      <div class="av-grade-cab" role="row">
        <span role="columnheader">Disciplina</span>
        ${verFechados || !BIMESTRES_FECHADOS.includes(1) ? '<span role="columnheader" class="av-grade-bim">1º bimestre<small><i>1ª chamada</i><i>2ª chamada</i></small></span>' : ''}
        <span role="columnheader" class="av-grade-bim">2º bimestre<small><i>1ª chamada</i><i>2ª chamada</i></small></span>
        <span role="columnheader" class="av-grade-bim">Exame semestral</span>
      </div>
      ${periodos.map(p => `
        <div class="av-periodo" role="row"><span role="cell">${ordinal(p)} período</span></div>
        ${lista.filter(d => d.periodo === p).map(d => `
          <div class="av-disc" role="row">
            <div class="av-disc-info" role="cell">
              <strong>${esc(d.nome)}</strong>
              <span class="av-disc-meta">${esc(d.sigla || '')} · ${souEditor() ? `<button type="button" class="av-link" data-criterios="${esc(d.chave)}">${d.criteriosDefinidos ? 'Critérios definidos' : 'Critérios: padrão'}</button> · <button type="button" class="av-link" data-progresso="${esc(d.chave)}">Progresso</button>` : souTitular(d.chave) ? `<span class="av-papel av-papel-tit">Você é o titular</span> · <button type="button" class="av-link" data-divisao="${esc(d.chave)}">Divisão das questões</button> · <button type="button" class="av-link" data-progresso="${esc(d.chave)}">Progresso</button>` : '<span class="av-papel">Você é adjunto(a): vê e edita só as suas questões</span>'}</span>

              <span class="av-disc-profs" aria-label="Professores: ${esc(d.professores.join(', '))}">${d.professores.map(n => avatar(n)).join('')}</span>
            </div>
            ${verFechados || !BIMESTRES_FECHADOS.includes(1) ? `<div class="av-slots" role="cell" data-rotulo="1º bimestre">${slotHtml(d, 1, 1)}${slotHtml(d, 1, 2)}</div>` : ''}
            <div class="av-slots" role="cell" data-rotulo="2º bimestre">${slotHtml(d, 2, 1)}${slotHtml(d, 2, 2)}</div>
            <div class="av-slots av-slots-1" role="cell" data-rotulo="Exame semestral">${slotHtml(d, 0, 0, 'exame')}</div>
          </div>`).join('')}`).join('')}
    </div>`;
}

async function criarAvaliacao(chave, bim, ch, tipo) {
  try {
    const r = await api(BASE, { method: 'POST', body: JSON.stringify({ semestre, chave, bimestre: bim, chamada: ch, tipo: tipo || '' }) });
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
    selecionadas = new Set(); confirmandoApagar = false;
    renderEditor();
    window.scrollTo({ top: 0 });
  } catch (e) { ed.innerHTML = `<div class="av-vazio">${esc(e.message)} <button type="button" class="av-link" data-voltar>Voltar</button></div>`; }
}
async function recarregarAtual() {
  resumoXmlCache.clear(); // as contagens dos botões de baixar podem ter mudado
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
        <p>${esc(av.sigla || '')} · ${esc(av.semestre)} · <b>${rotuloAvaliacao(av)}</b>
          <span class="av-status ${fin ? 'av-status-fin' : 'av-status-rasc'}">${fin ? 'Finalizada' : 'Em montagem'}</span></p>
      </div>
      <div class="av-ed-acoes">
        ${souEditor() ? `<button type="button" class="btn btn-secondary av-btn" data-conferir ${questoes.length ? '' : 'disabled'}>Conferência CADAM</button>` : ''}
        <button type="button" class="btn btn-secondary av-btn" data-relatorio-cadam ${questoes.length ? '' : 'disabled'} title="${souEditor() ? 'Parecer da prova e devolutiva de cada professor' : 'Devolutiva das questões: o que está bom e como melhorar'}">Relatório CADAM</button>
        ${fin ? `<button type="button" class="btn btn-primary av-btn" data-xml>${ic('baixar')}Baixar para o AVA</button>
                 ${souTitular(av.chave) ? '<button type="button" class="btn btn-secondary av-btn" data-reabrir>Reabrir</button>' : ''}`
              : souTitular(av.chave) ? `${souEditor() ? `<button type="button" class="btn btn-secondary av-btn" data-xml-como-esta ${questoes.length ? '' : 'disabled'} title="Baixa as questões como estão, sem finalizar nem padronizar">${ic('baixar')}Baixar para o AVA (como está)</button>` : ''}<button type="button" class="btn btn-primary av-btn" data-finalizar ${questoes.length ? '' : 'disabled'}>${ic('ok')}Finalizar avaliação</button>
                 <button type="button" class="av-icone-btn av-perigo" data-excluir-av title="Excluir avaliação" aria-label="Excluir avaliação">${ic('lixo')}</button>` : ''}
      </div>
    </header>

    <div class="av-ed-corpo">
      <section class="av-ed-questoes" aria-label="Questões da avaliação">
        ${fin ? `<div class="av-faixa av-faixa-fin">${ic('cadeado')}<div><b>Avaliação finalizada.</b> As ${atual.totalNaProva || questoes.length} questões estão no banco de ${esc(av.disciplina)}, na pasta ${esc(av.semestre)} / ${rotuloAvaliacao(av).replace(' · ', ' / ')}. Baixe o arquivo e importe no banco de questões do AVA.</div></div>` : `
        <div class="bmf-toolbar av-toolbar">
          <div class="av-toolbar-acoes">
            <button type="button" class="btn av-btn-branco" data-nova>${ic('mais')}Escrever questão</button>
            <button type="button" class="btn av-btn-fantasma" data-importar>${ic('importar')}Importar Word, PDF ou texto</button>
            <button type="button" class="btn av-btn-fantasma" data-banco>${ic('banco')}Pegar do banco</button>
            ${(() => { const n = questoes.reduce((s, q) => s + conferirQuestao(q).pt.filter(a => a.para).length, 0); return n ? `<button type="button" class="btn av-btn-fantasma" data-pt-tudo-prova="${esc(av.id)}">Corrigir português e ABNT (${n})</button>` : ''; })()}
          </div>
        </div>`}

        ${atual.papel === 'adjunto' ? `<div class="av-faixa av-faixa-papel" role="note"><div>Você é <b>adjunto(a)</b> nesta disciplina: aqui aparecem só as <b>suas ${questoes.length}</b> ${questoes.length === 1 ? 'questão' : 'questões'} (a prova tem ${atual.totalNaProva} no total). O titular confere e finaliza a prova.</div></div>` : atual.papel === 'titular' ? '<div class="av-faixa av-faixa-papel" role="note"><div>Você é o <b>titular</b> desta disciplina: vê e edita as questões de todos os professores, organiza a ordem e finaliza a prova.</div></div>' : ''}
        ${atual.papel && atual.papel !== 'editor' ? envioNaProvaHtml(av, questoes) : ''}
        ${analise.pendencias.length && !fin ? `<div class="av-faixa av-faixa-aviso" role="status">${ic('alerta')}<ul>${analise.pendencias.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}

        <div class="av-prog" aria-label="${prontas} de ${questoes.length} questões no padrão">
          <div class="av-prog-barra"><span style="width:${questoes.length ? Math.round(100 * prontas / questoes.length) : 0}%"></span></div>
          <span>${analise.planejado ? `<b>${questoes.length}</b> de <b>${analise.planejado}</b> questões · ` : ''}<b>${prontas}</b> de <b>${questoes.length}</b> no padrão${analise.avisos ? ` · ${analise.avisos} orientação(ões)` : ''}</span>
        </div>

        ${profsNaProva.length > 1 ? `<div class="av-filtro-prof" role="group" aria-label="Filtrar por professor">
          <button type="button" class="av-fp ${!filtroProfessor ? 'ativo' : ''}" data-fp="">Todos <b>${questoes.length}</b></button>
          ${profsNaProva.map(([n, c]) => `<button type="button" class="av-fp ${filtroProfessor === n ? 'ativo' : ''}" data-fp="${esc(n)}">${n === 'Sem professor' ? '' : avatar(n)}${esc(primeiroUltimo(n))} <b>${c}</b></button>`).join('')}
        </div>` : ''}

        ${!fin && questoes.length ? `<div id="av-sel-barra">${barraSelecaoHtml()}</div>` : ''}
        <ol class="av-lista">
          ${visiveis.length ? visiveis.map(({ q, n }) => linhaQuestao(q, n, fin, questoes.length)).join('') : `<li class="av-vazio">${questoes.length ? 'Nenhuma questão deste professor.' : 'Nenhuma questão ainda. Escreva no modelo, importe do Word/PDF ou pegue do banco da disciplina.'}</li>`}
        </ol>
      </section>

      <aside class="av-ed-plano" aria-label="Tabela de especificação">
        ${painelPlano(plano, analise, av)}
      </aside>
    </div>`;
}

// Professor sobe as próprias questões no AVA sem esperar a finalização (16/11/2026): o arquivo só sai quando as
// questões dele estão sem nada "a corrigir" na Conferência CADAM.
function envioNaProvaHtml(av, questoes) {
  const minhas = questoes.filter(q => atual.papel === 'adjunto' || P.norm(q.professorNome || '') === P.norm(atual.eu || ''));
  const aCorrigir = minhas.filter(q => !q.padrao.ok).length;
  const env = atual.meuEnvio || {};
  const marca = (etapa, rotulo) => { const e = env[etapa] || {}; return `<label class="av-envio-item ${e.feito ? 'av-envio-ok' : ''}"><input type="checkbox" data-envio="${etapa}" data-av="${esc(av.id)}" ${e.feito ? 'checked' : ''}> ${rotulo}${e.feito && e.em ? `<small>${new Date(e.em).toLocaleString('pt-BR')}</small>` : ''}</label>`; };
  return `<section class="av-envio av-envio-prova" aria-label="Enviar ao AVA">
    <h3>Enviar as suas questões ao AVA</h3>
    <p class="av-nota">${!minhas.length ? 'Você ainda não tem questões nesta prova.' : aCorrigir ? `<b>${aCorrigir} de ${minhas.length}</b> questão(ões) suas ainda têm item a corrigir (veja o Relatório CADAM). O arquivo do AVA só sai com todas no padrão.` : `Suas <b>${minhas.length}</b> questão(ões) estão no padrão. Baixe o arquivo de cada prova (cada botão traz só as suas questões daquela prova), importe no banco de questões do AVA e marque cada etapa.`}</p>
    <div class="av-envio-acoes">${botoesXmlHtml(av.id, 'btn btn-primary av-btn', !minhas.length || !!aCorrigir)}
      <div class="av-envio-itens">${marca('bancoAva', 'Subi no banco de questões do AVA')}${marca('questionario', 'Coloquei no questionário')}</div></div>
  </section>`;
}

function linhaQuestao(q, n, fin, total) {
  const p = q.padrao;
  // português e ABNT na própria lista (16/11/2026): o professor vê e corrige sem abrir a questão
  const pt = conferirQuestao(q).pt, ptFix = pt.filter(a => a.para).length;
  const status = p.ok ? `<span class="av-selo av-selo-ok">${ic('ok')}No padrão</span>` : `<span class="av-selo av-selo-erro">${ic('alerta')}${p.bloqueios.length} a corrigir</span>`;
  return `<li class="av-q ${p.ok ? '' : 'av-q-erro'} ${selecionadas.has(q.id) ? 'av-q-marcada' : ''}">
    ${fin ? '' : `<label class="av-q-sel" title="Selecionar para apagar"><input type="checkbox" data-sel-q="${esc(q.id)}" ${selecionadas.has(q.id) ? 'checked' : ''} aria-label="Selecionar a questão ${n} para apagar"></label>`}
    <span class="av-q-n">${n}</span>
    <div class="av-q-corpo">
      <div class="av-q-topo">${chipProfessor(q.professorNome)}<span class="av-tag">${esc(rotuloUnidade(q.unidade))}</span>
        <span class="av-tag ${p.aplicacao ? 'av-tag-caso' : ''}">${p.aplicacao ? 'Caso clínico' : 'Memorização'}</span>${(q.imagens || []).length || q.temImagem ? `<span class="av-tag">${(q.imagens || []).length + (q.temImagem ? 1 : 0)} imagem(ns)</span>` : ''}${status}</div>
      <p class="av-q-obj">${q.objetivo ? esc(q.objetivo) : '<i>Objetivo a definir</i>'}</p>
      <p class="av-q-enun">${esc(P.texto(q.casoClinico || q.enunciadoHtml).slice(0, 240))}${P.texto(q.casoClinico || q.enunciadoHtml).length > 240 ? '…' : ''}</p>
      ${(!p.ok || p.avisos.length) ? `<details class="av-q-det"><summary>${p.bloqueios.length ? `${p.bloqueios.length} a corrigir` : ''}${p.bloqueios.length && p.avisos.length ? ' · ' : ''}${p.avisos.length ? `${p.avisos.length} orientação(ões)` : ''}</summary>
        <ul>${p.bloqueios.map(b => `<li class="av-b">${esc(b.msg)}</li>`).join('')}${p.avisos.map(a => `<li class="av-a">${esc(a.msg)}</li>`).join('')}</ul></details>` : ''}
      ${pt.length ? `<details class="av-q-det av-q-pt"><summary>${pt.length} de português e ABNT${ptFix ? ` · ${ptFix} com correção automática` : ''}</summary>
        <ul>${pt.map(a => `<li><span class="av-conf-campo">${esc(a.campo)}</span> ${a.de ? `<del>${esc(a.de.trim())}</del>` : ''}${a.para ? ` → <ins>${esc(a.para.trim())}</ins>` : ''} <small>${esc(a.motivo)}</small></li>`).join('')}</ul>
        ${!fin && ptFix ? `<button type="button" class="av-pt-btn av-pt-tudo" data-pt-tudo-q="${esc(q.id)}" data-av="${esc(atual.avaliacao.id)}">Corrigir (ver antes de aplicar)</button>` : ''}</details>` : ''}
    </div>
    ${fin ? '' : `<div class="av-q-acoes">
      ${souTitular(atual.avaliacao.chave) ? `<button type="button" class="av-icone-btn" data-subir="${esc(q.id)}" ${n === 1 ? 'disabled' : ''} aria-label="Subir questão ${n}">${ic('cima')}</button>
      <button type="button" class="av-icone-btn" data-descer="${esc(q.id)}" ${n === total ? 'disabled' : ''} aria-label="Descer questão ${n}">${ic('baixo')}</button>` : ''}
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
      ${souEditor() ? '<button type="button" class="av-link" data-criterios-av>Ver critérios</button>' : souTitular(av.chave) ? `<button type="button" class="av-link" data-divisao="${esc(av.chave)}">Divisão das questões</button>` : ''}
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
    <div class="av-eq" aria-label="${analise.aplicacao} de caso clínico e ${analise.memorizacao} de conhecimento">
      <div class="av-eq-barra"><span class="av-eq-caso" style="width:${100 * analise.aplicacao / total}%"></span></div>
      <div class="av-eq-leg"><span><i class="av-dot av-dot-caso"></i>Caso clínico <b>${analise.aplicacao}</b></span><span><i class="av-dot"></i>Conhecimento <b>${analise.memorizacao}</b></span></div>
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
function barraSelecaoHtml() {
  const n = selecionadas.size, total = atual.questoes.length;
  if (confirmandoApagar && n) {
    const sel = atual.questoes.filter(q => selecionadas.has(q.id));
    const novas = sel.filter(q => q.avaliacaoId === atual.avaliacao.id && (q.status === 'rascunho_avaliacao' || (q.publicadaNoEnvio === true && !(q.usadaEm || []).length))).length, doBanco = n - novas;
    return `<div class="av-sel av-sel-confirma" role="alertdialog" aria-live="assertive">
      <p><b>Apagar ${n === 1 ? '1 questão' : `${n} questões`}?</b> ${novas ? (novas === 1 ? '1 foi escrita ou importada nesta prova e será <b>apagada de vez</b>.' : `${novas} foram escritas ou importadas nesta prova e serão <b>apagadas de vez</b>.`) : ''} ${doBanco ? (doBanco === 1 ? '1 veio do banco: só sai da prova e continua no banco da disciplina.' : `${doBanco} vieram do banco: só saem da prova e continuam no banco da disciplina.`) : ''}</p>
      <div class="av-sel-acoes"><button type="button" class="btn av-btn av-btn-perigo" data-apagar-sim>Sim, apagar ${n}</button><button type="button" class="btn btn-secondary av-btn" data-apagar-cancelar>Cancelar</button></div></div>`;
  }
  return `<div class="av-sel ${n ? 'av-sel-ativa' : ''}">
    <span>${n ? `<b>${n}</b> de ${total} ${n === 1 ? 'selecionada' : 'selecionadas'}` : 'Marque as questões que quer apagar'}</span>
    <div class="av-sel-acoes">${n < total ? '<button type="button" class="av-link" data-sel-todas>Selecionar todas</button>' : ''}
      ${n ? `<button type="button" class="av-link" data-sel-limpar>Limpar seleção</button><button type="button" class="btn av-btn av-btn-perigo" data-apagar-sel>${ic('lixo')}Apagar selecionadas</button>` : ''}</div></div>`;
}
function atualizarSelecao() {
  const b = $('#av-sel-barra'); if (b) b.innerHTML = barraSelecaoHtml();
  document.querySelectorAll('[data-sel-q]').forEach(c => { c.checked = selecionadas.has(c.dataset.selQ); c.closest('.av-q').classList.toggle('av-q-marcada', c.checked); });
  if (confirmandoApagar) { const s = $('#av-sel-barra'); if (s) s.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
async function apagarSelecionadas() {
  const btn = document.querySelector('[data-apagar-sim]'); if (btn) { btn.disabled = true; btn.textContent = 'Apagando…'; }
  try {
    const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/questoes/apagar`, { method: 'POST', body: JSON.stringify({ ids: [...selecionadas] }) });
    selecionadas = new Set(); confirmandoApagar = false;
    await recarregarAtual();
    toast(r.message);
  } catch (e) { toast(e.message, 'erro'); confirmandoApagar = false; atualizarSelecao(); }
}
async function retirarQuestao(id) {
  // a lixeira da questão usa a mesma confirmação clara (16/11/2026)
  selecionadas = new Set([id]); confirmandoApagar = true; atualizarSelecao(); return;
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
// prepara as questões para o XML: baixa imagens do enunciado e do feedback (Storage) e monta o HTML com @@PLUGINFILE@@
async function prepararParaXml(lista, prefixo = 'q') {
  const out = [];
  for (const [i, q] of lista.entries()) {
    const arquivos = [];
    for (const [j, im] of (q.imagens || []).entries()) {
      const r = await fetch(im.url);
      if (!r.ok) throw new Error(`Não consegui baixar a imagem "${im.nome}" da questão ${i + 1}.`);
      arquivos.push({ nome: `${prefixo}${i + 1}-${j + 1}-${nomeSeguro(im.nome)}`, base64: await blobParaBase64(await r.blob()) });
    }
    const arquivosFeedback = [];
    for (const [j, im] of (q.imagensFeedback || []).entries()) {
      const r = await fetch(im.url);
      if (!r.ok) throw new Error(`Não consegui baixar a imagem do feedback "${im.nome}" da questão ${i + 1}.`);
      arquivosFeedback.push({ nome: `${prefixo}${i + 1}-feedback-${j + 1}-${nomeSeguro(im.nome)}`, base64: await blobParaBase64(await r.blob()) });
    }
    const imgs = arquivos.map(a => `<p><img src="@@PLUGINFILE@@/${a.nome}" alt="Imagem da questão ${i + 1}"></p>`).join('\n');
    const perg = q.pergunta ? `<p><strong>${esc(q.pergunta)}</strong></p>` : '';
    const enunciadoHtml = (q.casoClinico || q.pergunta) ? [q.casoClinico, imgs, perg].filter(Boolean).join('\n') : [q.enunciadoHtml, imgs].filter(Boolean).join('\n');
    const justificativa = [q.justificativa, ...arquivosFeedback.map(a => `<p><img src="@@PLUGINFILE@@/${a.nome}" alt="Feedback da questão ${i + 1}"></p>`)].filter(Boolean).join('\n');
    out.push({ ...q, enunciadoHtml, arquivos, justificativa, arquivosFeedback, provaRotulo: USO_PROVA[q.usoProva] || '' });
  }
  return out;
}
function baixarTexto(texto, nome) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([texto], { type: 'application/xml;charset=utf-8' }));
  link.download = nome;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
async function baixarXml(comoEsta) {
  const btn = document.querySelector(comoEsta ? '[data-xml-como-esta]' : '[data-xml]');
  // sem finalizar: avisa o que está fora do padrão, mas baixa do jeito que veio (16/11/2026)
  if (comoEsta) {
    const semCorreta = atual.questoes.filter(q => !(q.alternativas || []).some(a => a.correta)).length;
    const fora = atual.questoes.filter(q => !q.padrao.ok).length;
    if (semCorreta) toast(`${semCorreta} questão(ões) sem alternativa correta marcada: o AVA não importa questão sem correta. Marque a correta antes.`, 'aviso');
    else if (fora) toast(`Baixando como está: ${fora} questão(ões) fora do padrão CADAM seguem sem alteração.`, 'aviso');
  }
  if (btn) { btn.disabled = true; btn.dataset.txt = btn.innerHTML; btn.textContent = 'Montando o arquivo…'; }
  try {
    const dados = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/exportar${comoEsta ? '?rascunho=1' : ''}`);
    const questoes = await prepararParaXml(dados.questoes);
    for (const [i, q] of questoes.entries()) {
      if (q.temImagemAntiga) {
        const a = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/questoes/${encodeURIComponent(q.id)}/imagem-antiga`);
        if (a.dataUrl) q.imagem = { nome: `q${i + 1}-${nomeSeguro(a.nome)}`, dataUrl: a.dataUrl };
      }
    }
    // nome no AVA com a prova e o número: [2ºB 1ªCH 01], [EXAME 05]…
    const a = atual.avaliacao;
    const prefixo = a.tipo === 'exame' ? 'EXAME' : `${a.bimestre}ºB ${a.chamada === 2 ? '2ª' : '1ª'}CH`;
    const xml = window.MoodleXml.gerarMoodleXml(dados.pasta, questoes.map((q, i) => ({ ...q, prefixoAva: prefixo, numeroAva: i + 1 })));
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
  { tipo: true },
  { t: 'Pergunta direta no final', c: ['pergunta', 'enunciado'] },
  { t: 'Enunciado afirmativo (sem EXCETO / INCORRETA)', c: ['negativo'] },
  { t: '4 alternativas (A a D), sem repetição', c: ['qtd', 'vazia', 'repetida'] },
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
// cor do tipo de prova a partir do texto do Word ("Prova: Exame", "2º bimestre – 2ª chamada"…)
function usoDoTextoTela(t) {
  const s = P.norm(t);
  if (/exame/.test(s)) return 'exame';
  if (/depend|^dp$/.test(s)) return 'dp';
  if (/adapta|^adp$/.test(s)) return 'adp';
  if (/(2|segunda)\s*a?\s*ch/.test(s)) return 'c2';
  return 'c1';
}
const USO_PROVA = { c1: '1ª chamada', c2: '2ª chamada', exame: 'Exame semestral', dp: 'Dependência', adp: 'Adaptação' };
// destino da questão (16/11/2026): bimestre + chamada, exame, dependência, adaptação
// Bimestres fechados (16/11/2026, fim de 2026.2): somem do "Para qual prova", do modelo do Word e da grade,
// para ninguém gerar questão no lugar errado. No próximo semestre: deixar [].
const BIMESTRES_FECHADOS = [1];
const DESTINOS_TODOS = [['b1c1', '1º bimestre – 1ª chamada'], ['b1c2', '1º bimestre – 2ª chamada'], ['b2c1', '2º bimestre – 1ª chamada'], ['b2c2', '2º bimestre – 2ª chamada'], ['exame', 'Exame semestral'], ['dp', 'Dependência'], ['adp', 'Adaptação']];
const DESTINOS = DESTINOS_TODOS.filter(([k]) => !BIMESTRES_FECHADOS.some(b => k.startsWith(`b${b}`)));
const BIM_ABERTO = [1, 2].find(b => !BIMESTRES_FECHADOS.includes(b)) || 2;
function destinoDe(q) {
  if (['exame', 'dp', 'adp'].includes(q.usoProva)) return q.usoProva;
  const bim = q.bimestre || (ed && ed.bimestre) || BIM_ABERTO;
  const ch = q.usoProva === 'c2' || (!q.usoProva && ed && ed.chamada === 2) ? 'c2' : 'c1';
  return (ed && ed.tipo === 'exame' && !q.usoProva) ? 'exame' : `b${bim}${ch}`;
}
let imgsFeedback = [];         // imagens do feedback (gráfico, tabela, figura) — 16/11/2026
let enviandoFb = 0;
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
              <label class="av-campo"><span>Para qual prova</span><select id="av-q-uso">${DESTINOS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
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
            <button type="button" class="av-link" id="av-q-mais-alt">+ Alternativa</button>
          </fieldset>

          <fieldset class="av-sec"><legend>Feedback e referência</legend>
            <label class="av-campo"><span>Feedback geral (por que a correta é a correta)</span></label>
            <div id="av-q-just" class="av-rico" contenteditable="true" spellcheck="true" lang="pt-BR" role="textbox" aria-multiline="true" aria-label="Feedback geral" data-ph="Explicação que o aluno vê depois da prova… (ou cole aqui o gráfico com Ctrl+V)"></div>
            <div class="av-imgs" id="av-q-fb-imgs" aria-live="polite"></div>
            <div class="av-img-linha">
              <label class="av-btn-img"><input type="file" id="av-q-fb-img" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden>+ Imagem no feedback</label>
              <span class="av-nota">Gráfico, tabela ou figura que explica a resposta. Pode ser só a imagem.</span>
            </div>
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
    <button type="button" class="av-icone-btn" data-tirar-alt aria-label="Tirar a alternativa ${LETRAS[i]}">${ic('x')}</button>
  </div>`;
}
// 16/11/2026: de 2 a 5 alternativas, qualquer uma pode sair; as letras se reorganizam (questão vinda do Word com menos alternativas)
// Medicina: questões até a letra D (16/11/2026). Questão antiga com 5 abre com as 5 para o professor tirar uma.
const MAX_ALTS = 4;
function renumerarAlts() {
  const linhas = [...document.querySelectorAll('#av-q-alts .av-alt')];
  linhas.forEach((el, i) => {
    el.dataset.i = i;
    const r = el.querySelector('input[type=radio]'); r.value = i; r.setAttribute('aria-label', `Alternativa ${LETRAS[i]} é a correta`);
    el.querySelector('.av-alt-letra span').textContent = LETRAS[i];
    el.querySelector('.av-alt-txt').placeholder = `Texto da alternativa ${LETRAS[i]}`;
    const x = el.querySelector('[data-tirar-alt]'); x.hidden = linhas.length <= 2; x.setAttribute('aria-label', `Tirar a alternativa ${LETRAS[i]}`);
  });
  const b = $('#av-q-mais-alt');
  b.hidden = linhas.length >= MAX_ALTS;
  b.textContent = `+ Alternativa ${LETRAS[linhas.length] || ''}`;
}

// unidades do bimestre de destino (16/11/2026): 2º bimestre mostra só as do 2º; exame semestral mostra todas.
// A divisão por bimestre é a dos Critérios da disciplina (o servidor já manda o plano com ela aplicada).
function bimestreDoDestino() {
  const v = ($('#av-q-uso') || {}).value || '';
  const m = /^b([12])/.exec(v);
  return m ? Number(m[1]) : null;
}
function renderUnidades(selecionada) {
  const unids = (ed.plano && ed.plano.unidades) || [];
  const bim = bimestreDoDestino();
  const sel = Number(selecionada) || null;
  const lista = bim ? unids.filter(u => u.bimestre === bim) : unids;
  const opU = (u, extra = '') => `<option value="${u.numero}" ${sel === u.numero ? 'selected' : ''}>Unidade ${u.numero} (${u.ch}h) – ${esc(u.titulo)}${extra}</option>`;
  // a unidade que a questão já tinha e é de outro bimestre continua visível, marcada
  const fora = sel && !lista.some(u => u.numero === sel) ? unids.find(u => u.numero === sel) : null;
  $('#av-q-unid').innerHTML = '<option value="">Escolha…</option>'
    + (lista.length ? `<optgroup label="${bim ? `Unidades do ${ordinal(bim)} bimestre` : 'Unidades do plano de ensino'}">${lista.map(u => opU(u)).join('')}</optgroup>` : '')
    + (fora ? opU(fora, ' (outro bimestre)') : '')
    + (!unids.length ? [1, 2, 3, 4].map(n => `<option value="${n}" ${sel === n ? 'selected' : ''}>Unidade ${n}</option>`).join('') : '');
}
function preencherSelects(q) {
  const { plano, professores } = ed;
  const profs = [...new Set([...(professores || []), ...(q.professorNome ? [q.professorNome] : [])])];
  $('#av-q-prof').innerHTML = `<option value="">Escolha…</option>${profs.map(n => `<option ${n === q.professorNome ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  // professor logado: o nome vem do perfil e não se troca
  if (ed.travaProfessor) { $('#av-q-prof').innerHTML = `<option>${esc(ed.travaProfessor)}</option>`; }
  $('#av-q-prof').disabled = !!ed.travaProfessor;
  renderUnidades(q.unidade);
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
  const q = id ? atual.questoes.find(x => x.id === id) : { alternativas: [{}, {}, {}, {}], dificuldade: 'media', professorNome: filtroProfessor && filtroProfessor !== 'Sem professor' ? filtroProfessor : '' };
  const avId = encodeURIComponent(atual.avaliacao.id);
  ed = {
    modo: 'avaliacao', travaProfessor: atual.papel === 'adjunto' ? atual.eu : null, chamada: atual.avaliacao.chamada, tipo: atual.avaliacao.tipo || '', sigla: atual.avaliacao.sigla, bimestre: atual.avaliacao.bimestre, plano: atual.plano, professores: atual.professores,
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
  const destQ = destinoDe(q);
  $('#av-q-uso').innerHTML = DESTINOS_TODOS.filter(([k]) => DESTINOS.some(d => d[0] === k) || k === destQ).map(([k, l]) => `<option value="${k}">${l}${DESTINOS.some(d => d[0] === k) ? '' : ' (bimestre fechado)'}</option>`).join('');
  $('#av-q-uso').value = destQ;
  preencherSelects(q);
  $('#av-q-dif').value = q.dificuldade || 'media';
  $('#av-q-nome').value = q.nomeQuestao || '';
  $('#av-q-caso').innerHTML = limpaHtml(q.casoClinico || q.enunciadoHtml || '');
  $('#av-q-perg').value = q.pergunta || '';
  $('#av-q-just').innerHTML = limpaHtml(q.justificativa || '');
  const alts = (q.alternativas && q.alternativas.length ? q.alternativas : [{}, {}, {}, {}]).slice(0, 5);
  $('#av-q-alts').innerHTML = alts.map((a, i) => linhaAlt(i, a)).join('');
  renumerarAlts();
  imgsQuestao = (q.imagens || []).map(i => ({ caminho: i.caminho, nome: i.nome, url: i.url, mimeType: i.mimeType }));
  imgsFeedback = (q.imagensFeedback || []).map(i => ({ caminho: i.caminho, nome: i.nome, url: i.url, mimeType: i.mimeType }));
  enviandoFb = 0; renderImgsFeedback();
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
    ...(() => { const d = $('#av-q-uso').value; const m = /^b([12])(c[12])$/.exec(d); return m ? { usoProva: m[2], bimestreDestino: Number(m[1]) } : { usoProva: d }; })(),
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
  const q = { ...f, imagensFeedback: imgsFeedback, tipoMoodle: 'multichoice_unica', enunciadoHtml: `${f.casoClinico} ${f.pergunta}` };
  const r = P.avaliarQuestao(q);
  const cods = new Map([...r.bloqueios.map(b => [b.cod, 'erro']), ...r.avisos.map(a => [a.cod, 'aviso'])]);
  const msgs = [...r.bloqueios, ...r.avisos];
  $('#av-check-lista').innerHTML = CHECKLIST.map(item => {
    if (item.tipo) return `<li class="av-ck av-ck-info"><span class="av-ck-ic">${ic('ok')}</span><div>${r.aplicacao ? 'Tipo: caso clínico (aplicação)' : 'Tipo: questão de conhecimento (sem caso clínico)'}<small>${r.aplicacao ? 'Parte de uma situação clínica.' : 'Normal no conteúdo de base. Caso clínico só quando o objetivo pedir aplicar, analisar ou decidir.'}</small></div></li>`;
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
let confRecarregar = null; // reabre a Conferência CADAM depois do "Corrigir tudo"
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
  if (enviandoFb) { toast('Espere as imagens do feedback terminarem de subir.', 'aviso'); return; }
  f.imagens = imgsQuestao.map(i => ({ caminho: i.caminho, nome: i.nome }));
  f.imagensFeedback = imgsFeedback.map(i => ({ caminho: i.caminho, nome: i.nome }));
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
function renderImgsFeedback() {
  const caixa = $('#av-q-fb-imgs'); if (!caixa) return;
  caixa.innerHTML = imgsFeedback.map((im, i) => `<figure class="av-img"><img src="${esc(im.url)}" alt=""><figcaption>${esc(im.nome)}</figcaption><button type="button" class="av-icone-btn" data-tirar-fb="${i}" aria-label="Remover ${esc(im.nome)}">${ic('x')}</button></figure>`).join('')
    + (enviandoFb ? `<figure class="av-img av-img-env"><span class="av-spin"></span><figcaption>Enviando ${enviandoFb}…</figcaption></figure>` : '');
}
async function enviarImagensFeedback(files) {
  if (imgsFeedback.length + files.length > 8) { toast('No máximo 8 imagens no feedback.', 'aviso'); return; }
  enviandoFb += files.length; renderImgsFeedback();
  for (const file of files) {
    try { imgsFeedback.push(await enviarImagem(file)); }
    catch (err) { toast(err.message, 'erro'); }
    finally { enviandoFb--; renderImgsFeedback(); atualizarChecklist(); }
  }
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
    if (e.target.closest('[data-tirar-alt]')) { if (document.querySelectorAll('#av-q-alts .av-alt').length > 2) { e.target.closest('.av-alt').remove(); renumerarAlts(); atualizarChecklist(); } }
    const tf = e.target.closest('[data-tirar-fb]');
    if (tf) { imgsFeedback.splice(Number(tf.dataset.tirarFb), 1); renderImgsFeedback(); atualizarChecklist(); }
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
    if (e.target.id === 'av-q-uso') renderUnidades($('#av-q-unid').value);
    if (e.target.id === 'av-q-obj') { $('#av-q-obj-outro').hidden = e.target.value !== '__outro'; if (e.target.value === '__outro') $('#av-q-obj-outro').focus(); }
    if (e.target.id === 'av-q-ref') { $('#av-q-ref-outra').hidden = e.target.value !== '__outra'; if (e.target.value === '__outra') $('#av-q-ref-outra').focus(); }
    atualizarChecklist();
  });
  $('#av-q-mais-alt').addEventListener('click', () => { const n = document.querySelectorAll('#av-q-alts .av-alt').length; if (n >= MAX_ALTS) return; $('#av-q-alts').insertAdjacentHTML('beforeend', linhaAlt(n)); renumerarAlts(); const novo = document.querySelectorAll('#av-q-alts .av-alt-txt')[n]; if (novo) novo.focus(); atualizarChecklist(); });
  $('#av-q-salvar').addEventListener('click', salvarQuestao);
  $('#av-q-fb-img').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; enviarImagensFeedback(files); });
  // colar um gráfico (Ctrl+V) direto no feedback vira imagem do feedback
  $('#av-q-just').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData && e.clipboardData.files || [])].filter(f => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault(); e.stopImmediatePropagation();
    enviarImagensFeedback(files.map((f, i) => new File([f], `feedback-colado-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type })));
  });
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
          <section class="av-imp-regras" aria-labelledby="av-imp-regras-tit">
            <h3 id="av-imp-regras-tit">Regras do arquivo</h3>
            <p class="av-imp-word"><b>Use o Word (.docx): é o padrão.</b> Só o Word traz as imagens do enunciado e do feedback (gráficos, figuras, GIFs). O PDF traz só o texto; as imagens ficam de fora e precisam ser coladas depois, questão por questão. Tem só o PDF? Abra no Word, salve como .docx e importe.</p>
            <div class="av-imp-colunas">
              <div>
                <h4>Obrigatório em cada questão</h4>
                <p class="av-imp-sub">Sem isso a questão não pode ser finalizada.</p>
                <ul>
                  <li>Começa em <b>"Questão 1"</b>, "1." ou <b>"NÍVEL DE DIFICULDADE:"</b>; o Órbita numera em sequência.</li>
                  <li><b>4 alternativas, A a D</b>, todas diferentes. Sem "nenhuma" ou "todas as anteriores".</li>
                  <li><b>Uma</b> correta, pintada de <mark>amarelo</mark> ou numa linha "Alternativa correta: C".</li>
                  <li><b>Unidade</b> e <b>objetivo</b> do plano de ensino ("Unidade: 2", "Objetivo: O3 – texto do objetivo"). O modelo da disciplina já traz a tabela para copiar.</li>
                  <li><b>Feedback</b> (justificativa da correta), em texto ou imagem.</li>
                  <li><b>Professor</b> que elaborou: escolha abaixo.</li>
                </ul>
              </div>
              <div>
                <h4>Recomendado</h4>
                <p class="av-imp-sub">Vira aviso na conferência CADAM.</p>
                <ul>
                  <li><b>Caso clínico</b> terminando numa pergunta direta ("Qual a conduta mais adequada?").</li>
                  <li>Evite enunciado negativo (EXCETO, INCORRETA), afirmativas I, II, III e correta bem mais longa que as outras.</li>
                  <li><b>Referência</b> bibliográfica (ABNT).</li>
                  <li>Linha <b>"Prova:"</b> para questões de 2ª chamada, Exame semestral, Dependência ou Adaptação. Sem ela, a questão vai para esta prova.</li>
                </ul>
              </div>
            </div>
          </section>
          <p class="av-modelo-baixar"><button type="button" class="btn btn-secondary av-btn" id="av-imp-modelo">Baixar o modelo desta disciplina (Word)</button><span class="av-nota">Já vem com as <b>unidades do bimestre</b> e os <b>objetivos do plano de ensino</b> numerados. Mande aos professores: em cada questão eles preenchem Unidade e Objetivo, pintam a <b>correta de amarelo</b> e o feedback pode ser texto ou imagem.</span></p>
          <div class="av-campos2">
            <label class="av-campo"><span>Arquivo Word (.docx), de preferência. PDF só com texto</span><input type="file" id="av-imp-arq" accept=".docx,.doc,.pdf"></label>
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
    $('#av-imp-modelo').addEventListener('click', async (ev) => {
      const b = ev.currentTarget; b.disabled = true; const t = b.textContent; b.textContent = 'Montando o modelo…';
      try { await baixar(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/modelo`); toast('Modelo baixado: mande aos professores da disciplina.'); }
      catch (e) { toast(e.message, 'erro'); } finally { b.disabled = false; b.textContent = t; }
    });
    m.addEventListener('change', (e) => { if (e.target.matches('.av-imp-gab')) { previaImport[Number(e.target.dataset.i)].gabarito = e.target.value || null; mostrarPrevia(''); } });
  }
  $('#av-imp-prof').innerHTML = atual.papel === 'adjunto' ? `<option>${esc(atual.eu)}</option>` : `<option value="">${atual.papel === 'titular' ? 'Eu mesmo(a)' : 'Definir depois'}</option>${atual.professores.map(n => `<option>${esc(n)}</option>`).join('')}`;
  $('#av-imp-prof').disabled = atual.papel === 'adjunto';
  $('#av-imp-unid').innerHTML = `<option value="">Definir depois</option>${(atual.plano.unidades || []).filter(u => u.bimestre === atual.avaliacao.bimestre).map(u => `<option value="${u.numero}">Unidade ${u.numero} – ${esc(u.titulo)}</option>`).join('')}`;
  $('#av-imp-arq').value = ''; $('#av-imp-txt').value = ''; $('#av-imp-previa').innerHTML = ''; previaImport = []; $('#av-imp-salvar').disabled = true;
  m.hidden = false; document.body.classList.add('av-sem-rolagem');
}
// Word lido no navegador: confere no servidor se alguma questão já existe (16/11/2026)
async function repetidasWord() {
  try {
    const chave = (x) => P.chaveComparar(x.casoHtml !== undefined || x.pergunta ? `${x.casoHtml || ''} ${x.pergunta || ''}` : (x.enunciado || ''));
    const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/importar/repetidas`, { method: 'POST', body: JSON.stringify({ chaves: previaImport.map(chave) }) });
    (r.repetidas || []).forEach((rep, i) => { if (rep && previaImport[i]) previaImport[i].repetida = rep; });
    const n = (r.repetidas || []).filter(Boolean).length;
    return n ? `${n} questão(ões) repetida(s): veja a marca em cada uma.` : '';
  } catch (e) { return ''; }
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
      if (doModelo && doModelo.length) { previaImport = doModelo; mostrarPrevia(await repetidasWord()); return; }
      const itens = await window.LerWord.ler(arq);
      previaImport = P.lerQuestoesDeLinhas(itens);
      if (!previaImport.length) throw new Error('Não encontrei questões objetivas. As questões precisam estar numeradas ("Questão 1", "1.", "2)") com as alternativas a), b), c)...');
      mostrarPrevia(await repetidasWord());
      return;
    }
    const body = { texto: txt };
    if (arq) {
      const b64 = await new Promise((ok, falha) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = falha; r.readAsDataURL(arq); });
      Object.assign(body, { arquivoBase64: b64, nomeArquivo: arq.name, texto: '' });
    }
    const r = await api(`${BASE}/${encodeURIComponent(atual.avaliacao.id)}/importar/analisar`, { method: 'POST', body: JSON.stringify(body) });
    previaImport = r.questoes;
    // PDF: lembra na prévia que as imagens não vieram (16/11/2026)
    const avisoPdf = arq && /\.pdf$/i.test(arq.name) ? 'Atenção: veio de PDF, então só o texto foi lido. Se alguma questão ou feedback tinha imagem, importe o Word (.docx) ou cole a imagem na edição da questão.' : '';
    mostrarPrevia([avisoPdf, r.aviso].filter(Boolean).join(' '));
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; btn.textContent = 'Ler as questões'; }
}
function mostrarPrevia(aviso) {
  {
    const semGab = previaImport.filter(q => !q.gabarito).length;
    const nImg = previaImport.reduce((s2, q) => s2 + (q.imagens || []).length, 0);
    $('#av-imp-previa').innerHTML = `
      <p class="av-nota"><b>${previaImport.length}</b> questão(ões) encontrada(s)${nImg ? `, com <b>${nImg}</b> imagem(ns)` : ''}.${semGab ? ` ${semGab} sem gabarito: marque abaixo.` : ''} ${aviso ? esc(aviso) : ''}</p>
      <ol class="av-previa">${previaImport.map((q, i) => `<li><label class="av-previa-incluir"><input type="checkbox" data-previa-incluir="${i}" ${q.incluir === false || (q.incluir === undefined && q.repetida) ? '' : 'checked'}> Importar esta questão</label>${q.repetida ? `<p class="av-previa-rep">Questão repetida: ${esc(q.repetida)}. Ela vem desmarcada; marque se quiser importar mesmo assim.</p>` : ''}${q.tema || q.tituloOriginal ? `<div class="av-previa-meta">${q.tema ? `<span class="av-tag">${esc(q.tema)}</span>` : ''}${q.dificuldade ? `<span class="av-tag">${esc({ facil: 'Fácil', media: 'Média', intermediaria: 'Intermediária', dificil: 'Difícil' }[q.dificuldade] || q.dificuldade)}</span>` : ''}${q.justificativa || (q.imagensFeedback || []).length ? `<span class="av-selo av-selo-ok">Feedback${(q.imagensFeedback || []).length ? ` (${q.imagensFeedback.length} imagem${q.imagensFeedback.length > 1 ? 's' : ''})` : ''}</span>` : '<span class="av-selo av-selo-erro">Sem feedback</span>'}${q.provaWord ? `<span class="av-tag av-tag-prova av-uso-${usoDoTextoTela(q.provaWord)}">${esc(q.provaWord)}</span>` : ''}${q.unidadeWord ? `<span class="av-tag">Unidade ${esc(q.unidadeWord)}</span>` : ''}${q.objetivoWord ? `<span class="av-tag">Objetivo ${esc(q.objetivoWord.slice(0, 40))}</span>` : ''}${q.fonte ? '<span class="av-selo av-selo-ok">Referência</span>' : ''}${q.gabarito ? '' : '<span class="av-selo av-selo-erro">Sem marca-texto: marque a correta</span>'}</div>` : ''}<p>${esc(q.enunciado.slice(0, 260))}${q.enunciado.length > 260 ? '…' : ''}</p>
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
    // só as marcadas na prévia (as repetidas vêm desmarcadas) — 16/11/2026
    const escolhidas = previaImport.filter((q, i) => { const c = document.querySelector(`[data-previa-incluir="${i}"]`); return c ? c.checked : true; });
    if (!escolhidas.length) { toast('Marque ao menos uma questão para importar.', 'aviso'); btn.disabled = false; return; }
    const total = escolhidas.reduce((s2, q) => s2 + (q.imagens || []).length + (q.imagensFeedback || []).length, 0);
    let feitas = 0;
    const questoes = [];
    for (const q of escolhidas) {
      const imagens = [];
      for (const [j, im] of (q.imagens || []).slice(0, 8).entries()) {
        btn.textContent = `Enviando imagens ${++feitas}/${total}…`;
        const env = await enviarImagem(await dataUrlParaArquivo(im.dataUrl, `questao-${q.numero}-${j + 1}`));
        imagens.push({ caminho: env.caminho, nome: env.nome });
      }
      const imagensFeedback = [];
      for (const [j, im] of (q.imagensFeedback || []).slice(0, 8).entries()) {
        btn.textContent = `Enviando imagens ${++feitas}/${total}…`;
        const env = await enviarImagem(await dataUrlParaArquivo(im.dataUrl, `feedback-${q.numero}-${j + 1}`));
        imagensFeedback.push({ caminho: env.caminho, nome: env.nome });
      }
      questoes.push({ numero: q.numero, enunciado: q.enunciado, alternativas: q.alternativas, gabarito: q.gabarito, imagens, imagensFeedback,
        unidadeWord: q.unidadeWord || '', objetivoWord: q.objetivoWord || '', provaWord: q.provaWord || '',
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

    <h3 class="av-mc-h">Professor responsável pela disciplina</h3>
    <label class="av-campo"><span>Responsável (divide as questões entre os colegas, define as unidades de cada bimestre e acompanha o envio ao AVA). Os demais são adjuntos e veem só as próprias questões.</span><select id="av-mc-resp"><option value="">Automático: titular no Edubox (${esc((c.titulares || []).join(', ') || 'nenhum lançado')})</option>${(c.professores || []).map(n => `<option ${P.norm(n) === P.norm(cr.responsavel || '') ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>

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

    <h3 class="av-mc-h">Avisos de equilíbrio da prova</h3>
    <p class="av-nota">O professor responsável também ajusta estes avisos em "Divisão das questões". O Órbita calcula quantas questões cada unidade deveria ter, proporcional à carga horária dela (ou ao peso acima), e avisa quando a prova foge disso.</p>
    <div class="av-campos3">
      <label class="av-campo"><span>Caso clínico: no mínimo (% da prova)</span><input type="number" id="av-mc-caso" class="av-input" min="0" max="100" value="${lim.minCaso}"></label>
      <label class="av-campo"><span>Unidade com poucas questões: avisar abaixo de (% do esperado)</span><input type="number" id="av-mc-abaixo" class="av-input" min="0" max="100" value="${lim.abaixo}"></label>
      <label class="av-campo"><span>Unidade com questões demais: avisar acima de (% do esperado)</span><input type="number" id="av-mc-acima" class="av-input" min="100" max="500" value="${lim.acima}"></label>
    </div>
    <p class="av-nota">Exemplo: numa prova de 20 questões, se a carga horária pede 8 para a Unidade 2, com ${c.padrao.abaixo}% o aviso aparece se ela tiver menos de ${Math.round(8 * c.padrao.abaixo) / 100} questões, e com ${c.padrao.acima}% se passar de ${Math.round(8 * c.padrao.acima) / 100}. Padrão: ${c.padrao.minCaso}% de caso clínico, ${c.padrao.abaixo}% e ${c.padrao.acima}%. São só avisos para quem monta a prova; não impedem finalizar.</p>`;
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
    const r = await api(`${CRIT}/${encodeURIComponent(critAtual.chave)}`, { method: 'PUT', body: JSON.stringify({ bimestres, pesos, limites, qtdQuestoes, porProfessor, semestre, responsavel: ($('#av-mc-resp') || {}).value || '' }) });
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
  let q = { alternativas: [{}, {}, {}, {}], dificuldade: 'media' };
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
function relatorioHtml({ sub, questoes, totalProva, deQuem, editar, avId }) {
  const itens = questoes.map(conferirQuestao);
  const corrigiveis = itens.reduce((s, x) => s + x.pt.filter(a => a.para).length, 0);
  const conta = (k) => itens.filter(x => x.sit === k).length;
  const erros = itens.reduce((s, x) => s + x.pt.length, 0);
  const min = minutosProva(itens);
  const lista = itens.map(({ q, pd, pt, sit }) => `
    <li class="av-conf-q av-conf-${sit}">
      <div class="av-conf-q-cab">
        <span class="av-conf-num">Questão ${q.numero}</span>
        <span class="av-conf-sit">${SIT[sit]}</span>
        ${deQuem ? `<span class="av-conf-prof">${esc(q.professorNome || 'Sem professor')}</span>` : ''}
        ${editar && avId && pt.some(a => a.para) ? `<button type="button" class="av-pt-btn av-pt-tudo" data-pt-tudo-q="${esc(q.id)}" data-av="${esc(avId)}">Ver correções de português e ABNT</button>` : ''}
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
      ${editar && avId && corrigiveis ? `<div class="av-pt-tudo-barra"><button type="button" class="btn btn-primary av-btn" data-pt-tudo-prova="${esc(avId)}">Corrigir tudo de português e ABNT (${corrigiveis})</button><span>Mostra antes cada correção (antes → depois) para você conferir; só muda o que você deixar marcado. O que precisa de decisão (ex.: referência sem ano) continua apontado.</span></div>` : ''}
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
      const dv = e.target.closest('[data-devolutiva-av]');
      if (dv) { abrirDevolutivaDaProva(dv.dataset.devolutivaAv); return; }
      const px = e.target.closest('[data-prof-xml]');
      if (px) { baixarXmlProfessor(px.dataset.profXml, px); return; }
      const ptq = e.target.closest('[data-pt-tudo-q], [data-pt-tudo-prova]');
      if (ptq) { corrigirPtTudo(ptq); return; }
      const pta = e.target.closest('[data-pt-aplicar]');
      if (pta) { aplicarPtMarcadas(pta); return; }
      if (e.target.closest('[data-pt-voltar]') && confRecarregar) { confRecarregar(); return; }
      const av = e.target.closest('[data-conf-av]');
      if (av) abrirConferenciaDaProva(av.dataset.confAv);
      if (e.target.closest('[data-conf-lista]')) abrirConferenciaProfessor();
    });
    m.addEventListener('change', async (e) => {
      const c = e.target.closest('[data-envio]');
      if (!c) return;
      c.disabled = true;
      try { const r = await api(`/banco-med-fatec/conferencia/${encodeURIComponent(c.dataset.av)}/envio`, { method: 'PUT', body: JSON.stringify({ etapa: c.dataset.envio, feito: c.checked }) }); toast(r.message); await abrirConferenciaDaProva(c.dataset.av); }
      catch (err) { c.checked = !c.checked; c.disabled = false; toast(err.message, 'erro'); }
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
  return `<span class="av-parte ${falta > 0 ? 'av-parte-falta' : 'av-parte-ok'}"><span class="av-uso-rot av-uso-${a.tipo === 'exame' ? 'exame' : a.chamada === 2 ? 'c2' : 'c1'}">${a.tipo === 'exame' ? 'Exame semestral' : a.chamada === 2 ? '2ª chamada' : '1ª chamada'}</span> <b>${a.feitas} de ${a.meta}</b> questões${falta > 0 ? ` · faltam ${falta}` : falta < 0 ? ` · ${-falta} a mais` : ' · completa'}</span>`;
}
// Progresso da disciplina (Bia / coordenação): professor × prova, feitas de cota
// marcações do AVA (professor): banco de questões e questionário
function envioCel(e) {
  if (!e) return '';
  // arquivo: marcado sozinho quando o professor baixa para o AVA (17/11/2026)
  const a = e.arquivo && e.arquivo.feito, b = e.bancoAva && e.bancoAva.feito, q = e.questionario && e.questionario.feito;
  if (!a && !b && !q) return '';
  return `<small class="av-pg-envio" title="Baixou o arquivo · subiu no banco do AVA · colocou no questionário">${a ? 'Baixou ✓' : 'Baixou –'} · ${b ? 'AVA ✓' : 'AVA –'} · ${q ? 'Quest. ✓' : 'Quest. –'}</small>`;
}
const ddmmIso = (iso) => iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '';
// toda prova pode ter 2ª chamada: a parte do professor também precisa estar pronta (16/11/2026)
function segundaHtml(s, rotulo = '2ª chamada') {
  const quando = s.data ? ` · prova em ${ddmmIso(s.data)}` : '';
  const usoR = /exame/i.test(rotulo) ? 'exame' : 'c2';
  if (!s.meta) return `<span class="av-parte av-parte-sem"><span class="av-uso-rot av-uso-${usoR}">${rotulo}</span> ${s.feitas ? `${s.feitas} questão(ões) pronta(s)` : 'nenhuma questão pronta'}${quando}</span>`;
  const falta = s.meta - s.feitas;
  return `<span class="av-parte ${falta > 0 ? 'av-parte-falta' : 'av-parte-ok'}"><span class="av-uso-rot av-uso-${usoR}">${rotulo}</span> <b>${s.feitas} de ${s.meta}</b>${falta > 0 ? ` · <b>falta preparar ${falta}</b>` : ' · pronta'}${quando}</span>`;
}
function envioResumo(e) {
  const b = e && e.bancoAva && e.bancoAva.feito, q = e && e.questionario && e.questionario.feito;
  return `<span class="av-envio-resumo">${b ? '✓ No banco do AVA' : '• Falta subir no AVA'} · ${q ? '✓ No questionário' : '• Falta o questionário'}</span>`;
}
async function abrirProgresso(chave, rota) {
  modalConf();
  confEditar = null;
  $('#av-conf-tit').textContent = 'Progresso da disciplina';
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Contando as questões de cada professor…</p>';
  try {
    const r = await api(rota || `${BASE}/progresso/${encodeURIComponent(chave)}?semestre=${encodeURIComponent(semestre)}`);
    // bimestre fechado (fim de 2026.2) não aparece no progresso, como na grade (16/11/2026)
    const fica = r.provas.map((p, i) => i).filter(i => r.provas[i].tipo === 'exame' || verFechados || !BIMESTRES_FECHADOS.includes(r.provas[i].bimestre));
    const ocultas = r.provas.length - fica.length;
    r.provas = fica.map(i => r.provas[i]);
    r.professores.forEach(pr => { pr.feitas = fica.map(i => pr.feitas[i]); if (Array.isArray(pr.envios)) pr.envios = fica.map(i => pr.envios[i]); });
    const cel = (feitas, meta, envio) => (meta ? `<td class="${feitas >= meta ? 'av-pg-ok' : feitas ? 'av-pg-meio' : 'av-pg-zero'}">${feitas} de ${meta}${feitas > meta ? ` <small>(+${feitas - meta})</small>` : ''}` : `<td class="av-pg-livre">${feitas || '–'}`) + envioCel(envio) + '</td>';
    const completos = (i) => r.professores.filter(p => p.meta && p.feitas[i] >= p.meta).length;
    const comCota = r.professores.filter(p => p.meta).length;
    $('#av-conf-corpo').innerHTML = `
      <p class="av-conf-sub">${esc(r.disciplina)} · ${esc(r.semestre)}${r.qtdQuestoes ? ` · prova de ${r.qtdQuestoes} questões` : ''}</p>
      ${!r.provas.length ? '<p class="av-vazio">Nenhuma prova montada ainda nesta disciplina.</p>' : `
      ${!comCota ? '<p class="av-conf-nota">A divisão entre os professores ainda não foi definida nos critérios da disciplina — a tabela mostra só quantas cada um já fez.</p>' : ''}
      ${ocultas ? `<p class="av-conf-nota">O 1º bimestre está fechado e não aparece aqui (${ocultas} coluna${ocultas > 1 ? 's' : ''}).</p>` : ''}
      <p class="av-pg-dica">Role a tabela para o lado para ver todas as provas.</p>
      <div class="av-pg-tabela"><table>
        <thead><tr><th scope="col">Professor</th>${r.provas.map(p => `<th scope="col" class="av-uso-th av-uso-${p.tipo === 'exame' ? 'exame' : p.chamada === 2 ? 'c2' : 'c1'}">${p.tipo === 'exame' ? 'Exame semestral' : `${ordinal(p.bimestre)} bim · ${p.chamada}ª ch.`}<small>${p.virtual ? 'ainda no banco' : p.status === 'finalizada' ? 'Finalizada' : 'Em montagem'}</small></th>`).join('')}</tr></thead>
        <tbody>${r.professores.map(pr => `<tr><th scope="row">${esc(pr.nome)}${r.responsavel && r.responsavel.split(' / ').some(x => P.norm(x) === P.norm(pr.nome)) ? ' <small class="av-resp">responsável</small>' : ''}${pr.meta ? '' : ' <small>sem cota</small>'}</th>${pr.feitas.map((f, i) => cel(f, pr.meta, (pr.envios || [])[i])).join('')}</tr>`).join('')}
          ${r.provas.some(p => p.semProfessor) ? `<tr><th scope="row"><i>Sem professor informado</i></th>${r.provas.map(p => `<td class="${p.semProfessor ? 'av-pg-zero' : 'av-pg-livre'}">${p.semProfessor || '–'}</td>`).join('')}</tr>` : ''}
        </tbody>
        <tfoot><tr><th scope="row">Total da prova</th>${r.provas.map((p, i) => `<td>${p.total}${r.qtdQuestoes ? ` de ${r.qtdQuestoes}` : ''}${comCota ? `<small>${completos(i)} de ${comCota} professores completos</small>` : ''}</td>`).join('')}</tr></tfoot>
      </table></div>`}`;
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
}
const subProva = (a) => `${esc(a.disciplina)} · ${rotuloAvaliacao(a)} · ${esc(a.semestre)} · ${a.status === 'finalizada' ? 'Finalizada' : 'Em montagem'}`;

// ===== Relatório CADAM (17/11/2026, a pedido da coordenação de Medicina) =====
// Mesmo diagnóstico (cadam-relatorio.js), dois leitores:
//  • Devolutiva (professor): formativa — o que está bom, o que corrigir e por quê, como reescrever. Sem "Inapta".
//  • Executivo (Bia/coordenação): parecer Apta/Requer ajustes/Inapta, tabela de inconformidades, matriz, professores.
// Só orienta: não trava nada (as travas continuam na Conferência CADAM / padrao.js).
const CR = () => window.CadamRelatorio;
const NIVEL_ROT = { obrigatorio: 'Corrigir antes de enviar', ajuste: 'Para melhorar', sugestao: 'Dica' };
const NIVEL_CLS = { obrigatorio: 'av-rel-obr', ajuste: 'av-rel-aj', sugestao: 'av-rel-sug' };
const SIT_CLS = { Corrigir: 'av-conf-refazer', Ajustar: 'av-conf-ajustar', Aprovada: '' };
let relEstado = null; // { modo, professor, questoes, analise, sub, editar, titulo, podeExecutivo, podeEscolher }
function itemMelhorarHtml(m) {
  return `<li class="av-rel-item ${NIVEL_CLS[m.nivel]}"><b>${esc(m.titulo)}</b>
    ${m.porque ? `<span class="av-rel-pq"><em>Por quê:</em> ${esc(m.porque)}</span>` : ''}
    ${m.como ? `<span class="av-rel-como"><em>Como fazer:</em> ${esc(m.como)}</span>` : ''}
    ${(m.exemplos || []).length ? `<span class="av-rel-ex">${m.exemplos.map(esc).join('<br>')}</span>` : ''}
    ${m.fonte ? `<small class="av-rel-fonte">${esc(m.fonte)}</small>` : ''}</li>`;
}
function devolutivaHtml(qs, sub, editar) {
  const C = CR(); const itens = qs.map(q => ({ q, r: C.analisarQuestao(q) }));
  const n = itens.length, corr = itens.filter(x => x.r.situacao === 'Corrigir').length, aj = itens.filter(x => x.r.situacao === 'Ajustar').length;
  // o que mais apareceu: vira a "mini-aula" do topo
  const tipos = {}; itens.forEach(({ q, r }) => r.melhorar.forEach(m => { const t = tipos[m.tipo] = tipos[m.tipo] || { ...m, qs: [] }; if (!t.qs.includes(q.numero)) t.qs.push(q.numero); }));
  const top = Object.values(tipos).sort((a, b) => b.qs.length - a.qs.length).slice(0, 4);
  const fortes = {}; itens.forEach(({ r }) => r.fortes.forEach(f => { fortes[f] = (fortes[f] || 0) + 1; }));
  const topFortes = Object.entries(fortes).sort((a, b) => b[1] - a[1]).slice(0, 3);
  return `<p class="av-conf-sub">${sub}</p>
    <p class="av-rel-intro">Esta devolutiva é para ajudar você a escrever questões cada vez melhores. Ela mostra o que já está bom, o que precisa ser corrigido antes da prova ser liberada e o porquê de cada recomendação, com base no padrão CADAM e nas diretrizes do NBME para questões de medicina.</p>
    <div class="av-conf-nums"><div><b>${n}</b><span>questões</span></div><div class="av-conf-n-ok"><b>${n - corr - aj}</b><span>prontas</span></div><div class="av-conf-n-aj"><b>${aj}</b><span>para melhorar</span></div><div class="av-conf-n-rf"><b>${corr}</b><span>corrigir antes de enviar</span></div></div>
    ${topFortes.length ? `<section class="av-rel-bloco av-rel-bom"><h3>O que você já faz bem</h3><ul>${topFortes.map(([f, k]) => `<li>${esc(f)} <small>(${k} de ${n})</small></li>`).join('')}</ul></section>` : ''}
    ${top.length ? `<section class="av-rel-bloco"><h3>O que mais apareceu nas suas questões</h3><ol class="av-rel-top">${top.map(t => `<li><b>${esc(t.tipo)}</b> <small>questões ${t.qs.join(', ')}</small><br>${esc(t.porque || '')} ${t.como ? `<em>${esc(t.como)}</em>` : ''}</li>`).join('')}</ol></section>` : ''}
    <ol class="av-conf-lista">${itens.map(({ q, r }) => {
      const por = (nv) => r.melhorar.filter(m => m.nivel === nv);
      return `<li class="av-conf-q ${SIT_CLS[r.situacao]}"><div class="av-conf-q-cab"><span class="av-conf-num">Questão ${q.numero}</span>
        <span class="av-conf-sit">${r.situacao === 'Aprovada' ? 'Pronta' : r.situacao === 'Ajustar' ? 'Para melhorar' : 'Corrigir antes de enviar'}</span>
        <span class="av-conf-prof">Bloom estimado: ${esc(r.bloom)}${r.nivelObjetivo ? ` · objetivo pede ${esc(r.nivelObjetivo)}` : ''}</span>
        ${editar ? `<button type="button" class="av-pt-btn av-conf-editar" data-conf-editar="${esc(q.id)}">Abrir questão</button>` : ''}</div>
        <p class="av-conf-enun">${esc((P.texto(q.casoClinico || q.enunciadoHtml) || '').slice(0, 160))}${(P.texto(q.casoClinico || q.enunciadoHtml) || '').length > 160 ? '…' : ''}</p>
        ${r.fortes.length ? `<h5 class="av-rel-h-bom">O que está bom</h5><ul class="av-rel-fortes">${r.fortes.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
        ${['obrigatorio', 'ajuste', 'sugestao'].map(nv => por(nv).length ? `<h5 class="${NIVEL_CLS[nv]}-h">${NIVEL_ROT[nv]}</h5><ul class="av-rel-lista">${por(nv).map(itemMelhorarHtml).join('')}</ul>` : '').join('')}
        ${!r.melhorar.length ? '<p class="av-conf-okmsg">Questão no padrão. Bom trabalho!</p>' : ''}</li>`; }).join('')}</ol>`;
}
function executivoHtml(qs, sub, analise) {
  const C = CR(); const r = C.analisarProva(qs, analise);
  const pc = r.parecer === 'Apta' ? 'av-rel-apta' : r.parecer === 'Inapta' ? 'av-rel-inapta' : 'av-rel-ajustes';
  const profs = {}; qs.forEach((q, k) => { const p = q.professorNome || 'Sem professor'; const x = profs[p] = profs[p] || { n: 0, ok: 0, aj: 0, co: 0 }; x.n++; const s = r.itens[k].situacao; if (s === 'Aprovada') x.ok++; else if (s === 'Ajustar') x.aj++; else x.co++; });
  const bloom = ['Lembrar', 'Entender', 'Aplicar', 'Analisar', 'Avaliar'].filter(b => r.bloom[b]).map(b => `${b} ${r.bloom[b]}`).join(' · ');
  const num = (q) => q == null ? 'Prova' : q;
  return `<p class="av-conf-sub">${sub}</p>
    <section class="av-rel-bloco"><h3>1. Resumo executivo</h3>
      <p class="av-rel-parecer ${pc}">Parecer preliminar: <b>${r.parecer}</b></p>
      <div class="av-conf-nums"><div><b>${r.total}</b><span>questões</span></div><div class="av-conf-n-ok"><b>${r.aprovadas}</b><span>aprovadas</span></div><div class="av-conf-n-aj"><b>${r.comAjuste}</b><span>requerem ajuste</span></div><div class="av-conf-n-rf"><b>${r.comObrig}</b><span>com correção obrigatória</span></div><div><b>${r.pctCaso}%</b><span>caso clínico</span></div><div><b>~${r.minutos} min</b><span>tempo estimado</span></div></div>
      <p class="av-rel-txt">Bloom estimado: ${bloom || '—'}.${r.travadas ? ` <b>${r.travadas} questão(ões) ainda fora do padrão</b> (não sai para o AVA).` : ''}</p></section>
    <section class="av-rel-bloco"><h3>2. Tabela sinóptica de inconformidades</h3>
      ${r.tabela.length ? `<div class="av-rel-tab-wrap"><table class="av-rel-tab"><thead><tr><th>Nº</th><th>Tipo de falha</th><th>Descrição</th><th>Impacto e ação corretiva</th></tr></thead><tbody>
      ${r.tabela.map(t => `<tr class="${NIVEL_CLS[t.nivel]}"><td data-r="Questão">${num(t.questao)}</td><td data-r="Tipo"><b>${esc(t.tipo)}</b><small>Eixo ${t.eixo} · ${t.nivel === 'obrigatorio' ? 'obrigatória' : 'ajuste'}</small></td><td data-r="Descrição">${esc(t.titulo)}${(t.exemplos || []).length ? `<small>${t.exemplos.map(esc).join('<br>')}</small>` : ''}</td><td data-r="Ação">${t.porque ? esc(t.porque) + ' ' : ''}<b>${esc(t.como || '')}</b></td></tr>`).join('')}
      </tbody></table></div>` : '<p class="av-conf-okmsg">Nenhuma inconformidade obrigatória ou de ajuste.</p>'}</section>
    <section class="av-rel-bloco"><h3>3. Análise temática e balanço da matriz</h3>
      <div class="av-rel-tab-wrap"><table class="av-rel-tab"><thead><tr><th>Objetivo / tema</th><th>Itens</th><th>Questões</th></tr></thead><tbody>
      ${r.temas.map(t => `<tr class="${t.alerta ? 'av-rel-aj' : ''}"><td>${esc(t.tema)}${t.alerta ? '<small>Hiperconcentração</small>' : ''}</td><td>${t.qtd} (${t.pct}%)</td><td>${t.questoes.join(', ')}</td></tr>`).join('')}
      ${r.semObjetivo.map(o => `<tr class="av-rel-obr"><td>${esc(o)}<small>Sem questão</small></td><td>0</td><td>—</td></tr>`).join('')}
      </tbody></table></div>
      ${r.redundancias.length ? `<p class="av-rel-txt"><b>Redundância de desfecho:</b> ${r.redundancias.map(d => `questões ${d.questoes.join(', ')} ("${esc(d.texto.slice(0, 60))}")`).join('; ')}.</p>` : '<p class="av-rel-txt">Sem redundância de desfecho (nenhuma resposta correta se repete).</p>'}</section>
    <section class="av-rel-bloco"><h3>4. Recomendações prioritárias para a devolutiva ao docente</h3>
      ${r.prioridades.length ? `<ol class="av-rel-top">${r.prioridades.map(p => `<li class="${NIVEL_CLS[p.nivel]}"><b>${esc(p.tipo)}</b>${p.questoes.length ? ` <small>questões ${p.questoes.join(', ')}</small>` : ' <small>prova inteira</small>'}<br>${esc(p.como || '')}</li>`).join('')}</ol>` : '<p class="av-conf-okmsg">Nada obrigatório a pedir ao professor.</p>'}
      ${r.conferenciaVisual.length ? `<p class="av-rel-txt"><b>Conferir a olho</b> as imagens das questões ${r.conferenciaVisual.join(', ')}: sem seta, legenda ou texto que entregue a resposta, e legíveis no celular.</p>` : ''}</section>
    <section class="av-rel-bloco"><h3>Situação por professor</h3><div class="av-rel-tab-wrap"><table class="av-rel-tab"><thead><tr><th>Professor(a)</th><th>Questões</th><th>Prontas</th><th>Ajustar</th><th>Corrigir</th><th></th></tr></thead><tbody>
      ${Object.entries(profs).map(([p, x]) => `<tr><td>${esc(p)}</td><td>${x.n}</td><td>${x.ok}</td><td>${x.aj}</td><td>${x.co}</td><td><button type="button" class="av-link" data-rel-prof="${esc(p)}">Devolutiva</button></td></tr>`).join('')}
      </tbody></table></div></section>
    <p class="av-conf-nota">Relatório automático: confirma padrões de escrita e estrutura; não substitui a leitura do conteúdo médico (gabarito, dados clínicos). Imagens não são lidas pelo sistema.</p>`;
}
// ---------- PDF do Relatório CADAM (17/11/2026) — padrão de relatório do Órbita (cadam-pdf.js) ----------
// jsPDF só é carregado quando alguém pede o PDF (mesma versão usada na CPA e na Avaliação Docente).
let jspdfCarregando = null;
const carregarJsPdf = () => (window.jspdf ? Promise.resolve() : (jspdfCarregando = jspdfCarregando || new Promise((ok, erro) => {
  const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
  s.onload = ok; s.onerror = () => { jspdfCarregando = null; erro(new Error('Não foi possível carregar o gerador de PDF. Confira a internet e tente de novo.')); };
  document.head.appendChild(s);
})));
const logosPdf = {};
async function logoPdf(url) {
  if (logosPdf[url]) return logosPdf[url];
  const blob = await (await fetch(url)).blob();
  const dataUrl = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(blob); });
  const img = new Image(); img.src = dataUrl; await img.decode();
  // corta a margem em branco da imagem (a logo da FATEC tem muita borda e saía pequena)
  const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
  const px = cx.getImageData(0, 0, cv.width, cv.height).data; let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) { const i = (y * cv.width + x) * 4; if (px[i + 3] > 20 && (px[i] < 235 || px[i + 1] < 235 || px[i + 2] < 235)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  if (x1 < 0) return (logosPdf[url] = { dataUrl, w: img.naturalWidth, h: img.naturalHeight });
  const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return (logosPdf[url] = { dataUrl: out.toDataURL('image/png'), w: out.width, h: out.height });
}
let pdfDados = null; // o que está na tela agora: { modo, questoes, av, professor, analise }
async function baixarPdfRelatorio(btn) {
  const d = pdfDados; if (!d || !d.questoes.length) return;
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Gerando PDF…';
  try {
    await carregarJsPdf();
    const { montarPdfDevolutiva, montarPdfExecutivo } = await import('./cadam-pdf.js?v=3');
    const [fatec, med] = await Promise.all([logoPdf('/img/fateclogoazul.png').catch(() => null), logoPdf('/img/medfatec-logo.png').catch(() => null)]);
    const args = { CR: { ...CR(), texto: P.texto }, questoes: d.questoes, av: d.av, rotulo: rotuloAvaliacao(d.av), professor: d.professor, analise: d.analise, logos: { fatec, med } };
    const doc = d.modo === 'executivo' ? montarPdfExecutivo(window.jspdf.jsPDF, args) : montarPdfDevolutiva(window.jspdf.jsPDF, args);
    const nome = ['Relatorio CADAM', d.modo === 'executivo' ? 'Executivo' : 'Devolutiva', d.professor, d.av.disciplina, rotuloAvaliacao(d.av)].filter(Boolean).join(' - ').replace(/[\\/:*?"<>|·]/g, '').replace(/\s+/g, ' ');
    doc.save(nome + '.pdf');
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; btn.textContent = txt; }
}
const botaoPdf = (modo) => `<div class="av-rel-pdf"><button type="button" class="btn btn-primary av-btn" data-rel-pdf>${ic('baixar')}Baixar PDF ${modo === 'executivo' ? 'do executivo' : 'da devolutiva'}</button></div>`;
function desenharRelatorio() {
  const e = relEstado; if (!e) return;
  const profs = [...new Set(e.questoes.map(q => q.professorNome || 'Sem professor'))].sort();
  const abas = e.podeExecutivo ? `<div class="av-rel-abas" role="tablist"><button type="button" role="tab" aria-selected="${e.modo === 'executivo'}" data-rel-modo="executivo">Executivo (coordenação)</button><button type="button" role="tab" aria-selected="${e.modo === 'devolutiva'}" data-rel-modo="devolutiva">Devolutiva ao professor</button></div>` : '';
  const escolher = e.modo === 'devolutiva' && e.podeEscolher && profs.length > 1 ? `<label class="av-rel-escolha">Professor(a): <select data-rel-sel>${['', ...profs].map(p => `<option value="${esc(p)}" ${p === (e.professor || '') ? 'selected' : ''}>${p ? esc(p) : 'Todos'}</option>`).join('')}</select></label>` : '';
  const qs = e.modo === 'devolutiva' && e.professor ? e.questoes.filter(q => (q.professorNome || 'Sem professor') === e.professor) : e.questoes;
  $('#av-conf-tit').textContent = e.modo === 'executivo' ? 'Relatório CADAM — executivo' : 'Relatório CADAM — devolutiva' + (e.professor ? ' · ' + e.professor : '');
  pdfDados = { modo: e.modo, questoes: qs, av: e.av, analise: e.analise, professor: e.modo === 'devolutiva' ? (e.professor || e.eu || '') : '' };
  $('#av-conf-corpo').innerHTML = abas + escolher + (qs.length ? botaoPdf(e.modo) : '') + (!qs.length ? '<p class="av-vazio">Nenhuma questão.</p>' : e.modo === 'executivo' ? executivoHtml(qs, e.sub, e.analise) : devolutivaHtml(qs, e.sub, e.editar));
  $('#av-conf-corpo').scrollTop = 0;
}
function ligarRelatorio() {
  const corpo = $('#av-conf-corpo'); if (corpo.dataset.relLigado) return; corpo.dataset.relLigado = '1';
  corpo.addEventListener('click', (ev) => {
    const m = ev.target.closest('[data-rel-modo]'); if (m && relEstado) { relEstado.modo = m.dataset.relModo; relEstado.professor = ''; desenharRelatorio(); return; }
    const pdf = ev.target.closest('[data-rel-pdf]'); if (pdf) { baixarPdfRelatorio(pdf); return; }
    const p = ev.target.closest('[data-rel-prof]'); if (p && relEstado) { relEstado.modo = 'devolutiva'; relEstado.professor = p.dataset.relProf; desenharRelatorio(); }
  });
  corpo.addEventListener('change', (ev) => { const s = ev.target.closest('[data-rel-sel]'); if (s && relEstado) { relEstado.professor = s.value; desenharRelatorio(); } });
}
// botão da prova aberta: Bia (editora) começa no executivo; professor só vê a devolutiva
function abrirRelatorioCadam() {
  if (!atual || !CR()) return;
  modalConf(); ligarRelatorio();
  const fin = atual.avaliacao.status === 'finalizada';
  confEditar = fin ? null : (id) => abrirQuestao(id);
  confRecarregar = async () => { await recarregarAtual(); abrirRelatorioCadam(); };
  const adj = atual.papel === 'adjunto';
  relEstado = { modo: souEditor() ? 'executivo' : 'devolutiva', professor: '', av: atual.avaliacao, eu: adj ? atual.eu : '', sub: subProva(atual.avaliacao), editar: !fin, analise: atual.analise,
    questoes: atual.questoes.map((q, i) => ({ ...q, numero: i + 1 })), podeExecutivo: souEditor(), podeEscolher: !adj };
  desenharRelatorio();
}
// "Minhas provas" do professor: devolutiva só das questões dele
async function abrirDevolutivaDaProva(id) {
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Preparando a devolutiva…</p>';
  try {
    const r = await api(`/banco-med-fatec/conferencia/${encodeURIComponent(id)}`);
    ligarRelatorio();
    relEstado = { modo: 'devolutiva', professor: '', sub: subProva(r.avaliacao), editar: false, analise: null, questoes: r.questoes, podeExecutivo: false, podeEscolher: false };
    desenharRelatorio();
    $('#av-conf-corpo').insertAdjacentHTML('afterbegin', `<button type="button" class="av-voltar" data-conf-av="${esc(id)}">${ic('voltar')}Conferência das minhas questões</button>`);
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
}

// Bia / coordenação: a prova aberta na aba Avaliações, inteira
function conferirProvaAberta() {
  if (!atual) return;
  modalConf();
  const fin = atual.avaliacao.status === 'finalizada';
  confEditar = fin ? null : (id) => abrirQuestao(id);
  $('#av-conf-tit').textContent = 'Conferência CADAM da prova';
  confRecarregar = async () => { await recarregarAtual(); conferirProvaAberta(); };
  $('#av-conf-corpo').innerHTML = relatorioHtml({ sub: subProva(atual.avaliacao), questoes: atual.questoes.map((q, i) => ({ ...q, numero: i + 1 })), totalProva: atual.questoes.length, deQuem: atual.papel !== 'adjunto', editar: !fin, avId: atual.avaliacao.id });
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
         <ul class="av-conf-provas">${r.avaliacoes.map(a => `<li><button type="button" data-conf-av="${esc(a.id)}"><b>${esc(a.disciplina)}</b><span>${rotuloAvaliacao(a)} · ${esc(a.semestre)}</span><span class="av-status ${a.status === 'finalizada' ? 'av-status-fin' : 'av-status-rasc'}">${a.status === 'finalizada' ? 'Finalizada' : 'Em montagem'}</span>${a.data ? `<span class="av-data-prova">Prova em ${ddmmIso(a.data)}</span>` : ''}${parteHtml(a)}${a.segunda ? segundaHtml(a.segunda) : ''}${a.exame ? segundaHtml(a.exame, 'Exame semestral') : ''}${envioResumo(a.envio)}</button></li>`).join('')}</ul>`
      : `<p class="av-vazio">Ainda não há prova montada nas suas disciplinas de ${esc(r.semestre)}.</p>`;
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
}
async function abrirConferenciaDaProva(id) {
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Conferindo…</p>';
  try {
    const r = await api(`/banco-med-fatec/conferencia/${encodeURIComponent(id)}`);
    const a = r.avaliacao;
    $('#av-conf-tit').textContent = 'Minhas questões — Relatório CADAM';
    ligarRelatorio();
    pdfDados = { modo: 'devolutiva', questoes: r.questoes, av: a, professor: r.professor || '', analise: null };
    confRecarregar = () => abrirConferenciaDaProva(id);
    confEditar = (qid) => abrirEditorBanco({ questaoId: qid, categorias: [{ id: a.categoriaId, nome: a.disciplina, periodo: 0 }], aposSalvar: async () => { modalConf(); await abrirConferenciaDaProva(id); } });
    const env = r.envio || {};
    const marca = (etapa, rotulo) => { const e = env[etapa] || {}; return `<label class="av-envio-item ${e.feito ? 'av-envio-ok' : ''}"><input type="checkbox" data-envio="${etapa}" data-av="${esc(id)}" ${e.feito ? 'checked' : ''}> ${rotulo}${e.feito && e.em ? `<small>${new Date(e.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small>` : ''}</label>`; };
    const envioHtml = `<section class="av-envio"><h3>Enviar ao AVA</h3><p class="av-nota">Cada botão baixa o arquivo de uma prova só (1ª chamada, 2ª chamada, exame…), com as suas questões daquela prova. Importe no banco de questões do AVA e depois marque cada etapa.</p>
      ${botoesXmlHtml(id, 'av-pt-btn', false)}
      <div class="av-envio-itens">${marca('bancoAva', 'Subi no banco de questões do AVA')}${marca('questionario', 'Coloquei no questionário')}</div></section>`;
    $('#av-conf-corpo').innerHTML = `<button type="button" class="av-voltar" data-conf-lista>${ic('voltar')}Minhas provas</button>${envioHtml}<p class="av-conf-cota">${parteHtml({ meta: r.meta, feitas: r.questoes.length })}${r.qtdProva ? ` <span class="av-conf-cota-prova">A prova tem ${r.qtdProva} questões no total, divididas entre os professores da disciplina.</span>` : ''}</p>` + (r.questoes.length ? botaoPdf('devolutiva') + devolutivaHtml(r.questoes, subProva(a), a.status !== 'finalizada') : '<p class="av-vazio">Nenhuma questão sua nesta prova ainda.</p>'); // 17/11/2026: professor vê o Relatório (devolutiva); a Conferência CADAM é só da coordenação
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
    nova.insertAdjacentHTML('beforebegin', '<button class="btn bmf-btn-on-blue-ghost action-execute" id="bmf-btn-modelo" type="button"><svg class="bmf-icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg><span>Modelo de questões (Word)</span></button>');
    document.getElementById('bmf-btn-modelo').addEventListener('click', () => abrirModeloProfessor(eu));
    try {
      const div = await api('/banco-med-fatec/divisao');
      if (div.some(d => d.souResponsavel)) {
        nova.insertAdjacentHTML('beforebegin', '<button class="btn bmf-btn-on-blue-ghost action-execute" id="bmf-btn-divisao" type="button"><svg class="bmf-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg><span>Divisão das questões</span></button>');
        document.getElementById('bmf-btn-divisao').addEventListener('click', () => abrirDivisao());
      }
    } catch (e) { /* sem divisão */ }
  } catch (e) { /* sem botão se o Edubox não respondeu */ }
}

// ---------- professor: modelo do Word, XML e divisão (16/11/2026) ----------
function abrirModeloProfessor(eu) {
  modalConf();
  confEditar = null;
  $('#av-conf-tit').textContent = 'Modelo de questões (Word)';
  const discs = (eu.categoriaIds || []).map((id, i) => ({ id, nome: (eu.disciplinas || [])[i] || id }));
  $('#av-conf-corpo').innerHTML = discs.length ? `
    <p class="av-conf-sub">O modelo vem com os <b>objetivos</b> e as <b>unidades</b> do plano de ensino da disciplina. Cada questão precisa avaliar um objetivo da lista: escreva na linha "Objetivo:" o código e o texto dele, copiados da tabela (ex.: "O2 – Identificar…").</p>
    <div class="av-mod-form">
      <label class="av-campo"><span>Disciplina</span><select id="av-mod-disc">${discs.map(d => `<option value="${esc(d.id)}">${esc(d.nome)}</option>`).join('')}</select></label>
      <label class="av-campo"><span>Bimestre</span><select id="av-mod-bim">${[1, 2].filter(b => !BIMESTRES_FECHADOS.includes(b)).map(b => `<option value="${b}" ${b === BIM_ABERTO ? 'selected' : ''}>${b}º bimestre</option>`).join('')}</select></label>
      <label class="av-campo"><span>Prova</span><select id="av-mod-prova"><option value="c1">1ª chamada</option><option value="c2">2ª chamada</option><option value="exame">Exame semestral</option></select></label>
      <button type="button" class="btn btn-primary av-btn" id="av-mod-baixar">Baixar o modelo</button>
      <p class="av-nota">Um arquivo para cada prova: baixe o modelo de cada uma e importe na própria prova, em Avaliações.</p>
    </div>` : '<p class="av-vazio">Você não aparece como professor(a) de nenhuma disciplina neste semestre no Edubox.</p>';
  const b = $('#av-mod-baixar');
  if (b) b.onclick = async () => {
    b.disabled = true; const t = b.textContent; b.textContent = 'Montando…';
    try { await baixar(`/banco-med-fatec/modelo/${encodeURIComponent($('#av-mod-disc').value)}?bimestre=${$('#av-mod-bim').value}&prova=${$('#av-mod-prova').value}&semestre=${encodeURIComponent(eu.semestre || '')}`); toast('Modelo baixado.'); }
    catch (e) { toast(e.message, 'erro'); } finally { b.disabled = false; b.textContent = t; }
  };
}
// "Corrigir tudo" com PRÉVIA (16/11/2026): nada muda sem a pessoa ver cada correção (antes → depois) e confirmar
async function corrigirPtTudo(btn) {
  const umaQ = btn.dataset.ptTudoQ, avId = btn.dataset.av || btn.dataset.ptTudoProva;
  const txt = btn.textContent; btn.disabled = true; btn.textContent = 'Preparando a prévia…';
  try {
    const r = await api(`${BASE}/${encodeURIComponent(avId)}/corrigir-pt/previa`, { method: 'POST', body: JSON.stringify({ ids: umaQ ? [umaQ] : [] }) });
    if (!r.itens.length) { toast('Não há correção automática para fazer.', 'aviso'); btn.disabled = false; btn.textContent = txt; return; }
    const total = r.itens.reduce((s, it) => s + it.campos.reduce((t, c) => t + c.mudancas.length, 0), 0);
    $('#av-conf-tit').textContent = 'Conferir as correções antes de aplicar';
    $('#av-conf-corpo').innerHTML = `
      <div class="av-pt-previa-topo"><p><b>${total}</b> correção(ões) em <b>${r.itens.length}</b> questão(ões). Confira o antes → depois. <b>Só as questões marcadas serão alteradas</b>; a alternativa correta e o resto da questão não mudam.</p>
        <div class="av-pt-previa-acoes"><button type="button" class="btn btn-primary av-btn" data-pt-aplicar="${esc(avId)}">Aplicar nas marcadas</button><button type="button" class="btn btn-secondary av-btn" data-pt-voltar>Voltar sem alterar</button></div></div>
      <ol class="av-pt-previa">${r.itens.map(it => `<li><label class="av-pt-previa-q"><input type="checkbox" data-pt-q="${esc(it.id)}" checked> <b>Questão ${it.numero}</b>${it.professor ? ` · ${esc(it.professor)}` : ''}</label>
        ${it.campos.map(c => `<div class="av-pt-previa-campo"><span class="av-conf-campo">${esc(c.campo)}</span><ul>${c.mudancas.map(m => `<li>${m.de ? `<del>${esc(m.de.trim())}</del> → <ins>${esc(String(m.para).trim())}</ins> ` : ''}<small>${esc(m.motivo)}</small></li>`).join('')}</ul></div>`).join('')}</li>`).join('')}</ol>`;
  } catch (e) { toast(e.message, 'erro'); btn.disabled = false; btn.textContent = txt; }
}
async function aplicarPtMarcadas(btn) {
  const ids = [...document.querySelectorAll('[data-pt-q]:checked')].map(c => c.dataset.ptQ);
  if (!ids.length) { toast('Marque ao menos uma questão.', 'aviso'); return; }
  btn.disabled = true; btn.textContent = 'Aplicando…';
  try {
    const r = await api(`${BASE}/${encodeURIComponent(btn.dataset.ptAplicar)}/corrigir-pt`, { method: 'POST', body: JSON.stringify({ ids }) });
    toast(r.message);
    if (confRecarregar) await confRecarregar();
  } catch (e) { toast(e.message, 'erro'); btn.disabled = false; btn.textContent = 'Aplicar nas marcadas'; }
}
// Botões "Baixar 2º bim – 1ª chamada", "Baixar 2º bim – 2ª chamada", "Baixar exame"... (17/11/2026): antes era um
// botão só, e o arquivo da 1ª chamada levava junto as questões de 2ª chamada/exame. Cada botão traz só um grupo;
// só aparece botão de grupo em que o professor tem questão. O container é preenchido depois do render.
const resumoXmlCache = new Map();
function botoesXmlHtml(id, classe, travarDaProva) {
  setTimeout(preencherBotoesXml);
  return `<div class="av-xml-botoes" data-xml-botoes="${esc(id)}" data-classe="${esc(classe)}" data-travar="${travarDaProva ? 1 : 0}"><span class="av-nota">Carregando os arquivos…</span></div>`;
}
function rotuloUsoXml(g, bim) {
  if (g.uso === 'exame') return 'Exame';
  if (g.uso === 'c1' || g.uso === 'c2') return `${bim ? `${bim}º bim – ` : ''}${g.rotulo}`;
  return g.rotulo;
}
async function preencherBotoesXml() {
  for (const box of document.querySelectorAll('[data-xml-botoes]:not([data-pronto])')) {
    box.dataset.pronto = '1';
    const id = box.dataset.xmlBotoes;
    try {
      if (!resumoXmlCache.has(id)) resumoXmlCache.set(id, api(`/banco-med-fatec/conferencia/${encodeURIComponent(id)}/xml?resumo=1`));
      const r = await resumoXmlCache.get(id);
      box.innerHTML = r.grupos.length
        ? r.grupos.map(g => `<button type="button" class="${esc(box.dataset.classe)}" data-prof-xml="${esc(id)}" data-uso="${esc(g.uso)}" ${g.daProva && box.dataset.travar === '1' ? 'disabled' : ''}>${ic('baixar')}Baixar ${esc(rotuloUsoXml(g, r.bimestre))} (${g.qtd})</button>`).join('')
        : '<span class="av-nota">Você ainda não tem questões para baixar.</span>';
    } catch (e) { resumoXmlCache.delete(id); box.innerHTML = `<span class="av-nota">${esc(e.message)}</span>`; }
  }
}
async function baixarXmlProfessor(id, btn) {
  const t = btn.innerHTML; btn.disabled = true; btn.textContent = 'Montando o arquivo…';
  try {
    const d = await api(`/banco-med-fatec/conferencia/${encodeURIComponent(id)}/xml${btn.dataset.uso ? `?uso=${encodeURIComponent(btn.dataset.uso)}` : ''}`);
    if (!d.grupos.length) { toast('Você ainda não tem questões nesta prova.', 'aviso'); return; }
    const grupos = [];
    for (const [gi, g] of d.grupos.entries()) grupos.push({ ...g, questoes: await prepararParaXml(g.questoes, `p${gi + 1}q`) });
    baixarTexto(window.MoodleXml.gerarMoodleXmlGrupos(grupos), d.nomeArquivo);
    toast(`Arquivo baixado (${d.grupos.map(g => `${g.questoes.length} de ${g.rotulo}`).join(', ')}).${d.publicadas ? ` ${d.publicadas} questão(ões) suas entraram no banco da disciplina.` : ''} No AVA: Banco de questões → Importar → Moodle XML.`);
    if (d.publicadas && atual && atual.avaliacao && atual.avaliacao.id === id) recarregarAtual();
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; btn.innerHTML = t; }
}
async function abrirDivisao(chaveAberta) {
  modalConf();
  confEditar = null;
  $('#av-conf-tit').textContent = 'Divisão das questões';
  $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Carregando…</p>';
  try {
    const lista = (await api('/banco-med-fatec/divisao')).filter(d => d.souResponsavel);
    const d = lista.find(x => x.chave === chaveAberta) || lista[0];
    if (!d) { $('#av-conf-corpo').innerHTML = '<p class="av-vazio">Você não é responsável por nenhuma disciplina.</p>'; return; }
    $('#av-conf-corpo').innerHTML = `
      ${lista.length > 1 ? `<label class="av-campo"><span>Disciplina</span><select id="av-div-disc">${lista.map(x => `<option value="${esc(x.chave)}" ${x.chave === d.chave ? 'selected' : ''}>${esc(x.disciplina)}</option>`).join('')}</select></label>` : `<p class="av-conf-sub">${esc(d.disciplina)}</p>`}
      <p class="av-nota">Você é o professor responsável: defina quantas questões tem a prova e quantas cada colega faz. Vale para cada prova: 1ª chamada e 2ª chamada de cada bimestre e o exame semestral — todo professor deixa a sua parte pronta para as três. Dependência e adaptação não entram na conta.${d.divisaoPor ? ` Última divisão: ${esc(d.divisaoPor)}, ${new Date(d.divisaoEm).toLocaleDateString('pt-BR')}.` : ''}</p>
      <div class="av-mc-qtd">
        <label class="av-campo"><span>Questões por prova</span><input type="number" id="av-mc-total" class="av-input" min="0" max="300" value="${d.qtdQuestoes || ''}" placeholder="ex.: 20"></label>
        <button type="button" class="btn btn-secondary av-btn" data-dividir>Dividir igualmente</button>
      </div>
      <div class="av-mc-profs">${d.professores.map(n => `<label class="av-mc-prof">${chipProfessor(n)}<input type="number" class="av-input av-mc-prof-n" data-prof="${esc(n)}" min="0" max="300" value="${(d.porProfessor || {})[n] || ''}" placeholder="0" aria-label="Questões de ${esc(n)}"></label>`).join('')}</div>
      <p class="av-nota" id="av-mc-soma"></p>
      <h3 class="av-mc-h">Unidades trabalhadas em cada bimestre</h3>
      ${(d.unidades || []).length ? `<p class="av-nota">Se uma unidade do 1º bimestre precisou ser trabalhada no 2º (ou o contrário), mude aqui. Vale para as provas, a lista de unidades das questões e o modelo do Word.</p>
      <table class="av-mc-tab av-div-unid"><thead><tr><th>Unidade</th><th>CH</th><th>Bimestre</th></tr></thead>
      <tbody>${d.unidades.map(u => `<tr><td><b>Unidade ${u.numero}</b><small>${esc(u.titulo)}</small></td><td>${u.ch}h</td>
        <td><select class="av-div-bim" data-u="${u.numero}" aria-label="Bimestre da unidade ${u.numero}"><option value="1" ${u.bimestre === 1 ? 'selected' : ''}>1º</option><option value="2" ${u.bimestre === 2 ? 'selected' : ''}>2º</option></select>${u.bimestre !== u.bimestrePlano ? '<small class="av-div-mudou">mudou do plano</small>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="av-nota">O plano de ensino desta disciplina não está no Edubox.</p>'}
      <h3 class="av-mc-h">Avisos de equilíbrio da prova</h3>
      <p class="av-nota">O Órbita calcula quantas questões cada unidade deveria ter, proporcional à carga horária dela, e avisa quando a prova foge disso. São só avisos; não impedem finalizar.</p>
      <div class="av-campos3">
        <label class="av-campo"><span>Caso clínico: no mínimo (% da prova)</span><input type="number" id="av-div-caso" class="av-input" min="0" max="100" value="${d.limites.minCaso}"></label>
        <label class="av-campo"><span>Unidade com poucas questões: avisar abaixo de (% do esperado)</span><input type="number" id="av-div-abaixo" class="av-input" min="0" max="100" value="${d.limites.abaixo}"></label>
        <label class="av-campo"><span>Unidade com questões demais: avisar acima de (% do esperado)</span><input type="number" id="av-div-acima" class="av-input" min="100" max="500" value="${d.limites.acima}"></label>
      </div>
      <p class="av-nota">Exemplo: numa prova de 20 questões, se a carga horária pede 8 para a Unidade 2, com 50% o aviso aparece se ela tiver menos de 4 questões, e com 175% se passar de 14. Padrão: ${d.padraoLimites.minCaso}%, ${d.padraoLimites.abaixo}% e ${d.padraoLimites.acima}%.</p>
      <div class="av-div-acoes"><button type="button" class="btn btn-primary av-btn" id="av-div-salvar">Salvar</button><button type="button" class="btn btn-secondary av-btn" id="av-div-prog">Ver o que cada um já fez</button></div>`;
    resumoCotas();
    const corpo = $('#av-conf-corpo');
    corpo.oninput = (e) => { if (e.target.matches('#av-mc-total, .av-mc-prof-n')) resumoCotas(); };
    corpo.onclick = (e) => {
      if (e.target.closest('[data-dividir]')) {
        const qtd = Number($('#av-mc-total').value) || 0; const ins = [...document.querySelectorAll('.av-mc-prof-n')];
        if (!qtd || !ins.length) { toast('Informe quantas questões tem a prova.', 'aviso'); return; }
        ins.forEach((inp, i) => { inp.value = Math.floor(qtd / ins.length) + (i < qtd % ins.length ? 1 : 0); }); resumoCotas();
      }
    };
    const sel = $('#av-div-disc'); if (sel) sel.onchange = () => abrirDivisao(sel.value);
    $('#av-div-salvar').onclick = async () => {
      const porProfessor = {}; document.querySelectorAll('.av-mc-prof-n').forEach(i => { if (Number(i.value) > 0) porProfessor[i.dataset.prof] = Number(i.value); });
      const bimestres = {}; document.querySelectorAll('.av-div-bim').forEach(s => { bimestres[s.dataset.u] = Number(s.value); });
      try { const r = await api(`/banco-med-fatec/divisao/${encodeURIComponent(d.chave)}`, { method: 'PUT', body: JSON.stringify({ qtdQuestoes: Number($('#av-mc-total').value) || null, porProfessor, limites: { minCaso: $('#av-div-caso').value, abaixo: $('#av-div-abaixo').value, acima: $('#av-div-acima').value }, ...(document.querySelector('.av-div-bim') ? { bimestres } : {}) }) }); toast(r.message); }
      catch (e) { toast(e.message, 'erro'); }
    };
    $('#av-div-prog').onclick = () => abrirProgresso(d.chave, `/banco-med-fatec/divisao/${encodeURIComponent(d.chave)}/progresso`);
  } catch (e) { $('#av-conf-corpo').innerHTML = `<p class="av-vazio">${esc(e.message)}</p>`; }
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
    try { meuPapel = await api(`${BASE}/eu`); liberado = true; }
    catch (e) {
      if (/Só a responsável|nível de acesso suficiente|Não encontrei disciplinas suas/i.test(e.message)) return false;
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
          ${BIMESTRES_FECHADOS.length ? '<button type="button" class="av-link" id="av-ver-fechados" aria-pressed="false">Mostrar 1º bimestre</button>' : ''}
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
    if (t.id === 'av-ver-fechados') { verFechados = !verFechados; t.setAttribute('aria-pressed', String(verFechados)); t.textContent = verFechados ? 'Esconder 1º bimestre' : 'Mostrar 1º bimestre'; return renderGrade(); }
    if (t.dataset.progresso) return abrirProgresso(t.dataset.progresso);
    if (t.dataset.divisao) return abrirDivisao(t.dataset.divisao);
    if (t.dataset.profXml) return baixarXmlProfessor(t.dataset.profXml, t);
    if (t.dataset.ptTudoQ || t.dataset.ptTudoProva) {
      modalConf();
      confRecarregar = async () => { await recarregarAtual(); const m = $('#av-conf'); if (m) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); } };
      return corrigirPtTudo(t);
    }
    if (t.dataset.criar) return criarAvaliacao(t.dataset.criar, Number(t.dataset.bim), Number(t.dataset.ch), t.dataset.tipo);
    if (t.dataset.abrir) return abrirAvaliacao(t.dataset.abrir);
    if (t.hasAttribute('data-voltar')) return voltarGrade();
    if (t.hasAttribute('data-nova')) return abrirQuestao(null);
    if (t.hasAttribute('data-importar')) return abrirImportar();
    if (t.hasAttribute('data-banco')) return abrirBanco();
    if (t.dataset.editar) return abrirQuestao(t.dataset.editar);
    if (t.dataset.retirar) return retirarQuestao(t.dataset.retirar);
    if (t.hasAttribute('data-sel-todas')) { atual.questoes.forEach(q => selecionadas.add(q.id)); confirmandoApagar = false; return atualizarSelecao(); }
    if (t.hasAttribute('data-sel-limpar') || t.hasAttribute('data-apagar-cancelar')) { selecionadas = new Set(); confirmandoApagar = false; return atualizarSelecao(); }
    if (t.hasAttribute('data-apagar-sel')) { confirmandoApagar = true; return atualizarSelecao(); }
    if (t.hasAttribute('data-apagar-sim')) return apagarSelecionadas();
    if (t.dataset.subir) return moverQuestao(t.dataset.subir, -1);
    if (t.dataset.descer) return moverQuestao(t.dataset.descer, 1);
    if (t.hasAttribute('data-finalizar')) return finalizar();
    if (t.hasAttribute('data-reabrir')) return reabrir();
    if (t.hasAttribute('data-excluir-av')) return excluirAvaliacao();
    if (t.hasAttribute('data-xml')) return baixarXml();
    if (t.hasAttribute('data-xml-como-esta')) return baixarXml(true);
    if (t.hasAttribute('data-conferir')) return conferirProvaAberta();
    if (t.hasAttribute('data-relatorio-cadam')) return abrirRelatorioCadam();
    if (t.dataset.fp !== undefined) { filtroProfessor = t.dataset.fp; renderEditor(); }
    if (t.dataset.criterios) return abrirCriterios(t.dataset.criterios, carregarGrade);
    if (t.hasAttribute('data-criterios-av')) return abrirCriterios(atual.avaliacao.chave, recarregarAtual);
  });
  // marcações "subi no AVA" / "coloquei no questionário" dentro da prova
  view.addEventListener('change', async (e) => {
    const s = e.target.closest('[data-sel-q]');
    if (s) { if (s.checked) selecionadas.add(s.dataset.selQ); else selecionadas.delete(s.dataset.selQ); confirmandoApagar = false; return atualizarSelecao(); }
    const c = e.target.closest('[data-envio]'); if (!c) return;
    c.disabled = true;
    try { const r = await api(`/banco-med-fatec/conferencia/${encodeURIComponent(c.dataset.av)}/envio`, { method: 'PUT', body: JSON.stringify({ etapa: c.dataset.envio, feito: c.checked }) }); toast(r.message); await recarregarAtual(); }
    catch (err) { c.checked = !c.checked; c.disabled = false; toast(err.message, 'erro'); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['#av-modal-q', '#av-modal-imp', '#av-modal-banco'].forEach(s => { const m = $(s); if (m && !m.hidden) { m.hidden = true; document.body.classList.remove('av-sem-rolagem'); } });
  });
  return meuPapel;
}
export function abrirAbaAvaliacoes() { if (!carregouGrade && !atual) carregarGrade(); }
