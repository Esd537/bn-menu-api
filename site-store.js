const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, 'users.json');
const ACTIVITY_FILE = path.join(__dirname, 'activity.json');
const SETTINGS_FILE = path.join(__dirname, 'portal-settings.json');

const DEFAULT_SETTINGS = {
    discordWebhookUrl: '',
    updatedAt: null
};

function ensureFile(filePath, defaultValue) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
    }
}

function readJson(filePath, defaultValue) {
    ensureFile(filePath, defaultValue);

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        return defaultValue;
    }
}

function writeJson(filePath, value) {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function createUsernameFromEmail(email, users) {
    const base = normalizeUsername(normalizeEmail(email).split('@')[0])
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, 20) || 'user';
    let candidate = base;
    let counter = 1;

    while (users.some((user) => normalizeUsername(user.username) === candidate)) {
        counter += 1;
        candidate = `${base}${counter}`.slice(0, 24);
    }

    return candidate;
}

function base64UrlEncode(value) {
    return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
    return Buffer.from(value, 'base64url').toString('utf8');
}

function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
    const salt = Buffer.from(saltHex, 'hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${saltHex}:${hash}`;
}

function verifyPassword(password, storedHash) {
    const [algorithm, saltHex, hashHex] = String(storedHash || '').split(':');
    if (algorithm !== 'scrypt' || !saltHex || !hashHex) {
        return false;
    }

    const candidate = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(hashHex, 'hex');

    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function sanitizeUser(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        role: user.role,
        provider: user.provider,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt || null,
        loginCount: user.loginCount || 0
    };
}

function maskIdentifier(value) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        return '-';
    }

    if (normalized.length <= 8) {
        return `${normalized.slice(0, 2)}****${normalized.slice(-2)}`;
    }

    return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

class SiteStore {
    constructor() {
        this.authSecret = process.env.AUTH_SECRET || 'bn-menu-auth-secret';
    }

    async init() {
        ensureFile(USERS_FILE, []);
        ensureFile(ACTIVITY_FILE, []);
        ensureFile(SETTINGS_FILE, DEFAULT_SETTINGS);
        this.ensureAdminUser();
    }

    ensureAdminUser() {
        const users = readJson(USERS_FILE, []);
        const adminUsername = process.env.ADMIN_USERNAME || 'eabn8';
        const adminEmail = process.env.ADMIN_EMAIL || 'eabn8@bnmenu.local';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admchora';

        const adminIndex = users.findIndex((user) => {
            return normalizeUsername(user.username) === normalizeUsername(adminUsername)
                || normalizeEmail(user.email) === normalizeEmail(adminEmail);
        });
        if (adminIndex >= 0) {
            const currentAdmin = users[adminIndex];
            users[adminIndex] = {
                ...currentAdmin,
                username: currentAdmin.username || adminUsername,
                displayName: currentAdmin.displayName || 'Administrador',
                email: normalizeEmail(adminEmail),
                role: 'admin',
                provider: currentAdmin.provider || 'local',
                passwordHash: currentAdmin.passwordHash || hashPassword(adminPassword),
                lastLoginAt: currentAdmin.lastLoginAt || null,
                loginCount: currentAdmin.loginCount || 0
            };
            writeJson(USERS_FILE, users);
            return;
        }

        users.push({
            id: crypto.randomUUID(),
            username: adminUsername,
            displayName: 'Administrador',
            email: normalizeEmail(adminEmail),
            role: 'admin',
            provider: 'local',
            passwordHash: hashPassword(adminPassword),
            createdAt: new Date().toISOString(),
            lastLoginAt: null,
            loginCount: 0
        });

        writeJson(USERS_FILE, users);
    }

