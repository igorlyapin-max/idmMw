# Secrets Map

This file lists secret classes and rotation responsibilities without values.

| Flow ID | Secret / credential class | Stored in | Used by | Rotation trigger / frequency | Safe handling |
| --- | --- | --- | --- | --- | --- |
| IF-001, IF-002, IF-010 | `INTEGRATION_AUTH_SECRET` | deployment secret source / PAM reference | HMAC auth for IDM-facing endpoints and protected metrics | platform policy; rotate on exposure or IDM integration rollover | never commit; verify all IDM callers updated |
| IF-003 | `ADMIN_AUTH_LOCAL_PASSWORD` | deployment secret source / PAM reference | local admin login | human access policy; rotate on staff change/exposure | production should use strong value or SSO |
| IF-003 | `ADMIN_AUTH_SESSION_SECRET` | deployment secret source / PAM reference | admin session cookie signing | rotate on exposure; coordinated restart required | invalidates sessions |
| IF-003 | SSO trusted headers/groups | reverse proxy config | admin SSO mode | proxy/IdP policy | require trusted proxy CIDR allowlist |
| IF-006 | per-target connector credentials | encrypted `TargetSystem.config` or secret references | connectors | per target system policy | `ENCRYPTION_ENABLED=true` before storing secrets |
| IF-006 | DB connector credentials | env/config or `TargetSystem.config` | DB connector | DB policy | use TLS settings where required |
| IF-007 | `REDIS_PASSWORD`, `REDIS_TLS_*` | deployment secret source | Redis client | Redis policy | no inline values in docs |
| IF-004, IF-005 | `KAFKA_TLS_CA_PATH`, `KAFKA_TLS_CERT_PATH`, `KAFKA_TLS_KEY_PATH` | Docker/Kubernetes secrets or secure mounts | Kafka client | certificate lifecycle | mount read-only; no private key in git |
| IF-008 | `DATABASE_URL` | deployment env/secret source | Prisma | DB policy | placeholders only in committed templates |
| IF-011 | PAM/AAPM application token | deployment secret source | secret resolver | PAM policy | prefer header transport; do not log token |
| IF-008, IF-004 | `ENCRYPTION_KEY_*`, `ENCRYPTION_ACTIVE_KEY_ID` | deployment secret source / PAM reference | encryption service | planned key rotation or emergency revocation | base64 32-byte keys; rotation in maintenance mode |
| IF-009 | HTTP TLS cert/key/CA | Docker/Kubernetes secrets or secure mounts | inbound HTTPS listener | certificate lifecycle | private keys never committed |

Rotation notes:

- Encryption key rotation uses `npm run security:rotate-key` in maintenance
  mode and checks Kafka lag unless explicitly skipped.
- Customer CA files used for image build are not runtime secrets, but real CA
  artifacts and fingerprints must not be committed.
- `apt/debian.sources` must not contain mirror credentials; use build-host proxy
  settings, Docker daemon configuration or approved CI secret injection.
