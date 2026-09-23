/**
 * Script para criar atividades de LAB BLOQUEADO no Órbita
 * para todas as semanas de segunda a quinta até 18/12/2026.
 *
 * Uso: node scripts/criar-bloqueios-labs.js
 *      (rode no seu terminal, NÃO via Claude — Firestore precisa de conexão direta)
 */
const admin = require('firebase-admin');
const serviceAccount = require('../serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ─── Configurações ───────────────────────────────────────────────────────────
const EMAIL_ADMIN = 'suporte.ava@fatecivaipora.com.br';

// Hora local do bloqueio (noite = 19:00 BRT = 22:00 UTC)
const HORA_UTC = 22;
const MIN_UTC  = 0;

// Período
const DATA_INICIO = new Date('2026-09-22T00:00:00-03:00'); // hoje (seg)
const DATA_FIM    = new Date('2026-12-18T00:00:00-03:00'); // última sexta

// ─── Atividades por dia da semana ─────────────────────────────────────────────
// Cada entrada: { titulo, descricao }
const BLOQUEIOS = {
  // Segunda-feira (0 = Dom, 1 = Seg no JS)
  1: [
    {
      titulo: 'LAB-12 INF – BLOQUEADO (noite)',
      descricao: 'Toda segunda-feira o LAB-12 INF já está ocupado por aula presencial fixa ' +
        '(Ciências Contábeis, turma 1 e 2). Não reservar este laboratório às ' +
        'segundas-feiras à noite. Válido até dezembro de 2026.',
    },
    {
      titulo: 'LAB-20 – BLOQUEADO (noite)',
      descricao: 'Toda segunda-feira o LAB-20 já está ocupado por aula presencial fixa ' +
        '(Arquitetura, turma 2). Não reservar este laboratório às ' +
        'segundas-feiras à noite. Válido até dezembro de 2026.',
    },
  ],
  // Terça-feira
  2: [
    {
      titulo: 'LAB-12 INF – BLOQUEADO (noite)',
      descricao: 'Toda terça-feira o LAB-12 INF já está ocupado por aula presencial fixa ' +
        '(Ciências Contábeis, turmas 3 e 4; Gestão RH, turmas 1, 2, 3 e 4). ' +
        'Não reservar este laboratório às terças-feiras à noite. Válido até dezembro de 2026.',
    },
    {
      titulo: 'LAB-20 – BLOQUEADO (noite)',
      descricao: 'Toda terça-feira o LAB-20 já está ocupado por aula presencial fixa ' +
        '(Eng. Civil, turmas 2 e 3). Não reservar este laboratório às ' +
        'terças-feiras à noite. Válido até dezembro de 2026.',
    },
  ],
  // Quarta-feira
  3: [
    {
      titulo: 'LAB-20 – BLOQUEADO (noite)',
      descricao: 'Toda quarta-feira o LAB-20 já está ocupado por aula presencial fixa ' +
        '(Arquitetura, turma 6). Não reservar este laboratório às ' +
        'quartas-feiras à noite. Válido até dezembro de 2026.',
    },
  ],
  // Quinta-feira
  4: [
    {
      titulo: 'LAB-20 – BLOQUEADO (noite)',
      descricao: 'Toda quinta-feira o LAB-20 já está ocupado por aula presencial fixa ' +
        '(Arquitetura, turma 6). Não reservar este laboratório às ' +
        'quintas-feiras à noite. Válido até dezembro de 2026.',
    },
  ],
  // Sexta-feira (5): sem bloqueio recorrente definido — adicione se necessário
};

// ─── Lógica principal ─────────────────────────────────────────────────────────
async function main() {
  // 1. Buscar usuário admin pelo e-mail
  console.log(`🔍 Buscando usuário ${EMAIL_ADMIN}...`);
  const userSnap = await db.collection('users').where('email', '==', EMAIL_ADMIN).limit(1).get();
  if (userSnap.empty) {
    // Tenta pelo campo 'emailPadrao' ou UID direto
    console.error('❌ Usuário não encontrado pela coleção users. Verifique o e-mail ou ajuste a query.');
    process.exit(1);
  }
  const userDoc = userSnap.docs[0];
  const uid = userDoc.id;
  const userData = userDoc.data();
  const nome = userData.nome || userData.name || userData.email || EMAIL_ADMIN;
  const setorId = userData.setorId || null;
  console.log(`✅ Usuário: ${nome} (uid=${uid}, setorId=${setorId})\n`);

  // 2. Gerar todas as datas de seg-qui no intervalo
  const atividades = [];
  const cursor = new Date(DATA_INICIO);
  cursor.setUTCHours(HORA_UTC, MIN_UTC, 0, 0);

  while (cursor <= DATA_FIM) {
    // getDay() usa fuso local do servidor; usamos UTC + offset BRT
    const diaSemanaLocal = ((cursor.getUTCDay())); // BRT = UTC-3, mas as datas já foram criadas em UTC
    const bloqueiosDoDia = BLOQUEIOS[diaSemanaLocal];
    if (bloqueiosDoDia) {
      for (const b of bloqueiosDoDia) {
        atividades.push({ ...b, prazo: cursor.toISOString() });
      }
    }
    // Avança 1 dia
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  console.log(`📋 Total de atividades a criar: ${atividades.length}`);

  // 3. Inserir em lotes (Firestore limita 500 por batch)
  const LOTE = 400;
  let criadas = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < atividades.length; i += LOTE) {
    const batch = db.batch();
    const slice = atividades.slice(i, i + LOTE);
    for (const at of slice) {
      const docRef = db.collection('atividades').doc();
      batch.set(docRef, {
        titulo: at.titulo,
        descricao: at.descricao,
        prazo: at.prazo,
        status: 'a_fazer',
        historico: [],
        criadoPor: uid,
        criadoPorNome: nome,
        uid,
        setorId,
        concluidoEm: null,
        tipo: 'semanal',
        fixo: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    await batch.commit();
    criadas += slice.length;
    console.log(`  ✔ Lote enviado: ${criadas}/${atividades.length}`);
  }

  console.log(`\n🎉 Concluído! ${criadas} atividades de bloqueio criadas no Órbita.`);
  process.exit(0);
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
