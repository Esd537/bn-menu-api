const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATA_FILE = path.join(__dirname, 'keys.json');
const VALID_KEY_TYPES = ['daily', 'weekly', 'monthly', 'lifetime', 'dev'];

const TYPE_NAMES = {
    daily: 'diaria',
    weekly: 'semanal',
    monthly: 'mensal',
    lifetime: 'vitalicia',
    dev: 'dev'
};

const MAX_DEVICES_BY_TYPE = {
    daily: 1,
    weekly: 2,
    monthly: 3,
    lifetime: 5,
    dev: 999
};

function getExpiryTime(type) {
    const times = {
        daily: 86400000,
        weekly: 604800000,
        monthly: 2592000000,
        lifetime: Infinity,
        dev: Infinity
    };
    return times[type] || 0;
}

function ensureJsonFile() {
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2));
    }
}

function readJsonKeys() {
    ensureJsonFile();

    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (error) {
        return {};
    }
}

function writeJsonKeys(keys) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(keys, null, 2));
}

function mapRowToKey(row) {
    return {
        type: row.key_type,
        created: new Date(row.created_at).toISOString(),
        user: row.user_id,
        active: row.active,
        devices: Array.isArray(row.devices) ? row.devices : [],
        maxDevices: row.max_devices
    };
}

function createKeyValue(type) {
    const prefix = TYPE_NAMES[type];
    const random = Math.random().toString(36).slice(2, 15);
    return `${prefix}-${random}`;
}

function buildKeyData(type) {
    return {
        type,
        created: new Date().toISOString(),
        user: null,
        active: true,
        devices: [],
        maxDevices: MAX_DEVICES_BY_TYPE[type]
    };
}

function buildValidationPayload(keyData) {
    const created = new Date(keyData.created);
    const expiryTime = getExpiryTime(keyData.type);
    const expiry = new Date(created.getTime() + expiryTime);
    const devices = keyData.devices || [];
    const maxDevices = keyData.maxDevices || 1;

    return {
        success: true,
        message: 'Key valida!',
        data: {
            type: keyData.type,
            expiresAt: expiryTime === Infinity ? null : expiry.toISOString(),
            devices: devices.length,
            maxDevices
        }
    };
}

function computeStats(keysById) {
    const keyList = Object.values(keysById);
    const now = new Date();

    let active = 0;
    let expired = 0;

    keyList.forEach((key) => {
        const created = new Date(key.created);
        const expiryTime = getExpiryTime(key.type);
        const expiry = new Date(created.getTime() + expiryTime);

        if (expiryTime === Infinity || expiry > now) {
            active += 1;
        } else {
            expired += 1;
        }
    });

    return {
        total: keyList.length,
        active,
        expired,
        uniqueUsers: new Set(keyList.map((item) => item.user).filter(Boolean)).size
    };
}

class JsonStorage {
    getMode() {
        return 'json';
    }

    async init() {
        ensureJsonFile();
    }

    async listKeys() {
        return readJsonKeys();
    }

    async validateKey(key, hwid) {
        const keys = readJsonKeys();
        const keyData = keys[key];

        if (!keyData) {
            return {
                statusCode: 404,
                body: {
                    success: false,
                    message: 'Key invalida!'
                }
            };
        }

        const created = new Date(keyData.created);
        const expiryTime = getExpiryTime(keyData.type);
        const expiry = new Date(created.getTime() + expiryTime);
        const now = new Date();

        if (expiryTime !== Infinity && expiry < now) {
            return {
                statusCode: 403,
                body: {
                    success: false,
                    message: 'Key expirada!'
                }
            };
        }

        const devices = keyData.devices || [];
        const maxDevices = keyData.maxDevices || 1;

        if (!devices.includes(hwid)) {
            if (devices.length >= maxDevices) {
                return {
                    statusCode: 403,
                    body: {
                        success: false,
                        message: `Limite de dispositivos atingido! (${devices.length}/${maxDevices})`
                    }
                };
            }

            devices.push(hwid);
            keyData.devices = devices;
            keyData.user = hwid;
            keys[key] = keyData;
            writeJsonKeys(keys);
        }

        return {
            statusCode: 200,
            body: buildValidationPayload(keyData)
        };
    }

    async createKeys(type, quantity) {
        const keys = readJsonKeys();
        const createdKeys = [];

        for (let index = 0; index < quantity; index += 1) {
            let key = createKeyValue(type);

            while (keys[key]) {
                key = createKeyValue(type);
            }

            keys[key] = buildKeyData(type);
            createdKeys.push(key);
        }

        writeJsonKeys(keys);
        return createdKeys;
    }

    async deleteKey(key) {
        const keys = readJsonKeys();
        if (!keys[key]) {
            return false;
        }

        delete keys[key];
        writeJsonKeys(keys);
        return true;
    }

    async resetKeyHwid(key) {
        const keys = readJsonKeys();
        if (!keys[key]) {
            return false;
        }

        keys[key].devices = [];
        keys[key].user = null;
        writeJsonKeys(keys);
        return true;
    }

    async deleteAllKeys() {
        writeJsonKeys({});
    }

    async deleteKeysByType(type) {
        const keys = readJsonKeys();
        let deletedCount = 0;

        Object.keys(keys).forEach((key) => {
            if (keys[key].type === type) {
                delete keys[key];
                deletedCount += 1;
            }
        });

        writeJsonKeys(keys);
        return deletedCount;
    }

    async getStats() {
        return computeStats(readJsonKeys());
    }
}

class PostgresStorage {
    constructor(databaseUrl) {
        this.pool = new Pool({
            connectionString: databaseUrl,
            ssl: process.env.DATABASE_SSL === 'true'
                ? { rejectUnauthorized: false }
                : undefined
        });
    }

