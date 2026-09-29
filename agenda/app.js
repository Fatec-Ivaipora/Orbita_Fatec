import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";
import { firebaseConfig } from "../core/firebase-config.js";
import { setupLayout } from "../core/layout.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);

const API_BASE = (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost' || window.location.hostname.startsWith('192.168.') || window.location.hostname.startsWith('10.')) 
  ? `http://${window.location.hostname}:3000/api` 
  : '/api';

let currentUser = null;
let eventos = [];
let todosLocais = [];
let currentDate = new Date();
let currentLocalId = '';

async function apiFetch(endpoint, options = {}) {
  let token = '';
  if (currentUser) {
    token = await currentUser.getIdToken();
  }
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    ...(options.headers || {})
  };
  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  if (!res.ok) throw new Error(`Erro na API: ${res.status}`);
  return res.json();
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    try {
      const res = await apiFetch('/usuarios/me');
      setupLayout(user, res.role, 'agenda', () => auth.signOut());
      document.getElementById('auth-guard').style.display = 'none';
      document.getElementById('layout-wrapper').style.display = 'flex';
      
      initAgenda();
    } catch (e) {
      alert("Acesso negado.");
      window.location.href = '/index.html';
    }
  } else {
    window.location.href = '/index.html';
  }
});

async function initAgenda() {
    iniciarRelogio();
    await carregarLocais();
    await carregarEventos();
}

async function carregarLocais() {
    try {
        const locais = await apiFetch('/locais');
        todosLocais = locais;
        const select = document.getElementById('select-local');
        select.innerHTML = '<option value="">Todos</option>';
        locais.forEach(l => {
            const opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = `${l.nome} (${l.tipo})`;
            select.appendChild(opt);
        });
        
        select.onchange = () => {
            currentLocalId = select.value;
            renderCalendar();
        };
    } catch (e) {
        console.error('Erro locais', e);
    }
}

async function carregarEventos() {
    try {
        eventos = await apiFetch('/agenda/completo');
        renderCalendar();
        renderPendentes();
        renderOcupacaoMap();
    } catch(e) {
        console.error('Erro eventos', e);
    }
}

// ─── Mapa de Ocupação ──────────────────────────────────────────────────────

function getStatusLocal(localId) {
    const agora = new Date();
    const hoje = agora.toISOString().split('T')[0];
    const horaAtual = agora.getHours() * 60 + agora.getMinutes();

    const eventosHoje = eventos.filter(e =>
        e.localId === localId &&
        e.data === hoje &&
        e.status !== 'Rejeitado'
    );

    if (eventosHoje.length === 0) return 'livre';

    // Verifica se algum evento aprovado está acontecendo agora
    const aprovadoAgora = eventosHoje.find(e => {
        if (e.status !== 'Aprovado') return false;
        const [hi, mi] = e.horaInicio.split(':').map(Number);
        const [hf, mf] = e.horaFim.split(':').map(Number);
        const inicio = hi * 60 + mi;
        const fim    = hf * 60 + mf;
        return horaAtual >= inicio && horaAtual <= fim;
    });
    if (aprovadoAgora) return 'ocupado';

    // Verifica se há evento pendente hoje
    const temPendente = eventosHoje.some(e => e.status === 'Pendente');
    if (temPendente) return 'parcial';

    // Há eventos aprovados mas fora do horário atual (reservado para outro momento)
    const temAprovado = eventosHoje.some(e => e.status === 'Aprovado');
    if (temAprovado) return 'parcial';

    return 'livre';
}

function getStatusInfo(status) {
    const map = {
        livre:   { icon: '🟢', label: 'Livre',   classe: 'livre'   },
        ocupado: { icon: '🔴', label: 'Ocupado', classe: 'ocupado' },
        parcial: { icon: '🟡', label: 'Pendente / Reservado', classe: 'parcial' },
    };
    return map[status] || map['livre'];
}

function renderOcupacaoMap() {
    const grid = document.getElementById('ocupacao-grid');
    if (!grid) return;

    if (todosLocais.length === 0) {
        grid.innerHTML = '<div class="ocupacao-loading">Nenhum local cadastrado.</div>';
        return;
    }

    grid.innerHTML = '';

    todosLocais.forEach(local => {
        const status = getStatusLocal(local.id);
        const info   = getStatusInfo(status);

        const card = document.createElement('div');
        card.className = `ocup-card ${info.classe}`;
        card.title = `${local.nome} — Capacidade: ${local.capacidade || '—'}`;
        card.innerHTML = `
            <span class="dot dot-${info.classe}"></span>
            <div class="ocup-card-info">
                <span class="ocup-card-nome">${local.nome}</span>
                <span class="ocup-card-status">${info.icon} ${info.label}</span>
            </div>
        `;

        // Clicar no card filtra o calendário por esse local
        card.onclick = () => {
            const sel = document.getElementById('select-local');
            sel.value = local.id;
            currentLocalId = local.id;
            renderCalendar();
        };

        grid.appendChild(card);
    });
}