    createToken(user) {
        const payload = {
            sub: user.id,
            role: user.role,
            exp: Date.now() + (1000 * 60 * 60 * 24 * 14)
        };
        const encodedPayload = base64UrlEncode(JSON.stringify(payload));
        const signature = crypto.createHmac('sha256', this.authSecret)
            .update(encodedPayload)
            .digest('base64url');

        return `${encodedPayload}.${signature}`;
    }

    verifyToken(token) {
        const [encodedPayload, signature] = String(token || '').split('.');
        if (!encodedPayload || !signature) {
            return null;
        }

        const expectedSignature = crypto.createHmac('sha256', this.authSecret)
            .update(encodedPayload)
            .digest('base64url');

        if (signature !== expectedSignature) {
            return null;
        }

        try {
            const payload = JSON.parse(base64UrlDecode(encodedPayload));
            if (!payload.sub || payload.exp < Date.now()) {
                return null;
            }

            return payload;
        } catch (error) {
            return null;
        }
    }

    getUserById(userId) {
        const users = readJson(USERS_FILE, []);
        return users.find((user) => user.id === userId) || null;
    }

    getUserFromToken(token) {
        const payload = this.verifyToken(token);
        if (!payload) {
            return null;
        }

        const user = this.getUserById(payload.sub);
        if (!user) {
            return null;
        }

        return sanitizeUser(user);
    }

    registerLocalUser({ username, displayName, email, password }) {
        const normalizedEmail = normalizeEmail(email);
        const users = readJson(USERS_FILE, []);
        const normalizedUsername = normalizeUsername(username) || createUsernameFromEmail(normalizedEmail, users);
        const safeDisplayName = String(displayName || '').trim()
            || normalizedUsername
            || normalizedEmail.split('@')[0];

        if (!normalizedEmail || !password) {
            throw new Error('Preencha email e senha.');
        }

        if (users.some((user) => normalizeUsername(user.username) === normalizedUsername)) {
            throw new Error('Esse usuario ja existe.');
        }

        if (users.some((user) => normalizeEmail(user.email) === normalizedEmail)) {
            throw new Error('Esse email ja esta cadastrado.');
        }

        const user = {
            id: crypto.randomUUID(),
            username: normalizedUsername,
            displayName: safeDisplayName,
            email: normalizedEmail,
            role: 'user',
            provider: 'local',
            passwordHash: hashPassword(password),
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString(),
            loginCount: 1
        };

        users.push(user);
        writeJson(USERS_FILE, users);
        this.sendWebhook('Novo cadastro no portal', [
            `Usuario: ${user.username}`,
            `Email: ${user.email}`,
            `Criado em: ${user.createdAt}`
        ]);

        return {
            token: this.createToken(user),
            user: sanitizeUser(user)
        };
    }

    loginLocalUser({ identifier, password }) {
        const normalizedIdentifier = String(identifier || '').trim().toLowerCase();
        const users = readJson(USERS_FILE, []);
        const userIndex = users.findIndex((item) => {
            return normalizeUsername(item.username) === normalizedIdentifier
                || normalizeEmail(item.email) === normalizedIdentifier;
        });
        const user = userIndex >= 0 ? users[userIndex] : null;

        if (!user || !verifyPassword(password, user.passwordHash)) {
            throw new Error('Usuario ou senha invalidos.');
        }

        const now = new Date().toISOString();
        const updatedUser = {
            ...user,
            lastLoginAt: now,
            loginCount: (user.loginCount || 0) + 1
        };
        users[userIndex] = updatedUser;
        writeJson(USERS_FILE, users);

        this.sendWebhook('Login no portal', [
            `Usuario: ${updatedUser.username}`,
            `Role: ${updatedUser.role}`,
            `Entrou em: ${now}`
        ]);

        return {
            token: this.createToken(updatedUser),
            user: sanitizeUser(updatedUser)
        };
    }

    listUsers() {
        const users = readJson(USERS_FILE, []);
        return users
            .map((user) => sanitizeUser(user))
            .sort((left, right) => {
                return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
            });
    }

