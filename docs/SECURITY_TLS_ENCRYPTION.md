# Security: TLS, encryption-at-rest и key rotation

Документ описывает эксплуатационный порядок включения TLS, первого запуска
шифрования данных и замены ключа шифрования в idmMw.

## TLS connections

TLS включается отдельно для каждого соединения. Глобального `require` режима нет:
администратор явно выбирает, где нужен TLS.

### Inbound API и Admin UI

NestJS listener для IDM API и Admin UI использует один порт. При включении TLS
оба интерфейса переходят на `https://`.

```env
HTTP_TLS_ENABLED=true
HTTP_TLS_CERT_PATH=/etc/idmmw/tls/server.crt
HTTP_TLS_KEY_PATH=/etc/idmmw/tls/server.key
HTTP_TLS_CA_PATH=/etc/idmmw/tls/ca.crt
HTTP_TLS_REQUEST_CLIENT_CERT=false
HTTP_TLS_REJECT_UNAUTHORIZED=true
```

`HTTP_TLS_CERT`, `HTTP_TLS_KEY`, `HTTP_TLS_CA` также могут содержать PEM inline
с `\n`. Private key и PEM значения маскируются в diagnostic/log output.

Admin UI auth включается отдельно от TLS:

```env
ADMIN_UI_ENABLED=true
ADMIN_AUTH_ENABLED=true
ADMIN_AUTH_MODE=local
ADMIN_AUTH_LOCAL_USERNAME=admin
ADMIN_AUTH_LOCAL_PASSWORD=aapm://idmmw-admin-local-credential
ADMIN_AUTH_SESSION_SECRET=aapm://idmmw-admin-session-credential
ADMIN_AUTH_COOKIE_SECURE=true
```

Режимы Admin UI authentication:

- `ADMIN_AUTH_MODE=local`: вход только локальным admin account из env/secret.
  Это обязательный break-glass вариант для первичной настройки RBAC и
  восстановления доступа.
- `ADMIN_AUTH_MODE=sso`: вход только через включенные SSO providers.
  Providers перечисляются в `ADMIN_AUTH_SSO_PROVIDERS`: `header`, `oidc`,
  `saml`.
- `ADMIN_AUTH_MODE=both`: рекомендуемый production режим. SSO используется для
  операторов, local admin сохраняется как break-glass superadmin.

При `HTTP_TLS_ENABLED=true` или `NODE_ENV=production` admin session cookie
становится `Secure` по умолчанию. Для SSO используйте доверенный reverse proxy,
который передает `ADMIN_AUTH_SSO_USER_HEADER` и
`ADMIN_AUTH_SSO_GROUPS_HEADER`; доступ ограничивайте через
`ADMIN_AUTH_ALLOWLIST` или `ADMIN_AUTH_ALLOWED_GROUPS`.
`ADMIN_AUTH_TRUSTED_PROXY_CIDRS` обязателен только для provider `header`, иначе
spoofable SSO headers отклоняются.
`ADMIN_AUTH_ALLOWED_GROUPS` является только allowlist для входа в Admin UI и не
выдает прав на connector types. Права назначаются отдельно в Admin UI `RBAC`:
IdP group мапится на локальную роль, а роль содержит `read`/`write` permissions
по connector type.

Для прямой OIDC-интеграции idmMw сам выполняет Authorization Code + PKCE flow:

```env
ADMIN_AUTH_MODE=both
ADMIN_AUTH_SSO_PROVIDERS=oidc
ADMIN_AUTH_OIDC_ISSUER_URL=https://fam.example.ru
ADMIN_AUTH_OIDC_CLIENT_ID=idmmw
ADMIN_AUTH_OIDC_CLIENT_SECRET=aapm://idmmw-oidc-client-secret
ADMIN_AUTH_OIDC_REDIRECT_URI=https://idmmw.example.ru/auth/oidc/callback
ADMIN_AUTH_OIDC_SCOPES=openid profile email
ADMIN_AUTH_OIDC_USER_CLAIM=sub
ADMIN_AUTH_OIDC_GROUPS_CLAIM=groups
ADMIN_AUTH_ALLOWED_GROUPS=idmmw-admins,idmmw-operators
```

Для прямой SAML-интеграции idmMw выступает SP:

```env
ADMIN_AUTH_MODE=both
ADMIN_AUTH_SSO_PROVIDERS=saml
ADMIN_AUTH_SAML_ENTRYPOINT=https://fam.example.ru/saml/login
ADMIN_AUTH_SAML_ISSUER=https://idmmw.example.ru/saml/metadata
ADMIN_AUTH_SAML_CALLBACK_URL=https://idmmw.example.ru/auth/saml/acs
ADMIN_AUTH_SAML_IDP_ISSUER=https://fam.example.ru/saml
ADMIN_AUTH_SAML_IDP_CERT=aapm://fam-saml-idp-cert
ADMIN_AUTH_SAML_SP_CERT=aapm://idmmw-saml-sp-cert
ADMIN_AUTH_SAML_SP_PRIVATE_KEY=aapm://idmmw-saml-sp-private-key
ADMIN_AUTH_SAML_USER_ATTRIBUTE=nameID
ADMIN_AUTH_SAML_GROUPS_ATTRIBUTE=groups
ADMIN_AUTH_ALLOWED_GROUPS=idmmw-admins,idmmw-operators
```

