# Email intake (proof of concept)

Brokers email a draft lease to a shared mailbox. The host reads the mailbox, files the lease, creates an intake
record, and starts the lease review. Nobody types anything into a system; the first human touch is the landman's
sign-off card in Teams.

```
broker email + attachment
  -> IMailboxClient          Graph (shared mailbox) in production; a drop folder locally
  -> LeaseEmailParser        sender allow-list, one acceptable lease attachment, Key: value fields, subject convention
  -> DocumentTextExtractor   .pdf (text layer), .docx, .txt  -> plain text the agent reads
  -> IIntakeStore            intake record (pre-Land-system row) + original file + extracted text
  -> WorkflowRunnerRegistry  starts LeaseReview with attributes (source, documentId, broker, state, county, tract)
  -> mailbox disposition     message moved to Inbox/Processed or Inbox/Rejected with a category
```

Code: `src/AgentWorkflow.Core/Intake/*` (parser, extractor, processor, store seams),
`src/AgentWorkflow.Host/Intake/*` (Graph and directory mailbox clients, background service, endpoints).

## What brokers are asked to do

One email per lease, from a domain on the allow-list, with the draft attached as PDF (text, not scanned), Word,
or text. Subject `Lease submission: <Lessor> - <County> County, <ST>`. Optional lines in the body:

```
Lessor: John A. Miller and Mary E. Miller
County: Washington
State: PA
Tract: T-3391
Gross acres: 118.42
```

Everything the broker omits, the analyst agent reads from the lease itself. If the parser rejects a message
(unknown sender, no usable attachment, scanned image with no text), the message lands in `Inbox/Rejected` with a
category and reason; nothing else happens. Rejections are silent to the broker in the PoC; an acknowledgement or
bounce email is the first thing to add (Graph `sendMail`, permission `Mail.Send`, same mailbox).

## Guardrails

- **Allow-listed senders only.** `Intake:Email:AllowedSenderDomains` is the gate. Display names are not trusted;
  the SMTP domain is. Spoofing is handled by your tenant's DMARC/anti-spam before the mailbox, not by this code.
- **Attachments are untrusted input.** Only `.pdf`, `.docx`, `.txt` under the size cap are opened, by libraries
  that parse rather than execute (PdfPig, System.IO.Packaging). Text goes to the model as data. The analyst agent
  has read-only tools, so a lease document that contains instructions cannot cause a write.
- **Idempotent, with bounded retries.** The internet message id and the filed document are recorded before the
  workflow starts. If the start fails (model endpoint down, identity misconfigured), the record stays at
  `Received` with the reason and the message stays in the inbox; the next pass retries. After
  `Intake:Email:MaxStartAttempts` (default 3) the record becomes `ReviewFailed`, the message is dispositioned, and
  `GET /api/intake/leases` shows why. A record that already reached `UnderReview` is never started twice.
- **One pass at a time.** The timer and the on-demand endpoint cannot overlap; a message being processed is never
  listed as new by a second pass.
- **One bad email never blocks the batch.** Each message is processed independently; failures stay in the inbox
  for the next pass and are counted in the pass summary.

## Run it locally (no mailbox needed)

Development config uses `Mode: Directory` and polls `.state/mail-drop` every 10 seconds. Copy the sample:

```bash
mkdir -p src/AgentWorkflow.Host/.state/mail-drop
cp -r samples/mail-drop/2026-09-07-miller src/AgentWorkflow.Host/.state/mail-drop/
```

Within ten seconds the host logs `Intake created L-2026-0001 ... WaitingForHuman`, the folder moves to
`mail-drop/processed/`, `.state/intake/records/L-2026-0001.json` exists, and the routed landman gets the card.
`GET /api/intake/leases` lists intake records; `POST /api/intake/email/run` forces a pass.

The sample MCP server reads the same `.state/intake` directory (`Intake:Directory` in its appsettings), so
`get_lease_metadata`, `get_lease_document`, and `list_leases_pending_review` see emailed leases. In production
that read-through is replaced by the land MCP server reading the SharePoint list and library.

## Production: the shared mailbox

Graph mode (`Mode: Graph`, `MailboxAddress: leases@contoso.com`) reads unread Inbox messages with the workflow's
managed identity and moves them to `Inbox/Processed` or `Inbox/Rejected`. What the administrator sets up is in
docs/azure-admin-request.md, section F:

1. A shared mailbox (no license needed) such as `leases@contoso.com`.
2. Graph application permission **Mail.ReadWrite** granted to the managed identity's service principal.
3. An Exchange Online **application access policy** restricting that permission to the intake mailbox only, so
   the identity can read no other mailbox in the tenant.

The mailbox is its own audit trail: every message keeps its category (Processed/Rejected) and the folder it was
moved to, and the intake record stores the message id.

## What replaces what, later

| PoC piece | Production replacement | Change surface |
| --- | --- | --- |
| `FileIntakeStore` | SharePoint list + document library through Graph (`Sites.Selected`), or Dataverse | one class behind `IIntakeStore` |
| `DirectoryMailboxClient` | `GraphMailboxClient` (already here) | config |
| Sample MCP read-through of the intake folder | Land MCP server reading the SharePoint list/library | MCP server only |
| Silent rejection | Acknowledgement and bounce emails to the broker | `Mail.Send`, a few lines in the processor |
| Text-layer PDFs only | Azure Document Intelligence OCR for scans | `DocumentTextExtractor` |
| Stage strings on the record | The list's Stage choice column drives the landman's view | none in the workflow |
