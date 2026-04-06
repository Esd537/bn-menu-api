const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const { createStorage, VALID_KEY_TYPES } = require('./storage');
const { createSiteStore } = require('./site-store');

const app = express();
const PORT = process.env.PORT || 3000;
const storage = createStorage();
const siteStore = createSiteStore();

app.use(cors());
app.use(bodyParser.json());

function asyncHandler(handler) {
    return (req, res) => {
        Promise.resolve(handler(req, res)).catch((error) => {
            console.error('BN MENU API error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Erro interno do servidor!'
            });
        });
    };
}

function getBearerToken(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
        return '';
    }

    return header.slice('Bearer '.length).trim();
}

function requireAuth(req, res, next) {
    const user = siteStore.getUserFromToken(getBearerToken(req));
    if (!user) {
        return res.status(401).json({
            success: false,
            message: 'Sessao invalida. Faca login novamente.'
        });
    }

    req.user = user;
    return next();
}

function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({
            success: false,
            message: 'Acesso restrito ao administrador.'
        });
    }

    return next();
}

app.post('/api/auth/register', asyncHandler(async (req, res) => {
    const { username, displayName, email, password, confirmPassword } = req.body;

    if (!username || !email || !password || !confirmPassword) {
        return res.status(400).json({
            success: false,
            message: 'Preencha usuario, email, senha e confirmacao.'
        });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({
            success: false,
            message: 'A confirmacao de senha nao confere.'
        });
    }

    if (String(password).length < 6) {
        return res.status(400).json({
            success: false,
            message: 'A senha precisa ter pelo menos 6 caracteres.'
        });
    }

    const result = siteStore.registerLocalUser({
        username,
        displayName,
        email,
        password
    });

    return res.json({
        success: true,
        message: 'Conta criada com sucesso!',
        data: result
    });
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
        return res.status(400).json({
            success: false,
            message: 'Informe usuario/email e senha.'
        });
    }

    const result = siteStore.loginLocalUser({ identifier, password });

    return res.json({
        success: true,
        message: 'Login realizado com sucesso!',
        data: result
    });
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
    return res.json({
        success: true,
        data: {
            user: req.user,
            providers: {
                google: false,
                github: false
            }
        }
    });
}));

app.post('/api/validate', asyncHandler(async (req, res) => {
    const { key, hwid, playerName, playerUserId, gameName, executor } = req.body;

    if (!key || !hwid) {
        return res.status(400).json({
            success: false,
            message: 'Key e HWID sao obrigatorios!'
        });
    }

    const result = await storage.validateKey(key, hwid);

    if (result.statusCode === 200) {
        siteStore.recordScriptActivity({
            key,
            keyType: result.body.data.type,
            playerName,
            playerUserId,
            gameName,
            executor,
            hwid
        });
    }

    return res.status(result.statusCode).json(result.body);
}));

app.get('/api/keys', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const keys = await storage.listKeys();
    return res.json({
        success: true,
        data: keys
    });
}));

app.post('/api/keys/create', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
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

app.delete('/api/keys/:key', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
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

app.post('/api/keys/:key/reset-hwid', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
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

app.delete('/api/keys', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    await storage.deleteAllKeys();
    return res.json({
        success: true,
        message: 'Todas as keys foram deletadas!'
    });
}));

app.delete('/api/keys/type/:type', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const type = String(req.params.type || '').trim().toLowerCase();
    const deletedCount = await storage.deleteKeysByType(type);

    return res.json({
        success: true,
        message: `${deletedCount} key(s) do tipo "${type}" deletada(s)!`
    });
}));

app.get('/api/stats', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const stats = await storage.getStats();
    return res.json({
        success: true,
        data: stats
    });
}));

app.get('/api/admin/activity', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    return res.json({
        success: true,
        data: siteStore.listActivity()
    });
}));

app.get('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    return res.json({
        success: true,
        data: siteStore.listUsers()
    });
}));

app.get('/api/admin/webhook', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    return res.json({
        success: true,
        data: siteStore.getSettings()
    });
}));

app.post('/api/admin/webhook', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const { discordWebhookUrl } = req.body;

    const settings = siteStore.updateSettings({ discordWebhookUrl });
    return res.json({
        success: true,
        message: 'Webhook atualizado com sucesso!',
        data: settings
    });
}));

app.post('/api/admin/webhook/test', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    await siteStore.testWebhook();
    return res.json({
        success: true,
        message: 'Teste de webhook enviado.'
    });
}));

app.get('/', (req, res) => {
    res.json({
        message: 'BN MENU API - Online!',
        version: '2.1.0',
        storage: storage.getMode(),
        auth: 'enabled',
        endpoints: {
            register: 'POST /api/auth/register',
            login: 'POST /api/auth/login',
            me: 'GET /api/auth/me',
            validate: 'POST /api/validate',
            keys: 'GET /api/keys',
            create: 'POST /api/keys/create',
            delete: 'DELETE /api/keys/:key',
            resetHwid: 'POST /api/keys/:key/reset-hwid',
            deleteAll: 'DELETE /api/keys',
            deleteByType: 'DELETE /api/keys/type/:type',
            stats: 'GET /api/stats',
            activity: 'GET /api/admin/activity',
            users: 'GET /api/admin/users'
        }
    });
});

async function start() {
    await Promise.all([
        storage.init(),
        siteStore.init()
    ]);

    app.listen(PORT, () => {
        console.log(`BN MENU API rodando na porta ${PORT}`);
        console.log(`Storage ativo: ${storage.getMode()}`);
        console.log('Portal auth ativo: sim');
        console.log(`Acesse: http://localhost:${PORT}`);
    });
}

start().catch((error) => {
    console.error('Falha ao iniciar a API:', error);
    process.exit(1);
});
