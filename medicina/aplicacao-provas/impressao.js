// Aplicação de Provas — IMPRESSÃO DA PROVA (24/11/2026)
// Para a secretaria acadêmica (Joyce): para cada prova, por sala, a lista da porta (aluno e nº do computador),
// a folha de login de cada aluno (login = RA, senha = "F" + CPF) e a ata de aplicação.
//   LAB12: computadores 1–60 · LAB20: 1–30 · NAPA: sala da prova (notebooks, sem número).
//   Os alunos do NAPA não entram nas listas dos laboratórios (fazem a prova separados).
//   A divisão da turma entre os laboratórios (ex.: da letra A até "Emily Silva" no LAB20, o resto no LAB12) fica salva.
// Alunos, RA e CPF vêm do Edubox na hora (relay) e não são gravados. A impressão é em preto e branco: nada depende de cor.
import { escapeHTML as esc } from '../../core/security.js';

const ROTULO_SALA = { LAB12: 'Laboratório 12', LAB20: 'Laboratório 20' };
const CAPACIDADE = { LAB12: 60, LAB20: 30 };
const CHAMADA = { b1: '1ª chamada · 1º bimestre', b2: '1ª chamada · 2º bimestre', sub: '2ª chamada', exame: 'Exame' };
const PARTICULAS = new Set(['de', 'da', 'do', 'dos', 'das', 'e']);
const toks = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w && !PARTICULAS.has(w));
// "Emily Silva" ⊂ "EMILY SILVA SANTOS": mesmo primeiro nome e os outros nomes digitados aparecem no nome completo
function casa(curto, completo) {
  const a = toks(curto), b = toks(completo);
  return !!a.length && a[0] === b[0] && a.slice(1).every(w => b.includes(w));
}
const dataBR = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');
const dois = (n) => String(n).padStart(2, '0');

