// ==========================================================================
// Sessão no AVA (Open LMS / Moodle 5.1) por login e senha — 25/11/2026.
// Só para o que o web service NÃO faz: importar questão no banco (não existe função para isso no Moodle).
// Usado pelo agente do banco do AVA (scripts/ava-banco-med-agente.js), que roda no droplet.
//
// Credencial: AVA_URL + AVA_LOGIN_USUARIO + AVA_LOGIN_SENHA no .env (nunca no código). O usuário é o de integração
// (orbita.integracao), com papel só na categoria MED — NÃO use login de pessoa (autoria e alcance de administrador).
//
// Sem biblioteca de HTML: as páginas são lidas com expressões regulares conferidas no AVA real em 25/11/2026.
// Se o Open LMS mudar a tela, as funções lerXxx() são o lugar de ajustar.
// ==========================================================================
const base = () => String(process.env.AVA_URL || '').trim().replace(/\/+$/, '');
const falha = (msg, extra = {}) => Object.assign(new Error(msg), extra);

const decodificar = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const semTags = (s) => decodificar(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, nome) => { const m = String(tag).match(new RegExp(`\\b${nome}\\s*=\\s*"([^"]*)"`, 'i')); return m ? decodificar(m[1]) : null; };

class SessaoAva {
    constructor() { this.cookies = new Map(); this.sesskey = null; }

    guardarCookies(r) {
        const lista = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
        for (const c of lista) {
            const [par] = c.split(';');
            const i = par.indexOf('=');
            if (i > 0) this.cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
        }
    }
    cabecalhoCookie() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }

    // segue redirecionamento na mão para não perder os cookies de cada resposta
    async req(caminho, { method = 'GET', body = null, tipo = 'texto' } = {}) {
        let url = /^https?:/.test(caminho) ? caminho : `${base()}${caminho}`;
        for (let i = 0; i < 6; i++) {
            const headers = { cookie: this.cabecalhoCookie(), 'user-agent': 'Orbita-Fatec-Integracao' };
            if (body && typeof body === 'string') headers['content-type'] = 'application/x-www-form-urlencoded';
            let r;
            try { r = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(90000) }); } catch (e) { throw falha(`O AVA não respondeu (${e.name === 'TimeoutError' ? 'demorou demais' : e.message}).`); }
            this.guardarCookies(r);
            if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
                url = new URL(r.headers.get('location'), url).toString();
                method = 'GET'; body = null;
                continue;
            }
            const texto = await r.text();
            if (tipo === 'json') { try { return JSON.parse(texto); } catch { throw falha(`O AVA respondeu em formato inesperado (HTTP ${r.status}).`); } }
            if (/sessionwaiterr/.test(texto)) throw falha('O AVA está ocupado com outra requisição desta sessão (sessionwaiterr).', { tentarDeNovo: true });
            return { url, status: r.status, texto };
        }
        throw falha('O AVA redirecionou demais.');
    }

    async entrar() {
        const usuario = String(process.env.AVA_LOGIN_USUARIO || '').trim(), senha = String(process.env.AVA_LOGIN_SENHA || '');
        if (!base() || !usuario || !senha) throw falha('Login do AVA não configurado (AVA_URL / AVA_LOGIN_USUARIO / AVA_LOGIN_SENHA no .env).', { semConfig: true });
        const pag = await this.req('/login/index.php');
        const token = (pag.texto.match(/name="logintoken"\s+value="([^"]+)"/) || [])[1];
        if (!token) throw falha('Não reconheci a tela de login do AVA (sem logintoken).');
        const corpo = new URLSearchParams({ logintoken: token, anchor: '', username: usuario, password: senha }).toString();
        const res = await this.req('/login/index.php', { method: 'POST', body: corpo });
        const sk = (res.texto.match(/"sesskey":"([^"]+)"/) || [])[1];
        if (!sk || /\/login\/index\.php/.test(res.url)) throw falha('O AVA recusou o login do usuário de integração (senha errada, conta bloqueada ou tela de login mudou).', { loginRecusado: true });
        this.sesskey = sk;
        return { sesskey: sk };
    }
}

