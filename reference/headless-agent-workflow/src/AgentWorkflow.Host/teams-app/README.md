# Teams app package

Zip `manifest.json` plus two PNG icons (`color.png` 192x192, `outline.png` 32x32) and upload it through
Teams admin center (Teams apps > Manage apps > Upload) or sideload it for testing.

Replace `{{AgentAppId}}` with the agent's Entra application (client) id and `{{HostDomain}}` with the public
hostname of the host. The Azure Bot resource must have the Microsoft Teams channel enabled and its messaging
endpoint set to `https://{{HostDomain}}/api/messages`.
