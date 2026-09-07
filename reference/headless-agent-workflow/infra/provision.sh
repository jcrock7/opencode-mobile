#!/usr/bin/env bash
# Provisions the Azure and Entra resources for the headless agentic workflow reference.
# Review docs/azure-admin-request.md first; this script performs sections A, B (except the dev secret), and C.
#
# Requirements: Azure CLI 2.60+, signed in (az login) as a user with Contributor + User Access Administrator on the
# subscription (or resource group) and Application Administrator + Cloud Application Administrator in Entra.
#
# Usage: edit the variables block, then: bash infra/provision.sh
# Output: infra/handoff.json with every value the development team needs. Idempotent where the CLI allows.

set -euo pipefail

# ------------------------------- variables (edit) -------------------------------------------------------------
ENV="${ENV:-dev}"
LOCATION="${LOCATION:-eastus2}"
RG="rg-agent-workflow-$ENV"
MI_NAME="id-agent-workflow-$ENV"
AOAI_NAME="aoai-agent-workflow-$ENV"
AOAI_DEPLOYMENT="${AOAI_DEPLOYMENT:-gpt-5.4-mini}"
AOAI_MODEL_NAME="${AOAI_MODEL_NAME:-gpt-5.4-mini}"      # model name/version must be available in LOCATION
AOAI_MODEL_VERSION="${AOAI_MODEL_VERSION:-}"           # leave empty to let the service pick the default version
STORAGE_NAME="${STORAGE_NAME:-stagentwf$ENV$RANDOM}"   # 3-24 lowercase alphanumerics, globally unique
AGENT_APP_NAME="app-agent-workflow-$ENV"
BOT_NAME="bot-agent-workflow-$ENV"
BOT_SKU="${BOT_SKU:-F0}"                               # F0 for dev, S1 for production
HOST_DOMAIN="${HOST_DOMAIN:-agent-workflow-$ENV.azurewebsites.net}"
MCP_APP_NAME="app-mcp-purchasing-$ENV"
MCP_SERVER_URL="${MCP_SERVER_URL:-https://mcp-purchasing-$ENV.contoso.com}"   # exact public URL of the MCP server
# -------------------------------------------------------------------------------------------------------------

TENANT_ID=$(az account show --query tenantId -o tsv)
SUB_ID=$(az account show --query id -o tsv)
echo "Tenant $TENANT_ID, subscription $SUB_ID, environment $ENV"

# ---- A. Azure resources ----
az group create -n "$RG" -l "$LOCATION" -o none

az identity create -g "$RG" -n "$MI_NAME" -o none
MI_CLIENT_ID=$(az identity show -g "$RG" -n "$MI_NAME" --query clientId -o tsv)
MI_PRINCIPAL_ID=$(az identity show -g "$RG" -n "$MI_NAME" --query principalId -o tsv)
MI_RESOURCE_ID=$(az identity show -g "$RG" -n "$MI_NAME" --query id -o tsv)
echo "Managed identity: clientId=$MI_CLIENT_ID principalId=$MI_PRINCIPAL_ID"

if ! az cognitiveservices account show -g "$RG" -n "$AOAI_NAME" -o none 2>/dev/null; then
  az cognitiveservices account create -g "$RG" -n "$AOAI_NAME" -l "$LOCATION" \
    --kind OpenAI --sku S0 --custom-domain "$AOAI_NAME" --yes -o none
fi
AOAI_ID=$(az cognitiveservices account show -g "$RG" -n "$AOAI_NAME" --query id -o tsv)
AOAI_ENDPOINT=$(az cognitiveservices account show -g "$RG" -n "$AOAI_NAME" --query properties.endpoint -o tsv)
if ! az cognitiveservices account deployment show -g "$RG" -n "$AOAI_NAME" --deployment-name "$AOAI_DEPLOYMENT" -o none 2>/dev/null; then
  VERSION_ARG=(); [ -n "$AOAI_MODEL_VERSION" ] && VERSION_ARG=(--model-version "$AOAI_MODEL_VERSION")
  az cognitiveservices account deployment create -g "$RG" -n "$AOAI_NAME" --deployment-name "$AOAI_DEPLOYMENT" \
    --model-name "$AOAI_MODEL_NAME" --model-format OpenAI "${VERSION_ARG[@]}" \
    --sku-capacity 50 --sku-name GlobalStandard -o none
