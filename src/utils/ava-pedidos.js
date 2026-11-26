// ==========================================================================
// Pedidos ao agente do AVA por prova (26/11/2026)
// Cada botão do Órbita ("Enviar esta prova", "Ler de novo no AVA", "Trazer do AVA", "Levar alterações", "Conferir
// todas") grava um pedido em ava_pedidos e acorda o agente do droplet (config/ava_banco_sync.pedidoEm, escutado ao
// vivo). O agente (scripts/ava-banco-med-agente.js) atende só o que foi pedido, um por um, e marca feito/erro.
// tipo: 'envio' | 'resultados' | 'trazer' | 'levar' | 'tudo'; alvo: id da avaliação (Banco MED) ou da prova
// (Aplicação de Provas); sem alvo em 'resultados' = todas as provas já aplicadas.
// ==========================================================================
const { db } = require('../firebase');

const COL_PEDIDOS = 'ava_pedidos';
const ABERTOS = ['pendente', 'rodando'];

async function pedidosAbertos() {
    const s = await db.collection(COL_PEDIDOS).where('status', 'in', ABERTOS).get();
    return s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.em).localeCompare(String(b.em)));
}

// o mesmo pedido já na fila (mesmo tipo e alvo) é reaproveitado: clicar duas vezes não faz o trabalho duas vezes
async function pedirAoAgente({ tipo, alvo = null, por = '' }) {
    const em = new Date().toISOString();
    const abertos = await pedidosAbertos();
    const igual = abertos.find(p => p.tipo === tipo && (p.alvo || null) === (alvo || null));
    const id = igual ? igual.id : (await db.collection(COL_PEDIDOS).add({ tipo, alvo: alvo || null, por, em, status: 'pendente' })).id;
    await db.collection('config').doc('ava_banco_sync').set({ pedidoEm: em, pedidoPorNome: por }, { merge: true });
    return { id, jaNaFila: !!igual, naFrente: abertos.filter(p => p.id !== id).length };
}

// estado para as telas: o agente está trabalhando? quais pedidos estão na fila?
async function estadoDoAgente() {
    const [cfg, pedidos] = await Promise.all([db.collection('config').doc('ava_banco_sync').get(), pedidosAbertos()]);
    const c = cfg.exists ? cfg.data() : {};
    return {
        vivoEm: c.agenteVivoEm || null, intervaloMin: c.intervaloMin || 15, ultimaRodada: c.ultimaRodada || null,
        pedidoEm: c.pedidoEm || null, pedidoPorNome: c.pedidoPorNome || '', rodandoDesde: c.rodandoDesde || null, rodandoOrigem: c.rodandoOrigem || null,
        pedidos: pedidos.map(p => ({ id: p.id, tipo: p.tipo, alvo: p.alvo || null, status: p.status, em: p.em, inicio: p.inicio || null, por: p.por || '' }))
    };
}

module.exports = { pedirAoAgente, pedidosAbertos, estadoDoAgente, COL_PEDIDOS };
