// Plano de Ação — o que cada atividade "deve" em cada período e se está
// feita, atrasada ou a fazer. Mesma conta pra tela do coordenador e pro
// painel da Direção (o servidor só guarda as marcas).
//
//   diário    → obrigação fixa da rotina (atender aluno, recepção da noite...):
//               só referência, não se marca nem conta atraso (21/10/2026)
//   semanal   → período = segunda da semana; prazo = sexta
//   mensal    → período = "AAAA-MM"; prazo = último dia letivo do mês
//   bimestral/semestral/anual → cada prazo do semestre (calendário do
//               Edubox ou lançado pela Direção); sem prazo = pendência de data
//   a_definir → sem periodicidade no documento: pendência
//
// Só conta a partir de `inicioAcompanhamento` (pedido 21/10/2026: "deste mês
// pra frente") e até o fim do semestre.

export const PERIODICIDADE_LABEL = {
  diario: 'Diária', semanal: 'Semanal', mensal: 'Mensal', bimestral: 'Bimestral',
  semestral: 'Semestral', anual: 'Anual', a_definir: 'Sem periodicidade'
};
export const COM_PRAZO = ['bimestral', 'semestral', 'anual', 'a_definir'];
// rotina fixa: aparece como "obrigações diárias", fora da conta de feito/atrasado
export const ROTINA = ['diario'];
export const conta = (a) => a.ativo !== false && !ROTINA.includes(a.periodicidade);

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dia = (s) => { const [a, m, d] = s.split('-').map(Number); return new Date(a, m - 1, d); };
const somaDias = (s, n) => { const d = dia(s); d.setDate(d.getDate() + n); return iso(d); };

export const segundaDa = (s) => { const d = dia(s); const w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return iso(d); };

export function letivo(sem, s) {
  const w = dia(s).getDay();
  return w !== 0 && w !== 6 && !(sem.naoLetivos || {})[s];
}

function diasLetivos(sem, de, ate) {
  const out = [];
  for (let s = de; s <= ate; s = somaDias(s, 1)) if (letivo(sem, s)) out.push(s);
  return out;
}

function ultimoLetivoDoMes(sem, mes) {
  const d = dia(`${mes}-01`); d.setMonth(d.getMonth() + 1); d.setDate(0);
  for (let s = iso(d); s.startsWith(mes); s = somaDias(s, -1)) if (letivo(sem, s)) return s;
  return iso(d);
}

const inicioConta = (sem) => (sem.inicioAcompanhamento > sem.inicio ? sem.inicioAcompanhamento : sem.inicio);

// Períodos da atividade no semestre (do início do acompanhamento ao fim do
// semestre): [{ periodo, prazo, rotulo }]. Os futuros também vêm (status "a fazer").
export function periodosDa(atv, sem) {
  const de = inicioConta(sem), ate = sem.fim;
  if (atv.periodicidade === 'diario') {
    return diasLetivos(sem, de, ate).map(d => ({ periodo: d, prazo: d, rotulo: fmtData(d) }));
  }
  if (atv.periodicidade === 'semanal') {
    const out = [];
    for (let seg = segundaDa(de); seg <= ate; seg = somaDias(seg, 7)) {
      const sex = somaDias(seg, 4);
      // semana inteira sem aula (recesso) não cobra
      if (!diasLetivos(sem, seg, sex).length || sex < de) continue;
      out.push({ periodo: seg, prazo: sex > ate ? ate : sex, rotulo: `semana de ${fmtData(seg).slice(0, 5)} a ${fmtData(sex).slice(0, 5)}` });
    }
    return out;
  }
  if (atv.periodicidade === 'mensal') {
    const out = [];
    for (let m = de.slice(0, 7); m <= ate.slice(0, 7); m = somaDias(`${m}-01`, 32).slice(0, 7)) {
      const prazo = ultimoLetivoDoMes(sem, m);
      out.push({ periodo: m, prazo: prazo > ate ? ate : prazo, rotulo: nomeMes(m) });
    }
    return out;
  }
  return ((sem.prazos || {})[atv.id] || [])
    .filter(p => p.data >= de)
    .map(p => ({ periodo: p.data, prazo: p.data, rotulo: `até ${fmtData(p.data)}`, evento: p.evento || null, origem: p.origem }));
}

// pendência de data: atividade que precisa de prazo e não tem nenhum no semestre
export function semPrazo(atv, sem) {
  return COM_PRAZO.includes(atv.periodicidade) && !((sem.prazos || {})[atv.id] || []).length;
}

export function status(atv, p, marcas, hoje) {
  const m = marcas[`${atv.id}|${p.periodo}`];
  if (m) return { tipo: 'feito', marca: m };
  if (p.prazo < hoje) return { tipo: 'atrasado' };
  return { tipo: 'afazer' };
}

// Resumo de um coordenador até hoje: devidos (prazo já chegou), feitos,
// atrasados, por periodicidade e no total.
export function resumo(atividades, sem, marcas, hoje) {
  const r = { total: { devidos: 0, feitos: 0, atrasados: 0 }, por: {}, pendenciasData: 0 };
  atividades.filter(conta).forEach(a => {
    if (semPrazo(a, sem)) { r.pendenciasData++; return; }
    const por = r.por[a.periodicidade] = r.por[a.periodicidade] || { devidos: 0, feitos: 0, atrasados: 0 };
    periodosDa(a, sem).forEach(p => {
      if (p.prazo > hoje) { if (marcas[`${a.id}|${p.periodo}`]) { por.feitos++; r.total.feitos++; por.devidos++; r.total.devidos++; } return; }
      por.devidos++; r.total.devidos++;
      if (marcas[`${a.id}|${p.periodo}`]) { por.feitos++; r.total.feitos++; } else { por.atrasados++; r.total.atrasados++; }
    });
  });
  return r;
}

export const pct = (x) => (x.devidos ? Math.round(x.feitos / x.devidos * 100) : null);

export function fmtData(s) {
  if (!s) return '';
  const [a, m, d] = s.split('-');
  return `${d}/${m}/${a}`;
}
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export function nomeMes(m) { const [a, mm] = m.split('-'); return `${MESES[Number(mm) - 1]} de ${a}`; }
export { somaDias };