fi
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role "Cognitive Services OpenAI User" --scope "$AOAI_ID" -o none 2>/dev/null || true

if ! az storage account show -g "$RG" -n "$STORAGE_NAME" -o none 2>/dev/null; then
  az storage account create -g "$RG" -n "$STORAGE_NAME" -l "$LOCATION" --sku Standard_LRS --kind StorageV2 \
    --allow-blob-public-access false --min-tls-version TLS1_2 -o none
fi
STORAGE_ID=$(az storage account show -g "$RG" -n "$STORAGE_NAME" --query id -o tsv)
az role assignment create --assignee-object-id "$MI_PRINCIPAL_ID" --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" --scope "$STORAGE_ID" -o none 2>/dev/null || true
az storage container create --account-name "$STORAGE_NAME" -n agent-state --auth-mode login -o none 2>/dev/null || true

# Hosting is intentionally left to your platform standard (App Service, Container Apps, AKS).
# Whatever you pick, assign the user-assigned identity to the HOST compute, for example:
#   az webapp identity assign -g "$RG" -n <host-app-name> --identities "$MI_RESOURCE_ID"

# ---- B. Agent app registration + federated credential + Azure Bot ----
AGENT_APP_ID=$(az ad app list --display-name "$AGENT_APP_NAME" --query '[0].appId' -o tsv)
if [ -z "$AGENT_APP_ID" ]; then
  AGENT_APP_ID=$(az ad app create --display-name "$AGENT_APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
fi
AGENT_APP_OBJECT_ID=$(az ad app show --id "$AGENT_APP_ID" --query id -o tsv)
az ad sp show --id "$AGENT_APP_ID" -o none 2>/dev/null || az ad sp create --id "$AGENT_APP_ID" -o none
echo "Agent app: appId=$AGENT_APP_ID"

FIC_NAME="fic-agent-workflow-$ENV"
if ! az ad app federated-credential list --id "$AGENT_APP_OBJECT_ID" --query "[?name=='$FIC_NAME']" -o tsv | grep -q .; then
  az ad app federated-credential create --id "$AGENT_APP_OBJECT_ID" --parameters "$(cat <<JSON
{
  "name": "$FIC_NAME",
  "issuer": "https://login.microsoftonline.com/$TENANT_ID/v2.0",
  "subject": "$MI_PRINCIPAL_ID",
  "description": "Workflow host managed identity may act as the agent app (Azure Bot Service)",
  "audiences": ["api://AzureADTokenExchange"]
}
JSON
)" -o none
fi

if ! az bot show -g "$RG" -n "$BOT_NAME" -o none 2>/dev/null; then
  az bot create -g "$RG" -n "$BOT_NAME" --app-type SingleTenant --appid "$AGENT_APP_ID" --tenant-id "$TENANT_ID" \
    --sku "$BOT_SKU" --endpoint "https://$HOST_DOMAIN/api/messages" -o none
fi
az bot msteams create -g "$RG" -n "$BOT_NAME" -o none 2>/dev/null || true

# ---- C. MCP server app registration, v2 tokens, Application ID URI, app roles, assignment to the identity ----
MCP_APP_ID=$(az ad app list --display-name "$MCP_APP_NAME" --query '[0].appId' -o tsv)
if [ -z "$MCP_APP_ID" ]; then
  MCP_APP_ID=$(az ad app create --display-name "$MCP_APP_NAME" --sign-in-audience AzureADMyOrg --query appId -o tsv)
fi
MCP_APP_OBJECT_ID=$(az ad app show --id "$MCP_APP_ID" --query id -o tsv)

ROLE_READ_ID=$(az ad app show --id "$MCP_APP_ID" --query "appRoles[?value=='Tools.Read'].id | [0]" -o tsv)
ROLE_EXEC_ID=$(az ad app show --id "$MCP_APP_ID" --query "appRoles[?value=='Tools.Execute'].id | [0]" -o tsv)
[ -n "$ROLE_READ_ID" ] || ROLE_READ_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
[ -n "$ROLE_EXEC_ID" ] || ROLE_EXEC_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')

