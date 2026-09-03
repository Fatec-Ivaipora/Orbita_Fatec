/**
 * orbita-assistente.js — helper usado pelo Claude para CRIAR, sob pedido do
 * Paulo Henrique (adm_l1 / setor TI), dois tipos de registro no Órbita, direto
 * no Firestore via Admin SDK (mesmo padrão dos outros scripts/*.js):
 *
 *   1) ATIVIDADE  (coleção `atividades`)  — tarefa avulsa do Kanban, podendo
 *      ser atribuída a uma ou várias pessoas.
 *   2) AVISO DE SETOR (coleção `avisos`)  — post-it do mural de um setor.
 *   3) AVISO INSTITUCIONAL (coleção `notices`) — recado que aparece pra todos.
 *
 * NÃO edita nem apaga nada — só cria. Espelha exatamente o formato de
 * documento que a API (src/rotas/processos.js e src/rotas/meu-espaco.js)
 * gravaria, pra ficar 100% compatível com o painel web.
 *
 * USO:
 *   node scripts/orbita-assistente.js <caminho-do-payload.json>
 *
 * O payload é um JSON. Sem "confirmar": true ele só PRÉ-VISUALIZA (não grava).
 *
 * Exemplos de payload:
 *   { "tipo": "atividade", "titulo": "Trocar toner LAB-20",
 *     "descricao": "Impressora da sala travando", "prazo": "2026-08-29 14:00",
 *     "para": ["Junior", "Mateus"], "confirmar": true }
 *
 *   { "tipo": "aviso", "setor": "ti", "cor": "azul",
 *     "texto": "Manutenção da rede sexta 18h", "confirmar": true }
 *
 *   { "tipo": "notice", "titulo": "Recesso", "texto": "Sem expediente 07/09",
 *     "confirmar": true }
 */
const fs = require('fs');
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Identidade de quem cria (Paulo Henrique) — resolvida pelo e-mail pra não
// depender de UID hard-coded caso a conta mude.
const EU_EMAIL = 'suporte.ava@fatecivaipora.com.br';
const CORES_AVISO = ['amarelo', 'rosa', 'azul', 'verde', 'laranja'];

// "2026-08-29 14:00" (horário de Ivaiporã, UTC-3) -> ISO UTC, igual ao que o
// front grava (new Date(datetime-local).toISOString()).
function prazoParaISO(str) {
  if (!str) throw new Error('Informe o "prazo" (dia e horário) da atividade.');
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) throw new Error(`Prazo inválido: "${str}". Use "AAAA-MM-DD HH:MM".`);
  const [, y, mo, d, h, mi] = m;
  const iso = new Date(`${y}-${mo}-${d}T${h}:${mi}:00-03:00`).toISOString();
  return iso;
}

async function carregarUsuarios() {
  const snap = await db.collection('users').get();
  const users = [];
  snap.forEach(doc => users.push({ uid: doc.id, ...doc.data() }));
  return users;
}

