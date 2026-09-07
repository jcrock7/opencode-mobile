# Authentication and identities

Five parties talk to each other. Each has its own identity and its own trust relationship. Nothing uses an API key.

```
 Trigger caller ──(Entra token, aud = agent app)──> Host ──(Bot token via MSAL)──> Azure Bot Service ──> Teams
                                                     │
                                                     ├──(managed identity, scope ai.azure.com)──> Azure OpenAI
                                                     └──(managed identity, aud = MCP server)────> MCP server(s)
 Teams user ──(click)──> Azure Bot Service ──(Bot Service JWT)──> Host   (user identity arrives in the activity)
```

## 1. The agent (bot) identity: Azure Bot + Entra app registration

What Teams and Azure Bot Service know the agent as.

Provision (Azure portal or Bicep):

1. **User-assigned managed identity** (UAMI), e.g. `id-agent-workflow`. Record its client id.
2. **Azure Bot** resource, identity type *Single Tenant* or *User-Assigned Managed Identity*. Record the
   **Microsoft App ID** (`{{AgentAppId}}`) and tenant id.
3. On the bot's app registration: **Certificates & secrets > Federated credentials > Add > Managed identity**,
   select the UAMI. Delete any client secret. This is the "federated credentials" pattern: the host proves it is the
   UAMI, Entra issues a token for the bot app id, no secret exists.
4. Bot **Channels > Microsoft Teams**: enable. **Configuration > Messaging endpoint**: `https://<host>/api/messages`.

Host settings this feeds:

```jsonc
"TokenValidation": { "Audiences": ["{{AgentAppId}}"], "TenantId": "{{TenantId}}" },
"Connections": { "ServiceConnection": { "Settings": {
  "AuthType": "FederatedCredentials",
  "ClientId": "{{AgentAppId}}",
  "AuthorityEndpoint": "https://login.microsoftonline.com/{{TenantId}}",
  "FederatedClientId": "{{ManagedIdentityClientId}}",
  "Scopes": ["https://api.botframework.com/.default"] } } }
```

- `TokenValidation` is **inbound**: `AspNetExtensions.cs` (copied from the Microsoft sample; it is not in the NuGet
  package) validates every request to `/api/messages` and to the trigger endpoints as a JWT from Azure Bot Service
  or Entra with audience = the agent app id. Add `"AllowedCallers": ["<app id>"]` to restrict which Entra apps may
  call the trigger endpoints.
- `Connections` is **outbound**: MSAL acquires tokens to send messages to Teams through Azure Bot Service.

Local development: federated credentials do not work through dev tunnels, so `appsettings.Development.json` uses
`AuthType: ClientSecret` with the secret in user secrets. Never ship that configuration.

## 2. The workload identity: what the agent *is* when it calls Azure OpenAI and your MCP servers

The same UAMI (or the system-assigned identity of the compute) is the principal for all downstream calls.
`Infrastructure/AzureIdentity.cs` selects the credential explicitly:

| `Identity:Mode` | Credential | Use |
| --- | --- | --- |
| `ManagedIdentity` | `ManagedIdentityCredential` (user-assigned via `ManagedIdentityClientId`, else system) | App Service, Container Apps, Functions, VMs |
| `WorkloadIdentity` | `WorkloadIdentityCredential` | AKS with Entra Workload ID |
| `Development` | `DefaultAzureCredential` limited to developer sign-ins (az login, Visual Studio) | Laptops only |

Do not use `DefaultAzureCredential` in production: it probes several sources, adds latency, and can pick up an
unintended identity.

Role assignments for the UAMI:

```bash
UAMI_PRINCIPAL=$(az identity show -g <rg> -n id-agent-workflow --query principalId -o tsv)

# Azure OpenAI: call deployments
az role assignment create --assignee-object-id $UAMI_PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services OpenAI User" --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<aoai>

# Blob storage for Agents SDK conversation state (if used)
az role assignment create --assignee-object-id $UAMI_PRINCIPAL --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<sa>
```

Azure OpenAI is called through the OpenAI SDK's v1 endpoint (`https://<resource>.openai.azure.com/openai/v1/`)
with a `BearerTokenPolicy`. Token scope `https://ai.azure.com/.default` (configurable; `https://cognitiveservices.azure.com/.default`
also works for Azure OpenAI resources).

## 3. Your MCP servers: OAuth 2.0 protected resources with Entra as the authorization server

