const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const { createStorage, VALID_KEY_TYPES } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3000;
const storage = createStorage();

app.use(cors());
app.use(bodyParser.json());

function asyncHandler(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((error) => {
            console.error('BN MENU API error:', error);
            res.status(500).json({
                success: false,
                message: 'Erro interno do servidor!'
            });
        });
    };
}

app.post('/api/validate', asyncHandler(async (req, res) => {
    const { key, hwid } = req.body;

    if (!key || !hwid) {
        return res.status(400).json({
            success: false,
            message: 'Key e HWID sao obrigatorios!'
        });
    }

    const result = await storage.validateKey(key, hwid);
    return res.status(result.statusCode).json(result.body);
}));

app.get('/api/keys', asyncHandler(async (req, res) => {
    const keys = await storage.listKeys();
    return res.json({
        success: true,
        data: keys
    });
}));

app.post('/api/keys/create', asyncHandler(async (req, res) => {
    const { type, quantity } = req.body;
    const normalizedType = String(type || '').trim().toLowerCase();
    const count = Number.parseInt(quantity, 10) || 1;

    if (!normalizedType) {
        return res.status(400).json({
            success: false,
            message: 'Tipo de key e obrigatorio!'
        });
    }

    if (!VALID_KEY_TYPES.includes(normalizedType)) {
        return res.status(400).json({
            success: false,
            message: 'Tipo de key invalido!'
        });
    }

    if (count < 1 || count > 1000) {
        return res.status(400).json({
            success: false,
            message: 'A quantidade deve ficar entre 1 e 1000.'
        });
    }

    const createdKeys = await storage.createKeys(normalizedType, count);

    return res.json({
        success: true,
        message: `${createdKeys.length} key(s) criada(s) com sucesso!`,
        data: createdKeys
    });
}));

app.delete('/api/keys/:key', asyncHandler(async (req, res) => {
    const deleted = await storage.deleteKey(req.params.key);

    if (!deleted) {
        return res.status(404).json({
            success: false,
            message: 'Key nao encontrada!'
        });
    }

    return res.json({
        success: true,
        message: 'Key deletada com sucesso!'
    });
}));

app.post('/api/keys/:key/reset-hwid', asyncHandler(async (req, res) => {
    const reset = await storage.resetKeyHwid(req.params.key);

    if (!reset) {
        return res.status(404).json({
            success: false,
            message: 'Key nao encontrada!'
        });
    }

    return res.json({
        success: true,
        message: 'HWID resetado com sucesso!'
    });
}));

app.delete('/api/keys', asyncHandler(async (req, res) => {
    await storage.deleteAllKeys();
    return res.json({
        success: true,
        message: 'Todas as keys foram deletadas!'
    });
}));

app.delete('/api/keys/type/:type', asyncHandler(async (req, res) => {
    const type = String(req.params.type || '').trim().toLowerCase();
    const deletedCount = await storage.deleteKeysByType(type);

    return res.json({
        success: true,
        message: `${deletedCount} key(s) do tipo "${type}" deletada(s)!`
    });
}));

app.get('/api/stats', asyncHandler(async (req, res) => {
    const stats = await storage.getStats();
    return res.json({
        success: true,
        data: stats
    });
}));

app.get('/', (req, res) => {
    res.json({
        message: 'BN MENU API - Online!',
        version: '1.1.0',
        storage: storage.getMode(),
        endpoints: {
            validate: 'POST /api/validate',
            keys: 'GET /api/keys',
            create: 'POST /api/keys/create',
            delete: 'DELETE /api/keys/:key',
            resetHwid: 'POST /api/keys/:key/reset-hwid',
            deleteAll: 'DELETE /api/keys',
            deleteByType: 'DELETE /api/keys/type/:type',
            stats: 'GET /api/stats'
        }
    });
});

async function start() {
    await storage.init();

    app.listen(PORT, () => {
        console.log(`BN MENU API rodando na porta ${PORT}`);
        console.log(`Storage ativo: ${storage.getMode()}`);
        console.log(`Acesse: http://localhost:${PORT}`);
    });
}

start().catch((error) => {
    console.error('Falha ao iniciar a API:', error);
    process.exit(1);
});