// ---------- leitura das páginas ----------
// /course/search.php → [{ id, nome }]
function lerCursos(html) {
    const out = [];
    const re = /<h3 class="coursename">\s*<a[^>]*href="[^"]*\/course\/view\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html))) out.push({ id: Number(m[1]), nome: semTags(m[2]) });
    return out;
}
// /mod/quiz/index.php?id= → [{ cmid, nome }]
function lerQuestionarios(html) {
    const out = [];
    const re = /<a[^>]*href="[^"]*\/mod\/quiz\/view\.php\?id=(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    // tira o texto escondido do leitor de tela ("… Questionário") que vem junto no link
    while ((m = re.exec(html))) { const nome = semTags(m[2].replace(/<span[^>]*class="[^"]*(?:accesshide|instancename-type|sr-only)[^"]*"[^>]*>[\s\S]*?<\/span>/g, '')).replace(/\s+Question[aá]rio$/i, ''); if (nome && !out.some(q => q.cmid === Number(m[1]))) out.push({ cmid: Number(m[1]), nome }); }
    return out;
}
// formulário de importação: campos escondidos do form, categorias em árvore e dados do seletor de arquivo
function lerFormImportacao(html) {
    const ini = html.search(/<form[^>]*action="[^"]*importquestions\/import\.php"[^>]*>/);
    if (ini < 0) return null;
    const fim = html.indexOf('</form>', ini);
    const form = html.slice(ini, fim > 0 ? fim : undefined);
    const escondidos = [];
    (form.match(/<input[^>]*>/g) || []).forEach(t => { if (/type="hidden"/i.test(t) && attr(t, 'name')) escondidos.push([attr(t, 'name'), attr(t, 'value') || '']); });
    const sel = (form.match(/<select[^>]*name="category"[^>]*>([\s\S]*?)<\/select>/) || [])[1] || '';
    const pilha = [];
    const categorias = [];
    const reOpt = /<option\s+value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g;
    let m;
    while ((m = reOpt.exec(sel))) {
        const nb = (m[2].match(/^(?:&nbsp;)*/) || [''])[0].length / 6;
        const nivel = Math.round(nb / 3);
        const txt = semTags(m[2]);
        const q = txt.match(/^(.*?)\s*\((\d+)\)$/);
        pilha.length = nivel; pilha[nivel] = q ? q[1] : txt;
        categorias.push({ valor: m[1], caminho: pilha.slice(0, nivel + 1), qtd: q ? Number(q[2]) : 0 });
    }
    // maxbytes vem número (-1, administrador) ou texto ("20971520", usuário de integração: limite de 20 MB por arquivo)
    const fp = html.match(/"itemid":(\d+),"maxbytes":"?-?\d+"?,"context":\{"id":(\d+)/);
    return {
        escondidos, categorias,
        itemid: (escondidos.find(([n]) => n === 'newfile') || [])[1] || (fp && fp[1]) || null,
        contextoId: fp ? fp[2] : null,
        clientId: (html.match(/"client_id":"([a-z0-9]+)","maxfiles"/) || [])[1] || '',
        repoUpload: (html.match(/"id":"(\d+)","name":"[^"]*","type":"upload"/) || [])[1] || null
    };
}
// /mod/quiz/edit.php → questões no questionário (sem o modelo "QUESTAO PARA APAGAR PROFESSORES")
function contarQuestoesNoQuestionario(html) {
    // cada questão é um <li id="slot-N">; "class=...slot" também aparece em modelo escondido da página e contava a mais
    const partes = String(html).split(/<li\b[^>]*\bid="slot-\d+"/).slice(1);
    // o nome da questão fica longe do começo do <li> (no AVA real, ~56 mil caracteres na prova de Patologia Clínica I)
    return partes.filter(p => !/QUESTAO PARA APAGAR/i.test(p.slice(0, 120000))).length;
}
// /mod/quiz/edit.php → o que a Joyce precisa para decidir (25/11/2026): quantas questões, nota máxima,
// soma das notas das questões e o texto de abertura/fechamento que o próprio AVA mostra.
function lerResumoQuestionario(html) {
    const num = (s) => { const n = Number(String(s || '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
    const maxgrade = (String(html).match(/<input[^>]*name="maxgrade"[^>]*value="([^"]*)"/) || [])[1];
    const soma = (String(html).match(/class="mod_quiz_summarks"[^>]*>\s*([\d.,]+)/) || [])[1];
    const status = (String(html).match(/class="quizopeningstatus"[^>]*title="([^"]*)"/) || [])[1];
    const noQuestionario = contarQuestoesNoQuestionario(html);
    return { noQuestionario, notaMaxima: num(maxgrade), somaNotas: num(soma), abertura: status ? semTags(status) : '', ...origemDasQuestoes(html, noQuestionario) };
}
// Quem colocou as questões no questionário (26/11/2026): o Órbita sempre dá o nome "[2ºB 1ªCH 07] Prof. …" ou
// "[EXAME 05] …"; o que tem outro nome foi posto direto no AVA pelo professor. A partir de 26/11 só o Órbita (com a
// coordenação) coloca questões no AVA, e as provas antigas montadas direto lá são trazidas para validar.
const RE_NOME_ORBITA = /^\[\s*(?:\d+\s*[ºo°]\s*B\s+\d+\s*[ªa]\s*CH|EXAME)\s*\d+\s*\]/i;
// A conta vale pelo número de questões do questionário: a página tem outros "questionname" fora da prova (questionário
// vazio aparecia como "0 questões = 0 Órbita + 1 direto" — 26/11/2026).
function origemDasQuestoes(html, noQuestionario) {
    const nomes = [...String(html).matchAll(/<span[^>]*class="[^"]*\bquestionname\b[^"]*"[^>]*>([\s\S]*?)<\/span>/g)].map(m => semTags(m[1]));
    const total = Number.isFinite(noQuestionario) ? noQuestionario : nomes.length;
    const pelaOrbita = Math.min(total, nomes.filter(n => RE_NOME_ORBITA.test(n)).length);
    return { pelaOrbita, direto: Math.max(0, total - pelaOrbita) };
}
// resposta do POST da importação
function lerResultadoImportacao(html) {
    const erro = (html.match(/<div[^>]*class="[^"]*(?:alert-danger|notifyproblem|errorbox)[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const n = (html.match(/Importando\s+(\d+)\s+quest/i) || html.match(/Importing\s+(\d+)\s+question/i) || [])[1];
    return { erro: erro ? semTags(erro).slice(0, 400) : null, importando: n ? Number(n) : null };
}

module.exports = { SessaoAva, lerCursos, lerQuestionarios, lerFormImportacao, contarQuestoesNoQuestionario, lerResumoQuestionario, lerResultadoImportacao, semTags };