// Resolve um termo ("Junior", email ou uid) para um usuário ativo. Casa por
// uid exato, e-mail exato, ou nome (case-insensitive, começa-com / contém).
function resolverPessoa(termo, users) {
  const t = String(termo).trim().toLowerCase();
  let u = users.find(x => x.uid === termo);
  if (!u) u = users.find(x => (x.email || '').toLowerCase() === t);
  if (!u) {
    const nome = users.filter(x => (x.name || '').toLowerCase() === t);
    if (nome.length === 1) u = nome[0];
  }
  if (!u) {
    const cand = users.filter(x => (x.name || '').toLowerCase().startsWith(t));
    if (cand.length === 1) u = cand[0];
    else if (cand.length > 1) throw new Error(`"${termo}" é ambíguo: ${cand.map(c => c.name).join(', ')}. Seja mais específico.`);
  }
  if (!u) {
    const cont = users.filter(x => (x.name || '').toLowerCase().includes(t));
    if (cont.length === 1) u = cont[0];
    else if (cont.length > 1) throw new Error(`"${termo}" casa com vários: ${cont.map(c => c.name).join(', ')}. Seja mais específico.`);
  }
  if (!u) throw new Error(`Não encontrei ninguém chamado "${termo}".`);
  if (u.ativo === false) throw new Error(`"${u.name}" está inativo — não dá pra atribuir.`);
  return u;
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) throw new Error('Passe o caminho do JSON: node scripts/orbita-assistente.js payload.json');
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

  const users = await carregarUsuarios();
  const eu = users.find(x => (x.email || '').toLowerCase() === EU_EMAIL);
  if (!eu) throw new Error(`Não achei o usuário criador (${EU_EMAIL}) no Órbita.`);
  const euNome = eu.name || eu.email;
  const confirmar = payload.confirmar === true;
  const now = new Date().toISOString();

  if (payload.tipo === 'atividade') {
    const titulo = (payload.titulo || '').trim();
    if (!titulo) throw new Error('Informe o "titulo" da atividade.');
    const prazoISO = prazoParaISO(payload.prazo);

    const termos = Array.isArray(payload.para) ? payload.para
      : (payload.para ? [payload.para] : [eu.uid]);
    const alvos = [...new Map(termos.map(t => {
      const u = resolverPessoa(t, users);
      return [u.uid, u];
    })).values()];

    const base = {
      titulo,
      descricao: (payload.descricao || '').trim(),
      prazo: prazoISO,
      status: 'a_fazer',
      historico: [],
      criadoPor: eu.uid,
      criadoPorNome: euNome,
      concluidoEm: null,
      createdAt: now,
      updatedAt: now
    };

    let doc;
    if (alvos.length === 1) {
      doc = { ...base, uid: alvos[0].uid, setorId: alvos[0].setorId || null };
    } else {
      doc = { ...base, atribuidos: alvos.map(a => a.uid), setorId: null };
    }

    console.log('── ATIVIDADE ──────────────────────────────');
    console.log('Título   :', titulo);
    console.log('Descrição:', doc.descricao || '(vazia)');
    console.log('Prazo    :', payload.prazo, '=>', prazoISO, '(UTC)');
    console.log('Para     :', alvos.map(a => `${a.name} [${a.setorId || 'sem setor'}]`).join(', '));
    console.log('Criado por:', euNome);
    console.log(alvos.length > 1 ? '(atividade COLETIVA — doc compartilhado)' : '(atividade individual)');

    if (!confirmar) { console.log('\n⚠️  PRÉVIA — nada foi gravado. Adicione "confirmar": true para criar.'); return; }
    const ref = await db.collection('atividades').add(doc);
    console.log('\n✅ Atividade criada. ID:', ref.id);
    return;
  }

  if (payload.tipo === 'aviso') {
    const texto = (payload.texto || '').trim();
    if (!texto) throw new Error('Escreva o "texto" do aviso.');
    const setor = (payload.setor || '').trim();
    if (!setor) throw new Error('Informe o "setor" do aviso (ex.: ti, financeiro, secretaria, rh, saude, admin).');
    const cor = CORES_AVISO.includes(payload.cor) ? payload.cor : CORES_AVISO[0];
    const doc = { setorId: setor, texto, cor, autorUid: eu.uid, autorNome: euNome, createdAt: now };

    console.log('── AVISO DE SETOR (mural) ─────────────────');
    console.log('Setor :', setor);
    console.log('Cor   :', cor);
    console.log('Texto :', texto);
    console.log('Autor :', euNome);

    if (!confirmar) { console.log('\n⚠️  PRÉVIA — nada foi gravado. Adicione "confirmar": true para criar.'); return; }
    const ref = await db.collection('avisos').add(doc);
    console.log('\n✅ Aviso de setor criado. ID:', ref.id);
    return;
  }

  if (payload.tipo === 'notice') {
    const texto = (payload.texto || '').trim();
    if (!texto && !payload.titulo) throw new Error('Escreva ao menos "titulo" ou "texto" do aviso institucional.');
    const doc = {
      titulo: (payload.titulo || '').trim(),
      texto,
      createdAt: now,
      updatedAt: now,
      createdBy: eu.uid
    };

    console.log('── AVISO INSTITUCIONAL (todos veem) ───────');
    console.log('Título:', doc.titulo || '(sem título)');
    console.log('Texto :', texto || '(vazio)');
    console.log('Autor :', euNome);

    if (!confirmar) { console.log('\n⚠️  PRÉVIA — nada foi gravado. Adicione "confirmar": true para criar.'); return; }
    const ref = await db.collection('notices').add(doc);
    console.log('\n✅ Aviso institucional criado. ID:', ref.id);
    return;
  }

  throw new Error(`"tipo" inválido: ${payload.tipo}. Use "atividade", "aviso" ou "notice".`);
}

main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message); process.exit(1); });
