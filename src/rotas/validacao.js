const express = require('express');
const router = express.Router();
const { db } = require('../firebase');

// GET /api/validacao/:uid - Consulta pública de status do usuário
router.get('/:uid', async (req, res) => {
    try {
        const snap = await db.collection('users').doc(req.params.uid).get();
        if (!snap.exists) {
            return res.status(404).json({ valid: false, message: 'Usuário não encontrado' });
        }
        
        const userData = snap.data();
        if (userData.ativo === false) {
            return res.status(403).json({ 
                valid: false, 
                message: 'Funcionário inativo/desativado',
                name: userData.name
            });
        }

        // Se não tiver o campo "ativo" false, assumimos ativo ou se tiver ativo: true.
        res.json({
            valid: true,
            name: userData.name,
            role: userData.role,
            fotoUrl: userData.fotoUrl || null,
            message: 'Cartão Válido'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
