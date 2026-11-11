// Página do professor (10/11/2026): abre pelo link que o coordenador gerou no Banco de Provas, sem login.
// Cola as questões (ou manda o Word) → prévia em forma de folha de prova → marca a resposta certa na
// bolinha → envia. As questões caem na Revisão de Importação do curso.
(function () {
  'use strict';
  const API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.hostname.startsWith('192.168.'))
    ? `http://${location.hostname}:3000/api` : '/api';
  const LETRAS = ['A', 'B', 'C', 'D', 'E'];
  const P = window.ParseLinhas;
  const token = new URLSearchParams(location.search).get('t') || '';
  const chaveRascunho = `eq-rascunho-${token}`;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lerLocal = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const gravarLocal = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } };

  let link = null;
  let nAlt = 5;
  let nAltEscolhido = false;    // o professor mexeu no 4/5 → não adivinha mais
  let questoes = [];            // resultado da leitura
  const marcas = new Map();     // chave da questão → letra marcada na bolinha
  let enviando = false;

  const chaveQ = (q) => `${q.tipo}|${(q.enunciado || '').slice(0, 80)}`;
  const dataBR = (iso) => { const [a, m, d] = String(iso || '').slice(0, 10).split('-'); return d ? `${d}/${m}/${a}` : ''; };
  // nome cadastrado em MAIÚSCULAS vira "Ética e Exercícios Profissionais em Medicina Veterinária"
  const nomeBonito = (n) => {
    const t = String(n || '').trim();
    if (t !== t.toUpperCase()) return t;
    return t.toLowerCase().replace(/(^|[\s(\/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/(?!^)\b(De|Da|Do|Das|Dos|E|Em|No|Na|Nos|Nas|Ao|Aos|À|Às|A|O|Para|Por|Com)\b/g, (x) => x.toLowerCase())
      .replace(/\b(Ii|Iii|Iv|Vi|Vii|Viii|Ix)\b/g, (x) => x.toUpperCase());
  };
  const diasAte = (iso) => Math.round((new Date(iso + 'T23:59:59') - new Date()) / 86400000);

  async function api(caminho, opts = {}) {
    const r = await fetch(API + caminho, { ...opts, headers: { 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Não foi possível concluir agora.'); e.status = r.status; e.dados = j; throw e; }
    return j;
  }

  // ---------- telas ----------
  function telaAviso(titulo, texto, extra = '') {
    $('eq-app').innerHTML = `<section class="eq-aviso"><h1>${esc(titulo)}</h1><p>${texto}</p>${extra}</section>`;
  }

  function cabecalhoLink() {
    const dias = diasAte(link.prazo);
    const prazoTxt = dias <= 0 ? 'vence hoje' : dias === 1 ? 'vence amanhã' : `faltam ${dias} dias`;
    const meta = [link.cursoNome, link.periodo ? `${link.periodo}º período` : '', link.chamada === 'exame' ? 'Exame' : `${link.bimestre}º bimestre · ${link.chamadaRotulo}`, `semestre ${String(link.semestre).replace('.', '/')}`].filter(Boolean);
    return `
      <section class="eq-pedido">
        <div class="eq-pedido-texto">
          <p class="eq-pedido-para">${link.professorNome ? `Prof. ${esc(link.professorNome)}, o` : 'O'} coordenador${link.coordenadorNome ? ` ${esc(link.coordenadorNome)}` : ''} pediu as questões de</p>
          <h1 class="eq-disciplina">${esc(nomeBonito(link.disciplinaNome))}</h1>
          <p class="eq-meta">${meta.map(esc).join('<span aria-hidden="true"> / </span>')}</p>
        </div>
        <div class="eq-prazo ${dias <= 1 ? 'urgente' : ''}">
          <span class="eq-prazo-rot">Prazo</span>
          <b>${dataBR(link.prazo)}</b>
          <span>${prazoTxt}</span>
        </div>
      </section>
      ${link.questoesEnviadas ? `<p class="eq-ja-enviou">Você já enviou <b>${link.questoesEnviadas}</b> ${link.questoesEnviadas === 1 ? 'questão' : 'questões'} por este link. Pode enviar mais, se quiser.</p>` : ''}`;
  }

  function telaPrincipal() {
    const rasc = lerLocal(chaveRascunho) || '';
    $('eq-app').innerHTML = `
      ${cabecalhoLink()}
      <div class="eq-grade">
        <section class="eq-col eq-col-texto" aria-labelledby="eq-passo1">
          <div class="eq-passo-topo">
            <h2 id="eq-passo1"><span class="eq-n" aria-hidden="true">1</span>Cole as suas questões</h2>
            <label class="eq-arquivo">
              <input type="file" id="eq-arquivo" accept=".docx,.doc,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6M9 15l3-3 3 3"/></svg>
              Abrir arquivo Word
            </label>
          </div>
          <p class="eq-ajuda">Copie do Word, PDF ou Google Docs e cole aqui. Numere as questões (<code>1)</code>, <code>2.</code> ou <code>Questão 3</code>) e deixe cada alternativa numa linha.</p>
          <div class="eq-alts" role="radiogroup" aria-label="Alternativas por questão">
            <span>Alternativas por questão</span>
            <button type="button" class="eq-alt-btn" data-n="4" role="radio">4 <small>(A a D)</small></button>
            <button type="button" class="eq-alt-btn" data-n="5" role="radio">5 <small>(A a E)</small></button>
          </div>
          <textarea id="eq-texto" spellcheck="false" aria-label="Texto das questões" placeholder="1) Qual estrutura do néfron é responsável pela filtração do sangue?
a) Alça de Henle
b) Glomérulo
c) Túbulo contorcido distal
d) Ducto coletor
e) Túbulo contorcido proximal

2) ...">${esc(rasc)}</textarea>
          <details class="eq-dicas">
            <summary>Dicas para o texto ser lido certinho</summary>
            <ul>
              <li>Se quiser, escreva <code>Gabarito: B</code> embaixo da questão. A bolinha já vem marcada.</li>
              <li>Questões dissertativas: escreva <code>QUESTÕES DISSERTATIVAS</code> numa linha antes delas e numere de novo a partir de 1.</li>
              <li>Imagens e tabelas não passam pelo texto. Avise o coordenador para incluir na revisão.</li>
            </ul>
          </details>
        </section>

        <section class="eq-col eq-col-folha" aria-labelledby="eq-passo2">
          <div class="eq-passo-topo">
            <h2 id="eq-passo2"><span class="eq-n" aria-hidden="true">2</span>Confira e marque a resposta certa</h2>
            <span id="eq-contagem" class="eq-contagem"></span>
          </div>
          <div id="eq-folha" class="eq-folha"></div>
        </section>
      </div>

      <section class="eq-envio" aria-labelledby="eq-passo3">
        <h2 id="eq-passo3" class="eq-sr"><span class="eq-n">3</span>Enviar</h2>
        <label class="eq-nome">Seu nome
          <input type="text" id="eq-nome" maxlength="120" autocomplete="name" value="${esc(link.professorNome || lerLocal('eq-nome') || '')}">
        </label>
        <p id="eq-status" class="eq-status"></p>
        <button type="button" id="eq-enviar" class="eq-btn-enviar" disabled>Enviar questões</button>
      </section>`;

    marcarAlt(nAlt);
    document.querySelectorAll('.eq-alt-btn').forEach(b => b.addEventListener('click', () => { nAltEscolhido = true; marcarAlt(Number(b.dataset.n)); ler(); }));
    let t;
    $('eq-texto').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { gravarLocal(chaveRascunho, $('eq-texto').value || null); ler(); }, 250); });
    $('eq-folha').addEventListener('click', (e) => {
      const b = e.target.closest('[data-marcar]');
      if (!b) return;
      const q = questoes[Number(b.dataset.q)];
      marcas.set(chaveQ(q), b.dataset.marcar);
      desenharFolha();
    });
    $('eq-arquivo').addEventListener('change', abrirWord);
    $('eq-enviar').addEventListener('click', enviar);
    $('eq-nome').addEventListener('input', atualizarRodape);
    ler();
  }

  function marcarAlt(n) {
    nAlt = n;
    document.querySelectorAll('.eq-alt-btn').forEach(b => { const on = Number(b.dataset.n) === n; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  }

  // ---------- leitura ----------
  function ler() {
    const texto = $('eq-texto').value;
    if (!nAltEscolhido && texto.trim()) marcarAlt(P.palpiteAlternativas(texto));
    questoes = texto.trim() ? P.parseTexto(texto, nAlt).filter(q => !q.vazia) : [];
    // "Gabarito: X" escrito no texto entra como marcação (se o professor ainda não clicou noutra)
    questoes.forEach(q => { if (q.gabarito && !marcas.has(chaveQ(q))) marcas.set(chaveQ(q), q.gabarito); });
    desenharFolha();
  }

  function desenharFolha() {
    const folha = $('eq-folha');
    if (!questoes.length) {
      const temTexto = $('eq-texto').value.trim();
      folha.innerHTML = `<div class="eq-folha-vazia">${temTexto
        ? '<b>Ainda não achei questões numeradas.</b><span>Comece cada questão com o número: <code>1)</code>, <code>1.</code>, <code>1 -</code> ou <code>Questão 1</code>.</span>'
        : '<b>A prévia aparece aqui.</b><span>Cole as questões ao lado e confira como elas vão chegar ao coordenador.</span>'}</div>`;
      atualizarRodape();
      return;
    }
    let numDissert = 0;
    folha.innerHTML = questoes.map((q, i) => {
      if (q.erro) return `<article class="eq-q erro"><p class="eq-q-erro"><b>Questão ${q.numero}:</b> não achei ${nAlt} alternativas depois do enunciado.</p><p class="eq-q-dica">Confira se cada alternativa está numa linha e se todas as ${nAlt} estão lá. Se a prova tem ${nAlt === 5 ? 4 : 5} alternativas, troque ali em cima.</p></article>`;
      if (q.tipo === 'dissertativa') {
        numDissert++;
        return `<article class="eq-q dissert"><header><span class="eq-q-num">${q.numero}</span><span class="eq-q-tipo">dissertativa</span></header><p class="eq-q-enun">${esc(q.enunciado)}</p></article>`;
      }
      const marcada = marcas.get(chaveQ(q));
      return `<article class="eq-q ${marcada ? 'ok' : 'falta'}">
        <header><span class="eq-q-num">${q.numero}</span>${marcada ? `<span class="eq-q-gab">resposta ${marcada}</span>` : '<span class="eq-q-pend">marque a resposta</span>'}</header>
        <p class="eq-q-enun">${esc(q.enunciado)}</p>
        <ol class="eq-q-alts" role="radiogroup" aria-label="Resposta certa da questão ${q.numero}">
          ${q.alternativas.map((a, j) => `<li><button type="button" class="eq-bolha ${marcada === LETRAS[j] ? 'on' : ''}" data-q="${i}" data-marcar="${LETRAS[j]}" role="radio" aria-checked="${marcada === LETRAS[j]}" aria-label="Marcar ${LETRAS[j]} como certa">${LETRAS[j]}</button><span>${esc(a)}</span></li>`).join('')}
        </ol>
        ${(q.avisoAlternativas || []).length ? `<p class="eq-q-dica">A ordem das letras no seu texto não bate com a posição. Confira as alternativas.</p>` : ''}
      </article>`;
    }).join('');
    atualizarRodape();
  }

  function resumo() {
    const validas = questoes.filter(q => !q.erro);
    const objetivas = validas.filter(q => q.tipo !== 'dissertativa');
    return {
      total: validas.length, erros: questoes.filter(q => q.erro).length,
      semGab: objetivas.filter(q => !marcas.get(chaveQ(q))).length,
      dissert: validas.length - objetivas.length
    };
  }

  function atualizarRodape() {
    const r = resumo();
    const cont = $('eq-contagem');
    if (cont) cont.textContent = r.total ? `${r.total} ${r.total === 1 ? 'questão' : 'questões'}${r.dissert ? ` (${r.dissert} dissertativa${r.dissert > 1 ? 's' : ''})` : ''}` : '';
    const st = $('eq-status');
    const nome = ($('eq-nome') && $('eq-nome').value.trim()) || '';
    let msg = '', pronto = false;
    if (!r.total && !r.erros) msg = 'Cole as questões para começar.';
    else if (r.erros) msg = `${r.erros} ${r.erros === 1 ? 'questão precisa' : 'questões precisam'} de ajuste no texto (em vermelho).`;
    else if (r.semGab) msg = `Falta marcar a resposta de ${r.semGab} ${r.semGab === 1 ? 'questão' : 'questões'}.`;
    else if (!nome) msg = 'Escreva o seu nome para enviar.';
    else { msg = `Tudo certo: ${r.total} ${r.total === 1 ? 'questão pronta' : 'questões prontas'} para enviar.`; pronto = true; }
    if (st) { st.textContent = msg; st.classList.toggle('pronto', pronto); }
    const b = $('eq-enviar');
    if (b) { b.disabled = !pronto || enviando; b.textContent = enviando ? 'Enviando…' : r.total ? `Enviar ${r.total} ${r.total === 1 ? 'questão' : 'questões'}` : 'Enviar questões'; }
  }

  // ---------- Word → vira texto na caixa (fica tudo editável num lugar só) ----------
  async function abrirWord(e) {
    const arq = e.target.files[0];
    e.target.value = '';
    if (!arq) return;
    if (arq.size > 12 * 1024 * 1024) return mostrarErro('Arquivo grande demais (máx. 12 MB). Tente colar o texto.');
    const st = $('eq-status');
    st.textContent = `Lendo “${arq.name}”…`;
    try {
      const b64 = await new Promise((ok, falha) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = falha; fr.readAsDataURL(arq); });
      const r = await api(`/banco-provas/publico/link/${encodeURIComponent(token)}/analisar-docx`, { method: 'POST', body: JSON.stringify({ arquivoBase64: b64, alternativasPorQuestao: nAlt }) });
      if (!r.questoes.length) return mostrarErro('Não achei questões numeradas nesse arquivo. Tente copiar e colar o texto.');
      const linhas = [];
      let jaDissert = false;
      r.questoes.forEach(q => {
        if (q.tipo === 'dissertativa' && !jaDissert) { linhas.push('QUESTÕES DISSERTATIVAS', ''); jaDissert = true; }
        if (q.erro) { linhas.push(`${q.numero}) (confira esta questão no arquivo: faltou alternativa)`, ''); return; }
        linhas.push(`${q.numero}) ${q.enunciado}`);
        (q.alternativas || []).forEach((a, j) => linhas.push(`${LETRAS[j].toLowerCase()}) ${a}`));
        if (q.gabarito) linhas.push(`Gabarito: ${q.gabarito}`);
        linhas.push('');
      });
      const caixa = $('eq-texto');
      caixa.value = (caixa.value.trim() ? caixa.value.trim() + '\n\n' : '') + linhas.join('\n');
      gravarLocal(chaveRascunho, caixa.value);
      ler();
    } catch (err) {
      mostrarErro(err.message);
    }
  }

  function mostrarErro(msg) {
    const st = $('eq-status');
    st.textContent = msg;
    st.classList.remove('pronto');
    st.classList.add('erro');
    setTimeout(() => st.classList.remove('erro'), 6000);
  }

  // ---------- envio ----------
  async function enviar() {
    const r = resumo();
    if (r.erros || r.semGab || !r.total) return atualizarRodape();
    const nome = $('eq-nome').value.trim();
    gravarLocal('eq-nome', nome);
    enviando = true; atualizarRodape();
    try {
      const corpo = {
        professorNome: nome, alternativasPorQuestao: nAlt,
        questoes: questoes.filter(q => !q.erro).map(q => ({ tipo: q.tipo, enunciado: q.enunciado, alternativas: q.alternativas || null, gabarito: q.tipo === 'dissertativa' ? null : marcas.get(chaveQ(q)) }))
      };
      const res = await api(`/banco-provas/publico/link/${encodeURIComponent(token)}/enviar`, { method: 'POST', body: JSON.stringify(corpo) });
      gravarLocal(chaveRascunho, null);
      link.questoesEnviadas = res.questoesEnviadas;
      telaAviso('Questões enviadas',
        `<b>${res.total}</b> ${res.total === 1 ? 'questão foi enviada' : 'questões foram enviadas'} para ${link.coordenadorNome ? esc(link.coordenadorNome) : 'o coordenador'}, de <b>${esc(nomeBonito(link.disciplinaNome))}</b>. Agora é com a coordenação: ela confere e coloca no banco de provas.`,
        `<div class="eq-aviso-acoes"><button type="button" class="eq-btn-sec" id="eq-mais">Enviar mais questões</button></div>`);
      $('eq-mais').addEventListener('click', () => { questoes = []; marcas.clear(); telaPrincipal(); });
    } catch (err) {
      enviando = false;
      if (err.status === 410) return telaFechado(err.dados && err.dados.link, err.message);
      mostrarErro(err.message);
      atualizarRodape();
    } finally { enviando = false; }
  }

  function telaFechado(l, msg) {
    telaAviso(l && l.situacao === 'vencido' ? 'O prazo deste link terminou' : 'Este link não está mais aberto',
      `${esc(msg || '')}${l ? ` <br>Disciplina: <b>${esc(nomeBonito(l.disciplinaNome))}</b>${l.coordenadorNome ? ` · coordenador ${esc(l.coordenadorNome)}` : ''}.` : ''}`);
  }

  // ---------- início ----------
  (async () => {
    if (!P) return telaAviso('Não foi possível abrir', 'Atualize a página. Se continuar, avise o coordenador.');
    if (!token) return telaAviso('Link incompleto', 'Abra o endereço completo que o coordenador enviou (ele termina com <code>?t=</code> e um código).');
    try {
      link = await api(`/banco-provas/publico/link/${encodeURIComponent(token)}`);
      document.title = `${nomeBonito(link.disciplinaNome)} · Enviar questões`;
      if (link.situacao !== 'aberto') return telaFechado(link, link.situacao === 'vencido' ? 'Peça ao coordenador para abrir um novo.' : 'O coordenador desativou este link.');
      telaPrincipal();
    } catch (err) {
      telaAviso('Não foi possível abrir o link', esc(err.message));
    }
  })();
})();
