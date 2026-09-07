# Teams and human decisions

## Why proactive messaging

Nobody talks to this agent first. The workflow decides *when* a human is needed and *who* it is, then the host
opens the conversation. The Microsoft 365 Agents SDK calls this proactive messaging and gives three operations:

| Operation | Used here for |
| --- | --- |
| `Proactive.CreateConversationAsync` | Open a 1:1 chat with the approver (by Entra object id) or post into a Teams channel, with the decision card as the first message. `WithStoreConversation(true)` persists the reference. |
| `Proactive.SendActivityAsync(adapter, conversationId, activity)` | Post the result card, or a failure notice, to that same conversation later. |
| `Proactive.ContinueConversationAsync` | Not needed here; use it when a follow-up must run inside the full agent pipeline (turn state, OAuth). |

Teams requires the tenant id and, without a prior inbound activity, a service URL. Public cloud is
`https://smba.trafficmanager.net/teams/`; government clouds differ (`Approvals:ServiceUrl`).

## Routing: who gets asked

`Approvals` config maps case types to approvers:

```jsonc
"Approvals": {
  "TenantId": "...",
  "Default": { "UserObjectId": "<fallback approver>" },
  "Routes": [
    { "CaseType": "PurchaseOrderHold", "UserObjectId": "<AP lead>" },
    { "CaseType": "LeaseReview", "Attribute": "state", "Value": "PA", "UserObjectId": "<PA land manager>", "TeamsChannelId": "19:...@thread.tacv2" },
    { "CaseType": "LeaseReview", "UserObjectId": "<land manager>" }
  ]
}
```

A route may also match a trigger attribute (`Attribute`/`Value`, case-insensitive); the most specific route wins:
case type + attribute, then case type only, then `Default`. Trigger attributes travel on the `DecisionRequest`, so
"state", "district", or "business unit" set by the calling system drive routing without code.

- **Personal chat** (`UserObjectId` only): private, one accountable person, the card renders in their chat list.
- **Channel post** (`TeamsChannelId`): visible to the team, anyone in it can decide, the first click wins.
  The Entra object id is still required because Teams creates channel conversations "on behalf of" a member.

For dynamic routing (look up the PO's cost-center owner in the ERP), replace `ApprovalRoutingOptions.Resolve`
with a service call; the rest is unchanged.

## The decision card

`Teams/DecisionCard.cs` builds three cards with `System.Text.Json` nodes (no card library needed). Workflows with a
richer payload add their own request card and are dispatched by case type: `Teams/LeaseReviewCard.cs` renders the
`LeaseReview` detail (terms, provisions, curative items) and reuses the same verb and action data, so the click
handler is shared.

1. **Request card**: title, risk, summary/recommendation/rationale facts, evidence list, highlighted proposed
   action, an optional comments box, and two `Action.Execute` buttons. Each button's `data` carries
   `{ requestId, outcome }`; the client merges the comments input into it.
2. **Decided card**: read-only, returned from the action handler to replace the request card in place so the
   thread shows who decided what and when.
3. **Result card**: posted when the workflow completes with what the operator agent did.

Design rules that matter in practice:

- Use `Action.Execute` (Universal Actions), not `Action.Submit`: it lets the bot return a replacement card and works
  in Outlook actionable messages too. Wrap in `ActionSet` with an `Action.Submit` fallback if you must support very
  old Teams clients.
- Show evidence, not just a verdict. Approvers act on facts the agent pulled through MCP; make the tool results
  visible.
- One card, one decision. If a case needs several independent approvals, fan out to several `RequestPort`s (see
  building-new-workflows.md) rather than one card with many buttons.
- Keep the card under Teams' 28 KB limit; truncate long evidence.

## What happens on a click

`DecisionAgent.OnDecisionAsync` (registered with `AdaptiveCards.OnActionExecute(DecisionCard.DecisionVerb, ...)`):

1. Parse `{ requestId, outcome, comments }`.
2. Load the pending record; if gone, answer "already recorded".
3. `TryClaimAsync` it with the approver's identity. A double-click or a second approver gets "someone else decided".
4. Queue `WorkflowRunner.ResumeAsync` on the Agents SDK `IBackgroundTaskQueue`. Teams expects the invoke to return
   in a few seconds; resuming may call the model and MCP tools for longer.
5. Return the decided card immediately (`AdaptiveCardInvokeResponseFactory.AdaptiveCard`).
6. When the run finishes, `TeamsDecisionChannel.CompleteAsync` posts the result card to the stored conversation; on
   error, `FailAsync` posts a notice.

## Audit trail

Every decision records `DecidedBy` as `Display Name (Entra object id)`, the timestamp, the comments, and the exact
proposed action that was approved, both in the `WorkflowResult` and in the decided card left in Teams. The run's
session id is logged at start, park, resume, and completion, which is enough to stitch the trail together in
Application Insights.

## Fallback and operations

- `POST /api/workflows/decisions/{requestId}/decide` records a decision without Teams (Teams outage,
  automated tests). The pending record names its workflow, so the right runner resumes it.
- `GET /api/workflows/pending` and the `pending` chat command list what is waiting.
- Expiry and escalation are not built in. Add a timer (Functions timer or the scheduled service) that lists pending
  records older than N hours and either re-notifies, re-routes to the default approver, or auto-rejects by calling
  `ResumeAsync` with a synthetic decision (`DecidedBy = "policy:timeout"`).

## Other channels

`IDecisionChannel` is the only Teams-specific seam. An email implementation (Graph `sendMail` with a link to a small
approval page) or a ServiceNow implementation (create an approval record, receive a webhook) drops in without any
change to the workflow, runner, or stores.
