// ================================================================
//  BANCO MED-FATEC — aba ENVIO AO AVA (25/11/2026)
//  Para a secretaria / coordenação: o professor termina no Órbita e o agente automático (droplet,
//  scripts/ava-banco-med-agente.js) leva para o banco de questões do AVA o que está pronto
//  (parte do professor que cumpriu a cota, ou prova finalizada). Aqui se acompanha, pede "Enviar agora",
//  baixa o arquivo do que está pronto (se precisar importar à mão) e registra "já está no AVA".
//  Rotas: src/rotas/banco-med-avaliacoes.js (/envio-ava). Regra da fila: src/utils/banco-med-ava-fila.js
// ================================================================
import { prepararParaXml, toast, ic, abrirProvaParaTrazer } from "./avaliacoes.js?v=51";

const BASE = '/banco-med-fatec/avaliacoes/envio-ava';
let api, esc;
let dados = null;
let filtro = 'acao';
let carregando = false;
let jaEscolheu = false; // a pessoa já clicou num filtro
let confirmando = null; // id da prova com "Já está no AVA" aberto para confirmar

const $ = (s, el = document) => el.querySelector(s);
const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const SITUACAO = {
  pronta: { rotulo: 'Pronta para o AVA', cls: 'ea-s-pronta' },
  conferir: { rotulo: 'Conferir', cls: 'ea-s-conferir' },
  erro: { rotulo: 'Erro no envio', cls: 'ea-s-conferir' },
  no_ava: { rotulo: 'No AVA', cls: 'ea-s-ok' },
  aguardando: { rotulo: 'Aguardando professor', cls: 'ea-s-espera' },
  vazia: { rotulo: 'Sem questões', cls: 'ea-s-espera' }
};
// prova com questões postas direto no AVA (fora do Órbita) — 26/11/2026
const temNoAva = (p) => !!(p.ava && p.ava.quadro && !p.ava.quadro.erro && p.ava.quadro.noQuestionario > 0);
const diretoNoAva = (p) => !!(p.ava && p.ava.quadro && !p.ava.quadro.erro && p.ava.quadro.noQuestionario > 0 && p.ava.quadro.direto > 0);
const FILTROS = [
  ['direto', 'Direto no AVA', diretoNoAva],
  ['acao', 'Precisa de atenção', p => ['conferir', 'erro'].includes(p.situacao)],
  ['pronta', 'Prontas', p => p.situacao === 'pronta'],
  ['aguardando', 'Aguardando professor', p => p.situacao === 'aguardando'],
  ['no_ava', 'No AVA', p => p.situacao === 'no_ava'],
  ['todas', 'Todas', p => p.situacao !== 'vazia' || temNoAva(p)]
];

export function configurarEnvioAva(opcoes) { ({ apiFetch: api, esc } = opcoes); }

export async function abrirEnvioAva() {
  const el = $('#bmf-view-envio-ava');
  if (!dados) el.innerHTML = '<div class="av-carregando"><span class="av-spin"></span>Carregando o envio ao AVA…</div>';
  await carregar();
}

async function carregar() {
  if (carregando) return;
  carregando = true;
  try {
    dados = await api(BASE);
    // começa no primeiro filtro que tem prova (26/11/2026: antes abria em "Prontas" vazio)
    if (!jaEscolheu) {
      const visiveis = dados.provas.filter(p => p.situacao !== 'vazia' || temNoAva(p));
      filtro = (['direto', 'acao', 'pronta', 'aguardando'].find(k => visiveis.some(FILTROS.find(f => f[0] === k)[2]))) || 'todas';
    }
    render();
  } catch (e) {
    $('#bmf-view-envio-ava').innerHTML = `<p class="av-vazio">Não consegui carregar o envio ao AVA: ${esc(e.message)}</p>`;
  } finally { carregando = false; }
}

