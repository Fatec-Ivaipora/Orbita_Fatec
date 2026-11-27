// Portfólio MED — link do professor (27/11/2026), sem login. O token (?t=) é a autorização; o servidor só devolve os
// portfólios distribuídos para este professor (src/rotas/portfolio-med-publico.js). A nota é calculada pela MESMA matriz
// do Órbita (window.PortfolioMatriz) com o que a coordenação escolheu cobrar; o servidor recalcula ao gravar.
(function () {
  'use strict';
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.hostname.startsWith('192.168.');
  const API = (local && !/^300[0-2]$/.test(location.port) ? `http://${location.hostname}:3000/api` : '/api') + '/portfolio-publico';
  const token = new URLSearchParams(location.search).get('t') || '';
  const M = window.PortfolioMatriz;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f2 = (x) => (x == null ? '—' : String(Math.round(Number(x) * 100) / 100).replace('.', ','));
  const STATUS = { pendente: 'A corrigir', rascunho: 'Rascunho salvo', finalizada: 'Enviada' };
  const ROT = { O: 'Ótimo', B: 'Bom', DM: 'Deve melhorar', I: 'Insuficiente' };

  let lista = null;   // { professor, semestre, atividades }
  let corr = null;    // { dados, av, sujo }

  async function api(caminho, opts = {}) {
    const r = await fetch(API + '/' + encodeURIComponent(token) + caminho, { ...opts, headers: { 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || 'Não foi possível concluir agora.'), { faltando: j.faltando });
    return j;
  }
  function toast(msg, tipo = 'ok') {
    const t = $('pp-toast'); t.textContent = msg; t.className = `pp-toast pp-toast-${tipo}`; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 5000);
  }
  const aviso = (titulo, texto) => { $('pp-app').innerHTML = `<section class="pp-aviso"><h1>${esc(titulo)}</h1><p>${texto}</p></section>`; };
  const naDisc = (nota, valor) => (nota == null ? null : Math.round(Number(nota) * valor / 10 * 10 + 1e-9) / 10);

  // ------------------------------------------------------------ lista
  async function carregarLista() {
    try { lista = await api(''); } catch (e) { aviso('Não foi possível abrir', esc(e.message)); return; }
    $('pp-quem').textContent = `${lista.professor} · ${lista.semestre.replace('.', '/')}`;
    renderLista();
  }
  function renderLista() {
    corr = null;
    history.replaceState(null, '', `?t=${encodeURIComponent(token)}`);
    const todas = lista.atividades.flatMap(a => a.entregas);
    const env = todas.filter(e => e.status === 'finalizada').length;
    const pct = todas.length ? Math.round(env / todas.length * 100) : 0;
    if (!todas.length) { aviso(`Olá, ${lista.professor}`, 'Ainda não há portfólios distribuídos para você neste semestre. A coordenação de Medicina avisa quando distribuir.'); return; }
    $('pp-app').innerHTML = `
      <section class="pp-ola">
        <h1>Olá, ${esc(lista.professor)}</h1>
        <p>Você tem <b>${todas.length}</b> portfólio(s) para corrigir. Corrija no seu ritmo: salve o rascunho quando quiser e <b>envie</b> cada um quando terminar.</p>
        <div class="pp-prog" role="img" aria-label="${env} de ${todas.length} enviados"><i style="width:${pct}%"></i></div>
        <p class="pp-prog-txt"><b>${env}</b> de ${todas.length} enviados</p>
      </section>
      ${lista.atividades.map(a => `<section class="pp-grupo">
        <h2><span class="pp-turma">${esc(a.turma)}</span> ${esc(a.titulo)}${a.periodo ? ` <small>${a.periodo}º período</small>` : ''}</h2>
        ${a.tema ? `<p class="pp-dica">${esc(a.tema)}</p>` : ''}
        <ul class="pp-lista">${a.entregas.map(e => `<li>
          <button type="button" class="pp-item pp-st-${esc(e.status)}" data-abrir="${esc(e.id)}">
            <span class="pp-item-nome">${esc(e.nome)}</span>
            <span class="pp-chip">${STATUS[e.status] || e.status}</span>
            <span class="pp-item-nota">${e.status === 'finalizada' && e.nota != null ? `${f2(naDisc(e.nota, a.valorDisciplina))} / ${f2(a.valorDisciplina)}` : ''}</span>
            <span class="pp-item-ir" aria-hidden="true">${e.status === 'finalizada' ? 'Ver' : 'Corrigir'}</span>
          </button></li>`).join('')}</ul>
      </section>`).join('')}`;
  }

  // ------------------------------------------------------------ correção
  async function abrir(id) {
    $('pp-app').innerHTML = '<div class="pp-carregando"><span class="pp-spinner" aria-hidden="true"></span>Abrindo o portfólio…</div>';
    let d;
    try { d = await api(`/entregas/${encodeURIComponent(id)}`); } catch (e) { toast(e.message, 'erro'); renderLista(); return; }
    const objs = d.turma.objetivos || [];
    const base = d.entrega.avaliacao || {};
    const av = {
      c1: { nivel: null, justificativa: '', ...(base.c1 || {}) },
      c2: { analise: null, necessidades: false, acoes: false, nivelManual: null, justificativa: '', ...(base.c2 || {}) },
      c3: { justificativa: '', ...(base.c3 || {}), objetivos: objs.map((_, i) => !!(base.c3 && base.c3.objetivos && base.c3.objetivos[i])) },
      c4: { nivel: null, justificativa: '', ...(base.c4 || {}) },
      feedback: { fortes: '', desenvolver: '', recomendacao: '', analise: '', ...(base.feedback || {}) },
      conformidade: { capa: '', capaFaltando: [], formatacao: '', foraAva: false, obs: '', ...(base.conformidade || {}) },
      penalidade: base.penalidade || 'nenhuma'
    };
    corr = { dados: d, av, sujo: false, sugerida: false };
    if (!d.entrega.avaliacao) preencherPelaNotaDeCorte();
    history.replaceState(null, '', `?t=${encodeURIComponent(token)}#p=${encodeURIComponent(id)}`);
    renderCorrecao();
  }
  // nunca corrigido: começa pelas marcações da nota de corte (o professor confere e ajusta) — igual ao Órbita
  function preencherPelaNotaDeCorte() {
    const { dados, av } = corr;
    const ref = dados.entrega.referencia;
    const objs = dados.turma.objetivos || [];
    if (ref && ref.origem === 'claude' && !ref.semTexto && ref.niveis) {
      const ev = (id) => `Nota de corte: ${(ref.evidencias && ref.evidencias[id]) || ''}`;
      av.c1.nivel = ref.niveis.c1; av.c1.justificativa = ev('c1');
      Object.assign(av.c2, { analise: ref.c2.analise, necessidades: !!ref.c2.necessidades, acoes: !!ref.c2.acoes, nivelManual: ref.c2.nivelManual || null, justificativa: ev('c2') });
      av.c3.objetivos = objs.map((_, i) => !!(ref.c3.objetivos || [])[i]); av.c3.justificativa = ev('c3');
      av.c4.nivel = ref.niveis.c4; av.c4.justificativa = ev('c4');
      corr.sugerida = true; return;
    }
    if (!dados.texto || !window.PortfolioSugestao) return;
    const s = window.PortfolioSugestao.sugerir(dados.texto, objs);
    Object.assign(av.c1, { nivel: s.c1.nivel, justificativa: s.c1.justificativa });
    Object.assign(av.c2, { analise: s.c2.analise, necessidades: s.c2.necessidades, acoes: s.c2.acoes, nivelManual: s.c2.nivelManual || null, justificativa: s.c2.justificativa });
    av.c3.objetivos = objs.map((_, i) => !!s.c3.objetivos[i]); av.c3.justificativa = s.c3.justificativa;
    Object.assign(av.c4, { nivel: s.c4.nivel, justificativa: s.c4.justificativa });
    corr.sugerida = true;
  }
  const calc = () => M.calcular(corr.av, (corr.dados.turma.objetivos || []).length, corr.dados.atividade.matrizCobrar);

  function textoHtml(t) {
    if (!t.trim()) return '<p class="pp-aviso-in">Sem texto extraído (arquivo escaneado ou foto). Abra o arquivo original acima.</p>';
    return `<article class="pp-texto">${esc(t).split(/\[\[p\.(\d+)\]\]/).map((parte, k) => (k % 2 ? `<div class="pp-pag">página ${parte}</div>` : parte.replace(/\n/g, '<br>'))).join('')}</article>`;
  }
  function radios(c, valor, nome, trava) {
    return `<div class="pp-niveis">${M.NIVEIS.map(n => `<label class="pp-nivel pp-n-${n.toLowerCase()}"><input type="radio" name="${nome}" value="${n}" ${valor === n ? 'checked' : ''} ${trava}>
      <span><b>${M.NOME_NIVEL[n]}</b> <em>${f2(c.niveis[n].pts)} pt</em></span><small>${esc(c.niveis[n].descritor)}</small></label>`).join('')}</div>`;
  }
  const just = (id, v, ph, trava) => `<label class="pp-just">Evidência no texto (página/trecho) <span class="pp-obrig">obrigatória</span>
    <textarea data-campo="${id}.justificativa" rows="3" placeholder="${esc(ph)}" ${trava}>${esc(v || '')}</textarea></label>`;

  function renderCorrecao() {
    const { dados, av } = corr;
    const { entrega, turma, atividade } = dados;
    const enviada = entrega.status === 'finalizada';
    const trava = enviada ? 'disabled' : '';
    const rc = calc();
    const [c1, c2, c3, c4] = M.CRITERIOS;
    const objCob = rc.cobrar.objetivos;
    const ref = entrega.referencia;
    const valor = atividade.valorDisciplina || 3;
    const crit = (c, corpo) => {
      const x = rc.criterios[c.id];
      if (x.naoCobrado) return `<fieldset class="pp-crit pp-nao"><legend><span>${c.num}</span>${esc(c.nome)} <em>não cobrado nesta atividade</em></legend><p class="pp-dica">O valor deste critério foi distribuído entre os demais.</p></fieldset>`;
      return `<fieldset class="pp-crit" ${trava}><legend><span>${c.num}</span>${esc(c.nome)} <em>máx. ${f2(x.max)}</em></legend>${corpo}</fieldset>`;
    };
    $('pp-app').innerHTML = `
      <nav class="pp-volta"><button type="button" class="pp-link" data-voltar>‹ Voltar à minha lista</button></nav>
      <section class="pp-cab">
        <div><h1>${esc(entrega.nome)}</h1>
          <p class="pp-dica">${esc(turma.turma)}${turma.periodo ? ` · ${turma.periodo}º período` : ''} · ${esc(atividade.titulo)} · ${entrega.paginas || 0} pág. · ${entrega.palavras || 0} palavras</p></div>
        ${enviada ? '<span class="pp-chip pp-chip-ok">Enviada</span>' : ''}
      </section>
      <div class="pp-corr">
        <section class="pp-leitor" aria-label="Portfólio do estudante">
          ${entrega.avaArquivos.length ? `<div class="pp-arqs">${entrega.avaArquivos.map(a => `<a class="pp-btn pp-btn-peq" href="${API}/${encodeURIComponent(token)}/entregas/${encodeURIComponent(entrega.id)}/arquivo?c=${encodeURIComponent(a.caminho)}" target="_blank" rel="noopener">Abrir o arquivo: ${esc(a.nome || 'original')}</a>`).join('')}</div>` : ''}
          <details class="pp-turma-info"><summary>Questão norteadora e instruções da ${esc(turma.turma)}</summary>
            <blockquote>${esc(turma.questaoNorteadora)}</blockquote><ol>${(turma.instrucoes || []).map(x => `<li>${esc(x)}</li>`).join('')}</ol></details>
          ${textoHtml(dados.texto || '')}
        </section>
        <form class="pp-matriz" id="pp-matriz" autocomplete="off">
          ${ref && !ref.semTexto && ref.nota != null ? `<div class="pp-ref"><b>Nota de corte: ${f2(naDisc(ref.nota, valor))} de ${f2(valor)}</b> <small>(${f2(ref.nota)} na matriz de 10 · ${M.CRITERIOS.map(c => `C${c.num} ${ref.niveis && ref.niveis[c.id] ? ROT[ref.niveis[c.id]] : '—'}`).join(' · ')})</small>
            <small>É o ponto de partida, igual para todos os professores, e <b>não aparece para o aluno</b>. ${corr.sugerida && !enviada ? 'As marcações abaixo vieram dela: confira cada critério no texto e ajuste.' : ''} Se a sua nota ficar diferente, explique na análise interna.</small></div>` : ''}
          ${enviada ? '<p class="pp-aviso-in">Esta correção já foi enviada. Para mudar algo, peça à coordenação de Medicina para reabrir.</p>' : ''}
          ${crit(c1, `${radios(c1, av.c1.nivel, 'c1.nivel', trava)}${just('c1', av.c1.justificativa, 'Cite o trecho entre aspas ou a página.', trava)}`)}
          ${crit(c2, `<div class="pp-elem"><p><b>(a) Análise crítica</b></p>
            ${[['consistente', 'Consistente'], ['superficial', 'Superficial'], ['ausente', 'Ausente ou com incoerências graves']].map(([v, t]) => `<label class="pp-chk"><input type="radio" name="c2.analise" value="${v}" ${av.c2.analise === v ? 'checked' : ''} ${trava}> ${t}</label>`).join('')}
            <p><b>Os outros dois elementos</b></p>
            <label class="pp-chk"><input type="checkbox" name="c2.necessidades" ${av.c2.necessidades ? 'checked' : ''} ${trava}> (b) Identifica necessidades</label>
            <label class="pp-chk"><input type="checkbox" name="c2.acoes" ${av.c2.acoes ? 'checked' : ''} ${trava}> (c) Propõe ações</label></div>
            <div id="pp-c2-res" class="pp-res"></div>
            ${just('c2', av.c2.justificativa, 'Evidência dos 3 elementos.', trava)}`)}
          ${crit(c3, `<p class="pp-dica">Marque os objetivos que o portfólio <b>menciona, discute e atinge</b>.</p>
            <div class="pp-objs">${(turma.objetivos || []).map((o, k) => (objCob && !objCob.includes(k)
              ? `<label class="pp-chk pp-obj pp-obj-nao"><input type="checkbox" disabled><span><b>${k + 1}.</b> ${esc(o)} <em>(não cobrado)</em></span></label>`
              : `<label class="pp-chk pp-obj"><input type="checkbox" name="c3.obj" data-k="${k}" ${av.c3.objetivos[k] ? 'checked' : ''} ${trava}><span><b>${k + 1}.</b> ${esc(o)}</span></label>`)).join('')}</div>
            <div id="pp-c3-res" class="pp-res"></div>
            ${just('c3', av.c3.justificativa, 'Onde cada objetivo atingido aparece no texto.', trava)}`)}
          ${crit(c4, `${radios(c4, av.c4.nivel, 'c4.nivel', trava)}${just('c4', av.c4.justificativa, 'Coesão, estrutura e erros encontrados (com exemplos).', trava)}`)}
          <fieldset class="pp-crit" ${trava}><legend>Devolutiva ao estudante <em>sem frases genéricas: diga o critério, o objetivo, a página</em></legend>
            <label>Pontos fortes<textarea data-campo="feedback.fortes" rows="2">${esc(av.feedback.fortes)}</textarea></label>
            <label>Pontos a desenvolver<textarea data-campo="feedback.desenvolver" rows="2">${esc(av.feedback.desenvolver)}</textarea></label>
            <label>Recomendação prática<textarea data-campo="feedback.recomendacao" rows="2">${esc(av.feedback.recomendacao)}</textarea></label>
            <label>Análise do professor — <b>interna, não vai para o aluno</b> <span class="pp-obrig">obrigatória se a nota ficar diferente da nota de corte</span>
              <textarea data-campo="feedback.analise" rows="3" placeholder="Para a coordenação: o que você viu que a nota de corte não considerou (critério, página, trecho).">${esc(av.feedback.analise)}</textarea></label>
          </fieldset>
          <fieldset class="pp-crit" ${trava}><legend>Condições especiais <em>só se for o caso</em></legend>
            ${Object.entries(M.PENALIDADES).map(([k, p]) => `<label class="pp-chk"><input type="radio" name="penalidade" value="${k}" ${av.penalidade === k ? 'checked' : ''}> ${esc(p.rotulo)}</label>`).join('')}
          </fieldset>
          <div class="pp-total" id="pp-total"></div>
        </form>
      </div>`;
    atualizarTotal();
  }

  function lerForm() {
    const f = $('pp-matriz'); if (!f || !corr) return;
    const av = corr.av;
    const v = (n) => { const x = f.querySelector(`input[name="${n}"]:checked`); return x ? x.value : null; };
    if (f.querySelector('input[name="c1.nivel"]')) av.c1.nivel = v('c1.nivel');
    if (f.querySelector('input[name="c4.nivel"]')) av.c4.nivel = v('c4.nivel');
    if (f.querySelector('input[name="c2.analise"]')) {
      av.c2.analise = v('c2.analise');
      av.c2.necessidades = f.querySelector('input[name="c2.necessidades"]').checked;
      av.c2.acoes = f.querySelector('input[name="c2.acoes"]').checked;
      const man = f.querySelector('select[name="c2.nivelManual"]');
      if (man) av.c2.nivelManual = man.value || null;
    }
    f.querySelectorAll('input[name="c3.obj"]').forEach(c => { av.c3.objetivos[+c.dataset.k] = c.checked; });
    av.penalidade = v('penalidade') || 'nenhuma';
    f.querySelectorAll('[data-campo]').forEach(x => { const [a, b] = x.dataset.campo.split('.'); av[a][b] = x.value; });
  }
  function atualizarTotal() {
    const { dados } = corr;
    const enviada = dados.entrega.status === 'finalizada';
    const r = calc();
    const valor = dados.atividade.valorDisciplina || 3;
    const tag = (x) => (x.nivel ? `<span class="pp-tag pp-n-${x.nivel.toLowerCase()}">${M.NOME_NIVEL[x.nivel]} · ${f2(x.pts)} pt</span>` : '<span class="pp-tag">nível ainda não definido</span>');
    const r2 = $('pp-c2-res');
    if (r2) r2.innerHTML = r.criterios.c2.manual
      ? `<p class="pp-aviso-in">${esc(M.NOTA_C2)} Escolha: <select name="c2.nivelManual" ${enviada ? 'disabled' : ''}><option value="">—</option>${M.NIVEIS.map(n => `<option value="${n}" ${corr.av.c2.nivelManual === n ? 'selected' : ''}>${M.NOME_NIVEL[n]}</option>`).join('')}</select></p>`
      : `Nível pela matriz: ${tag(r.criterios.c2)}`;
    const r3 = $('pp-c3-res');
    if (r3) r3.innerHTML = `${r.criterios.c3.n} de ${r.criterios.c3.total} objetivos (${Math.round((r.criterios.c3.pct || 0) * 100)}%) → ${tag(r.criterios.c3)}`;
    $('pp-total').innerHTML = `
      <div class="pp-total-nota"><small>Nota</small><b>${f2(naDisc(r.nota, valor))}</b><small>de ${f2(valor)} · ${f2(r.nota)} na matriz de 10</small></div>
      ${enviada ? '' : `<div class="pp-total-acoes">
        ${r.completo ? '' : `<small class="pp-falta">${r.faltando.length} item(ns) pendente(s) para enviar</small>`}
        <button type="button" class="pp-btn" data-salvar>Salvar rascunho</button>
        <button type="button" class="pp-btn pp-btn-pri" data-enviar>Enviar correção</button></div>`}`;
  }
  async function salvar(finalizar) {
    lerForm();
    if (finalizar && !confirm('Enviar esta correção? Depois de enviada, só a coordenação consegue reabrir.')) return;
    const id = corr.dados.entrega.id;
    try {
      const r = await api(`/entregas/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ avaliacao: corr.av, finalizar }) });
      corr.sujo = false;
      const e = lista.atividades.flatMap(a => a.entregas).find(x => x.id === id);
      if (e) { e.status = r.status; e.nota = r.nota; }
      toast(r.message);
      if (finalizar) {
        const prox = lista.atividades.flatMap(a => a.entregas).find(x => x.status !== 'finalizada');
        if (prox && confirm('Enviada! Abrir o próximo portfólio que falta?')) abrir(prox.id); else renderLista();
      }
    } catch (err) {
      toast(err.faltando && err.faltando.length ? `${err.message} ${err.faltando.join(' · ')}` : err.message, 'erro');
    }
  }

  // ------------------------------------------------------------ eventos
  document.addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.abrir) { abrir(b.dataset.abrir); return; }
    if (b.hasAttribute('data-voltar')) { if (corr && corr.sujo && !confirm('Há alterações não salvas. Voltar mesmo assim?')) return; renderLista(); return; }
    if (b.hasAttribute('data-salvar')) salvar(false);
    if (b.hasAttribute('data-enviar')) salvar(true);
  });
  const mudou = (ev) => { if (!corr || !ev.target.closest('#pp-matriz')) return; corr.sujo = true; lerForm(); if (ev.type === 'change') atualizarTotal(); };
  document.addEventListener('input', mudou);
  document.addEventListener('change', mudou);
  window.addEventListener('beforeunload', (ev) => { if (corr && corr.sujo) { ev.preventDefault(); ev.returnValue = ''; } });

  if (!token) { aviso('Link incompleto', 'Abra o endereço inteiro que a coordenação de Medicina mandou para você.'); return; }
  const pedido = /#p=([\w-]+)/.exec(location.hash); // lido antes: a lista limpa o endereço
  carregarLista().then(() => { if (pedido && lista) abrir(decodeURIComponent(pedido[1])); });
})();
