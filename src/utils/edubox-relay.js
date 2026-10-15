// Cliente do relay do Edubox — único jeito de o Órbita buscar dado do Edubox
// (ver regras/regra_do_app.md, seção 8). Erros vêm com `status` pronto pra
// devolver na resposta HTTP.
const RELAY_URL = process.env.EDUBOX_RELAY_URL;
const RELAY_TOKEN = process.env.EDUBOX_RELAY_TOKEN;

async function relay(caminho, { timeoutMs = 20000 } = {}) {
    if (!RELAY_URL || !RELAY_TOKEN) {
        const e = new Error('EDUBOX_RELAY_URL/EDUBOX_RELAY_TOKEN não configurados no .env.');
        e.status = 500;
        throw e;
    }
    let r;
    try {
        r = await fetch(`${RELAY_URL}${caminho}`, {
            headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (erro) {
        const e = new Error(`Não foi possível falar com o relay do Edubox: ${erro.message}`);
        e.status = 502;
        throw e;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) {
        const e = new Error(j.erro || `Relay respondeu ${r.status}`);
        e.status = j.status || (r.status >= 400 && r.status < 500 ? r.status : 502);
        throw e;
    }
    return j;
}

module.exports = { relay };
