# Customer CA build context

Place customer CA certificates here only on the controlled build host when the
Docker build must trust an internal registry, package mirror, npm proxy, PAM, DB
or integration endpoint.

Accepted file suffixes are `.crt` and `.pem`. Real certificate files in this
directory are ignored by Git but are intentionally not excluded by
`.dockerignore`, so Docker can copy them immediately after base `FROM` before
the first package-manager network command.

Set `CUSTOMER_CA_REQUIRED=true` for release builds that must fail when no
customer CA file is present.
