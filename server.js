// ==================== BN MENU - API BACKEND ====================
// Arquivo: server.js
// Instalar dependências: npm install express cors body-parser

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Arquivo de dados
const DATA_FILE = path.join(__dirname, 'keys.json');

// Inicializar arquivo de dados
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

// Função para ler keys
function readKeys() {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        return {};
    }
}

// Função para salvar keys
function saveKeys(keys) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2));
}

// Função para calcular tempo de expiração
function getExpiryTime(type) {
    const times = {
        'daily': 86400000,      // 24 horas
        'weekly': 604800000,    // 7 dias
        'monthly': 2592000000,  // 30 dias
        'lifetime': Infinity,
        'dev': Infinity
    };
    return times[type] || 0;
}

// ==================== ROTAS DA API ====================

// 1. Validar Key
app.post('/api/validate', (req, res) => {
    const { key, hwid } = req.body;
    
    if (!key || !hwid) {
        return res.status(400).json({
            success: false,
            message: '❌ Key e HWID são obrigatórios!'
        });
    }
    
    const keys = readKeys();
    const keyData = keys[key];
    
    if (!keyData) {
        return res.status(404).json({
            success: false,
            message: '❌ Key inválida!'
        });
    }
    
    // Verificar expiração
    const created = new Date(keyData.created);
    const expiryTime = getExpiryTime(keyData.type);
    const expiry = new Date(created.getTime() + expiryTime);
    const now = new Date();
    
    if (expiry < now && expiryTime !== Infinity) {
        return res.status(403).json({
            success: false,
            message: '⏳ Key expirada!'
        });
    }
    
    // Verificar dispositivos
    const devices = keyData.devices || [];
    const maxDevices = keyData.maxDevices || 1;
    
    if (!devices.includes(hwid)) {
        if (devices.length >= maxDevices) {
            return res.status(403).json({
                success: false,
                message: `❌ Limite de dispositivos atingido! (${devices.length}/${maxDevices})`
            });
        }
        
        // Adicionar novo dispositivo
        devices.push(hwid);
        keyData.devices = devices;
        keyData.user = hwid;
        keys[key] = keyData;
        saveKeys(keys);
    }
    
    // Key válida
    return res.json({
        success: true,
        message: '✅ Key válida!',
        data: {
            type: keyData.type,
            expiresAt: expiryTime === Infinity ? null : expiry.toISOString(),
            devices: devices.length,
            maxDevices: maxDevices
        }
    });
});

// 2. Listar todas as keys (Admin)
app.get('/api/keys', (req, res) => {
    const keys = readKeys();
    return res.json({
        success: true,
        data: keys
    });
});

// 3. Criar nova key (Admin)
app.post('/api/keys/create', (req, res) => {
    const { type, quantity } = req.body;
    
    if (!type) {
        return res.status(400).json({
            success: false,
            message: '❌ Tipo de key é obrigatório!'
        });
    }
    
    const keys = readKeys();
    const createdKeys = [];
    const count = quantity || 1;
    
    const maxDevicesByType = {
        'daily': 1,
        'weekly': 2,
        'monthly': 3,
        'lifetime': 5,
        'dev': 999
    };
    
    for (let i = 0; i < count; i++) {
        const typeNames = {
            'daily': 'diaria',
            'weekly': 'semanal',
            'monthly': 'mensal',
            'lifetime': 'vitalicia',
            'dev': 'dev'
        };
        
        const prefix = typeNames[type];
        const random = Math.random().toString(36).substring(2, 15);
        const key = `${prefix}-${random}`;
        
        keys[key] = {
            type: type,
            created: new Date().toISOString(),
            user: null,
            active: true,
            devices: [],
            maxDevices: maxDevicesByType[type]
        };
        
        createdKeys.push(key);
    }
    
    saveKeys(keys);
    
    return res.json({
        success: true,
        message: `✅ ${count} key(s) criada(s) com sucesso!`,
        data: createdKeys
    });
});

// 4. Deletar key (Admin)
app.delete('/api/keys/:key', (req, res) => {
    const { key } = req.params;
    const keys = readKeys();
    
    if (!keys[key]) {
        return res.status(404).json({
            success: false,
            message: '❌ Key não encontrada!'
        });
    }
    
    delete keys[key];
    saveKeys(keys);
    
    return res.json({
        success: true,
        message: '✅ Key deletada com sucesso!'
    });
});

// 5. Resetar HWID (Admin)
app.post('/api/keys/:key/reset-hwid', (req, res) => {
    const { key } = req.params;
    const keys = readKeys();
    
    if (!keys[key]) {
        return res.status(404).json({
            success: false,
            message: '❌ Key não encontrada!'
        });
    }
    
    keys[key].devices = [];
    keys[key].user = null;
    saveKeys(keys);
    
    return res.json({
        success: true,
        message: '✅ HWID resetado com sucesso!'
    });
});

// 6. Deletar todas as keys (Admin)
app.delete('/api/keys', (req, res) => {
    saveKeys({});
    
    return res.json({
        success: true,
        message: '✅ Todas as keys foram deletadas!'
    });
});

// 7. Deletar keys por tipo (Admin)
app.delete('/api/keys/type/:type', (req, res) => {
    const { type } = req.params;
    const keys = readKeys();
    
    let deletedCount = 0;
    Object.keys(keys).forEach(key => {
        if (keys[key].type === type) {
            delete keys[key];
            deletedCount++;
        }
    });
    
    saveKeys(keys);
    
    return res.json({
        success: true,
        message: `✅ ${deletedCount} key(s) do tipo "${type}" deletada(s)!`
    });
});

// 8. Estatísticas (Admin)
app.get('/api/stats', (req, res) => {
    const keys = readKeys();
    const keyList = Object.values(keys);
    const now = new Date();
    
    let active = 0;
    let expired = 0;
    
    keyList.forEach(key => {
        const created = new Date(key.created);
        const expiryTime = getExpiryTime(key.type);
        const expiry = new Date(created.getTime() + expiryTime);
        
        if (expiry > now || expiryTime === Infinity) {
            active++;
        } else {
            expired++;
        }
    });
    
    const uniqueUsers = new Set(keyList.map(k => k.user).filter(u => u)).size;
    
    return res.json({
        success: true,
        data: {
            total: keyList.length,
            active: active,
            expired: expired,
            uniqueUsers: uniqueUsers
        }
    });
});

// Rota de teste
app.get('/', (req, res) => {
    res.json({
        message: '🎮 BN MENU API - Online!',
        version: '1.0.0',
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

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 BN MENU API rodando na porta ${PORT}`);
    console.log(`📡 Acesse: http://localhost:${PORT}`);
});
