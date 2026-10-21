// Utilidades compartilhadas pelas telas do Comercial (Contratos, Aula
// Experimental, Aulões, Palestras).

// Texto da opção escolhida num <select> de filtro, sem o "(12)" de contagem.
export function opcaoEscolhida(id) {
  const sel = document.getElementById(id);
  if (!sel || !sel.value) return '';
  return sel.selectedOptions[0].textContent.replace(/\s*\(\d+\)\s*$/, '').trim();
}

// Preenche o cabeçalho do relatório (logo + título ficam no HTML) com o que
// está filtrado e quem emitiu, e abre o diálogo de impressão do navegador
// (o usuário escolhe "Salvar como PDF" se quiser) — mesmo padrão dos outros
// relatórios do Órbita.
export function imprimirRelatorio(partesFiltro, emitidoPor) {
  const partes = partesFiltro.filter(Boolean);
  document.getElementById('print-filtros').textContent = partes.join(' · ');
  const agora = new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  document.getElementById('print-data-emissao').textContent = `Emitido em ${agora}${emitidoPor ? ` por ${emitidoPor}` : ''}`;
  window.print();
}

// Círculo com as iniciais (ex.: "MARIA DA SILVA" -> "MS").
export function avatar(nome) {
  const partes = (nome || '').trim().split(/\s+/).filter(p => p.length > 2 || /^[A-ZÀ-Ú]/.test(p) && p.length > 1);
  const ini = ((partes[0] || '')[0] || '') + ((partes.length > 1 ? partes[partes.length - 1] : '')[0] || '');
  const div = document.createElement('div');
  div.textContent = ini.toUpperCase();
  return `<span class="cm-avatar">${div.innerHTML}</span>`;
}

// ==========================================
// OFÍCIO DO AGENDAMENTO (Aulões e Palestras, 21/10/2026) — pedido do
// Comercial: anexar o ofício (PDF ou foto) do colégio ao agendamento, com o
// que foi solicitado e quando. Depois que o agendamento é salvo, o arquivo
// sobe direto pro Firebase Storage por um link assinado que o servidor gera
// (ver src/rotas/comercial-oficio.js); a listagem só traz o resumo e o
// arquivo só é aberto ao clicar em "Ver".
// ==========================================
const OFICIO_MAX_BYTES = 20 * 1024 * 1024;

// Foto do celular costuma ter 4–8 MB: reduz pra no máx. 2000px em JPEG.
function comprimirImagem(arquivo) {
  return new Promise((ok, erro) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => {
      const escala = Math.min(1, 2000 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? ok(blob) : erro(new Error('Não consegui converter a imagem do ofício.')), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); erro(new Error('Não consegui abrir a imagem do ofício.')); };
    img.src = url;
  });
}

