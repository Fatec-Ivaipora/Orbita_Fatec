const express = require('express');
const router = express.Router();
const { db } = require('../firebase');
const verifyToken = require('../middlewares/auth');
const custosGcp = require('../utils/custos-gcp');
const custosDigitalOcean = require('../utils/custos-digitalocean');

const checkPermission = verifyToken.requireModulePermission('custos-ti');

// GET /api/custos-ti/resumo — cards do topo: gasto do mês atual e do mês
// anterior, por fonte (Órbita, SIGMA, DigitalOcean).
router.get('/resumo', verifyToken, checkPermission, async (req, res) => {
    try {
        const [gcp, digitalOcean] = await Promise.all([
            custosGcp.resumoMensal(),
            custosDigitalOcean.resumoMensal()
        ]);
        res.json({ gcp, digitalOcean });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/custos-ti/historico?periodo=... — três modos:
//   30d (padrão) -> diário, últimos 30 dias
//   5m / 12m     -> mensal, comparar os últimos N meses lado a lado
//   AAAA-MM      -> diário, só dentro daquele mês específico (drill-down)
const PERIODOS_FIXOS = {
    '30d': { dias: 30 },
    '5m': { meses: 5 },
    '12m': { meses: 12 }
};
router.get('/historico', verifyToken, checkPermission, async (req, res) => {
    try {
        const periodo = req.query.periodo || '30d';
        const opcoes = PERIODOS_FIXOS[periodo] || (/^\d{4}-\d{2}$/.test(periodo) ? { mes: periodo } : PERIODOS_FIXOS['30d']);
        const [gcp, digitalOcean] = await Promise.all([
            custosGcp.historico(opcoes),
            custosDigitalOcean.historicoFaturas()
        ]);
        res.json({ gcp, digitalOcean });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/custos-ti/uso?dias=30 — uso diário do Órbita, robô (ODTech) x
// humano, e por módulo — instrumentação própria (ver src/middlewares/auth.js,
// registrarUso), não depende de nenhuma credencial externa.
router.get('/uso', verifyToken, checkPermission, async (req, res) => {
    try {
        const dias = Math.min(Number(req.query.dias) || 30, 90);
        const hoje = new Date();
        const datasPedidas = [];
        for (let i = dias - 1; i >= 0; i--) {
            const d = new Date(hoje);
            d.setDate(d.getDate() - i);
            datasPedidas.push(d.toISOString().slice(0, 10));
        }
        const refs = datasPedidas.map(dia => db.collection('custos_ti_uso').doc(dia));
        const docs = await db.getAll(...refs);
        const porData = {};
        docs.forEach(doc => { if (doc.exists) porData[doc.id] = doc.data(); });
        const serie = datasPedidas.map(dia => {
            const d = porData[dia] || {};
            return {
                dia,
                total: d.total || 0,
                robo: (d.porOrigem && d.porOrigem.robo) || 0,
                humano: (d.porOrigem && d.porOrigem.humano) || 0,
                porModulo: d.porModulo || {}
            };
        });
        res.json({ serie });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