SAML metadata idmMw публикует на `/auth/saml/metadata`. В Avanpost FAM idmMw
настраивается как application: OpenID Connect application или SAML application.
Не настраивайте idmMw как FAM external IdP source: FAM в этом сценарии является
IdP, idmMw является OIDC client/SAML SP.
SAML ACS принимает только SP-initiated ответы с обязательным валидным
`InResponseTo`; IdP-initiated SSO не поддерживается.
`ADMIN_AUTH_SAML_IDP_ISSUER` проверяется как issuer IdP.
Provider contract для Admin UI: `local`, `header-sso`, `oidc`, `saml`,
`disabled`; legacy `sso` не поддерживается.
Admin auth защищает `/admin/*`; IDM inbound API и `/idm/*` защищаются отдельным
HMAC runtime contract при `INTEGRATION_AUTH_ENABLED=true`. `/health` остаётся
публичным liveness, `/ready` и `/metrics` публикуются по внутреннему runtime
периметру.

### Redis

```env
REDIS_ENABLED=true
REDIS_TLS_ENABLED=true
REDIS_TLS_CA_PATH=/etc/idmmw/tls/redis-ca.crt
REDIS_TLS_CERT_PATH=/etc/idmmw/tls/redis-client.crt
REDIS_TLS_KEY_PATH=/etc/idmmw/tls/redis-client.key
REDIS_TLS_SERVER_NAME=redis.internal
REDIS_TLS_REJECT_UNAUTHORIZED=true
```

### Kafka

```env
KAFKA_ENABLED=true
KAFKA_TLS_ENABLED=true
KAFKA_TLS_CA_PATH=/etc/idmmw/tls/kafka-ca.crt
KAFKA_TLS_CERT_PATH=/etc/idmmw/tls/kafka-client.crt
KAFKA_TLS_KEY_PATH=/etc/idmmw/tls/kafka-client.key
KAFKA_TLS_SERVER_NAME=kafka.internal
KAFKA_TLS_REJECT_UNAUTHORIZED=true
```

### DB connector

PostgreSQL and MySQL receive SSL options through knex. Oracle uses best-effort
TCPS validation and wallet options.

```env
DB_CONNECTOR_TLS_ENABLED=true
DB_CONNECTOR_TLS_CA_PATH=/etc/idmmw/tls/db-ca.crt
DB_CONNECTOR_TLS_CERT_PATH=/etc/idmmw/tls/db-client.crt
DB_CONNECTOR_TLS_KEY_PATH=/etc/idmmw/tls/db-client.key
DB_CONNECTOR_TLS_SERVER_NAME=db.internal
DB_CONNECTOR_TLS_REJECT_UNAUTHORIZED=true

# Oracle only, optional
DB_CONNECTOR_TLS_WALLET_LOCATION=/etc/idmmw/oracle-wallet
DB_CONNECTOR_TLS_WALLET_PASSWORD=secret://oracle-wallet-password
```

For Oracle, `DB_CONNECTOR_URL` must use TCPS, for example
`tcps://host:2484/service` or a descriptor with `PROTOCOL=TCPS`.

### Target systems

Zabbix, CMDBuild, Passwork, REST and fake remote target configs support the
same `tls` object. If `tls.enabled=true`, `baseUrl`/target URL must be
`https://`.

```json
{
  "baseUrl": "https://zabbix.example.com",
  "apiToken": "secret://zabbix-token",
  "tls": {
    "enabled": true,
    "caPath": "/etc/idmmw/tls/zabbix-ca.crt",
    "certPath": "/etc/idmmw/tls/idmmw-client.crt",
    "keyPath": "/etc/idmmw/tls/idmmw-client.key",
    "serverName": "zabbix.example.com",
    "rejectUnauthorized": true
  }
}
```

## Encryption model

When `ENCRYPTION_ENABLED=true`, idmMw encrypts:

- `AuditLog.payload` and `AuditLog.response`
- `DlqItem.payload`
- `TargetSystem.config`
- Kafka message payloads
- idempotency keys through deterministic HMAC

Encryption uses AES-256-GCM. Key material must be base64 for exactly 32 bytes.
Stored envelopes include `kid`, `iv`, `tag` and ciphertext. New writes always
use `ENCRYPTION_ACTIVE_KEY_ID`; reads support every key listed in the keyring.

Recommended keyring format:

```env
ENCRYPTION_ENABLED=true
ENCRYPTION_ACTIVE_KEY_ID=key_2026_06
ENCRYPTION_KEYS=key_2026_06
ENCRYPTION_KEY_KEY_2026_06=secret://idmmw-key-2026-06
SECRETS_PROVIDER=IndeedPamAapm
```