function tamanhoLegivel(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// Liga a seção "Ofício" do formulário (campos f-sol-data, f-sol-texto,
// f-oficio e o quadro oficio-atual). `base` = '/auloes' ou '/palestras';
// `aoMudar(id, oficio)` atualiza o item na lista da tela.
export function criarOficio({ base, apiFetch, showToast, esc, aoMudar }) {
  const el = (id) => document.getElementById(id);
  let itemId = null;
  let atual = null;

  function desenharAtual() {
    const box = el('oficio-atual');
    box.classList.toggle('hidden', !atual);
    if (!atual) { box.innerHTML = ''; return; }
    const quando = new Date(atual.enviadoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    box.innerHTML = `
      <span class="cm-oficio-nome">📎 ${esc(atual.nome)}</span>
      <span class="ct-sub">${tamanhoLegivel(atual.tamanho)} · anexado por ${esc(atual.enviadoPor)} em ${quando}</span>
      <span class="cm-oficio-botoes">
        <button type="button" class="cm-oficio-btn" data-oficio="ver">Ver</button>
        <button type="button" class="cm-oficio-btn cm-oficio-btn-perigo" data-oficio="remover">Remover</button>
      </span>
      <span class="ct-sub cm-oficio-troca">Pra trocar, é só escolher outro arquivo abaixo.</span>`;
  }

  // Abre a janela antes de buscar o arquivo: depois do await o navegador bloqueia o pop-up.
  async function ver(id) {
    const janela = window.open('', '_blank');
    try {
      const o = await apiFetch(`${base}/${id}/oficio`);
      if (janela) janela.location.href = o.url;
      else window.location.href = o.url;
    } catch (err) {
      if (janela) janela.close();
      showToast(err.message, 'error');
    }
  }

  async function remover() {
    if (!itemId || !atual || !confirm(`Remover o ofício "${atual.nome}" deste agendamento?`)) return;
    try {
      await apiFetch(`${base}/${itemId}/oficio`, { method: 'DELETE' });
      atual = null;
      desenharAtual();
      aoMudar(itemId, null);
      showToast('Ofício removido.');
    } catch (err) { showToast(err.message, 'error'); }
  }

  el('oficio-atual').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-oficio]');
    if (!btn) return;
    if (btn.dataset.oficio === 'ver') ver(itemId);
    else remover();
  });

  return {
    ver,
    // Ao abrir o formulário (item = null quando é agendamento novo).
    preencher(item) {
      itemId = item ? item.id : null;
      atual = item ? item.oficio || null : null;
      el('f-sol-data').value = item?.solicitacaoData || '';
      el('f-sol-texto').value = item?.solicitacaoTexto || '';
      el('f-oficio').value = '';
      desenharAtual();
    },
    campos() {
      return { solicitacaoData: el('f-sol-data').value, solicitacaoTexto: el('f-sol-texto').value };
    },
    // Confere/comprime o arquivo escolhido ANTES de salvar o agendamento, pra
    // recusar arquivo inválido sem salvar nada pela metade. null = nenhum.
    async prepararArquivo() {
      const arquivo = el('f-oficio').files[0];
      if (!arquivo) return null;
      const ehPdf = arquivo.type === 'application/pdf' || /\.pdf$/i.test(arquivo.name);
      if (!ehPdf && !arquivo.type.startsWith('image/')) throw new Error('O ofício precisa ser PDF ou foto (JPG/PNG).');
      const blob = ehPdf ? arquivo : await comprimirImagem(arquivo);
      if (blob.size > OFICIO_MAX_BYTES) throw new Error(`O ofício tem ${tamanhoLegivel(blob.size)} — o máximo é 20 MB. Tente escanear com resolução menor.`);
      const nome = ehPdf ? arquivo.name : arquivo.name.replace(/\.[^.]+$/, '') + '.jpg';
      return { blob, nome, mimeType: ehPdf ? 'application/pdf' : 'image/jpeg' };
    },
    // 1) pede o link ao servidor  2) sobe direto pro Storage  3) confirma.
    async enviar(id, { blob, nome, mimeType }) {
      const envio = await apiFetch(`${base}/${id}/oficio/envio`, { method: 'POST', body: JSON.stringify({ nome, mimeType, tamanho: blob.size }) });
      const up = await fetch(envio.url, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
      if (!up.ok) throw new Error(`falha ao enviar o arquivo (${up.status}).`);
      const r = await apiFetch(`${base}/${id}/oficio`, { method: 'PUT', body: JSON.stringify({ caminho: envio.caminho, nome }) });
      aoMudar(id, r.oficio);
      return r.oficio;
    }
  };
}

// Linha "Ofício" que vai na tabela, dentro da célula do colégio/local.
export function oficioNaLinha(i, esc, fmtData) {
  const partes = [];
  if (i.solicitacaoData) partes.push(`Solicitado em ${fmtData(i.solicitacaoData)}`);
  if (i.solicitacaoTexto) partes.push(`<span title="${esc(i.solicitacaoTexto)}">${esc(i.solicitacaoTexto.length > 40 ? i.solicitacaoTexto.slice(0, 40) + '…' : i.solicitacaoTexto)}</span>`);
  const link = i.oficio ? `<button type="button" class="cm-oficio-link" data-acao="oficio" data-id="${i.id}" title="Abrir o ofício anexado">📎 Ofício</button>` : '';
  return partes.length || link ? `<div class="ct-sub cm-oficio-linha">${link}${partes.join(' · ')}</div>` : '';
}
