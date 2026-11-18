// Unidades da disciplina EAD por link (18/11/2026), sem login.
//   ?t=<token do professor>    → o professor escolhe as unidades do catálogo SAGAH (nº, código, título) e envia
//   ?t=<token do coordenador>  → o coordenador do curso valida cada unidade (ou pede ajuste com observação)
// O tipo vem do próprio link. Servidor: src/rotas/automacao-ava.js (/publico/unidades/:token).
(function () {
  'use strict';
  // local: se a página veio do próprio servidor da API (porta 3000–3002), usa ele; senão (Live Server etc.), a 3000
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.hostname.startsWith('192.168.');
  const API = local && !/^300[0-2]$/.test(location.port) ? `http://${location.hostname}:3000/api` : '/api';
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lerLocal = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const gravarLocal = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } };
  // "BACHARELADO EM ARQUITETURA E URBANISMO" -> "Arquitetura e Urbanismo"; "... APLICADA À ARQUITETURA II" -> "... Aplicada à Arquitetura II"
  const nomeBonito = (n) => {
    const t = String(n || '').trim().replace(/^(BACHARELADO|LICENCIATURA|SUPERIOR DE TECNOLOGIA) EM /i, '');
    if (t !== t.toUpperCase()) return t;
    return t.toLowerCase().replace(/(^|[\s(\/-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
      .replace(/(?!^)(?<![\p{L}])(De|Da|Do|Das|Dos|E|Em|No|Na|Nos|Nas|Ao|Aos|À|Às|A|O|Para|Por|Com)(?![\p{L}])/gu, (x) => x.toLowerCase())
      .replace(/(?<![\p{L}])(Ii|Iii|Iv|Vi|Vii|Viii|Ix)(?![\p{L}])/gu, (x) => x.toUpperCase());
  };
  const dois = (n) => String(n).padStart(2, '0');
  const sem = (s) => String(s || '').replace('.', '/');

  let dados = null;
  const ocupado = new Set();

  async function api(caminho, opts = {}) {
    const r = await fetch(API + caminho, { ...opts, headers: { 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Não foi possível concluir agora.');
    return j;
  }
  const aviso = (titulo, texto) => { $('ua-app').innerHTML = `<section class="eq-aviso"><h1>${esc(titulo)}</h1><p>${texto}</p></section>`; };

  function situacao(u) {
    if (!u || !u.codigo) return '<span class="ua-sit vazio">Não preenchida</span>';
    const c = u.coord;
    if (c && c.status === 'ok') return '<span class="ua-sit ok">✓ Validada</span>';
    if (c && c.status === 'ajustar') return `<span class="ua-sit ajustar">Ajustar</span><span class="ua-obs">${esc(c.obs)}</span>`;
    if (c && c.status === 'reenviada') return `<span class="ua-sit esperando">Corrigida, aguardando validação</span><span class="ua-obs">Pedido: ${esc(c.obs)}</span>`;
    return '<span class="ua-sit esperando">Aguardando validação</span>';
  }
  function resumo(d) {
    const its = d.itens.filter(u => u.codigo);
    const ok = its.filter(u => u.coord && u.coord.status === 'ok').length;
    const aj = its.filter(u => u.coord && u.coord.status === 'ajustar').length;
    if (ok === d.qtd) return '<span class="ua-resumo ok">Todas validadas</span>';
    if (aj) return `<span class="ua-resumo alerta">${aj} para ajustar</span>`;
    return `<span class="ua-resumo">${its.length} de ${d.qtd} preenchidas · ${ok} validadas</span>`;
  }
  const metaDisc = (d) => [
    `<b>${esc(nomeBonito(d.cursoNome))}</b>`,
    d.periodos && d.periodos.length ? `${d.periodos.join('º, ')}º período` : '',
    d.chEad ? `${d.chEad} h EAD` : '',
    `${d.qtd} unidades`
  ].filter(Boolean).join(' · ');
  const linhaBim = (n, qtd) => (n === 1 ? `<tr class="ua-bim"><td colspan="4">1º BIMESTRE</td></tr>` : (n === qtd / 2 + 1 ? `<tr class="ua-bim"><td colspan="4">2º BIMESTRE</td></tr>` : ''));

  // ---------------- professor ----------------
  function rascunhoKey(d) { return `ua-${token}-${d.id}`; }
  function discProfessor(d) {
    const ras = lerLocal(rascunhoKey(d)) || {};
    const por = new Map(d.itens.map(u => [u.n, u]));
    let linhas = '';
    for (let n = 1; n <= d.qtd; n++) {
      const u = por.get(n) || { n };
      const trav = u.coord && u.coord.status === 'ok';
      const r = ras[n] || {};
      const cod = trav ? u.codigo : (r.codigo ?? u.codigo ?? '');
      const tit = trav ? u.titulo : (r.titulo ?? u.titulo ?? '');
      linhas += linhaBim(n, d.qtd) + `
        <tr data-n="${n}">
          <td class="ua-n">UA ${dois(n)}</td>
          <td class="ua-col-cod"><input inputmode="numeric" aria-label="Código SAGAH da UA ${dois(n)}" placeholder="Código" data-campo="codigo" value="${esc(cod)}" ${trav ? 'disabled' : ''}></td>
          <td><input aria-label="Título da UA ${dois(n)}" placeholder="Título da unidade no catálogo" data-campo="titulo" value="${esc(tit)}" ${trav ? 'disabled' : ''}></td>
          <td class="ua-col-sit">${situacao(u)}</td>
        </tr>`;
    }
    const tudoOk = d.itens.filter(u => u.coord && u.coord.status === 'ok').length === d.qtd;
    return `
      <section class="ua-disc" data-disc="${esc(d.id)}">
        <div class="ua-disc-topo">
          <div>
            <h2>${esc(nomeBonito(d.nome))}</h2>
            <p class="ua-disc-meta">${metaDisc(d)}${d.coordenador ? ` · Coordenador: <b>${esc(d.coordenador)}</b>` : ''}</p>
          </div>
          ${resumo(d)}
        </div>
        <table class="ua-tabela">
          <thead><tr><th>Unidade</th><th>Código SAGAH</th><th>Título</th><th>Situação</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
        <div class="ua-acoes">
          <span class="ua-status" data-status>${tudoOk ? 'Todas as unidades foram validadas pelo coordenador.' : 'O que você digita fica guardado neste navegador até enviar.'}</span>
          <button type="button" class="ua-btn" data-enviar ${tudoOk ? 'disabled' : ''}>Salvar e enviar ao coordenador</button>
        </div>
      </section>`;
  }

  async function enviarProfessor(sec) {
    const id = sec.dataset.disc;
    if (ocupado.has(id)) return;
    const d = dados.disciplinas.find(x => x.id === id);
    const itens = [];
    const faltam = [];
    sec.querySelectorAll('tr[data-n]').forEach(tr => {
      const n = Number(tr.dataset.n);
      const codigo = tr.querySelector('[data-campo="codigo"]').value.trim();
      const titulo = tr.querySelector('[data-campo="titulo"]').value.trim();
      if (codigo || titulo) {
        if (!codigo || !titulo) faltam.push(`UA ${dois(n)}`);
        itens.push({ n, codigo, titulo });
      }
    });
    const st = sec.querySelector('[data-status]');
    if (faltam.length) { st.textContent = `Preencha o código e o título juntos: ${faltam.join(', ')}.`; return; }
    if (!itens.length) { st.textContent = 'Preencha pelo menos uma unidade.'; return; }
    ocupado.add(id);
    const btn = sec.querySelector('[data-enviar]');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const nova = await api(`/automacao-ava/publico/unidades/${encodeURIComponent(token)}/salvar`, { method: 'POST', body: JSON.stringify({ discId: id, itens }) });
      Object.assign(d, nova);
      gravarLocal(rascunhoKey(d), null);
      sec.outerHTML = discProfessor(d);
      const novaSec = document.querySelector(`[data-disc="${CSS.escape(id)}"] [data-status]`);
      const preenchidas = d.itens.filter(u => u.codigo).length;
      if (novaSec) novaSec.textContent = preenchidas === d.qtd ? 'Enviado! O coordenador já pode validar.' : `Salvo: ${preenchidas} de ${d.qtd} unidades. Pode completar depois pelo mesmo link.`;
    } catch (e) {
      st.textContent = e.message;
      btn.disabled = false; btn.textContent = 'Salvar e enviar ao coordenador';
    } finally { ocupado.delete(id); }
  }

  function telaProfessor() {
    const ds = dados.disciplinas;
    $('ua-app').innerHTML = `
      <div class="ua-cabeca">
        <p class="ua-para">Prof. ${esc(dados.professor)} · semestre ${esc(sem(dados.semestre))}</p>
        <h1>Unidades das suas disciplinas EAD</h1>
      </div>
      <div class="ua-instr">
        Para cada disciplina, escolha no <b>catálogo SAGAH</b> as unidades de aprendizagem, na ordem em que serão dadas.
        <ol>
          <li>Em cada UA, digite o <b>código</b> e o <b>título</b> da unidade como estão no catálogo.</li>
          <li>Disciplina de 80/60 h tem 12 unidades (6 por bimestre); de 40/30 h, 6 unidades.</li>
          <li>Clique em <b>Salvar e enviar ao coordenador</b>. Dá para salvar parcial e voltar depois por este mesmo link.</li>
          <li>Se o coordenador pedir ajuste, a UA aparece em vermelho com a observação: corrija e envie de novo.</li>
        </ol>
      </div>
      ${ds.length ? ds.map(discProfessor).join('') : '<section class="eq-aviso"><h1>Nenhuma disciplina por enquanto</h1><p>Ainda não há disciplina EAD para criar no seu nome neste semestre. Se achar que é engano, fale com o setor de T.I.</p></section>'}`;
  }

  // ---------------- coordenador ----------------
  function discCoordenador(d) {
    const por = new Map(d.itens.map(u => [u.n, u]));
    let linhas = '';
    for (let n = 1; n <= d.qtd; n++) {
      const u = por.get(n) || { n };
      const tem = u.codigo && u.titulo;
      const st = u.coord && u.coord.status;
      linhas += linhaBim(n, d.qtd) + `
        <tr data-n="${n}">
          <td class="ua-n">UA ${dois(n)}</td>
          <td class="ua-col-cod"><span class="ua-txt-cod">${tem ? esc(u.codigo) : '—'}</span></td>
          <td>${tem ? esc(u.titulo) : '<span class="ua-sit vazio">O professor ainda não preencheu</span>'}</td>
          <td class="ua-col-sit">
            ${situacao(u)}
            ${tem ? `<div class="ua-botoes-linha" style="margin-top:6px">
              ${st !== 'ok' ? `<button type="button" class="ua-btn mini bom" data-validar="${n}">Validar</button>` : `<button type="button" class="ua-btn mini sec" data-desfazer="${n}">Desfazer</button>`}
              ${st !== 'ajustar' ? `<button type="button" class="ua-btn mini crit" data-ajustar="${n}">Pedir ajuste</button>` : ''}
            </div>` : ''}
          </td>
        </tr>`;
    }
    const pendentes = d.itens.filter(u => u.codigo && u.titulo && !(u.coord && u.coord.status === 'ok')).length;
    return `
      <section class="ua-disc" data-disc="${esc(d.id)}">
        <div class="ua-disc-topo">
          <div>
            <h2>${esc(nomeBonito(d.nome))}</h2>
            <p class="ua-disc-meta">${metaDisc(d)} · Professor: <b>${esc(d.professor)}</b></p>
          </div>
          ${resumo(d)}
        </div>
        <table class="ua-tabela">
          <thead><tr><th>Unidade</th><th>Código SAGAH</th><th>Título</th><th>Validação</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
        <div class="ua-acoes">
          <span class="ua-status" data-status></span>
          <button type="button" class="ua-btn bom" data-validar="todas" ${pendentes ? '' : 'disabled'}>Validar todas as preenchidas${pendentes ? ` (${pendentes})` : ''}</button>
        </div>
      </section>`;
  }

  async function validar(sec, n, status, obs) {
    const id = sec.dataset.disc;
    if (ocupado.has(id)) return;
    ocupado.add(id);
    const st = sec.querySelector('[data-status]');
    st.textContent = 'Salvando…';
    try {
      const nova = await api(`/automacao-ava/publico/unidades/${encodeURIComponent(token)}/validar`, { method: 'POST', body: JSON.stringify({ discId: id, n, status, obs }) });
      const d = dados.disciplinas.find(x => x.id === id);
      Object.assign(d, nova);
      sec.outerHTML = discCoordenador(d);
      const s2 = document.querySelector(`[data-disc="${CSS.escape(id)}"] [data-status]`);
      if (s2) s2.textContent = status === 'ajustar' ? 'Pedido de ajuste salvo. O professor vê a observação no link dele.' : 'Salvo.';
    } catch (e) { st.textContent = e.message; }
    finally { ocupado.delete(id); }
  }

  function telaCoordenador() {
    const ds = dados.disciplinas;
    $('ua-app').innerHTML = `
      <div class="ua-cabeca">
        <p class="ua-para">Coord. ${esc(dados.coordenador)} · ${esc(nomeBonito(dados.cursoNome))} · semestre ${esc(sem(dados.semestre))}</p>
        <h1>Validação das unidades das disciplinas EAD</h1>
      </div>
      <div class="ua-instr">
        Estas são as disciplinas EAD novas do curso. O professor escolheu as unidades no catálogo SAGAH.
        <ol>
          <li>Confira cada unidade e clique em <b>Validar</b>, ou em <b>Validar todas as preenchidas</b>.</li>
          <li>Se alguma não servir, clique em <b>Pedir ajuste</b> e escreva o motivo: o professor vê no link dele e corrige.</li>
          <li>Volte a este link quando quiser: ele sempre mostra o que o professor enviou por último.</li>
        </ol>
      </div>
      ${ds.length ? ds.map(discCoordenador).join('') : '<section class="eq-aviso"><h1>Nenhuma disciplina por enquanto</h1><p>Ainda não há disciplina EAD nova com professor definido para este curso.</p></section>'}`;
  }

  // ---------------- eventos ----------------
  document.addEventListener('input', (e) => {
    const inp = e.target.closest('input[data-campo]');
    if (!inp || !dados || dados.tipo !== 'professor') return;
    const sec = inp.closest('[data-disc]');
    const d = dados.disciplinas.find(x => x.id === sec.dataset.disc);
    const k = rascunhoKey(d);
    const ras = lerLocal(k) || {};
    const n = inp.closest('tr').dataset.n;
    ras[n] = { ...(ras[n] || {}), [inp.dataset.campo]: inp.value };
    gravarLocal(k, ras);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !dados) return;
    const sec = b.closest('[data-disc]');
    if (!sec) return;
    if (b.dataset.enviar !== undefined) return enviarProfessor(sec);
    if (b.dataset.validar) return validar(sec, b.dataset.validar === 'todas' ? 'todas' : Number(b.dataset.validar), 'ok');
    if (b.dataset.desfazer) return validar(sec, Number(b.dataset.desfazer), 'limpar');
    if (b.dataset.ajustar) {
      const td = b.closest('td');
      if (td.querySelector('.ua-ajuste')) return;
      const n = b.dataset.ajustar;
      td.insertAdjacentHTML('beforeend', `<div class="ua-ajuste"><input aria-label="O que ajustar na UA ${dois(n)}" placeholder="O que o professor precisa ajustar?" maxlength="600"><button type="button" class="ua-btn mini crit" data-mandar-ajuste="${n}">Enviar</button></div>`);
      td.querySelector('.ua-ajuste input').focus();
      return;
    }
    if (b.dataset.mandarAjuste) {
      const obs = b.parentElement.querySelector('input').value.trim();
      if (!obs) { b.parentElement.querySelector('input').focus(); return; }
      return validar(sec, Number(b.dataset.mandarAjuste), 'ajustar', obs);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('.ua-ajuste input');
    if (inp) { e.preventDefault(); inp.parentElement.querySelector('button').click(); }
  });

  async function iniciar() {
    if (!token) return aviso('Link incompleto', 'Abra o endereço completo que o setor de T.I enviou.');
    try { dados = await api(`/automacao-ava/publico/unidades/${encodeURIComponent(token)}`); }
    catch (e) { return aviso('Não foi possível abrir', esc(e.message)); }
    document.title = (dados.tipo === 'professor' ? 'Unidades das disciplinas EAD' : 'Validação das unidades EAD') + ' · Órbita Fatec';
    if (dados.tipo === 'professor') telaProfessor(); else telaCoordenador();
  }
  iniciar();
})();
