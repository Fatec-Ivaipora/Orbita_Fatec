// ==========================================================================
// Cliente do AVA (Open LMS / Moodle) por web service REST — 24/11/2026.
// Usado pelo Portfólio Reflexivo da Medicina para buscar as entregas da Tarefa e lançar a nota + feedback.
//
// Credencial: AVA_URL e AVA_WS_TOKEN no .env (e nas variáveis do Vercel). O token é do usuário
// "orbita.integracao" no serviço "Órbita Medicina" (só 5 funções; papel ws_orbita_med só na categoria MED).
// O token NUNCA vai para o navegador: os arquivos dos alunos passam pelo Órbita (proxy) — ver baixarArquivo().
// ==========================================================================
const base = () => String(process.env.AVA_URL || '').trim().replace(/\/+$/, '');
const token = () => String(process.env.AVA_WS_TOKEN || '').trim();
const configurado = () => !!(base() && token());

const falha = (status, msg) => Object.assign(new Error(msg), { status });

// Moodle quer arrays/objetos como chave[0][campo]=valor
function achatar(obj, prefixo = '', out = new URLSearchParams()) {
    Object.entries(obj || {}).forEach(([k, v]) => {
        const chave = prefixo ? `${prefixo}[${k}]` : k;
        if (v && typeof v === 'object') achatar(v, chave, out);
        else if (v !== undefined && v !== null) out.append(chave, String(v));
    });
    return out;
}

async function ws(funcao, params = {}) {
    if (!configurado()) throw falha(503, 'A integração com o AVA não está configurada (AVA_URL / AVA_WS_TOKEN).');
    const corpo = achatar(params);
    corpo.append('wstoken', token());
    corpo.append('wsfunction', funcao);
    corpo.append('moodlewsrestformat', 'json');
    let r;
    try {
        r = await fetch(`${base()}/webservice/rest/server.php`, { method: 'POST', body: corpo, signal: AbortSignal.timeout(30000) });
    } catch (e) { throw falha(502, `O AVA não respondeu (${e.name === 'TimeoutError' ? 'demorou demais' : e.message}).`); }
    const j = await r.json().catch(() => null);
    if (!j) throw falha(502, `O AVA respondeu em formato inesperado (HTTP ${r.status}).`);
    if (j.exception) throw falha(502, `AVA: ${j.message || j.errorcode}`);
    return j;
}

// Só aceita arquivo de envio de Tarefa do próprio AVA (nada de URL arbitrária no proxy)
const RE_ARQ = /^\/webservice\/pluginfile\.php\/\d+\/assignsubmission_file\/submission_files\/\d+\/.+/;
function caminhoDoArquivo(fileurl) {
    const b = base();
    const u = String(fileurl || '');
    if (!b || !u.startsWith(`${b}/`)) return null;
    const p = u.slice(b.length).split('?')[0];
    return RE_ARQ.test(p) ? p : null;
}
async function baixarArquivo(caminho) {
    if (!RE_ARQ.test(String(caminho || ''))) throw falha(400, 'Arquivo inválido.');
    let r;
    try {
        r = await fetch(`${base()}${caminho}?token=${encodeURIComponent(token())}`, { signal: AbortSignal.timeout(60000) });
    } catch (e) { throw falha(502, `Não consegui baixar o arquivo do AVA (${e.message}).`); }
    if (!r.ok) throw falha(502, `O AVA recusou o arquivo (HTTP ${r.status}).`);
    const tipo = r.headers.get('content-type') || 'application/octet-stream';
    if (/json/.test(tipo)) throw falha(502, 'O AVA recusou o arquivo (sem permissão para baixar).');
    return { tipo, bytes: Buffer.from(await r.arrayBuffer()) };
}

module.exports = { ws, configurado, caminhoDoArquivo, baixarArquivo };