function estadoAgente(a) {
  const vivo = a.vivoEm && (Date.now() - new Date(a.vivoEm).getTime()) < 15 * 60000;
  const u = a.ultimaRodada;
  const ultima = u ? (u.ok ? `Última conferência ${dataHora(u.em)}${u.resumo && (u.resumo.importada || u.resumo.ja_estava) ? `: ${u.resumo.importada || 0} prova(s) importada(s), ${u.resumo.ja_estava || 0} já estavam no AVA` : ''}.` : `Última tentativa ${dataHora(u.em)} falhou: ${esc(u.erro || '')}`) : 'Ainda não rodou.';
  const pedido = a.pedidoEm && (!u || a.pedidoEm > u.em) ? ` Pedido de ${esc(a.pedidoPorNome || 'alguém')} às ${dataHora(a.pedidoEm)}, aguardando.` : '';
  return vivo
    ? `<p class="ea-agente ea-agente-ok"><span class="ea-ponto"></span><span><b>Envio automático ligado</b> — confere a cada ${a.intervaloMin || 15} min. ${ultima}${pedido}</span></p>`
    : `<p class="ea-agente ea-agente-fora"><span class="ea-ponto"></span><span><b>Envio automático fora do ar.</b> As questões prontas não vão sozinhas: baixe o arquivo de cada prova e importe no AVA, ou avise o Suporte AVA. ${ultima}</span></p>`;
}

function professorHtml(p) {
  let estado, cls;
  if (p.noAva && !p.prontas && !p.aguardando) { estado = p.subiuSozinho ? 'no AVA (marcou que subiu)' : 'no AVA'; cls = 'ea-p-ok'; }
  else if (p.prontas) { estado = `${p.prontas} pronta(s)${p.noAva ? ` · ${p.noAva} no AVA` : ''}`; cls = 'ea-p-pronta'; }
  else {
    const falta = [];
    if (!p.meta) falta.push('sem cota: vai quando a prova for finalizada');
    else if (p.feitas < p.meta) falta.push(`${p.feitas} de ${p.meta} questões`);
    if (p.aCorrigir) falta.push(`${p.aCorrigir} a corrigir`);
    estado = falta.join(' · ') || 'aguardando'; cls = 'ea-p-espera';
  }
  return `<li class="ea-prof ${cls}"><b>${esc(p.nome)}</b><span>${p.feitas}${p.meta ? `/${p.meta}` : ''} questões · ${estado}</span></li>`;
}

