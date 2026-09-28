// Utilidades compartilhadas pelas telas do Comercial (Contratos, Aula
// Experimental, Aulões).

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