# Order matters: v2 tokens first, then an HTTPS Application ID URI equal to the server URL.
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$MCP_APP_OBJECT_ID" \
  --headers "Content-Type=application/json" --body "$(cat <<JSON
{
  "api": { "requestedAccessTokenVersion": 2 },
  "appRoles": [
    { "id": "$ROLE_READ_ID", "allowedMemberTypes": ["Application"], "displayName": "Read tools",
      "description": "Call read-only MCP tools", "isEnabled": true, "value": "Tools.Read" },
    { "id": "$ROLE_EXEC_ID", "allowedMemberTypes": ["Application"], "displayName": "Execute tools",
      "description": "Call MCP tools that change data", "isEnabled": true, "value": "Tools.Execute" }
  ]
}
JSON
)"
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$MCP_APP_OBJECT_ID" \
  --headers "Content-Type=application/json" --body "{\"identifierUris\": [\"$MCP_SERVER_URL\"]}"

az ad sp show --id "$MCP_APP_ID" -o none 2>/dev/null || az ad sp create --id "$MCP_APP_ID" -o none
MCP_SP_OID=$(az ad sp show --id "$MCP_APP_ID" --query id -o tsv)

for ROLE_ID in "$ROLE_READ_ID" "$ROLE_EXEC_ID"; do
  EXISTING=$(az rest --method GET --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$MCP_SP_OID/appRoleAssignedTo" \
    --query "value[?principalId=='$MI_PRINCIPAL_ID' && appRoleId=='$ROLE_ID'] | length(@)" -o tsv)
  if [ "$EXISTING" = "0" ]; then
    az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$MCP_SP_OID/appRoleAssignedTo" \
      --headers "Content-Type=application/json" \
      --body "{\"principalId\":\"$MI_PRINCIPAL_ID\",\"resourceId\":\"$MCP_SP_OID\",\"appRoleId\":\"$ROLE_ID\"}" -o none
  fi
done
echo "MCP app: appId=$MCP_APP_ID identifierUri=$MCP_SERVER_URL roles assigned to $MI_NAME"

# ---- Handoff ----
cat > "$(dirname "$0")/handoff.json" <<JSON
{
  "environment": "$ENV",
  "tenantId": "$TENANT_ID",
  "subscriptionId": "$SUB_ID",
  "resourceGroup": "$RG",
  "managedIdentity": { "name": "$MI_NAME", "clientId": "$MI_CLIENT_ID", "principalId": "$MI_PRINCIPAL_ID", "resourceId": "$MI_RESOURCE_ID" },
  "agentApp": { "appId": "$AGENT_APP_ID", "objectId": "$AGENT_APP_OBJECT_ID", "botName": "$BOT_NAME", "messagingEndpoint": "https://$HOST_DOMAIN/api/messages" },
  "azureOpenAI": { "endpoint": "$AOAI_ENDPOINT", "deployment": "$AOAI_DEPLOYMENT", "scope": "https://ai.azure.com/.default" },
  "storage": { "accountName": "$STORAGE_NAME", "container": "agent-state" },
  "mcpServers": [
    { "name": "purchasing", "appId": "$MCP_APP_ID", "applicationIdUri": "$MCP_SERVER_URL", "scope": "$MCP_SERVER_URL/.default",
      "appRoles": { "Tools.Read": "$ROLE_READ_ID", "Tools.Execute": "$ROLE_EXEC_ID" } }
  ],
  "remaining_manual_steps": [
    "Assign the managed identity to the host compute (az webapp identity assign ... --identities $MI_RESOURCE_ID).",
    "Deploy the host to https://$HOST_DOMAIN and the MCP server to $MCP_SERVER_URL.",
    "Dev environment only: create a 90-day client secret on $AGENT_APP_NAME and share it out of band.",
    "Teams admin: upload and publish the Teams app package (botId = $AGENT_APP_ID).",
    "Provide approver Entra object ids: az ad user show --id <upn> --query id -o tsv",
    "Developers: grant 'Cognitive Services OpenAI User' on $AOAI_NAME to the dev group."
  ]
}
JSON
echo "Wrote $(dirname "$0")/handoff.json"