function iniciarRelogio() {
    const clockEl = document.getElementById('ocupacao-clock');
    function tick() {
        const agora = new Date();
        const h = String(agora.getHours()).padStart(2, '0');
        const m = String(agora.getMinutes()).padStart(2, '0');
        if (clockEl) clockEl.textContent = `${h}:${m}`;
    }
    tick();
    setInterval(tick, 1000);

    // Atualiza o mapa de ocupação a cada 60 segundos
    setInterval(renderOcupacaoMap, 60000);
}


function renderPendentes() {
    const pendentesList = document.getElementById('pendentes-list');
    pendentesList.innerHTML = '';
    const pendentes = eventos.filter(e => e.status === 'Pendente');
    
    if (pendentes.length === 0) {
        pendentesList.innerHTML = '<p class="empty-state">Nenhuma solicitação pendente.</p>';
        return;
    }

    // Sort by date then time
    pendentes.sort((a,b) => {
        if (a.data !== b.data) return a.data.localeCompare(b.data);
        return a.horaInicio.localeCompare(b.horaInicio);
    });

    pendentes.forEach(p => {
        const div = document.createElement('div');
        div.className = 'pendente-item';
        div.innerHTML = `
            <div class="pendente-nome">${p.nomeEvento}</div>
            <div class="pendente-detalhe">Por: ${p.nomeSolicitante}</div>
            <div class="pendente-detalhe">Data: ${p.data.split('-').reverse().join('/')} | ${p.horaInicio} às ${p.horaFim}</div>
        `;
        div.onclick = () => abrirModalAcao(p);
        pendentesList.appendChild(div);
    });
}

function renderCalendar() {
    const calendarGrid = document.getElementById('calendar-grid');
    const headers = Array.from(calendarGrid.querySelectorAll('.weekday'));
    calendarGrid.innerHTML = '';
    headers.forEach(h => calendarGrid.appendChild(h));

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const monthNames = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
    document.getElementById('current-month-year').textContent = `${monthNames[month]} ${year}`;

    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
        const cell = document.createElement('div');
        cell.className = 'day-cell disabled';
        calendarGrid.appendChild(cell);
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const cell = document.createElement('div');
        cell.className = 'day-cell';

        const dayNum = document.createElement('div');
        dayNum.className = 'day-number';
        dayNum.textContent = day;
        cell.appendChild(dayNum);

        const indicators = document.createElement('div');
        indicators.className = 'day-indicators';

        let dayEvents = eventos.filter(e => e.data === dateStr && e.status !== 'Rejeitado');
        if (currentLocalId) {
            dayEvents = dayEvents.filter(e => e.localId === currentLocalId);
        }
        
        dayEvents.forEach(e => {
            const ind = document.createElement('div');
            ind.className = `indicator ${e.status.toLowerCase()}`;
            ind.textContent = `${e.horaInicio} ${e.nomeEvento}`;
            ind.onclick = () => abrirModalAcao(e);
            indicators.appendChild(ind);
        });

        cell.appendChild(indicators);
        
        cell.onclick = (e) => {
            if (e.target === cell || e.target === dayNum || e.target === indicators) {
                abrirModalEvento(dateStr);
            }
        };

        calendarGrid.appendChild(cell);
    }
}

document.getElementById('btn-prev-month').onclick = () => {
    currentDate.setMonth(currentDate.getMonth() - 1);
    renderCalendar();
};

document.getElementById('btn-next-month').onclick = () => {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderCalendar();
};

// Modals
let currentEventoSelecionado = null;

window.abrirModalAcao = (evento) => {
    currentEventoSelecionado = evento;
    const modal = document.getElementById('modal-acao');
    const detalhes = document.getElementById('detalhes-solicitacao');
    
    const localObj = todosLocais.find(l => l.id === evento.localId);
    const localNome = localObj ? localObj.nome : 'Local Desconhecido';

    detalhes.innerHTML = `
        <strong>Local:</strong> ${localNome}<br>
        <strong>Evento:</strong> ${evento.nomeEvento}<br>
        <strong>Solicitante:</strong> ${evento.nomeSolicitante}<br>
        <strong>Curso/Setor:</strong> ${evento.curso || '-'}<br>
        <strong>Data:</strong> ${evento.data.split('-').reverse().join('/')}<br>
        <strong>Horário:</strong> ${evento.horaInicio} às ${evento.horaFim}<br>
        <strong>Descrição:</strong> ${evento.descricaoEvento || '-'}<br>
        <strong>Status:</strong> ${evento.status}
    `;

    document.getElementById('btn-aprovar').style.display = evento.status === 'Pendente' ? 'block' : 'none';
    document.getElementById('btn-rejeitar').style.display = evento.status !== 'Rejeitado' ? 'block' : 'none';
    document.getElementById('btn-editar').style.display = 'block';
    document.getElementById('btn-excluir').style.display = 'block';
    
    modal.classList.add('active');
};

