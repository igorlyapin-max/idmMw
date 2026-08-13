# Карта секретов

Этот файл перечисляет классы секретов и ответственность за rotation без
значений секретов.

| ID потока | Класс secret / credential | Где хранится | Где используется | Триггер/частота rotation | Правила безопасного обращения |
| --- | --- | --- | --- | --- | --- |
| IF-001, IF-002, IF-010 | `INTEGRATION_AUTH_SECRET` | deployment secret source / PAM reference | HMAC auth для IDM-facing endpoints и protected metrics | platform policy; rotate on exposure или IDM integration rollover | не commit'ить; проверять обновление всех IDM callers |
| IF-003 | `ADMIN_AUTH_LOCAL_PASSWORD` | deployment secret source / PAM reference | local admin login | human access policy; rotate on staff change/exposure | production должен использовать strong value или SSO |
| IF-003 | `ADMIN_AUTH_SESSION_SECRET` | deployment secret source / PAM reference | admin session cookie signing | rotate on exposure; требуется coordinated restart | invalidates sessions |
| IF-003 | SSO trusted headers/groups | reverse proxy config | admin SSO mode | proxy/IdP policy | требуется trusted proxy CIDR allowlist |
| IF-006 | per-target connector credentials | encrypted `TargetSystem.config` или secret references | connectors | per target system policy | `ENCRYPTION_ENABLED=true` до хранения secrets |
| IF-006 | DB connector credentials | env/config или `TargetSystem.config` | DB connector | DB policy | использовать TLS settings, где требуется |
| IF-007 | `REDIS_PASSWORD`, `REDIS_TLS_*` | deployment secret source | Redis client | Redis policy | без inline values in docs |
| IF-004, IF-005 | `KAFKA_TLS_CA_PATH`, `KAFKA_TLS_CERT_PATH`, `KAFKA_TLS_KEY_PATH` | Docker/Kubernetes secrets или secure mounts | Kafka client | certificate lifecycle | mount read-only; private key не хранить в git |
| IF-008 | `DATABASE_URL` | deployment env/secret source | Prisma | DB policy | только placeholders в committed templates |
| IF-011 | PAM/AAPM application token | deployment secret source | secret resolver | PAM policy | preferred header transport; token не логировать |
| IF-008, IF-004 | `ENCRYPTION_KEY_*`, `ENCRYPTION_ACTIVE_KEY_ID` | deployment secret source / PAM reference | encryption service | planned key rotation или emergency revocation | base64 32-byte keys; rotation в maintenance mode |
| IF-009 | HTTP TLS cert/key/CA | Docker/Kubernetes secrets или secure mounts | inbound HTTPS listener | certificate lifecycle | private keys не попадают в commit |

Примечания по rotation:

- Encryption key rotation выполняется командой `npm run security:rotate-key` в
  maintenance mode и проверяет Kafka lag, если он явно не пропущен.
- Customer CA files, используемые для image build, не являются runtime secrets,
  но реальные CA artifacts и fingerprints не должны попадать в git.
- `apt/debian.sources` не должен содержать mirror credentials; используйте
  build-host proxy settings, Docker daemon configuration или approved CI secret
  injection.
