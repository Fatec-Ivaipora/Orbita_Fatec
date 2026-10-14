// Rótulos T1/T2/T3... por coorte de ingresso, pra cursos onde o nome de turma
// do Edubox muda a cada semestre (ex.: Medicina — a mesma turma que entrou em
// 2024/2 aparece como "MEDICINA 2 - 2024/2" num semestre e "MEDICINA 4 -
// 2024/2" dois semestres depois, com um codtur novo toda vez). O que não muda
// é o semestre de ingresso, no fim do nome — é essa parte que identifica a
// coorte de verdade, não o codtur nem o número inicial.
//
// Portado de cpa-fatec/src/turma-labels.js: lá o mapa vivia em
// data/rotulos-turma.json (disco local do servidor); aqui vive em
// config/cpa_rotulos_turma no Firestore, porque o Vercel não tem disco
// persistente entre invocações.
const DOC = 'config/cpa_rotulos_turma';

// Mesma extração usada na participação pra ordenar turma — reaproveitada
// aqui como chave estável da coorte (ano*10+semestre de ingresso).
function extrairEntrada(nomeTurma) {
    const m = /(\d{4})[/-](\d)\s*$/.exec(nomeTurma || '');
    if (!m) return null;
    return Number(m[1]) * 10 + Number(m[2]);
}

// Rotula as turmas de um curso com T1/T2/T3... por coorte de ingresso. Cursos
// sem mapeamento configurado não são afetados (retorna null pra cada turma,
// mantém o nome original do Edubox). Coortes novas (nunca vistas) recebem o
// próximo número disponível automaticamente, na ordem em que ingressaram —
// isso grava de volta no Firestore (só quando há coorte nova pra atribuir).
async function rotularTurmas(db, codcur, nomesTurma) {
    const ref = db.doc(DOC);
    const snap = await ref.get();
    const mapa = snap.exists ? (snap.data() || {}) : {};
    if (!mapa[codcur]) return nomesTurma.map(() => null);

    const porCurso = mapa[codcur];
    const resultado = new Array(nomesTurma.length).fill(null);
    const pendentes = [];

    nomesTurma.forEach((nome, idx) => {
        const entrada = extrairEntrada(nome);
        if (entrada === null) return; // não segue o padrão -> mantém nome original
        const chave = String(entrada);
        if (porCurso[chave]) {
            resultado[idx] = porCurso[chave];
        } else {
            pendentes.push({ idx, chave, entrada });
        }
    });

    if (pendentes.length > 0) {
        const numerosExistentes = Object.values(porCurso)
            .map(t => Number(String(t).replace('T', '')))
            .filter(n => !Number.isNaN(n));
        let proximoNumero = numerosExistentes.length > 0 ? Math.max(...numerosExistentes) + 1 : 1;

        pendentes.sort((a, b) => a.entrada - b.entrada); // ordem cronológica de ingresso
        for (const p of pendentes) {
            const label = `T${proximoNumero}`;
            porCurso[p.chave] = label;
            resultado[p.idx] = label;
            proximoNumero++;
        }
        await ref.set({ [codcur]: porCurso }, { merge: true });
    }

    return resultado;
}

module.exports = { rotularTurmas };
