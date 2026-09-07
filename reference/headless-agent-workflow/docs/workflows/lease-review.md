# Land team: pre-execution lease review

The first production-shaped workflow on the reference. A draft oil and gas lease arrives from a broker; before
anyone signs, a landman needs the key terms captured, every provision compared with the company form, and the
curative title work identified. The agent does that work unattended; the landman or land manager signs off in
Teams; the agent records the review in the land system and opens the curative tasks.

## What the agent captures

**Key terms** (`LeaseKeyTerms`): lessors, lessee, legal description, county/state, gross and net mineral acres,
primary term and extension option, bonus consideration, royalty rate and whether it is cost-free, delay rental,
shut-in royalty, depth limitation, Pugh clause, pooling limits, continuous development clause, surface use,
assignment restrictions, warranty of title, and any other notable terms. Values are quoted from the lease as
strings; the land system normalizes them.

**Provisions** (`ProvisionFinding`): each material provision compared with the company standard positions returned
by `get_lease_form_standards`, classified Standard / NonStandard / Missing, with the concrete concern and a
recommendation (accept, negotiate, escalate). The card shows only the non-standard and missing ones.

**Curative title work** (`CurativeItem`): from the tract runsheet and mineral ownership, every defect with the
affected interest, timing (BeforeExecution, BeforeDrilling, PostExecution), the recommended instrument, and who
is responsible. Categories the analyst is instructed to look for:

| Category | Typical instrument |
| --- | --- |
| UnreleasedPriorLease | Release of Oil and Gas Lease, Affidavit of Non-Production |
| MortgageSubordination | Subordination Agreement |
| Heirship / Probate | Affidavit of Heirship, probate, leases from heirs |
| NpriRatification | Ratification of Oil and Gas Lease (for pooling) |
| NameVariance | Affidavit of Identity (AKA) |
| LifeEstate | Joinder of remaindermen |
| MissingConveyance | Corrective or quitclaim deed |
| TaxLien | Payoff / release |
| UnlocatedOwner | Escrow, forced pooling where available |

**Conclusion**: `TitleStatus` (Clean, CurativeRequired, Defective), `Recommendation` (ApproveForExecution,
ApproveWithCurative, ReturnForRevision), a thirty-second summary, and evidence citing tool and record.

## The graph

```
WorkflowTrigger (lease id, state, county, tract, document)
  -> ReviewLease          LeaseAnalyst agent + land read tools  -> LeaseReview (structured output)
                          mapped to the shared DecisionRequest; the full review rides in Detail
  -> LeaseSignoff         RequestPort: halt, checkpoint, lease card to the routed landman
  -> RecordLeaseReview    LandOperator agent + land write tools
        Approved:  record_lease_review(ApprovedForExecution) + create_curative_task x N + update_lease_status
        Rejected:  record_lease_review(ReturnedForRevision) only; no status change, no tasks
  -> WorkflowResult, result card posted to the same Teams conversation
```

Files: `src/AgentWorkflow.Core/Land/*` (models, agents, executors, graph),
`src/AgentWorkflow.Host/Infrastructure/LeaseReviewWorkflowFactory.cs` (tool grants),
`src/AgentWorkflow.Host/Teams/LeaseReviewCard.cs` (the card), `tests/.../LeaseReviewWorkflowTests.cs`.

The risk shown on the card is derived, not model-chosen: Defective title or any BeforeExecution curative item is
High; any curative or non-standard provision is Medium; otherwise Low.

## The card

Header with lease id, county/state, title status, risk. Then key terms as a fact set, non-standard provisions
with concern and recommendation, every curative item with timing and instrument, the analyst's recommendation
and proposed action highlighted, evidence, a comments box, and two buttons: **Approve for execution** and
**Return for revision**. Lists are capped at eight items to stay under Teams' 28 KB card limit; the land system
record has everything.

## Who gets the card

Land teams route by district, so `Approvals` routes can match a trigger attribute:

```jsonc
"Routes": [
  { "CaseType": "LeaseReview", "Attribute": "state", "Value": "PA", "UserObjectId": "<PA land manager>", "TeamsChannelId": "<PA land team channel>" },
  { "CaseType": "LeaseReview", "UserObjectId": "<land manager>" }
]
```

The most specific match wins (case type + attribute, then case type, then `Default`). Post to a channel when the
whole district team should see the review; use a 1:1 chat when one person is accountable.

## MCP tools the land system must expose

The sample server (`src/SampleMcpServer/Tools/LandTools.cs`) shows the contract with an in-memory Appalachian
tract. Your real server sits in front of the land system (Quorum Land, P2, Enverus, a SharePoint lease library)
and should expose the same shapes:

| Tool | Access | Purpose |
| --- | --- | --- |
| `get_lease_metadata` | read | Status, tract, county/state, broker, document id |
| `list_leases_pending_review` | read | Source for a scheduled trigger |
| `get_lease_document` | read | Full lease text (OCR the PDF upstream) |
| `get_tract_title` | read | Runsheet: deeds, leases, mortgages, reservations, estate notes with examiner remarks |
| `get_mineral_ownership` | read | Owners, decimal interests, vesting, NPRI burdens |
| `get_lease_form_standards` | read | Company standard positions and tolerances per provision |
| `record_lease_review` | Tools.Execute | Persist outcome, summary, approver identity and comments |
| `create_curative_task` | Tools.Execute | Open a curative task per item |
| `update_lease_status` | Tools.Execute | ApprovedForExecution after a human approves |

Run it as its own MCP server with its own Entra app registration (`app-mcp-land-{{env}}`) and app roles; the
workflow's managed identity gets `Tools.Read` and `Tools.Execute` on it (docs/azure-admin-request.md, section C,
repeated for the land server). The analyst agent is only given the read tools; the operator only the three
write tools, so even a prompt-injected lease document cannot cause a write before the human decides.

## Triggering

- Land system event or Logic App: `POST /api/workflows/LeaseReview/run` with
  `{"caseId":"L-2026-0142","caseType":"LeaseReview","description":"...","attributes":{"state":"PA","county":"Washington","tractId":"T-3391","documentId":"DOC-88213"}}`.
- Scheduled: set `Triggers:Schedule:Enabled` and point `IWorkflowTriggerSource` at `list_leases_pending_review`
  (the sample reads cases from configuration).

## What to adapt for your Land department

1. Replace the sample standards with your actual lease form positions (or have the tool read them from the
   policy document).
2. Add categories to the curative taxonomy your title attorneys use; they are strings, so no code change.
3. If a title opinion (DTO) is available as a document, add a `get_title_opinion` tool and mention it in the
   analyst instructions; the agent will cite it as evidence.
4. Decide whether ReturnForRevision should notify the broker automatically (a `notify_broker` write tool in the
   operator's grant) or stay a human step.
5. For high-value leases add a second port (Land Manager after Landman) with `AddEdge(signoff, managerSignoff)`;
   the runner parks one request per halt, so the two approvals are sequential cards.
