# infra

`provision.sh` performs the Azure and Entra steps described in [docs/azure-admin-request.md](../docs/azure-admin-request.md)
and writes `handoff.json` with the values the development team needs. It is meant to be read by the administrator
before it is run; every command maps to a numbered step in that document.

It does not deploy compute. Pick your platform standard (App Service, Container Apps, AKS) and assign the
user-assigned managed identity to the workflow host.

`handoff.json` is git-ignored; it contains ids, not secrets, but there is no reason to commit it.