window.fecharModalAcao = () => {
    document.getElementById('modal-acao').classList.remove('active');
    currentEventoSelecionado = null;
};

document.getElementById('btn-aprovar').onclick = () => mudarStatus('Aprovado');
document.getElementById('btn-rejeitar').onclick = () => mudarStatus('Rejeitado');

document.getElementById('btn-editar').onclick = () => {
    fecharModalAcao();
    abrirModalEvento('', currentEventoSelecionado);
};

document.getElementById('btn-excluir').onclick = async () => {
    if (!confirm('Tem certeza que deseja excluir este evento permanentemente?')) return;
    try {
        await apiFetch(`/agenda/${currentEventoSelecionado.id}`, { method: 'DELETE' });
        fecharModalAcao();
        await carregarEventos();
        alert('Evento excluído.');
    } catch (err) {
        alert('Erro ao excluir: ' + err.message);
    }
};

window.abrirModalEvento = (dateStr = '', evento = null) => {
    const select = document.getElementById('ev-local');
    select.innerHTML = '<option value="">Selecione...</option>';
    todosLocais.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        opt.textContent = l.nome;
        select.appendChild(opt);
    });

    const form = document.getElementById('form-evento');
    form.reset();

    if (evento) {
        document.getElementById('modal-evento-titulo').textContent = 'Editar Evento';
        document.getElementById('ev-id').value = evento.id;
        document.getElementById('ev-data').value = evento.data;
        document.getElementById('ev-local').value = evento.localId;
        document.getElementById('ev-inicio').value = evento.horaInicio;
        document.getElementById('ev-fim').value = evento.horaFim;
        document.getElementById('ev-titulo').value = evento.nomeEvento;
        document.getElementById('ev-solicitante').value = evento.nomeSolicitante;
        document.getElementById('ev-curso').value = evento.curso || '';
        document.getElementById('ev-descricao').value = evento.descricaoEvento || '';
    } else {
        document.getElementById('modal-evento-titulo').textContent = 'Novo Evento';
        document.getElementById('ev-id').value = '';
        if (dateStr) document.getElementById('ev-data').value = dateStr;
        if (currentLocalId) document.getElementById('ev-local').value = currentLocalId;
    }
    
    document.getElementById('modal-evento').classList.add('active');
};

window.fecharModalEvento = () => {
    document.getElementById('modal-evento').classList.remove('active');
};

document.getElementById('form-evento').onsubmit = async (e) => {
    e.preventDefault();
    const id = document.getElementById('ev-id').value;
    const isEdit = !!id;
    
    const payload = {
        localId: document.getElementById('ev-local').value,
        data: document.getElementById('ev-data').value,
        horaInicio: document.getElementById('ev-inicio').value,
        horaFim: document.getElementById('ev-fim').value,
        nomeEvento: document.getElementById('ev-titulo').value,
        nomeSolicitante: document.getElementById('ev-solicitante').value,
        curso: document.getElementById('ev-curso').value,
        descricaoEvento: document.getElementById('ev-descricao').value
    };

    if (!isEdit) {
        payload.status = 'Aprovado';
    }

    try {
        const method = isEdit ? 'PUT' : 'POST';
        const endpoint = isEdit ? `/agenda/${id}` : '/agenda';
        
        await apiFetch(endpoint, {
            method,
            body: JSON.stringify(payload)
        });
        
        fecharModalEvento();
        await carregarEventos();
        alert(isEdit ? 'Evento atualizado!' : 'Evento criado com sucesso!');
    } catch (err) {
        alert('Erro ao salvar evento: ' + err.message);
    }
};

async function mudarStatus(novoStatus) {
    if (!currentEventoSelecionado) return;
    try {
        await apiFetch(`/agenda/${currentEventoSelecionado.id}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status: novoStatus })
        });
        alert(`Solicitação ${novoStatus.toLowerCase()}!`);
        fecharModalAcao();
        await carregarEventos();
    } catch (e) {
        alert(e.message);
    }
}

// Local Modal
window.abrirModalLocal = () => {
    document.getElementById('form-local').reset();
    document.getElementById('modal-local').classList.add('active');
};
window.fecharModalLocal = () => {
    document.getElementById('modal-local').classList.remove('active');
};

document.getElementById('form-local').onsubmit = async (e) => {
    e.preventDefault();
    const nome = document.getElementById('loc-nome').value;
    const tipo = document.getElementById('loc-tipo').value;
    
    try {
        await apiFetch('/locais', {
            method: 'POST',
            body: JSON.stringify({ nome, tipo, capacidade: 0 })
        });
        alert('Local adicionado!');
        fecharModalLocal();
        carregarLocais();
    } catch (err) {
        alert('Erro ao salvar local');
    }
};