The MCP authorization spec makes an HTTP MCP server a protected resource. Entra guidance
("Secure an MCP server with Microsoft Entra ID") maps onto it as follows; `SampleMcpServer` implements every step.

Per MCP server, one app registration:

1. **Manifest**: set `"api": { "requestedAccessTokenVersion": 2 }` first. Without v2 tokens you cannot use an HTTPS
   Application ID URI and resource matching fails.
2. **Expose an API > Application ID URI** = the server's canonical URL, e.g. `https://mcp-purchasing.contoso.com`.
   This is what clients send as the `resource` and what the token's `aud` becomes.
3. **App roles** (for app-only callers such as the workflow): `Tools.Read`, `Tools.Execute`, allowed member type
   *Applications*. Optionally delegated **scopes** with the same names for people using the server from an IDE.
4. **Assign the app roles to the UAMI's service principal** (Enterprise applications > your MCP app > Users and
   groups, or `az ad app-role-assignment` via Graph). Without an assignment the token has no `roles` claim and the
   server returns 403.

Server side (`SampleMcpServer/Program.cs`):

- `AddMicrosoftIdentityWebApi(AzureAd)` validates issuer, signature, lifetime, and **audience = the Application ID
  URI** (`AzureAd:Audience`). Microsoft.Identity.Web maps `roles` so `User.IsInRole("Tools.Execute")` works.
- `AddMcp(...)` from the MCP SDK serves `/.well-known/oauth-protected-resource` (RFC 9728) with the Entra v2.0
  issuer as authorization server and returns `401` + `WWW-Authenticate: Bearer resource_metadata=...` for
  unauthenticated calls.
- `MapMcp().RequireAuthorization("McpRead")` gates the endpoint; the write tool re-checks `Tools.Execute` itself.

Client side (`AgentWorkflow.Core/Mcp`): `EntraBearerTokenHandler` acquires a token for the server's scope
(`https://mcp-purchasing.contoso.com/.default`) with the workload identity and adds it to every request.
Configured per server in `Mcp:Servers[].Scope`. Least privilege: use `AllowedTools` to hand agents only the tools
they need, and give the analyst read tools only (`HumanDecisionWorkflowFactory`).

**Entra Agent ID.** Microsoft's newer model gives an agent its own identity type ("agent identity", provisioned
from an "agent blueprint") instead of a plain managed identity. The MCP server side is unchanged: it still sees a
bearer token with `aud` and `roles`. When your tenant adopts Agent ID, swap the `TokenCredential` for the Agent ID
acquisition path (Microsoft.Identity.Web.AgentIdentities) and assign the app roles to the agent identity.

## 4. Trigger callers (Logic Apps, Functions, ERP relays)

They call `POST /api/workflows/human-decision/run` with an Entra **client-credentials token whose audience is the
agent app id** (`scope = api://{{AgentAppId}}/.default`, after exposing an API on the agent app registration, or the
app id itself). The same `TokenValidation` middleware accepts it. Restrict with `AllowedCallers`. In
`Development` the trigger endpoints are unauthenticated for convenience.

## 5. Humans in Teams

Approvers do not sign in to anything extra. Their identity arrives on the card action as
`Activity.From.AadObjectId` and display name, which the host records as `DecidedBy`. Authorization of *who may
approve* is by construction: only the configured approver (or channel) receives the card, and the pending record
can be claimed once. If the operator action must run **as the approver** rather than as the workload identity,
add an Agents SDK OAuth connection (`AddAgentAuthorization` + Azure Bot OAuth connection with federated credentials)
and use the on-behalf-of token in `ApplyDecisionExecutor`; the reference keeps app-only tokens so the audit trail is
"agent acted, human approved".

## Checklist

- [ ] UAMI created; federated credential added to the bot app registration; no client secrets in production
- [ ] Azure Bot: Teams channel on, messaging endpoint set, single-tenant
- [ ] `TokenValidation.Audiences` = agent app id; `AllowedCallers` set if trigger callers are known
- [ ] UAMI has *Cognitive Services OpenAI User* on the Azure OpenAI resource
- [ ] Each MCP app registration: v2 tokens, Application ID URI = URL, app roles assigned to the UAMI
- [ ] `Mcp:Servers[].Scope` = `<Application ID URI>/.default`; `AllowedTools` trimmed per workflow
- [ ] Checkpoint and pending-decision stores readable only by the host identity
- [ ] Teams app manifest `botId` = agent app id; `validDomains` = host domain
