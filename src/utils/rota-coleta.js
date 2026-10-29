// ==========================================
// Contratos › Rota de coleta (27/10/2026) — monta o roteiro do dia pra coletar a assinatura do contrato
// na casa do aluno: endereço vindo do Edubox (relay /comercial/enderecos, só dos alunos da rota) e ordem
// de visita. O celular abre cada parada no Google Maps (pelo ponto salvo no GPS ou pelo endereço escrito;
// off-line com o mapa da região baixado).
// Ordem de visita (decisão do usuário, 27/10): o Google Routes API calcula a melhor ordem (saindo da
// Fatec e voltando), com km e minutos de cada trecho. Vai só o endereço/ponto, NUNCA o nome do aluno.
// Sem GOOGLE_MAPS_API_KEY no .env, cai pra ordem local (GPS pela distância, depois bairro/rua).
// ==========================================
const { relay } = require('./edubox-relay');
const nomesSociais = require('./nome-social');

// Saída da rota: Fatec Ivaiporã (centro de Ivaiporã-PR).
const SAIDA = { lat: -24.2475, lng: -51.6847, nome: 'Fatec Ivaiporã' };

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const formatoEdubox = (sem) => { const [a, s] = String(sem).split('.'); return [`${a}/${s}`, `${a}-${s}`]; };

// Endereço é dado pessoal: só passa pelo relay com HTTPS (ou o simulador local no localhost).
function relaySeguro() {
    const url = process.env.EDUBOX_RELAY_URL || '';
    return /^https:\/\//i.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url);
}

// Endereço SÓ dos alunos da rota (nomes já sem acento/pontuação, como o relay compara).
async function enderecosDosAlunos(semestre, nomes) {
    if (!relaySeguro()) {
        const e = new Error('O endereço do aluno só vem do Edubox com o relay em HTTPS (EDUBOX_RELAY_URL).');
        e.status = 503; throw e;
    }
    // quem usa nome social está no Órbita com ele; no Edubox só existe o nome de registro
    await nomesSociais.carregarNomesSociais();
    const lista = [...new Set(nomes.map(n => norm(nomesSociais.nomeRegistro(n))).filter(n => n.length >= 3))].slice(0, 40);
    const porNome = new Map();
    if (!lista.length) return porNome;
    const r = await relay(`/comercial/enderecos?semestres=${encodeURIComponent(formatoEdubox(semestre).join(','))}&nomes=${encodeURIComponent(lista.join('|'))}`, { timeoutMs: 45000 });
    (r.alunos || []).forEach(a => {
        const k = norm(nomesSociais.nomeSocial(a.nome));
        porNome.set(k, porNome.has(k) ? null : a); // dois alunos com o mesmo nome: não dá pra saber qual — fica sem endereço
    });
    return porNome;
}

const enderecoTexto = (a) => [[a.rua, a.numero].filter(Boolean).join(', '), a.bairro, [a.cidade, a.uf].filter(Boolean).join(' - '), a.cep && `CEP ${a.cep}`].filter(Boolean).join(' · ');
// Texto que o Google Maps do celular procura (decisão do usuário, 27/10: o Órbita NÃO manda endereço pra
// serviço de mapa nenhum — quem procura é o próprio celular, na hora de navegar).
// Formato que o Google entende melhor: "RUA X, 123 - BAIRRO, CIDADE - PR, 86870-000, Brasil".
// Número com letra ("S/N", "123A") fica só com os dígitos; sem dígito nenhum, sai sem número.
const enderecoBusca = (a) => {
    const num = String(a.numero || '').replace(/\D+/g, ' ').trim().split(' ')[0] || '';
    return `${[a.rua, num].filter(Boolean).join(', ')}${a.bairro ? ' - ' + a.bairro : ''}, ${a.cidade}${a.uf ? ' - ' + a.uf : ''}${a.cep ? ', ' + a.cep : ''}, Brasil`;
};