For config-only deployments:

```bash
openssl rand -base64 32
```

```env
ENCRYPTION_ENABLED=true
ENCRYPTION_ACTIVE_KEY_ID=key_2026_06
ENCRYPTION_KEYS=key_2026_06
ENCRYPTION_KEY_KEY_2026_06=<base64-32-byte-key>
```

`ENCRYPTION_KEY` and `ENCRYPTION_KEY_ID` remain accepted for a single-key setup,
but the keyring format is preferred because it supports rotation.

## First encryption enablement

Encryption can be enabled only on a strictly empty system. The startup guard
checks these tables before creating `EncryptionState`:

- `AuditLog`
- `DlqItem`
- `TargetSystem`
- active `IdempotencyKey`

Procedure:

1. Stop all idmMw workers and make sure IDM is not sending events.
2. Apply DB migrations.
3. Verify the system is empty:

```sql
SELECT COUNT(*) FROM "AuditLog";
SELECT COUNT(*) FROM "DlqItem";
SELECT COUNT(*) FROM "TargetSystem";
SELECT COUNT(*) FROM "IdempotencyKey" WHERE "expiresAt" > now();
```

For SQLite, use `CURRENT_TIMESTAMP` instead of `now()`.

4. Generate or provision the key in Indeed PAM.
5. Set encryption env vars.
6. Start one idmMw instance and check logs for
   `Encryption state initialized with active key`.
7. Run a smoke request and verify storage is encrypted:

```sql
SELECT "activeKeyId", "rotationStatus" FROM "EncryptionState";
SELECT "payload" FROM "AuditLog" LIMIT 1;
```

The payload should be an `idmmw.v1` envelope, not raw request JSON.

Fail-fast errors are expected if the system is non-empty, the migration is
missing, a secret reference was not resolved, or the key is not base64 32 bytes.

## Key rotation

Rotation is a maintenance operation. Do not start normal workers with a new
active key until the rotation CLI has completed.

Procedure:

1. Keep the old key in the keyring and add the new key.

```env
ENCRYPTION_ENABLED=true
ENCRYPTION_ACTIVE_KEY_ID=key_2026_07
ENCRYPTION_KEYS=key_2026_06,key_2026_07
ENCRYPTION_KEY_KEY_2026_06=secret://idmmw-key-2026-06
ENCRYPTION_KEY_KEY_2026_07=secret://idmmw-key-2026-07
SECRETS_PROVIDER=IndeedPamAapm
```

2. Stop normal workers or drain traffic.
3. Verify no active work remains:

```sql
SELECT status, COUNT(*) FROM "DlqItem" GROUP BY status;
SELECT COUNT(*) FROM "IdempotencyKey" WHERE "expiresAt" > now();
```

4. If Kafka is enabled, verify consumer lag is zero. The CLI checks Kafka lag
   unless `ENCRYPTION_ROTATION_SKIP_KAFKA_LAG_CHECK=true`.
5. Run rotation:

```bash
npm run security:rotate-key
```

The CLI sets `ENCRYPTION_ROTATION_MODE=true` internally, re-encrypts DB storage
fields with the new active key, and updates `EncryptionState`.

6. Validate:

```sql
SELECT "activeKeyId", "previousKeyIds", "rotationStatus", "rotatedAt"
FROM "EncryptionState";
```

7. Start normal workers with the same keyring.
8. Keep the old key until:
   - DB rotation is completed;
   - Kafka backlog from the old key window is drained;
   - Redis/idempotency TTL window has expired.
9. Remove the old key from the keyring only after those conditions are true.

Rollback is limited: before old-key removal, set
`ENCRYPTION_ACTIVE_KEY_ID` back to the previous key and rerun
`npm run security:rotate-key`. After the old key is removed or Kafka backlog is
drained without the old key available, rollback requires restoring key material.

## Troubleshooting

| Symptom                                          | Cause                                    | Action                                                                |
| ------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `Cannot enable encryption on a non-empty system` | Existing plaintext data                  | Start from empty DB or run a separate migration project               |
| `Encryption key ... is still a secret reference` | PAM resolver did not run                 | Set `SECRETS_PROVIDER=IndeedPamAapm` and PAM connection vars          |
| `must be base64-encoded 32 bytes`                | Wrong key format                         | Generate `openssl rand -base64 32`                                    |
| `active key mismatch`                            | Runtime active key differs from DB state | Run `npm run security:rotate-key` in maintenance                      |
| `URL does not use https://`                      | TLS enabled for HTTP target              | Change target URL to HTTPS or disable target TLS                      |
| TLS certificate mismatch                         | Wrong CA/serverName                      | Check `*_TLS_CA_PATH` and `*_TLS_SERVER_NAME`                         |
| Rotation blocked by Kafka lag                    | Backlog not drained                      | Wait for consumers or explicitly skip only after operational approval |
