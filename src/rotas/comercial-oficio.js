const { admin, db } = require('../firebase');

// ==========================================
// OFÍCIO DO AGENDAMENTO (Comercial) — Aulões e Palestras (21/10/2026). O
// colégio/instituição manda um ofício pedindo a atividade; fica anexado ao
// agendamento junto com O QUE foi solicitado e QUANDO, pra consulta depois.
//
// Arquivo no Firebase Storage (bucket privado, modo produção): o navegador
// sobe direto pro Storage por um link assinado de 10 min (não passa pelo
// Vercel, que limita o corpo a ~4,5 MB) e depois confirma aqui; pra ver, o
// servidor devolve outro link assinado de 5 min. No agendamento fica só o
// resumo (`oficio`), então a listagem não pesa.
// ==========================================
const BUCKET = process.env.FIREBASE_STORAGE_BUCKET || 'orbita-fatecivp.firebasestorage.app';
const MAX_BYTES = 20 * 1024 * 1024;
const TIPOS = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

const bucket = () => admin.storage().bucket(BUCKET);
const texto = (v, max = 200) => (v ?? '').toString().trim().slice(0, max);
const data = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const nomeDeArquivo = (v) => texto(v, 120).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-') || 'oficio';

// Vai junto do formulário do agendamento (POST/PUT).
function camposSolicitacao(body) {
    return {
        solicitacaoData: data(body.solicitacaoData),
        solicitacaoTexto: texto(body.solicitacaoTexto, 1000)
    };
}

// Ao excluir o agendamento (ou trocar o arquivo).
async function apagarArquivo(oficio) {
    if (oficio && oficio.caminho) await bucket().file(oficio.caminho).delete({ ignoreNotFound: true });
}

function montarRotas(router, { col, verifyToken, checkPermission }) {
    const quemFez = (req) => req.user.name || req.user.email || '';
    const pasta = (id) => `comercial/${col}/${id}/`;

    async function agendamento(req, res) {
        const ref = db.collection(col).doc(req.params.id);
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ error: 'Agendamento não encontrado.' }); return null; }
        return { ref, atual: snap.data() };
    }

    // POST /:id/oficio/envio { nome, mimeType, tamanho } — link pro navegador subir o arquivo.
    router.post('/:id/oficio/envio', verifyToken, checkPermission, async (req, res) => {
        try {
            if (!(await agendamento(req, res))) return;
            const { mimeType } = req.body;
            const tamanho = Number(req.body.tamanho);
            if (!TIPOS.includes(mimeType)) return res.status(400).json({ error: 'Envie o ofício em PDF ou foto (JPG/PNG).' });
            if (!(tamanho > 0) || tamanho > MAX_BYTES) return res.status(400).json({ error: 'Arquivo muito grande (máx. 20 MB).' });
            const caminho = `${pasta(req.params.id)}${Date.now()}-${nomeDeArquivo(req.body.nome)}`;
            const [url] = await bucket().file(caminho).getSignedUrl({
                version: 'v4', action: 'write', expires: Date.now() + 10 * 60 * 1000, contentType: mimeType
            });
            res.json({ url, caminho });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // PUT /:id/oficio { caminho, nome } — confirma o arquivo que acabou de subir.
    router.put('/:id/oficio', verifyToken, checkPermission, async (req, res) => {
        try {
            const ag = await agendamento(req, res);
            if (!ag) return;
            const caminho = texto(req.body.caminho, 400);
            if (!caminho.startsWith(pasta(req.params.id)) || caminho.includes('..')) return res.status(400).json({ error: 'Arquivo inválido.' });
            const arquivo = bucket().file(caminho);
            const [existe] = await arquivo.exists();
            if (!existe) return res.status(400).json({ error: 'O arquivo não chegou ao servidor. Tente de novo.' });
            const [meta] = await arquivo.getMetadata();
            const tamanho = Number(meta.size);
            if (!TIPOS.includes(meta.contentType) || tamanho > MAX_BYTES) {
                await arquivo.delete({ ignoreNotFound: true });
                return res.status(400).json({ error: 'Arquivo inválido (PDF ou foto, até 20 MB).' });
            }
            if (ag.atual.oficio && ag.atual.oficio.caminho !== caminho) await apagarArquivo(ag.atual.oficio);
            const agora = new Date().toISOString();
            const oficio = { nome: texto(req.body.nome, 150) || 'oficio', mimeType: meta.contentType, tamanho, caminho, enviadoEm: agora, enviadoPor: quemFez(req) };
            await ag.ref.update({ oficio, updatedAt: agora, updatedBy: quemFez(req) });
            res.json({ oficio });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // GET /:id/oficio — link de 5 min pra abrir o arquivo.
    router.get('/:id/oficio', verifyToken, checkPermission, async (req, res) => {
        try {
            const ag = await agendamento(req, res);
            if (!ag) return;
            const oficio = ag.atual.oficio;
            if (!oficio) return res.status(404).json({ error: 'Esse agendamento não tem ofício anexado.' });
            const [url] = await bucket().file(oficio.caminho).getSignedUrl({
                version: 'v4', action: 'read', expires: Date.now() + 5 * 60 * 1000,
                responseDisposition: `inline; filename="${nomeDeArquivo(oficio.nome)}"`
            });
            res.json({ ...oficio, url });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.delete('/:id/oficio', verifyToken, checkPermission, async (req, res) => {
        try {
            const ag = await agendamento(req, res);
            if (!ag) return;
            await apagarArquivo(ag.atual.oficio);
            await ag.ref.update({ oficio: null, updatedAt: new Date().toISOString(), updatedBy: quemFez(req) });
            res.json({ message: 'Ofício removido.' });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });
}

module.exports = { montarRotas, camposSolicitacao, apagarArquivo };