// distância aproximada em km
function km(a, b) {
    const R = 6371, r = (x) => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
// Ordem de visita: quem já tem o ponto salvo pelo GPS vai primeiro, sempre a casa mais perto de onde a
// pessoa está (saindo de Ivaiporã); depois os outros por cidade, bairro, rua e número.
function ordenar(paradas) {
    const com = paradas.filter(p => p.geo), sem = paradas.filter(p => !p.geo);
    const ordem = []; let aqui = SAIDA;
    while (com.length) {
        let mi = 0, md = Infinity;
        com.forEach((p, i) => { const d = km(aqui, p.geo); if (d < md) { md = d; mi = i; } });
        const [p] = com.splice(mi, 1);
        p.kmAnterior = Math.round(md * 10) / 10;
        ordem.push(p); aqui = p.geo;
    }
    const k = (p) => p.local || {};
    sem.sort((x, y) => (k(x).cidade || '').localeCompare(k(y).cidade || '', 'pt-BR') || (k(x).bairro || '').localeCompare(k(y).bairro || '', 'pt-BR')
        || (k(x).rua || '').localeCompare(k(y).rua || '', 'pt-BR') || (parseInt(k(x).numero, 10) || 0) - (parseInt(k(y).numero, 10) || 0));
    return [...ordem, ...sem];
}

// ---------------- Google Routes API: melhor ordem de visita ----------------
// computeRoutes com optimizeWaypointOrder: até 25 paradas no meio. Origem e destino = Fatec (ida e volta).
const MAX_GOOGLE = 25;
const pontoGoogle = (p) => p.geo ? { location: { latLng: { latitude: p.geo.lat, longitude: p.geo.lng } } } : { address: p.busca };
async function ordenarGoogle(paradas) {
    const chave = process.env.GOOGLE_MAPS_API_KEY;
    const vao = paradas.filter(p => p.geo || p.busca);
    const ficam = paradas.filter(p => !(p.geo || p.busca));
    if (!chave || vao.length < 2 || vao.length > MAX_GOOGLE) return null;
    const saida = { location: { latLng: { latitude: SAIDA.lat, longitude: SAIDA.lng } } };
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', 'X-Goog-Api-Key': chave,
            'X-Goog-FieldMask': 'routes.optimizedIntermediateWaypointIndex,routes.legs.distanceMeters,routes.legs.duration,routes.legs.endLocation,routes.distanceMeters,routes.duration'
        },
        body: JSON.stringify({ origin: saida, destination: saida, intermediates: vao.map(pontoGoogle), travelMode: 'DRIVE', optimizeWaypointOrder: true, languageCode: 'pt-BR', regionCode: 'BR' }),
        signal: AbortSignal.timeout(20000)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.routes || !j.routes[0]) {
        const e = new Error((j.error && j.error.message) || `Google respondeu ${r.status}`); e.google = true; throw e;
    }
    const rota = j.routes[0];
    const idx = rota.optimizedIntermediateWaypointIndex && rota.optimizedIntermediateWaypointIndex.length === vao.length
        ? rota.optimizedIntermediateWaypointIndex : vao.map((_, i) => i);
    const seg = (d) => Math.round(parseInt(String(d || '0').replace('s', ''), 10) / 60);
    const legs = rota.legs || [];
    // ponto que o Google achou pra cada casa (fim de cada trecho): os links do celular usam ele em vez do texto
    // do endereço, que o app do Google Maps às vezes não encontra. Não é guardado (só vale pra esta rota).
    const pontoDe = (leg) => { const l = leg && leg.endLocation && leg.endLocation.latLng; return l ? { lat: l.latitude, lng: l.longitude } : null; };
    const ordem = idx.map((i, n) => ({ ...vao[i], ponto: vao[i].geo ? null : pontoDe(legs[n]), kmAnterior: legs[n] ? Math.round(legs[n].distanceMeters / 100) / 10 : null, minAnterior: legs[n] ? seg(legs[n].duration) : null }));
    const volta = legs[vao.length];
    return {
        paradas: [...ordem, ...ficam],
        totais: { km: Math.round((rota.distanceMeters || 0) / 100) / 10, minutos: seg(rota.duration), voltaKm: volta ? Math.round(volta.distanceMeters / 100) / 10 : null }
    };
}

module.exports = { SAIDA, MAX_GOOGLE, norm, enderecosDosAlunos, enderecoTexto, enderecoBusca, ordenar, ordenarGoogle };
