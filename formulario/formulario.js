// Página pública dos Formulários (12/11/2026): a pessoa abre o link e responde sem login.
(function () {
  'use strict';
  const API = (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) || location.hostname.startsWith('192.168.') || location.hostname.startsWith('10.'))
    ? `http://${location.hostname}:3000/api` : '/api';
  const token = new URLSearchParams(location.search).get('t') || '';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lerLocal = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const gravarLocal = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } };
  const dataBR = (iso) => { if (!iso) return ''; const [a, m, d] = iso.split('-'); return `${d}/${m}/${a}`; };
  let form = null, enviando = false;

  // identificador do aparelho (só pra "1 resposta por pessoa" nos formulários anônimos)
  let dispositivo = lerLocal('fp-dispositivo');
  if (!dispositivo) { dispositivo = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, ''); gravarLocal('fp-dispositivo', dispositivo); }

  async function api(caminho, opts = {}) {
    const r = await fetch(API + caminho, { ...opts, headers: { 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || 'Não foi possível concluir agora.'); e.status = r.status; throw e; }
    return j;
  }
  function aviso(titulo, texto) {
    $('fp-app').innerHTML = `${form && form.capa ? `<img class="fp-capa" src="${form.capa}" alt="">` : ''}<section class="fp-aviso"><h1>${esc(titulo)}</h1><p>${texto}</p></section>`;
  }

  function campoPergunta(p, i) {
    const nome = `p_${p.id}`;
    const ob = p.obrigatoria ? ' <span class="fp-ob" aria-label="obrigatória">*</span>' : '';
    let campo = '';
    if (p.tipo === 'curta') campo = `<input type="text" name="${nome}" maxlength="500" ${p.obrigatoria ? 'required' : ''}>`;
    else if (p.tipo === 'longa') campo = `<textarea name="${nome}" rows="4" maxlength="5000" ${p.obrigatoria ? 'required' : ''}></textarea>`;
    else if (p.tipo === 'data') campo = `<input type="date" name="${nome}" ${p.obrigatoria ? 'required' : ''}>`;
    else if (p.tipo === 'unica' || p.tipo === 'simnao') campo = `<div class="fp-ops">${(p.tipo === 'simnao' ? ['Sim', 'Não'] : p.opcoes).map(o => `<label class="fp-op"><input type="radio" name="${nome}" value="${esc(o)}" ${p.obrigatoria ? 'required' : ''}><span>${esc(o)}</span></label>`).join('')}</div>`;
    else if (p.tipo === 'multipla') campo = `<div class="fp-ops">${p.opcoes.map(o => `<label class="fp-op"><input type="checkbox" name="${nome}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join('')}</div><small class="fp-dica">Pode marcar mais de uma.</small>`;
    else if (p.tipo === 'escala') campo = `<div class="fp-escala">${[1, 2, 3, 4, 5].map(n => `<label class="fp-esc"><input type="radio" name="${nome}" value="${n}" ${p.obrigatoria ? 'required' : ''}><span>${n}</span></label>`).join('')}</div><div class="fp-escala-leg"><span>pouco</span><span>muito</span></div>`;
    return `<fieldset class="fp-perg" data-id="${p.id}" data-tipo="${p.tipo}"><legend><span class="fp-n">${i + 1}</span>${esc(p.texto)}${ob}</legend>${campo}</fieldset>`;
  }

  function tela() {
    const ident = form.identificacao === 'identificado';
    $('fp-app').innerHTML = `
      ${form.capa ? `<img class="fp-capa" src="${form.capa}" alt="Arte do evento">` : ''}
      <section class="fp-cab">
        <h1>${esc(form.titulo)}</h1>
        ${form.descricao ? `<p class="fp-desc">${esc(form.descricao)}</p>` : ''}
        ${form.fechaEm ? `<p class="fp-prazo">Responda até <b>${dataBR(form.fechaEm)}</b></p>` : ''}
      </section>
      <form id="fp-form" novalidate>
        ${ident ? `<section class="fp-ident">
          <h2>Seus dados</h2>
          <label class="fp-campo"><span>Nome completo <span class="fp-ob">*</span></span><input type="text" id="fp-nome" maxlength="150" autocomplete="name" required value="${esc(lerLocal('fp-nome') || '')}"></label>
          <div class="fp-dupla">
            <label class="fp-campo"><span>Curso <span class="fp-ob">*</span></span><select id="fp-curso" required><option value="">Escolha o seu curso</option>${form.cursos.map(c => `<option ${lerLocal('fp-curso') === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
            <label class="fp-campo"><span>Período</span><select id="fp-periodo"><option value="">—</option>${Array.from({ length: 12 }, (_, i) => `${i + 1}º`).map(p => `<option ${lerLocal('fp-periodo') === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
          </div>
        </section>` : ''}
        ${form.perguntas.map(campoPergunta).join('')}
        <p class="fp-erro hidden" id="fp-erro" role="alert"></p>
        <button type="submit" class="fp-enviar" id="fp-enviar">Enviar resposta</button>
        ${form.umaPorPessoa ? '<p class="fp-dica fp-centro">Se você responder de novo, sua resposta anterior é substituída.</p>' : ''}
      </form>`;
    $('fp-form').addEventListener('submit', enviar);
  }

  async function enviar(e) {
    e.preventDefault();
    if (enviando) return;
    const erro = $('fp-erro');
    erro.classList.add('hidden');
    document.querySelectorAll('.fp-perg.falta').forEach(el => el.classList.remove('falta'));
    const respostas = {};
    const faltam = [];
    form.perguntas.forEach(p => {
      const nome = `p_${p.id}`;
      let v;
      if (p.tipo === 'multipla') v = [...document.querySelectorAll(`input[name="${nome}"]:checked`)].map(i => i.value);
      else if (['unica', 'simnao', 'escala'].includes(p.tipo)) v = document.querySelector(`input[name="${nome}"]:checked`)?.value || '';
      else v = (document.querySelector(`[name="${nome}"]`)?.value || '').trim();
      const vazio = Array.isArray(v) ? !v.length : !v;
      if (p.obrigatoria && vazio) { faltam.push(p); document.querySelector(`.fp-perg[data-id="${p.id}"]`).classList.add('falta'); }
      if (!vazio) respostas[p.id] = p.tipo === 'escala' ? Number(v) : v;
    });
    let pessoa = null;
    if (form.identificacao === 'identificado') {
      pessoa = { nome: $('fp-nome').value.trim(), curso: $('fp-curso').value, periodo: $('fp-periodo').value };
      if (pessoa.nome.split(/\s+/).length < 2 || !pessoa.curso) {
        erro.textContent = 'Preencha o seu nome completo e o curso.';
        erro.classList.remove('hidden'); $('fp-nome').focus(); return;
      }
    }
    if (faltam.length) {
      erro.textContent = `Faltou responder: ${faltam.map(p => p.texto).slice(0, 3).join('; ')}${faltam.length > 3 ? '…' : ''}`;
      erro.classList.remove('hidden');
      document.querySelector('.fp-perg.falta')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    enviando = true;
    const btn = $('fp-enviar'); btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await api(`/formularios/publico/${encodeURIComponent(token)}/responder`, { method: 'POST', body: JSON.stringify({ respostas, pessoa, dispositivo }) });
      if (pessoa) { gravarLocal('fp-nome', pessoa.nome); gravarLocal('fp-curso', pessoa.curso); gravarLocal('fp-periodo', pessoa.periodo); }
      aviso(r.atualizada ? 'Resposta atualizada' : 'Resposta enviada', `${esc(r.message || 'Obrigado!')}<br>Pode fechar esta página.`);
      window.scrollTo(0, 0);
    } catch (err) {
      erro.textContent = err.message; erro.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Enviar resposta';
    } finally { enviando = false; }
  }

  (async () => {
    if (!token) return aviso('Link incompleto', 'Abra o endereço completo que você recebeu.');
    try {
      form = await api(`/formularios/publico/${encodeURIComponent(token)}`);
      document.title = `${form.titulo} · Fatec Ivaiporã`;
      if (form.situacao === 'agendado') return aviso(form.titulo, `Este formulário abre em <b>${dataBR(form.abreEm)}</b>. Volte a partir dessa data.`);
      if (form.situacao === 'encerrado') return aviso(form.titulo, 'Este formulário já foi encerrado e não recebe mais respostas.');
      tela();
    } catch (err) { aviso('Não foi possível abrir', esc(err.message)); }
  })();
})();
