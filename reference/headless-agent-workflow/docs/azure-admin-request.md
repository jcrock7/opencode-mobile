# Request to the Azure / Entra administrator

This document is written to be forwarded. It lists everything an administrator must provision for the
headless agentic workflow reference, why each item exists, and the values to hand back to the development
team. A script that performs the Azure and Entra steps is in `infra/provision.sh`; the portal steps below
describe the same work for review or manual execution.

**Time estimate:** 60 to 90 minutes for a first environment. Nothing here requires a client secret in production.

## Who needs to do what

| Step | Portal / tool | Directory or Azure role needed | Done by |
| --- | --- | --- | --- |
| A. Resource group, managed identity, Azure OpenAI, storage, hosting | Azure portal / `az` | *Contributor* on the subscription or resource group, plus *User Access Administrator* (or *Owner*) for role assignments | Azure admin |
| B. Agent app registration + Azure Bot + Teams channel | Azure portal / `az` | *Application Administrator* (Entra) and *Contributor* (Azure) | Azure/Entra admin |
| C. MCP server app registration, app roles, role assignment to the managed identity | Entra admin center / Graph | *Application Administrator* (create app, set manifest) and *Cloud Application Administrator* or *Privileged Role Administrator* (app-role assignment to a service principal) | Entra admin |
| D. Teams app publication | Teams admin center | *Teams Administrator* | Teams admin |
| E. Developer onboarding (RBAC for laptops) | Azure portal / `az` | *User Access Administrator* | Azure admin |
| F. Broker intake mailbox (shared mailbox, Graph Mail.ReadWrite on the managed identity, application access policy) | Exchange admin center / Graph / Exchange Online PowerShell | *Exchange Administrator* plus *Privileged Role Administrator* or *Cloud Application Administrator* for the Graph permission grant | Exchange/Entra admin |
| G. Fill configuration, deploy, test | Repo | none | Development team |

Steps A through F are the request. Step G is ours.

## Inputs we provide up front

| Placeholder | Value we supply | Used in |
| --- | --- | --- |
| `{{Environment}}` | e.g. `dev`, `test`, `prod` | resource names |
| `{{Region}}` | e.g. `eastus2` (must offer the chosen Azure OpenAI model) | Azure OpenAI, hosting |
| `{{HostDomain}}` | public hostname the host will run on, e.g. `agent-workflow-dev.azurewebsites.net` | Bot messaging endpoint, Teams manifest |
| `{{McpServerUrl}}` | public HTTPS URL of each custom MCP server, e.g. `https://mcp-purchasing-dev.contoso.com` | MCP app registration (Application ID URI) |
| `{{ApproverUpns}}` | who receives decision cards in the first environment | Approvals routing (we need their Entra object ids back) |
| `{{DeveloperUpns}}` | developers who will run the host locally | step E |

## A. Azure resources

1. **Resource group** `rg-agent-workflow-{{Environment}}` in `{{Region}}`.
2. **User-assigned managed identity** `id-agent-workflow-{{Environment}}`.
   This is *the* identity of the workflow. Every downstream call (Azure OpenAI, MCP servers, storage) is made as
   this principal. Record **Client ID**, **Principal (object) ID**, **Resource ID**.
3. **Azure OpenAI** (Foundry) resource `aoai-agent-workflow-{{Environment}}` with one chat deployment (we suggest
   `gpt-5.4-mini` or the current mid-tier GPT model; deployment name is configuration).
   Role assignment: the managed identity gets **Cognitive Services OpenAI User** on this resource.
4. **Storage account** `stagentwf{{Environment}}` (lowercase, unique) with a private container `agent-state`.
   Used for Teams conversation references. Role assignment: managed identity gets **Storage Blob Data Contributor**.
   (Checkpoint and pending-decision stores can also live here later; the reference starts on local disk.)
5. **Hosting** for two web apps, the workflow host and the MCP server. App Service (Linux, .NET 10) or Container
   Apps both work. Assign the user-assigned managed identity to the **host** compute. The MCP server needs no
   identity of its own for the reference.
   Enable HTTPS only. The host must be reachable from Azure Bot Service (public endpoint, or Private Link to Bot
   Service in regulated setups).

Portal equivalents: *Create a resource* for each; *Access control (IAM) > Add role assignment* for the two roles,
choosing *Managed identity* as the member type.

## B. The agent identity for Teams (Azure Bot)

The agent needs an Entra application that Azure Bot Service and Teams recognize. It authenticates as that app
**through the managed identity** (federated credential), so no secret exists in production.