    updateUserRole(userId, role) {
        const normalizedRole = String(role || '').trim().toLowerCase();
        if (!['admin', 'user'].includes(normalizedRole)) {
            throw new Error('Cargo invalido.');
        }

        const users = readJson(USERS_FILE, []);
        const userIndex = users.findIndex((user) => user.id === userId);
        if (userIndex < 0) {
            throw new Error('Conta nao encontrada.');
        }

        const currentUser = users[userIndex];
        if (currentUser.role === normalizedRole) {
            return sanitizeUser(currentUser);
        }

        if (currentUser.role === 'admin' && normalizedRole !== 'admin') {
            const adminCount = users.filter((user) => user.role === 'admin').length;
            if (adminCount <= 1) {
                throw new Error('Nao e possivel remover o ultimo admin.');
            }
        }

        const updatedUser = {
            ...currentUser,
            role: normalizedRole
        };
        users[userIndex] = updatedUser;
        writeJson(USERS_FILE, users);

        this.sendWebhook('Cargo alterado no portal', [
            `Usuario: ${updatedUser.username}`,
            `Email: ${updatedUser.email}`,
            `Novo cargo: ${updatedUser.role}`
        ]);

        return sanitizeUser(updatedUser);
    }

    listActivity() {
        return readJson(ACTIVITY_FILE, []);
    }

    clearActivity() {
        writeJson(ACTIVITY_FILE, []);
    }

    recordScriptActivity(activity) {
        const currentActivity = readJson(ACTIVITY_FILE, []);
        const entry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            key: String(activity.key || '').trim(),
            keyType: String(activity.keyType || '').trim(),
            playerName: String(activity.playerName || '').trim() || '-',
            playerUserId: activity.playerUserId || '-',
            gameName: String(activity.gameName || '').trim() || '-',
            executor: String(activity.executor || '').trim() || '-',
            hwid: String(activity.hwid || '').trim() || '-',
            hwidMasked: maskIdentifier(activity.hwid)
        };

        currentActivity.unshift(entry);
        writeJson(ACTIVITY_FILE, currentActivity.slice(0, 300));

        this.sendWebhook('Nova atividade do script', [
            `Jogador: ${entry.playerName}`,
            `User ID: ${entry.playerUserId}`,
            `Jogo: ${entry.gameName}`,
            `Executor: ${entry.executor}`,
            `HWID: ${entry.hwidMasked}`,
            `Key: ${entry.key}`
        ]);

        return entry;
    }

    getSettings() {
        const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
        return {
            discordWebhookConfigured: Boolean(settings.discordWebhookUrl),
            discordWebhookUrlPreview: settings.discordWebhookUrl
                ? `${settings.discordWebhookUrl.slice(0, 30)}...`
                : '',
            updatedAt: settings.updatedAt
        };
    }

    updateSettings({ discordWebhookUrl }) {
        const current = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
        const normalizedWebhook = String(discordWebhookUrl || '').trim();
        const nextSettings = {
            ...current,
            discordWebhookUrl: normalizedWebhook,
            updatedAt: new Date().toISOString()
        };

        writeJson(SETTINGS_FILE, nextSettings);
        return this.getSettings();
    }

    async testWebhook() {
        await this.sendWebhook('Teste do painel BN MENU', [
            'Se voce recebeu esta mensagem, o webhook foi salvo corretamente.'
        ]);
    }

    async sendWebhook(title, lines) {
        const settings = readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
        if (!settings.discordWebhookUrl) {
            return;
        }

        try {
            await fetch(settings.discordWebhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    embeds: [{
                        title,
                        description: lines.join('\n'),
                        color: 0x8b5cf6,
                        timestamp: new Date().toISOString()
                    }]
                })
            });
        } catch (error) {
            console.error('Falha ao enviar webhook:', error.message);
        }
    }
}

function createSiteStore() {
    return new SiteStore();
}

module.exports = {
    createSiteStore
};