export function criarImpressao({ api, toast, BASE, dadosAtuais, provasVisiveis }) {
  const cache = new Map(); // `${semestre}|${turma}` → resposta do servidor (só na memória desta aba)
  let provaId = '';
  let carregando = false;

  async function alunosDa(turma) {
    const d = dadosAtuais();
    const k = `${d.semestre}|${turma}`;
    if (!cache.has(k)) cache.set(k, await api(`${BASE}/impressao/alunos?semestre=${encodeURIComponent(d.semestre)}&turma=${encodeURIComponent(turma)}`));
    return cache.get(k);
  }

  // distribui a turma nas salas → { salas: [{ id, rotulo, alunos:[{...,pc}] }], napa: {...}, avisos: [] }
  function distribuir(info, prova) {
    const d = dadosAtuais();
    const avisos = [];
    const napaNomes = ((d.config.napaAlunos || {})[info.turma]) || [];
    const napaRa = new Set();
    napaNomes.forEach(n => {
      const ach = info.alunos.filter(a => casa(n, a.nome));
      if (ach.length === 1) napaRa.add(ach[0].ra);
      else avisos.push(ach.length ? `NAPA: "${n}" bate com mais de um aluno. Escreva o nome completo em Configurar.` : `NAPA: "${n}" não foi encontrado na turma no Edubox. Confira o nome em Configurar.`);
    });
    const napaAlunos = info.alunos.filter(a => napaRa.has(a.ra));
    const resto = info.alunos.filter(a => !napaRa.has(a.ra));
    const s = info.salas || { modo: 'unica', primeira: 'LAB12' };
    let partes;
    if (s.modo === 'dividida') {
      const alvos = info.alunos.filter(a => casa(s.ate, a.nome));
      if (alvos.length !== 1) {
        avisos.push(alvos.length ? `Divisão: "${s.ate}" bate com mais de um aluno. Escolha o aluno exato na divisão.` : `Divisão: "${s.ate}" não está na turma. Escolha de novo até qual aluno vai para o ${ROTULO_SALA[s.primeira]}.`);
        partes = [[s.primeira, resto]];
      } else {
        const limite = alvos[0].nome;
        partes = [[s.primeira, resto.filter(a => a.nome.localeCompare(limite, 'pt-BR') <= 0)], [s.segunda, resto.filter(a => a.nome.localeCompare(limite, 'pt-BR') > 0)]];
      }
    } else partes = [[s.primeira || 'LAB12', resto]];
    const salas = partes.filter(([, l]) => l.length).map(([id, l]) => {
      if (l.length > CAPACIDADE[id]) avisos.push(`${ROTULO_SALA[id]}: ${l.length} alunos para ${CAPACIDADE[id]} computadores.`);
      return { id, rotulo: ROTULO_SALA[id], alunos: l.map((a, i) => ({ ...a, pc: i + 1 })) };
    });
    if (info.semCpf) avisos.push(`${info.semCpf} aluno(s) sem CPF no Edubox: a folha sai sem senha (procure a secretaria).`);
    const napaSala = (prova.napa && prova.napa.sala) || (d.config.napa && d.config.napa.sala) || 'Sala 33';
    const napa = napaAlunos.length ? { id: 'NAPA', rotulo: napaSala, alunos: napaAlunos, napa: true } : null;
    return { salas, napa, avisos };
  }

  // ------------------------------------------------------------------ tela
  function opcoesProva() {
    const ps = provasVisiveis().slice().sort((a, b) => a.data.localeCompare(b.data) || a.turma.localeCompare(b.turma));
    if (!provaId || !ps.some(p => p.id === provaId)) {
      const hoje = new Date().toISOString().slice(0, 10);
      provaId = (ps.find(p => p.data >= hoje) || ps[0] || {}).id || '';
    }
    return ps;
  }

  async function render(alvo) {
    const ps = opcoesProva();
    if (!ps.length) { alvo.innerHTML = '<div class="ap-vazio">Nenhuma prova nesta etapa. Cadastre a prova primeiro.</div>'; return; }
    const prova = ps.find(p => p.id === provaId);
    alvo.innerHTML = `<div class="ap-imp">
      <div class="ap-imp-topo">
        <label class="ap-campo"><span>Prova</span><select id="ap-imp-prova">${ps.map(p => `<option value="${esc(p.id)}" ${p.id === provaId ? 'selected' : ''}>${dataBR(p.data)} · ${esc(p.turma)} · ${esc(p.disciplina)}${p.etapa ? ` (${esc(CHAMADA[p.etapa] || '')})` : ''}</option>`).join('')}</select></label>
      </div>
      <div id="ap-imp-corpo"><div class="ap-vazio">Buscando os alunos da ${esc(prova.turma)} no Edubox…</div></div>
      <p class="ap-nota">Login = RA do aluno; senha = F + CPF (padrão da Fatec). Os dados vêm do Edubox na hora e não ficam gravados no Órbita. Só a coordenação e a secretaria de Medicina veem esta aba.</p>
    </div>`;
    if (carregando) return;
    carregando = true;
    try {
      const info = await alunosDa(prova.turma);
      if (provaId !== prova.id) return;
      renderCorpo(prova, info);
    } catch (e) {
      const c = document.getElementById('ap-imp-corpo');
      if (c) c.innerHTML = `<div class="ap-vazio">${esc(e.message)}</div>`;
    } finally { carregando = false; }
  }

  function renderCorpo(prova, info) {
    const c = document.getElementById('ap-imp-corpo');
    if (!c) return;
    const dist = distribuir(info, prova);
    const s = info.salas || {};
    const todas = [...dist.salas, ...(dist.napa ? [dist.napa] : [])];
    c.innerHTML = `
      <section class="ap-imp-div">
        <h3>Como a ${esc(info.turma)} (${info.periodo}º período · ${info.alunos.length} alunos no Edubox) fica nas salas</h3>
        <div class="ap-imp-div-campos">
          <label class="ap-check"><input type="radio" name="ap-imp-modo" value="unica" ${s.modo !== 'dividida' ? 'checked' : ''}> Uma sala só</label>
          <label class="ap-check"><input type="radio" name="ap-imp-modo" value="dividida" ${s.modo === 'dividida' ? 'checked' : ''}> Dividida em dois laboratórios</label>
          <label class="ap-campo"><span>${s.modo === 'dividida' ? 'Da letra A vai para o' : 'Sala'}</span><select id="ap-imp-primeira">${Object.keys(ROTULO_SALA).map(k => `<option value="${k}" ${(s.primeira || 'LAB12') === k ? 'selected' : ''}>${ROTULO_SALA[k]}</option>`).join('')}</select></label>
          ${s.modo === 'dividida' ? `<label class="ap-campo"><span>até o(a) aluno(a)</span><select id="ap-imp-ate">${info.alunos.map(a => `<option value="${esc(a.nome)}" ${casa(s.ate, a.nome) ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select></label>
            <p class="ap-nota">O resto da turma vai para o ${esc(ROTULO_SALA[(s.primeira || 'LAB12') === 'LAB12' ? 'LAB20' : 'LAB12'])}.</p>` : ''}
          <button type="button" class="ap-btn" id="ap-imp-salvar-div">Salvar divisão</button>
        </div>
      </section>
      ${dist.avisos.length ? `<div class="ap-imp-avisos" role="alert"><b>Confira antes de imprimir:</b><ul>${dist.avisos.map(a => `<li>${esc(a)}</li>`).join('')}</ul></div>` : ''}
      <div class="ap-imp-salas">${todas.map(sl => `<article class="ap-imp-sala">
        <h4>${esc(sl.rotulo)}${sl.napa ? ' <small>(NAPA)</small>' : ''}</h4>
        <p><b>${sl.alunos.length}</b> aluno(s)${CAPACIDADE[sl.id] ? ` · computadores 1 a ${sl.alunos.length} (de ${CAPACIDADE[sl.id]})` : ' · notebooks, sem número'}</p>
        <div class="ap-imp-botoes">
          <button type="button" class="ap-btn ap-btn-pri" data-imp="tudo:${sl.id}">Imprimir tudo desta sala</button>
          ${sl.napa ? '' : `<button type="button" class="ap-btn" data-imp="porta:${sl.id}">Lista da porta</button>`}
          <button type="button" class="ap-btn" data-imp="logins:${sl.id}">Folhas de login (${sl.alunos.length})</button>
          <button type="button" class="ap-btn" data-imp="ata:${sl.id}">Ata</button>
        </div>
        ${sl.napa ? '' : `<details><summary>Ver a lista</summary><ol class="ap-imp-lista">${sl.alunos.map(a => `<li>${esc(a.nome)}</li>`).join('')}</ol></details>`}
      </article>`).join('')}</div>
      <div class="ap-imp-geral"><button type="button" class="ap-btn ap-btn-pri" data-imp="tudo:*">Imprimir tudo da prova (todas as salas)</button>
        <span class="ap-nota">Sai na ordem: para cada sala, a lista da porta, a ata e as folhas de login na ordem dos computadores.</span></div>`;
  }

  // ------------------------------------------------------------------ páginas impressas (A4 retrato, preto e branco)
  function cab() {
    return `<header class="ap-ip-cab"><img src="/img/medfatec-logo.png" alt="MED FATEC"><div><b>FATEC Ivaiporã</b><span>Bacharelado em Medicina</span></div></header>`;
  }
  function linhaProva(prova, info) {
    return `${esc(prova.disciplina)}${prova.etapa ? ` — ${esc(CHAMADA[prova.etapa] || '')}` : ''} · Turma ${esc(info.turma)} (${info.periodo}º período) · ${dataBR(prova.data)}${prova.horario ? ` · ${esc(prova.horario.replace(':', 'h'))}` : ''}`;
  }
  function paginaPorta(sl, prova, info) {
    const longa = sl.alunos.length > 30;
    return `<section class="ap-ip-pg">${cab()}
      <h1 class="ap-ip-sala">${esc(sl.rotulo.toUpperCase())}</h1>
      <p class="ap-ip-sub">${linhaProva(prova, info)}</p>
      <table class="ap-ip-porta ${longa ? 'ap-ip-duas' : ''}"><thead><tr><th>PC</th><th>Aluno(a)</th>${longa ? '<th>PC</th><th>Aluno(a)</th>' : ''}</tr></thead><tbody>
      ${(() => {
        if (!longa) return sl.alunos.map(a => `<tr><td class="ap-ip-pc">${dois(a.pc)}</td><td>${esc(a.nome)}</td></tr>`).join('');
        const meio = Math.ceil(sl.alunos.length / 2), linhas = [];
        for (let i = 0; i < meio; i++) {
          const a = sl.alunos[i], b = sl.alunos[i + meio];
          linhas.push(`<tr><td class="ap-ip-pc">${dois(a.pc)}</td><td>${esc(a.nome)}</td>${b ? `<td class="ap-ip-pc">${dois(b.pc)}</td><td>${esc(b.nome)}</td>` : '<td></td><td></td>'}</tr>`);
        }
        return linhas.join('');
      })()}</tbody></table>
      <p class="ap-ip-total">${sl.alunos.length} aluno(s) neste laboratório</p></section>`;
  }
  function paginaAta(sl, prova, info) {
    const linhas = (n) => Array.from({ length: n }, () => '<div class="ap-ip-linha"></div>').join('');
    return `<section class="ap-ip-pg ap-ip-ata">${cab()}
      <h1>ATA DE APLICAÇÃO DE PROVA</h1>
      <div class="ap-ip-campos">
        <p><b>Instituição:</b> FACULDADE TECNOLÓGICA DO VALE DO IVAÍ</p>
        <p><b>Curso:</b> BACHARELADO EM MEDICINA</p>
        <p><b>Disciplina:</b> ${esc(prova.disciplina.toUpperCase())}${prova.etapa ? ` — ${esc((CHAMADA[prova.etapa] || '').toUpperCase())}` : ''}</p>
        <p><b>Turma:</b> ${esc(info.turma)} (${info.periodo}º período) &nbsp; <b>Sala:</b> ${esc(sl.rotulo.toUpperCase())} &nbsp; <b>Alunos previstos:</b> ${sl.alunos.length}</p>
        <p><b>Data:</b> ${dataBR(prova.data)} &nbsp; <b>Horário de início:</b> ________ &nbsp; <b>Horário de término:</b> ________</p>
      </div>
      <h2>Ocorrências durante a aplicação</h2>
      <p>(&nbsp;&nbsp;) Nenhuma ocorrência registrada.</p>
      <p>(&nbsp;&nbsp;) Ocorreram as seguintes situações:</p>
      ${linhas(4)}
      <p class="ap-ip-texto">Nada mais havendo a relatar, lavra-se a presente ata, que vai assinada pelo(a) professor(a) responsável e, se necessário, por fiscais presentes.</p>
      <h2>Aplicadores</h2>
      <table class="ap-ip-tab"><thead><tr><th style="width:8%">Nº</th><th>Nome</th><th style="width:40%">Assinatura</th></tr></thead>
        <tbody>${[1, 2, 3, 4].map(n => `<tr><td>${n}</td><td></td><td></td></tr>`).join('')}</tbody></table>
      <h2>Registro dos dois últimos alunos a deixar a sala</h2>
      <table class="ap-ip-tab"><thead><tr><th style="width:8%">Nº</th><th>Nome do(a) aluno(a)</th><th style="width:18%">Horário de saída</th><th style="width:30%">Assinatura</th></tr></thead>
        <tbody>${[1, 2].map(n => `<tr><td>${n}</td><td></td><td></td><td></td></tr>`).join('')}</tbody></table>
    </section>`;
  }
  function paginaLogin(a, sl, prova, info) {
    return `<section class="ap-ip-pg ap-ip-login">${cab()}
      <div class="ap-ip-lugar">${sl.napa ? esc(sl.rotulo.toUpperCase()) : `${esc(sl.rotulo.toUpperCase())} · COMPUTADOR ${dois(a.pc)}`}</div>
      <p class="ap-ip-sub">${linhaProva(prova, info)}</p>
      <p class="ap-ip-nome">${esc(a.nome)}</p>
      <p class="ap-ip-cred"><span>Login:</span> <b>${esc(a.ra)}</b></p>
      <p class="ap-ip-cred"><span>Senha:</span> <b>${esc(a.senha || '— procure a secretaria —')}</b></p>
      <div class="ap-ip-notas"><span>Anotações</span></div>
    </section>`;
  }
  function paginasDaSala(sl, prova, info, o) {
    const out = [];
    if ((o === 'tudo' || o === 'porta') && !sl.napa) out.push(paginaPorta(sl, prova, info));
    if (o === 'tudo' || o === 'ata') out.push(paginaAta(sl, prova, info));
    if (o === 'tudo' || o === 'logins') sl.alunos.forEach(a => out.push(paginaLogin(a, sl, prova, info)));
    return out;
  }

  async function imprimir(acao) {
    const [o, salaId] = acao.split(':');
    const prova = provasVisiveis().find(p => p.id === provaId);
    if (!prova) return;
    const info = await alunosDa(prova.turma);
    const dist = distribuir(info, prova);
    const todas = [...dist.salas, ...(dist.napa ? [dist.napa] : [])];
    const alvo = salaId === '*' ? todas : todas.filter(s => s.id === salaId);
    const pags = alvo.flatMap(sl => paginasDaSala(sl, prova, info, o));
    if (!pags.length) { toast('Nada para imprimir nesta sala.', 'erro'); return; }
    const saida = document.getElementById('ap-saida');
    saida.innerHTML = `<div class="ap-ip">${pags.join('')}</div>`;
    await Promise.all([...saida.querySelectorAll('img')].map(i => (i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))));
    document.body.classList.add('ap-imprimindo', 'ap-imprimindo-ret');
    setTimeout(() => {
      window.print();
      document.body.classList.remove('ap-imprimindo', 'ap-imprimindo-ret');
      saida.innerHTML = ''; // a folha tem a senha: não fica na página depois de imprimir
    }, 150);
  }

  async function salvarDivisao() {
    const d = dadosAtuais();
    const prova = provasVisiveis().find(p => p.id === provaId);
    if (!prova) return;
    const modo = (document.querySelector('[name="ap-imp-modo"]:checked') || {}).value || 'unica';
    const primeira = document.getElementById('ap-imp-primeira').value;
    const ateSel = document.getElementById('ap-imp-ate');
    const info = await alunosDa(prova.turma);
    const ate = modo === 'dividida' ? (ateSel ? ateSel.value : (info.alunos[Math.floor(info.alunos.length / 2)] || {}).nome || '') : '';
    const r = await api(`${BASE}/impressao/salas/${encodeURIComponent(d.semestre)}`, { method: 'PUT', body: JSON.stringify({ salas: { [prova.turma]: { modo, primeira, ate } } }) });
    info.salas = r.salas[prova.turma];
    toast(r.message);
    renderCorpo(prova, info);
  }

  function ligar(alvo) {
    alvo.addEventListener('change', (e) => {
      if (e.target.id === 'ap-imp-prova') { provaId = e.target.value; render(alvo); return; }
      if (e.target.name === 'ap-imp-modo') {
        // mostra/esconde o "até" sem salvar ainda
        const prova = provasVisiveis().find(p => p.id === provaId);
        const info = cache.get(`${dadosAtuais().semestre}|${prova.turma}`);
        if (info) { info.salas = { ...(info.salas || {}), modo: e.target.value, ate: info.salas && info.salas.ate ? info.salas.ate : (info.alunos[Math.floor(info.alunos.length / 2)] || {}).nome || '' }; renderCorpo(prova, info); }
      }
    });
    alvo.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-imp]');
      try {
        if (b) { await imprimir(b.dataset.imp); return; }
        if (e.target.closest('#ap-imp-salvar-div')) await salvarDivisao();
      } catch (err) { toast(err.message, 'erro'); }
    });
  }

  return { render, ligar, limpar: () => cache.clear() };
}
