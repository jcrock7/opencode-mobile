namespace AgentWorkflow.Core.Intake;

/// <summary>A message waiting in the intake mailbox, as seen by the processor (no content bytes yet).</summary>
public sealed record InboundMessage(
    string Id,
    string InternetMessageId,
    string FromAddress,
    string? FromName,
    string Subject,
    string BodyText,
    DateTimeOffset ReceivedAt,
    IReadOnlyList<InboundAttachment> Attachments);

public sealed record InboundAttachment(string Id, string Name, string? ContentType, long Size);

public enum IntakeDisposition
{
    Processed,
    Rejected,
}

/// <summary>
/// The intake row: what we know about a lease before it exists in the Land system. In the proof of concept
/// this is a JSON file; the SharePoint list (or Dataverse row) replaces it later with the same fields.
/// </summary>
public sealed record LeaseIntakeRecord(
    string LeaseId,
    string MessageId,
    string InternetMessageId,
    string BrokerEmail,
    string? BrokerName,
    string BrokerFirm,
    string Subject,
    string? Lessor,
    string? County,
    string? State,
    string? TractId,
    string? GrossAcres,
    string DocumentId,
    string DocumentFileName,
    DateTimeOffset ReceivedAt,
    string Stage,
    string? WorkflowSessionId = null,
    string? Notes = null,
    int StartAttempts = 0);

/// <summary>Result of parsing one inbound email.</summary>
public sealed record IntakeParseResult(
    bool Accepted,
    string? RejectReason,
    string BrokerFirm,
    string? Lessor,
    string? County,
    string? State,
    string? TractId,
    string? GrossAcres,
    InboundAttachment? LeaseAttachment);

/// <summary>Configuration section <c>Intake:Email</c>.</summary>
public sealed class EmailIntakeOptions
{
    public bool Enabled { get; set; }

    /// <summary>"Graph" reads a shared mailbox through Microsoft Graph; "Directory" reads a local drop folder (dev, tests).</summary>
    public string Mode { get; set; } = "Directory";

    /// <summary>Shared mailbox brokers send to, for example leases@contoso.com (Graph mode).</summary>
    public string? MailboxAddress { get; set; }

    /// <summary>Drop folder with one sub-folder per message (Directory mode).</summary>
    public string? DropDirectory { get; set; }

    public int PollIntervalSeconds { get; set; } = 60;

    /// <summary>Only these sender domains are accepted; everything else is moved to Rejected untouched.</summary>
    public List<string> AllowedSenderDomains { get; set; } = [];

    /// <summary>Optional domain -> firm display name mapping for the intake record.</summary>
    public Dictionary<string, string> BrokerFirms { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    public List<string> AllowedAttachmentExtensions { get; set; } = [".pdf", ".docx", ".txt"];

    public long MaxAttachmentBytes { get; set; } = 25 * 1024 * 1024;

    /// <summary>Workflow to start for each accepted lease.</summary>
    public string WorkflowName { get; set; } = "LeaseReview";

    /// <summary>After this many failed attempts to start the review, the record is marked ReviewFailed and the message dispositioned.</summary>
    public int MaxStartAttempts { get; set; } = 3;

    /// <summary>Where intake records and documents are written (shared with the land MCP server in the PoC).</summary>
    public string Directory { get; set; } = ".state/intake";
}
