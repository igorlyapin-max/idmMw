# Debian package sources

`debian.sources` is copied into the runtime image before the first
`apt-get update`.

The committed file uses the standard Debian Bookworm repositories. For a
customer source build that must use an internal OS package mirror or proxy,
replace `apt/debian.sources` in the build context before `docker build`.

Do not commit mirror credentials in this file. Use build-host proxy settings,
Docker daemon configuration, or the approved CI secret mechanism for
authenticated mirrors.