1. **App registration** `app-agent-workflow-{{Environment}}`, *Accounts in this organizational directory only*
   (single tenant). No redirect URIs, no API permissions. Record **Application (client) ID** and **Object ID**.
2. On that app: **Certificates & secrets > Federated credentials > Add credential**.
   Scenario *Managed identity* (or *Other issuer* on older portals) with:
   - Issuer: `https://login.microsoftonline.com/{{TenantId}}/v2.0`
   - Subject: the managed identity's **Principal (object) ID** from A.2
   - Audience: `api://AzureADTokenExchange`
   - Name: `fic-agent-workflow-{{Environment}}`
   Do **not** create a client secret on this app for production.
3. **Azure Bot** resource `bot-agent-workflow-{{Environment}}`:
   - Type of App: **Single Tenant**
   - Microsoft App ID: the client id from B.1 (use "existing app registration")
   - Tenant: our tenant id
   - Pricing tier: S1 (F0 is fine for dev)
4. Bot **Configuration**: Messaging endpoint `https://{{HostDomain}}/api/messages`.
5. Bot **Channels**: add **Microsoft Teams**, accept terms, default settings (no calling).

Local development exception: developers run the host on a laptop through a dev tunnel, and federated credentials do
not work there. For the **dev** environment only, create a client secret on the app registration with a short
expiry (90 days) and share it with the team through the approved secret channel. It is stored in .NET user
secrets, never in the repository. Production and test environments get no secret.

## C. Each custom MCP server as an Entra-protected API

One app registration per MCP server. These steps must be done in this order.

1. **App registration** `app-mcp-purchasing-{{Environment}}`, single tenant. Record client id and object id.
2. **Manifest**: set the access token version to 2. In the manifest editor set
   `"api": { "requestedAccessTokenVersion": 2 }` (or the equivalent field in the new manifest view).
   Without this, step 3 is rejected and tokens will not match the server URL.
3. **Expose an API > Application ID URI**: set to exactly `{{McpServerUrl}}` (for example
   `https://mcp-purchasing-dev.contoso.com`). This must equal the URL the server is reached on.
4. **Expose an API > Add a scope** (for people using the server from IDEs later; optional today):
   `Tools.Read` and `Tools.Execute`, admins-and-users consent.
5. **App roles > Create app role**, allowed member type **Applications**:
   - `Tools.Read` (display name "Read tools", description "Call read-only MCP tools")
   - `Tools.Execute` (display name "Execute tools", description "Call MCP tools that change data")
   Record both role ids.
6. **Assign both app roles to the managed identity** from A.2. There is no portal button for this on managed
   identities; use Graph (the script does it):

   ```bash
   MI_OID=<managed identity principal id>
   MCP_SP_OID=$(az ad sp list --filter "appId eq '<mcp app client id>'" --query '[0].id' -o tsv)
   for ROLE_ID in <Tools.Read id> <Tools.Execute id>; do
     az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$MCP_SP_OID/appRoleAssignedTo" \
       --body "{\"principalId\":\"$MI_OID\",\"resourceId\":\"$MCP_SP_OID\",\"appRoleId\":\"$ROLE_ID\"}"
   done
   ```

   If the MCP app has no service principal yet (`az ad sp list` returns nothing), create one first:
   `az ad sp create --id <mcp app client id>`.

Why this matters: the workflow asks Entra for a token with `resource = {{McpServerUrl}}`; Entra issues it only
because the Application ID URI matches, and puts `Tools.Read`/`Tools.Execute` in the `roles` claim only because of
the assignment. The server validates audience and roles and rejects everything else.

## D. Teams app

1. In **Teams admin center > Teams apps > Manage apps > Upload new app**, upload the zip the team provides
   (`manifest.json` + two icons). The manifest's `botId` is the client id from B.1.
2. Publish it to the org catalog, or restrict it with an **app permission policy** / app-centric management to the
   approver group only. No consent prompts are involved; the app requests no Graph permissions.
3. Confirm **Org-wide app settings > Let users interact with custom apps** is on (it is by default).
4. For the dev tenant or a pilot team, optionally allow **Upload custom apps** in the app setup policy for the
   development team so they can sideload without waiting for publication.

## F. Broker intake mailbox (email intake proof of concept)

Land brokers submit draft leases by email. The workflow host reads one shared mailbox with the managed identity
and moves processed messages into sub-folders. Three steps:

1. **Shared mailbox** `leases@{{Domain}}` (Exchange admin center > Recipients > Mailboxes > Add a shared mailbox).
   No license is required. Add the Land team as members so people can also look at it.
