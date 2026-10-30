#!/bin/bash
# Instala/atualiza a rota /comercial/* do Órbita no relay do Edubox (endereços pra rota de coleta — 27/10/2026).
# Colar INTEIRO no Web Console do droplet (DigitalOcean), como root. Só mexe no bloco do Órbita; não toca no SIGMA.
# Desfazer: cp /opt/edubox-relay/server.mjs.bak-comercial /opt/edubox-relay/server.mjs && systemctl restart edubox-relay
set -e
cd /opt/edubox-relay
cp server.mjs server.mjs.bak-comercial
cat > /tmp/bloco-comercial.mjs <<'BLOCO'
function comResponder(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(corpo) });
  res.end(corpo);
}

const COM_NOME_SQL = (col) => `regexp_replace(regexp_replace(translate(upper(trim(${col})), 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'AAAAAEEEEIIIIOOOOOUUUUCN'), '[^A-Z0-9 ]+', ' ', 'g'), ' +', ' ', 'g')`;

async function comEnderecos(semestres, nomes) {
  const client = novoClient();
  try {
    await client.connect();
    await client.query('set search_path=ivp,public;');
    const r = await client.query(`
      select distinct on (cl.codcli)
             trim(cl.nomcli) nome, trim(coalesce(cl.endcli, '')) rua, trim(coalesce(cl.numcli::text, '')) numero,
             trim(coalesce(cl.baicli, '')) bairro, trim(coalesce(mu.nommun, '')) cidade,
             trim(coalesce(cl.uf_cli, mu.uf_mun, '')) uf, trim(coalesce(cl.cepcli, '')) cep, t.semtur sem
        from tac_matricula m
        join tac_turma t on t.codtur = m.turmat
        join tac_curso c on c.codcur = t.curtur
        join tfi_cliente cl on cl.codcli = m.climat
        left join sis_municipio mu on mu.codmun = cl.muncli
       where t.semtur = any($1) and trim(${COM_NOME_SQL('cl.nomcli')}) = any($2)
       order by cl.codcli, t.semtur desc`, [semestres, nomes]);
    return { ok: true, alunos: r.rows };
  } catch (e) {
    return { ok: false, erro: e.message };
  } finally {
    try { await client.end(); } catch (e) { /* já fechado */ }
  }
}

async function rotaOrbitaComercial(req, res) {
  const u = new URL(req.url, 'http://relay');
  if (!u.pathname.startsWith('/comercial/')) return false;
  if (!autenticadoOrbita(req)) { comResponder(res, 401, { ok: false, erro: 'nao autorizado' }); return true; }
  if (req.method !== 'GET') { comResponder(res, 405, { ok: false, erro: 'so GET' }); return true; }
  if (u.pathname === '/comercial/ping') { comResponder(res, 200, { ok: true, rotas: 'comercial', versao: 2 }); return true; }
  if (u.pathname === '/comercial/enderecos') {
    const semestres = String(u.searchParams.get('semestres') || '').split(',').map(s => s.trim()).filter(s => /^\d{4}[/-][12]$/.test(s)).slice(0, 4);
    const nomes = [...new Set(String(u.searchParams.get('nomes') || '').split('|').map(n => n.trim().toUpperCase()).filter(n => /^[A-Z0-9 ]{3,150}$/.test(n)))];
    if (!semestres.length) { comResponder(res, 400, { ok: false, erro: 'semestres invalidos' }); return true; }
    if (!nomes.length || nomes.length > 40) { comResponder(res, 400, { ok: false, erro: 'informe de 1 a 40 nomes' }); return true; }
    const r = await comEnderecos(semestres, nomes);
    comResponder(res, r.ok ? 200 : 500, r);
    return true;
  }
  comResponder(res, 404, { ok: false, erro: 'rota' });
  return true;
}
BLOCO
node -e '
const fs = require("fs");
let s = fs.readFileSync("server.mjs", "utf8");
const bloco = fs.readFileSync("/tmp/bloco-comercial.mjs", "utf8");
const MARCA = "// ---- Órbita — Comercial";
const FIM = "// ---- fim Órbita — Comercial ----";
const a = s.indexOf("const server = http.createServer(");
if (a < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
const m = s.indexOf(MARCA), f = s.indexOf(FIM);
if (m >= 0 && f > m && f < a) {
  s = s.slice(0, m) + MARCA + " (v1) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(f + FIM.length + 1);
  console.log("bloco atualizado");
} else {
  const g = s.indexOf("if (!autenticado(req))", a);
  if (g < 0) { console.error("ANCORA NAO ENCONTRADA - nada foi alterado"); process.exit(1); }
  const ini = s.lastIndexOf("\n", g) + 1, recuo = s.slice(ini, g);
  s = s.slice(0, ini) + recuo + "if (await rotaOrbitaComercial(req, res)) return; // Órbita — Comercial\n" + s.slice(ini);
  // antes do bloco da Automação AVA (o instalador dela troca tudo do marcador dela até o createServer)
  const ava = s.indexOf("// ---- Órbita — Automação AVA"), p = ava >= 0 && ava < a ? ava : a;
  s = s.slice(0, p) + MARCA + " (v1) ----\n" + bloco + "\n" + FIM + "\n" + s.slice(p);
  console.log("bloco inserido");
}
fs.writeFileSync("server.mjs", s);
'
node --check server.mjs && chown relay:relay server.mjs && systemctl restart edubox-relay && sleep 2 && systemctl is-active edubox-relay
TOKEN=$(grep -E '^ORBITA_TOKEN=' /opt/edubox-relay/.env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s "http://localhost:8443/comercial/ping" -H "Authorization: Bearer $TOKEN"; echo
curl -s "http://localhost:8443/comercial/enderecos?semestres=2027/1,2027-1" -H "Authorization: Bearer $TOKEN" | head -c 60; echo " ..."