    getMode() {
        return 'postgres';
    }

    async init() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS bn_menu_keys (
                license_key TEXT PRIMARY KEY,
                key_type TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                user_id TEXT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                devices JSONB NOT NULL DEFAULT '[]'::jsonb,
                max_devices INTEGER NOT NULL DEFAULT 1
            )
        `);

        await this.migrateFromJsonIfNeeded();
    }

    async migrateFromJsonIfNeeded() {
        const countResult = await this.pool.query('SELECT COUNT(*)::int AS total FROM bn_menu_keys');
        if (countResult.rows[0].total > 0) {
            return;
        }

        const keys = readJsonKeys();
        const entries = Object.entries(keys);
        if (entries.length === 0) {
            return;
        }

        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            for (const [licenseKey, data] of entries) {
                await client.query(
                    `
                        INSERT INTO bn_menu_keys (
                            license_key,
                            key_type,
                            created_at,
                            user_id,
                            active,
                            devices,
                            max_devices
                        )
                        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                        ON CONFLICT (license_key) DO NOTHING
                    `,
                    [
                        licenseKey,
                        data.type,
                        data.created,
                        data.user || null,
                        data.active !== false,
                        JSON.stringify(data.devices || []),
                        data.maxDevices || 1
                    ]
                );
            }

            await client.query('COMMIT');
            console.log(`Migradas ${entries.length} key(s) de keys.json para Postgres.`);
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async listKeys() {
        const result = await this.pool.query(`
            SELECT license_key, key_type, created_at, user_id, active, devices, max_devices
            FROM bn_menu_keys
            ORDER BY created_at DESC
        `);

        const keys = {};
        result.rows.forEach((row) => {
            keys[row.license_key] = mapRowToKey(row);
        });

        return keys;
    }

    async validateKey(key, hwid) {
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                    SELECT license_key, key_type, created_at, user_id, active, devices, max_devices
                    FROM bn_menu_keys
                    WHERE license_key = $1
                    FOR UPDATE
                `,
                [key]
            );

            if (result.rowCount === 0) {
                await client.query('ROLLBACK');
                return {
                    statusCode: 404,
                    body: {
                        success: false,
                        message: 'Key invalida!'
                    }
                };
            }

            const keyData = mapRowToKey(result.rows[0]);
            const created = new Date(keyData.created);
            const expiryTime = getExpiryTime(keyData.type);
            const expiry = new Date(created.getTime() + expiryTime);
            const now = new Date();

            if (expiryTime !== Infinity && expiry < now) {
                await client.query('ROLLBACK');
                return {
                    statusCode: 403,
                    body: {
                        success: false,
                        message: 'Key expirada!'
                    }
                };
            }

            const devices = keyData.devices || [];
            const maxDevices = keyData.maxDevices || 1;

            if (!devices.includes(hwid)) {
                if (devices.length >= maxDevices) {
                    await client.query('ROLLBACK');
                    return {
                        statusCode: 403,
                        body: {
                            success: false,
                            message: `Limite de dispositivos atingido! (${devices.length}/${maxDevices})`
                        }
                    };
                }

                devices.push(hwid);
                keyData.devices = devices;
                keyData.user = hwid;

                await client.query(
                    `
                        UPDATE bn_menu_keys
                        SET devices = $2::jsonb, user_id = $3
                        WHERE license_key = $1
                    `,
                    [key, JSON.stringify(devices), hwid]
                );
            }

            await client.query('COMMIT');
            return {
                statusCode: 200,
                body: buildValidationPayload(keyData)
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async createKeys(type, quantity) {
        const client = await this.pool.connect();
        const createdKeys = [];

        try {
            await client.query('BEGIN');

            for (let index = 0; index < quantity; index += 1) {
                let inserted = false;

                while (!inserted) {
                    const key = createKeyValue(type);
                    const data = buildKeyData(type);

                    const result = await client.query(
                        `
                            INSERT INTO bn_menu_keys (
                                license_key,
                                key_type,
                                created_at,
                                user_id,
                                active,
                                devices,
                                max_devices
                            )
                            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
                            ON CONFLICT (license_key) DO NOTHING
                            RETURNING license_key
                        `,
                        [
                            key,
                            data.type,
                            data.created,
                            data.user,
                            data.active,
                            JSON.stringify(data.devices),
                            data.maxDevices
                        ]
                    );

                    if (result.rowCount === 1) {
                        createdKeys.push(key);
                        inserted = true;
                    }
                }
            }

            await client.query('COMMIT');
            return createdKeys;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async deleteKey(key) {
        const result = await this.pool.query(
            'DELETE FROM bn_menu_keys WHERE license_key = $1',
            [key]
        );
        return result.rowCount === 1;
    }

    async resetKeyHwid(key) {
        const result = await this.pool.query(
            `
                UPDATE bn_menu_keys
                SET devices = '[]'::jsonb, user_id = NULL
                WHERE license_key = $1
            `,
            [key]
        );
        return result.rowCount === 1;
    }

    async deleteAllKeys() {
        await this.pool.query('TRUNCATE TABLE bn_menu_keys');
    }

    async deleteKeysByType(type) {
        const result = await this.pool.query(
            'DELETE FROM bn_menu_keys WHERE key_type = $1',
            [type]
        );
        return result.rowCount;
    }

    async getStats() {
        const keys = await this.listKeys();
        return computeStats(keys);
    }
}

function createStorage() {
    if (process.env.DATABASE_URL) {
        return new PostgresStorage(process.env.DATABASE_URL);
    }

    return new JsonStorage();
}

module.exports = {
    createStorage,
    VALID_KEY_TYPES
};