2. **Graph application permission `Mail.ReadWrite`** on the managed identity from A.2. Managed identities cannot be
   granted permissions in the portal's API permissions blade; use Graph (the script does it):

   ```bash
   MI_OID=<managed identity principal id>
   GRAPH_SP=$(az ad sp list --filter "appId eq '00000003-0000-0000-c000-000000000000'" --query '[0].id' -o tsv)
   ROLE_ID=$(az ad sp show --id $GRAPH_SP --query "appRoles[?value=='Mail.ReadWrite'].id | [0]" -o tsv)
   az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$GRAPH_SP/appRoleAssignedTo"      --body "{\"principalId\":\"$MI_OID\",\"resourceId\":\"$GRAPH_SP\",\"appRoleId\":\"$ROLE_ID\"}"
   ```

3. **Application access policy** so that permission reaches only the intake mailbox (Exchange Online PowerShell):

   ```powershell
   Connect-ExchangeOnline
   New-DistributionGroup -Name "Agent Intake Mailboxes" -Type Security -Members leases@{{Domain}}
   New-ApplicationAccessPolicy -AppId <managed identity client id> -PolicyScopeGroupId "Agent Intake Mailboxes" `
     -AccessRight RestrictAccess -Description "Agent workflow host may read only the lease intake mailbox"
   Test-ApplicationAccessPolicy -Identity leases@{{Domain}} -AppId <managed identity client id>
   ```

   Without this policy `Mail.ReadWrite` would cover every mailbox in the tenant. The policy takes up to an hour
   to apply.

Later, when the broker acknowledgement email is added, the same identity needs `Mail.Send` under the same policy.

## E. Developer onboarding

Developers run the host locally with their own sign-in (`az login`) and need:

- **Cognitive Services OpenAI User** on the Azure OpenAI resource (for `{{DeveloperUpns}}`, or a group).
- Membership in a security group that is allowed to read the resource group (Reader) for troubleshooting.
- The dev-only bot client secret from section B, delivered out of band.

They do **not** need access to the managed identity or to create app registrations.

## Values to hand back

Please return this table filled in (the script writes it as `handoff.json`):

| Key | Where it goes in our config |
| --- | --- |
| Tenant ID | `TokenValidation:TenantId`, `Connections:...:AuthorityEndpoint`, `Approvals:TenantId`, MCP `AzureAd:TenantId` |
| Agent app (client) ID (B.1) | `TokenValidation:Audiences[0]`, `Connections:ServiceConnection:Settings:ClientId`, Teams manifest `botId` |
| Managed identity client ID (A.2) | `Connections:ServiceConnection:Settings:FederatedClientId`, `Identity:ManagedIdentityClientId` |
| Managed identity principal ID (A.2) | for our records / future role assignments |
| Azure OpenAI endpoint + deployment name (A.3) | `AzureOpenAI:Endpoint`, `AzureOpenAI:Deployment` |
| Storage account name (A.4) | `Storage:BlobConnectionString` (we use the identity-based form) |
| Host URL, MCP server URL (A.5) | Bot endpoint check, `Mcp:Servers[].Endpoint`, Teams manifest `validDomains` |
| MCP app (client) ID + Application ID URI (C) | MCP server `AzureAd:ClientId`, `AzureAd:Audience`, `Mcp:ResourceUri`; host `Mcp:Servers[].Scope` = `<Application ID URI>/.default` |
| Approver Entra object IDs | `Approvals:Default:UserObjectId`, `Approvals:Routes[].UserObjectId` (`az ad user show --id user@contoso.com --query id`) |
| Intake mailbox address (F) | `Intake:Email:MailboxAddress`; confirm the application access policy test passed |
| Dev-only bot client secret (B, dev env only) | .NET user secrets on developer machines |

## Security notes for the reviewer

- No secrets in production: the bot authenticates via federated credential to the managed identity; Azure OpenAI,
  storage, and MCP servers are reached with managed-identity tokens; MCP servers validate Entra tokens.
- Least privilege: the identity gets *OpenAI User* (not Contributor), *Blob Data Contributor* scoped to one account,
  and app roles only on the MCP apps it needs. The MCP server additionally enforces `Tools.Execute` on write tools.
- The Teams app requests no Graph permissions. Approver identity comes from the Teams activity.
- The host's trigger endpoints accept Entra tokens for the agent app id; we will set `TokenValidation:AllowedCallers`
  to the app ids of the systems allowed to start workflows once those are known.
- Conditional Access: if workload identity policies are in use, allow the managed identity to reach Azure OpenAI
  and the MCP app; if app-role assignment requires admin consent workflow, the assignment in C.6 is the consent.