// O questionário no AVA, lido pelo agente (25/11/2026): a Joyce decide pelo Órbita sem abrir o AVA.
// Avisa quando o questionário tem quantidade diferente da prova do Órbita ou quando a soma das notas não fecha a nota máxima.
const fmt = (n) => (n === null || n === undefined ? '–' : String(n).replace('.', ','));
// ---------- cartão da prova (26/11/2026: reorganizado para ler rápido) ----------
// Cabeçalho (disciplina, prova, situação) → três números lado a lado (Órbita · questionário do AVA · quem colocou)
// → UMA linha "O que fazer agora" com o botão certo → detalhes recolhidos (abertura, soma das notas, curso,
// professores). Antes era um bloco de texto com avisos repetidos.
function proximoPasso(p) {
  const q = (p.ava && p.ava.quadro) || null;
  const esperado = p.qtdProva || p.total;
  if (q && !q.erro && q.noQuestionario > 0 && q.direto > 0) {
    return { tom: 'atencao', txt: q.direto === q.noQuestionario
      ? `<b>Montada direto no AVA</b> (${q.direto} questões fora do Órbita). Traga para o Órbita para validar.`
      : `<b>${q.direto} questão(ões) postas direto no AVA</b>, fora do Órbita. Traga para validar.`,
      botao: p.status === 'finalizada' ? '' : `<button type="button" class="btn btn-primary av-btn" data-ea-trazer="${esc(p.id)}">${ic('importar')}Abrir e trazer do AVA</button>` };
  }
  if (['conferir', 'erro'].includes(p.situacao)) return { tom: 'erro', txt: `<b>O envio parou:</b> ${esc(p.ava.msg || (q && q.erro) || 'confira no AVA')}` };
  if (q && q.erro) return { tom: 'erro', txt: `<b>Não achei no AVA:</b> ${esc(q.erro)}` };
  if (p.situacao === 'pronta') return { tom: 'acao', txt: `<b>${p.prontas.length} questão(ões) prontas.</b> O envio automático leva sozinho; se estiver fora do ar, baixe e importe.` };
  if (p.total && q && q.noQuestionario !== esperado) return { tom: 'atencao', txt: q.noQuestionario ? `<b>O questionário tem ${q.noQuestionario} e a prova tem ${esperado}.</b> Confira as questões dentro do questionário no AVA.` : '<b>As questões ainda não foram colocadas dentro do questionário</b> (estão só no banco).' };
  if (q && q.noQuestionario && q.somaNotas !== q.notaMaxima) return { tom: 'atencao', txt: `<b>A soma das notas (${fmt(q.somaNotas)}) é diferente da nota máxima (${fmt(q.notaMaxima)}).</b> Ajuste no questionário do AVA.` };
  if (p.situacao === 'aguardando') {
    const faltam = p.professores.filter(x => x.aguardando || (x.meta && x.feitas < x.meta) || x.aCorrigir);
    return { tom: 'espera', txt: `<b>Aguardando professor:</b> ${faltam.length ? faltam.map(x => esc(x.nome.split(' ')[0])).join(', ') : 'questões da prova'}.` };
  }
  if (p.situacao === 'no_ava') return { tom: 'ok', txt: '<b>Tudo certo:</b> as questões estão no AVA.' };
  return { tom: 'espera', txt: 'Sem questões no Órbita ainda.' };
}
function provaHtml(p) {
  const s = SITUACAO[p.situacao] || SITUACAO.aguardando;
  const q = (p.ava && p.ava.quadro) || null;
  const passo = proximoPasso(p);
  const numero = (rot, val, sub, cls = '') => `<div class="ea-n ${cls}"><span>${rot}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const acoes = p.prontas.length ? (confirmando === p.id
    ? `<div class="ea-confirma" role="group" aria-label="Confirmar registro">
         <span>Registrar as <b>${p.prontas.length}</b> questão(ões) prontas como <b>já importadas</b> no AVA? Confira antes no banco do questionário.</span>
         <button type="button" class="btn btn-primary av-btn" data-ea-marcar="${esc(p.id)}">Sim, já estão no AVA</button>
         <button type="button" class="btn btn-secondary av-btn" data-ea-cancelar>Cancelar</button></div>`
    : `<button type="button" class="btn btn-secondary av-btn" data-ea-baixar="${esc(p.id)}">${ic('baixar')}Baixar arquivo (${p.prontas.length})</button>
       <button type="button" class="btn btn-secondary av-btn" data-ea-confirmar="${esc(p.id)}">${ic('ok')}Já está no AVA</button>`) : '';
  const temOrigem = q && !q.erro && q.direto !== undefined && q.noQuestionario;
  return `<li class="ea-prova ea-tom-${passo.tom}">
    <div class="ea-cab">
      <div><h3>${esc(p.disciplina)}</h3><p>${esc(p.prova)} · ${p.status === 'finalizada' ? 'prova finalizada' : 'prova em montagem'}</p></div>
      <span class="ea-sit ${s.cls}">${s.rotulo}</span>
    </div>
    <div class="ea-ns">
      ${numero('No Órbita', `${p.total}`, p.qtdProva && p.qtdProva !== p.total ? `prova de ${p.qtdProva}` : `${p.jaNoAva} já no AVA`)}
      ${numero('No questionário do AVA', q && !q.erro ? `${q.noQuestionario}` : '–', q && !q.erro ? `nota máx. ${fmt(q.notaMaxima)}` : 'não lido')}
      ${temOrigem ? numero('Quem colocou', `${q.pelaOrbita || 0} <i>Órbita</i> · ${q.direto} <i>direto</i>`, '', q.direto ? 'ea-n-alerta' : '') : ''}
    </div>
    <div class="ea-passo"><p>${passo.txt}</p><div class="ea-passo-acoes">${passo.botao || ''}${acoes}</div></div>
    <details class="ea-det"><summary>Ver detalhes</summary>
      ${p.ava.quiz ? `<p><b>No AVA:</b> ${esc(p.ava.curso)} › ${esc(p.ava.quiz)}</p>` : ''}
      ${q && !q.erro ? `<p>Soma das notas ${fmt(q.somaNotas)} · nota máxima ${fmt(q.notaMaxima)}${q.naPasta !== null && q.naPasta !== undefined ? ` · ${q.naPasta} na pasta do banco` : ''}</p>${q.abertura ? `<p>${esc(q.abertura)}</p>` : ''}<p class="ea-quadro-lido">Lido no AVA em ${dataHora(q.lidoEm)}</p>` : ''}
      ${p.professores.length ? `<ul class="ea-profs">${p.professores.map(professorHtml).join('')}</ul>` : ''}
    </details>
  </li>`;
}

function render() {
  const el = $('#bmf-view-envio-ava');
  // vazia no Órbita mas com questões no questionário do AVA (montada direto lá) também aparece — 26/11/2026
  const provas = dados.provas.filter(p => p.situacao !== 'vazia' || temNoAva(p));
  const contar = (f) => provas.filter(f).length;
  const f = FILTROS.find(x => x[0] === filtro) || FILTROS.find(x => x[0] === 'todas');
  const lista = provas.filter(f[2]);
  el.innerHTML = `
    <div class="ea">
      <header class="ea-topo">
        <div>
          <h2>Envio ao AVA · ${esc(dados.semestre)}</h2>
          <p class="av-nota">O professor termina no Órbita. Quando ele cumpre a parte dele (a cota da disciplina, com tudo no padrão) ou a prova é finalizada, as questões vão sozinhas para o banco de questões do questionário no AVA, na pasta disciplina / semestre / bimestre / chamada. Colocar as questões dentro do questionário continua sendo feito no AVA.</p>
        </div>
        <div class="ea-topo-acoes">
          <button type="button" class="btn btn-primary av-btn" data-ea-agora>Enviar agora</button>
          <button type="button" class="btn btn-secondary av-btn" data-ea-recarregar>Atualizar</button>
        </div>
      </header>
      ${estadoAgente(dados.agente)}
      <div class="ea-filtros" role="tablist" aria-label="Filtrar provas">
        ${FILTROS.map(([k, r, fn]) => `<button type="button" role="tab" aria-selected="${k === f[0]}" class="ea-filtro ${k === f[0] ? 'ativo' : ''}" data-ea-filtro="${k}">${r} <span>${contar(fn)}</span></button>`).join('')}
      </div>
      ${lista.length ? `<ul class="ea-lista">${lista.map(provaHtml).join('')}</ul>` : `<p class="av-vazio">Nenhuma prova em "${f[1]}".</p>`}
    </div>`;
}

async function baixarArquivo(id, btn) {
  const txt = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'Montando o arquivo…';
  try {
    const d = await api(`${BASE}/${encodeURIComponent(id)}/exportar`);
    const questoes = await prepararParaXml(d.questoes);
    questoes.forEach((q, i) => { if (d.questoes[i].imagemAntiga) q.imagem = { nome: `q${d.questoes[i].numero}-${String(d.questoes[i].imagemAntiga.nome).replace(/[^a-zA-Z0-9._-]+/g, '-')}`, dataUrl: d.questoes[i].imagemAntiga.dataUrl }; });
    const xml = window.MoodleXml.gerarMoodleXml(d.pasta, questoes.map((q, i) => ({ ...q, prefixoAva: d.prefixo, numeroAva: d.questoes[i].numero })));
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8' }));
    link.download = d.nomeArquivo;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    toast('Arquivo baixado. No AVA: abra o questionário → Banco de questões → Importar → Moodle XML. Depois clique em "Já está no AVA".');
  } catch (e) { toast(e.message, 'erro'); }
  finally { btn.disabled = false; btn.innerHTML = txt; }
}

export function iniciarEnvioAva(opcoes) {
  configurarEnvioAva(opcoes);
  document.getElementById('bmf-tab-envio-ava').hidden = false;
  const el = $('#bmf-view-envio-ava');
  el.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.eaFiltro) { filtro = b.dataset.eaFiltro; jaEscolheu = true; confirmando = null; render(); return; }
    if (b.hasAttribute('data-ea-recarregar')) { await carregar(); return; }
    if (b.hasAttribute('data-ea-cancelar')) { confirmando = null; render(); return; }
    if (b.dataset.eaConfirmar) { confirmando = b.dataset.eaConfirmar; render(); return; }
    if (b.dataset.eaBaixar) { await baixarArquivo(b.dataset.eaBaixar, b); return; }
    if (b.dataset.eaTrazer) { await abrirProvaParaTrazer(b.dataset.eaTrazer); return; }
    if (b.hasAttribute('data-ea-agora')) {
      b.disabled = true;
      try { const r = await api(`${BASE}/agora`, { method: 'POST' }); toast(r.message); setTimeout(carregar, 20000); await carregar(); }
      catch (e) { toast(e.message, 'erro'); } finally { b.disabled = false; }
      return;
    }
    if (b.dataset.eaMarcar) {
      const p = dados.provas.find(x => x.id === b.dataset.eaMarcar);
      b.disabled = true;
      try { const r = await api(`${BASE}/${encodeURIComponent(p.id)}/marcar`, { method: 'POST', body: JSON.stringify({ ids: p.prontas }) }); toast(r.message); confirmando = null; await carregar(); }
      catch (e) { toast(e.message, 'erro'); b.disabled = false; }
    }
  });
}
